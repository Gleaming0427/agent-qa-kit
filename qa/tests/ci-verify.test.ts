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
const KIT_FILES = ['qa/ci-verify.sh', 'qa/ci-node-version.sh', 'qa/ci-permissions.sh', 'qa/ci-trusted-kit.sh', 'qa/check-scope.sh', 'qa/check-test-blocks.ts', 'qa/check-tooling.ts', 'qa/github-approval.ts', 'qa/scenario-review.ts',
  'qa/loose-assertions.ts', 'qa/criteria-manifest.ts', '.claude/hooks/strict-evidence.ts', '.claude/hooks/coverage.ts'];
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
// The trusted copy of the kit is read-only: make it removable first.
function cleanup(dir: string) {
  spawnSync('chmod', ['-R', 'u+w', dir]);
  rmSync(dir, { recursive: true, force: true });
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
  // The kit as the base branch has it, in a copy that the pull request's code cannot change.
  const trusted = join(dir, 'trusted');
  const copied = spawnSync('bash', [join(kit, 'qa/ci-trusted-kit.sh'), work], { encoding: 'utf8', env: { ...process.env, QA_TRUSTED_KIT: trusted } });
  if (copied.status !== 0) throw new Error(copied.stdout + copied.stderr);
  const tree = git(work, 'rev-parse', '--short', 'HEAD:.claude');

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
  git(work, 'checkout', '-qb', `feat/${TICKET}-old-node`, `feat/${TICKET}`);
  write(work, 'app/.nvmrc', 'v20.19.0\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'pin an old Node.js');
  git(work, 'checkout', '-qb', `feat/${TICKET}-without-tests`, 'main');
  write(work, 'app/src/App.tsx', 'export const App = () => "Clear search";\n');
  git(work, 'commit', '-qam', 'feature without the QA tests');
  // A pull request that weakens an approved test and the check that would catch it.
  git(work, 'checkout', '-qb', `feat/${TICKET}-weakened-kit`, `feat/${TICKET}`);
  write(app, `src/${TICKET}.test.tsx`, `test('[${TICKET}][AC-1] MFE shows the clear button', () => { /* weakened */ });\n`);
  write(work, 'qa/check-scope.sh', '#!/usr/bin/env bash\nexit 0\n');
  // The review package's own check (the hashes of the approved tests) says yes as well.
  write(work, 'qa/scenario-review.ts', `export const missingReasons = () => [];
export const reviewReasons = () => ({});
if (process.argv[2] === 'import') console.log(JSON.stringify({ mfe: 'services', spec: '../specs/${TICKET}.md' }));
`);
  git(work, 'commit', '-qam', 'weaken a test and the checks on it');
  // A pull request that changes how its own tests run.
  git(work, 'checkout', '-qb', `feat/${TICKET}-setup`, `feat/${TICKET}`);
  write(app, 'package.json', JSON.stringify({ scripts: { 'test:unit': 'vitest run || true', build: 'vite build' }, dependencies: { react: '19.1.1' } }));
  write(app, 'vitest.config.ts', "export default { test: { setupFiles: ['./setup.ts'] } };\n");
  write(app, 'setup.ts', 'export {};\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'change the test setup');
  // A pull request that changes a file of the kit.
  git(work, 'checkout', '-qb', `feat/${TICKET}-kit`, `feat/${TICKET}`);
  write(work, 'qa/loose-assertions.ts', `${readFileSync(join(work, 'qa/loose-assertions.ts'), 'utf8')}// changed\n`);
  git(work, 'commit', '-qam', 'change the kit');

  // GitHub keeps refs/pull/<number>/head even after the branch is deleted.
  git(dir, 'clone', '-q', '--bare', work, 'origin.git');
  git(work, 'push', '-q', join(dir, 'origin.git'), `qa/${TICKET}:refs/pull/7/head`);
  const main = git(work, 'rev-parse', 'main');

  write(dir, 'bin/gh', `#!/usr/bin/env bash
case "$*" in
  'auth setup-git') ;;
  *'/pulls?'*) cat "${dir}/pulls.json" ;;
  *'/pulls/7/reviews'*) cat "${dir}/reviews.json" ;;
  # Who may write to the repository: permissions.json, when a test gives one; otherwise the call fails, as it does
  # for a token that is not allowed to read it.
  *'/collaborators/'*'/permission'*) login="\${2#repos/acme/shop/collaborators/}"; login="\${login%/permission}"
    [[ -f "${dir}/permissions.json" ]] && jq -er --arg l "$login" '.[$l] // empty' "${dir}/permissions.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  return { dir, approved, main, trusted, tree };
}

function verify(h: ReturnType<typeof history>, options: {
  branch?: string; title?: string; pulls?: unknown[]; reviews?: unknown[]; env?: Record<string, string>;
  // Run the kit from the copy of the base branch's kit, with the checkout apart (as the workflow does).
  trusted?: boolean;
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
  const result = spawnSync('bash', [options.trusted ? join(h.trusted, 'qa/ci-verify.sh') : 'qa/ci-verify.sh', 'prepare'], {
    cwd: ci, encoding: 'utf8',
    env: { ...process.env, ...(options.trusted ? { QA_REPO_DIR: ci, QA_KIT_FROM: 'base' } : {}),
      PATH: `${join(h.dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/shop',
      BASE_REF: 'main', HEAD_REF: branch, PR_TITLE: options.title ?? 'Clear the search', RUNNER_TEMP: temp,
      GITHUB_OUTPUT: join(temp, 'output'), GITHUB_STEP_SUMMARY: join(temp, 'summary'), PR_NUMBER: '12', HEAD_SHA: 'abcdef123456',
      ...options.env },
  });
  const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { code: result.status, output: result.stdout + result.stderr, ci, temp,
    list: read(join(temp, 'qa-verify-tickets.tsv')),
    count: read(join(temp, 'output')).match(/^count=.*$/m)?.[0] ?? '',
    node: read(join(temp, 'output')).split('\n').filter((line) => line.startsWith('node')).join('\n'),
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
    assert.equal(r.node, 'node=22\nnode_from=default', 'no .nvmrc: Node.js 22 for the application');
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
  } finally { cleanup(h.dir); }
});

test('the verify workflow counts an approval only from someone who can write, and falls back to the association when it cannot tell', () => {
  const h = history();
  try {
    const approval = (login: string, association: string) => ({ id: 1, user: { login }, state: 'APPROVED', commit_id: h.approved, author_association: association, body: REASONS });
    // The token cannot read permissions: the association decides, and the log says so.
    let r = verify(h);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /::warning title=QA approval::Could not read the repository permission of alice/);

    // alice is the owner of the organization but only reads this repository.
    writeFileSync(join(h.dir, 'permissions.json'), JSON.stringify({ alice: 'read' }));
    r = verify(h);
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /@alice cannot approve: only has read access to the repository/);
    assert.equal(r.record.at(-1)?.result, 'fail');

    // A reader's request for changes does not cancel a writer's approval.
    writeFileSync(join(h.dir, 'permissions.json'), JSON.stringify({ alice: 'write', rhea: 'read' }));
    r = verify(h, { reviews: [approval('alice', 'OWNER'), { id: 2, user: { login: 'rhea' }, state: 'CHANGES_REQUESTED', commit_id: h.approved, author_association: 'MEMBER', body: 'no' }] });
    assert.equal(r.code, 0, r.output);
    const approved = JSON.parse(readFileSync(join(r.ci, `app/reports/${TICKET}-approved.json`), 'utf8'));
    assert.equal(approved.reviewer, '@alice');
    assert.doesNotMatch(r.output, /::warning title=QA approval/, 'every permission was read');

    // A writer's request for changes does.
    writeFileSync(join(h.dir, 'permissions.json'), JSON.stringify({ alice: 'write', wes: 'write' }));
    r = verify(h, { reviews: [approval('alice', 'OWNER'), { id: 2, user: { login: 'wes' }, state: 'CHANGES_REQUESTED', commit_id: h.approved, author_association: 'COLLABORATOR', body: 'no' }] });
    assert.equal(r.code, 1);
    assert.match(r.output, /@wes requested changes/);
  } finally { cleanup(h.dir); }
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
  } finally { cleanup(h.dir); }
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
  } finally { cleanup(h.dir); }
});

// The application's Node.js version comes from its .nvmrc or .node-version (qa/ci-node-version.sh).
test('the verify workflow gives the application the Node.js it names, and refuses one the kit cannot run on', () => {
  const h = history();
  try {
    let r = verify(h, { branch: `feat/${TICKET}-old-node` });
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /::error title=QA verify::app\/\.nvmrc names Node\.js v20\.19\.0; the kit's scripts need 22\.18 or later/);
    assert.equal(r.count, '');
    assert.deepEqual(r.record.map((o) => [o.ticket, o.step, o.result]), [[TICKET, 'prepare', 'pass'], [TICKET, 'prepare', 'fail']]);

    r = verify(h, { branch: `feat/${TICKET}-old-node`, env: { QA_VERIFY_MODE: 'advisory' } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=0', 'nothing else runs');
    assert.match(r.output, /::warning title=QA verify \(advisory\)::Would block: app\/\.nvmrc names Node\.js v20\.19\.0/);
    assert.match(r.summary, /would block: app\/\.nvmrc names Node\.js/);
  } finally { cleanup(h.dir); }
});

// A pull request must not be judged by the scripts it can change (qa/ci-trusted-kit.sh).
test('a pull request that weakens the checks on its own tests passes with its own scripts and fails with the base branch\'s', () => {
  const h = history();
  try {
    const branch = `feat/${TICKET}-weakened-kit`;
    let r = verify(h, { branch });
    assert.equal(r.code, 0, `judged by its own scripts, which say yes to everything: ${r.output}`);
    assert.equal(r.count, 'count=1');

    r = verify(h, { branch, trusted: true });
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /differ from the version approved in #7/);
  } finally { cleanup(h.dir); }
});

test('the kit run from the base branch\'s copy verifies like the kit in the checkout, and records the version of its agents', () => {
  const h = history();
  try {
    const r = verify(h, { trusted: true });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.list, `${TICKET}\tapp\tservices\t../specs/${TICKET}.md\n`);
    assert.equal(r.count, 'count=1');
    assert.equal(r.node, 'node=22\nnode_from=default');
    assert.equal(r.record[0].agent, h.tree, 'the tree of .claude the copy was made from, read from the copy');
    assert.doesNotMatch(r.output, /::(warning|notice) title=QA verify \((kit|test setup)\)/, 'nothing else changed');
    // The checkout holds the approval it recorded, apart from the kit.
    assert.equal(JSON.parse(readFileSync(join(r.ci, `app/reports/${TICKET}-approved.json`), 'utf8')).reviewer, '@alice');
  } finally { cleanup(h.dir); }
});

// What the pull request changes in the way its own tests run (qa/check-tooling.ts).
test('a pull request that changes how its own tests run is flagged, and the track record says so', () => {
  const h = history();
  try {
    const branch = `feat/${TICKET}-setup`;
    const r = verify(h, { branch });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=1', 'by default it warns and goes on');
    assert.match(r.output, /::warning title=QA verify \(test setup\)::This pull request changes how its own tests run: app\/package\.json \(script "test:unit" added\); app\/vitest\.config\.ts \(the configuration of the tests\); app\/setup\.ts \(named in app\/vitest\.config\.ts as setupFiles\)\./);
    assert.doesNotMatch(r.output, /build/, 'a script that does not run the tests is not reported');
    assert.match(r.summary, /\*\*Test setup changed\*\*: app\/package\.json/);
    assert.deepEqual(r.record.map((o) => [o.step, o.result]), [['prepare', 'pass'], ['prepare', 'pass']]);
    assert.match(r.record[1].detail, /^tooling changed: app\/package\.json/);

    assert.doesNotMatch(verify(h).output, /test setup/, 'the approved branch changes nothing there');
  } finally { cleanup(h.dir); }
});

test('with QA_VERIFY_TOOLING=block, a change to the test setup fails the check, or would in advisory mode', () => {
  const h = history();
  try {
    const branch = `feat/${TICKET}-setup`;
    let r = verify(h, { branch, env: { QA_VERIFY_TOOLING: 'block' } });
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, /::error title=QA verify::This pull request changes how its own tests run: app\/package\.json[^\n]*Make that change in a pull request of its own, then verify this one\./);
    assert.deepEqual(r.record.map((o) => [o.step, o.result]), [['prepare', 'pass'], ['prepare', 'fail']]);
    assert.match(r.record[1].detail, /^tooling: This pull request changes how its own tests run/);

    r = verify(h, { branch, env: { QA_VERIFY_TOOLING: 'block', QA_VERIFY_MODE: 'advisory' } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.count, 'count=1');
    assert.match(r.output, /::warning title=QA verify \(advisory\)::Would block: This pull request changes how its own tests run/);
    assert.match(r.summary, /would block: This pull request changes how its own tests run/);

    r = verify(h, { branch, env: { QA_VERIFY_TOOLING: 'strict' } });
    assert.equal(r.code, 1);
    assert.match(r.output, /QA_VERIFY_TOOLING must be warn or block, got "strict"/);
  } finally { cleanup(h.dir); }
});

test('a pull request that changes the kit says whose copy of the kit judged it', () => {
  const h = history();
  try {
    const branch = `feat/${TICKET}-kit`;
    let r = verify(h, { branch });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /::warning title=QA verify \(kit\)::This pull request changes 1 file\(s\) of the kit \(qa\/loose-assertions\.ts\)\. This run used the kit as this pull request has it: nothing checked these scripts/);

    r = verify(h, { branch, trusted: true });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /::notice title=QA verify \(kit\)::This pull request changes 1 file\(s\) of the kit \(qa\/loose-assertions\.ts\)\. This run used the kit of main, so the change only takes effect once the pull request is merged/);
    assert.match(r.summary, /\*\*Kit changed\*\* \(1 file\(s\): qa\/loose-assertions\.ts\)/);

    r = verify(h, { branch, trusted: true, env: { QA_KIT_FROM: 'pull-request' } });
    assert.match(r.output, /::warning title=QA verify \(kit\)::[^\n]*This run used the pull request's own copy of the kit, since the base branch has no kit that can run from a copy yet/);
  } finally { cleanup(h.dir); }
});
