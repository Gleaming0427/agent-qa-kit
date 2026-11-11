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

// What the tests are set up with: package.json, the test configuration, its setup files and what they import,
// and the files that are test support by name.
function setupProject(options: { git?: boolean } = {}) {
  const { root, write } = project();
  if (options.git === false) rmSync(join(root, '.git'), { recursive: true, force: true });
  write('package.json', '{ "scripts": { "test": "vitest run" } }\n');
  write('vitest.config.ts', "export default { test: { setupFiles: ['./src/boot.ts', '@vitest/ui-setup'] } };\n");
  write('src/boot.ts', "import './helpers/matchers';\nimport { server } from './helpers/server.ts';\nconst lazy = () => import('../test/lazy');\nexport { server, lazy };\n");
  write('src/helpers/matchers.ts', "export * from './more';\n");
  write('src/helpers/more.ts', 'export const more = 1;\n');
  write('src/helpers/server.ts', "export const server = {};\n");
  write('test/lazy.ts', 'export const lazy = 1;\n');
  write('src/__mocks__/api.ts', 'export const api = {};\n');
  write('src/setupTests.ts', "import '@testing-library/jest-dom';\n");
  write('src/unrelated.ts', "import './helpers/more';\n");
  return { root, write };
}

test('the snapshot covers package.json, the test configuration, the setup files it names, what those import, and the support files by name', () => {
  const { root } = setupProject();
  try {
    const keys = Object.keys(snapshot(root)).filter((key) => key.startsWith('setup:')).sort();
    assert.deepEqual(keys, [
      'setup:package.json', 'setup:src/__mocks__/api.ts', 'setup:src/boot.ts', 'setup:src/helpers/matchers.ts', 'setup:src/helpers/more.ts',
      'setup:src/helpers/server.ts', 'setup:src/setupTests.ts', 'setup:test/lazy.ts', 'setup:vitest.config.ts',
    ]);
    assert.ok(!keys.includes('setup:src/unrelated.ts') && !keys.includes('setup:src/App.tsx'), 'the application is not');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a change to a setup file, an imported helper, a mock or package.json is reported; a change to the application is not', () => {
  const { root, write } = setupProject();
  try {
    const before = snapshot(root);
    write('src/App.tsx', 'export const App = () => "fixed";\n');
    write('src/unrelated.ts', 'export const x = 2;\n');
    assert.deepEqual(compare(before, snapshot(root)), none);

    write('src/boot.ts', `${"import './helpers/matchers';\nimport { server } from './helpers/server.ts';\n"}globalThis.expect = () => ({});\n`);
    write('src/helpers/more.ts', 'export const more = 2;\n');
    write('src/__mocks__/api.ts', 'export const api = { cheat: true };\n');
    write('package.json', '{ "scripts": { "test": "true" } }\n');
    write('src/__mocks__/extra.ts', 'export const extra = 1;\n');
    unlinkSync(join(root, 'src/setupTests.ts'));
    assert.deepEqual(compare(before, snapshot(root)), {
      changed: ['setup:package.json', 'setup:src/__mocks__/api.ts', 'setup:src/boot.ts', 'setup:src/helpers/more.ts'],
      added: ['setup:src/__mocks__/extra.ts'],
      removed: ['setup:src/setupTests.ts'],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a setup file that starts importing a new helper brings that helper in, so the helper is checked next time', () => {
  const { root, write } = setupProject();
  try {
    write('src/helpers/extra.ts', 'export const extra = 1;\n');
    const before = snapshot(root);
    assert.ok(!('setup:src/helpers/extra.ts' in before), 'not imported by a setup file yet');
    write('src/boot.ts', `import './helpers/extra';\n${"import './helpers/matchers';\nimport { server } from './helpers/server.ts';\n"}`);
    const difference = compare(before, snapshot(root));
    assert.deepEqual(difference.changed, ['setup:src/boot.ts']);
    assert.deepEqual(difference.added, ['setup:src/helpers/extra.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without git the folder is walked: node_modules and .git are left to their own entries', () => {
  const { root } = setupProject({ git: false });
  try {
    const keys = Object.keys(snapshot(root));
    assert.ok(keys.includes('setup:src/boot.ts') && keys.includes('setup:src/helpers/more.ts') && keys.includes('setup:src/__mocks__/api.ts'));
    assert.ok(!keys.some((key) => key.startsWith('setup:node_modules')), 'packages have their own entries');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a project with no test configuration still has its support files by name checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-tooling-bare-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/App.tsx'), 'x\n');
    assert.deepEqual(Object.keys(snapshot(root)).filter((key) => key.startsWith('setup:')), []);
    writeFileSync(join(root, 'src/test-utils.tsx'), 'x\n');
    assert.deepEqual(Object.keys(snapshot(root)).filter((key) => key.startsWith('setup:')), ['setup:src/test-utils.tsx']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
