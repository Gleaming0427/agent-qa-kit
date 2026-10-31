# Agent QA Kit

**Write tests from the ticket before implementation, then check the app in a browser.**

An AI PR review can flag suspicious code, but it cannot prove that a user journey still works. Agent QA Kit adds two Claude Code QA agents, Playwright browser tests, and checks that compare the agents' verdicts with actual test reports.

> **Experimental:** the demo and deterministic CI checks are included. The full agent workflow has not been measured on real project tickets yet.

## The approach

1. **Start with the ticket.** Before development, the QA writer turns each `AC-N` criterion in a local Markdown ticket into a unit test and a Playwright scenario. The launcher requires initial failing evidence (RED) at both levels for every criterion.
2. **Review the tests.** A human checks the assertions and explains, for each criterion, why the RED failures show missing behavior rather than a broken test or environment. Approval records hashes of the ticket, tests, and initial reports; changing them invalidates it.
3. **Implement and verify.** Your developer or development agent implements the feature. The QA verifier runs the approved tests without write tools. A separate checker compares its verdict with the JSON reports for every criterion.
4. **Check the whole app.** After a passing verdict, the launcher runs the full unit and browser suites itself. It rejects failures and flaky browser tests, rechecks the ticket criteria, and requires at least one passing `@smoke` journey. By default, verification is limited to three runs per approved baseline.

Keep a small, fixed Playwright smoke suite for critical journeys on every PR. Use ticket-specific QA for changes where a broken user flow would matter. The CI demo runs smoke checks on desktop and mobile and compares committed screenshots; it does not call an AI agent.

For example, the demo ticket says search is case-insensitive. Its browser test enters `ALPHA` and expects to see `Alpha`. A deliberate bug makes that test fail; removing the bug makes it pass; restoring it makes the same test fail again.

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

After integration, run phase 1, review the generated tests and RED report, fill in the review decision, implement the ticket, then run phase 2. If a remote `qa/<TICKET>` branch exists, the CI rules can keep its tests frozen in a PR whose title or branch names that ticket. See [HOW_TO_APPLY.md](HOW_TO_APPLY.md) for the exact commands and integration steps.

## Cost

- **Demo and CI:** no model calls or token charges from this kit. Browser tests still use local or CI compute time.
- **QA writer:** Sonnet, medium effort, up to 40 turns, with a default Claude CLI budget of **$1.00 per run**.
- **QA verifier:** Haiku, low effort, up to 25 turns, with a default budget of **$0.20 per run**. Up to three verification runs are allowed per approved baseline.

One writer run plus one verifier run has **$1.20 in configured budget ceilings**; three verifier runs bring those ceilings to **$1.60**. These are limits passed to the CLI, **not measured costs or a per-ticket price**. The development agent, any new writing cycle, and CI compute are separate. Claude's reported cost is saved under `reports/`. You can override the QA budget, model, and effort with `QA_BUDGET_USD`, `QA_MODEL`, and `QA_EFFORT`.

On failure, `qa/summary.ts` extracts short error excerpts and trace paths from the JSON reports. A repair agent can read that summary first and open a full trace only when needed; summarizing the reports takes no model call.

## Current limits

- Checks can prove that named tests ran and reported the expected result; they cannot prove the assertions capture the user's intent. Human review remains necessary.
- The review receipt detects changes but does not authenticate the reviewer. Use required PR reviews and branch protection for a team workflow.
- The demo is a small React app, not a real micro-frontend shell. The kit does not connect to Jira or launch Claude in CI.
- Agent hooks and the sandbox are guardrails, not a substitute for a disposable environment without secrets.
