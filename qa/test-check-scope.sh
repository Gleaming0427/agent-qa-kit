#!/usr/bin/env bash
# Branch rules on a real git history: a QA branch changes only tests, and the
# tests of a ticket with a qa/ branch stay frozen on every pull request.
cd "$(dirname "$0")/.." || exit 1
SCOPE="$PWD/qa/check-scope.sh"
REPO="$(mktemp -d)"
REPO2="$(mktemp -d)"
trap 'rm -rf "$REPO" "$REPO2"' EXIT
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
mkdir -p qa-reviews/TICKET-42
echo '{"tests":["e2e/TICKET-42.spec.ts"]}' > qa-reviews/TICKET-42/TICKET-42-review-request.json
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
branch feat/TICKET-42-review-edited feat/TICKET-42
echo '{"tests":[]}' > qa-reviews/TICKET-42/TICKET-42-review-request.json
commit 'edit the approved review package'
branch chore/review-unnamed main
mkdir -p qa-reviews/TICKET-42
echo '{}' > qa-reviews/TICKET-42/context.json
commit 'unnamed PR adds a review package'
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
expect 1 'dev PR named by its branch edits the review package' feat/TICKET-42-review-edited pr origin/main feat/TICKET-42-review-edited ''
expect 1 'unnamed PR that changes a review package'           chore/review-unnamed pr origin/main chore/review-unnamed 'Tidy up'
echo 'QA branch scope and the direct frozen check'
expect 0 'QA branch changes only tests and its review'       qa/TICKET-42 scope origin/main
expect 1 'QA branch changes the application'                  qa/TICKET-60 scope origin/main
expect 0 'frozen: tests identical to the QA branch'           feat/TICKET-42 frozen origin/main origin/qa/TICKET-42
expect 1 'frozen: a QA test was edited'                       feat/TICKET-42-test-edited frozen origin/main origin/qa/TICKET-42
# A second history, where main already holds the unit tests of a ticket: nothing refers to a qa/ branch.
cd "$REPO2" || exit 1
git init -q -b main
git config user.email qa@example.invalid
git config user.name QA
mkdir -p src
cat > src/App.test.tsx <<'TESTS'
test('[TICKET-42][AC-1] the button clears the search', () => {
  expect(clear()).toBe('');
});
beforeEach(() => {
  reset();
});
test('an older feature', () => {
  expect(older()).toBe(true);
});
TESTS
echo 'export const clear = () => "";' > src/App.tsx
commit 'base: a ticket and its unit test are on main'
git update-ref refs/remotes/origin/main main

branch fix/unit-weakened main
sed -i.bak "s/expect(clear()).toBe('');/expect(clear()).toBeDefined();/" src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'weaken the unit test of a ticket, unnamed'
branch fix/unit-removed main
sed -i.bak '1,3d' src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'remove the unit test of a ticket'
branch fix/unit-moved main
git mv src/App.test.tsx src/Search.test.tsx
commit 'move the test file of a ticket'
branch feat/TICKET-50 main
echo "test('[TICKET-50][AC-1] sorts', () => {});" >> src/App.test.tsx
sed -i.bak "s/toBe(true)/toBe(false)/" src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'another ticket adds a test, and changes an older one that has no ticket'
branch feat/TICKET-51 main
echo "test('[TICKET-51][AC-1] filters', () => {});" >> src/App.test.tsx
echo 'export const filter = 1;' >> src/App.tsx
commit 'another ticket adds a test and changes the application'
branch feat/TICKET-50-edits-42 main
sed -i.bak "s/toBe('')/toBe('x')/" src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'a pull request that names another ticket edits the test of TICKET-42'
branch qa/TICKET-70 main
echo "test('[TICKET-70][AC-1] new', () => {});" >> src/App.test.tsx
commit 'the QA agent adds a test'
branch qa/TICKET-71 main
sed -i.bak "s/toBe(true)/toBe(false)/" src/App.test.tsx && rm -f src/App.test.tsx.bak
echo "test('[TICKET-71][AC-1] new', () => {});" >> src/App.test.tsx
commit 'the QA agent rewrites a test that has no ticket'
branch qa/TICKET-72 main
sed -i.bak "s/toBe('')/toBe('x')/" src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'the QA agent rewrites the test of another ticket'
branch qa/TICKET-73 main
sed -i.bak "s|expect(older()).toBe(true);|expect(older()).toBe(true); // with a comment|" src/App.test.tsx && rm -f src/App.test.tsx.bak
commit 'the QA agent edits an older test, without a ticket to name'
branch qa/TICKET-74 main
sed -i.bak "s/reset();/reset(1);/" src/App.test.tsx && rm -f src/App.test.tsx.bak
echo "test('[TICKET-74][AC-1] new', () => {});" >> src/App.test.tsx
commit 'the QA agent changes a hook that was there, and adds a test'
branch qa/TICKET-75 main
sed -i.bak "s/^test('an older feature'/beforeEach(() => {});\ntest('an older feature'/" src/App.test.tsx && rm -f src/App.test.tsx.bak
echo "test('[TICKET-75][AC-1] new', () => {});" >> src/App.test.tsx
commit 'the QA agent adds a hook of its own and a test'

echo 'Every pull request: the tests of a ticket it does not name'
expect 1 'unnamed PR weakens the unit test of a ticket'              fix/unit-weakened pr origin/main fix/unit-weakened 'Tidy up'
expect 1 'unnamed PR removes the unit test of a ticket'              fix/unit-removed pr origin/main fix/unit-removed 'Tidy up'
expect 1 'unnamed PR moves the test file of a ticket'                fix/unit-moved pr origin/main fix/unit-moved 'Rename tests'
expect 0 'PR named by its title: the frozen check decides'           fix/unit-weakened pr origin/main fix/unit-weakened 'TICKET-42: tidy up'
expect 1 'PR that names another ticket edits the test of TICKET-42'  feat/TICKET-50-edits-42 pr origin/main feat/TICKET-50-edits-42 'TICKET-50: sort'
expect 0 'another ticket adds tests and edits an untagged one'       feat/TICKET-50 pr origin/main feat/TICKET-50 'TICKET-50: sort'
expect 0 'another ticket only adds a test'                           feat/TICKET-51 pr origin/main feat/TICKET-51 'TICKET-51: filter'
echo 'A QA branch changes only its own tests'
expect 0 'QA branch adds a test'                                     qa/TICKET-70 scope origin/main TICKET-70
expect 0 'QA branch adds a test, no ticket given'                    qa/TICKET-70 scope origin/main
expect 1 'QA branch rewrites a test that has no ticket'              qa/TICKET-71 scope origin/main TICKET-71
expect 1 'QA branch rewrites the test of another ticket'             qa/TICKET-72 scope origin/main TICKET-72
expect 1 'QA branch edits an older test, no ticket given'            qa/TICKET-73 scope origin/main
expect 1 'QA branch changes a hook that was there'                   qa/TICKET-74 scope origin/main TICKET-74
expect 0 'QA branch adds a hook of its own (not looked at)'          qa/TICKET-75 scope origin/main TICKET-75
expect 2 'a ticket that is not a ticket'                             qa/TICKET-70 scope origin/main notes
echo
if [[ "$failures" == 0 ]]; then echo "All $n branch rule cases behave as expected."; else echo "$failures of $n cases failed"; exit 1; fi
