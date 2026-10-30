import assert from 'node:assert/strict';
import test from 'node:test';
import { buildManifest } from '../criteria-manifest.ts';
import { checkFullSuite } from '../full-suite.ts';
import type { PlaywrightReport, PlaywrightSpec, Verdict, VitestReport } from '../../.claude/hooks/strict-evidence.ts';

const manifest = buildManifest('TICKET-42', '- AC-1: list services\n');
const verdict: Verdict = {
  ticket: 'TICKET-42', phase: 2, verdict: 'pass',
  criteria: (['mfe', 'shell'] as const).map((level) => ({ id: 'AC-1', level, status: 'pass', evidence: 'test' })),
  flaky_tests: [], spec_questions: [], alerts: [],
};
const passed = (title: string, tags: string[] = []): PlaywrightSpec => ({ title, tags, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] });
function suite(): { vitest: VitestReport; playwright: PlaywrightReport } {
  return {
    vitest: {
      numPassedTests: 2, numFailedTests: 0,
      testResults: [{ name: '/app/src/App.test.tsx', assertionResults: [
        { fullName: '[TICKET-42][AC-1] lists services', status: 'passed' },
        { fullName: 'an older feature still works', status: 'passed' },
      ] }],
    },
    playwright: {
      stats: { expected: 2, unexpected: 0, flaky: 0 },
      suites: [
        { title: 'TICKET-42.spec.ts', file: 'TICKET-42.spec.ts', specs: [passed('[TICKET-42][AC-1] shell lists services')] },
        { title: 'smoke.spec.ts', file: 'smoke.spec.ts', specs: [passed('@smoke a user can find a service', ['smoke'])] },
      ],
    },
  };
}
const check = (s = suite()) => checkFullSuite({ manifest, verdict, ...s });

test('full suite passes when every test passes, smoke journey included', () => {
  assert.deepEqual(check(), []);
});
test('full suite fails on a regression outside the ticket', () => {
  const s = suite();
  s.vitest.testResults![0].assertionResults![1].status = 'failed';
  s.vitest.numFailedTests = 1;
  assert(check(s).includes('Unit test failed: an older feature still works'));
});
test('full suite fails on a failing or flaky browser test', () => {
  const s = suite();
  s.playwright.suites![1].specs![0].tests![0].status = 'unexpected';
  s.playwright.suites![0].specs![0].tests![0].status = 'flaky';
  const problems = check(s);
  assert(problems.includes('Browser test failed: smoke.spec.ts @smoke a user can find a service'));
  assert(problems.includes('Browser test is flaky: TICKET-42.spec.ts [TICKET-42][AC-1] shell lists services'));
});
test('full suite requires a passing @smoke journey', () => {
  const s = suite();
  s.playwright.suites![1].specs![0].tests![0].status = 'skipped';
  assert(check(s).includes('No @smoke journey passed.'));
  s.playwright.suites!.pop();
  assert(check(s).some((p) => p.startsWith('No @smoke journey ran')));
});
test('full suite requires the ticket tests to pass again', () => {
  const s = suite();
  s.playwright.suites!.shift();
  assert(check(s).some((p) => p.includes('AC-1 shell')));
});
test('full suite fails when the browser suite could not start', () => {
  const s = suite();
  s.playwright = { stats: { expected: 0, unexpected: 0, flaky: 0 }, suites: [], errors: [{ message: 'Error: http://127.0.0.1:4173 is already used' }] };
  const problems = check(s);
  assert(problems.includes('Browser suite error: Error: http://127.0.0.1:4173 is already used'));
  assert(problems.includes('The full browser suite ran no tests.'));
});
