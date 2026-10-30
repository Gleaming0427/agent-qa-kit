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
# This check does not depend on the agents: even if a guard were bypassed
# during the work, the PR could not be merged.

set -uo pipefail

usage() {
  echo "usage: $0 scope <base> | $0 frozen <base> <qa-branch>" >&2
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
    modified=()
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      is_test "$file" || continue
      git diff --quiet "$QA" HEAD -- "$file" || modified+=("$file")
    done < <(git diff --name-only "$BASE"..."$QA")

    if (( ${#modified[@]} > 0 )); then
      echo "These tests differ from the version written by the QA agent:"
      printf '  %s\n' "${modified[@]}"
      echo "Any change to a test must be reviewed by a human."
      exit 1
    fi
    echo "Frozen tests: identical to the version written by the QA agent."
    ;;

  *)
    usage
    ;;
esac
