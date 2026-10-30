import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../criteria-manifest.ts';
import { validateEvidence } from '../../.claude/hooks/strict-evidence.ts';
import type { PlaywrightReport, Verdict, VitestReport } from '../../.claude/hooks/strict-evidence.ts';

const specText = '# TICKET-42\n- AC-1: list servers\n- AC-2: filter servers\n- AC-3: empty state\n';
const manifest = buildManifest('TICKET-42', specText);
function verdict(status = 'pass', ids = ['AC-1', 'AC-2', 'AC-3']): Verdict {
  return {
    ticket: 'TICKET-42', phase: 2, verdict: status,
    criteria: ids.flatMap((id) => (['mfe', 'shell'] as const).map((level) => ({ id, level, status: 'pass', evidence: `${id} test` }))),
    flaky_tests: [], spec_questions: [], alerts: [],
  };
}
function reports({ bug = false, skipped = false } = {}): { vitest: VitestReport; playwright: PlaywrightReport } {
  return {
    vitest: {
      numFailedTests: bug ? 1 : 0,
      numPassedTests: bug ? 2 : 3,
      testResults: [{ name: '/apps/servers/ServerList.test.tsx', assertionResults: ['AC-1','AC-2','AC-3'].map((id) => ({
        fullName: `[TICKET-42][${id}] MFE test`,
        status: (bug && id === 'AC-2') ? 'failed' : skipped && id === 'AC-3' ? 'pending' : 'passed',
      })) }],
    },
    playwright: {
      stats: { expected: 3, unexpected: 0, flaky: 0 },
      suites: [{ file: 'e2e/TICKET-42.spec.ts', title: '', specs: ['AC-1','AC-2','AC-3'].map((id) => ({
        title: `[TICKET-42][${id}] shell test`,
        tests: [{ status: 'expected', results: [{ status: 'passed' }] }],
      })) }],
    },
  };
}
function validate(v: Verdict, r = reports(), phase = 2, root?: string) {
  return validateEvidence({ verdict: v, manifest, phase, ...r, specText, root });
}
test('extracts the authoritative criteria and rejects duplicates', () => {
  assert.deepEqual(manifest.criteria.map((x) => x.id), ['AC-1', 'AC-2', 'AC-3']);
  assert.throws(() => buildManifest('TICKET-42', '- AC-1: a\n- AC-1: b'), /Duplicate/);
  assert.throws(() => buildManifest('TICKET-42', '# no criteria'), /No AC-N/);
});
test('rejects omitted criterion even if every declared test passes', () => {
  const r = validate(verdict('pass', ['AC-1']), reports());
  assert(r.problems.some((p) => p.includes('Missing criterion AC-2')));
});
test('rejects duplicate / invented criterion', () => {
  const v = verdict(); v.criteria.push(v.criteria[0]);
  assert(validate(v).problems.some((p) => p.includes('Duplicate verdict entry')));
  v.criteria.push({ id: 'AC-99', level: 'mfe', status: 'pass', evidence: 'x' });
  assert(validate(v).problems.some((p) => p.includes('Unknown criterion')));
});
test('accepts one genuine passing test for every acceptance criterion at both levels', () => {
  assert.deepEqual(validate(verdict()).problems, []);
});
test('rejects a summary-only 0-fail report (no real tests)', () => {
  const r = reports(); r.vitest.testResults = [];
  assert(validate(verdict(), r).problems.some((p) => p.includes('no individual executed tests')));
});
test('rejects reports with a skipped test', () => {
  const r = reports({ skipped: true });
  assert(validate(verdict(), r).problems.some((p) => p.includes('AC-3 mfe')));
});
test('rejects fake pass where a corresponding actual assertion failed', () => {
  const r = reports({ bug: true });
  assert(validate(verdict(), r).problems.some((p) => p.includes('AC-2 mfe')));
});
test('rejects E2E test without actual execution results', () => {
  const r = reports(); r.playwright.suites![0].specs![1].tests![0].results = [];
  assert(validate(verdict(), r).problems.some((p) => p.includes('AC-2 shell')));
});
test('rejects mismatched ticket spec hash', () => {
  const r = validateEvidence({ verdict: verdict(), manifest, phase: 2, ...reports(), specText: `${specText}changed` });
  assert(r.problems.some((p) => p.includes('spec changed')));
});
// What Playwright reports when an expect() fails: the message carries ANSI colors.
const ASSERTION_FAILURE = 'Error: \u001b[2mexpect(\u001b[22mlocator).toHaveCount(expected) failed\nExpected: 1\nReceived: 3';
function redPhase1(root: string) {
  mkdirSync(join(root, 'e2e'));
  writeFileSync(join(root, 'e2e/TICKET-42.spec.ts'), '[TICKET-42][AC-1]\n[TICKET-42][AC-2]\n[TICKET-42][AC-3]\n');
  const v = verdict('ready'); v.phase = 1;
  v.criteria.forEach((c) => { c.status = 'written'; });
  const r = reports({ bug: true });
  r.vitest.testResults![0].assertionResults!.forEach((a) => { a.status = 'failed'; });
  r.playwright.stats = { expected: 0, unexpected: 3, flaky: 0 };
  const scenarios = r.playwright.suites![0].specs!;
  for (const spec of scenarios) spec.tests = [{ status: 'unexpected', results: [{ status: 'failed', error: { message: ASSERTION_FAILURE } }] }];
  return { v, r, scenarios };
}
function inTempDir(body: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'qa-strict-'));
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
test('phase 1 accepts unit and browser tests that all fail on an assertion', () => inTempDir((root) => {
  const { v, r } = redPhase1(root);
  assert.deepEqual(validate(v, r, 1, root).problems, []);
}));
test('phase 1 requires a failing MFE test for each criterion', () => inTempDir((root) => {
  const { v, r } = redPhase1(root);
  r.vitest.testResults![0].assertionResults![0].status = 'passed';
  assert(validate(v, r, 1, root).problems.some((p) => p.includes('AC-1 MFE must have a failing')));
}));
test('phase 1 rejects a browser scenario that already passes', () => inTempDir((root) => {
  const { v, r, scenarios } = redPhase1(root);
  scenarios[1].tests = [{ status: 'expected', results: [{ status: 'passed' }] }];
  assert(validate(v, r, 1, root).problems.some((p) => p.startsWith('AC-2 shell') && p.includes('got passed')));
}));
test('phase 1 rejects browser scenarios that were never run', () => inTempDir((root) => {
  const { v, r } = redPhase1(root);
  const problems = validate(v, { ...r, playwright: undefined as never }, 1, root).problems;
  assert(problems.some((p) => p.includes('Playwright JSON report missing')));
  assert(problems.some((p) => p.includes('AC-3 shell must have a failing')));
}));
test('phase 1 rejects a browser failure caused by the environment', () => inTempDir((root) => {
  const { v, r, scenarios } = redPhase1(root);
  scenarios[0].tests![0].results![0].error = { message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4173/' };
  assert(validate(v, r, 1, root).problems.some((p) => p.startsWith('AC-1 shell') && p.includes('test environment')));
}));
test('phase 1 rejects a browser timeout or a failure outside expect()', () => inTempDir((root) => {
  const { v, r, scenarios } = redPhase1(root);
  scenarios[0].tests = [{ status: 'unexpected', results: [{ status: 'timedOut', error: { message: 'Test timeout of 30000ms exceeded.' } }] }];
  scenarios[1].tests![0].results![0].error = { message: "TypeError: Cannot read properties of undefined (reading 'name')" };
  const problems = validate(v, r, 1, root).problems;
  assert(problems.some((p) => p.startsWith('AC-1 shell') && p.includes('got timedOut')));
  assert(problems.some((p) => p.startsWith('AC-2 shell') && p.includes('outside an expect() assertion')));
}));
test('phase 1 rejects a browser run whose application never started', () => inTempDir((root) => {
  const { v, r } = redPhase1(root);
  r.playwright = { stats: { expected: 0, unexpected: 0, flaky: 0 }, suites: [], errors: [{ message: 'Error: http://127.0.0.1:4173 is already used' }] };
  assert(validate(v, r, 1, root).problems.some((p) => p.includes('Playwright could not run')));
}));
