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
5. **Repairs are automatic, bounded, and cannot cheat.** When the verification fails, `qa/repair-loop.sh` sends a short failure summary, not the full reports, to a repair agent. That agent may change the application, but not the tests, their configuration, the dependencies, the installed packages in `node_modules/` or the git files. After each repair, the approved tests are checked against their hashes and the installed packages against a snapshot taken before the loop, and the loop stops after three verifications.
6. **The whole app is checked, not only the ticket.** After a pass, the launcher reruns every unit and browser test itself, including fixed `@smoke` journeys on desktop and mobile. A regression elsewhere, or a flaky browser test, fails the ticket.

The demo makes this concrete. Its ticket says the cart subtotal is the sum of price × quantity: the browser test adds two notebooks and a pen set and expects `€15.00`. With a deliberate bug the test fails, without it the test passes, and when the bug comes back the same, unchanged test fails again.

## When to use it

- **On every pull request:** a small, fixed Playwright smoke suite for the journeys that cost money when they break (login, search, checkout), on desktop and mobile, with screenshots compared in CI. It calls no AI.
- **Optionally, on the same screenshots:** an AI visual review. A pixel comparison says a page *changed*, not that it is *broken*, and a new page has no baseline yet. With an `ANTHROPIC_API_KEY` secret, `qa/visual-review.ts` asks a vision model to look for text that overflows, overlapping elements, empty sections and controls off screen. Its findings appear as warnings on the pull request and never block it: a person confirms them.
- **On risky tickets:** the full workflow above, for changes where a broken user flow would matter, on a developer machine or in CI. A low-risk change only needs the smoke suite and a normal review.

## Try the demo

Requires Node.js 22.18+ on the 22.x line or Node.js 24.x, npm, Bash, and `jq`. The browser demo also installs Chromium. These commands make **no AI calls**.

```bash
npm ci
npm run check

cd examples/shop
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

After integration, run phase 1, review the generated tests and RED report, fill in the review decision, and implement the ticket. Then run `qa/repair-loop.sh TICKET-42 specs/TICKET-42.md shop`: it verifies the ticket and, while it fails, lets the repair agent fix the application. To verify once without repairs, run phase 2 directly. If a remote `qa/<TICKET>` branch exists, the CI rules can keep its tests frozen in a PR whose title or branch names that ticket. See [HOW_TO_APPLY.md](HOW_TO_APPLY.md) for the exact commands and integration steps.

## Run the agents in CI

Two GitHub workflows run the same steps without a developer machine:

1. **QA write tests**, started by hand from the Actions tab with a ticket key. The QA writer agent turns `specs/<ticket>.md` into tests, the kit checks that each one fails for the right reason, and the workflow opens a pull request from `qa/<ticket>` into `feat/<ticket>`. It lists every criterion with its failing tests. **Approving that pull request is the human review**: the approval gives one line per criterion, such as `AC-1: the button does not exist yet`. Merge it, then develop on `feat/<ticket>`.
2. **QA verify**, on every pull request into `main`. When the branch or the title names a ticket with QA tests, it checks that a collaborator approved the latest version of those tests and that they have not changed since. It then runs the QA verifier agent and the full suite. Make it a required check, and a failure blocks the merge. A pull request without such a ticket passes at once and calls no model.

The agent's commands run in a sandbox without network access, and never see the API key. The full suite, which runs the pull request's code, has a step of its own without the key. To set it up, add an `ANTHROPIC_API_KEY` secret, allow Actions to create pull requests, and require the **QA verify** check: see [HOW_TO_APPLY.md](HOW_TO_APPLY.md#5-run-the-agents-in-ci). To try it on the demo, run **QA write tests** with `TICKET-44`, a promo code field that does not exist yet.

## Measure the agents

`eval/` measures the agents on a fixed corpus of sixteen shop tickets, each with a reference implementation, injected bugs and hidden tests. It runs several trials per ticket and reports each metric with a 95% confidence interval:

- how often the written tests fail for the right reason, and how often they fail on a correct implementation;
- how many injected bugs they catch;
- whether the agents stayed within their rules, including on an ambiguous ticket and on a ticket that hides an instruction;
- the verifier's accuracy, pass^k, cost and duration.

The agent of a trial never shares a runner with the corpus: it gets a bundle with the kit, the shop and the ticket's spec only, and its tests are scored on another runner, in a sandbox without network or secrets. Every campaign is kept in a versioned history (`eval/history`) that says which campaigns can be compared, and on which tickets. `node eval/compare.ts` compares two versions ticket by ticket and bug by bug, with paired tests across tickets, and gives a decision (accepted, review or rejected) under the rules of `eval/compare-policy.json`. `tickets: smoke` runs a few tickets chosen from the history (the critical ones, those that regressed or were unstable, and a rotation) instead of all 16. Each run ends with a release decision against the release baseline, under the rules in force at the run's commit: a rejected version fails the job, one to review asks for a human review. `trials: adaptive` gives each ticket its trials from its history: more for critical and unstable tickets, fewer for stable ones.

Run **QA eval** from the Actions tab, or check the corpus locally with `node eval/validate-corpus.ts`. See [eval/README.md](eval/README.md) for the method, the definitions and the limits.

## Cost

- **Demo and CI checks:** no model calls or token charges from this kit, except the optional visual review and the two agent workflows. Browser tests still use local or CI compute time.
- **Visual review (optional):** one Claude Opus 5.5 call per CI run with the two smoke screenshots, about 2,000 input tokens. Its output is capped at 8,000 tokens, so a run costs at most about $0.17, and a few cents is the expected range (an estimate, not a measurement). Change the model with `QA_VISUAL_MODEL`.
- **QA writer:** Sonnet, medium effort, up to 40 turns, with a default Claude CLI budget of **$1.00 per run**.
- **QA verifier:** Haiku, low effort, up to 25 turns, with a default budget of **$0.20 per run**. Up to three verification runs are allowed per approved baseline.
- **Repair agent:** Sonnet, medium effort, up to 40 turns, with a default budget of **$1.00 per repair**. The loop makes at most two repairs.

In CI, a ticket costs one writer run, then one verifier run per push to the developer's pull request; a newer push cancels the run in progress.

One writer run plus one verifier run has **$1.20 in configured budget ceilings**; with the repair loop at its limit (three verifications, two repairs), the ceilings reach **$3.60**. These are limits passed to the CLI, **not measured costs or a per-ticket price**. The development agent, any new writing cycle, and CI compute are separate. Claude's reported cost is saved under `reports/`. You can override the budgets, models and effort with `QA_BUDGET_USD`, `QA_MODEL`, `QA_EFFORT`, `QA_REPAIR_BUDGET_USD`, `QA_REPAIR_MODEL` and `QA_REPAIR_EFFORT`.

On failure, `qa/summary.ts` extracts short error excerpts and trace paths from the JSON reports, and the repair agent receives only that summary. In the demo, a failing ticket is described in about 500 characters instead of the full reports; summarizing them takes no model call.

## Maintenance

- **Smoke tests:** a few stable journeys. Update them only when a critical flow changes.
- **Screenshots:** the baselines are made in CI. After an intended visual change, delete them and commit the new ones from the `screenshot-baselines` artifact.
- **Ticket tests:** frozen while the ticket is developed. Delete the `qa/<TICKET>` branch once it is merged: they become ordinary tests. The review package in `qa-reviews/<TICKET>/` stays as a record of what was approved, and by whom.
- **Dependencies:** keep Playwright, Vitest and Vite up to date and check `npm audit`.

## Security

The kit defends against one threat above all: **an AI agent that cheats to obtain a pass**, by editing the approved tests, faking the results or patching the test tools, or that is **manipulated by text it reads** in the ticket, the code or the test output. It does not defend against a person who has write access to the repository.

| Layer | What it does |
|---|---|
| Guard hook and permissions | Each agent writes only what its role needs: tests for the writer, nothing for the verifier, the application for the repair agent, which may not touch the tests, their configuration, the kit, `node_modules/` or `.git/`. Commands come from a short allowlist, without chaining, redirection or network tools. Secret files, paths outside the project and symbolic links are refused. |
| Operating-system sandbox | The commands an agent runs have no network access (bubblewrap on Linux, Seatbelt on macOS). If the sandbox cannot start, Claude Code stops instead of running without it. |
| No credentials for agent commands | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key from the commands an agent starts. On Linux, they cannot read other processes' environments either. |
| Deterministic checks | A script compares the agent's verdict with the test reports. Hashes protect the ticket, the approved tests and the first reports, and the tests stay frozen on every pull request. During repairs, `node_modules/` and the git files are compared with a snapshot after every step. The launcher runs the full suite itself. |
| CI | The API key exists only in the agent's step. The full suite, which runs the pull request's code, has a step of its own without it. The agent workflows keep no GitHub token on disk and have minimal permissions, and their inputs reach the scripts through environment variables, so they cannot inject commands. Pull requests from forks receive no secrets. Only a collaborator's approval of the latest version of the tests counts. |
| Dependencies | Exact versions, committed lockfiles, and releases at least two weeks old when they were chosen. In November 2026, `npm audit` reported no known vulnerability in either package. |

Each rule has regression tests, which `npm run check` runs in CI.

**Known gaps**, to fix before a team relies on the kit:

- The CI approval check trusts GitHub's author association: owner, member or collaborator. A collaborator with read-only access would therefore count, whereas GitHub's required reviews only count people with write access.
- The GitHub Actions are referenced by tag (`@v5`), not by commit SHA. A hijacked tag would run with the job's permissions and secrets.

**Limits that no tool removes:**

- Code under test can lie about its own results, or detect that it is being tested. A person must still review the diff.
- A pull request opened from a branch of this repository can change the workflows that judge it, and the code it runs in a job can read that job's secrets. Protect `.github/`, `qa/` and `.claude/` with a `CODEOWNERS` file and the ruleset option "Require review from Code Owners", and use a dedicated API key with a low spending limit.
- The local approval receipt detects changes but does not prove who approved. In CI, the approval is a GitHub review.
- Hooks and the sandbox are guardrails, not a disposable environment: the commands in the sandbox can still read most of the disk. When you can, run the agents in a container or in CI, without personal credentials.
- Traces and screenshots uploaded as CI artifacts can contain session data: use test accounts, never real credentials, in browser tests.
- The visual review sends screenshots to the Anthropic API: keep it off for pages that show sensitive data.

**Recommended repository settings:** require the checks on `main` (without them, nothing blocks a merge), and turn on secret scanning with push protection and Dependabot alerts.

## Current limits

- Checks can prove that named tests ran and reported the expected result; they cannot prove the assertions capture the user's intent. Human review remains necessary.
- The demo is a small React app, not a real micro-frontend shell. The kit does not connect to Jira.
- The CI workflows have not run against the real API yet: their deterministic parts are tested, the agents' behavior in CI is not.
- The visual review can miss a problem or report one that is not there, which is why it only warns.
- For the security limits, see [Security](#security).
