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
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KIT"
# Workflow commands need %, CR and LF escaped.
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
fail() { echo "::error title=QA verify::$(escape "$1")"; exit 1; }
# One line per ticket to verify: ticket, application folder, feature area, spec (from the application).
LIST="$RUNNER_TEMP/qa-verify-tickets.tsv"
ERR="$RUNNER_TEMP/qa-verify-error.txt"

case "${1:-}" in
  prepare)
    : > "$LIST"
    gh auth setup-git
    for ticket in $(grep -oE '[A-Z][A-Z0-9]*-[0-9]+' <<<"${HEAD_REF:-} ${PR_TITLE:-}" | sort -u); do
      pulls="$RUNNER_TEMP/$ticket-pulls.json"; reviews="$RUNNER_TEMP/$ticket-reviews.json"
      gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls?state=all&per_page=100&head=${GITHUB_REPOSITORY%%/*}:qa/$ticket" > "$pulls"
      pull="$(node qa/github-approval.ts pull "$ticket" "$GITHUB_REPOSITORY" "$pulls" 2>"$ERR")" || fail "$ticket: $(<"$ERR")"
      if [[ "$pull" == null ]]; then echo "$ticket: no QA pull request, nothing to verify."; continue; fi
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
      echo "$ticket: tests approved by $reviewer in #$number, unchanged since."
    done
    count="$(wc -l < "$LIST" | tr -d ' ')"
    echo "count=$count" >> "$GITHUB_OUTPUT"
    if [[ "$count" == 0 ]]; then
      echo '::notice title=QA verify::No ticket with QA tests in this pull request: nothing to verify.'
      echo 'No ticket with QA tests in this pull request: nothing to verify.' >> "$GITHUB_STEP_SUMMARY"
    fi
    ;;

  install)
    mapfile -t apps < <(cut -f2 "$LIST" | sort -u)
    for app in "${apps[@]}"; do
      (cd "$app" && npm ci --no-audit --no-fund && npx playwright install --with-deps chromium)
    done
    bash qa/ci-install-agents.sh
    ;;

  agent|suite)
    [[ -s "$LIST" ]] || { echo 'Nothing to verify.'; exit 0; }
    if [[ "$1" == agent && -z "${ANTHROPIC_API_KEY:-}" ]]; then
      fail 'ANTHROPIC_API_KEY is not available: add the repository secret. Pull requests from forks never receive it; push the branch to this repository instead.'
    fi
    failed=0
    while IFS=$'\t' read -r -u 3 ticket app mfe spec; do
      code=0
      if [[ "$1" == agent ]]; then
        (cd "$app" && QA_PROJECT_DIR="$PWD" QA_FULL_SUITE=later bash "$KIT/qa/run-qa.sh" "$ticket" 2 "$spec" "$mfe") || code=$?
        verdict="$(jq -r '"\(.verdict), cost $\(.cost_usd)"' "$app/reports/$ticket-phase2.json" 2>/dev/null || echo 'no verdict')"
        echo "- **$ticket**, QA verifier agent: $verdict (code $code)" >> "$GITHUB_STEP_SUMMARY"
      else
        (cd "$app" && bash "$KIT/qa/full-suite.sh" "$ticket") || code=$?
        echo "- **$ticket**, full suite: $([[ $code == 0 ]] && echo pass || echo "fail (code $code)")" >> "$GITHUB_STEP_SUMMARY"
      fi
      if [[ $code != 0 ]]; then
        echo "::error title=QA verify::$ticket does not pass the $1 check (code $code): see the log and the qa-verify-reports artifact."
        failed=1
      fi
    done 3< "$LIST"
    exit "$failed"
    ;;

  *) echo 'usage: qa/ci-verify.sh prepare|install|agent|suite' >&2; exit 2 ;;
esac
