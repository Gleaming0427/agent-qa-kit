#!/usr/bin/env bash
# Regression matrix for Claude Code PreToolUse guard.
cd "$(dirname "$0")/.." || exit 1
GUARD="$PWD/.claude/hooks/qa-guard.sh"
export CLAUDE_PROJECT_DIR=/project
MODE=qa
failures=0; n=0
check() {
  local expected="$1" description="$2" json="$3" message code
  n=$((n + 1))
  message="$(printf '%s' "$json" | QA_GUARD_MODE="$MODE" "$GUARD" 2>&1)"; code=$?
  if [[ "$code" == "$expected" ]]; then
    [[ "$code" == 0 ]] && printf ' ok   allowed  %s\n' "$description" || printf ' ok   blocked  %s\n' "$description"
  else
    printf ' FAIL (got %s want %s) %s: %s\n' "$code" "$expected" "$description" "$message"
    failures=$((failures + 1))
  fi
}
# A refusal names what to do instead: the agents read it before their next try.
says() {
  local text="$1" description="$2" json="$3" message
  n=$((n + 1))
  message="$(printf '%s' "$json" | QA_GUARD_MODE="$MODE" "$GUARD" 2>&1)"
  if [[ "$message" == *"$text"* ]]; then
    printf ' ok   says     %s\n' "$description"
  else
    printf ' FAIL (no "%s") %s: %s\n' "$text" "$description" "$message"
    failures=$((failures + 1))
  fi
}
search() { jq -cn --arg t "$1" --arg p "$2" --arg q "$3" '{tool_name:$t,tool_input:{path:$p,pattern:$q}}'; }
action() { jq -cn --arg t "$1" --arg k "$2" --arg v "$3" '{tool_name:$t,tool_input:{($k):$v}}'; }
file_action() { jq -cn --arg t "$1" --arg f "$2" --arg c "$3" '{tool_name:$t,tool_input:{file_path:$f,content:$c,new_string:$c}}'; }
echo 'Reads'
check 0 'read a component'                    "$(action Read file_path /project/apps/services/src/ServiceList.tsx)"
check 0 'read .env.example'                   "$(action Read file_path .env.example)"
check 2 'read .env'                           "$(action Read file_path /project/.env)"
check 2 'read .env.production'                "$(action Read file_path apps/services/.env.production)"
check 2 'read .npmrc'                         "$(action Read file_path .npmrc)"
check 2 'read outside project'                "$(action Read file_path /root/.ssh/id_rsa)"
check 2 'read /etc/passwd'                    "$(action Read file_path /etc/passwd)"
check 2 'search secrets folder'               "$(action Grep path config/secrets)"
check 2 'unscoped Grep search (might expose secrets)' '{"tool_name":"Grep","tool_input":{"pattern":"PASSWORD"}}'
check 0 'glob source files'                   "$(action Glob pattern 'src/**/*.{ts,tsx}')"
check 0 'glob with an absolute pattern inside the project' "$(action Glob pattern '/project/src/**/*.tsx')"
check 2 'glob with an absolute pattern outside the project' "$(action Glob pattern '/home/runner/work/kit/eval/**/*.md')"
check 2 'glob with a parent path'             "$(action Glob pattern '../../eval/**')"
check 2 'glob with an absolute alternative'   "$(action Glob pattern '{src,/etc}/*')"
check 2 'glob in the home folder'             "$(action Glob pattern '~/.ssh/*')"
# Glob from the project root lists names only, as Glob with no path does; Grep would read every file.
check 0 'glob from the project root'          "$(search Glob /project '{src,e2e}/**/*')"
check 0 'glob from the project root, as .'    "$(search Glob . 'src/**/*.tsx')"
check 2 'grep from the project root'          "$(search Grep /project 'loyal|member')"
says 'Grep needs a folder inside the project, such as src or e2e' 'grep from the root says which folder to give' "$(search Grep /project 'loyal')"
echo 'Writes' 
check 0 'write component test'                "$(file_action Write apps/services/src/ServiceList.test.tsx "it('AC-2', () => {})")"
check 0 'write Playwright scenario'           "$(file_action Write /project/e2e/TICKET-42.spec.ts "test.describe('@services', () => {})")"
check 2 'modify application code'             "$(file_action Edit apps/services/src/ServiceList.tsx 'export const x = 1')"
check 2 'modify Playwright config'            "$(file_action Edit playwright.config.ts 'retries: 0')"
check 2 'modify package.json'                 "$(file_action Edit package.json '{}')"
check 2 'parent traversal'                    "$(file_action Write e2e/../src/App.test.tsx 'x')"
check 2 'test.skip'                           "$(file_action Edit e2e/TICKET-42.spec.ts "test.skip('AC-1', async () => {})")"
check 2 'it.only'                             "$(file_action Write apps/services/src/a.test.tsx "it.only('x', () => {})")"
check 2 'xit'                                 "$(file_action Write apps/services/src/a.test.tsx "xit('x', () => {})")"
check 2 'describe.skip'                       "$(file_action Write e2e/a.spec.ts "test.describe.skip('@services', () => {})")"
check 2 'test file inside installed packages'  "$(file_action Write node_modules/vitest/dist/a.test.ts "it('x', () => {})")"
check 2 'test file inside git metadata'        "$(file_action Write .git/hooks/a.test.ts "it('x', () => {})")"
echo 'Commands'
check 0 'affected tests'                     "$(action Bash command 'npm run test:affected')"
check 0 'E2E grep'                           "$(action Bash command 'npm run test:e2e -- --grep @services')"
check 0 'summary'                            "$(action Bash command 'npm run test:summary')"
check 0 'run the tests, then the summary'    "$(action Bash command 'npm run test:summary -- --run @services')"
check 2 'summary, feature area without @'    "$(action Bash command 'npm run test:summary -- --run services')"
check 2 'summary with another option'        "$(action Bash command 'npm run test:summary -- --run @services --json')"
check 0 'test cycle that stops after unit failures' "$(action Bash command 'npm run test:summary -- --run @services --stop-on-unit-failure')"
check 2 'stop option with something after it' "$(action Bash command 'npm run test:summary -- --run @services --stop-on-unit-failure --json')"
check 2 'stop option before the feature area' "$(action Bash command 'npm run test:summary -- --run --stop-on-unit-failure @services')"
check 2 'read a file with cat'               "$(action Bash command 'cat reports/TICKET-42-criteria.json')"
says 'use the Read tool to read a file'      'cat says to use Read'  "$(action Bash command 'cat reports/TICKET-42-criteria.json')"
says 'Glob to list files'                    'ls says to use Glob'   "$(action Bash command 'ls src')"
# What the agents tried most in the evaluation: the three test commands in one, the output cut.
check 2 'the test cycle chained'             "$(action Bash command 'npm run test:affected >/dev/null 2>&1; npm run test:e2e -- --grep @shop >/dev/null 2>&1; npm run test:summary 2>&1 | tail -60')"
says 'npm run test:summary -- --run @<mfe>'  'chaining says to run one command, and how to run a cycle' "$(action Bash command 'npm run test:affected 2>&1 | tail -n 80')"
check 0 'one test file'                      "$(action Bash command 'npx vitest run apps/services/src/ServiceList.test.tsx')"
check 0 'read diff'                          "$(action Bash command 'git diff --name-only origin/master...HEAD')"
check 2 'update snapshots -u'                "$(action Bash command 'npx vitest run -u')"
check 2 'update snapshots --update'          "$(action Bash command 'npx playwright test --update-snapshots')"
check 2 'chain deletion'                     "$(action Bash command 'npm test && rm -rf src')"
check 2 'redirect file'                      "$(action Bash command 'echo hacked > src/App.tsx')"
check 2 'subshell'                           "$(action Bash command 'npm test $(rm -rf src)')"
check 2 'multiline'                          "$(action Bash command $'npm test\nrm -rf src')"
check 2 'sed edit'                           "$(action Bash command 'sed -i s/a/b/ src/App.tsx')"
check 2 'package install'                    "$(action Bash command 'npm install left-pad')"
check 2 'build command'                      "$(action Bash command 'npm run build')"
check 2 'git push'                           "$(action Bash command 'git push --force')"
check 2 'network curl'                       "$(action Bash command 'curl https://example.com')"
echo 'Robustness'
check 2 'invalid JSON'                       'not json'
check 2 'tool name missing'                  '{"tool_input":{}}'
check 2 'unknown tool'                       '{"tool_name":"Computer","tool_input":{}}'
check 2 'unsafe E2E options'                 "$(action Bash command 'npm run test:e2e -- --grep @services --update-snapshots')"
echo 'Repair mode: the agent fixes the application, never the tests'
MODE=repair
check 0 'fix a component'                     "$(file_action Edit apps/services/src/ServiceList.tsx 'export const x = 1')"
check 0 'add a source file'                   "$(file_action Write src/search.ts 'export const search = 1')"
check 0 'build the app'                       "$(action Bash command 'npm run build')"
check 0 'run the failing tests'               "$(action Bash command 'npm run test:affected')"
check 2 'edit a unit test'                    "$(file_action Edit apps/services/src/ServiceList.test.tsx "it('AC-2', () => {})")"
check 2 'edit a browser test'                 "$(file_action Write e2e/TICKET-42.spec.ts "test('AC-2', () => {})")"
check 2 'edit a nested e2e helper'            "$(file_action Edit examples/demo/e2e/helpers.ts 'export {}')"
check 2 'replace a screenshot baseline'       "$(file_action Write e2e/smoke.spec.ts-snapshots/home-linux.png 'x')"
check 2 'edit package.json'                   "$(file_action Edit apps/services/package.json '{}')"
check 2 'edit Playwright config'              "$(file_action Edit playwright.config.ts 'retries: 5')"
check 2 'edit Vite config'                    "$(file_action Edit vite.config.ts 'test: {}')"
check 2 'edit the kit'                        "$(file_action Edit qa/run-qa.sh 'exit 0')"
check 2 'edit the guard'                      "$(file_action Edit .claude/hooks/qa-guard.sh 'exit 0')"
check 2 'edit CI'                             "$(file_action Edit .github/workflows/qa-guard.yml 'on: []')"
check 2 'write a report'                      "$(file_action Write reports/TICKET-42-phase2.json '{}')"
check 2 'edit the ticket'                     "$(file_action Edit specs/TICKET-42.md '- AC-1: anything')"
check 2 'patch the test runner'               "$(file_action Edit node_modules/vitest/dist/index.js 'export const expect = () => ({})')"
check 2 'patch a nested installed package'    "$(file_action Write apps/services/node_modules/@playwright/test/index.js 'export {}')"
check 2 'add a git hook'                      "$(file_action Write .git/hooks/pre-commit 'npm publish')"
check 2 'edit the git config'                 "$(file_action Edit /project/.git/config '[core] fsmonitor = evil')"
check 0 'a source file named like those'      "$(file_action Write src/node_modules-info.ts 'export {}')"
# What the tests are set up with: no configuration needs to name it, the name is enough.
check 2 'edit a setup file'                   "$(file_action Edit src/setupTests.ts "import '@testing-library/jest-dom'")"
check 2 'edit a setup file, other spelling'   "$(file_action Edit src/setup-tests.tsx 'export {}')"
check 2 'edit vitest.setup'                   "$(file_action Edit vitest.setup.ts 'export {}')"
check 2 'edit a Playwright setup project'     "$(file_action Edit e2e-support/auth.setup.ts 'export {}')"
check 2 'edit a global teardown'              "$(file_action Edit apps/shop/globalTeardown.js 'export {}')"
check 2 'edit a mock'                         "$(file_action Edit src/__mocks__/api.ts 'export {}')"
check 2 'add a mock'                          "$(file_action Write apps/shop/src/__mocks__/cart.ts 'export {}')"
check 2 'edit a fixture'                      "$(file_action Edit src/__fixtures__/cart.json '{}')"
check 2 'edit a test helper'                  "$(file_action Edit src/test-utils.tsx 'export {}')"
check 2 'edit a test helper, camel case'      "$(file_action Edit src/testUtils.ts 'export {}')"
check 2 'edit a helper in a tests folder'     "$(file_action Edit src/tests/helpers.ts 'export {}')"
check 2 'edit a helper in a test folder'      "$(file_action Edit apps/shop/test/render.tsx 'export {}')"
check 2 'a setup file, upper case'            "$(file_action Edit src/SetupTests.TS 'export {}')"
check 0 'an application file that only looks similar' "$(file_action Edit src/setup.ts 'export {}')"
check 0 'an application folder named latest'  "$(file_action Edit src/latest/cart.ts 'export {}')"
check 0 'a component with test in its name'   "$(file_action Edit src/TestimonialList.tsx 'export {}')"
check 0 'a utility that is not a test one'    "$(file_action Edit src/utils.ts 'export {}')"
says 'say so in your answer instead'          'a refusal says to report the file, not to work around it' "$(file_action Edit src/setupTests.ts 'x')"
check 2 'read .env'                           "$(action Read file_path /project/.env)"
check 2 'install a package'                   "$(action Bash command 'npm install left-pad')"
check 2 'edit through sed'                    "$(action Bash command 'sed -i s/a/b/ src/App.test.tsx')"
echo
[[ "$failures" == 0 ]] && echo "All $n guard cases passed." || { echo "$failures of $n failed"; exit 1; }
