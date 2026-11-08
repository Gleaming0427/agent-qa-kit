# Apply the QA workflow

## Install the kit

In the repository of your application, with Node.js 22.18 or later:

```bash
npx github:Gleaming0427/agent-qa-kit init
```

npm downloads the kit from GitHub and runs its installer; nothing is published to
the npm registry. The repository must be a git repository with one application
whose `package.json` has `vitest` and `@playwright/test`. When there are several,
run it from the application's folder or give it with `--app apps/web`. It:

- copies the agents, their hooks and the `qa/` scripts, and the five workflows (QA
  write tests, QA verify, QA branch rules, QA amend tests, QA approval), set to the application's
  folder, its feature area (`--mfe`, the folder's name by default) and the branch
  that pull requests go into (`--branch`, the remote's default branch by default);
- adds the npm scripts the agents call when they are missing: `test:unit`,
  `test:affected`, `test:e2e` and `test:summary`. It never changes a script that
  exists;
- adds `/reports/` to the application's `.gitignore`;
- writes `.agent-qa-kit.json`, the installed version and a digest of each file.

It plans every change before it writes one. If a file it would write exists and
differs from the kit, it lists the conflicts and writes nothing. `--dry-run` shows
the plan without writing.

It then checks what the workflows need, as `npx github:Gleaming0427/agent-qa-kit
doctor` does: the scripts and the reports they write (`reports/vitest.json`,
`reports/playwright.json`), Playwright's `testDir` (the agents write the browser
tests in `e2e/`), a browser test tagged `@smoke` (section 1), a committed
lockfile, and what git ignores. A `FAIL`
must be fixed for the workflows to pass; a `warn` is worth reading. `doctor --run`
also runs `test:unit`, `test:e2e` and `test:summary` the way QA verify's full
suite does, and reads their reports. Commit the files it lists, then make the
GitHub settings of [section 5](#5-run-the-agents-in-ci).

To upgrade, run `init` again. A file still as the last install wrote it is
updated; a file you changed is a conflict. `--force` replaces it, only if it is
committed with no local change, so that git can give it back. To pin a version,
add a tag or a commit: `npx github:Gleaming0427/agent-qa-kit#<tag> init`.

**npm or pnpm.** The workflows install the application from its lockfile
(`qa/ci-install-app.sh`): `npm ci` for a `package-lock.json`, `pnpm install
--frozen-lockfile` for a `pnpm-lock.yaml`. In a workspace, the lockfile may be at
the workspace's root, next to `pnpm-workspace.yaml` or to a package.json with
`"workspaces"`. pnpm needs its version in `"packageManager"`, for instance
`"pnpm@10.34.9"`: every pnpm version writes the same lockfile format, so the
lockfile cannot tell which one to install. Whatever installed the dependencies,
the agents and the full suite run the scripts with `npm run`, which only starts a
script of `package.json`; their allowed commands stay the same. Yarn and Bun are
not supported.

**A step after the install.** When the application needs one before its tests, for
instance building a package of its workspace whose built files are not committed,
put it in a `qa:setup` script of the application's `package.json`, such as
`"qa:setup": "pnpm --filter @acme/sdk build"`. The workflows run it right after the
install, and `doctor --run` before the tests. `doctor` asks for it when the
application depends on such a package.

**Node.js.** The workflows give the application the Node.js version its `.nvmrc`
or `.node-version` names (`qa/ci-node-version.sh`), in its folder or above it up to
the repository's root, and 22 when there is none. The kit's scripts need 22.18 or
later, so an older version is refused; write a version number, such as `24` or
`26.13.0`, or `lts/*`.

The agents run on Linux and macOS (their commands go through an OS sandbox). On
Windows, use the GitHub workflows.

## 1. Start with a fixed smoke journey

Choose one or two user journeys whose failure would be costly. Keep their
Playwright tests independent of a Jira ticket, tag them `@smoke`, use
accessible roles and visible text, and run them on every pull request. The
example uses `examples/shop/e2e/smoke.spec.ts` and `npm run test:smoke`.

Run them on a phone screen too. The example's Playwright config adds a
`mobile` project (Pixel 7) that runs only `@smoke` tests. The smoke test compares
a full-page screenshot with a committed baseline, checks that the first "Add to
cart" button is in view and that the page does not scroll sideways, then fills a
cart and checks out.

Screenshots are compared only in CI (`ignoreSnapshots: !process.env.CI`),
because fonts render differently on each machine. When no baseline exists, CI
creates one and publishes it as the `screenshot-baselines` artifact: commit its
files to `e2e/smoke.spec.ts-snapshots/`. To accept an intended visual change,
delete the old images, push, and commit the new artifact. When a comparison
fails, the `qa-demo-reports` artifact holds the expected, actual and diff images.
The CI runner is pinned to `ubuntu-24.04` for this reason: regenerate the
baselines when you move it to a newer image.

A pixel comparison says that a page changed, not that it is broken. For that,
the smoke test also saves each page to `reports/screens/` and CI runs an
advisory AI visual review:

```bash
node qa/visual-review.ts reports/screens reports/visual-review.json
```

It sends the screenshots to a vision model (Claude Opus 5.5 by default,
`QA_VISUAL_MODEL` to change it) with four checks: text that overflows,
overlapping elements, empty sections, and controls off screen. Each finding
becomes a warning on the pull request, and the job summary lists them in a
table. The step never fails the build: without an `ANTHROPIC_API_KEY` secret it
is skipped, and an API error or a refused request becomes a warning. Confirm
each finding on the screenshots, which the `qa-demo-reports` artifact holds,
before acting on it. Screenshots leave your infrastructure: keep the review off
for pages with sensitive data.

Keep these tests small, isolated, and stable. Add a new journey only when it
protects a distinct user outcome.

## 2. Decide when ticket-specific QA is useful

Run the QA writer for changes to critical journeys, authorization, data
integrity, important UI states, or integration boundaries. For a low-risk
change, run the fixed suite and ordinary code review without generating a new
browser scenario. Record the reason for the choice in the ticket or PR.

The ticket must state observable acceptance criteria such as `AC-1`, `AC-2`.
Resolve ambiguous criteria before the agent writes tests.

## 3. Establish and review the RED baseline

The application needs these scripts in its `package.json`. `init` adds the
missing ones; the Vitest and Playwright JSON reports may also be set in their
configuration files, as in the example:

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

`test:summary` gives the path of `qa/summary.ts` from the application's folder,
`node ../../qa/summary.ts` for `apps/web`. `npm run test:summary -- --run @shop`
runs `test:affected`, then `test:e2e -- --grep @shop`, and prints the summary of
both: the QA writer runs a test cycle with this one command.

Every test name must contain `[TICKET-42][AC-1]` (adapt ticket and ID). The
Playwright scenarios for the ticket belong in `e2e/TICKET-42.spec.ts`, inside
`test.describe('@shop TICKET-42', ...)` (the MFE name as a tag), so that
`npm run test:e2e -- --grep @shop` selects them in both phases.
`test:affected` may be narrowed to the changed MFE; `test:unit` and `test:e2e`
must run everything, because the launcher uses them for the final full suite.
The QA writer must work from the ticket before seeing the implementation.
Then run:

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md shop
```

For every criterion, the launcher requires an individual failing unit test
and a failing browser scenario. A browser scenario must fail on an
`expect(...)` assertion: a pass, a timeout, a crash or a network error is
refused. If the application cannot start for the browser tests, the launcher
stops with `blocked` (exit code 2).

It then prepares `reports/TICKET-42-review-request.json`: for each criterion,
the failing unit and browser tests with their error excerpts, plus hashes of
the test files. Inspect the full test source and reports. Confirm each failure
comes from the missing user behavior. A missing module, a selector that does
not match the specified UI, a server failure or a test setup error is not an
accepted RED baseline.

Copy `reports/TICKET-42-review-decision.template.json` to
`reports/TICKET-42-review-decision.json`. Fill in `reviewer` and one substantive
`red_reasons` explanation per criterion, then run:

```bash
node qa/scenario-review.ts approve TICKET-42 specs/TICKET-42.md
```

This local receipt detects changes to the spec, tests, and initial report. It
does not authenticate the reviewer. Require a human PR review and protect the
QA test branch in a production repository.

## 4. Implement, verify, and stop after bounded repairs

After the review, the development agent implements the ticket without editing
the approved tests. Keep the QA agent's tests on a `qa/TICKET-42` branch and
start the development branch from it. The "QA branch rules" check runs on every
pull request:

- a `qa/TICKET-42` branch may change only tests;
- a PR that names TICKET-42 in its branch name or title must keep every test
  from `qa/TICKET-42` unchanged;
- a PR that does not name it may not touch `e2e/TICKET-42.spec.ts` at all.

The QA writer puts each ticket's unit tests in a file named after the ticket;
they are compared when the PR names the ticket. Delete `qa/TICKET-42` once the
ticket is merged: its tests then follow the normal review. Then run:

```bash
qa/repair-loop.sh TICKET-42 specs/TICKET-42.md shop
```

The loop runs phase 2. When it fails, it sends the short output of
`qa/summary.ts` to the `qa-repairer` agent, which may change the application
but not tests, snapshots, test configuration, dependencies, installed packages
(`node_modules/`), git files or the kit. After each repair, the loop checks
that the approved tests, ticket and initial reports are unchanged, then
verifies again.

Before the first verification, the loop also records every file in
`node_modules/` and the git configuration, hooks and info files
(`qa/tooling-integrity.ts`). It compares them after every repair and every
verification: a change stops the loop with code 3, even when it comes from
code that the tests ran rather than from the agent itself. A test runner
patched in `node_modules/` cannot make a broken application pass. Only the
caches that test tools rewrite on every run (`node_modules/.vite`, `.vitest`,
`.cache` and `.tmp`) are left out.

The guard hook, not the settings file, keeps the agents out of `reports/` and
`node_modules/`. Claude Code also applies the settings' deny rules to the
commands that run in the sandbox, and the test tools must keep writing their
reports and caches there. The launcher accepts at most three
verification runs per reviewed baseline: the first run and two after repairs.
To verify once without repairs, run `qa/run-qa.sh TICKET-42 2
specs/TICKET-42.md shop`.

The verifier's pass is not final: the launcher then runs `npm run test:unit`
and `npm run test:e2e` itself. The ticket passes only if every test passes, at
least one `@smoke` journey passes, and the ticket's criteria pass again in that
run. The result is in `reports/TICKET-42-full-suite.json`. If all attempts
fail, reassess the spec and tests with a human and establish a new RED baseline.

Exit codes: `0` ready or pass, `1` fail, `2` blocked, `3` technical error,
invalid verdict, attempt limit, or a repair that touched the approved tests,
the installed packages or the git files.
Review the repair agent's diff in the pull request like any other change.

## 5. Run the agents in CI

Two GitHub workflows run steps 3 and 4 without a developer machine. Set them up
once:

- add an `ANTHROPIC_API_KEY` repository secret (Settings → Secrets and
  variables → Actions), ideally a dedicated key with a low spending limit;
- tick "Allow GitHub Actions to create and approve pull requests" (Settings →
  Actions → General → Workflow permissions);
- in the ruleset of `main`, require the **QA verify** and **QA branch rules
  (scope + frozen tests)** checks.

**Write the tests.** Commit the ticket as `specs/TICKET-44.md`, then open
Actions → **QA write tests** → Run workflow, with the ticket key, the feature
area (`shop`) and the application folder. The job:

1. checks the request before it spends anything: a valid ticket key, its spec,
   the secret, and no `qa/TICKET-44` branch yet;
2. installs the application, Chromium, Claude Code and its sandbox
   (`qa/ci-install-agents.sh`). The agent's commands run in bubblewrap, without
   network access, and never see the API key;
3. runs phase 1, as `qa/run-qa.sh TICKET-44 1 specs/TICKET-44.md shop`
   does on a developer machine;
4. saves the review package (criteria, first verdict, RED reports and review
   request) to `qa-reviews/TICKET-44/` next to the tests, so that a later job
   can check the approval;
5. commits the tests and the package on `qa/TICKET-44`, creates
   `feat/TICKET-44` from `main` when it does not exist, and opens the pull
   request `qa/TICKET-44` → `feat/TICKET-44`.

**Review.** The pull request lists each criterion with its failing tests and
their error excerpts; the test files are in its diff. Under each criterion, the
writer's coverage summary gives the cases its tests use, the wrong
implementation each one rules out, and what they do not cover. Read that last
list first: a case the ticket needs and the tests miss does not show in the test
code. The kit has already recomputed every expected amount written as
`a + b = c`. It also lists the browser assertions that a longer number would
still pass: Playwright matches text by its part, so `getByText('4 products')`
also finds "14 products", and `toContainText('× 1')` accepts "× 12". And it
lists the unit tests that already passed before the feature existed: the kit
accepts them when another test of the criterion fails, but each one shows
nothing about the feature. Approve it with a review comment that has one line
per criterion:

```text
AC-1: the Promo code field does not exist yet, so the test cannot fill it
AC-2: the Promo code field does not exist yet, so no code can be applied
```

Approve first, then merge it into `feat/TICKET-44`. The pull request's **QA
approval** status, next to the merge button, stays red until a collaborator
approves its latest commit with a reason per criterion. It says what is missing:
no approval yet, no reason for a criterion, an approval of an older commit, a
request for changes. QA write tests sets it when it opens the pull request, and
the **QA approval** workflow updates it after each review (`qa/ci-approval.sh`).
It does not prevent the merge: QA verify checks the approval again on the
developer's pull request. Prefer **Create a merge commit**: after a squash, a
later amendment may have to be merged by hand (see below). To change a test
before it is approved, request changes, delete `qa/TICKET-44` and run the
workflow again.

**Amend an approved test.** An approved test can turn out to be wrong, for
instance an expected total worked out by hand. The repair agent may not touch it,
and QA verify refuses a test edited on the developer's branch. Amend it instead:

1. fix the test on `qa/TICKET-44`: same test files, same titles;
2. run Actions → **QA amend tests** with the ticket key and the reason, such as
   "the expected total was €24.40; €19.50 + €4.90 + €4.00 is €28.40". No agent
   runs. The job runs the ticket's tests on the application without the feature:
   each one must still fail for the right reason. It logs who amended the tests
   and why in `qa-reviews/TICKET-44/TICKET-44-amendments.json`, and opens a pull
   request `qa/TICKET-44` → `feat/TICKET-44` that shows the amendment;
3. a collaborator approves it, with one line per criterion as before. Merge it
   once its QA approval status is green, then update the developer's branch from
   `feat/TICKET-44`.

A test pull request merged with **Squash and merge** or **Rebase and merge**
puts a copy of the tests on `feat/TICKET-44`, not the commits of
`qa/TICKET-44`. The amendment's pull request would then add the same test files
again and conflict. When the copy holds only the tests, as it does when nothing
else had reached `feat/TICKET-44` before, QA amend tests records it on
`qa/TICKET-44` with a merge commit that changes no file, and the amendment
merges cleanly. Otherwise it warns, and the amendment has to be merged by hand,
keeping the version of `qa/TICKET-44` of each conflicting file:

```bash
git fetch origin
git switch feat/TICKET-44
git merge origin/qa/TICKET-44
git checkout origin/qa/TICKET-44 -- $(git diff --name-only --diff-filter=U)
git commit --no-edit
git push origin feat/TICKET-44
```

Approve the amendment's pull request first: GitHub marks it as merged once
`feat/TICKET-44` holds its commits.

QA verify then accepts the amended tests and lists each amendment in its summary.
Adding or removing a test file is not an amendment: delete the branch and write
the tests again. In a team, have someone other than the author approve the
amendment. Locally, the same check is `node qa/scenario-review.ts amend
TICKET-44 specs/TICKET-44.md <author> <reason file>`, after the ticket's unit and
browser tests have run, followed by a new approval.

**Develop and verify.** Work on `feat/TICKET-44`, or on any branch whose name or
pull request title contains `TICKET-44`, and open a pull request into `main`.
**QA verify** then:

1. finds the QA pull request of each ticket the branch or title names. It needs
   an approval by an owner, member or collaborator of the repository, on the
   latest commit of the tests, and no reviewer whose latest review requests
   changes (`qa/github-approval.ts`);
2. checks that the tests and the review package are identical to the approved
   commit (`qa/check-scope.sh frozen`), then records the approval from the
   review text, which must give a reason per criterion;
3. runs the QA verifier agent (phase 2) with the API key, then the full suite
   (`qa/full-suite.sh`) in a step without it.

A failure blocks the merge. A pull request that names no such ticket passes at
once, without a model call.

**Start in advisory mode.** Generated tests and the verifier's verdict should
earn the right to block a merge. Set the repository variable `QA_VERIFY_MODE` to
`advisory` (Settings → Secrets and variables → Actions → Variables): QA verify
then runs every check, reports each failure as a warning that says it would have
blocked, and passes. The **QA branch rules** check still keeps the approved tests
frozen. In both modes, each run uploads a `qa-verify-record` artifact: one line
per ticket and step, with the pull request, the commit, the result and the
version of the agents. After a few weeks, download them and run:

```bash
node qa/verify-record.ts --labels labels.json path/to/records
```

It lists every run that would have blocked, with an id. Label each one in
`labels.json`, as `"false_block"` when the pull request was fine (a wrong test,
a wrong verdict, a broken environment) or `"caught"` when the check found a real
problem. It says the check is ready to block once it has seen 10 pull requests
(`--min-prs`) with no false block and no failure left unlabeled. Then delete the
variable, or set it to `blocking`, and make the check required. If the QA pull request is approved after the
developer's pull request was opened, re-run the check. Each verification has a
$0.20 budget ceiling, and a newer push cancels the run in progress.

Limits:

- The workflows have not run against the real API yet; their deterministic
  parts are tested in `qa/tests/ci-verify.test.ts`.
- A pull request opened with `GITHUB_TOKEN` does not trigger other workflows,
  so the QA pull request gets no checks of its own when it opens. QA write tests
  and QA amend tests set its QA approval status themselves.
- The QA approval status and an amendment after a squash have run on GitHub on
  one ticket of the demo (`eval/results/2026-11-07-approval-trial.md`). Their
  logic is tested in `qa/tests/github-approval.test.ts`,
  `qa/tests/ci-approval.test.ts` and `qa/tests/ci-amend.test.ts`, with a
  stand-in for the GitHub CLI.
- A pull request can change the workflows that judge it. In a team, protect
  `.github/`, `qa/` and `.claude/` with a `CODEOWNERS` file and the ruleset
  option "Require review from Code Owners".
- Code that runs in a job can reach that job's secrets. The key is limited to
  the agent's step and scrubbed from the agent's commands
  (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), and pull requests from forks never
  receive it. The dependencies of the pull request are still installed in the
  same job: keep the key dedicated and its spending limit low.

The example CI demonstrates the smoke journey on desktop and mobile with a
screenshot comparison, the expected RED → Green → Regression cycle, and a final
full-suite run. It does not connect to Jira or a real application shell.

## 6. Keep it running

- **Smoke tests:** a few stable journeys. Update them only when a critical flow changes.
- **Screenshots:** the baselines are made in CI. After an intended visual change, delete them and commit the new ones from the `screenshot-baselines` artifact.
- **Ticket tests:** frozen while the ticket is developed. If an approved test turns out to be wrong, fix it on `qa/<TICKET>` and run **QA amend tests** with the reason. No agent runs: the job checks that the tests still fail for the right reason without the feature, logs who changed them and why, and opens a pull request to approve again (see [section 5](#5-run-the-agents-in-ci)). Delete the `qa/<TICKET>` branch once it is merged: they become ordinary tests. The review package in `qa-reviews/<TICKET>/` stays as a record of what was approved, by whom, and what was amended.
- **Dependencies:** keep Playwright, Vitest and Vite up to date and check `npm audit`.
- **The kit:** after a change to the test setup, run `npx github:Gleaming0427/agent-qa-kit doctor --run`. To upgrade the kit, run `init` again: it updates the files you have not changed and lists the others.
