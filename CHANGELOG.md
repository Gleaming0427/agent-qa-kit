# Changelog

## Unreleased

- **The scripts that judge are no longer the ones the code under test can rewrite.** Two gaps, found in a review of the kit's security:
  - **An application at the root of its repository.** The tests an agent runs can write in the project's folder, which then holds `qa/` and `.claude/`; the launchers run those files again outside the sandbox, with the API key. Tried with the sandbox runtime (bubblewrap), a test run with the project's folder writable rewrote `qa/` and `.claude/hooks/`; with those folders in the sandbox's `denyWrite`, it could not. Now:
    - the agents' settings add the kit's folders and the project's `qa/`, `.claude/` and `.github/` to `denyWrite`, as absolute paths;
    - `qa/run-qa.sh` and `qa/repair-loop.sh` compare the kit's files before and after each agent, before any script of the kit runs again, and stop with the paths that changed (`qa/kit-integrity.sh`);
    - the workflows run the kit from `/opt/qa-kit`, a copy owned by root and read-only, made before any code of the application runs (`qa/ci-trusted-kit.sh`; it uses `sudo`, as GitHub's runners allow).
  - **A pull request judged by its own scripts.** QA verify ran `qa/` and `.claude/` as the pull request had them, so a pull request could weaken the checks that judged it. Now QA verify and QA branch rules use the kit of the pull request's base branch, and the QA approval status the default branch's. A pull request that installs or upgrades the kit has no such copy to use: it uses its own scripts and warns.
  - **New: changes to how the tests run are reported.** QA verify says, in a warning and in the job summary, when a pull request changes the test scripts of a `package.json`, the Vitest, Vite or Playwright configuration, a setup file it names, or the kit's own files. The repository variable `QA_VERIFY_TOOLING=block` makes a change to the test setup fail the check. The default only warns.
  - Run on a GitHub-hosted runner so far: the copy in `/opt/qa-kit` and the checkout of the base branch, in QA verify on a pull request that names no ticket. Not yet run: the steps that follow with a ticket, QA write tests, and the sandbox rules through Claude Code. The rest has regression tests. Run `npx github:Gleaming0427/agent-qa-kit init` again to upgrade.
- **Approval counts only from someone who can write, the tests of a ticket stay frozen on any pull request, and the repair agent keeps out of the test setup.** The three remaining gaps of the same review:
  - **Approval.** An owner, a member or a collaborator can have read access only, and GitHub's author association does not say. `qa/ci-permissions.sh` now reads each reviewer's permission, and an approval counts only with write access or more; a request for changes blocks only from someone whose approval would count, so a passer-by on a public repository can no longer block QA verify. If the job's token cannot read the permission, the check warns and falls back to the association, as before: the change only narrows who may approve. Whether the workflows' token may read it has not been tried on a runner.
  - **Tests of a ticket the pull request does not name.** A pull request whose branch and title name no ticket could change that ticket's unit tests; only its browser tests and review package were protected. `qa/check-test-blocks.ts` reads the test files test by test: a test whose title carries `[TICKET-42][AC-1]` cannot be changed, removed or moved by a pull request that does not name TICKET-42. It runs in QA branch rules on every pull request, for tickets whose `qa/` branch was deleted too.
  - **The QA agent rewriting existing tests.** The writer's branch may add tests and rewrite the ones it wrote for its own ticket, not another ticket's test, a test with no ticket, or a hook that was there. The check runs before the tests are pushed (`qa/check-scope.sh scope`, in QA write tests and QA amend tests) and again on the pull request.
  - **The repair agent and the test setup.** It may no longer edit a setup file, a mock, a fixture or a test helper, found by name (`setupTests.ts`, `vitest.setup.ts`, `auth.setup.ts`, `__mocks__/`, `test-utils.ts`, `tests/` and the like). `qa/repair-loop.sh` also compares `package.json`, the test configuration, the setup files it names and what they import with a snapshot taken before any agent ran, so a change made by code that the tests run is caught too. QA verify names a pull request's changes to such files with the other changes to how the tests run.
  - Regression tests cover each rule, on real git histories. Not yet run on a GitHub-hosted runner. Limits are in `SECURITY.md`. Run `npx github:Gleaming0427/agent-qa-kit init` again to upgrade.
- **Fixed: the kit's integrity check stopped every run that used Claude Code.** On the first real run of QA write tests after the checks above (a GitHub-hosted runner, TICKET-44 on the demo shop), the writer finished (verdict `ready`, 10 turns, 56 s, $0.14, red tests for both criteria), and `qa/run-qa.sh` then stopped with "the kit's own files changed while the agent ran (.claude/, .claude/.cc-writes/, .claude/agents/, .claude/commands/)". Claude Code had created those empty folders in the project while it started its session; the manifest listed folders, so an empty one that appeared counted as tampering. The manifest now lists files, links and what is neither, not folders: a file created inside a new folder is still reported. This affected the application in a folder of its own with no `.claude/`, and very likely the application at the root too. It could not show in the kit's tests, whose stand-in for `claude` creates nothing; the new ones reproduce what the runner showed, in both layouts and in the repair loop, and fail with the previous script.
- **Tested: the publish step of QA write tests.** `qa/ci-write-tests.sh publish` had no test. It now runs on a real git history with a bare origin and a stand-in for the GitHub CLI: tests that the writer added are committed and pushed with `feat/<ticket>` and the pull request, a test added to a shared file is accepted, a rewrite of another ticket's test or of a test with no ticket stops the run before anything is pushed, and application changes are left out with a warning.
- **The demo no longer compares screenshots with committed images.** A pixel comparison needs the same pixels on every machine, and fonts differ between Mac, Windows and Linux: the baselines had to be made by CI on its pinned runner and made again whenever the page changed, which took a manual round (remove them, run the workflow, download them, look at them, commit them). The kit never installed this part; it only ran in the demo's CI. The smoke test keeps its other checks (a control in view, no sideways scroll, the journey itself), and still takes its screenshots for the advisory AI visual review, which is not compared with anything. The two images, the `ignoreSnapshots` setting and the two workflow steps that made and published baselines are gone.
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
