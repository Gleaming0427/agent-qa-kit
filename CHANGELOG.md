# Changelog

## Unreleased

### Evaluation

- **An evaluation before a change of the agents is merged.** The "QA eval required" workflow (`eval/required.ts`) reads, with git, what the agents see or can do: the writer's and the verifier's prompt, model, effort and tools, their settings, the hooks, the launcher (`qa/run-qa.sh`, `qa/kit-integrity.sh`, `qa/criteria-manifest.ts`) and the Claude Code version. A pull request that changes one of them fails until the history holds a campaign of the same agents, and then applies that campaign's release decision; the label `qa-eval-waived` lets a change that needs none through, with a warning. No model call. It runs the base branch's copy of `eval/`.
- **Cost per success.** The campaign report gives the cost of all the trials over the number that succeeded, for the campaign and for each ticket, and the comparison of two versions shows it for each side: a version that succeeds less often at the same cost per trial costs more per success.

### Security: what an agent's session reads

A Claude Code session starts what the project tells it to, outside the sandbox: the hooks of `.claude/settings.json` and the servers of `.mcp.json` run as commands, and `CLAUDE.md` goes to the model as instructions. A pull request can change all of them, and a session in a project with a planted hook and MCP server ran both (with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, they no longer saw the API key, but still ran). `qa/run-qa.sh` and `qa/repair-loop.sh` now start the agents with:

- `--setting-sources ""`: no settings, hooks or `CLAUDE.md` from the project or the user; the kit's settings file (`--settings`) is still read, hooks included (checked);
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: no auto memory. `--setting-sources ""` leaves it on, and a `MEMORY.md` planted in the project's folder of `~/.claude/projects` reached the writer's context: on a developer's machine, what the developer's own sessions on the project remembered. The setting also takes about 2,800 characters out of the agents' fixed context;
- `--strict-mcp-config` and `--disable-slash-commands`: no MCP server, no skill, no command;
- `--tools` from the `tools:` line of the agent's file (`qa/kit-integrity.sh`, `kit_session_args`): 6 tools for the writer and the repair agent and 3 for the verifier, instead of 24, with no sub-agents and no web tools.

`QA_SETTING_SOURCES=user` also reads `~/.claude`, for a machine where the login or provider is set in the user's settings; any other value stops the run before the agent starts. Measured with Claude Code 2.1.303 against a stand-in for the API that recorded what was sent (nothing was billed): the default session sent the project's and the user's `CLAUDE.md` and ran both hooks; with the options, none of it. Run since in QA eval, with the real model, against a reference of the agents before the change: `eval/results/2026-11-12-session-surface.md`.

### The verifier: one test command, three tools

Counted in the transcripts of 60 verifier sessions (QA eval runs 49 and 50): it never used Glob, and it ran three commands per session, two of them with the raw output of Vitest or Playwright in its context, where the writer runs one. Neither the writer nor the verifier ran `git diff`, `git status` or `git log` in 96 sessions.

- The verifier runs `npm run test:summary -- --run @<mfe> --stop-on-unit-failure` once: the unit tests, then the browser tests only if no unit test failed, and the summary of both. The new option of `qa/summary.ts` removes the earlier browser report when it skips the browser tests, so that `not_run` is checked as before: only after a unit failure, and without a browser report. The writer's cycle is unchanged: its unit tests fail by design and its browser tests must run too.
- Its tools are Read, Grep and Bash: Glob is gone, and Grep lists files.
- `.claude/qa-settings.json` no longer allows `git diff`, `git status` or `git log` to the writer and the verifier. The repair agent keeps them in its own settings.

## v0.3.1, 11 November 2026

Since v0.3.0 the kit's own scripts are out of reach of the code they judge, and the kit has run for the first time on a GitHub-hosted runner with a ticket (QA write tests, then QA verify, on a demo ticket), which found two defects that the kit's stand-ins could not show. A review of the kit's security found five gaps; all five are closed, each with regression tests. The agents' prompts and settings files are unchanged; the sandbox now also keeps the kit's folders read-only when an agent starts, and the repair agent's guard denies more. The campaigns of v0.3.0 were not run again: they still describe the writer and the verifier, whose prompts did not change. Run `npx github:Gleaming0427/agent-qa-kit init` again to upgrade.

### Security: the five gaps of a review

- **The scripts that judge are out of reach of the code they judge.** The agents' sandbox keeps `qa/`, `.claude/` and `.github/` read-only (`denyWrite`, as absolute paths); `qa/run-qa.sh` and `qa/repair-loop.sh` compare the kit's files before and after each agent and stop on a change, before any script of the kit runs again (`qa/kit-integrity.sh`); and the workflows run the kit from `/opt/qa-kit`, a copy owned by root and read-only, made before any code of the application runs (`qa/ci-trusted-kit.sh`, which uses `sudo`, as GitHub's runners allow). The copy comes from the pull request's base branch (the default branch for the QA approval status): a pull request is no longer judged by its own scripts. A pull request that installs or upgrades the kit has no such copy to use: it uses its own scripts and warns.
- **Changes to how the tests run are reported.** QA verify says, in a warning and in the job summary, when a pull request changes the test scripts of a `package.json`, the Vitest, Vite or Playwright configuration, a setup file, a mock, a fixture or a helper, or the kit's own files. `QA_VERIFY_TOOLING=block` makes the check fail instead.
- **Approval counts only from someone who can write.** `qa/ci-permissions.sh` reads each reviewer's permission; an approval counts only with write access or more, and a request for changes blocks only from someone whose approval would count. If the token cannot read a permission, the check warns and falls back to GitHub's author association, as before.
- **The tests of a ticket stay frozen on any pull request.** `qa/check-test-blocks.ts` reads the test files test by test: a test tagged `[TICKET-N][AC-N]` cannot be changed, removed or moved by a pull request that does not name the ticket, even when its `qa/` branch was deleted. A QA branch may add tests and rewrite its own ticket's, not another ticket's test, a test with no ticket, or a hook that was there; this is checked before the push in QA write tests and QA amend tests, and again on the pull request.
- **The repair agent keeps out of the test setup.** It may not edit setup files, mocks, fixtures or test helpers, found by name (`setupTests.ts`, `auth.setup.ts`, `__mocks__/`, `test-utils.ts`, `tests/` and the like). The repair loop also compares `package.json`, the test configuration, the setup files it names and what they import with a snapshot taken before any agent ran, so a change made by code that the tests run is caught too.

### Found by the first real runs

- **The kit's integrity check stopped every run that used Claude Code.** On the first real run of QA write tests, the writer finished (verdict `ready`, 10 turns, $0.14), and `qa/run-qa.sh` then stopped with "the kit's own files changed while the agent ran" for empty folders that Claude Code had created in the project. The manifest now lists files, not folders; a file created inside a new folder is still reported.
- **An approval without text no longer cancels the reasons given before it.** The kit kept only each reviewer's latest review, so a second click on Approve with an empty comment replaced the lines `AC-1: …` written for the same commit: the "QA approval" status went red and QA verify would have refused the approval. Now the earlier lines stand; a request for changes, a dismissal or an approval of an older commit still takes them away.
- **The publish step of QA write tests is tested.** It had no test; it now runs on a real git history with a bare origin and a stand-in for the GitHub CLI.

### The demo and the guide

- **The demo no longer compares screenshots with committed images.** A pixel comparison needs the same pixels on every machine, and fonts differ between Mac, Windows and Linux: the baselines had to be made again, by a workflow run, whenever the page changed. The kit never installed this part. The smoke test keeps its other checks and its screenshots for the advisory AI visual review.
- **What ran on a real runner, and what did not.** QA write tests (the writer for $0.14, the checks before the push, the pull request), the QA approval status, and QA verify (the approval read from three reviews, the tests compared with the approved commit, the verifier for $0.005, the full suite of 9 unit and 8 browser tests) ran on a ticket of the demo shop, with the real API, QA write tests and QA verify from the copy in `/opt/qa-kit`. No warning about a collaborator's permission appeared, so the token read it. Not run yet on a runner: the sandbox's write rules through Claude Code, an application at the root of its repository, QA amend tests from the copy, the repair loop, an approval from someone with read access only. `SECURITY.md` and `HOW_TO_APPLY.md` say so, and also that the checks on a QA pull request are red by design, that the install steps need the runner's network, and that the warning about empty `.env`-like files comes from Claude Code's sandbox.
- **An MIT license.** The kit had none, so nobody could reuse it. `LICENSE` now holds the MIT license, and `package.json` says so.

## v0.3.0, 9 November 2026

Since v0.2.0 the kit installs into an application's repository with one command. It was tried outside its demo: an install on immich, a pnpm workspace of 12 projects, and two real tickets end to end, one on the demo shop and one on omni-tools, a React app of about 860 files. The test pull request now tells its reviewer what the tests cover, which of their assertions or tests could pass on a wrong implementation, and what the approval is missing. The release baseline is still "D clean" (`eval/release-baseline.json`).

### Installing the kit

- **An installer.** `npx github:Gleaming0427/agent-qa-kit init` installs the kit in an application's repository; `doctor` checks what the workflows need, and `doctor --run` also runs the tests. When a file it would replace differs, it writes nothing and lists it. Running `init` again upgrades the files nobody changed.
- **npm and pnpm applications**, in a workspace too, installed from their lockfile.
- **A `qa:setup` script** runs after the install, for a step the tests need first, such as building a package of the workspace ([immich trial](eval/results/2026-11-07-immich.md)).
- **The application's Node.js**, from its `.nvmrc` or `.node-version`; 22.18 or later.
- **`QA_MAX_TURNS`**, a repository variable that gives the agents more turns on a large application.
- An application at the root of its repository now works with QA amend tests.

### QA workflow

- **A coverage summary.** For each criterion, the test pull request gives the cases the tests use, the mistake each one rules out, and what they leave out. A hook sends back a summary whose arithmetic does not add up ([details](eval/results/2026-11-05-coverage-summary.md)).
- **Assertions that a longer number would still pass**, such as `getByText('4 products')`, which also finds "14 products", are listed on the test pull request with what to use instead.
- **Unit tests that already pass without the feature** are listed on the test pull request with their criterion.
- **A QA approval status** on the test pull request stays red until a collaborator approves its latest commit with a reason per criterion, and says what is missing ([trial](eval/results/2026-11-07-approval-trial.md)).
- **QA amend tests**, a new workflow, fixes an approved test that turns out to be wrong. A person changes it on `qa/<TICKET>` and gives a reason; the tests must still fail without the feature, and they are approved again. After a squash-merged test pull request, it records the copy when it holds only the tests, and warns otherwise.
- **An advisory mode for QA verify** (`QA_VERIFY_MODE=advisory`): failures are warnings, each run is recorded, and `node qa/verify-record.ts` says when the check can block.

### The QA agents

- **Fewer refused commands.** `npm run test:summary -- --run @<area>` runs a test cycle in one command, and the guard's refusals say what to do instead. On the 5 tickets the campaigns of 5 and 7 November share, the writer's refusals fell from 16 to 1 and the verifier's from 41 to 0 ([details](eval/results/2026-11-07-guard-refusals.md)).
- **Fewer guesses about markup that does not exist yet.** The writer finds a field the ticket names by its label, not by a role it assumes, and checks a value such as a total as part of the element's text. On the 6 tickets measured, 21 of 21 trials succeeded, and the release decision is accepted against "D clean" ([details](eval/results/2026-11-09-field-by-label.md)).

### Evaluating the agents

- **Two real tickets, end to end**, through QA write tests, the review, QA verify and QA amend tests ([details](eval/results/2026-11-07-real-tickets.md)).
- **11 more campaigns in the history**, from 5 to 9 November: 31 in all.

The results of each campaign and analysis are in [eval/results](eval/results).

## v0.2.0, 4 November 2026

Since v0.1.0 the kit has an evaluation framework that measures its QA agents, without letting them see what they are measured on. The agents' prompts are those of the "D clean" campaign, the release baseline (`eval/release-baseline.json`).

### QA workflow

- The repair loop, an AI visual review and the QA agents run in CI.
- The agents are kept out of `node_modules` and `.git`, and the security model is documented.
- The example application is a shop, with CI screenshot baselines. It replaces the server console.
- The QA workflow, the demo and the costs are documented.

### Evaluating the agents

- **An evaluation harness**, `eval/`. Each ticket of a corpus comes with a spec, hidden tests, a reference implementation and injected bugs. `node eval/validate-corpus.ts` checks the corpus with no model call.
  - There are 17 tickets, among them an ambiguous one and an adversarial one.
  - EVAL-11 to EVAL-17 were written as tickets the agents were not tuned on.
- **The writer's choice of cases is measured.** It chooses cases that separate a right implementation from a wrong one, and unit tests that cannot pass on any implementation are sent back.
- **The corpus is isolated from the agent.** Each trial runs on three runners:
  - the agent, with a bundle and no checkout;
  - the scoring, with the corpus and no secret;
  - the verifier, with two implementations under neutral names.

  The bundle is scanned for any trace of the corpus. The agent's tests are scored in a sandbox that fails closed. Every campaign was rechecked for a sight of the corpus.
- **A versioned history** of every campaign, `eval/history`. Each campaign is rebuilt from its source report and records the agent version, environment, scorer, provenance and corrections. It holds 20 campaigns.
- **Paired comparisons**, `eval/compare.ts`. Two agent versions are compared ticket by ticket, with an exact sign test (McNemar when every ticket is stable), under rules fixed in `eval/compare-policy.json`: accepted, review or rejected.
- **Smoke runs**, `tickets: smoke`. A few tickets are chosen from the history: the critical ones, one of each kind, the risky ones, and a rotation slot. The choice is deterministic and backtested.
- **A release decision in CI**, under the rules at the candidate's commit. A rejection fails the job. A ticket rerun for its results gets one follow-up, then a human review.
- **Trials per ticket**, `trials: adaptive`. Each ticket gets its number of trials from its history (`eval/trials-policy.json`). `eval/trials.ts` replays what more or fewer trials change.
- **A cost cap**, `max_cost_usd`, 5 dollars by default. The plan estimates a campaign's cost from the history and starts nothing above the cap.

### Fixes found by the campaigns

- The parallelism counts each runner's working time, not the wait between runners.
- A trial whose scoring runner sent nothing back is recorded as a scoring error, not as missed bugs.
- Glob and Grep are back for the agents, and the verifier's transcripts are checked too.

### Measured and not kept

- **Asking the writer for one case per plausible wrong implementation.** It found EVAL-1's shipping bug 3 times out of 3, but false positives rose from 2 to 5 in 48 trials. It was reverted ([eval/results/2026-11-04-rule-5.md](eval/results/2026-11-04-rule-5.md)).

The results of each campaign and analysis are in [eval/results](eval/results).

## v0.1.0, 30 October 2026

The first version: the QA writer and verifier agents, their guard hooks, the `qa/` scripts, and a server console example.
