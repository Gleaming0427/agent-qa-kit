import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../criteria-manifest.mjs';
import { validateEvidence } from '../../.claude/hooks/strict-evidence.mjs';

const specText = '# TICKET-42\n- AC-1: list servers\n- AC-2: filter servers\n- AC-3: empty state\n';
const manifest = buildManifest('TICKET-42', specText);
function verdict(status = 'pass', ids = ['AC-1', 'AC-2', 'AC-3']) {
  return {
    ticket: 'TICKET-42', phase: 2, verdict: status,
    criteria: ids.flatMap((id) => ['mfe', 'shell'].map((level) => ({ id, level, status: 'pass', evidence: `${id} test` }))),
    flaky_tests: [], spec_questions: [], alerts: [],
  };
}
function reports({ bug = false, skipped = false } = {}) {
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
function validate(v, r = reports(), phase = 2, root) {
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
  const r = reports(); r.playwright.suites[0].specs[1].tests[0].results = [];
  assert(validate(verdict(), r).problems.some((p) => p.includes('AC-2 shell')));
});
test('rejects mismatched ticket spec hash', () => {
  const r = validateEvidence({ verdict: verdict(), manifest, phase: 2, ...reports(), specText: `${specText}changed` });
  assert(r.problems.some((p) => p.includes('spec changed')));
});
test('phase 1 requires an individual failing test and a shell scenario for each criterion', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-strict-'));
  try {
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e/TICKET-42.spec.ts'), '[TICKET-42][AC-1]\n[TICKET-42][AC-2]\n[TICKET-42][AC-3]\n');
    const v = verdict('ready'); v.phase = 1;
    v.criteria.forEach((c) => { c.status = 'written'; });
    const r = reports({ bug: true });
    let result = validate(v, r, 1, root);
    assert(result.problems.some((p) => p.includes('AC-1 MFE must have a failing')));
    r.vitest.testResults[0].assertionResults.forEach((a) => { a.status = 'failed'; });
    assert.deepEqual(validate(v, r, 1, root).problems, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
