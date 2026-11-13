import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// npm run test:summary -- --run @<mfe>: one command for a test cycle, with a stand-in for npm whose
// test runs write the reports, or fail to.
const SUMMARY = resolve(import.meta.dirname, '../summary.ts');
const vitest = JSON.stringify({ numPassedTests: 1, numFailedTests: 1, testResults: [{ assertionResults: [
  { fullName: '[SHOP-2][AC-1] MFE heading counts each line quantity', status: 'failed',
    failureMessages: ['Unable to find an accessible element with the role "heading" and name "Cart (3)"'] },
] }] });
const playwright = JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{ title: 'SHOP-2.spec.ts', specs: [{
  title: '[SHOP-2][AC-1] shell heading counts each line quantity',
  tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: "Locator: getByRole('heading', { name: 'Cart (3)' })" } }] }],
}] }] });

const vitestPassing = JSON.stringify({ numPassedTests: 2, numFailedTests: 0, testResults: [] });

function app(e2e: 'report' | 'crash', unit: 'fail' | 'pass' | 'crash' = 'fail') {
  const dir = mkdtempSync(join(tmpdir(), 'qa-summary-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'reports'));
  writeFileSync(join(dir, 'vitest.json'), unit === 'pass' ? vitestPassing : vitest);
  writeFileSync(join(dir, 'playwright.json'), playwright);
  // Reports from an earlier run, which --run must not show as this one's.
  writeFileSync(join(dir, 'reports/vitest.json'), '{"numPassedTests":9,"numFailedTests":0,"testResults":[]}');
  writeFileSync(join(dir, 'reports/playwright.json'), '{"stats":{"expected":9,"unexpected":0,"flaky":0},"suites":[]}');
  writeFileSync(join(dir, 'bin/npm'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
echo "lots of test output"
case "$*" in
  'run test:affected') ${unit === 'crash' ? 'echo "vitest crashed" >&2; exit 1' : `cp "${dir}/vitest.json" reports/vitest.json; exit ${unit === 'pass' ? 0 : 1}`} ;;
  'run test:e2e -- --grep @shop')
    ${e2e === 'report' ? `cp "${dir}/playwright.json" reports/playwright.json; exit 1` : `echo 'Error: browserType.launch: Executable does not exist' >&2; exit 1`} ;;
  *) echo "unexpected npm call: $*" >&2; exit 9 ;;
esac
`);
  chmodSync(join(dir, 'bin/npm'), 0o755);
  return dir;
}

function summary(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [SUMMARY, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  return { code: result.status, out: result.stdout + result.stderr, calls };
}

test('--run @<mfe> runs the unit tests, then the browser tests, and prints only the summary of both', () => {
  const dir = app('report');
  try {
    const r = summary(dir, '--run', '@shop');
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls, 'run test:affected\nrun test:e2e -- --grep @shop\n');
    assert.match(r.out, /^MFE level \(Vitest\): 1 passed, 1 failed\n {2}✗ \[SHOP-2\]\[AC-1\] MFE heading/);
    assert.match(r.out, /Shell level \(Playwright\): 0 passed, 1 failed, 0 flaky\n {2}✗ SHOP-2\.spec\.ts › \[SHOP-2\]\[AC-1\]/);
    assert.doesNotMatch(r.out, /lots of test output|9 passed/, 'neither the raw output nor the earlier reports');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--run says which command wrote no report, with the end of its output', () => {
  const dir = app('crash');
  try {
    const r = summary(dir, '--run', '@shop');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^npm run test:e2e -- --grep @shop wrote no reports\/playwright\.json \(exit code 1\)\. Its last lines:\n {2}lots of test output\n {2}Error: browserType\.launch: Executable does not exist\n/);
    assert.match(r.out, /MFE level \(Vitest\): 1 passed, 1 failed/);
    assert.doesNotMatch(r.out, /Shell level/, 'no summary from the earlier browser report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--stop-on-unit-failure runs the browser tests only after unit tests with no failure', () => {
  for (const unit of ['fail', 'crash'] as const) {
    const dir = app('report', unit);
    try {
      const r = summary(dir, '--run', '@shop', '--stop-on-unit-failure');
      assert.equal(r.calls, 'run test:affected\n', `${unit}: the browser tests do not run`);
      assert.match(r.out, new RegExp(`Browser tests not run: the unit tests ${unit === 'fail' ? 'failed' : 'wrote no report'}\\. Report the shell level as not_run\\.`));
      assert.doesNotMatch(r.out, /Shell level/, `${unit}: no browser summary`);
      assert.equal(existsSync(join(dir, 'reports/playwright.json')), false, `${unit}: the earlier browser report is removed, so not_run can be checked`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const dir = app('report', 'pass');
  try {
    const r = summary(dir, '--run', '@shop', '--stop-on-unit-failure');
    assert.equal(r.code, 0, r.out);
    assert.equal(r.calls, 'run test:affected\nrun test:e2e -- --grep @shop\n');
    assert.match(r.out, /MFE level \(Vitest\): 2 passed, 0 failed/);
    assert.match(r.out, /Shell level \(Playwright\): 0 passed, 1 failed/);
    assert.doesNotMatch(r.out, /not run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without --stop-on-unit-failure, the browser tests run after failing unit tests, as the writer needs', () => {
  const dir = app('report', 'fail');
  try {
    assert.equal(summary(dir, '--run', '@shop').calls, 'run test:affected\nrun test:e2e -- --grep @shop\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an option other than --run @<mfe> is refused before any test runs', () => {
  const dir = app('report');
  try {
    for (const args of [['--run'], ['--run', 'shop'], ['--run', '@Shop'], ['--run', '@shop', 'extra'], ['--update'],
      ['--run', '@shop', '--stop-on-unit-failure', 'extra'], ['--stop-on-unit-failure', '--run', '@shop'], ['--run', '--stop-on-unit-failure', '@shop']]) {
      const r = summary(dir, ...args);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.out, /Usage: npm run test:summary, or npm run test:summary -- --run @<mfe>/);
      assert.equal(r.calls, '', args.join(' '));
    }
    // Without an option, it only reads the reports, as before.
    const r = summary(dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /MFE level \(Vitest\): 9 passed, 0 failed/);
    assert.equal(r.calls, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// With --stop-on-unit-failure, the verifier reads which test of each criterion passed: the counts do
// not say (QA eval run 53: after a failure of AC-1, two verifiers reported AC-2 as not_run).
const mixedUnit = JSON.stringify({ numPassedTests: 2, numFailedTests: 1, testResults: [{ assertionResults: [
  { fullName: '[SHOP-2][AC-1] MFE heading counts each line quantity', status: 'failed', failureMessages: ['Unable to find "Cart (3)"'] },
  { fullName: '[SHOP-2][AC-2] MFE an empty cart shows the empty message', status: 'passed', failureMessages: [] },
  { fullName: 'the cart reducer adds a line', status: 'passed', failureMessages: [] },
  { fullName: '[SHOP-2][AC-3] MFE a skipped scenario', status: 'pending', failureMessages: [] },
] }] });
const passingUnit = JSON.stringify({ numPassedTests: 2, numFailedTests: 0, testResults: [{ assertionResults: [
  { fullName: '[SHOP-2][AC-1] MFE heading counts each line quantity', status: 'passed', failureMessages: [] },
  { fullName: '[SHOP-2][AC-2] MFE an empty cart shows the empty message', status: 'passed', failureMessages: [] },
] }] });
const mixedBrowser = JSON.stringify({ stats: { expected: 2, unexpected: 1, flaky: 0 }, suites: [{ title: 'SHOP-2.spec.ts', specs: [
  { title: '[SHOP-2][AC-1] shell heading counts each line quantity', tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'no heading' } }] }] },
  { title: '[SHOP-2][AC-2] shell an empty cart shows the empty message', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
  { title: 'the page loads', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] },
] }] });

test('--stop-on-unit-failure lists the passed tests named for a criterion, at both levels', () => {
  // The unit tests failed: the verifier still has the evidence of AC-2, and the browser tests are not run.
  let dir = app('report', 'fail');
  try {
    writeFileSync(join(dir, 'vitest.json'), mixedUnit);
    const r = summary(dir, '--run', '@shop', '--stop-on-unit-failure');
    assert.match(r.out, /MFE level \(Vitest\): 2 passed, 1 failed\n {2}✗ \[SHOP-2\]\[AC-1\] MFE heading counts each line quantity\n {4}Unable to find "Cart \(3\)"\n {2}✓ \[SHOP-2\]\[AC-2\] MFE an empty cart shows the empty message\n/);
    assert.doesNotMatch(r.out, /reducer|AC-3|skipped/, 'neither an untagged test nor a skipped one');
    assert.match(r.out, /Browser tests not run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The unit tests passed: both levels list the tests of the criteria, and only those.
  dir = app('report', 'pass');
  try {
    writeFileSync(join(dir, 'vitest.json'), passingUnit);
    writeFileSync(join(dir, 'playwright.json'), mixedBrowser);
    const r = summary(dir, '--run', '@shop', '--stop-on-unit-failure');
    assert.match(r.out, /MFE level \(Vitest\): 2 passed, 0 failed\n {2}✓ \[SHOP-2\]\[AC-1\] MFE heading[^\n]*\n {2}✓ \[SHOP-2\]\[AC-2\] MFE an empty cart[^\n]*\n/);
    assert.match(r.out, /Shell level \(Playwright\): 2 passed, 1 failed, 0 flaky\n {2}✗ SHOP-2\.spec\.ts › \[SHOP-2\]\[AC-1\] shell heading[^\n]*\n {4}no heading\n {2}✓ SHOP-2\.spec\.ts › \[SHOP-2\]\[AC-2\] shell an empty cart[^\n]*\n/);
    assert.doesNotMatch(r.out, /page loads/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without --stop-on-unit-failure, no passed test is listed: the writer reads the summary it always read', () => {
  const dir = app('report', 'fail');
  try {
    writeFileSync(join(dir, 'vitest.json'), mixedUnit);
    writeFileSync(join(dir, 'playwright.json'), mixedBrowser);
    const run = summary(dir, '--run', '@shop');
    assert.match(run.out, /MFE level \(Vitest\): 2 passed, 1 failed\n {2}✗ /);
    assert.doesNotMatch(run.out, /✓/);
    // Reading the reports of an earlier run lists none either.
    const read = summary(dir);
    assert.match(read.out, /MFE level \(Vitest\)/);
    assert.doesNotMatch(read.out, /✓/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--stop-on-unit-failure lists at most 30 passed tests, and says how many more there are', () => {
  const many = JSON.stringify({ numPassedTests: 35, numFailedTests: 0, testResults: [{ assertionResults:
    Array.from({ length: 35 }, (_, i) => ({ fullName: `[SHOP-9][AC-${i + 1}] MFE criterion ${i + 1}`, status: 'passed', failureMessages: [] })) }] });
  const dir = app('report', 'pass');
  try {
    writeFileSync(join(dir, 'vitest.json'), many);
    const r = summary(dir, '--run', '@shop', '--stop-on-unit-failure');
    assert.equal(r.out.split('\n').filter((line) => line.startsWith('  ✓ ')).length, 30);
    assert.match(r.out, /✓ \[SHOP-9\]\[AC-30\] MFE criterion 30\n {2}… and 5 more passed tests named for a criterion\n/);
    assert.doesNotMatch(r.out, /AC-31\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
