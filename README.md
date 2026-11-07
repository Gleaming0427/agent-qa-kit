# Agent QA Kit

**Prove that AI-written code works for the user before it is accepted.**

AI agents write code, and other AI agents review it. Nobody checks that the app still works for the person using it. This kit adds that check. A QA agent writes the tests from the ticket before the code exists, a person approves them once, and scripts decide whether they pass, not the agent.

Version 0.2.0, experimental. Changes: [CHANGELOG.md](CHANGELOG.md).

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
        │          ↺ on failure, a repair agent fixes the app, never the tests
 5. Checker        compares the verdict with the real test reports,
                   then reruns the whole suite
```

Tests written after the code tend to confirm what was built, bugs included. Tests written from the ticket, and seen failing first, describe what was asked.

The reviewer gets more than the test code. For each criterion, the writer lists the cases its tests use, the mistake each case rules out, and what the tests leave out. Reading code shows what is wrong in a test, not what is missing.

## Results so far

I measure the agents on 17 small tickets for a demo shop. Each ticket has hidden tests and a few planted bugs. The agent runs on its own CI runner and never sees them. Details and stats are in [eval/results](eval/results).

- **Baseline:** 45 of 48 trials pass, and 86 of 87 planted bugs are caught. 2 trials of 45 had a test that fails on a correct implementation. About $0.11 per trial.
- **A blind spot it found:** on a promo code ticket, the agent missed a bug in 8 of 15 trials. The tests looked fine. They just always used a cart big enough for free shipping, and the bug only shows when you pay shipping. I would have approved those tests.
- **A fix I dropped:** asking for more test cases caught that bug, but false positives went from 2 to 5 in 48 trials. Most were totals the agent got wrong when working them out by hand.
- **A fix I kept:** the agent now lists what its tests don't cover, and a hook recomputes every amount it writes. On six tickets that gave:
  - 22 of 23 trials passed;
  - the promo bug was caught 5 times out of 5;
  - no false positive in 20 trials;
  - about 11% more per trial.

  The one miss was listed in its own "not covered" section, so a reviewer would have seen it.

These are small samples, 3 to 5 trials per ticket. Treat them as signals, not proof.

### Two real tickets, end to end

The whole workflow, as a team would run it: the writer's tests, a person's review, the developer's pull request, QA verify. One ticket on the demo shop, one on [omni-tools](https://github.com/iib0011/omni-tools), a real React app of about 860 files. Details: [eval/results/2026-11-07-real-tickets.md](eval/results/2026-11-07-real-tickets.md).

| | Demo shop: express delivery | omni-tools: reverse the word order |
|---|---|---|
| Tests written | first try, about 1 minute | third try |
| QA verify | passed | blocked once, then passed |
| Full suite | 9 unit, 8 browser tests | 705 unit, 9 browser tests |
| Model calls | $0.17 | $1.44 |

What went wrong on omni-tools, and what it changed:
- The writer ran out of turns on a codebase much bigger than the demo. `QA_MAX_TURNS` now raises the limit.
- On the next run it couldn't render the component in a unit test. Instead of passing off broken evidence, it stopped and asked how to test it. The answer went into the ticket.
- QA verify blocked the correct code. The approved browser tests looked for a checkbox the page shows four times. Nobody caught it in review, because the option didn't exist yet. The tests were fixed through QA amend tests, approved again, and QA verify passed.

It also showed that the human step is easy to get wrong. One test pull request was merged before it was approved, another approved without the reasons QA verify needs. A squash merge then blocked the amendment. Those are the next things to fix.

## Try the demo

Needs Node.js 22.18+ (22.x or 24.x), npm, Bash and `jq`. No AI calls.

```bash
npm ci
npm run check

cd examples/shop
npm ci
npx playwright install chromium
npm run test:smoke    # fixed desktop and mobile journey
npm run demo:unit     # RED -> GREEN -> REGRESSION in Vitest
npm run demo:e2e      # the same cycle in Playwright
```

The demo is a small React shop that can switch a bug on and off. It shows the test cycle, not a run of the agents.

## Use it on your app

In your app's repository (Node.js 22.18+, Vitest and Playwright, npm or pnpm):

```bash
npx github:Gleaming0427/agent-qa-kit init
```

It copies the agents, their checks and four GitHub workflows, and adds the npm scripts they call if they are missing. If a file is already there and differs, it writes nothing and says which. Then it lists what is still missing, for instance a browser test tagged `@smoke` or a committed lockfile, and the GitHub settings to make. `doctor --run` runs your tests the way the workflows will.

Tickets are Markdown files in `specs/`, with no Jira connection. Four GitHub workflows do the work:

- **QA write tests:** started by hand with a ticket key. The writer's tests arrive as a pull request, and approving it is the human review.
- **QA verify:** runs on pull requests into `main`. When one names a ticket with QA tests, it checks they are the approved ones, then runs the verifier and the full suite. Otherwise it passes without calling a model.
  - Start it with `QA_VERIFY_MODE=advisory` to only warn. It keeps a record of what it would have blocked, and `node qa/verify-record.ts` tells you when it has earned the right to block.
- **QA amend tests:** for an approved test that turns out to be wrong. You fix it, give a reason, and it gets logged and approved again.
- **QA eval:** measures the agents on the corpus (`eval/`). You don't need it to use the kit.

Setup, commands and maintenance: [HOW_TO_APPLY.md](HOW_TO_APPLY.md). The evaluation method: [eval/README.md](eval/README.md).

## Cost

| Agent | Model | Budget ceiling per run |
|---|---|---|
| Writer | Sonnet, medium effort | $1.00 |
| Verifier | Haiku, low effort | $0.20, up to 3 runs per approved baseline |
| Repair | Sonnet, medium effort | $1.00, at most 2 repairs |
| Visual review (optional, warnings only) | Opus | about $0.17 at most |

Those are ceilings passed to the CLI, not prices. In practice a writer and verifier trial costs $0.10 to $0.14 on the corpus. An evaluation smoke run costs $2 to $3, and a full run about $6. QA eval estimates the cost before it starts and refuses to go above `max_cost_usd`. Budgets, models and effort can be changed with `QA_BUDGET_USD`, `QA_MODEL`, `QA_EFFORT` and the `QA_REPAIR_*` variables. On a large application, the repository variable `QA_MAX_TURNS` gives the agents more turns than their own limit (40 for the writer, 25 for the verifier).

## Security

The main threat is an agent that cheats to get a pass, or follows instructions hidden in what it reads:
- each agent can only write what its role needs, and only run allowlisted commands;
- those commands run in a sandbox with no network, and never see the API key;
- approved tests are hashed and frozen;
- a script reads the test reports, the agent's verdict is not trusted.

The kit does not protect against someone with write access to the repository. Details, known gaps and recommended settings are in [SECURITY.md](SECURITY.md).

## Limits

- Checks prove that named tests ran and gave the expected result. They can't prove the assertions match what the user wanted, so a person still reviews.
- The four product workflows have each run on a real ticket, but only on two tickets, one of them in the demo. The repair agent isn't measured.
- The installer has run on one large project, immich, a pnpm monorepo: install and full suite, no agent ([eval/results/2026-11-07-immich.md](eval/results/2026-11-07-immich.md)).
- The evaluation corpus is 17 tickets of one small shop: it says how the agents do there, not on a real project.
- The visual review can miss problems or report ones that aren't there, so it only warns.
