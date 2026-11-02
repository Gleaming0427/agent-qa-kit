#!/usr/bin/env bash
# The "QA write tests" workflow, step by step. Inputs come from the environment:
# TICKET (e.g. TICKET-43), MFE (the feature area, e.g. services) and APP (the
# application folder, relative to the repository).
#   check    validates the request before anything is installed or paid for
#   write    the QA writer agent writes the tests; they must fail for the right reason
#   publish  commits the tests and their review package on qa/<TICKET>, then opens
#            the pull request into feat/<TICKET>: its approval is the human review
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$KIT"
# Workflow commands need %, CR and LF escaped.
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
fail() { echo "::error title=QA write tests::$(escape "$1")"; exit 1; }
branch_exists() { gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$1" --silent >/dev/null 2>&1; }
SPEC="specs/${TICKET:-}.md"
REVIEW_BODY="$RUNNER_TEMP/qa-review-body.md"

case "${1:-}" in
  check)
    [[ "${TICKET:-}" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || fail "Invalid ticket \"${TICKET:-}\": use a key such as TICKET-43."
    [[ "${MFE:-}" =~ ^[a-z0-9-]+$ ]] || fail "Invalid feature area \"${MFE:-}\": lowercase letters, digits and dashes only."
    [[ "${APP:-}" =~ ^[A-Za-z0-9._/-]+$ && "/$APP/" != */../* && -f "$APP/package.json" ]] \
      || fail "No application in \"${APP:-}\": give the folder of its package.json, relative to the repository."
    [[ "$GITHUB_REF_TYPE" == branch ]] || fail 'Run the workflow from a branch, usually main.'
    [[ -f "$SPEC" ]] || fail "$SPEC is missing on $GITHUB_REF_NAME: commit the ticket's acceptance criteria first."
    node qa/criteria-manifest.ts "$TICKET" "$SPEC" "$RUNNER_TEMP/criteria.json" >/dev/null \
      || fail "$SPEC has no valid acceptance criteria: write one line per criterion, such as \"- AC-1: ...\"."
    [[ "${HAS_API_KEY:-}" == true ]] || fail 'Add an ANTHROPIC_API_KEY repository secret: the QA writer agent needs it.'
    if branch_exists "qa/$TICKET"; then
      fail "qa/$TICKET already exists. Review its pull request, or delete the branch to write the tests again."
    fi
    echo "Request valid: $TICKET, feature area $MFE, application $APP, from $GITHUB_REF_NAME."
    ;;

  write)
    code=0
    QA_PROJECT_DIR="$KIT/$APP" bash qa/run-qa.sh "$TICKET" 1 "$SPEC" "$MFE" || code=$?
    case "$code" in
      0) ;;
      2) fail "Blocked: the tests could not run in $APP. The agent's questions are in the qa-write-reports artifact." ;;
      *) fail "The QA writer did not produce failing tests that the kit accepts (code $code). See the log and the qa-write-reports artifact." ;;
    esac
    cd "$APP"
    node "$KIT/qa/scenario-review.ts" export "$TICKET" "$KIT/$SPEC" "$MFE"
    node "$KIT/qa/scenario-review.ts" pr-body "$TICKET" > "$REVIEW_BODY"
    cat "$REVIEW_BODY" >> "$GITHUB_STEP_SUMMARY"
    ;;

  publish)
    [[ -s "$REVIEW_BODY" ]] || fail 'No review package: the write step did not finish.'
    gh auth setup-git
    git switch --quiet -c "qa/$TICKET"
    qa_files=(); other=()
    while IFS= read -r -d '' file; do
      case "$file" in
        *.spec.ts|*.test.ts|*.test.tsx|qa-reviews/"$TICKET"/*|*/qa-reviews/"$TICKET"/*) qa_files+=("$file") ;;
        *) other+=("$file") ;;
      esac
    done < <(git ls-files -z --modified --others --exclude-standard -- "$APP")
    (( ${#qa_files[@]} > 0 )) || fail 'The QA writer wrote no test file.'
    if (( ${#other[@]} > 0 )); then
      echo "::warning title=QA write tests::$(escape "Changed during the run but not committed, as they are not tests: ${other[*]}")"
    fi
    git add -- "${qa_files[@]}"
    git -c user.name="$GITHUB_ACTOR" -c user.email="$GITHUB_ACTOR_ID+$GITHUB_ACTOR@users.noreply.github.com" \
      commit --quiet -m "test($TICKET): add the QA tests to review"
    bash qa/check-scope.sh scope "$GITHUB_SHA"
    git push --quiet origin "qa/$TICKET"
    # feat/<TICKET> receives the approved tests; the developer's work starts from it.
    branch_exists "feat/$TICKET" || git push --quiet origin "$GITHUB_SHA:refs/heads/feat/$TICKET"
    url="$(gh pr create --repo "$GITHUB_REPOSITORY" --base "feat/$TICKET" --head "qa/$TICKET" \
      --title "$TICKET: QA tests to review" --body-file "$REVIEW_BODY")" \
      || fail "qa/$TICKET is pushed, but the pull request could not be opened. Allow it in Settings > Actions > General (\"Allow GitHub Actions to create and approve pull requests\"), or open it yourself: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/compare/feat/$TICKET...qa/$TICKET?expand=1"
    echo "::notice title=QA tests ready for review::$url"
    printf '\n**Review and approve:** %s\n' "$url" >> "$GITHUB_STEP_SUMMARY"
    ;;

  *) echo 'usage: qa/ci-write-tests.sh check|write|publish' >&2; exit 2 ;;
esac
