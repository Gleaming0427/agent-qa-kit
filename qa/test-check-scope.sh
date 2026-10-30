#!/usr/bin/env bash
# Branch rules on a real git history: a QA branch changes only tests, and the
# tests of a ticket with a qa/ branch stay frozen on every pull request.
cd "$(dirname "$0")/.." || exit 1
SCOPE="$PWD/qa/check-scope.sh"
REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT
cd "$REPO" || exit 1
git init -q -b main
git config user.email qa@example.invalid
git config user.name QA
commit() { git add -A && git commit -qm "$1"; }
branch() { git checkout -q -b "$1" "$2"; }

failures=0
n=0
# expect <code> <description> <branch to check out> <check-scope.sh arguments...>
expect() {
  local expected="$1" description="$2" head="$3" code
  shift 3
  n=$((n + 1))
  git checkout -q "$head"
  bash "$SCOPE" "$@" >/dev/null 2>&1
  code=$?
  if [[ "$code" == "$expected" ]]; then
    [[ "$code" == 0 ]] && printf '  ok   accepted   %s\n' "$description" || printf '  ok   refused    %s\n' "$description"
  else
    printf '  FAILED (code %s, expected %s)  %s\n' "$code" "$expected" "$description"
    failures=$((failures + 1))
  fi
}

mkdir -p src e2e
echo 'export const search = 1;' > src/app.ts
echo "test('an older feature', () => {});" > src/App.test.tsx
commit 'base'
git update-ref refs/remotes/origin/main main

# The QA agent's branch: a browser test file and a unit test in a shared file.
branch qa/TICKET-42 main
echo "test('[TICKET-42][AC-1] shell', () => {});" > e2e/TICKET-42.spec.ts
echo "test('[TICKET-42][AC-1] unit', () => {});" >> src/App.test.tsx
commit 'TICKET-42 tests'
git update-ref refs/remotes/origin/qa/TICKET-42 qa/TICKET-42

branch feat/TICKET-42 qa/TICKET-42
echo 'export const search = 2;' > src/app.ts
commit 'TICKET-42 implementation'
branch feat/TICKET-42-test-edited feat/TICKET-42
echo "test('[TICKET-42][AC-1] shell', () => { /* weakened */ });" > e2e/TICKET-42.spec.ts
commit 'edit a QA test'
branch fix/search feat/TICKET-42
echo 'export const search = 3;' > src/app.ts
commit 'unnamed branch'
branch fix/search-unit-edited fix/search
sed -i.bak 's/unit/unit, weakened/' src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'edit a QA unit test'
branch chore/docs main
echo 'docs' > README.md
commit 'docs'
branch feat/TICKET-50 main
echo "test('[TICKET-50][AC-1] unit', () => {});" >> src/App.test.tsx
commit 'another ticket in the shared test file'
branch qa/TICKET-50 qa/TICKET-42
echo "test('[TICKET-42][AC-1] shell', () => { /* rewritten */ });" > e2e/TICKET-42.spec.ts
commit 'another QA branch edits a frozen test'
branch chore/nested main
mkdir -p examples/demo/e2e
echo "test('[TICKET-42][AC-1] nested', () => {});" > examples/demo/e2e/TICKET-42.spec.ts
commit 'nested browser test'
branch qa/TICKET-60 main
echo 'export const search = 0;' > src/app.ts
commit 'a QA branch edits the application'

echo 'Every pull request: frozen tests'
expect 0 'dev PR named by its branch keeps the QA tests'      feat/TICKET-42 pr origin/main feat/TICKET-42 'Case-insensitive search'
expect 1 'dev PR named by its branch edits a QA test'         feat/TICKET-42-test-edited pr origin/main feat/TICKET-42-test-edited ''
expect 1 'unnamed PR that carries the browser tests'          fix/search pr origin/main fix/search 'Fix search'
expect 0 'PR named by its title keeps the QA tests'           fix/search pr origin/main fix/search 'TICKET-42: fix search'
expect 1 'PR named by its title edits a QA unit test'         fix/search-unit-edited pr origin/main fix/search-unit-edited 'TICKET-42: fix search'
expect 0 'unrelated PR, ticket-like word in the title'        chore/docs pr origin/main chore/docs 'Fix UTF-8 output'
expect 0 'another ticket adds tests to the shared file'       feat/TICKET-50 pr origin/main feat/TICKET-50 'TICKET-50: sort services'
expect 0 'the QA branch itself'                               qa/TICKET-42 pr origin/main qa/TICKET-42 'TICKET-42 tests'
expect 1 'another QA branch edits frozen browser tests'       qa/TICKET-50 pr origin/main qa/TICKET-50 'TICKET-50 tests'
expect 1 'browser tests in a nested project, unnamed'         chore/nested pr origin/main chore/nested 'Add a demo'
echo 'QA branch scope and the direct frozen check'
expect 0 'QA branch changes only tests'                       qa/TICKET-42 scope origin/main
expect 1 'QA branch changes the application'                  qa/TICKET-60 scope origin/main
expect 0 'frozen: tests identical to the QA branch'           feat/TICKET-42 frozen origin/main origin/qa/TICKET-42
expect 1 'frozen: a QA test was edited'                       feat/TICKET-42-test-edited frozen origin/main origin/qa/TICKET-42
echo
if [[ "$failures" == 0 ]]; then echo "All $n branch rule cases behave as expected."; else echo "$failures of $n cases failed"; exit 1; fi
