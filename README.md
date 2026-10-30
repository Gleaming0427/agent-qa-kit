# Agent QA Kit

**Two-stage QA for React micro-frontends, with independently checked acceptance criteria.**

`qa-writer` creates component tests and integrated-shell Playwright scenarios
from a ticket. `qa-verifier` runs those tests **without Write/Edit tools**.
A deterministic validator rejects a success verdict if an expected criterion
is missing, an assertion was not executed, a test was skipped, or actual test
results contradict the verdict.
The example also runs a fixed browser smoke journey on every PR.

> **Status: experimental.** Includes a working-source React example and an
> executable Red → Green → Regression test workflow. It is not production-ready
> security isolation, nor proof that every generated assertion is meaningful.

## What makes this different?

```text
                 Jira / specification
                         │
             Extract immutable AC manifest
                         │
             ┌───────────▼───────────┐
             │  QA writer (Sonnet)   │
             │  MFE + shell tests    │
             └───────────┬───────────┘
                         │
                 RED tests expected
                         │
             Human reviews tests + RED cause
                         │
                Development agent
                         │
             ┌───────────▼───────────┐
             │ QA verifier (Haiku)   │
             │ No direct write tools │
             └───────────┬───────────┘
                         │
             Vitest + Playwright + fixed smoke
                         │
             ┌───────────▼───────────┐
             │ Deterministic check   │
             │ AC IDs ↔ test results │
             └───────────┬───────────┘
                         │
                  CI + human PR review
```

The *acceptance criteria manifest* is generated from the spec **before** an
agent starts, not from the agent's own answer. The verdict checker requires
actual named assertions for each criterion and for both test levels.

### Files

| File | Purpose |
|---|---|
| `.claude/agents/qa-writer.md` | Phase 1: author tests, establish failing baseline |
| `.claude/agents/qa-verifier.md` | Phase 2: run tests and report findings |
| `.claude/hooks/qa-guard.sh` | Block out-of-scope tool uses and commands |
| `.claude/hooks/verdict-check.mjs` | Claude Code stop-hook + final launcher check |
| `.claude/hooks/strict-evidence.mjs` | Independent per-criterion report comparison |
| `qa/criteria-manifest.mjs` | Generate authoritative criterion IDs + spec hash |
| `qa/coverage-report.mjs` | Report execution evidence by criterion |
| `qa/check-tests.mjs` | Scan edited test files for disabled/focused cases |
| `qa/scenario-review.mjs` | Prepare and verify human review of generated tests and RED failures |
| `qa/run-qa.sh` | Orchestrate CLI agent phases and deterministic validation |
| `qa/test-guard.sh`, `qa/test-verdict-check.sh` | Existing guard/validator regression matrices |
| `qa/tests/` | Node's built-in strict-evidence and hook-integration tests |
| `examples/server-console/` | Small React + TypeScript + Vitest + Playwright demonstration |
| `.github/workflows/qa-guard.yml` | Deterministic checks and React demonstration in CI |

## Quick start: validators without Claude or API costs

Requirements: Node.js 22+, bash, `jq`.

```bash
bash qa/test-guard.sh
bash qa/test-verdict-check.sh
node --test qa/tests/*.test.mjs
node qa/criteria-manifest.mjs TICKET-42 specs/TICKET-42.md reports/TICKET-42-criteria.json
```

This checks tool restrictions, verdict rejection behavior, missing criteria,
empty test reports, skipped tests and mismatched evidence — without a model.

## Live React demonstration

The example contains a simple list of services with case-insensitive search
and an empty-state message. Its acceptance criteria are the existing
`TICKET-42` example:

- `AC-1`: services are listed.
- `AC-2`: search is case insensitive.
- `AC-3`: empty search results display "No service found".

```bash
cd examples/server-console
npm ci
npx playwright install chromium
npm run build
npm run test:smoke
npm run demo:unit
npm run demo:e2e
npm run verify:final
```

Both `demo:*` commands run the same assertions through three stages:

| Stage | Code variant | Expected |
|---|---|---|
| Red | Deliberate case-sensitive bug | AC-2 fails |
| Green | Correct implementation | All three pass |
| Regression | Reintroduce the bug | AC-2 fails again |

The code variant is selected using `VITE_DEMO_BUG`; assertions are **not
edited** between stages. JSON reports are saved to the example's `reports/`
directory. This tests the same UI at the component level (Vitest / Testing
Library) and browser level (Playwright). **It is an isolated fake shell, not a real application or a multi-repo MFE integration.**

The smoke test follows a stable user journey: open services, search for one,
and see the empty state. CI runs it on every PR independently of a ticket.
The demo cycle checks that the RED and regression stages contain an actual
`AC-2` assertion failure with a diagnostic message; a crashed test runner does
not count as a successful RED stage. `verify:final` runs the complete green
unit and browser suites after the demonstration.

The example includes `package-lock.json`; CI uses `npm ci` for reproducible installs.

## Integrate into a real MFE project

Run a small fixed browser suite for the flows whose failure would have the
largest user impact on every PR. Invoke ticket-specific QA for changes to those
flows or other high-risk behavior; a low-risk change need not generate new E2E
tests. Keep the fixed suite stable and independent of individual Jira tickets.

Adapt the existing client's test scripts and Playwright configuration:

```json
{
  "scripts": {
    "test:affected": "vitest run --reporter=dot --reporter=json --outputFile.json=reports/vitest.json",
    "test:e2e": "playwright test",
    "test:summary": "node qa/summary.mjs"
  }
}
```

The validator expects JSON at `reports/vitest.json` and
`reports/playwright.json`, with individual test cases in each report.
Every test name must include `[TICKET-42][AC-1]` (adapt ticket and ID).
The Playwright scenarios for the ticket belong in `e2e/TICKET-42.spec.ts`.

Then run:

```bash
QA_DRY_RUN=1 qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services
qa/run-qa.sh TICKET-42 1 specs/TICKET-42.md services
# Review the generated tests and reports/TICKET-42-review-request.json.
# Copy reports/TICKET-42-review-decision.template.json to
# reports/TICKET-42-review-decision.json, then fill the reviewer and the
# reason each RED failure reflects missing behavior.
node qa/scenario-review.mjs approve TICKET-42 specs/TICKET-42.md
# Once implementation is delivered:
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services
```

Phase 1 prepares a review request with the acceptance criteria, test file
hashes, and the observed RED error for each criterion. Review the assertions
against the ticket and confirm the RED failure is the expected missing behavior,
not a selector, setup, or environment error. Phase 2 refuses to run until the
review decision is recorded; edits to the spec, tests, or RED report invalidate
that decision. The local reviewer name is self-declared, so use required human
PR reviews and branch protection when applying this gate in a team.

The launcher permits three phase-2 verifications per reviewed baseline: the
initial run and two attempts after repairs. On a failure, send the compact
`qa/summary.mjs` output to the repair agent, rerun the affected test, then run
the full suite before accepting the change. A new phase-1 baseline and review
are required after the attempt limit. The example's `npm run verify:final`
provides that full-suite command; adapt it to the real application.

Exit codes: `0` = ready/passed; `1` = failed; `2` = blocked;
`3` = technical failure or invalid verdict. Costs reported by Claude are
recorded per run in `reports/TICKET-42-phase2.json`.
`reports/TICKET-42-evidence-phase2.json` contains evidence for each criterion.

## Safety design and its limits

- **Tools:** verifier receives no direct file-writing tools. The guard rejects
  unknown tools, out-of-scope paths, snapshot updates and unsupported shell commands.
- **Isolation:** the CLI settings request an OS sandbox and no network, but
  availability and enforcement depend on Claude Code and the machine.
- **Independent criteria:** the manifest is derived from the spec before agent
  work. Every expected AC requires matching test results; stale summary-only
  reports are insufficient to claim `pass`.
- **Testing discipline:** the post-edit scan and CI catch disabled/focused tests;
  they do **not** semantically prove tests are good. A developer reviews assertions.
- **Review receipt:** the launcher checks that the reviewed spec, tests, and RED
  report have not changed. The receipt does not authenticate the reviewer or
  prove that their interpretation is correct.
- **Untrusted tests:** running agent-generated tests executes code. A malicious
  test can make changes through its runner. Use a disposable isolated test
  environment with no credentials; do not run generated tests in production.
- **Permissions:** hooks are defense in depth, not a substitute for strong OS
  isolation, branch protection and a human review of the PR.

## Costs and quality evaluation

The example agent defaults are Sonnet (writer, $1 cap) and Haiku (verifier,
$0.20 cap). These are **spending limits**, not predicted costs or savings.
Collect cost, duration, defect detection, false positives and flaky-test rate
on representative tickets before claiming improvements.

For initial adoption, compare the automated agent verdict with independent
human findings before making QA a mandatory merge gate. Start with a limited
set of well-specified, low-risk features.

## What has and hasn't been verified

- **Verified:** Node evidence/hook tests, guard and verdict tests, React build,
  Vitest RED → Green → Regression, and Playwright Chromium browser tests.
- **Still needed for production use:** a true application and shell integration,
  independent human review of generated scenarios, adversarial tests, and
  security review of the execution environment. The example does not contact
  Jira or run a Claude Code agent end to end in CI.

See [HOW_TO_APPLY.md](HOW_TO_APPLY.md) for installation instructions and
integration limitations.
