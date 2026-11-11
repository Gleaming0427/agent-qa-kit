# Apply the QA workflow

This guide installs the kit in an application's repository, then follows one ticket through the GitHub workflows: write the tests, approve them, develop, verify. Running the agents on a developer machine is optional and comes after ([section 9](#9-run-the-agents-locally-optional)).

Words used below:
- **Ticket**: a Markdown file `specs/<TICKET>.md`, one line per acceptance criterion (`- AC-1: …`). There is no Jira connection.
- **Feature area**: the tag that groups the application's browser tests, `@shop` in the example (`--mfe` at install, for micro-frontend). The QA writer tags its browser tests with it.
- **RED**: every test of a ticket fails on an assertion, because the feature does not exist yet. The writer's tests are accepted only in that state.
- **Phase 1** is the writer's run: it writes the tests and shows them RED. **Phase 2** is the verifier's run, on the developer's implementation.
- **Review package**: the files of `qa-reviews/<TICKET>/`, next to the tests. They record the criteria, the writer's verdict, the RED reports, and later the approval and any amendment.

## 1. Install the kit

In the repository of your application, with Node.js 22.18 or later:

```bash
npx github:Gleaming0427/agent-qa-kit init
```

npm downloads the kit from GitHub and runs its installer; nothing is published to the npm registry. The repository must be a git repository with one application whose `package.json` has `vitest` and `@playwright/test`. When there are several, run it from the application's folder or give it with `--app apps/web`. It:

- copies the agents, their hooks, the `qa/` scripts and five workflows (QA write tests, QA approval, QA verify, QA amend tests, QA branch rules), set to the application's folder, its feature area (`--mfe`, the folder's name by default) and the branch that pull requests go into (`--branch`, the remote's default branch by default);
- adds the npm scripts the agents call when they are missing: `test:unit`, `test:affected`, `test:e2e` and `test:summary`. It never changes a script that exists;
- adds `/reports/` to the application's `.gitignore`;
- writes `.agent-qa-kit.json`, the installed version and a digest of each file.

It plans every change before it writes one. If a file it would write exists and differs from the kit, it lists the conflicts and writes nothing. `--dry-run` shows the plan without writing.

It then checks what the workflows need, as `npx github:Gleaming0427/agent-qa-kit doctor` does: the scripts and the reports they write (`reports/vitest.json`, `reports/playwright.json`), Playwright's `testDir` (the agents write the browser tests in `e2e/`), a browser test tagged `@smoke` ([section 8](#8-smoke-journeys)), a committed lockfile, and what git ignores. A `FAIL` must be fixed for the workflows to pass; a `warn` is worth reading. `doctor --run` also runs `test:unit`, `test:e2e` and `test:summary` the way QA verify's full suite does, and reads their reports. Commit the files it lists.

**The test scripts.** `init` adds these when they are missing; the Vitest and Playwright JSON reports may also be set in their configuration files, as in the example:

```json
{
  "scripts": {
    "test:affected": "vitest run --reporter=default --reporter=json --outputFile.json=reports/vitest.json",
    "test:unit": "vitest run --reporter=default --reporter=json --outputFile.json=reports/vitest.json",
    "test:e2e": "PLAYWRIGHT_JSON_OUTPUT_FILE=reports/playwright.json playwright test --reporter=list,json",
    "test:summary": "node qa/summary.ts"
  }
}
```

`test:affected` may be narrowed to the changed feature area. `test:unit` and `test:e2e` must run everything: they run the final full suite. `test:summary` gives the path of `qa/summary.ts` from the application's folder, `node ../../qa/summary.ts` for `apps/web`. `npm run test:summary -- --run @shop` runs `test:affected`, then `test:e2e -- --grep @shop`, and prints the summary of both: the writer runs a test cycle with this one command.

**npm or pnpm.** The workflows install the application from its lockfile (`qa/ci-install-app.sh`): `npm ci` for a `package-lock.json`, `pnpm install --frozen-lockfile` for a `pnpm-lock.yaml`. In a workspace, the lockfile may be at the workspace's root, next to `pnpm-workspace.yaml` or to a package.json with `"workspaces"`. pnpm needs its version in `"packageManager"`, for instance `"pnpm@10.34.9"`: every pnpm version writes the same lockfile format, so the lockfile cannot tell which one to install. Whatever installed the dependencies, the agents and the full suite run the scripts with `npm run`, which only starts a script of `package.json`; their allowed commands stay the same. Yarn and Bun are not supported.

**A step after the install.** When the application needs one before its tests, for instance building a package of its workspace whose built files are not committed, put it in a `qa:setup` script of the application's `package.json`, such as `"qa:setup": "pnpm --filter @acme/sdk build"`. The workflows run it right after the install, and `doctor --run` before the tests. `doctor` asks for it when the application depends on such a package.

**Node.js.** The workflows give the application the Node.js version its `.nvmrc` or `.node-version` names (`qa/ci-node-version.sh`), in its folder or above it up to the repository's root, and 22 when there is none. The kit's scripts need 22.18 or later, so an older version is refused; write a version number, such as `24` or `26.13.0`, or `lts/*`.

**Upgrade.** Run `init` again. A file still as the last install wrote it is updated; a file you changed is a conflict. `--force` replaces it, only if it is committed with no local change, so that git can give it back. To pin a version, add a tag or a commit: `npx github:Gleaming0427/agent-qa-kit#<tag> init`.

## 2. Set up GitHub, once

- Add the repository secret `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions), ideally a dedicated key with a low spending limit. The agents call Claude with it, and a run fails when the key has no credit left.
- Tick "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General → Workflow permissions).
- Add the repository variable `QA_VERIFY_MODE` = `advisory` (same page as the secret, Variables). QA verify then only warns until it has shown it can block ([section 7](#7-let-qa-verify-block-merges)).
- On a large application, add the variable `QA_MAX_TURNS`: it replaces the agents' own limit of turns (40 for the writer, 25 for the verifier). The budget ceiling still applies.
- Optionally, the variable `QA_VERIFY_TOOLING` = `block`: QA verify then fails when a pull request changes how its own tests run ([section 5](#5-develop-and-verify)). Without it, QA verify only says so.

Do not require the checks yet: that is the last step, in section 7.

## 3. Write a ticket and get its tests

Use the writer for changes to critical journeys, authorization, data integrity, important UI states, or integration boundaries. For a low-risk change, run the existing tests and ordinary code review. Record the reason for the choice in the ticket or pull request.

Write the ticket as `specs/TICKET-44.md`, with observable acceptance criteria: what the user sees or can do. Resolve ambiguous criteria before the writer starts: on an ambiguous ticket it stops and asks instead of guessing. Commit the ticket, then open Actions → **QA write tests** → Run workflow, from the branch the ticket is on (usually the default branch), with the ticket key, the feature area and the application folder. The job:

1. copies the kit (`qa/` and `.claude/`) to `/opt/qa-kit`, owned by root and read-only, before any code of the application runs (`qa/ci-trusted-kit.sh`, with `sudo`, as GitHub's runners allow). The agent's tests can write in the checkout, and the kit's scripts run again afterwards, with the API key or a token: they run from this copy;
2. checks the request before it spends anything: a valid ticket key, its spec, the secret, and no `qa/TICKET-44` branch yet;
3. installs the application, Chromium, Claude Code and its sandbox (`qa/ci-install-agents.sh`). The agent's commands run in bubblewrap, without network access, and never see the API key;
4. runs phase 1: for each criterion, at least one failing unit test and a failing browser test. A browser test must fail on an `expect(...)` assertion: a pass, a timeout, a crash or a network error is refused. If the application cannot start for the browser tests, the run stops as `blocked`;
5. saves the review package to `qa-reviews/TICKET-44/`, so that a later job can check the approval;
6. commits the tests and the package on `qa/TICKET-44`, creates `feat/TICKET-44` from the commit it ran on when it does not exist, and opens the pull request `qa/TICKET-44` → `feat/TICKET-44`.

The writer names every test with `[TICKET-44][AC-1]`. It puts the browser tests in `e2e/TICKET-44.spec.ts`, inside `test.describe('@shop TICKET-44', …)`, and the unit tests in a file named after the ticket.

## 4. Review and approve the tests

The pull request lists each criterion with its failing tests and their error excerpts; the test files are in its diff. Check that each failure comes from the missing behavior: a missing module, a selector that does not match the specified UI, a server failure or a test setup error is not a valid RED.

Under each criterion, the writer's coverage summary gives the cases its tests use, the wrong implementation each one rules out, and what they do not cover. Read that last list first: a case the ticket needs and the tests miss does not show in the test code. The kit has already recomputed every expected amount written as `a + b = c`. The pull request also lists:
- the browser assertions that a longer number would still pass. Playwright matches text by its part, so `getByText('4 products')` also finds "14 products", and `toContainText('× 1')` accepts "× 12";
- the unit tests that already passed before the feature existed. The kit accepts them when another test of the criterion fails, but each one shows nothing about the feature.

Approve with a review comment that has one line per criterion:

```text
AC-1: the Promo code field does not exist yet, so the test cannot fill it
AC-2: the Promo code field does not exist yet, so no code can be applied
```

Approve first, then merge into `feat/TICKET-44`. The pull request's **QA approval** status, next to the merge button, stays red until a collaborator approves its latest commit with a reason per criterion. It says what is missing: no approval yet, no reason for a criterion, an approval of an older commit, a request for changes. QA write tests sets it when it opens the pull request, and the QA approval workflow updates it after each review and each push (`qa/ci-approval.sh`). It does not prevent the merge: QA verify checks the approval again on the developer's pull request.

Prefer **Create a merge commit**: after a squash, a later amendment may have to be merged by hand ([section 6](#6-amend-an-approved-test)). To change a test before it is approved, request changes, delete `qa/TICKET-44` and run the workflow again.

## 5. Develop and verify

Work on `feat/TICKET-44`, or on any branch whose name or pull request title contains `TICKET-44`, and open a pull request into the branch chosen at install. The developer, a person or an agent, does not edit the approved tests.

**QA branch rules** runs on every pull request, with no model call:
- a `qa/TICKET-44` branch may change only tests;
- a pull request that names TICKET-44 in its branch name or title must keep every test from `qa/TICKET-44` unchanged, unit tests included;
- a pull request that does not name it may not touch `e2e/TICKET-44.spec.ts` at all.

**QA verify** runs on pull requests into that branch. For each ticket the branch or title names, it:

1. finds the ticket's QA pull request. It needs an approval by someone who can write to the repository (an owner, member or collaborator whose permission, read from GitHub, is write or more), on the latest commit of the tests, and no such person whose latest review requests changes (`qa/github-approval.ts`, `qa/ci-permissions.sh`). Someone with read access only does not count, and a request for changes from them does not block;
2. checks that the tests and the review package are identical to the approved commit (`qa/check-scope.sh frozen`), then records the approval from the review text, which must give a reason per criterion;
3. runs the verifier (phase 2) with the API key, then the full suite (`qa/full-suite.sh`) in a step without it. The ticket passes only if every test passes, at least one `@smoke` journey passes, and the ticket's criteria pass again in that run.

A pull request that names no such ticket passes at once, without a model call. Each verification has a $0.20 budget ceiling, and a newer push cancels the run in progress. If the QA pull request is approved after the developer's pull request was opened, re-run the check.

**Whose scripts judge the pull request.** QA verify and QA branch rules run the kit as the **base branch** has it, not as the pull request has it: a pull request that edits `qa/` or `.claude/` is still judged by the scripts it is merged into, and its change takes effect once it is merged. QA verify copies them to `/opt/qa-kit` (section 3); the other two read them from a second checkout of the base branch, and the QA approval status from the default branch. On the pull request that installs the kit, or upgrades it from a version without this copy, the base branch has nothing to copy from: the job uses the pull request's own scripts and warns. The workflow files `.github/workflows/qa-*.yml` still run as the pull request has them: protect `.github/` with a `CODEOWNERS` file.

**Changes to how the tests run.** The approved tests are frozen; what they run on is not. QA verify lists, in a warning and in the job summary, what the pull request changes in:
- the scripts of a `package.json` that run the tests or the install (`test*`, `install`, `prepare`, `qa:*`);
- the Vitest, Vite and Playwright configuration, and the files a configuration names as `setupFiles`, `globalSetup` or `globalTeardown`;
- the kit's own files (`qa/`, `.claude/`, the QA workflows, `.agent-qa-kit.json`).

A pass says nothing about those files: read that diff yourself. It does not look at dependencies, or at what a configuration imports without naming it as a setup file. With the repository variable `QA_VERIFY_TOOLING=block`, a change to the test setup fails the check (it only warns in advisory mode): make it in a pull request of its own, which names no ticket, then verify the feature.

When QA verify fails, fix the application. No workflow runs the repair agent: [section 9](#9-run-the-agents-locally-optional) shows how to run it on a developer machine. When the test itself is wrong, amend it (section 6).

Delete `qa/TICKET-44` once the ticket is merged: its tests then follow the normal review. The review package stays as a record of what was approved, by whom, and what was amended.

## 6. Amend an approved test

An approved test can turn out to be wrong, for instance an expected total worked out by hand. The repair agent may not touch it, and QA verify refuses a test edited on the developer's branch. Amend it instead:

1. fix the test on `qa/TICKET-44`: same test files, same titles;
2. run Actions → **QA amend tests** with the ticket key and the reason, such as "the expected total was €24.40; €19.50 + €4.90 + €4.00 is €28.40". No agent runs. The job runs the ticket's tests on the application without the feature: each one must still fail for the right reason. It logs who amended the tests and why in `qa-reviews/TICKET-44/TICKET-44-amendments.json`, and opens a pull request `qa/TICKET-44` → `feat/TICKET-44` that shows the amendment;
3. a collaborator approves it, with one line per criterion as before. Merge it once its QA approval status is green, then update the developer's branch from `feat/TICKET-44`.

QA verify then accepts the amended tests and lists each amendment in its summary. Adding or removing a test file is not an amendment: delete the branch and write the tests again. In a team, have someone other than the author approve the amendment.

**After a squash.** A test pull request merged with **Squash and merge** or **Rebase and merge** puts a copy of the tests on `feat/TICKET-44`, not the commits of `qa/TICKET-44`. The amendment's pull request would then add the same test files again and conflict. When the copy holds only the tests, as it does when nothing else had reached `feat/TICKET-44` before, QA amend tests records it on `qa/TICKET-44` with a merge commit that changes no file, and the amendment merges cleanly. Otherwise it warns, and the amendment has to be merged by hand, keeping the version of `qa/TICKET-44` of each conflicting file:

```bash
git fetch origin
git switch feat/TICKET-44
git merge origin/qa/TICKET-44
git checkout origin/qa/TICKET-44 -- $(git diff --name-only --diff-filter=U)
git commit --no-edit
git push origin feat/TICKET-44
```

Approve the amendment's pull request first: GitHub marks it as merged once `feat/TICKET-44` holds its commits.

## 7. Let QA verify block merges

Generated tests and the verifier's verdict should earn the right to block a merge. With `QA_VERIFY_MODE=advisory` (section 2), QA verify runs every check, reports each failure as a warning that says it would have blocked, and passes. QA branch rules still keeps the approved tests frozen.

In both modes, each run uploads a `qa-verify-record` artifact: one line per ticket and step, with the pull request, the commit, the result and the version of the agents. After a few weeks, download them and run:

```bash
node qa/verify-record.ts --labels labels.json path/to/records
```

It lists every run that would have blocked, with an id. A change to the test setup appears there as a `prepare` step, with the files in its detail. Label each one in `labels.json`, as `"false_block"` when the pull request was fine (a wrong test, a wrong verdict, a broken environment) or `"caught"` when the check found a real problem. It says the check is ready to block once it has seen 10 pull requests (`--min-prs`) with no false block and no failure left unlabeled.

Then delete the variable, or set it to `blocking`, and in the ruleset of the branch, require the **QA verify** and **QA branch rules (scope + frozen tests)** checks.

## 8. Smoke journeys

Choose one or two user journeys whose failure would be costly. Keep their Playwright tests independent of any ticket, tag them `@smoke`, use accessible roles and visible text, and run them on every pull request. `doctor` asks for at least one, and QA verify's full suite needs one to pass. Keep them small, isolated and stable; add a journey only when it protects a distinct user outcome.

The example, `examples/shop`, goes further. `init` does not install these parts; they run in the kit's own CI:
- a `mobile` Playwright project (Pixel 7) that runs only the `@smoke` tests;
- a full-page screenshot compared with a committed baseline, only in CI (`ignoreSnapshots: !process.env.CI`), because fonts render differently on each machine. When no baseline exists, CI creates one and publishes it as the `screenshot-baselines` artifact, to commit to `e2e/smoke.spec.ts-snapshots/`. When a comparison fails, the `qa-demo-reports` artifact holds the expected, actual and diff images. The runner is pinned to `ubuntu-24.04` for this reason;
- an advisory AI visual review, `node qa/visual-review.ts reports/screens reports/visual-review.json`. It sends the screenshots to a vision model (Claude Opus 5.5 by default, `QA_VISUAL_MODEL` to change it) with four checks: text that overflows, overlapping elements, empty sections, and controls off screen. Each finding becomes a warning; the step never fails the build, and is skipped without an `ANTHROPIC_API_KEY`. Screenshots leave your infrastructure: keep it off for pages with sensitive data;
- the test cycle: the same tests fail with a deliberate bug on, pass with it off, and fail again when it is back on.

## 9. Run the agents locally (optional)

The same steps run on a developer machine, on Linux or macOS (the agents' commands go through an OS sandbox). On Windows, use the workflows.

**Phase 1.** With the ticket in `specs/TICKET-42.md`:

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md shop
```

It applies the same rules as QA write tests, then prepares `reports/TICKET-42-review-request.json`: for each criterion, the failing tests with their error excerpts, and hashes of the test files. Read the tests and reports as in section 4. Copy `reports/TICKET-42-review-decision.template.json` to `reports/TICKET-42-review-decision.json`, fill in `reviewer` and one reason per criterion in `red_reasons`, then run:

```bash
node qa/scenario-review.ts approve TICKET-42 specs/TICKET-42.md
```

This local receipt detects changes to the spec, tests and initial report. It does not authenticate the reviewer: in a team, use the pull request review of section 4.

**Phase 2, with repairs.**

```bash
qa/repair-loop.sh TICKET-42 specs/TICKET-42.md shop
```

The loop runs phase 2. When it fails, it sends the short output of `qa/summary.ts` to the repair agent (`qa-repairer`), which may change the application but not tests, snapshots, test configuration, dependencies, installed packages (`node_modules/`), git files or the kit. After each repair, the loop checks that the approved tests, ticket and initial reports are unchanged, then verifies again: at most three verifications, the first and two after repairs (`QA_MAX_VERIFY_ATTEMPTS`). To verify once without repairs, run `qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md shop`.

Before the first verification, the loop records every file in `node_modules/` and the git configuration, hooks and info files (`qa/tooling-integrity.ts`). It compares them after every repair and every verification: a change stops the loop, even when it comes from code the tests ran rather than from the agent. A test runner patched in `node_modules/` cannot make a broken application pass. Only the caches that test tools rewrite on every run (`node_modules/.vite`, `.vitest`, `.cache` and `.tmp`) are left out.

As in QA verify, the verifier's pass is not final: the launcher then runs `npm run test:unit` and `npm run test:e2e` itself, with the same rules (section 5). The result is in `reports/TICKET-42-full-suite.json`. If every attempt fails, reassess the ticket and tests with a person and write the tests again. Review the repair agent's changes in the pull request like any other change.

Exit codes: `0` ready or pass, `1` fail, `2` blocked, `3` technical error, invalid verdict, attempt limit, or a repair that touched the approved tests, the installed packages or the git files.

**Amend locally.** `node qa/scenario-review.ts amend TICKET-42 specs/TICKET-42.md <author> <reason file>`, after the ticket's unit and browser tests have run, then a new approval.

**Budgets and models.** These environment variables change the local scripts' defaults: `QA_BUDGET_USD` ($1.00 for the writer, $0.20 for the verifier), `QA_MODEL` and `QA_EFFORT` (from the agent's file), `QA_REPAIR_BUDGET_USD` ($1.00), `QA_REPAIR_MODEL`, `QA_REPAIR_EFFORT`, `QA_MAX_TURNS`. In the workflows, only `QA_MAX_TURNS` and `QA_VERIFY_MODE` are read from the repository's variables.

## 10. Keep it running

- **Ticket tests** stay frozen while the ticket is developed. A wrong one is amended (section 6), never edited on the developer's branch.
- **Smoke tests:** a few stable journeys. Update them only when a critical flow changes.
- **Dependencies:** keep Playwright, Vitest and Vite up to date and check `npm audit`.
- **The kit:** after a change to the test setup, run `npx github:Gleaming0427/agent-qa-kit doctor --run`. To upgrade, run `init` again: it updates the files you have not changed and lists the others.

## Limits

- The workflows have run with the real API on two real tickets, one on the demo shop and one on omni-tools (`eval/results/2026-11-07-real-tickets.md`). The QA approval status and an amendment after a squash have run on a third demo ticket (`eval/results/2026-11-07-approval-trial.md`). Their deterministic parts are tested in `qa/tests/`, with a stand-in for the GitHub CLI.
- A pull request opened with `GITHUB_TOKEN` does not trigger other workflows, so the QA pull request gets no checks of its own when it opens. QA write tests and QA amend tests set its QA approval status themselves.
- A pull request can change the workflow files that judge it. The scripts they call come from the base branch, but the workflow files do not: in a team, protect `.github/` (and `qa/` and `.claude/`, which take effect once merged) with a `CODEOWNERS` file and the ruleset option "Require review from Code Owners".
- The copy of the kit in `/opt/qa-kit` and the checkout of the base branch have run on a GitHub-hosted runner, in QA verify on a pull request that names no ticket. The steps that come after, with a ticket, and QA write tests have not run with the copy yet, and the sandbox's write rules for the kit's folders were tried with the sandbox runtime, not through Claude Code. If a run fails at "Copy the kit where the agent's code cannot change it", the runner has no `sudo` or `/opt` is not writable.
- Code that runs in a job can reach that job's secrets. The key is limited to the agent's step and scrubbed from the agent's commands (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), and pull requests from forks never receive it. The dependencies of the pull request are still installed in the same job: keep the key dedicated and its spending limit low.
- The guard hook, not the settings file, keeps the agents out of `reports/` and `node_modules/`, since the test tools must keep writing their reports and caches there. More in [SECURITY.md](SECURITY.md).
