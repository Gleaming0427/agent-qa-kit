#!/usr/bin/env bash
# The launcher's own full suite, run after a phase 2 pass: every unit test and
# every browser scenario, smoke journeys included. The agent cannot skip it.
# Usage: qa/full-suite.sh TICKET-42   (in the project folder, or set QA_PROJECT_DIR)
# Codes: 0 pass; 1 a test fails; 3 the reports needed to judge are missing.
set -uo pipefail
fail() { echo "full-suite: $1" >&2; exit 3; }
[[ $# -eq 1 && "$1" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]] || fail 'usage: qa/full-suite.sh <TICKET>'
TICKET="$1"
KIT="$(cd "$(dirname "$0")/.." && pwd)" || fail 'Cannot locate the kit'
cd "${QA_PROJECT_DIR:-$PWD}" || fail "Cannot enter the project: ${QA_PROJECT_DIR:-$PWD}"
echo "Full suite for $TICKET: npm run test:unit, then npm run test:e2e"
rm -f reports/vitest.json reports/playwright.json
# The application's own tests never need the API credentials.
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run test:unit
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run test:e2e
node "$KIT/qa/full-suite.ts" "$TICKET"
case $? in
  0) exit 0 ;;
  1) node "$KIT/qa/summary.ts"; exit 1 ;;
  *) fail 'cannot check the full suite: npm run test:unit and npm run test:e2e must write reports/vitest.json and reports/playwright.json' ;;
esac
