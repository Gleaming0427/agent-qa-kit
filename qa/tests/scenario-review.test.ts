import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildManifest } from '../criteria-manifest.ts';
import { approveReview, prepareReview, reserveVerifyAttempt, verifyReview } from '../scenario-review.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qa-scenario-review-'));
  mkdirSync(join(root, 'reports'));
  mkdirSync(join(root, 'e2e'));
  mkdirSync(join(root, 'src'));
  const specPath = join(root, 'TICKET-42.md');
  const spec = '- AC-1: search matches a service regardless of case\n';
  writeFileSync(specPath, spec);
  writeFileSync(join(root, 'reports/TICKET-42-criteria.json'), JSON.stringify(buildManifest('TICKET-42', spec)));
  writeFileSync(join(root, 'reports/TICKET-42-phase1.json'), JSON.stringify({
    ticket: 'TICKET-42', phase: 1, verdict: 'ready',
    criteria: ['mfe', 'shell'].map((level) => ({ id: 'AC-1', level, status: 'written', evidence: 'test' })),
  }));
  writeFileSync(join(root, 'e2e/TICKET-42.spec.ts'), "test('[TICKET-42][AC-1] shell search', () => {});\n");
  const testFile = join(root, 'src/Search.test.tsx');
  writeFileSync(testFile, "test('[TICKET-42][AC-1] MFE search', () => {});\n");
  const report = {
    numFailedTests: 1, numPassedTests: 0,
    testResults: [{ name: testFile, assertionResults: [{
      fullName: '[TICKET-42][AC-1] MFE search', status: 'failed',
      failureMessages: ['Unable to find Alpha after typing ALPHA'],
    }] }],
  };
  writeFileSync(join(root, 'reports/vitest.json'), JSON.stringify(report));
  const e2eReport = {
    stats: { expected: 0, unexpected: 1, flaky: 0 },
    suites: [{ title: 'TICKET-42.spec.ts', file: 'TICKET-42.spec.ts', specs: [{
      title: '[TICKET-42][AC-1] shell search', file: 'TICKET-42.spec.ts',
      tests: [{ status: 'unexpected', results: [{ status: 'failed', error: {
        message: 'Error: \u001b[2mexpect(\u001b[22mlocator).toHaveCount(expected) failed\nExpected: 1\nReceived: 0',
      } }] }],
    }] }],
  };
  writeFileSync(join(root, 'reports/playwright.json'), JSON.stringify(e2eReport));
  return { root, specPath, testFile, report, e2eReport };
}

test('review requires a reason and rejects changed tests', () => {
  const f = fixture();
  try {
    const args = { root: f.root, ticket: 'TICKET-42', specPath: f.specPath };
    const request = prepareReview(args);
    assert.equal(request.tests.length, 2);
    assert.deepEqual(request.criteria[0].failures, [
      { level: 'mfe', title: '[TICKET-42][AC-1] MFE search', message: 'Unable to find Alpha after typing ALPHA' },
      { level: 'shell', title: 'TICKET-42.spec.ts [TICKET-42][AC-1] shell search', message: 'Error: expect(locator).toHaveCount(expected) failed Expected: 1 Received: 0' },
    ]);
    const decisionFile = join(f.root, 'reports/TICKET-42-review-decision.json');
    writeFileSync(decisionFile, JSON.stringify({ reviewer: 'Reviewer', red_reasons: { 'AC-1': '' } }));
    assert.throws(() => approveReview(args), /explain why this RED failure/);
    writeFileSync(decisionFile, JSON.stringify({ reviewer: 'Reviewer', red_reasons: {
      'AC-1': 'The expected Alpha service is missing when searching ALPHA.',
    } }));
    approveReview(args);
    assert.equal(verifyReview(args).reviewer, 'Reviewer');
    assert.equal(reserveVerifyAttempt({ ...args, maxAttempts: 2 }), 1);
    assert.equal(reserveVerifyAttempt({ ...args, maxAttempts: 2 }), 2);
    assert.throws(() => reserveVerifyAttempt({ ...args, maxAttempts: 2 }), /2 verification attempts used/);
    writeFileSync(f.testFile, `${readFileSync(f.testFile, 'utf8')}// changed\n`);
    assert.throws(() => verifyReview(args), /Reviewed test changed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('review refuses an unexplained RED test failure', () => {
  const f = fixture();
  try {
    f.report.testResults[0].assertionResults[0].failureMessages = [];
    writeFileSync(join(f.root, 'reports/vitest.json'), JSON.stringify(f.report));
    assert.throws(() => prepareReview({ root: f.root, ticket: 'TICKET-42', specPath: f.specPath }), /no diagnostic message/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('review refuses a browser scenario that did not fail on an assertion', () => {
  const f = fixture();
  try {
    f.e2eReport.suites[0].specs[0].tests[0].results[0] = { status: 'timedOut', error: { message: 'Test timeout of 30000ms exceeded.' } };
    writeFileSync(join(f.root, 'reports/playwright.json'), JSON.stringify(f.e2eReport));
    assert.throws(() => prepareReview({ root: f.root, ticket: 'TICKET-42', specPath: f.specPath }), /AC-1 shell .*got timedOut/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('review needs the browser report before it starts', () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'reports/playwright.json'));
    assert.throws(() => prepareReview({ root: f.root, ticket: 'TICKET-42', specPath: f.specPath }), /playwright\.json missing/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('review refuses a test path redirected to a secret file', () => {
  const f = fixture();
  try {
    const secret = join(f.root, '.env');
    writeFileSync(secret, 'hidden');
    rmSync(f.testFile);
    symlinkSync(secret, f.testFile);
    assert.throws(() => prepareReview({ root: f.root, ticket: 'TICKET-42', specPath: f.specPath }), /resolves outside a test source/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
