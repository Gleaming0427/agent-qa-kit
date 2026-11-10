# Agent QA Kit

**Prove that AI-written code works for the user before it is accepted.**

AI agents write code, and other AI agents review it. Nobody checks that the app still works for the person using it. This kit adds that check: a QA agent writes the tests from the ticket before the code exists, a person approves them once, and scripts, not the agent, decide whether they pass.

Version 0.3.0, experimental. Changes: [CHANGELOG.md](CHANGELOG.md).

## How it works

```text
 Ticket with acceptance criteria (AC-1, AC-2…)
        │
 1. QA writer      one unit test and one browser test per criterion
        │          → each must fail on an assertion: the feature isn't there yet
 2. Human review   approves the tests once, then they are frozen
        │
 3. Developer      builds the feature (a person or an agent)
        │
 4. QA verifier    runs the frozen tests, with no write access
        │          ↺ optional, locally: a repair agent fixes the app, never the tests
 5. Checker        compares the verdict with the real test reports,
                   then reruns the whole suite
```

Tests written after the code tend to confirm what was built, bugs included. Tests written from the ticket, and seen failing first, describe what was asked.

The person who approves the tests sees, on the test pull request:
- for each criterion, the cases the tests use, the mistake each case rules out, and what the tests leave out;
- the browser assertions that a longer number would still pass (`getByText('4 products')` also finds "14 products"), and the unit tests that already pass without the feature;
- a **QA approval** status, red until the approval gives a reason per criterion.

## Use it on your app

You need:
- a GitHub repository whose app uses Vitest and Playwright, with npm or pnpm, and Node.js 22.18 or later;
- an Anthropic API key with credit, as the repository secret `ANTHROPIC_API_KEY`: the agents call Claude with it (see [Cost](#cost)).

In the app's repository:

```bash
npx github:Gleaming0427/agent-qa-kit init
```

`init` copies the agents, their checks and five GitHub workflows, and adds the npm scripts they call if they are missing. If a file is already there and differs, it writes nothing and says which. It then lists what is still missing, such as a browser test tagged `@smoke` or a committed lockfile, and the GitHub settings to make. `npx github:Gleaming0427/agent-qa-kit doctor --run` runs the tests the way the workflows will.

A ticket is a Markdown file in `specs/`, one line per acceptance criterion (`- AC-1: …`). There is no Jira connection.

| Workflow | Runs | Calls a model |
|---|---|---|
| QA write tests | by hand, with a ticket key; the tests arrive as a pull request | yes, the writer |
| QA approval | on each review of that pull request, and each push to it | no |
| QA verify | on pull requests into the default branch (`--branch` to change it); one that names a ticket with approved tests gets its tests checked, the verifier and the full suite, the others pass | yes, the verifier |
| QA amend tests | by hand, to fix an approved test that turns out to be wrong, with a reason; the tests need a new approval | no |
| QA branch rules | on every pull request: a `qa/` branch may only change tests, and no other branch may change the tests of a ticket that has a `qa/` branch | no |

Start QA verify with the repository variable `QA_VERIFY_MODE=advisory`: it only warns, and keeps a record of what it would have blocked. `node qa/verify-record.ts` says when it can block.

The repair agent is not in a workflow: `qa/repair-loop.sh` runs it locally, at most twice, and verifies again after each repair.

Setup, commands and maintenance: [HOW_TO_APPLY.md](HOW_TO_APPLY.md).

## Try the demo

Nothing here calls a model, so no API key is needed. It needs Node.js 22.18+ (22.x or 24.x), npm, Bash and `jq`.

```bash
npm ci
npm run check          # the kit's own tests

cd examples/shop
npm ci
npx playwright install chromium
npm run test:smoke     # a fixed journey, on desktop and mobile
npm run demo:unit      # the test cycle, in Vitest
npm run demo:e2e       # the same cycle, in Playwright
```

The demo is a small React shop that can switch a bug on and off. The test cycle runs the same tests three times: they fail with the bug on, pass with it off, and fail again when it is back on. It shows the cycle, not a run of the agents.

## What has been measured

**On a corpus of 17 small tickets for the demo shop.** Each ticket has hidden tests, a reference implementation and a few planted bugs. The agents run on their own CI runner and never see them. A trial is one run of the agents on one ticket. On a feature ticket, it succeeds when the tests fail before the feature, none fails on the reference implementation, every planted bug is caught, and the agent changed only test files.

| Version | Date | Tickets | Trials successful | Planted bugs caught | Trials with a test failing on correct code | Cost per trial |
|---|---|---|---|---|---|---|
| "D clean", the release baseline | 3 Nov | 16 | 45/48 | 86/87 | 2/45 | $0.11 |
| main, before the fixes of v0.3.0 | 9 Nov | 17 | 49/51 | 93/96 | 1/48 | $0.095 |
| v0.3.0 | 9 Nov | 6 | 21/21 | 33/33 | 0/18 | $0.094 |

What the evaluation found:
- **A blind spot.** On a promo code ticket, the "D clean" writer missed a bug in 8 of 15 trials: its tests always used a cart big enough for free shipping, and the bug only shows when shipping is paid. Asking for more test cases caught it, but tests failing on correct code went from 2 to 5 trials in 48, so that change was dropped. The coverage summary was kept: on six tickets, the bug was caught 5 times out of 5, no test failed on correct code in 20 trials, for about 11% more per trial.
- **Guesses about markup that does not exist yet.** The writer looked up a search field by a role it assumed, and a total as an element whose whole text it assumed; both made correct code fail. In v0.3.0 it finds a field by its label and checks a value as part of the element's text.

These are small samples, 3 to 6 trials per ticket: signals, not proof. Results: [eval/results](eval/results). Method: [eval/README.md](eval/README.md).

**On two real tickets, end to end**: the writer's tests, a person's review, the developer's pull request, QA verify. One ticket on the demo shop, one on [omni-tools](https://github.com/iib0011/omni-tools), a React app of about 860 files ([details](eval/results/2026-11-07-real-tickets.md)).

| | Demo shop: express delivery | omni-tools: reverse the word order |
|---|---|---|
| Tests written | first try, about 1 minute | third try |
| QA verify | passed | blocked once, then passed |
| Full suite | 9 unit, 8 browser tests | 705 unit, 9 browser tests |
| Model calls | $0.17 | $1.44 |

On omni-tools, QA verify blocked the correct code once: an approved browser test looked for a checkbox the page shows four times. The test was fixed with QA amend tests, approved again, and QA verify passed. Both test pull requests were also merged before they were approved, which is why the QA approval status exists.

## Cost

| Agent | Model | Budget ceiling |
|---|---|---|
| Writer | Sonnet, medium effort | $1.00 per run |
| Verifier | Haiku, low effort | $0.20 per run; up to 3 runs with the repair loop |
| Repair | Sonnet, medium effort | $1.00 per repair, at most 2 |
| Visual review, in the demo's CI (warnings only) | Opus | about $0.17 at most |

These are ceilings passed to the CLI, not prices. Measured costs are in the tables above. An evaluation run of every ticket cost $4.84 on 9 November, a smoke run $1.60 to $1.73. QA eval estimates the cost before it starts and refuses to go above `max_cost_usd`.

On a large application, the repository variable `QA_MAX_TURNS` gives the agents more turns than their own limit (40 for the writer, 25 for the verifier). When the scripts run on a developer machine, `QA_BUDGET_USD`, `QA_MODEL`, `QA_EFFORT` and `QA_REPAIR_*` change budgets, models and effort.

## Security

The main threat is an agent that cheats to get a pass, or follows instructions hidden in what it reads:
- each agent can only write what its role needs, and only run allowlisted commands;
- those commands run in a sandbox with no network, and never see the API key;
- approved tests are hashed and frozen;
- a script reads the test reports, the agent's verdict is not trusted.

The kit does not protect against someone with write access to the repository. Details, known gaps and recommended settings are in [SECURITY.md](SECURITY.md).

## Limits

- Checks prove that named tests ran and gave the expected result. They can't prove the assertions match what the user wanted, so a person still reviews.
- QA write tests, QA verify and QA amend tests have run on two real tickets, one of them in the demo. QA approval and an amendment after a squash merge have run on a third demo ticket ([details](eval/results/2026-11-07-approval-trial.md)). The repair agent isn't measured.
- The installer has run on one large project, immich, a pnpm monorepo: install and full suite, no agent ([details](eval/results/2026-11-07-immich.md)).
- The corpus is 17 tickets of one small shop: it says how the agents do there, not on a real project. The v0.3.0 writer was measured on 6 of them.
- The visual review can miss problems or report ones that aren't there, so it only warns.
