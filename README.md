# Agent QA Kit

**Test what the user actually sees, not just the code diff.**

An AI code reviewer reads code. It cannot tell you whether a user can still
log in or search. This kit adds a QA step that writes tests **from the ticket,
before the code exists**, then runs them in a real browser and checks the
verdict against the test reports.

> **Experimental.** It works on the included demo. It has not been measured
> on real tickets yet.

## How it works

```text
 Ticket (AC-1, AC-2…)
        │
 1. QA writer      writes unit + Playwright tests from the ticket
        │          → both must fail (RED): the feature does not exist yet
 2. Human review   checks the tests and why they fail
        │
 3. Dev agent      implements the feature (cannot edit the tests)
        │
 4. QA verifier    runs the ticket's tests (cannot write files)
        │
 5. Checker        compares the verdict with the real test reports,
        │          then reruns every test, smoke journeys included
        │
 CI: smoke test on desktop + mobile, screenshots compared, on every PR
```

Three rules make it trustworthy:

1. **Tests come from the ticket, not the code.** Otherwise they just confirm
   the code does what it does.
2. **A RED test must fail for the right reason.** Missing feature: yes.
   Broken selector, crash, timeout or server that never starts: no. A
   browser test must fail on an `expect()` assertion.
3. **The agent's word is not proof.** A script checks every criterion
   against the JSON test reports. A missing, skipped or failing test means
   no "pass".

## Try it (no AI, no tokens)

Requirements: Node.js 22.18+, bash, `jq`.

```bash
npm ci
npm run check
```

This type-checks the scripts and tests the guards and the verdict checker.

## Run the browser demo

A small React app with a search box. The ticket (`specs/TICKET-42.md`) has
three criteria: list services, case-insensitive search, empty-state message.

```bash
cd examples/server-console
npm ci
npx playwright install chromium
npm run test:smoke     # fixed critical journey, desktop + mobile
npm run demo:unit      # RED → GREEN → REGRESSION, component level
npm run demo:e2e       # same cycle in a real browser
npm run verify:final   # full suite on the current code
```

The demo switches a deliberate bug on and off. The tests never change: they
fail with the bug, pass without it, and fail again when it comes back.

## Use it in your project

1. **Start with a smoke suite.** Two or three Playwright tests for flows that
   cost money if they break (login, checkout…). Run them on every PR, on a
   desktop and a phone screen, with a screenshot compared in CI.
2. **Add ticket QA only for risky changes.** Name each test
   `[TICKET-42][AC-1] …` and write reports to `reports/vitest.json` and
   `reports/playwright.json`.
3. **Run the two phases:**

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services   # write tests, expect RED
node qa/scenario-review.ts approve TICKET-42 specs/TICKET-42.md
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services   # verify after the dev
```

Phase 1 refuses tests that already pass or fail for the wrong reason. If the
app does not start, the result is "blocked".

Phase 2 refuses to run until a human approves the tests. Changing a test
afterwards cancels the approval, and in CI a pull request for the ticket
cannot change its QA tests. A pass counts only if the full suite passes too,
smoke journeys included. After three failed verifications, start again
from phase 1.

On failure, send the short `node qa/summary.ts` output to the repair agent
instead of the full report. It costs far fewer tokens.

Step-by-step guide: [HOW_TO_APPLY.md](HOW_TO_APPLY.md).

## Main files

| Path | Role |
|---|---|
| `.claude/agents/` | QA writer and QA verifier prompts |
| `.claude/hooks/` | Tool guard and verdict checker |
| `qa/run-qa.sh` | Runs a QA phase |
| `qa/scenario-review.ts` | Human approval of the generated tests |
| `qa/full-suite.ts` | Final check: every test passes, smoke included |
| `qa/summary.ts` | Short test summary for agents |
| `examples/server-console/` | React + Playwright demo |

All scripts are TypeScript, run directly by Node (no build step).

## Limits

- Hooks are a safety net, not real isolation. The final full suite runs
  outside the agent. Run the kit in a disposable environment with no secrets.
- The checks prove tests ran, not that they are good. A human still reviews
  the assertions.
- The reviewer name is not authenticated. In a team, use branch protection
  and required PR reviews.
- The demo is a fake shell, not a real micro-frontend setup. It does not
  connect to Jira or run a Claude agent in CI.
