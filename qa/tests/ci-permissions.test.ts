import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

// qa/ci-permissions.sh with a stand-in for the GitHub CLI: who is asked about, and what a refusal leaves.
const script = resolve(import.meta.dirname, '../ci-permissions.sh');

function review(login: string, state: string, association: string) {
  return { id: 1, user: { login }, state, author_association: association };
}

function run(reviews: unknown[], permissions: Record<string, string | 'fail'>) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-ci-permissions-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'permissions.json'), JSON.stringify(permissions));
  writeFileSync(join(dir, 'bin/gh'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
login="\${2#repos/acme/shop/collaborators/}"; login="\${login%/permission}"
value="$(jq -r --arg l "$login" '.[$l] // "fail"' "${dir}/permissions.json")"
[[ "$value" != fail ]] || { echo '{"message":"Resource not accessible by integration"}' >&2; exit 1; }
echo "$value"
`);
  chmodSync(join(dir, 'bin/gh'), 0o755);
  // --slurp: every page is an array, inside one array.
  writeFileSync(join(dir, 'reviews.json'), JSON.stringify([reviews]));
  const result = spawnSync('bash', [script, join(dir, 'reviews.json'), join(dir, 'out.json')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, GITHUB_REPOSITORY: 'acme/shop' },
  });
  const out = existsSync(join(dir, 'out.json')) ? JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) : null;
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : [];
  rmSync(dir, { recursive: true, force: true });
  return { code: result.status, output: result.stdout + result.stderr, out, calls };
}

test('the permission of everyone who could count is read, once, and written with the login in lower case', () => {
  const r = run([
    review('Alice', 'APPROVED', 'OWNER'), review('Alice', 'COMMENTED', 'OWNER'), review('alice', 'CHANGES_REQUESTED', 'OWNER'),
    review('bob', 'APPROVED', 'MEMBER'), review('carol', 'DISMISSED', 'COLLABORATOR'),
  ], { Alice: 'admin', alice: 'admin', bob: 'read', carol: 'write' });
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(r.out, { alice: 'admin', bob: 'read', carol: 'write' });
  assert.equal(r.calls.length, 3, `one call per login: ${r.calls.join(' | ')}`);
  assert.equal(r.calls[0], 'api repos/acme/shop/collaborators/alice/permission --jq .permission', 'the login in lower case, once for Alice and alice');
  assert.equal(r.output.trim(), '', 'nothing to warn about');
});

test('outsiders, comments and logins that are not logins are not asked about', () => {
  const r = run([
    review('passerby', 'APPROVED', 'NONE'), review('first', 'CHANGES_REQUESTED', 'FIRST_TIME_CONTRIBUTOR'),
    review('dana', 'COMMENTED', 'OWNER'), review('evil/../../x', 'APPROVED', 'OWNER'), review('bot[bot]', 'APPROVED', 'COLLABORATOR'),
    review('-leading', 'APPROVED', 'OWNER'),
  ], {});
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(r.calls, [], 'no request for a login that could change the path, and none for people who could not count anyway');
  assert.deepEqual(r.out, {});
  assert.match(r.output, /::warning title=QA approval::Could not read the repository permission of -leading bot\[bot\] evil\/\.\.\/\.\.\/x/);
});

test('a permission that cannot be read is left out and named in a warning, the others are kept', () => {
  const r = run([review('alice', 'APPROVED', 'OWNER'), review('bob', 'APPROVED', 'COLLABORATOR')], { alice: 'write', bob: 'fail' });
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(r.out, { alice: 'write' });
  assert.match(r.output, /::warning title=QA approval::Could not read the repository permission of bob: their review counts if GitHub calls them an owner, a member or a collaborator, even with read access only\./);
});

test('no review at all, and a missing file, are handled', () => {
  const none = run([], {});
  assert.equal(none.code, 0, none.output);
  assert.deepEqual(none.out, {});
  const usage = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: qa\/ci-permissions\.sh/);
});
