import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// The "publish" step of the QA write tests workflow (qa/ci-write-tests.sh), on a real git history with a bare
// origin and a stand-in for the GitHub CLI: what the QA writer left in the checkout is committed on qa/<ticket>
// only if it is a test that stays in its lane, and nothing is pushed otherwise. The "write" step runs the agent
// (qa/run-qa.sh, tested with a stand-in claude in kit-integrity.test.ts) and is not run here.
const kit = resolve(import.meta.dirname, '../..');
const TICKET = 'TICKET-44';
const APP = 'app';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const OLDER = `test('[TICKET-42][AC-1] the search can be cleared', () => {
  expect(clear()).toBe('');
});
test('an older feature', () => {
  expect(older()).toBe(true);
});
`;

// main holds the application with a unit test file that an earlier ticket and an older feature share.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ci-write-'));
  const work = join(dir, 'work');
  const kitDir = join(dir, 'kit');
  for (const file of ['qa/ci-write-tests.sh', 'qa/check-scope.sh', 'qa/check-test-blocks.ts']) {
    mkdirSync(dirname(join(kitDir, file)), { recursive: true });
    copyFileSync(join(kit, file), join(kitDir, file));
  }
  // The approval status is set after the pull request is opened: not what is tested here.
  write(kitDir, 'qa/ci-approval.sh', '#!/usr/bin/env bash\nexit 0\n');
  write(work, `${APP}/package.json`, '{ "name": "app" }\n');
  write(work, `${APP}/src/App.tsx`, 'export const App = () => null;\n');
  write(work, `${APP}/src/App.test.tsx`, OLDER);
  git(dir, 'init', '-q', '--bare', 'origin.git');
  git(work, 'init', '-q');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', join(dir, 'origin.git'));
  git(work, 'push', '-q', 'origin', 'main');
  const sha = git(work, 'rev-parse', 'HEAD');
  write(dir, 'bin/gh', `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
case "$*" in
  'auth setup-git') ;;
  'api repos/acme/shop/git/ref/heads/'*) git --git-dir="${dir}/origin.git" rev-parse --verify --quiet "refs/heads/\${2#repos/acme/shop/git/ref/heads/}" >/dev/null ;;
  'pr create '*) echo 'https://github.com/acme/shop/pull/8' ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  const temp = join(dir, 'runner');
  write(temp, 'qa-review-body.md', 'Review the tests.\n');
  return { dir, work, kitDir, sha, temp };
}

function publish(s: ReturnType<typeof setup>) {
  const result = spawnSync('bash', [join(s.kitDir, 'qa/ci-write-tests.sh'), 'publish'], {
    cwd: s.work, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, QA_REPO_DIR: s.work, TICKET, MFE: 'shop', APP,
      GITHUB_REPOSITORY: 'acme/shop', GITHUB_SHA: s.sha, GITHUB_ACTOR: 'alice', GITHUB_ACTOR_ID: '7', GITHUB_SERVER_URL: 'https://github.com',
      RUNNER_TEMP: s.temp, GITHUB_STEP_SUMMARY: join(s.temp, 'summary') },
  });
  const calls = existsSync(join(s.dir, 'calls.log')) ? readFileSync(join(s.dir, 'calls.log'), 'utf8') : '';
  const remote = (ref: string) => spawnSync('git', ['--git-dir', join(s.dir, 'origin.git'), 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' }).stdout.trim();
  return { code: result.status, output: result.stdout + result.stderr, calls, remote };
}
function done(s: ReturnType<typeof setup>) { rmSync(s.dir, { recursive: true, force: true }); }

// What the writer leaves for a ticket: its unit tests, its browser tests, its review package.
function writerAdds(s: ReturnType<typeof setup>) {
  write(s.work, `${APP}/src/${TICKET}.test.tsx`, `test('[${TICKET}][AC-1] shows the promo field', () => { expect(field()).toBeVisible(); });\n`);
  write(s.work, `${APP}/e2e/${TICKET}.spec.ts`, `test('[${TICKET}][AC-1] shows the promo field', async () => {});\n`);
  write(s.work, `${APP}/qa-reviews/${TICKET}/${TICKET}-review-request.json`, '{}\n');
}

test('the tests the writer added are committed on qa/<ticket> and pushed, with feat/<ticket> and the pull request', () => {
  const s = setup();
  try {
    writerAdds(s);
    // It also changed the application while it explored: not a test, so not committed, and said so.
    write(s.work, `${APP}/src/App.tsx`, 'export const App = () => "changed";\n');
    const r = publish(s);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Changed during the run but not committed, as they are not tests: app\/src\/App\.tsx/);
    assert.notEqual(r.remote(`refs/heads/qa/${TICKET}`), '', 'qa/<ticket> is pushed');
    assert.equal(r.remote(`refs/heads/feat/${TICKET}`), s.sha, 'feat/<ticket> starts from the commit the job ran on');
    assert.equal(git(s.work, 'diff', '--name-only', s.sha, `qa/${TICKET}`).split('\n').sort().join(' '),
      `${APP}/e2e/${TICKET}.spec.ts ${APP}/qa-reviews/${TICKET}/${TICKET}-review-request.json ${APP}/src/${TICKET}.test.tsx`);
    assert.match(r.calls, new RegExp(`pr create --repo acme/shop --base feat/${TICKET} --head qa/${TICKET} --title ${TICKET}: QA tests to review`));
  } finally { done(s); }
});

test('a test added to a file that other tickets share is accepted', () => {
  const s = setup();
  try {
    writerAdds(s);
    write(s.work, `${APP}/src/App.test.tsx`, `${OLDER}test('[${TICKET}][AC-2] an unknown code is refused', () => { expect(apply('x')).toBe('Invalid code'); });\n`);
    const r = publish(s);
    assert.equal(r.code, 0, r.output);
    assert.notEqual(r.remote(`refs/heads/qa/${TICKET}`), '');
  } finally { done(s); }
});

test('a writer that rewrote a test that was already there is stopped before anything is pushed', () => {
  for (const [what, edit, listed] of [
    ['the test of another ticket', OLDER.replace("toBe('')", 'toBeDefined()'), '[TICKET-42] [TICKET-42][AC-1] the search can be cleared'],
    ['a test that belongs to no ticket', OLDER.replace('toBe(true)', 'toBeDefined()'), 'an older feature'],
  ] as const) {
    const s = setup();
    try {
      writerAdds(s);
      write(s.work, `${APP}/src/App.test.tsx`, edit);
      const r = publish(s);
      assert.notEqual(r.code, 0, `${what}: ${r.output}`);
      assert.match(r.output, new RegExp(`The QA branch of ${TICKET} changes or removes tests that are not its own`), what);
      assert.ok(r.output.includes(listed), `${what} is named: ${r.output}`);
      assert.equal(r.remote(`refs/heads/qa/${TICKET}`), '', `${what}: nothing is pushed`);
      assert.equal(r.remote(`refs/heads/feat/${TICKET}`), '', `${what}: no feat branch either`);
      assert.doesNotMatch(r.calls, /pr create/, `${what}: no pull request`);
    } finally { done(s); }
  }
});

test('a writer that left no test file has nothing to publish', () => {
  const s = setup();
  try {
    write(s.work, `${APP}/src/App.tsx`, 'export const App = () => "changed";\n');
    const r = publish(s);
    assert.notEqual(r.code, 0);
    assert.match(r.output, /The QA writer wrote no test file/);
    assert.equal(r.remote(`refs/heads/qa/${TICKET}`), '');
  } finally { done(s); }
});
