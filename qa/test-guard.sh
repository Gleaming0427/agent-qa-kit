#!/usr/bin/env bash
# Regression matrix for Claude Code PreToolUse guard.
cd "$(dirname "$0")/.." || exit 1
GUARD="$PWD/.claude/hooks/qa-guard.sh"
export CLAUDE_PROJECT_DIR=/project
failures=0; n=0
check() {
  local expected="$1" description="$2" json="$3" message code
  n=$((n + 1))
  message="$(printf '%s' "$json" | "$GUARD" 2>&1)"; code=$?
  if [[ "$code" == "$expected" ]]; then
    [[ "$code" == 0 ]] && printf ' ok   allowed  %s\n' "$description" || printf ' ok   blocked  %s\n' "$description"
  else
    printf ' FAIL (got %s want %s) %s: %s\n' "$code" "$expected" "$description" "$message"
    failures=$((failures + 1))
  fi
}
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
echo 'Commands'
check 0 'affected tests'                     "$(action Bash command 'npm run test:affected')"
check 0 'E2E grep'                           "$(action Bash command 'npm run test:e2e -- --grep @services')"
check 0 'summary'                            "$(action Bash command 'npm run test:summary')"
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
echo
[[ "$failures" == 0 ]] && echo "All $n guard cases passed." || { echo "$failures of $n failed"; exit 1; }
