# Apply the QA workflow

## 1. Start with a fixed smoke journey

Choose one or two user journeys whose failure would be costly. Keep their
Playwright tests independent of a Jira ticket, tag them `@smoke`, use
accessible roles and visible text, and run them on every pull request. The
example uses `examples/server-console/e2e/smoke.spec.ts` and `npm run test:smoke`.

Run them on a phone screen too. The example's Playwright config adds a
`mobile` project (Pixel 7) that runs only `@smoke` tests. The smoke test checks
that the search box is in view and that the page does not scroll sideways, then
compares a full-page screenshot with a committed baseline.

Screenshots are compared only in CI (`ignoreSnapshots: !process.env.CI`),
because fonts render differently on each machine. When no baseline exists, CI
creates one and publishes it as the `screenshot-baselines` artifact: commit its
files to `e2e/smoke.spec.ts-snapshots/`. To accept an intended visual change,
delete the old images, push, and commit the new artifact. When a comparison
fails, the `qa-demo-reports` artifact holds the expected, actual and diff images.

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
`test.describe('@services TICKET-42', ...)` (the MFE name as a tag), so that
`npm run test:e2e -- --grep @services` selects them in both phases.
`test:affected` may be narrowed to the changed MFE; `test:unit` and `test:e2e`
must run everything, because the launcher uses them for the final full suite.
The QA writer must work from the ticket before seeing the implementation.
Then run:

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services
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
the approved tests. Run:

```bash
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services
```

The launcher accepts at most three verification runs per reviewed baseline:
the first run and two after repairs. When a run fails, send the short output
from `qa/summary.ts` to the repair agent, inspect a full trace only when
needed, and rerun the affected test.

The verifier's pass is not final: the launcher then runs `npm run test:unit`
and `npm run test:e2e` itself. The ticket passes only if every test passes, at
least one `@smoke` journey passes, and the ticket's criteria pass again in that
run. The result is in `reports/TICKET-42-full-suite.json`. If all attempts
fail, reassess the spec and tests with a human and establish a new RED baseline.

Exit codes: `0` ready or pass, `1` fail, `2` blocked, `3` technical error or
invalid verdict.

The example CI demonstrates the smoke journey on desktop and mobile with a
screenshot comparison, the expected RED → Green → Regression cycle, and a final
full-suite run. It does not connect to Jira or a real application shell.
