# Apply the QA workflow

## 1. Start with a fixed smoke journey

Choose one or two user journeys whose failure would be costly. Keep their
Playwright tests independent of a Jira ticket, use accessible roles and visible
text, and run them on every pull request. The example uses
`examples/server-console/e2e/smoke.spec.ts` and `npm run test:smoke`.

Keep these tests small, isolated, and stable. Add a new journey only when it
protects a distinct user outcome. Run the full unit and browser suites before
accepting a repaired PR; the example command is `npm run verify:final`.

## 2. Decide when ticket-specific QA is useful

Run the QA writer for changes to critical journeys, authorization, data
integrity, important UI states, or integration boundaries. For a low-risk
change, run the fixed suite and ordinary code review without generating a new
browser scenario. Record the reason for the choice in the ticket or PR.

The ticket must state observable acceptance criteria such as `AC-1`, `AC-2`.
Resolve ambiguous criteria before the agent writes tests.

## 3. Establish and review the RED baseline

Adapt the real application's `test:affected`, `test:e2e`, and `test:summary`
scripts as described in the README. The QA writer must work from the ticket
before seeing the implementation. Then run:

```bash
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services
```

The launcher checks for an individual failing MFE assertion for every
criterion and prepares `reports/TICKET-42-review-request.json`. It includes
the criterion, failing test name, error excerpt, and hashes of the test files.
Inspect the full test source and report. Confirm each failure comes from the
missing user behavior. A missing module, broken selector, server failure, or
test setup error is not an accepted RED baseline.

Copy `reports/TICKET-42-review-decision.template.json` to
`reports/TICKET-42-review-decision.json`. Fill in `reviewer` and one substantive
`red_reasons` explanation per criterion, then run:

```bash
node qa/scenario-review.mjs approve TICKET-42 specs/TICKET-42.md
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
from `qa/summary.mjs` to the repair agent, inspect a full trace only when
needed, and rerun the affected test. After a pass, run the full suite and fixed
smoke journey. If all attempts fail, reassess the spec and tests with a human
and establish a new RED baseline.

The example CI demonstrates the fixed smoke journey, the expected RED → Green
→ Regression cycle, and a final full-suite run. It does not connect to Jira or
a real application shell.
