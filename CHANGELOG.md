# Changelog

## Unreleased

- **Fewer turns lost to refused commands.** Each tool call the guard refuses costs the agent a turn. In the campaign of 5 November (15 trials), it refused 16 calls of the writer and 41 of the verifier:
  - 12 of the writer's were its three test commands chained with `;`, their output cut with `| tail` or `| head`;
  - 23 of the verifier's were `cat` on a file, often tried again after the refusal, and 12 a test command cut with `| tail`.

  Now:
  - `npm run test:summary -- --run @<mfe>` runs the unit tests, then the browser tests of the feature area, and prints the summary of both: one command for a test cycle. When a run writes no report, it shows the end of that run's output. The writer's instructions use it.
  - The guard's refusals say what to do instead: one command per call, the Read, Glob and Grep tools rather than `cat`, `ls` or `find`, a folder for Grep. The reasons the evaluation counts refusals by stay the same, except for Grep from the project root.
  - Glob may search from the project root, as it already did with no path. Grep still may not: it would read files such as `.env`.
  - The verifier's instructions now say, as the writer's did, that shell commands such as `cat` are refused. The writer, which had that line, never tried `cat` in the campaign.
  - Measured on the smoke selection (run 42401051963), on the 5 tickets shared with the campaign of 5 November: writer refusals 16 → 1, verifier refusals 41 → 0, writer turns 11.3 → 9.0 on average, cost per trial $0.111 → $0.094; every score at 100%. The release decision asks for every ticket before a release (`eval/results/2026-11-07-guard-refusals.md`).
- **An amendment after a squash-merged test pull request.** On omni-tools, the test pull request was squash-merged: `feat/OMNI-1` got a copy of the tests, not the commits of `qa/OMNI-1`, so the amendment's pull request added the same files again and could not be merged on GitHub.
  - QA amend tests now finds how the latest test pull request was merged. When its copy on `feat/<TICKET>` holds only the tests, it records it on `qa/<TICKET>` with a merge commit that changes no file, and the amendment merges cleanly.
  - Replayed on the trial's commits, the amendment then merges into the same files as the merge made by hand.
  - When the copy also holds other changes, it warns instead: recording it would undo them on `feat/<TICKET>`. HOW_TO_APPLY.md gives the commands to merge by hand, checked on the same commits.
  - The test pull request's text recommends **Create a merge commit**.
  - Tried on GitHub on a demo ticket, SHOP-2: after a squash, the amendment's pull request showed only the amendment and merged with no conflict (`eval/results/2026-11-07-approval-trial.md`).
- **A QA approval status on the test pull request.** On two real tickets, both test pull requests were merged before they were approved, and one was first approved with no text. Nothing said so until QA verify ran on the developer's pull request.
  - The test pull request now has a **QA approval** status next to its merge button. It stays red until a collaborator approves its latest commit with a reason per criterion, and says what is missing. It turns green once the approval is the one QA verify will accept.
  - QA write tests and QA amend tests set it when they open the pull request, which triggers no workflow of its own. The new **QA approval** workflow updates it after each review and each push by a person (`qa/ci-approval.sh`). No AI and no application code runs there.
  - It does not prevent the merge, and QA verify still checks the approval. The pull request's text now says to approve first, then merge.
  - The installer copies the new workflow and script.
  - Tried on GitHub on a demo ticket, SHOP-2: red when the pull request opened, still red after an approval with no text, green after one with a line per criterion (`eval/results/2026-11-07-approval-trial.md`).
- **An installer.** `npx github:Gleaming0427/agent-qa-kit init`, in the repository of an application, installs the kit; `doctor` checks what the workflows need. Until now the files had to be copied by hand.
  - It finds the application (Vitest and Playwright in its `package.json`), copies the agents, hooks, `qa/` scripts and the four workflows set to that application and to the remote's default branch, adds the missing npm scripts without changing existing ones, and has git ignore `reports/`.
  - It plans before writing: a file that exists and differs is a conflict, and nothing is written. `.agent-qa-kit.json` records a digest of each file, so that running `init` again upgrades the files nobody changed. `--force` only replaces files committed with no local change.
  - `doctor` checks the scripts and their JSON reports, Playwright's test folder, a test tagged `@smoke`, a committed lockfile, ignored files and executable bits. `doctor --run` runs the tests as QA verify's full suite does.
  - **pnpm applications.** The workflows install the application with npm or pnpm, whichever its lockfile belongs to, in a workspace too (`qa/ci-install-app.sh`). pnpm's version comes from `"packageManager"`, which `doctor` asks for. The agents still run the scripts with `npm run`, so their allowed commands do not change; tried with pnpm 12 on the demo shop.
  - **A setup step and the project's Node.js**, found by trying the kit on a large monorepo (immich):
    - an application's `qa:setup` script runs after the install, for a step its tests need first, such as building a package of its workspace. `doctor` asks for it when the application depends on a package of the repository whose built entry is not committed, with the command to write;
    - the workflows use the Node.js version of the application's `.nvmrc` or `.node-version`, 22 without one, and refuse one older than 22.18, which the kit's scripts need (`qa/ci-node-version.sh`).
  - **More turns for a large application.** On omni-tools, the writer reached its limit of 40 turns before writing the browser test. The repository variable `QA_MAX_TURNS` now replaces the agents' own limit in the workflows; the budget ceiling still applies, and the limits stay the same when it is unset.
  - An application at the root of its repository works: **QA amend tests** refused it, as it read the review package's path with a `./` prefix git does not write.
- **A coverage summary for the reviewer.** Reading test code shows what is wrong in a test, not what is missing: the evaluation's missed bugs came from tests that looked right.
  - The writer's phase 1 verdict now states, for each criterion, the cases its tests use (data, expected values with their arithmetic, the wrong implementation each one rules out) and what they leave out.
  - The Stop hook sends back a verdict without it, and one whose arithmetic does not add up (`.claude/hooks/coverage.ts`).
  - The review pull request shows the summary under each criterion.
  - Verdicts approved before this change stay valid.
- **Amending approved tests.** A wrong approved test had no clean way out: the repair agent may not touch it, and QA verify refuses a test edited on the developer's branch. Now:
  - a person fixes it on `qa/<TICKET>`, then runs the new **QA amend tests** workflow with the reason;
  - no agent runs: every test of the ticket must still fail for the right reason on the application without the feature;
  - the amendment is logged with its author and reason in the review package, and the tests need a new approval;
  - QA verify lists the amendments in its summary.
- **An advisory mode for QA verify.** The repository variable `QA_VERIFY_MODE=advisory` makes every failure a warning that says it would have blocked, and lets the check pass.
  - In both modes, each run records the outcome of each step, ticket by ticket, in a `qa-verify-record` artifact.
  - `node qa/verify-record.ts` reads these records and lists the failures for a person to label as false blocks or real problems. It says when the check can block: enough pull requests, no false block, nothing left unlabeled.

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
