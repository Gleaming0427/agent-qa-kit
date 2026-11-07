#!/usr/bin/env bash
# The "QA verify" workflow, step by step, on a pull request. Inputs come from the
# environment: BASE_REF, HEAD_REF and PR_TITLE (the pull request's title).
#   prepare  for each ticket the branch or title names that has QA tests: checks
#            that a collaborator approved them in their pull request and that they
#            are unchanged since, then records that approval (needs GH_TOKEN)
#   install  installs each application, its browser and the agent sandbox
#   agent    the QA verifier agent checks each ticket (needs ANTHROPIC_API_KEY)
#   suite    the full suite, in a step of its own without the API key, since the
#            pull request's code runs there
# QA_VERIFY_MODE is "blocking" (the default: a failure fails the check) or "advisory":
# every check still runs, a failure becomes a warning that says it would have
# blocked, and the check passes. Either way, each step's outcome for each ticket is
# appended to QA_VERIFY_RECORD (JSON lines): the track record that tells when the
# check can block (node qa/verify-record.ts).
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KIT"
MODE="${QA_VERIFY_MODE:-blocking}"
RECORD="${QA_VERIFY_RECORD:-$RUNNER_TEMP/qa-verify-record.jsonl}"
# Workflow commands need %, CR and LF escaped.
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
# One line per ticket to verify: ticket, application folder, feature area, spec (from the application).
LIST="$RUNNER_TEMP/qa-verify-tickets.tsv"
ERR="$RUNNER_TEMP/qa-verify-error.txt"
REFUSAL="$RUNNER_TEMP/qa-verify-refusal.txt"
fail() {
  printf '%s\n' "$1" > "$REFUSAL"
  if [[ "$MODE" == advisory ]]; then
    echo "::warning title=QA verify (advisory)::$(escape "Would block: $1")"
  else
    echo "::error title=QA verify::$(escape "$1")"
  fi
  exit 1
}
if [[ "$MODE" != blocking && "$MODE" != advisory ]]; then
  echo "::error title=QA verify::QA_VERIFY_MODE must be blocking or advisory, got \"$MODE\"."
  exit 1
fi
# One JSON line per ticket and step: the evidence for letting the check block, or not yet.
record() {
  jq -nc --arg ticket "$1" --arg step "$2" --arg result "$3" --arg detail "$4" --arg mode "$MODE" \
    --arg pr "${PR_NUMBER:-}" --arg sha "${HEAD_SHA:-}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg agent "$(git -C "$KIT" rev-parse --short HEAD:.claude 2>/dev/null || echo unknown)" \
    '{at: $at, mode: $mode, pr: $pr, sha: $sha, ticket: $ticket, step: $step, result: $result, detail: $detail, agent: $agent}' >> "$RECORD"
}

# Checks the approved tests of one ticket; exits through fail when they cannot be verified.
prepare_ticket() {
  local ticket="$1"
  pulls="$RUNNER_TEMP/$ticket-pulls.json"; reviews="$RUNNER_TEMP/$ticket-reviews.json"
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls?state=all&per_page=100&head=${GITHUB_REPOSITORY%%/*}:qa/$ticket" > "$pulls"
  pull="$(node qa/github-approval.ts pull "$ticket" "$GITHUB_REPOSITORY" "$pulls" 2>"$ERR")" || fail "$ticket: $(<"$ERR")"
  if [[ "$pull" == null ]]; then echo "$ticket: no QA pull request, nothing to verify."; return 0; fi
  number="$(jq -r .number <<<"$pull")"

  context="$(git ls-files -- ":(glob)**/qa-reviews/$ticket/context.json" | head -n 1)"
  [[ -n "$context" ]] || fail "$ticket has QA tests in pull request #$number, but this branch does not contain them: approve and merge #$number into feat/$ticket, then update this branch from feat/$ticket."
  app="$(dirname "$(dirname "$(dirname "$context")")")"

  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls/$number/reviews?per_page=100" > "$reviews"
  approval="$(node qa/github-approval.ts approval "$ticket" "$GITHUB_REPOSITORY" "$pulls" "$reviews" 2>"$ERR")" || fail "$ticket: $(<"$ERR")"
  sha="$(jq -r .head_sha <<<"$approval")"; reviewer="$(jq -r .reviewer <<<"$approval")"
  jq -r .body <<<"$approval" > "$RUNNER_TEMP/$ticket-review.md"

  # The tests and their review package must be exactly the approved ones.
  git fetch --quiet --no-tags origin "+refs/pull/$number/head:refs/remotes/origin/qa-approved/$ticket"
  [[ "$(git rev-parse "origin/qa-approved/$ticket")" == "$sha" ]] || fail "$ticket: pull request #$number changed during the check; run it again."
  bash qa/check-scope.sh frozen "origin/$BASE_REF" "origin/qa-approved/$ticket" \
    || fail "$ticket: the tests or their review package differ from the version approved in #$number."

  context_json="$(cd "$app" && node "$KIT/qa/scenario-review.ts" import "$ticket" 2>"$ERR")" \
    || fail "$ticket: incomplete review package in $app/qa-reviews/$ticket. $(<"$ERR")"
  mfe="$(jq -r .mfe <<<"$context_json")"; spec="$(jq -r .spec <<<"$context_json")"
  (cd "$app" && node "$KIT/qa/scenario-review.ts" approve-review "$ticket" "$spec" "$reviewer" "$RUNNER_TEMP/$ticket-review.md") 2>"$ERR" \
    || fail "$ticket: the approval of #$number by $reviewer cannot be used. $(<"$ERR") Approve #$number again with one line per criterion, such as \"AC-1: why this failure shows the feature is missing\"."
  printf '%s\t%s\t%s\t%s\n' "$ticket" "$app" "$mfe" "$spec" >> "$LIST"
  record "$ticket" prepare pass "tests approved by $reviewer in #$number"
  echo "$ticket: tests approved by $reviewer in #$number, unchanged since."
  # Approved tests changed by hand say so, with who changed them and why (qa/ci-amend-tests.sh).
  amendments="$app/reports/$ticket-amendments.json"
  if [[ -s "$amendments" ]]; then
    log="$(jq -r 'length as $n | .[-1] | "\($n) amendment(s) of the approved tests, the latest by \(.author): \(.reason)"' "$amendments")"
    echo "$ticket: $log"
    echo "::notice title=QA verify::$(escape "$ticket: $log")"
    echo "- **$ticket**: $log Approved by $reviewer in #$number." >> "$GITHUB_STEP_SUMMARY"
  fi
}

case "${1:-}" in
  prepare)
    : > "$LIST"
    gh auth setup-git
    [[ "$MODE" == blocking ]] || echo '**QA verify is advisory**: a failure is reported as a warning and does not block the merge.' >> "$GITHUB_STEP_SUMMARY"
    for ticket in $(grep -oE '[A-Z][A-Z0-9]*-[0-9]+' <<<"${HEAD_REF:-} ${PR_TITLE:-}" | sort -u); do
      code=0; rm -f "$REFUSAL"
      ( prepare_ticket "$ticket" ) || code=$?
      if (( code != 0 )); then
        record "$ticket" prepare fail "$(cat "$REFUSAL" 2>/dev/null || echo "exit $code")"
        [[ "$MODE" == advisory ]] || exit 1
        echo "- **$ticket**: would block, the tests cannot be verified: $(cat "$REFUSAL" 2>/dev/null)" >> "$GITHUB_STEP_SUMMARY"
      fi
    done
    count="$(wc -l < "$LIST" | tr -d ' ')"
    # The applications' Node.js version, for the steps after this one.
    if [[ "$count" != 0 ]]; then
      mapfile -t apps < <(cut -f2 "$LIST" | sort -u)
      if ! bash qa/ci-node-version.sh "${apps[@]}" >> "$GITHUB_OUTPUT" 2>"$ERR"; then
        while IFS=$'\t' read -r ticket _; do record "$ticket" prepare fail "$(<"$ERR")"; done < "$LIST"
        ( fail "$(<"$ERR")" ) || true
        [[ "$MODE" == advisory ]] || exit 1
        echo "- would block: $(<"$ERR")" >> "$GITHUB_STEP_SUMMARY"
        count=0
      fi
    fi
    echo "count=$count" >> "$GITHUB_OUTPUT"
    if [[ "$count" == 0 ]]; then
      echo '::notice title=QA verify::No ticket with QA tests in this pull request: nothing to verify.'
      echo 'No ticket with QA tests in this pull request: nothing to verify.' >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;

  install)
    mapfile -t apps < <(cut -f2 "$LIST" | sort -u)
    for app in "${apps[@]}"; do
      bash qa/ci-install-app.sh "$app"
    done
    bash qa/ci-install-agents.sh
    ;;

  agent|suite)
    [[ -s "$LIST" ]] || { echo 'Nothing to verify.'; exit 0; }
    if [[ "$1" == agent && -z "${ANTHROPIC_API_KEY:-}" ]]; then
      while IFS=$'\t' read -r ticket _; do record "$ticket" agent fail 'ANTHROPIC_API_KEY is not available'; done < "$LIST"
      ( fail 'ANTHROPIC_API_KEY is not available: add the repository secret. Pull requests from forks never receive it; push the branch to this repository instead.' ) \
        || { [[ "$MODE" == advisory ]] && exit 0; exit 1; }
    fi
    failed=0
    while IFS=$'\t' read -r -u 3 ticket app mfe spec; do
      code=0
      if [[ "$1" == agent ]]; then
        (cd "$app" && QA_PROJECT_DIR="$PWD" QA_FULL_SUITE=later bash "$KIT/qa/run-qa.sh" "$ticket" 2 "$spec" "$mfe") || code=$?
        verdict="$(jq -r '"\(.verdict), cost $\(.cost_usd)"' "$app/reports/$ticket-phase2.json" 2>/dev/null || echo 'no verdict')"
        echo "- **$ticket**, QA verifier agent: $verdict (code $code)$([[ $code != 0 && "$MODE" == advisory ]] && echo ', would block')" >> "$GITHUB_STEP_SUMMARY"
        detail="verdict $verdict, code $code"
      else
        (cd "$app" && bash "$KIT/qa/full-suite.sh" "$ticket") || code=$?
        echo "- **$ticket**, full suite: $([[ $code == 0 ]] && echo pass || echo "fail (code $code)")$([[ $code != 0 && "$MODE" == advisory ]] && echo ', would block')" >> "$GITHUB_STEP_SUMMARY"
        detail="code $code"
      fi
      record "$ticket" "$1" "$([[ $code == 0 ]] && echo pass || echo fail)" "$detail"
      if [[ $code != 0 ]]; then
        if [[ "$MODE" == advisory ]]; then
          echo "::warning title=QA verify (advisory)::Would block: $ticket does not pass the $1 check (code $code): see the log and the qa-verify-reports artifact."
        else
          echo "::error title=QA verify::$ticket does not pass the $1 check (code $code): see the log and the qa-verify-reports artifact."
          failed=1
        fi
      fi
    done 3< "$LIST"
    exit "$failed"
    ;;

  *) echo 'usage: qa/ci-verify.sh prepare|install|agent|suite' >&2; exit 2 ;;
esac
