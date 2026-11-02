import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { compare, snapshot } from '../tooling-integrity.ts';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'qa-tooling-'));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('node_modules/vitest/index.js', 'export const expect = realExpect;\n');
  write('node_modules/.vite/deps/_metadata.json', '{}');
  write('packages/app/node_modules/left-pad/index.js', 'module.exports = pad;\n');
  write('src/App.tsx', 'export const App = () => null;\n');
  mkdirSync(join(root, 'node_modules/.bin'));
  symlinkSync('../vitest/index.js', join(root, 'node_modules/.bin/vitest'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  return { root, write };
}
const none = { changed: [], added: [], removed: [] };

test('the snapshot covers installed packages and git files, not the application or tool caches', () => {
  const { root } = project();
  try {
    const files = snapshot(root);
    assert.ok(files['node_modules/vitest/index.js']);
    assert.ok(files['packages/app/node_modules/left-pad/index.js']);
    assert.equal(files['node_modules/.bin/vitest'], 'link:../vitest/index.js');
    assert.ok(files['git:config']);
    assert.ok(!Object.keys(files).some((key) => key.includes('.vite') || key.startsWith('src/')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('changes to the application and to tool caches are not reported', () => {
  const { root, write } = project();
  try {
    const before = snapshot(root);
    write('src/App.tsx', 'export const App = () => "fixed";\n');
    write('node_modules/.vite/deps/chunk.js', 'cached');
    write('node_modules/.vite-temp/vite.config.ts.timestamp.mjs', 'temporary');
    assert.deepEqual(compare(before, snapshot(root)), none);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a patched, added or removed package file, a retargeted link and a git hook are reported', () => {
  const { root, write } = project();
  try {
    const before = snapshot(root);
    write('node_modules/vitest/index.js', 'export const expect = () => ({});\n');
    write('node_modules/vitest/patch.js', 'globalThis.cheat = true;\n');
    unlinkSync(join(root, 'packages/app/node_modules/left-pad/index.js'));
    unlinkSync(join(root, 'node_modules/.bin/vitest'));
    symlinkSync('../../src/fake-vitest.js', join(root, 'node_modules/.bin/vitest'));
    write('.git/hooks/pre-commit', 'npm publish\n');
    spawnSync('git', ['config', 'core.fsmonitor', 'evil'], { cwd: root });
    assert.deepEqual(compare(before, snapshot(root)), {
      changed: ['git:config', 'node_modules/.bin/vitest', 'node_modules/vitest/index.js'],
      added: ['git:hooks/pre-commit', 'node_modules/vitest/patch.js'],
      removed: ['packages/app/node_modules/left-pad/index.js'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
