# Agent QA Kit

**Prove that AI-written code works for the user before it is accepted.**

AI agents now write code, and other AI agents review it. That pipeline has a blind spot: nothing proves that the application still works for the person using it. Agent QA Kit adds an independent QA step that produces this proof, with Claude Code agents, Playwright browser tests and deterministic checks.

> **Experimental:** the demo and the deterministic CI checks are included and tested. The full agent workflow has not been measured on real project tickets yet.

## Why a code review is not enough

| What usually happens | Why it is not proof |
|---|---|
| The coding agent says "done" | It grades its own work. |
| An AI reviews the pull request | It reads the code, not the screen: a button that disappears on mobile looks fine in a diff. |
| An AI writes tests after the code | The tests follow the implementation, so they confirm a bug as built. |

What is missing is evidence from an independent source: tests derived from what the ticket asks for, run in a real browser, and checked by a script rather than by the agent that wrote the code.

## How the kit closes the gap

```text
 Ticket with acceptance criteria (AC-1, AC-2…)
        │
 1. QA writer      turns each criterion into a unit test and a browser test
        │          → both must fail: the feature does not exist yet
 2. Human review   approves the tests and why they fail; they are then frozen
        │
 3. Developer      implements the feature (a person or an agent)
        │
 4. QA verifier    runs the approved tests, with no write access
        │          ↺ on failure, a repair agent fixes the app, never the
        │            tests, and the verification runs again (3 runs max)
 5. Checker        compares the verdict with the real test reports,
                   then reruns every test, critical journeys included
```

Each step answers a specific risk:

1. **Tests are written from the ticket, before the code.** They describe what was asked, not what was built, so they can catch a feature that works as coded but not as intended.
2. **Every new test must fail first, for the right reason.** A test that already passes before the feature exists proves nothing. For browser tests, only a failed `expect()` counts: a crash, a timeout or a server that never started is refused, and an app that cannot start makes the run "blocked".
3. **A person approves the tests once.** An AI can misread an ambiguous ticket. Checking its interpretation before development is cheap; finding out afterwards is not. The approval stores hashes of the ticket, the tests and the first reports: changing any of them cancels it.
4. **The verifier cannot edit anything, and its word is not trusted.** A script checks every criterion against the JSON test reports. A missing, skipped or failing test means no "pass".
5. **Repairs are automatic, bounded, and cannot cheat.** When the verification fails, `qa/repair-loop.sh` sends a short failure summary, not the full reports, to a repair agent. That agent may change the application but not the tests, their configuration or the dependencies. After each repair, the approved tests are checked against their hashes, and the loop stops after three verifications.
6. **The whole app is checked, not only the ticket.** After a pass, the launcher reruns every unit and browser test itself, including fixed `@smoke` journeys on desktop and mobile. A regression elsewhere, or a flaky browser test, fails the ticket.

The demo makes this concrete. Its ticket says search is case-insensitive: the browser test types `ALPHA` and expects to see `Alpha`. With a deliberate bug the test fails, without it the test passes, and when the bug comes back the same, unchanged test fails again.

## When to use it

- **On every pull request:** a small, fixed Playwright smoke suite for the journeys that cost money when they break (login, search, checkout), on desktop and mobile, with screenshots compared in CI. It calls no AI.
- **On risky tickets:** the full workflow above, for changes where a broken user flow would matter. A low-risk change only needs the smoke suite and a normal review.

## Try the demo

Requires Node.js 22.18+ on the 22.x line or Node.js 24.x, npm, Bash, and `jq`. The browser demo also installs Chromium. These commands make **no AI calls**.

```bash
npm ci
npm run check

cd examples/server-console
npm ci
npx playwright install chromium
npm run test:smoke    # fixed desktop and mobile journey
npm run demo:unit     # RED -> GREEN -> REGRESSION in Vitest
npm run demo:e2e      # the same cycle in Playwright
npm run verify:final  # build, unit tests, browser tests
```

The demo is a standalone React and TypeScript app that toggles a bug. It shows the test behavior, **not** a run of the Claude agents or the complete ticket workflow. Local screenshot comparison is disabled; CI compares the committed Linux baselines.

## Use it with your app

The root package checks the kit itself. To run `qa/run-qa.sh` on a real ticket, integrate it with an app that provides `test:affected`, `test:unit`, `test:e2e`, and `test:summary`, plus the expected Vitest and Playwright JSON reports. The ticket is a Markdown file; there is no built-in Jira connection. The launcher also needs the Claude Code CLI.

After integration, run phase 1, review the generated tests and RED report, fill in the review decision, and implement the ticket. Then run `qa/repair-loop.sh TICKET-42 specs/TICKET-42.md services`: it verifies the ticket and, while it fails, lets the repair agent fix the application. To verify once without repairs, run phase 2 directly. If a remote `qa/<TICKET>` branch exists, the CI rules can keep its tests frozen in a PR whose title or branch names that ticket. See [HOW_TO_APPLY.md](HOW_TO_APPLY.md) for the exact commands and integration steps.

## Cost

- **Demo and CI:** no model calls or token charges from this kit. Browser tests still use local or CI compute time.
- **QA writer:** Sonnet, medium effort, up to 40 turns, with a default Claude CLI budget of **$1.00 per run**.
- **QA verifier:** Haiku, low effort, up to 25 turns, with a default budget of **$0.20 per run**. Up to three verification runs are allowed per approved baseline.
- **Repair agent:** Sonnet, medium effort, up to 40 turns, with a default budget of **$1.00 per repair**. The loop makes at most two repairs.

One writer run plus one verifier run has **$1.20 in configured budget ceilings**; with the repair loop at its limit (three verifications, two repairs), the ceilings reach **$3.60**. These are limits passed to the CLI, **not measured costs or a per-ticket price**. The development agent, any new writing cycle, and CI compute are separate. Claude's reported cost is saved under `reports/`. You can override the budgets, models and effort with `QA_BUDGET_USD`, `QA_MODEL`, `QA_EFFORT`, `QA_REPAIR_BUDGET_USD`, `QA_REPAIR_MODEL` and `QA_REPAIR_EFFORT`.

On failure, `qa/summary.ts` extracts short error excerpts and trace paths from the JSON reports, and the repair agent receives only that summary. In the demo, a failing ticket is described in about 500 characters instead of the full reports; summarizing them takes no model call.

## Maintenance

- **Smoke tests:** a few stable journeys. Update them only when a critical flow changes.
- **Screenshots:** the baselines are made in CI. After an intended visual change, delete them and commit the new ones from the `screenshot-baselines` artifact.
- **Ticket tests:** frozen while the ticket is developed. Delete the `qa/<TICKET>` branch once it is merged: they become ordinary tests.
- **Dependencies:** keep Playwright, Vitest and Vite up to date and check `npm audit`.

## Current limits

- Checks can prove that named tests ran and reported the expected result; they cannot prove the assertions capture the user's intent. Human review remains necessary.
- The review receipt detects changes but does not authenticate the reviewer. Use required PR reviews and branch protection for a team workflow.
- The demo is a small React app, not a real micro-frontend shell. The kit does not connect to Jira or launch Claude in CI.
- Agent hooks and the sandbox are guardrails, not a substitute for a disposable environment without secrets.
