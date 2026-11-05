import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildManifest } from '../criteria-manifest.ts';
import {
  amendReview, approveFromReview, approveReview, exportReview, importReview, prepareReview, readAmendments, reserveVerifyAttempt,
  reviewMarkdown, verifyReview,
} from '../scenario-review.ts';

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

test('a review package moves to another checkout and is approved from a pull request review', () => {
  const f = fixture();
  const ci = mkdtempSync(join(tmpdir(), 'qa-scenario-ci-'));
  try {
    const args = { root: f.root, ticket: 'TICKET-42', specPath: f.specPath };
    prepareReview(args);
    const red = JSON.parse(readFileSync(join(f.root, 'reports/TICKET-42-red-vitest.json'), 'utf8'));
    assert.equal(red.testResults[0].name, 'src/Search.test.tsx');
    exportReview({ ...args, mfe: 'services' });
    // CI checks out the committed files at another path, without the reports folder.
    for (const path of ['TICKET-42.md', 'e2e', 'src', 'qa-reviews']) cpSync(join(f.root, path), join(ci, path), { recursive: true });
    const context = importReview({ root: ci, ticket: 'TICKET-42' });
    assert.deepEqual(context, { ticket: 'TICKET-42', mfe: 'services', spec: 'TICKET-42.md' });
    assert.match(reviewMarkdown({ root: ci, ticket: 'TICKET-42' }),
      /### AC-1: search matches a service regardless of case[\s\S]*Unable to find Alpha[\s\S]*AC-1: why this failure/);
    const ciArgs = { root: ci, ticket: 'TICKET-42', specPath: join(ci, context.spec), reviewer: '@alice' };
    assert.throws(() => approveFromReview({ ...ciArgs, text: 'LGTM' }), /AC-1: explain why/);
    approveFromReview({ ...ciArgs, text: 'Good tests.\n\n- **AC-1**: Alpha is missing when the search is in capitals.' });
    const approval = verifyReview({ root: ci, ticket: 'TICKET-42', specPath: ciArgs.specPath });
    assert.equal(approval.reviewer, '@alice');
    assert.equal(approval.red_reasons['AC-1'], 'Alpha is missing when the search is in capitals.');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(ci, { recursive: true, force: true });
  }
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

test('a wrong approved test is amended with a logged reason, checked RED again, and approved again', () => {
  const f = fixture();
  const ci = mkdtempSync(join(tmpdir(), 'qa-scenario-amend-'));
  try {
    const args = { root: f.root, ticket: 'TICKET-42', specPath: f.specPath };
    prepareReview(args);
    approveFromReview({ ...args, reviewer: '@alice', text: 'AC-1: Alpha is missing when the search is in capitals.' });
    const amend = (reason = 'The expected count was 2; the ticket lists one Alpha service.') => amendReview({ ...args, author: '@bob', reason });
    assert.throws(() => amend(), /No reviewed test changed/);

    // A person fixes the unit test, keeps its title, and runs the ticket's tests again: still RED.
    writeFileSync(f.testFile, "test('[TICKET-42][AC-1] MFE search', () => { /* expects 1 */ });\n");
    f.report.testResults[0].assertionResults[0].failureMessages = ['Expected 1 Alpha service, found 0'];
    writeFileSync(join(f.root, 'reports/vitest.json'), JSON.stringify(f.report));
    assert.throws(() => amend('wrong'), /20 characters or more/);
    const amendment = amend();
    assert.equal(amendment.author, '@bob');
    assert.deepEqual(amendment.files.map((x) => x.path), ['src/Search.test.tsx']);
    assert.notEqual(amendment.files[0].before, amendment.files[0].after);
    // The approval of the old tests no longer counts: the amended ones need a new one.
    assert.throws(() => verifyReview(args), /ENOENT|approved/);
    const markdown = reviewMarkdown({ root: f.root, ticket: 'TICKET-42' });
    assert.match(markdown, /^## Amended QA tests for TICKET-42/);
    assert.match(markdown, /### Amendments[\s\S]*by @bob: The expected count was 2[\s\S]*Changed: `src\/Search\.test\.tsx`/);
    assert.match(markdown, /Expected 1 Alpha service, found 0/);

    // The log travels with the package, and CI approves the amended tests from a review.
    exportReview({ ...args, mfe: 'services' });
    for (const path of ['TICKET-42.md', 'e2e', 'src', 'qa-reviews']) cpSync(join(f.root, path), join(ci, path), { recursive: true });
    const context = importReview({ root: ci, ticket: 'TICKET-42' });
    assert.equal(readAmendments(ci, 'TICKET-42').length, 1);
    const ciArgs = { root: ci, ticket: 'TICKET-42', specPath: join(ci, context.spec) };
    approveFromReview({ ...ciArgs, reviewer: '@carol', text: 'AC-1: no Alpha service is listed yet, so the count is 0.' });
    assert.equal(verifyReview(ciArgs).reviewer, '@carol');
    // A review request changed after the logged amendment is refused.
    const request = join(ci, 'reports/TICKET-42-review-request.json');
    writeFileSync(request, readFileSync(request, 'utf8').replace('Expected 1 Alpha', 'Expected 2 Alpha'));
    assert.throws(() => verifyReview(ciArgs), /RED failure review request changed|amendment log/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(ci, { recursive: true, force: true });
  }
});

test('an amendment keeps the same test files, and an amended test must still fail for the right reason', () => {
  const f = fixture();
  try {
    const args = { root: f.root, ticket: 'TICKET-42', specPath: f.specPath };
    prepareReview(args);
    approveFromReview({ ...args, reviewer: '@alice', text: 'AC-1: Alpha is missing when the search is in capitals.' });
    const before = readFileSync(join(f.root, 'reports/TICKET-42-review-request.json'), 'utf8');
    const reason = 'The approved test expected the wrong service name.';
    writeFileSync(f.testFile, "test('[TICKET-42][AC-1] MFE search', () => { /* fixed */ });\n");
    // Passing on the application without the feature: no RED evidence, refused, and nothing changed.
    f.report.testResults[0].assertionResults[0].status = 'passed';
    writeFileSync(join(f.root, 'reports/vitest.json'), JSON.stringify(f.report));
    assert.throws(() => amendReview({ ...args, author: '@bob', reason }), /must have a failing \[TICKET-42\]\[AC-1\] test before implementation/);
    assert.equal(readFileSync(join(f.root, 'reports/TICKET-42-review-request.json'), 'utf8'), before);
    assert.ok(existsSync(join(f.root, 'reports/TICKET-42-approved.json')), 'the earlier approval is kept');
    assert.deepEqual(readAmendments(f.root, 'TICKET-42'), []);
    // The edited test is neither approved nor amended: verification still refuses it.
    assert.throws(() => verifyReview(args), /Reviewed test changed/);
    // A new failing test file is a new test, not an amendment.
    f.report.testResults[0].assertionResults[0].status = 'failed';
    const extra = join(f.root, 'src/Extra.test.tsx');
    writeFileSync(extra, "test('[TICKET-42][AC-1] MFE extra', () => {});\n");
    f.report.testResults.push({ name: extra, assertionResults: [{ fullName: '[TICKET-42][AC-1] MFE extra', status: 'failed', failureMessages: ['Expected Alpha'] }] });
    writeFileSync(join(f.root, 'reports/vitest.json'), JSON.stringify(f.report));
    assert.throws(() => amendReview({ ...args, author: '@bob', reason }), /needs a new QA writing cycle/);
    assert.equal(readFileSync(join(f.root, 'reports/TICKET-42-review-request.json'), 'utf8'), before);
    // A reviewed test file that is gone cannot be amended away.
    rmSync(extra); rmSync(f.testFile);
    assert.throws(() => amendReview({ ...args, author: '@bob', reason }), /was reviewed and is gone/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
