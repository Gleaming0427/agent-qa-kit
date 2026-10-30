#!/usr/bin/env bash
# CI check: everyone stays in their lane.
#
# Usage:
#   qa/check-scope.sh scope <base>
#       On the QA agent's branch: fails if any file other than a test
#       was modified compared with <base>.
#
#   qa/check-scope.sh frozen <base> <qa-branch>
#       On the final branch: fails if a test written by the QA agent has been
#       modified or deleted since. The development agent does not touch tests.
#
#   qa/check-scope.sh pr <base> <head-branch> [pr-title]
#       On every pull request, for each ticket that has an origin/qa/<ticket>
#       branch: if the branch name or the title names the ticket, its tests
#       must match the QA branch ("frozen"); otherwise the PR may not touch
#       the ticket's browser tests, e2e/<ticket>.spec.ts, at all.
#
# This check does not depend on the agents: even if a guard were bypassed
# during the work, the PR could not be merged.

set -uo pipefail

usage() {
  echo "usage: $0 scope <base> | $0 frozen <base> <qa-branch> | $0 pr <base> <head-branch> [pr-title]" >&2
  exit 2
}

is_test() {
  case "$1" in
    *.spec.ts|*.test.ts|*.test.tsx|*.test.mjs) return 0 ;;
    *) return 1 ;;
  esac
}

check_ref() {
  git rev-parse --verify --quiet "$1^{commit}" >/dev/null || {
    echo "Unknown git reference: $1" >&2
    exit 2
  }
}

# Tests the QA branch wrote must be identical on HEAD.
check_frozen() {
  local base="$1" qa="$2" file
  local modified=()
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    is_test "$file" || continue
    git diff --quiet "$qa" HEAD -- "$file" || modified+=("$file")
  done < <(git diff --name-only "$base"..."$qa")

  if (( ${#modified[@]} > 0 )); then
    echo "These tests differ from the version written by the QA agent on $qa:"
    printf '  %s\n' "${modified[@]}"
    echo "Any change to a test must be reviewed by a human."
    return 1
  fi
  echo "Frozen tests: identical to the version written by the QA agent on $qa."
}

MODE="${1:-}"
case "$MODE" in
  scope)
    [[ $# -eq 2 ]] || usage
    BASE="$2"; check_ref "$BASE"
    out_of_scope=()
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      is_test "$file" || out_of_scope+=("$file")
    done < <(git diff --name-only "$BASE"...HEAD)

    if (( ${#out_of_scope[@]} > 0 )); then
      echo "The QA branch modifies files that are not tests:"
      printf '  %s\n' "${out_of_scope[@]}"
      exit 1
    fi
    echo "QA scope respected: only tests were modified."
    ;;

  frozen)
    [[ $# -eq 3 ]] || usage
    BASE="$2"; QA="$3"; check_ref "$BASE"; check_ref "$QA"
    check_frozen "$BASE" "$QA" || exit 1
    ;;

  pr)
    [[ $# -eq 3 || $# -eq 4 ]] || usage
    BASE="$2"; HEAD_BRANCH="$3"; TITLE="${4:-}"; check_ref "$BASE"
    # Tickets this PR names, in its branch name or its title.
    named=" $(grep -oE '[A-Z][A-Z0-9]*-[0-9]+' <<<"$HEAD_BRANCH $TITLE" | sort -u | tr '\n' ' ')"
    failed=0; checked=0
    while IFS= read -r qa; do
      ticket="${qa#origin/qa/}"
      [[ "$ticket" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || continue
      [[ "$HEAD_BRANCH" != "qa/$ticket" ]] || continue  # the QA agent's own branch: see "scope"
      checked=$((checked + 1))
      if [[ "$named" == *" $ticket "* ]]; then
        check_frozen "$BASE" "$qa" || failed=1
      elif [[ -n "$(git diff --name-only "$BASE"...HEAD -- ":(glob)**/e2e/$ticket.spec.ts")" ]]; then
        echo "This PR changes the browser tests of $ticket without naming the ticket."
        echo "Name $ticket in the branch or the title, so its tests are compared with $qa."
        failed=1
      fi
    done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin/qa/)
    (( failed == 0 )) || exit 1
    echo "Frozen tests respected: $checked ticket(s) with a qa/ branch checked."
    ;;

  *)
    usage
    ;;
esac
