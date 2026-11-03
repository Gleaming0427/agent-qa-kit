import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bwrapArgs, bwrapAvailable, sandboxMode } from '../lib/sandbox.ts';
import { APP, KIT, copyApp, runVitest } from '../lib/workspace.ts';

test('the sandbox mode is off by default and refuses unknown values', () => {
  assert.equal(sandboxMode(undefined), 'off');
  assert.equal(sandboxMode(''), 'off');
  assert.equal(sandboxMode('bwrap'), 'bwrap');
  assert.throws(() => sandboxMode('docker'), /EVAL_SANDBOX/);
});

test('the bwrap command hides folders, clears the environment and leaves one writable folder', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-bwrap-args-'));
  try {
    const variant = join(work, 'variant');
    const hidden = join(work, 'hidden');
    const modules = join(hidden, 'node_modules');
    mkdirSync(variant);
    mkdirSync(modules, { recursive: true });
    const args = bwrapArgs({ workdir: variant, hide: [hidden, '/'], readOnly: [modules, join(variant, 'inside')], env: { CI: '', PATH: '/usr/bin' } }, ['npx', 'vitest']);
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    assert.ok(args.includes('--unshare-all'), 'new network namespace: loopback only');
    assert.ok(args.includes('--clearenv'));
    assert.ok(pairs('--tmpfs').includes('/tmp') && pairs('--tmpfs').includes(hidden));
    assert.ok(!pairs('--tmpfs').includes('/'), 'the root is never hidden');
    assert.deepEqual(pairs('--ro-bind'), ['/', modules], 'node_modules is re-exposed read-only; a folder inside the variant is not');
    assert.deepEqual(pairs('--bind'), [variant], 'the variant is the only writable bind');
    // Mounts are applied in order: hidden folders first, then what is shown again, then the variant.
    const shownAgain = args.indexOf(modules) - 1;
    assert.equal(args[shownAgain], '--ro-bind');
    assert.ok(args.lastIndexOf('--tmpfs') < shownAgain && shownAgain < args.indexOf('--bind'));
    assert.deepEqual(pairs('--setenv'), ['CI', 'PATH'], 'only the given variables');
    assert.deepEqual(args.slice(args.indexOf('--') + 1), ['npx', 'vitest']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// What a generated test could try while it is scored. Each test passes only if the sandbox stops it.
const PROBE = (paths: { corpus: string; kit: string; outside: string; modules: string }) => `// @vitest-environment node
import { existsSync, writeFileSync } from 'node:fs';
import { test, expect } from 'vitest';
test('the corpus cannot be read', () => { expect(existsSync(${JSON.stringify(paths.corpus)})).toBe(false); });
test('the checkout is hidden', () => { expect(existsSync(${JSON.stringify(paths.kit)})).toBe(false); });
test('a file outside the variant is hidden', () => { expect(existsSync(${JSON.stringify(paths.outside)})).toBe(false); });
test('secrets in the environment are gone', () => { expect(process.env.EVAL_PROBE_SECRET).toBeUndefined(); });
test('the installed packages are read-only', () => { expect(() => writeFileSync(${JSON.stringify(paths.modules)}, 'x')).toThrow(); });
test('no state survives from an earlier run', () => {
  expect(existsSync('/tmp/eval-probe-marker')).toBe(false);
  writeFileSync('/tmp/eval-probe-marker', 'seen');
});
test('the network is unreachable', async () => {
  await expect(fetch('http://example.com', { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
});
`;

const canRun = bwrapAvailable().ok && existsSync(join(APP, 'node_modules/.bin/vitest'));

test('a generated test run in the sandbox cannot see the corpus, secrets, the network or earlier runs', { skip: !canRun && 'needs bwrap and npm ci in examples/shop' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-sandbox-'));
  const outside = join(work, 'outside.txt');
  const variant = join(work, 'v-probe');
  const saved = { mode: process.env.EVAL_SANDBOX, secret: process.env.EVAL_PROBE_SECRET };
  try {
    writeFileSync(outside, 'not for the tests');
    copyApp(variant, { mode: 'farm' });
    // The tests of the reference ticket stand for the corpus: the real one is in this checkout.
    const probe = { corpus: join(KIT, 'eval/tickets/EVAL-1/gold.diff'), kit: join(KIT, 'package.json'), outside, modules: join(APP, 'node_modules/eval-probe.txt') };
    writeFileSync(join(variant, 'src/probe.test.ts'), PROBE(probe));
    process.env.EVAL_PROBE_SECRET = 'sk-not-a-real-key';
    process.env.EVAL_SANDBOX = 'bwrap';
    for (const run of [1, 2]) {
      const result = runVitest(variant, ['src/probe.test.ts'], 'EVAL-1');
      assert.equal(result.ran, true, result.error);
      const failed = result.tests.filter((t) => t.status !== 'pass').map((t) => t.title);
      assert.deepEqual(failed, [], `run ${run}: the sandbox let these through`);
      assert.equal(result.tests.length, 7);
    }
    assert.equal(existsSync(probe.modules), false);
    // Without the sandbox, the same probe sees the corpus and the secret: it measures something.
    process.env.EVAL_SANDBOX = 'off';
    const open = runVitest(variant, ['src/probe.test.ts'], 'EVAL-1');
    const exposed = open.tests.filter((t) => t.status === 'fail').map((t) => t.title);
    assert.ok(exposed.some((t) => t.includes('corpus')) && exposed.some((t) => t.includes('secrets')), `unsandboxed failures: ${exposed.join('; ')}`);
  } finally {
    if (saved.mode === undefined) delete process.env.EVAL_SANDBOX; else process.env.EVAL_SANDBOX = saved.mode;
    if (saved.secret === undefined) delete process.env.EVAL_PROBE_SECRET; else process.env.EVAL_PROBE_SECRET = saved.secret;
    rmSync(join(APP, 'node_modules/eval-probe.txt'), { force: true });
    rmSync('/tmp/eval-probe-marker', { force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
