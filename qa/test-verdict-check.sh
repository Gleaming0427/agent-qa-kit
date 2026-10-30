#!/usr/bin/env bash
# Original regression cases; retained for backwards compatibility.
cd "$(dirname "$0")/.." || exit 1
CHECK="$PWD/.claude/hooks/verdict-check.ts"
PROJECT="$(mktemp -d)"
export TMPDIR="$(mktemp -d)" CLAUDE_PROJECT_DIR="$PROJECT"
trap 'rm -rf "$PROJECT" "$TMPDIR"' EXIT
mkdir -p "$PROJECT/reports" "$PROJECT/e2e"
unset QA_RUN_ID QA_PHASE QA_STRICT_EVIDENCE
failures=0
n=0
run_case() {
  local expected="$1" description="$2" phase="$3" message="$4" option="${5:-}"
  n=$((n + 1))
  local input code
  input="$(jq -cn --arg m "$message" --arg s "case-$n" '{last_assistant_message: $m, session_id: $s}')"
  printf '%s' "$input" | node "$CHECK" "$phase" $option >/dev/null 2>&1
  code=$?
  if [[ "$code" == "$expected" ]]; then
    [[ "$code" == 0 ]] && printf '  ok   accepted   %s\n' "$description" || printf '  ok   sent back  %s\n' "$description"
  else
    printf '  FAILED (code %s, expected %s)  %s\n' "$code" "$expected" "$description"
    failures=$((failures + 1))
  fi
}
reports() {
  rm -f "$PROJECT/reports/"*.json
  [[ "$1" != absent ]] && echo "{\"numFailedTests\": $1, \"numPassedTests\": 5}" > "$PROJECT/reports/vitest.json"
  [[ "$2" != absent ]] && echo "{\"stats\": {\"expected\": 3, \"unexpected\": $2, \"flaky\": ${3:-0}}}" > "$PROJECT/reports/playwright.json"
  return 0
}
verdict() {
  jq -cn --argjson p "$1" --arg v "$2" --arg sm "$3" --arg ss "$4" "
    {ticket: \"TICKET-42\", phase: \$p, verdict: \$v,
     criteria: [range(1; 4) as \$i | (\"mfe\", \"shell\") as \$l |
       {id: \"AC-\(\$i)\", level: \$l, status: (if \$l == \"mfe\" then \$sm else \$ss end), evidence: \"test AC-\(\$i)\"}],
     flaky_tests: [], spec_questions: [], alerts: []} ${5:-}"
}
echo 'Phase 1: write the tests'
touch "$PROJECT/e2e/TICKET-42.spec.ts"
reports 3 absent
run_case 0 'complete verdict, tests failing as expected'     1 "$(verdict 1 ready written written)"
run_case 0 'verdict in a json block surrounded by text'      1 "Here is the verdict:
\`\`\`json
$(verdict 1 ready written written)
\`\`\`"
run_case 2 'no JSON at all'                                  1 'I wrote the tests.'
run_case 2 'a criterion without a shell-level test'          1 "$(verdict 1 ready written written '| .criteria |= map(select(.id != "AC-3" or .level != "shell"))')"
run_case 2 'wrong phase value'                               1 "$(verdict 2 ready written written)"
run_case 2 'unknown status'                                  1 "$(verdict 1 ready pass written)"
run_case 2 'missing evidence'                                1 "$(verdict 1 ready written written '| .criteria[0].evidence = ""')"
run_case 2 'blocked without a question'                      1 "$(verdict 1 blocked written written)"
run_case 0 'blocked with a question'                         1 "$(verdict 1 blocked written written '| .spec_questions = ["Is the search case-sensitive?"]')"
run_case 0 'untestable criterion with its question'          1 "$(verdict 1 ready written written '| .criteria |= map(if .id == "AC-3" then .status = "untestable" else . end) | .spec_questions = ["AC-3: which message?"]')"
reports 1 absent
run_case 2 'tests that already pass before implementation'   1 "$(verdict 1 ready written written)"
reports absent absent
run_case 2 'tests never run'                                 1 "$(verdict 1 ready written written)"
reports 3 absent; rm -f "$PROJECT/e2e/TICKET-42.spec.ts"
run_case 2 'shell scenarios not written'                     1 "$(verdict 1 ready written written)"
echo 'Phase 2: verify'
reports 0 0
run_case 0 'everything passes, pass verdict'                 2 "$(verdict 2 pass pass pass)"
reports 1 0
run_case 2 'pass verdict despite a failure in the reports'   2 "$(verdict 2 pass pass pass)"
reports 0 absent
run_case 2 'pass verdict without running the shell level'    2 "$(verdict 2 pass pass pass)"
reports 1 absent
run_case 0 'failure at the MFE level, shell not run'         2 "$(verdict 2 fail pass not_run '| .criteria[2].status = "fail"')"
reports 0 0
run_case 2 'fail verdict without any failure'                2 "$(verdict 2 fail pass pass '| .criteria[2].status = "fail"')"
run_case 2 'shell not run although MFE passes'               2 "$(verdict 2 fail pass not_run '| .criteria[2].status = "fail"')"
reports 0 0 1
run_case 2 'flaky test not reported'                         2 "$(verdict 2 pass pass pass)"
run_case 0 'flaky test reported'                             2 "$(verdict 2 pass pass pass '| .flaky_tests = ["AC-3 shell"]')"
reports absent absent
run_case 2 'no test report'                                  2 "$(verdict 2 pass pass pass)"
echo 'Rejection limit and final validation'
input="$(jq -cn --arg m 'no verdict' '{last_assistant_message: $m, session_id: "loop"}')"
codes=''
for _ in 1 2 3 4; do printf '%s' "$input" | node "$CHECK" 2 >/dev/null 2>&1; codes+="$? "; done
n=$((n + 1))
if [[ "$codes" == '2 2 2 0 ' ]]; then
  echo '  ok   accepted   stopping allowed after 3 rejections'
else
  echo "  FAILED (codes $codes)  rejection limit"; failures=$((failures + 1))
fi
reports 0 0
run_case 0 'final validation of a valid verdict'             2 "$(verdict 2 pass pass pass)" --final
run_case 2 'final validation of an invalid verdict'          2 'no verdict' --final
echo
if [[ "$failures" == 0 ]]; then echo "All $n cases behave as expected."; else echo "$failures of $n cases failed"; exit 1; fi
