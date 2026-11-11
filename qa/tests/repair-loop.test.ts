import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const file of ['tooling-integrity.ts', 'check-tooling.ts', 'check-test-blocks.ts']) copyFileSync(join(kit, 'qa', file), join(root, 'qa', file));
  copyFileSync(join(kit, 'qa/kit-integrity.sh'), join(root, 'qa/kit-integrity.sh'));
  writeFileSync(join(root, 'node_modules/vitest/index.js'), 'export const expect = realExpect;\n');
  // What the tests are set up with: a setup file the configuration names, a helper it imports, a mock found by its name.
  for (const dir of ['src/helpers', 'src/__mocks__']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'vitest.config.ts'), "export default { test: { setupFiles: ['./src/boot.ts'] } };\n");
  writeFileSync(join(root, 'src/boot.ts'), "import { server } from './helpers/server';\nserver.listen();\n");
  writeFileSync(join(root, 'src/helpers/server.ts'), 'export const server = { listen() {} };\n');
  writeFileSync(join(root, 'src/__mocks__/api.ts'), 'export const api = {};\n');
  writeFileSync(join(root, 'src/App.tsx'), 'export const App = () => null;\n');
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
[[ -f src/patch-kit-on-test ]] && echo '// patched' >> qa/summary.ts
exit "$code"
`);
  writeFileSync(join(root, 'qa/summary.ts'), "console.log('  ✗ [TICKET-42][AC-2] search is case insensitive\\n    expected Alpha, received nothing');\n");
  writeFileSync(join(root, 'qa/scenario-review.ts'), "import { existsSync } from 'node:fs';\nprocess.exitCode = existsSync('tests-changed') ? 1 : 0;\n");
  writeFileSync(join(root, 'qa/check-tests.ts'), '');
  writeFileSync(join(root, 'bin/claude'), `#!/usr/bin/env bash
printf '%s' "$2" > "repair-request-$(ls repair-request-* 2>/dev/null | wc -l | tr -d ' ')"
while [[ $# -gt 0 ]]; do [[ "$1" == --settings ]] && printf '%s' "$2" > repair-settings-used.json; shift; done
echo "repair" >> calls
[[ "\${FAKE_TAMPER:-0}" == 1 ]] && touch tests-changed
[[ "\${FAKE_TAMPER_DEPS:-0}" == 1 ]] && echo 'export const expect = () => ({});' > node_modules/vitest/index.js
[[ "\${FAKE_PLANT:-0}" == 1 ]] && mkdir -p src && touch src/patch-on-test
[[ "\${FAKE_TAMPER_KIT:-0}" == 1 ]] && echo '// the repair'"'"'s tests ran this' >> qa/summary.ts
[[ "\${FAKE_PLANT_KIT:-0}" == 1 ]] && mkdir -p src && touch src/patch-kit-on-test
[[ "\${FAKE_TAMPER_SETUP:-0}" == 1 ]] && echo 'globalThis.expect = () => ({});' >> src/boot.ts
[[ "\${FAKE_TAMPER_HELPER:-0}" == 1 ]] && echo 'globalThis.expect = () => ({});' >> src/helpers/server.ts
[[ "\${FAKE_TAMPER_MOCK:-0}" == 1 ]] && echo 'export const api = { cheat: true };' > src/__mocks__/api.ts
[[ "\${FAKE_ADD_MOCK:-0}" == 1 ]] && echo 'export const extra = 1;' > src/__mocks__/extra.ts
[[ "\${FAKE_TAMPER_PACKAGE:-0}" == 1 ]] && echo '{ "scripts": { "test": "true" } }' > package.json
[[ "\${FAKE_FIX_APP:-0}" == 1 ]] && echo 'export const App = () => "fixed";' > src/App.tsx
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
  assert.match(r.output, /node_modules, the git files or the test setup .* changed during the repair/);
}));
test('code planted by a repair that patches packages while the tests run is caught', () => inProject([1, 0], (root) => {
  const r = run(root, { FAKE_PLANT: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify']);
  assert.match(r.output, /node_modules, the git files or the test setup .* changed during the verification/);
}));
// What the tests are set up with is checked against its state before any agent ran.
for (const [name, env, changed] of [
  ['a setup file that the test configuration names', 'FAKE_TAMPER_SETUP', 'setup:src/boot.ts'],
  ['a helper that a setup file imports', 'FAKE_TAMPER_HELPER', 'setup:src/helpers/server.ts'],
  ['a mock, found by its name', 'FAKE_TAMPER_MOCK', 'setup:src/__mocks__/api.ts'],
  ['a package.json that is written', 'FAKE_TAMPER_PACKAGE', 'setup:package.json'],
] as const) {
  test(`a repair that changes ${name} stops the loop`, () => inProject([1, 0], (root) => {
    if (env === 'FAKE_TAMPER_PACKAGE') writeFileSync(join(root, 'package.json'), '{ "scripts": { "test": "vitest run" } }\n');
    const r = run(root, { [env]: '1' });
    assert.equal(r.code, 3, r.output);
    assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair'], 'no second verification on a tampered setup');
    assert.match(r.output, new RegExp(`changed: ${changed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(r.output, /the test setup .* changed during the repair/);
  }));
}
test('a mock added by a repair stops the loop; a fix to the application does not', () => {
  inProject([1, 0], (root) => {
    const r = run(root, { FAKE_ADD_MOCK: '1' });
    assert.equal(r.code, 3, r.output);
    assert.match(r.output, /added: setup:src\/__mocks__\/extra\.ts/);
  });
  inProject([1, 0], (root) => {
    const r = run(root, { FAKE_FIX_APP: '1' });
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify']);
  });
});
test('with one allowed verification, nothing is repaired', () => inProject([1], (root) => {
  const r = run(root, { QA_MAX_VERIFY_ATTEMPTS: '1' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify']);
}));
test('a repair whose commands changed the kit stops the loop before any script of the kit runs', () => inProject([1, 0], (root) => {
  const r = run(root, { FAKE_TAMPER_KIT: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair']);
  assert.match(r.output, /the kit's own files changed during the repair \(qa\/summary\.ts\)/);
}));
test('code planted by a repair that changes the kit while the tests run stops the loop', () => inProject([1, 1, 0], (root) => {
  const r = run(root, { FAKE_PLANT_KIT: '1' });
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[0]), ['verify', 'repair', 'verify']);
  assert.match(r.output, /the kit's own files changed during the verification \(qa\/summary\.ts\)/);
}));
test('the repair agent starts with the kit\'s folders read-only in the sandbox', () => inProject([1, 0], (root) => {
  const r = run(root);
  assert.equal(r.code, 0);
  const settings = JSON.parse(readFileSync(join(root, 'repair-settings-used.json'), 'utf8'));
  assert.deepEqual(settings.sandbox.filesystem.denyWrite.sort(), [join(root, '.claude'), join(root, 'qa')].map((p) => realpathSync(p)).sort());
  assert.equal(settings.sandbox.enabled, true, 'the other sandbox settings are kept');
}));
