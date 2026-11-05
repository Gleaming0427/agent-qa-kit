# Apply the QA workflow

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

Add these scripts to the real application's `package.json` (copy
`qa/summary.ts` and `.claude/hooks/strict-evidence.ts`, which it imports):

```json
{
  "scripts": {
    "test:affected": "vitest run --reporter=dot --reporter=json --outputFile.json=reports/vitest.json",
    "test:unit": "vitest run --reporter=dot --reporter=json --outputFile.json=reports/vitest.json",
    "test:e2e": "playwright test",
    "test:summary": "node qa/summary.ts"
  }
}
```

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
`a + b = c`. Approve it with a review comment that has one line per criterion:

```text
AC-1: the Promo code field does not exist yet, so the test cannot fill it
AC-2: the Promo code field does not exist yet, so no code can be applied
```

Then merge it into `feat/TICKET-44`. To change a test before it is approved,
request changes, delete `qa/TICKET-44` and run the workflow again.

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
3. a collaborator approves it, with one line per criterion as before. Merge it,
   then update the developer's branch from `feat/TICKET-44`.

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
  so the QA pull request gets no checks of its own.
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
