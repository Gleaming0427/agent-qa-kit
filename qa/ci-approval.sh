#!/usr/bin/env bash
# The "QA approval" commit status of a QA pull request (qa/<TICKET> into feat/<TICKET>),
# shown next to its merge button. It stays red until a collaborator approves the latest
# commit of the tests with one line per criterion, and says what is missing: the approval
# QA verify will require later. It does not prevent the merge.
# "QA write tests" and "QA amend tests" set it when they open the pull request (their
# pull requests trigger no workflow); the "QA approval" workflow updates it after each
# review, and after each push by a person.
# Usage: qa/ci-approval.sh PULL_NUMBER
# Needs GH_TOKEN (statuses: write, pull-requests: read), GITHUB_REPOSITORY, RUNNER_TEMP,
# and the pull request's latest commit in the git repository of the current folder.
set -euo pipefail
KIT="$(cd "$(dirname "$0")/.." && pwd)"
# Workflow commands need %, CR and LF escaped.
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
number="${1:-}"
[[ "$number" =~ ^[1-9][0-9]*$ ]] || { echo 'usage: qa/ci-approval.sh PULL_NUMBER' >&2; exit 2; }
pull="$RUNNER_TEMP/qa-approval-$number-pull.json"
reviews="$RUNNER_TEMP/qa-approval-$number-reviews.json"
request="$RUNNER_TEMP/qa-approval-$number-request.json"
summary() { [[ -z "${GITHUB_STEP_SUMMARY:-}" ]] || printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"; }

gh api "repos/$GITHUB_REPOSITORY/pulls/$number" > "$pull"
ref="$(jq -r .head.ref "$pull")"; sha="$(jq -r .head.sha "$pull")"
if [[ ! "$ref" =~ ^qa/([A-Z][A-Z0-9]*-[0-9]+)$ || "$(jq -r '.head.repo.full_name // empty' "$pull")" != "$GITHUB_REPOSITORY" ]]; then
  echo "#$number is not a QA pull request of this repository ($ref): no approval status."
  exit 0
fi
ticket="${BASH_REMATCH[1]}"
if [[ "$(jq -r .state "$pull")" == closed && "$(jq -r '.merged_at // empty' "$pull")" == "" ]]; then
  echo "#$number was closed without merging: no approval status."
  exit 0
fi
if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "::notice title=QA approval::$(escape "#$number moved on to ${sha:0:7} during this run: the run for that commit sets the status.")"
  exit 0
fi

# The criteria come from the review package of the commit to approve.
package="$(git ls-tree -r --name-only "$sha" | grep -E "(^|/)qa-reviews/$ticket/$ticket-review-request\.json$" | head -n 1 || true)"
if [[ -n "$package" ]]; then
  git show "$sha:$package" > "$request"
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls/$number/reviews?per_page=100" > "$reviews"
  status="$(node "$KIT/qa/github-approval.ts" status "$pull" "$reviews" "$request")"
else
  status="$(jq -nc --arg ticket "$ticket" \
    '{state: "failure", description: "No review package qa-reviews/\($ticket)/ in this pull request: QA verify cannot check its approval."}')"
fi
state="$(jq -r .state <<<"$status")"; description="$(jq -r .description <<<"$status")"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY/actions/runs/${GITHUB_RUN_ID:-}"
gh api --silent -X POST "repos/$GITHUB_REPOSITORY/statuses/$sha" \
  -f state="$state" -f context='QA approval' -f description="$description" -f target_url="$run_url"
echo "#$number ($ticket, ${sha:0:7}): QA approval $state. $description"
summary "- **QA approval** of #$number ($ticket): $([[ "$state" == success ]] && echo 'complete' || echo 'not complete'). $description"
