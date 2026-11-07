#!/usr/bin/env bash
# The "QA amend tests" workflow, step by step: a person fixed approved QA tests that
# turned out to be wrong, on qa/<TICKET>. No agent runs. Inputs come from the
# environment: TICKET, APP (the application folder, relative to the repository),
# REASON (why the approved tests were wrong) and WORK (the checkout of qa/<TICKET>).
# The kit's own scripts come from this script's checkout, so a QA branch made
# before this workflow existed can still be amended.
#   check    validates the request before anything is installed
#   amend    runs the ticket's tests on the application without the feature: each
#            amended test must still fail for the right reason. Logs the amendment
#            in the review package (no token in this step: the tests run here)
#   publish  commits the package on qa/<TICKET> and opens, or updates, the pull
#            request into feat/<TICKET>: its approval is the review of the amendment
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
fail() { echo "::error title=QA amend tests::$(escape "$1")"; exit 1; }
branch_exists() { gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$1" --silent >/dev/null 2>&1; }
warn() { echo "::warning title=QA amend tests::$(escape "$1")"; }
commit_as_actor() { git -c user.name="$GITHUB_ACTOR" -c user.email="$GITHUB_ACTOR_ID+$GITHUB_ACTOR@users.noreply.github.com" "$@"; }
REVIEW_BODY="$RUNNER_TEMP/qa-amend-body.md"

# A QA pull request merged with "Squash and merge" or "Rebase and merge" puts a copy of its commits
# on feat/<TICKET>, not the commits of qa/<TICKET>. The next pull request from qa/<TICKET> then adds
# the same test files again, and conflicts. When the copy holds exactly the merged tests, as it does
# when nothing else had reached feat/<TICKET> yet, a merge commit on qa/<TICKET> records it without
# changing any file: the amendment then merges cleanly. Runs in the checkout of qa/<TICKET>, with
# origin/feat/<TICKET> fetched. Called with || (set -e does not apply): each step returns on failure.
record_copy() {
  local pulls="$RUNNER_TEMP/qa-amend-pulls.json" feat="origin/feat/$TICKET" merged number head copy differ
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls?state=closed&per_page=100&head=${GITHUB_REPOSITORY%%/*}:qa/$TICKET" > "$pulls" || return 1
  merged="$(node "$KIT/qa/github-approval.ts" merged "$TICKET" "$GITHUB_REPOSITORY" "$pulls")" || return 1
  [[ "$merged" != null ]] || return 0
  number="$(jq -r .number <<<"$merged")"; head="$(jq -r .head_sha <<<"$merged")"; copy="$(jq -r '.merge_commit_sha // empty' <<<"$merged")"
  # Merged with a merge commit, or its copy already recorded: nothing to do.
  git merge-base --is-ancestor "$head" "$feat" 2>/dev/null && return 0
  [[ -n "$copy" ]] && git merge-base --is-ancestor "$copy" HEAD 2>/dev/null && return 0
  local manual="The amendment's pull request may conflict on the test files: merge it into feat/$TICKET by hand, keeping the version of qa/$TICKET (HOW_TO_APPLY.md, \"Amend an approved test\")."
  if [[ -z "$copy" ]] || ! git merge-base --is-ancestor "$copy" "$feat" 2>/dev/null || ! git merge-base --is-ancestor "$head" HEAD 2>/dev/null; then
    warn "The tests of #$number are not on feat/$TICKET as qa/$TICKET has them, and their copy cannot be traced. $manual"
    return 0
  fi
  differ="$(git diff --name-only "$head" "$copy" | tr '\n' ' ')"
  if [[ -n "$differ" ]]; then
    warn "#$number was merged into feat/$TICKET as a copy (squash or rebase) that also holds other changes: ${differ% }. $manual"
    return 0
  fi
  commit_as_actor merge --quiet --no-edit -s ours "$copy" -m "Record that #$number reached feat/$TICKET as ${copy:0:7}

#$number was merged with a squash or a rebase: feat/$TICKET has a copy of its tests, not the
commits of qa/$TICKET. This merge changes no file. It lets the amendment merge into
feat/$TICKET without adding the tests a second time." || return 1
  echo "::notice title=QA amend tests::$(escape "#$number reached feat/$TICKET as a copy (${copy:0:7}): recorded on qa/$TICKET, so the amendment merges cleanly.")"
}
REASON_FILE="$RUNNER_TEMP/qa-amend-reason.txt"
CONTEXT="$RUNNER_TEMP/qa-amend-context.json"

case "${1:-}" in
  check)
    [[ "${TICKET:-}" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || fail "Invalid ticket \"${TICKET:-}\": use a key such as TICKET-43."
    [[ "${APP:-}" =~ ^[A-Za-z0-9._/-]+$ && "/$APP/" != */../* ]] || fail "Invalid application folder \"${APP:-}\"."
    reason="$(tr -s '[:space:]' ' ' <<<"${REASON:-}" | sed 's/^ //; s/ $//')"
    (( ${#reason} >= 20 )) || fail 'Say why the approved tests were wrong, in 20 characters or more: the reason is logged with them.'
    branch_exists "qa/$TICKET" || fail "No qa/$TICKET branch: there are no QA tests to amend. Run \"QA write tests\" first."
    branch_exists "feat/$TICKET" || fail "No feat/$TICKET branch to receive the amended tests."
    [[ -f "$WORK/$APP/qa-reviews/$TICKET/context.json" ]] || fail "qa/$TICKET has no review package in $APP/qa-reviews/$TICKET."
    echo "Request valid: amend the QA tests of $TICKET in $APP, as fixed on qa/$TICKET ($(git -C "$WORK" rev-parse --short HEAD))."
    ;;

  amend)
    cd "$WORK/$APP"
    node "$KIT/qa/scenario-review.ts" import "$TICKET" > "$CONTEXT" || fail "The review package of $TICKET cannot be read."
    mfe="$(jq -r .mfe "$CONTEXT")"; spec="$(jq -r .spec "$CONTEXT")"
    [[ "$mfe" =~ ^[a-z0-9-]+$ ]] || fail "The review package gives an invalid feature area: \"$mfe\"."
    node "$KIT/qa/check-tests.ts" || fail 'A test is disabled or focused.'
    # The tests must fail here: the application does not have the feature yet.
    rm -f reports/vitest.json reports/playwright.json
    npm run test:affected || true
    npm run test:e2e -- --grep "@$mfe" || true
    [[ -s reports/vitest.json && -s reports/playwright.json ]] || fail 'The tests did not produce their reports: see the log.'
    printf '%s\n' "$REASON" > "$REASON_FILE"
    node "$KIT/qa/scenario-review.ts" amend "$TICKET" "$spec" "@$GITHUB_ACTOR" "$REASON_FILE" \
      || fail "The amendment of $TICKET is refused: see the message above. The amended tests are unchanged on qa/$TICKET."
    node "$KIT/qa/scenario-review.ts" export "$TICKET" "$spec" "$mfe"
    node "$KIT/qa/scenario-review.ts" pr-body "$TICKET" > "$REVIEW_BODY"
    cat "$REVIEW_BODY" >> "$GITHUB_STEP_SUMMARY"
    ;;

  publish)
    [[ -s "$REVIEW_BODY" ]] || fail 'No review package: the amend step did not finish.'
    cd "$WORK"
    gh auth setup-git
    changed=(); other=()
    # git lists paths from the repository's root: an application at the root ("." ) has no prefix.
    package="qa-reviews/$TICKET/"; [[ "$APP" == . || "$APP" == ./ ]] || package="${APP%/}/$package"
    while IFS= read -r -d '' file; do
      case "$file" in
        "$package"*) changed+=("$file") ;;
        *) other+=("$file") ;;
      esac
    done < <(git ls-files -z --modified --others --exclude-standard)
    (( ${#other[@]} == 0 )) || fail "The job changed files outside the review package: ${other[*]}"
    (( ${#changed[@]} > 0 )) || fail 'The review package did not change.'
    git add -- "${changed[@]}"
    commit_as_actor commit --quiet -m "test($TICKET): log the amendment of the approved QA tests"
    git fetch --quiet --no-tags origin "+refs/heads/feat/$TICKET:refs/remotes/origin/feat/$TICKET"
    ( record_copy ) || warn "Could not check how the previous tests of $TICKET reached feat/$TICKET: see the log above. If the pull request conflicts, merge it by hand (HOW_TO_APPLY.md, \"Amend an approved test\")."
    bash "$KIT/qa/check-scope.sh" scope "origin/feat/$TICKET"
    git push --quiet origin "HEAD:refs/heads/qa/$TICKET"
    open="$(gh pr list --repo "$GITHUB_REPOSITORY" --head "qa/$TICKET" --base "feat/$TICKET" --state open --json url --jq '.[0].url // empty')"
    if [[ -n "$open" ]]; then
      gh pr edit "$open" --body-file "$REVIEW_BODY" >/dev/null
      url="$open"
    else
      url="$(gh pr create --repo "$GITHUB_REPOSITORY" --base "feat/$TICKET" --head "qa/$TICKET" \
        --title "$TICKET: amended QA tests to review" --body-file "$REVIEW_BODY")" \
        || fail "qa/$TICKET is pushed, but the pull request could not be opened: open it yourself, $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/compare/feat/$TICKET...qa/$TICKET?expand=1"
    fi
    echo "::notice title=Amended QA tests ready for review::$url"
    printf '\n**Review and approve the amendment:** %s\n' "$url" >> "$GITHUB_STEP_SUMMARY"
    # Red until the amendment is approved: the push above, made with GITHUB_TOKEN, triggers no workflow.
    bash "$KIT/qa/ci-approval.sh" "${url##*/}" \
      || echo "::warning title=QA amend tests::$(escape "The QA approval status could not be set on $url: see the log above. QA verify still checks the approval.")"
    ;;

  *) echo 'usage: qa/ci-amend-tests.sh check|amend|publish' >&2; exit 2 ;;
esac
