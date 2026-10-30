#!/usr/bin/env bash
# Demonstrates the QA agent's guard: each line simulates an action
# of the agent and checks that it is allowed (0) or blocked (2).
# Usage: qa/test-guard.sh

cd "$(dirname "$0")/.." || exit 1
GUARD="$PWD/.claude/hooks/qa-guard.sh"
export CLAUDE_PROJECT_DIR=/project

failures=0
n=0
check() {
  local expected="$1" description="$2" json="$3"
  local message code
  n=$((n + 1))
  message="$(printf '%s' "$json" | "$GUARD" 2>&1)"
  code=$?
  if [[ "$code" == "$expected" ]]; then
    [[ "$code" == 0 ]] && printf '  ok   allowed   %s\n' "$description" \
                       || printf '  ok   blocked   %s\n' "$description"
  else
    printf '  FAILED (code %s, expected %s)  %s\n' "$code" "$expected" "$description"
    failures=$((failures + 1))
  fi
}
action() { jq -cn --arg t "$1" --arg k "$2" --arg v "$3" '{tool_name:$t, tool_input:{($k):$v}}'; }
file_action() { jq -cn --arg t "$1" --arg f "$2" --arg c "$3" '{tool_name:$t, tool_input:{file_path:$f, content:$c, new_string:$c}}'; }

echo "Reads"
check 0 "read a component"                     "$(action Read file_path /project/apps/services/src/ServiceList.tsx)"
check 0 "read .env.example"                    "$(action Read file_path .env.example)"
check 2 "read .env"                            "$(action Read file_path /project/.env)"
check 2 "read .env.production"                 "$(action Read file_path apps/services/.env.production)"
check 2 "read .npmrc (tokens)"                 "$(action Read file_path .npmrc)"
check 2 "read an SSH key outside the project"  "$(action Read file_path /root/.ssh/id_rsa)"
check 2 "read /etc/passwd"                     "$(action Read file_path /etc/passwd)"
check 2 "search a secrets folder"              "$(action Grep path config/secrets)"

echo "Writes"
check 0 "write a component test"               "$(file_action Write apps/services/src/ServiceList.test.tsx "it('AC-2', () => {})")"
check 0 "write a Playwright scenario"          "$(file_action Write /project/e2e/TICKET-42.spec.ts "test.describe('@services', () => {})")"
check 2 "modify application code"              "$(file_action Edit apps/services/src/ServiceList.tsx "export const x = 1")"
check 2 "modify the Playwright config"         "$(file_action Edit playwright.config.ts "retries: 0")"
check 2 "modify package.json"                  "$(file_action Edit package.json "{}")"
check 2 "leave the project with .."            "$(file_action Write e2e/../src/App.test.tsx "x")"
check 2 "add a test.skip"                      "$(file_action Edit e2e/TICKET-42.spec.ts "test.skip('AC-1', async () => {})")"
check 2 "add an it.only"                       "$(file_action Write apps/services/src/a.test.tsx "it.only('x', () => {})")"
check 2 "add an xit"                           "$(file_action Write apps/services/src/a.test.tsx "xit('x', () => {})")"
check 2 "add a test.describe.skip"             "$(file_action Write e2e/a.spec.ts "test.describe.skip('@services', () => {})")"

echo "Commands"
check 0 "tests of the modified MFE"            "$(action Bash command 'npm run test:affected')"
check 0 "MFE scenarios inside the shell"       "$(action Bash command 'npm run test:e2e -- --grep @services')"
check 0 "results summary"                      "$(action Bash command 'npm run test:summary')"
check 0 "one specific test file"               "$(action Bash command 'npx vitest run apps/services/src/ServiceList.test.tsx')"
check 0 "read the git diff"                    "$(action Bash command 'git diff --name-only origin/master...HEAD')"
check 2 "update snapshots (-u)"                "$(action Bash command 'npx vitest run -u')"
check 2 "update snapshots"                     "$(action Bash command 'npx playwright test --update-snapshots')"
check 2 "chain a deletion"                     "$(action Bash command 'npm test && rm -rf src')"
check 2 "redirect to a file"                   "$(action Bash command 'echo hacked > src/App.tsx')"
check 2 "\$( ) subshell"                       "$(action Bash command 'npm test $(rm -rf src)')"
check 2 "command on two lines"                 "$(action Bash command $'npm test\nrm -rf src')"
check 2 "edit with sed"                        "$(action Bash command 'sed -i s/a/b/ src/App.tsx')"
check 2 "install a package"                    "$(action Bash command 'npm install left-pad')"
check 2 "run the build"                        "$(action Bash command 'npm run build')"
check 2 "push to git"                          "$(action Bash command 'git push --force')"
check 2 "call the network"                     "$(action Bash command 'curl https://example.com')"

echo "Robustness"
check 2 "invalid JSON"                         'not json'
check 2 "tool without a name"                  '{"tool_input":{}}'

echo
if [[ "$failures" == 0 ]]; then
  echo "All $n cases behave as expected."
else
  echo "$failures of $n cases do not behave as expected."
  exit 1
fi
