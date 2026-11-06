import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { buildManifest } from '../criteria-manifest.ts';
import { exportReview, prepareReview } from '../scenario-review.ts';

// The "QA amend tests" workflow on a real git history, with stand-ins for the GitHub CLI and for
// npm (whose test runs write the reports), then the "prepare" step of QA verify on the result.
const kit = resolve(import.meta.dirname, '../..');
const KIT_FILES = ['qa/ci-verify.sh', 'qa/check-scope.sh', 'qa/github-approval.ts', 'qa/scenario-review.ts',
  'qa/criteria-manifest.ts', '.claude/hooks/strict-evidence.ts', '.claude/hooks/coverage.ts'];
const TICKET = 'TICKET-43';
const UNIT = `[${TICKET}][AC-1] MFE shows the clear button`;
const SHELL = `[${TICKET}][AC-1] shell shows the clear button`;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const vitest = (app: string, message: string) => JSON.stringify({ numFailedTests: 1, numPassedTests: 0, testResults: [{
  name: join(app, `src/${TICKET}.test.tsx`), assertionResults: [{ fullName: UNIT, status: 'failed', failureMessages: [message] }],
}] });
const playwright = JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{
  title: `${TICKET}.spec.ts`, file: `${TICKET}.spec.ts`, specs: [{ title: SHELL, file: `${TICKET}.spec.ts`,
    tests: [{ status: 'unexpected', results: [{ status: 'failed', error: {
      message: 'Error: expect(locator).toBeVisible() failed\nLocator: getByRole(\'button\', { name: \'Clear search\' })',
    } }] }] }],
}] });

// main holds the kit and the ticket; qa/TICKET-43 the approved RED tests (pull request 7), merged
// into feat/TICKET-43, where the feature is being built. Then a person fixes the unit test on qa/.
// folder: the application's folder in the repository, "." for an application at its root.
function history(folder = 'app') {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ci-amend-'));
  const work = join(dir, 'work');
  for (const file of KIT_FILES) write(work, file, readFileSync(join(kit, file), 'utf8'));
  const spec = '- AC-1: a "Clear search" button is displayed while the search field has text.\n';
  write(work, `specs/${TICKET}.md`, spec);
  write(work, `${folder}/src/App.tsx`, 'export const App = () => null;\n');
  write(work, '.gitignore', 'reports/\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'checkout', '-qb', `qa/${TICKET}`);
  const app = join(work, folder);
  write(app, `e2e/${TICKET}.spec.ts`, `test('${SHELL}', () => {});\n`);
  write(app, `src/${TICKET}.test.tsx`, `test('${UNIT}', () => { /* expects "Clear" */ });\n`);
  write(app, `reports/${TICKET}-criteria.json`, JSON.stringify(buildManifest(TICKET, spec)));
  write(app, `reports/${TICKET}-phase1.json`, JSON.stringify({ ticket: TICKET, phase: 1, verdict: 'ready',
    criteria: ['mfe', 'shell'].map((level) => ({ id: 'AC-1', level, status: 'written', evidence: 'test' })) }));
  write(app, 'reports/vitest.json', vitest(app, 'Unable to find a button named Clear'));
  write(app, 'reports/playwright.json', playwright);
  const specPath = join(work, `specs/${TICKET}.md`);
  prepareReview({ root: app, ticket: TICKET, specPath });
  exportReview({ root: app, ticket: TICKET, specPath, mfe: 'services' });
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'QA tests');
  git(work, 'checkout', '-qb', `feat/${TICKET}`);
  write(work, `${folder}/src/App.tsx`, 'export const App = () => "Clear search";\n');
  git(work, 'commit', '-qam', 'feature');
  // The approved unit test looked for "Clear"; the ticket says "Clear search".
  git(work, 'checkout', '-q', `qa/${TICKET}`);
  write(app, `src/${TICKET}.test.tsx`, `test('${UNIT}', () => { /* expects "Clear search" */ });\n`);
  git(work, 'commit', '-qam', 'fix the button name the unit test expects');
  git(dir, 'clone', '-q', '--bare', work, 'origin.git');

  // gh: branch lookups against the bare origin; pull requests recorded in calls.log.
  write(dir, 'bin/gh', `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
case "$*" in
  'auth setup-git') ;;
  'api repos/acme/shop/git/ref/heads/'*) git --git-dir="${dir}/origin.git" rev-parse --verify --quiet "refs/heads/\${2#repos/acme/shop/git/ref/heads/}" >/dev/null ;;
  'pr list '*) ;;
  'pr create '*) echo 'https://github.com/acme/shop/pull/8' ;;
  *'/pulls?'*) cat "${dir}/pulls.json" ;;
  *'/pulls/8/reviews'*) cat "${dir}/reviews.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  // npm: the ticket's tests, still failing on the application without the feature.
  write(dir, 'bin/npm', `#!/usr/bin/env bash
mkdir -p reports
case "$*" in
  'run test:affected') cat "${dir}/vitest.json" > reports/vitest.json ;;
  'run test:e2e -- --grep @services') cat "${dir}/playwright.json" > reports/playwright.json ;;
  *) echo "unexpected npm call: $*" >&2; exit 2 ;;
esac
exit 1
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  chmodSync(join(dir, 'bin/npm'), 0o755);
  return { dir, folder };
}

function amend(h: { dir: string; folder: string }, step: string, work: string, reason = 'The unit test looked for "Clear"; the ticket names the button "Clear search".') {
  const temp = join(h.dir, 'runner');
  mkdirSync(temp, { recursive: true });
  const result = spawnSync('bash', [join(kit, 'qa/ci-amend-tests.sh'), step], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(h.dir, 'bin')}:${process.env.PATH}`, TICKET, APP: h.folder, REASON: reason, WORK: work,
      GITHUB_REPOSITORY: 'acme/shop', GITHUB_SERVER_URL: 'https://github.com', GITHUB_ACTOR: 'bob', GITHUB_ACTOR_ID: '2',
      RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, 'summary') },
  });
  return { code: result.status, output: result.stdout + result.stderr };
}

function amendAndVerify(folder: string) {
  const h = history(folder);
  try {
    const work = join(h.dir, 'ci-work');
    git(h.dir, 'clone', '-q', '--branch', `qa/${TICKET}`, join(h.dir, 'origin.git'), work);
    const app = join(work, folder);
    writeFileSync(join(h.dir, 'vitest.json'), vitest(app, 'Unable to find a button named Clear search'));
    writeFileSync(join(h.dir, 'playwright.json'), playwright);

    let r = amend(h, 'check', work, 'typo');
    assert.equal(r.code, 1);
    assert.match(r.output, /in 20 characters or more/);
    r = amend(h, 'check', work);
    assert.equal(r.code, 0, r.output);

    r = amend(h, 'amend', work);
    assert.equal(r.code, 0, r.output);
    const log = JSON.parse(readFileSync(join(app, `qa-reviews/${TICKET}/${TICKET}-amendments.json`), 'utf8'));
    assert.equal(log.length, 1);
    assert.equal(log[0].author, '@bob');
    assert.deepEqual(log[0].files.map((f: { path: string }) => f.path), [`src/${TICKET}.test.tsx`]);
    const body = readFileSync(join(h.dir, 'runner/qa-amend-body.md'), 'utf8');
    assert.match(body, /^## Amended QA tests for TICKET-43[\s\S]*by @bob: The unit test looked for "Clear"/);
    assert.match(body, /Unable to find a button named Clear search/);

    r = amend(h, 'publish', work);
    assert.equal(r.code, 0, r.output);
    assert.match(readFileSync(join(h.dir, 'calls.log'), 'utf8'), /pr create --repo acme\/shop --base feat\/TICKET-43 --head qa\/TICKET-43 --title TICKET-43: amended QA tests to review/);
    const pushed = git(h.dir, '--git-dir=origin.git', 'show', '--stat', '--format=%s', `qa/${TICKET}`);
    assert.match(pushed, /^test\(TICKET-43\): log the amendment of the approved QA tests/);
    assert.match(pushed, /TICKET-43-amendments\.json/);

    // QA verify on the developer's branch, once the amendment is merged into it and approved by @carol.
    const head = git(h.dir, '--git-dir=origin.git', 'rev-parse', `qa/${TICKET}`);
    git(h.dir, '--git-dir=origin.git', 'update-ref', 'refs/pull/8/head', head);
    const dev = join(h.dir, 'dev');
    git(h.dir, 'clone', '-q', '--branch', `feat/${TICKET}`, join(h.dir, 'origin.git'), dev);
    git(dev, 'merge', '-q', '--no-edit', `origin/qa/${TICKET}`);
    writeFileSync(join(h.dir, 'pulls.json'), JSON.stringify([[
      { number: 8, state: 'closed', merged_at: '2026-11-05T10:00:00Z', head: { ref: `qa/${TICKET}`, sha: head, repo: { full_name: 'acme/shop' } } },
      { number: 7, state: 'closed', merged_at: '2026-11-01T10:00:00Z', head: { ref: `qa/${TICKET}`, sha: 'old', repo: { full_name: 'acme/shop' } } },
    ]]));
    writeFileSync(join(h.dir, 'reviews.json'), JSON.stringify([[{ id: 3, user: { login: 'carol' }, state: 'APPROVED', commit_id: head,
      author_association: 'MEMBER', body: 'AC-1: the Clear search button does not exist yet.' }]]));
    const temp = join(h.dir, 'verify-runner');
    mkdirSync(temp);
    const v = spawnSync('bash', ['qa/ci-verify.sh', 'prepare'], {
      cwd: dev, encoding: 'utf8',
      env: { ...process.env, PATH: `${join(h.dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/shop',
        BASE_REF: 'main', HEAD_REF: `feat/${TICKET}`, PR_TITLE: 'Clear the search', RUNNER_TEMP: temp,
        GITHUB_OUTPUT: join(temp, 'output'), GITHUB_STEP_SUMMARY: join(temp, 'summary') },
    });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /tests approved by @carol in #8, unchanged since/);
    assert.match(v.stdout, /1 amendment\(s\) of the approved tests, the latest by @bob: The unit test looked for "Clear"/);
    assert.match(readFileSync(join(temp, 'summary'), 'utf8'), /Approved by @carol in #8\./);
    assert.equal(readFileSync(join(temp, 'qa-verify-tickets.tsv'), 'utf8').split('\t')[1], folder);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
}

test('the amend workflow logs the amended tests, checks them RED, and opens a pull request to approve', () => {
  amendAndVerify('app');
});

// The installer lets an application live at the repository's root: the workflows then get ".".
test('the amend workflow and QA verify also work for an application at the repository root', () => {
  amendAndVerify('.');
});

test('the amend workflow refuses a run where no approved test changed', () => {
  const h = history();
  try {
    const work = join(h.dir, 'ci-work');
    git(h.dir, 'clone', '-q', '--branch', `qa/${TICKET}`, join(h.dir, 'origin.git'), work);
    git(work, 'reset', '-q', '--hard', 'HEAD~1');
    writeFileSync(join(h.dir, 'vitest.json'), vitest(join(work, 'app'), 'Unable to find a button named Clear'));
    writeFileSync(join(h.dir, 'playwright.json'), playwright);
    const r = amend(h, 'amend', work);
    assert.equal(r.code, 1);
    assert.match(r.output, /No reviewed test changed/);
    assert.match(r.output, /The amendment of TICKET-43 is refused/);
    assert.ok(!existsSync(join(work, `app/qa-reviews/${TICKET}/${TICKET}-amendments.json`)));
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
