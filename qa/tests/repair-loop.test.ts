import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const kit = resolve(import.meta.dirname, '../..');

// A project where the verification, the summary, the review check and claude
// are stand-ins, so the loop's decisions can be tested without AI or a browser.
function project(verifications: number[]) {
  const root = mkdtempSync(join(tmpdir(), 'qa-repair-loop-'));
  for (const dir of ['qa', 'bin', 'specs', 'reports', '.claude/agents', 'node_modules/vitest']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(kit, 'qa/repair-loop.sh'), join(root, 'qa/repair-loop.sh'));
  copyFileSync(join(kit, 'qa/tooling-integrity.ts'), join(root, 'qa/tooling-integrity.ts'));
  writeFileSync(join(root, 'node_modules/vitest/index.js'), 'export const expect = realExpect;\n');
  copyFileSync(join(kit, '.claude/agents/qa-repairer.md'), join(root, '.claude/agents/qa-repairer.md'));
  copyFileSync(join(kit, '.claude/repair-settings.json'), join(root, '.claude/repair-settings.json'));
  writeFileSync(join(root, 'specs/TICKET-42.md'), '- AC-2: search is case insensitive\n');
  writeFileSync(join(root, 'codes'), `${verifications.join('\n')}\n`);
  writeFileSync(join(root, 'qa/run-qa.sh'), `#!/usr/bin/env bash
cd "$(dirname "$0")/.."
code="$(head -n 1 codes)"; sed -i.bak 1d codes
echo "verify $*" >> calls
# Test tools rewrite their caches on every run.
mkdir -p node_modules/.vite/deps && echo "$RANDOM" > node_modules/.vite/deps/_metadata.json
# Code planted by a repair runs with the tests.
[[ -f src/patch-on-test ]] && echo 'export const expect = () => ({});' > node_modules/vitest/index.js
exit "$code"
`);
  writeFileSync(join(root, 'qa/summary.ts'), "console.log('  ✗ [TICKET-42][AC-2] search is case insensitive\\n    expected Alpha, received nothing');\n");
  writeFileSync(join(root, 'qa/scenario-review.ts'), "import { existsSync } from 'node:fs';\nprocess.exitCode = existsSync('tests-changed') ? 1 : 0;\n");
  writeFileSync(join(root, 'qa/check-tests.ts'), '');
  writeFileSync(join(root, 'bin/claude'), `#!/usr/bin/env bash
printf '%s' "$2" > "repair-request-$(ls repair-request-* 2>/dev/null | wc -l | tr -d ' ')"
echo "repair" >> calls
[[ "\${FAKE_TAMPER:-0}" == 1 ]] && touch tests-changed
[[ "\${FAKE_TAMPER_DEPS:-0}" == 1 ]] && echo 'export const expect = () => ({});' > node_modules/vitest/index.js
[[ "\${FAKE_PLANT:-0}" == 1 ]] && mkdir -p src && touch src/patch-on-test
jq -n '{result: "{\\"needs_human\\": false}", total_cost_usd: 0.4, is_error: false}'
`);
  chmodSync(join(root, 'bin/claude'), 0o755);
  return root;
}
function run(root: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', [join(root, 'qa/repair-loop.sh'), 'TICKET-42', join(root, 'specs/TICKET-42.md'), 'services'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, QA_MAX_VERIFY_ATTEMPTS: '3', ...env },
  });
  const calls = existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n') : [];
  return { code: result.status, calls, output: result.stdout + result.stderr };
}
function inProject(verifications: number[], body: (root: string) => void) {
  const root = project(verifications);
  try { body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a ticket that passes needs no repair', () => inProject([0], (root) => {
  const r = run(root);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, ['verify TICKET-42 2 ' + join(root, 'specs/TICKET-42.md') + ' services']);
}));
test('a failure is repaired, then verified again', () => inProject([1, 0], (root) => {
  const r = run(root);
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify']);
  const request = readFileSync(join(root, 'repair-request-0'), 'utf8');
  assert.match(request, /expected Alpha, received nothing/);
  assert.match(request, /<spec>\n- AC-2: search is case insensitive/);
}));
test('the loop stops after the last allowed verification', () => inProject([1, 1, 1], (root) => {
  const r = run(root);
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify', 'repair', 'verify']);
  assert.match(r.output, /still fails after 3 verification\(s\)/);
}));
test('a blocked verification is never repaired', () => inProject([2], (root) => {
  const r = run(root);
  assert.equal(r.code, 2);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify']);
}));
test('a repair that touches the approved tests stops the loop', () => inProject([1, 0], (root) => {
  const r = run(root, { FAKE_TAMPER: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair']);
  assert.match(r.output, /the repair changed the approved tests/);
}));
test('a repair that patches the installed test runner stops the loop', () => inProject([1, 0], (root) => {
  const r = run(root, { FAKE_TAMPER_DEPS: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair']);
  assert.match(r.output, /changed: node_modules\/vitest\/index\.js/);
  assert.match(r.output, /node_modules or the git files changed during the repair/);
}));
test('code planted by a repair that patches packages while the tests run is caught', () => inProject([1, 0], (root) => {
  const r = run(root, { FAKE_PLANT: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify']);
  assert.match(r.output, /node_modules or the git files changed during the verification/);
}));
test('with one allowed verification, nothing is repaired', () => inProject([1], (root) => {
  const r = run(root, { QA_MAX_VERIFY_ATTEMPTS: '1' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify']);
}));
