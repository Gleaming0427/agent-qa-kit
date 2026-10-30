# Agent QA Kit

**Two-stage QA for React micro-frontends, with independently checked acceptance criteria.**

`qa-writer` creates component tests and integrated-shell Playwright scenarios
from a ticket. `qa-verifier` runs those tests **without Write/Edit tools**.
A deterministic validator rejects a success verdict if an expected criterion
is missing, an assertion was not executed, a test was skipped, or actual test
results contradict the verdict.

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
                Development agent
                         │
             ┌───────────▼───────────┐
             │ QA verifier (Haiku)   │
             │ No direct write tools │
             └───────────┬───────────┘
                         │
                 Vitest + Playwright
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
npm install
npx playwright install chromium
npm run build
npm run demo:unit
npm run demo:e2e
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

The current ZIP doesn't include an npm lockfile: generate and commit
`examples/server-console/package-lock.json` on your development machine,
then switch the CI install to `npm ci` to ensure dependency reproducibility.

## Integrate into a real MFE project

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
# Once implementation is delivered:
qa/run-qa.sh TICKET-42 2 specs/TICKET-42.md services
```

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

- **Verified locally for this upgrade:** JavaScript syntax; Bash syntax;
  built-in Node strict-evidence/hook tests; legacy guard and verdict tests;
  basic demonstration search behavior with Node TypeScript stripping.
- **Not run in the upgrade creation environment:** npm dependency install,
  actual React rendering, Playwright Chromium tests, or an end-to-end Claude
  Code run (network and Claude CLI unavailable in that environment).
- **Pending before claiming production readiness:** lockfile, GitHub Actions
  green on the target commit, a true real-MFE shell integration, adversarial
  tests and security review.

See [HOW_TO_APPLY.md](HOW_TO_APPLY.md) for installation instructions and
integration limitations.
