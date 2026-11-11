import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { isConfig, isSupportFile, setupFilesOf, toolingChanges, type Reader } from '../check-tooling.ts';

const script = resolve(import.meta.dirname, '../check-tooling.ts');

// A reader over two versions of some files.
const sides = (base: Record<string, string>, head: Record<string, string>): Reader => (side, file) => (side === 'base' ? base : head)[file] ?? null;
const pkg = (scripts: Record<string, string>, extra: object = {}) => JSON.stringify({ name: 'app', scripts, ...extra });

test('the files that decide how tests run are recognised', () => {
  for (const file of ['vitest.config.ts', 'vite.config.mts', 'apps/web/playwright.config.js', 'vitest.workspace.ts', 'packages/ui/vitest.config.cjs']) assert.ok(isConfig(file), file);
  for (const file of ['src/vite.config.d.ts.map', 'docs/vitest.config.md', 'src/App.tsx', 'my-vitest.config.ts.bak']) assert.ok(!isConfig(file), file);
});

test('the setup files a configuration names are found, relative to the repository', () => {
  const config = `export default defineConfig({
    test: { setupFiles: ['./src/setupTests.ts', "./test/extra.ts", '@vitest/setup'], globalSetup: "../shared/global.ts" },
    globalTeardown: \`./teardown.ts\`,
  });`;
  assert.deepEqual(setupFilesOf('apps/web/vitest.config.ts', config), [
    { key: 'setupFiles', file: 'apps/web/src/setupTests.ts' },
    { key: 'setupFiles', file: 'apps/web/test/extra.ts' },
    { key: 'globalSetup', file: 'apps/shared/global.ts' },
    { key: 'globalTeardown', file: 'apps/web/teardown.ts' },
  ]);
  assert.deepEqual(setupFilesOf('vitest.config.ts', "export default { test: { include: ['src/**/*.test.ts'] } };"), []);
});

test('a change to a script that runs the tests or the install is reported, a change to the dependencies is not', () => {
  const base = { 'package.json': pkg({ 'test:unit': 'vitest run', 'test:e2e': 'playwright test', build: 'tsc', start: 'node server.js' }, { dependencies: { react: '19.1.1' } }) };
  const head = { 'package.json': pkg({ 'test:unit': 'vitest run || true', 'test:e2e': 'playwright test', build: 'tsc && cp x y', start: 'node server.js', postinstall: 'node patch.js', 'qa:setup': 'pnpm build' }, { dependencies: { react: '19.2.0', left: '1.0.0' } }) };
  const changes = toolingChanges(['package.json'], sides(base, head));
  assert.deepEqual(changes, [
    { kind: 'setup', file: 'package.json', why: 'script "postinstall" added' },
    { kind: 'setup', file: 'package.json', why: 'script "qa:setup" added' },
    { kind: 'setup', file: 'package.json', why: 'script "test:unit" changed' },
  ]);
  assert.deepEqual(toolingChanges(['package.json'], sides(base, { 'package.json': pkg({ 'test:unit': 'vitest run', 'test:e2e': 'playwright test', build: 'x', start: 'y' }, { dependencies: { react: '20.0.0' } }) })), [],
    'build and start are not watched; dependencies are not scripts');
  assert.deepEqual(toolingChanges(['package.json'], sides(base, { 'package.json': pkg({ 'test:e2e': 'playwright test' }) })), [
    { kind: 'setup', file: 'package.json', why: 'script "test:unit" removed' },
  ]);
  assert.deepEqual(toolingChanges(['package.json'], sides(base, { 'package.json': '{ not json' })), [
    { kind: 'setup', file: 'package.json', why: 'script "test:e2e" removed' },
    { kind: 'setup', file: 'package.json', why: 'script "test:unit" removed' },
  ], 'a package.json that no longer parses removes the watched scripts');
});

test('a configuration that changed, and a setup file that changed under a configuration that did not', () => {
  const config = "export default { test: { setupFiles: ['./src/setupTests.ts'] } };";
  assert.deepEqual(toolingChanges(['vitest.config.ts'], sides({ 'vitest.config.ts': config }, { 'vitest.config.ts': `${config}\n// x` }), ['vitest.config.ts']),
    [{ kind: 'setup', file: 'vitest.config.ts', why: 'the configuration of the tests' }], 'the configuration is reported; its setup file is not, as it did not change');
  const same = sides({ 'vitest.config.ts': config }, { 'vitest.config.ts': config });
  assert.deepEqual(toolingChanges(['src/setupTests.ts'], same, ['vitest.config.ts']), [
    { kind: 'setup', file: 'src/setupTests.ts', why: 'named in vitest.config.ts as setupFiles' },
  ]);
  assert.deepEqual(toolingChanges(['src/App.tsx', 'src/setupOther.ts'], same, ['vitest.config.ts']), [], 'other files are not reported');
  // A pull request that adds the setup file together with the line that names it: reported once.
  const added = sides({}, { 'vitest.config.ts': config });
  assert.deepEqual(toolingChanges(['vitest.config.ts', 'src/setupTests.ts'], added, ['vitest.config.ts']).map((c) => c.file), ['vitest.config.ts', 'src/setupTests.ts']);
});

test('the kit\'s own files are reported as such', () => {
  const changes = toolingChanges(['qa/ci-verify.sh', '.claude/agents/qa-writer.md', '.github/workflows/qa-verify.yml', '.github/workflows/build.yml', '.agent-qa-kit.json', 'src/qa/App.tsx', 'docs/qa/x.md'], sides({}, {}));
  assert.deepEqual(changes.map((c) => [c.kind, c.file]), [
    ['kit', '.agent-qa-kit.json'], ['kit', '.claude/agents/qa-writer.md'], ['kit', '.github/workflows/qa-verify.yml'], ['kit', 'qa/ci-verify.sh'],
  ]);
});

// The command on a real history: what the pull request changed since it branched, not what the base did.
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-check-tooling-'));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (changes: Record<string, string>) => {
    for (const [path, content] of Object.entries(changes)) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); }
  };
  git('init', '-q', '-b', 'main');
  put(files); git('add', '-A'); git('commit', '-qm', 'base');
  return { dir, git, put };
}
const run = (dir: string, ...args: string[]) => {
  const r = spawnSync('node', [script, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('the command compares the pull request with the commit it branched from', () => {
  const r = repo({
    'package.json': pkg({ 'test:unit': 'vitest run' }), 'vitest.config.ts': "export default { test: { setupFiles: ['./src/setup.ts'] } };", 'src/setup.ts': 'export {};\n', 'src/App.tsx': 'x\n',
  });
  try {
    r.git('checkout', '-qb', 'feature');
    r.put({ 'src/App.tsx': 'y\n', 'src/setup.ts': 'export const patched = true;\n' });
    r.git('commit', '-qam', 'feature');
    // The base moves on, and changes the scripts: not the pull request's doing.
    r.git('checkout', '-q', 'main');
    r.put({ 'package.json': pkg({ 'test:unit': 'vitest run --coverage' }) });
    r.git('commit', '-qam', 'base moves on');
    r.git('checkout', '-q', 'feature');

    const result = run(r.dir, 'main', 'feature');
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(JSON.parse(result.out).changes, [{ kind: 'setup', file: 'src/setup.ts', why: 'named in vitest.config.ts as setupFiles' }]);

    const clean = run(r.dir, 'feature', 'feature');
    assert.deepEqual(JSON.parse(clean.out).changes, [], 'nothing changed against itself');
    assert.equal(run(r.dir, 'no-such-branch').code, 2);
    assert.match(run(r.dir, 'no-such-branch').err, /Cannot compare no-such-branch with HEAD/);
    assert.equal(run(r.dir).code, 2);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

const SUPPORT = [
  'src/setupTests.ts', 'src/setup-tests.tsx', 'src/setup_tests.js', 'src/SetupTests.TS', 'src/testSetup.ts', 'src/test-setup.mts', 'vitest.setup.ts', 'jest.setup.js',
  'e2e-support/auth.setup.ts', 'support/global.teardown.ts', 'apps/shop/globalSetup.ts', 'global-teardown.cjs', 'src/test-utils.tsx', 'src/testUtils.ts', 'src/test_helpers.ts', 'src/testHelper.ts',
  'src/__mocks__/api.ts', 'apps/shop/__fixtures__/cart.json', 'src/__tests__/helpers.ts', 'src/tests/helpers.ts', 'test/render.tsx', 'apps/shop/test/render.tsx', 'src/testing/server.ts', 'src/test-utils/index.ts',
];
const NOT_SUPPORT = [
  'src/setup.ts', 'src/App.tsx', 'src/utils.ts', 'src/TestimonialList.tsx', 'src/latest/cart.ts', 'src/contest/entry.ts', 'src/testing-library.md', 'src/setupTests.d.ts', 'src/protests/x.ts', 'src/helpers.ts', 'README.md',
];

test('test support is recognised by its name: setup files, mocks, fixtures and helpers, not the application', () => {
  for (const file of SUPPORT) assert.ok(isSupportFile(file), `${file} is test support`);
  for (const file of NOT_SUPPORT) assert.ok(!isSupportFile(file), `${file} is not`);
});

test('the guard that stops the repair agent holds the same names as isSupportFile', () => {
  const guard = resolve(import.meta.dirname, '../../.claude/hooks/qa-guard.sh');
  const denied = (file: string) => {
    const result = spawnSync('bash', [guard], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, new_string: 'x' } }), encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: '/project', QA_GUARD_MODE: 'repair' },
    });
    return result.status === 2 && /set up with/.test(result.stderr);
  };
  for (const file of [...SUPPORT, ...NOT_SUPPORT]) assert.equal(denied(file), isSupportFile(file), `${file}: the guard and isSupportFile disagree`);
});

test('a pull request that changes a mock, a fixture or a helper is told so; a test file in a tests folder is not', () => {
  const changes = toolingChanges(['src/__mocks__/api.ts', 'src/tests/helpers.ts', 'src/tests/search.test.ts', 'e2e/TICKET-1.spec.ts', 'src/App.tsx', 'src/test-utils.tsx'], sides({}, {}));
  assert.deepEqual(changes.map((c) => [c.kind, c.file, c.why]), [
    ['setup', 'src/__mocks__/api.ts', 'a test setup, mock or helper file'],
    ['setup', 'src/test-utils.tsx', 'a test setup, mock or helper file'],
    ['setup', 'src/tests/helpers.ts', 'a test setup, mock or helper file'],
  ]);
  // A setup file that a configuration names keeps its more precise reason, and a kit file stays a kit file.
  const config = "export default { test: { setupFiles: ['./src/setupTests.ts'] } };";
  assert.deepEqual(toolingChanges(['src/setupTests.ts', 'qa/tests/ci.test.ts', 'qa/tests/helpers.ts'], sides({ 'vitest.config.ts': config }, { 'vitest.config.ts': config }), ['vitest.config.ts']).map((c) => [c.kind, c.why]), [
    ['kit', 'a file of the kit'], ['kit', 'a file of the kit'], ['setup', 'named in vitest.config.ts as setupFiles'],
  ]);
});
