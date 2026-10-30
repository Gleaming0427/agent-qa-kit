# QA agent kit

Two QA agents that prove each modified micro-frontend (MFE) meets its Jira spec, first on its own, then integrated into the shell. The first writes the tests; the second runs them without being able to modify any file. Neither can touch application code, and an automatic check rejects any verdict that is incomplete or contradicted by the test reports.

## What the kit contains

| File | Role |
|---|---|
| `.claude/agents/qa-writer.md` | Phase 1: writes the tests (Sonnet) |
| `.claude/agents/qa-verifier.md` | Phase 2: runs the tests, with no write tools at all (Haiku, low effort) |
| `.claude/hooks/qa-guard.sh` | The guard, which checks every action before it runs |
| `.claude/hooks/verdict-check.mjs` | The verdict check, which stops the agent from finishing with an invalid verdict |
| `.claude/qa-settings.json` | Security settings for pipeline mode: permissions, hooks, sandbox |
| `qa/run-qa.sh` | The launcher, called by the orchestrator |
| `qa/summary.mjs` | The condensed summary of the test results |
| `qa/check-scope.sh` | The CI check: everyone stays in their lane |
| `qa/test-guard.sh` | Demonstration of the guard (36 cases) |
| `qa/test-verdict-check.sh` | Demonstration of the verdict check (25 cases) |
| `playwright.config.ts` | Configuration of the tests inside the shell |
| `.github/workflows/qa-guard.yml` | The checks run on every PR |
| `specs/TICKET-42.md` | An example spec |

## How it works

**Phase 1, as soon as the spec is ready: `qa-writer`.** For each acceptance criterion, it writes a component test (the MFE on its own, with a fake shell) and a Playwright scenario (the MFE inside the real shell). It then checks that its tests fail: nothing is implemented yet, so a test that already passes does not test the new behavior.

**Phase 2, on each delivery from the development agent: `qa-verifier`.** It runs the tests of the modified MFE and, if they pass, the scenarios inside the shell. It returns a verdict: `pass`, `fail`, or `blocked` if the spec does not allow a conclusion. It has no write tools: it cannot "fix" a test, only report the failure.

**The verdict check, before every stop.** When an agent wants to finish, a stop hook checks its verdict:
- the JSON is complete, and every criterion has both tests, at the MFE level and at the shell level;
- in phase 1, the shell scenarios exist and the new tests do fail;
- in phase 2, the verdict matches the actual test reports: no `pass` while a failure remains, no `fail` without a failure, flaky tests reported.

If something is wrong, the agent is sent back to work with the exact list of what to fix, at most three times. This is the separate-evaluator principle, in a deterministic version: the check costs no tokens.

## Security: five locks

1. **Removed tools.** The verifier has neither Write nor Edit: the rule "never modify a test" does not depend on an instruction, it cannot be broken.
2. **Permissions** (`qa-settings.json`). The writer can only write test files, and both agents only run test commands. They do not read secrets, do not access the web and do not push to git.
3. **The guard** (`qa-guard.sh`). Before every action, it checks what the agent is about to do and refuses anything out of bounds. It also blocks disabled tests (`.skip`, `.only`, `.fixme`, `.todo`) and snapshot updates.
4. **The sandbox.** Commands run isolated at the operating-system level, with no network. If the sandbox is not available, the agent refuses to start.
5. **CI.** It checks that the QA branch contains only tests and that the development agent modified no test, then runs all the tests again on the real code, outside the agents' environment.

The spec is passed as data, never as an instruction: any text that tries to give orders to the agent is ignored and reported in `alerts`.

## Cost

| Phase | Model | Default cap |
|---|---|---|
| 1: write the tests | Sonnet, medium effort | $1.00 |
| 2: verify | Haiku 5.5, low effort | $0.20 |

- Phase 2 is mechanical: Haiku 5.5 is enough, and costs about 20 times less than Sonnet on input as long as each request stays under 100,000 tokens. Above that, the whole request is billed at the higher rate.
- The agent reads `npm run test:summary`, never the full logs. In the tested example, the raw report was about 18,000 characters and the summary about 700. This is what keeps phase 2 under the 100,000-token threshold.
- The MFE level runs before the shell: if it fails, the shell level is not run.
- Each verdict records its actual cost (`cost_usd`) in `reports/`.

The model, the effort and the maximum number of turns are set in the header of each agent: the launcher reads them from there.

## Installation

1. Copy `.claude/`, `qa/`, `playwright.config.ts` and `.github/workflows/qa-guard.yml` to the root of your repository.
2. Add these scripts to `package.json`:

   ```json
   {
     "scripts": {
       "test:affected": "vitest run --changed origin/master --reporter=dot --reporter=json --outputFile.json=reports/vitest.json",
       "test:e2e": "playwright test",
       "test:summary": "node qa/summary.mjs"
     }
   }
   ```

   The verdict check relies on `reports/vitest.json` and `reports/playwright.json`: keep these paths.
3. On Linux, install the sandbox: `sudo apt-get install bubblewrap socat`. Nothing to install on macOS.
4. Adapt to your repository:
   - the command that starts the shell, in `playwright.config.ts`;
   - the name of the main branch (`origin/master`);
   - the test locations, defined in three places to keep aligned: `qa-guard.sh`, `qa-settings.json` and `check-scope.sh`.

## Usage

**In the pipeline, called by the orchestrator:**

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services   # phase 1: write the tests
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services   # phase 2: verify a delivery
```

The exit code tells the orchestrator what to do next: `0` ready or passed, `1` failed (send back to the development agent), `2` blocked (question for a human), `3` error, budget exceeded or invalid verdict. The verdict is written to `reports/TICKET-42-phase2.json`. To see the settings without running anything: `QA_DRY_RUN=1 qa/run-qa.sh ...`.

**As a demo, inside Claude Code:**

> Use the qa-verifier agent for ticket TICKET-42, MFE services. The spec is in specs/TICKET-42.md.

In this mode, the permissions and the sandbox from `qa-settings.json` do not apply. The hooks declared in the agents (the guard and the verdict check) only run if Claude Code trusts the folder, which it asks the first time the folder is opened. Full protection goes through `run-qa.sh`.

To show the locks in action, without spending anything:

```bash
qa/test-guard.sh           # what the agent is allowed to do, and what it is refused
qa/test-verdict-check.sh   # the verdicts accepted, and those that send the agent back to work
```

## Start carefully

For two or three weeks, let the agents run without blocking anything: ignore their exit code and compare their verdicts with what humans find, in real bugs caught and false alarms. Give them a veto once these numbers are satisfactory.

## What was verified

With Claude Code 2.1.314:

- **a real phase 2 with Haiku 5.5** on a test project where one criterion failed at the MFE level: `fail` verdict on that criterion, shell level not run, about 1 cent, exit code 1;
- **a real send-back**: during a phase 2, the check rejected a first verdict, the agent corrected it, then the verdict was accepted;
- the stop hook does receive the agent's last message, and a rejection does make the agent resume;
- in pipeline mode, writing to application code and adding a `test.skip` were refused, and writing a test file was accepted;
- without an available sandbox, the agent refuses to start;
- the guard (36 cases) and the verdict check (25 cases) behave as expected;
- `qa/summary.mjs` correctly summarizes a real Playwright report;
- `qa/check-scope.sh` was validated on seven scenarios in a test git repository.

Not verified: in demo mode, in a folder that was not marked as trusted, the subagent's hooks did not fire, in line with Claude Code's rules. The behavior in a trusted folder could not be tested here.

## Known limits

- On Linux, if Chromium refuses to start inside the sandbox, run the shell-level tests in a dedicated container rather than disabling the sandbox.
- In demo mode, the agents' hooks depend on the trust granted to the folder: CI remains the last lock.
- The phase 1 check verifies that there are at least as many failing tests as criteria at the MFE level. It is an indicator, not a test-by-test proof.
- The cost estimates are orders of magnitude: measure.
- The paths, the commands and the fake shell are examples to adapt to your code.
- This kit combines proven practices (separate evaluator, verification loops, targeted tests), but there is no published turnkey recipe for micro-frontend QA agents.
