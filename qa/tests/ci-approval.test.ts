import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// qa/ci-approval.sh on a real git history, with a stand-in for the GitHub CLI: which
// "QA approval" status a QA pull request gets, on which commit, and when it gets none.
const kit = resolve(import.meta.dirname, '../..');
const TICKET = 'TICKET-43';
const REASONS = 'AC-1: the Delivery choice does not exist yet.\nAC-2: there is no Express radio to select yet.';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ci-approval-'));
  const work = join(dir, 'work');
  write(work, 'app/src/App.tsx', 'export const App = () => null;\n');
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'base');
  const bare = git(work, 'rev-parse', 'HEAD');
  // Only the criteria of the review request matter here.
  write(work, `app/qa-reviews/${TICKET}/${TICKET}-review-request.json`, JSON.stringify({ criteria: [{ id: 'AC-1' }, { id: 'AC-2' }] }));
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'QA tests');
  const tests = git(work, 'rev-parse', 'HEAD');
  write(dir, 'bin/gh', `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
case "$*" in
  'api repos/acme/shop/pulls/7') cat "${dir}/pull.json" ;;
  *'/pulls/7/reviews'*) cat "${dir}/reviews.json" ;;
  'api --silent -X POST repos/acme/shop/statuses/'*) ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  return { dir, work, bare, tests };
}

function status(s: ReturnType<typeof setup>, options: { pull?: Record<string, unknown>; head?: Record<string, unknown>; reviews?: unknown[] } = {}) {
  const pull = { number: 7, state: 'open', merged_at: null, ...options.pull,
    head: { ref: `qa/${TICKET}`, sha: s.tests, repo: { full_name: 'acme/shop' }, ...options.head } };
  writeFileSync(join(s.dir, 'pull.json'), JSON.stringify(pull));
  writeFileSync(join(s.dir, 'reviews.json'), JSON.stringify([options.reviews ?? []]));
  rmSync(join(s.dir, 'calls.log'), { force: true });
  const temp = mkdtempSync(join(s.dir, 'runner-'));
  const result = spawnSync('bash', [join(kit, 'qa/ci-approval.sh'), '7'], {
    cwd: s.work, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(s.dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/shop',
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '99', RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, 'summary') },
  });
  const calls = existsSync(join(s.dir, 'calls.log')) ? readFileSync(join(s.dir, 'calls.log'), 'utf8') : '';
  const posted = calls.split('\n').find((line) => line.includes('/statuses/'));
  return { code: result.status, output: result.stdout + result.stderr, posted,
    summary: existsSync(join(temp, 'summary')) ? readFileSync(join(temp, 'summary'), 'utf8') : '' };
}
const call = (sha: string, state: string, description: string) =>
  `api --silent -X POST repos/acme/shop/statuses/${sha} -f state=${state} -f context=QA approval -f description=${description} `
  + '-f target_url=https://github.com/acme/shop/actions/runs/99';

test('a QA pull request gets a red "QA approval" status on its latest commit until the approval is complete', () => {
  const s = setup();
  try {
    let r = status(s);
    assert.equal(r.code, 0, r.output);
    assert.equal(r.posted, call(s.tests, 'failure', 'Not approved yet. Approve with one line per criterion (AC-1, AC-2), then merge.'));
    assert.match(r.summary, /\*\*QA approval\*\* of #7 \(TICKET-43\): not complete\. Not approved yet/);

    r = status(s, { reviews: [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', commit_id: s.tests, author_association: 'OWNER', body: null }] });
    assert.equal(r.posted, call(s.tests, 'failure', '@alice approved without a reason for AC-1, AC-2. Approve again with one line per criterion.'));

    r = status(s, { reviews: [{ id: 2, user: { login: 'alice' }, state: 'APPROVED', commit_id: s.tests, author_association: 'OWNER', body: REASONS }] });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.posted, call(s.tests, 'success', 'Approved by @alice, with a reason per criterion. Ready to merge.'));
    assert.match(r.summary, /: complete\. Approved by @alice/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('GitHub gets a description of 140 characters at most', () => {
  const s = setup();
  try {
    const older = (id: number, login: string) => ({ id, user: { login }, state: 'APPROVED', commit_id: s.bare, author_association: 'MEMBER', body: REASONS });
    const r = status(s, { reviews: [older(1, 'alice-the-first-reviewer'), older(2, 'bob-the-second-reviewer'), older(3, 'carol-the-third')] });
    assert.equal(r.code, 0, r.output);
    const description = r.posted!.match(/-f description=(.*) -f target_url=/)![1];
    assert.equal(description.length, 140);
    assert.match(description, /^This pull request has no valid approval: @alice-the-first-reviewer approved an older version.*…$/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('no status for a pull request that is not a QA one, closed unmerged, from a fork, or that moved on', () => {
  const s = setup();
  try {
    for (const [options, message] of [
      [{ head: { ref: `feat/${TICKET}` } }, /#7 is not a QA pull request of this repository \(feat\/TICKET-43\)/],
      [{ head: { repo: { full_name: 'someone/shop' } } }, /#7 is not a QA pull request of this repository/],
      [{ pull: { state: 'closed' } }, /#7 was closed without merging/],
      [{ head: { sha: 'c'.repeat(40) } }, /#7 moved on to ccccccc during this run/],
    ] as const) {
      const r = status(s, options);
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, message);
      assert.equal(r.posted, undefined, r.output);
    }
    // A merged one still gets it: it can be approved after the merge, and QA verify needs that approval.
    const r = status(s, { pull: { state: 'closed', merged_at: '2026-11-07T10:41:14Z' } });
    assert.equal(r.posted, call(s.tests, 'failure', 'Merged before approval. Approve it now, one line per criterion (AC-1, AC-2): QA verify needs it.'));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a QA pull request without its review package gets a red status that says so', () => {
  const s = setup();
  try {
    const r = status(s, { head: { sha: s.bare } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.posted, call(s.bare, 'failure', `No review package qa-reviews/${TICKET}/ in this pull request: QA verify cannot check its approval.`));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
