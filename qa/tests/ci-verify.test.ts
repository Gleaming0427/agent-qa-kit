import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildManifest } from '../criteria-manifest.ts';
import { exportReview, prepareReview } from '../scenario-review.ts';

// The "prepare" step of the QA verify workflow on a real git history, with a
// stand-in for the GitHub CLI: which approval counts, and on which tests.
const kit = resolve(import.meta.dirname, '../..');
const KIT_FILES = ['qa/ci-verify.sh', 'qa/check-scope.sh', 'qa/github-approval.ts', 'qa/scenario-review.ts',
  'qa/criteria-manifest.ts', '.claude/hooks/strict-evidence.ts', '.claude/hooks/coverage.ts'];
const TICKET = 'TICKET-43';
const REASONS = 'Looks right.\n\nAC-1: the button does not exist yet, so the search cannot be cleared.';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// main holds the kit, an application and the ticket; qa/TICKET-43 adds the RED
// tests and their review package; feat/TICKET-43 adds the feature.
function history() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ci-verify-'));
  const work = join(dir, 'work');
  for (const file of KIT_FILES) write(work, file, readFileSync(join(kit, file), 'utf8'));
  const spec = '- AC-1: a "Clear search" button is displayed while the search field has text.\n';
  write(work, `specs/${TICKET}.md`, spec);
  write(work, 'app/src/App.tsx', 'export const App = () => null;\n');
  write(work, '.gitignore', 'reports/\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');

  git(work, 'checkout', '-qb', `qa/${TICKET}`);
  const app = join(work, 'app');
  write(app, `e2e/${TICKET}.spec.ts`, `test('[${TICKET}][AC-1] shell shows the clear button', () => {});\n`);
  write(app, `src/${TICKET}.test.tsx`, `test('[${TICKET}][AC-1] MFE shows the clear button', () => {});\n`);
  write(app, `reports/${TICKET}-criteria.json`, JSON.stringify(buildManifest(TICKET, spec)));
  write(app, `reports/${TICKET}-phase1.json`, JSON.stringify({ ticket: TICKET, phase: 1, verdict: 'ready',
    criteria: ['mfe', 'shell'].map((level) => ({ id: 'AC-1', level, status: 'written', evidence: 'test' })) }));
  write(app, 'reports/vitest.json', JSON.stringify({ numFailedTests: 1, numPassedTests: 0, testResults: [{
    name: join(app, `src/${TICKET}.test.tsx`),
    assertionResults: [{ fullName: `[${TICKET}][AC-1] MFE shows the clear button`, status: 'failed',
      failureMessages: ['Unable to find a button named Clear search'] }],
  }] }));
  write(app, 'reports/playwright.json', JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{
    title: `${TICKET}.spec.ts`, file: `${TICKET}.spec.ts`, specs: [{
      title: `[${TICKET}][AC-1] shell shows the clear button`, file: `${TICKET}.spec.ts`,
      tests: [{ status: 'unexpected', results: [{ status: 'failed', error: {
        message: 'Error: expect(locator).toBeVisible() failed\nLocator: getByRole(\'button\', { name: \'Clear search\' })',
      } }] }],
    }],
  }] }));
  const specPath = join(work, `specs/${TICKET}.md`);
  prepareReview({ root: app, ticket: TICKET, specPath });
  exportReview({ root: app, ticket: TICKET, specPath, mfe: 'services' });
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'QA tests');
  const approved = git(work, 'rev-parse', 'HEAD');

  git(work, 'checkout', '-qb', `feat/${TICKET}`);
  write(work, 'app/src/App.tsx', 'export const App = () => "Clear search";\n');
  git(work, 'commit', '-qam', 'feature');
  git(work, 'checkout', '-qb', `feat/${TICKET}-edited`);
  write(app, `src/${TICKET}.test.tsx`, `test('[${TICKET}][AC-1] MFE shows the clear button', () => { /* weakened */ });\n`);
  git(work, 'commit', '-qam', 'edit an approved test');
  git(work, 'checkout', '-qb', `feat/${TICKET}-without-tests`, 'main');
  write(work, 'app/src/App.tsx', 'export const App = () => "Clear search";\n');
  git(work, 'commit', '-qam', 'feature without the QA tests');

  // GitHub keeps refs/pull/<number>/head even after the branch is deleted.
  git(dir, 'clone', '-q', '--bare', work, 'origin.git');
  git(work, 'push', '-q', join(dir, 'origin.git'), `qa/${TICKET}:refs/pull/7/head`);
  const main = git(work, 'rev-parse', 'main');

  write(dir, 'bin/gh', `#!/usr/bin/env bash
case "$*" in
  'auth setup-git') ;;
  *'/pulls?'*) cat "${dir}/pulls.json" ;;
  *'/pulls/7/reviews'*) cat "${dir}/reviews.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  return { dir, approved, main };
}

function verify(h: ReturnType<typeof history>, options: {
  branch?: string; title?: string; pulls?: unknown[]; reviews?: unknown[]; env?: Record<string, string>;
} = {}) {
  const branch = options.branch ?? `feat/${TICKET}`;
  const pulls = options.pulls ?? [{ number: 7, state: 'closed', merged_at: '2026-11-01T10:00:00Z',
    head: { ref: `qa/${TICKET}`, sha: h.approved, repo: { full_name: 'acme/shop' } } }];
  const reviews = options.reviews ?? [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', commit_id: h.approved,
    author_association: 'OWNER', body: REASONS }];
  writeFileSync(join(h.dir, 'pulls.json'), JSON.stringify([pulls]));
  writeFileSync(join(h.dir, 'reviews.json'), JSON.stringify([reviews]));
  const ci = mkdtempSync(join(h.dir, 'ci-'));
  const temp = mkdtempSync(join(h.dir, 'runner-'));
  git(ci, 'clone', '-q', '--branch', branch, join(h.dir, 'origin.git'), '.');
  const result = spawnSync('bash', ['qa/ci-verify.sh', 'prepare'], {
    cwd: ci, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(h.dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/shop',
      BASE_REF: 'main', HEAD_REF: branch, PR_TITLE: options.title ?? 'Clear the search', RUNNER_TEMP: temp,
      GITHUB_OUTPUT: join(temp, 'output'), GITHUB_STEP_SUMMARY: join(temp, 'summary'), PR_NUMBER: '12', HEAD_SHA: 'abcdef123456',
      ...options.env },
  });
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { code: result.status, output: result.stdout + result.stderr, ci, temp,
    list: read(join(temp, 'qa-verify-tickets.tsv')), count: read(join(temp, 'output')).trim(),
    record: read(join(temp, 'qa-verify-record.jsonl')).split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    summary: read(join(temp, 'summary')) };
}

test('the verify workflow accepts only the tests a collaborator approved', () => {
  const h = history();
  try {
    let r = verify(h);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.list, `${TICKET}\tapp\tservices\t../specs/${TICKET}.md\n`);
    assert.equal(r.count, 'count=1');
    const approval = JSON.parse(readFileSync(join(r.ci, `app/reports/${TICKET}-approved.json`), 'utf8'));
    assert.equal(approval.reviewer, '@alice');

    r = verify(h, { reviews: [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', commit_id: h.main,
      author_association: 'OWNER', body: REASONS }] });
    assert.equal(r.code, 1);
    assert.match(r.output, /@alice approved an older version of the tests/);

    r = verify(h, { reviews: [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', commit_id: h.approved,
      author_association: 'OWNER', body: 'LGTM' }] });
    assert.equal(r.code, 1);
    assert.match(r.output, /approval of #7 by @alice cannot be used.*AC-1: explain why/);

    r = verify(h, { branch: `feat/${TICKET}-edited` });
    assert.equal(r.code, 1);
    assert.match(r.output, /differ from the version written by the QA agent[\s\S]*differ from the version approved in #7/);

    r = verify(h, { branch: `feat/${TICKET}-without-tests` });
    assert.equal(r.code, 1);
    assert.match(r.output, /QA tests in pull request #7, but this branch does not contain them/);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('the verify workflow has nothing to check without a ticket that has QA tests', () => {
  const h = history();
  try {
    let r = verify(h, { branch: `feat/${TICKET}-without-tests`, pulls: [] });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=0');
    assert.match(r.output, /TICKET-43: no QA pull request, nothing to verify/);

    r = verify(h, { branch: 'main', title: 'Fix a typo in the footer' });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=0');
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test('in advisory mode the verify workflow warns where it would block, records it, and passes', () => {
  const h = history();
  try {
    const advisory = { env: { QA_VERIFY_MODE: 'advisory' } };
    // Tests edited on the developer's branch: blocking mode fails, advisory mode warns.
    let r = verify(h, { branch: `feat/${TICKET}-edited`, ...advisory });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=0');
    assert.match(r.output, /::warning title=QA verify \(advisory\)::Would block: TICKET-43: the tests or their review package differ/);
    assert.doesNotMatch(r.output, /::error/);
    assert.match(r.summary, /QA verify is advisory[\s\S]*TICKET-43\*\*: would block/);
    assert.deepEqual(r.record.map((o) => [o.mode, o.pr, o.sha, o.ticket, o.step, o.result]), [['advisory', '12', 'abcdef123456', TICKET, 'prepare', 'fail']]);
    assert.match(r.record[0].detail, /differ from the version approved in #7/);

    // Approved tests, then a full suite that fails: blocking mode fails, advisory mode records it and passes.
    r = verify(h, advisory);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=1');
    assert.deepEqual(r.record.map((o) => [o.step, o.result]), [['prepare', 'pass']]);
    const suite = (mode: string) => spawnSync('bash', ['qa/ci-verify.sh', 'suite'], {
      cwd: r.ci, encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: r.temp, GITHUB_STEP_SUMMARY: join(r.temp, 'summary'), QA_VERIFY_MODE: mode, PR_NUMBER: '12', HEAD_SHA: 'abcdef123456' },
    });
    // This history has no qa/full-suite.sh: the suite cannot pass.
    const advised = suite('advisory');
    assert.equal(advised.status, 0, advised.stdout + advised.stderr);
    assert.match(advised.stdout, /::warning title=QA verify \(advisory\)::Would block: TICKET-43 does not pass the suite check/);
    const blocked = suite('blocking');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /::error title=QA verify::TICKET-43 does not pass the suite check/);
    const record = readFileSync(join(r.temp, 'qa-verify-record.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(record.map((o) => [o.mode, o.step, o.result]), [['advisory', 'prepare', 'pass'], ['advisory', 'suite', 'fail'], ['blocking', 'suite', 'fail']]);

    assert.equal(verify(h, { env: { QA_VERIFY_MODE: 'warn' } }).code, 1);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
