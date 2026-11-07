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
REVIEW_BODY="$RUNNER_TEMP/qa-amend-body.md"
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
    git -c user.name="$GITHUB_ACTOR" -c user.email="$GITHUB_ACTOR_ID+$GITHUB_ACTOR@users.noreply.github.com" \
      commit --quiet -m "test($TICKET): log the amendment of the approved QA tests"
    git fetch --quiet --no-tags origin "+refs/heads/feat/$TICKET:refs/remotes/origin/feat/$TICKET"
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
