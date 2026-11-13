import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { findBlocks, lostBlocks, scan, violations, type Reader } from '../check-test-blocks.ts';

const script = resolve(import.meta.dirname, '../check-test-blocks.ts');

const FILE = `import { render } from '@testing-library/react';
describe('search', () => {
  beforeEach(() => { vi.resetModules(); });
  it('[TICKET-42][AC-1] shows the clear button', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: /clear/i })).toBeVisible();
  });
  it('an older behaviour', () => { expect(1).toBe(1); });
});
test('[TICKET-50][AC-2] sorts', async ({ page }) => {
  await page.goto('/');
});
`;

test('tests and hooks are found, with their ticket, in order', () => {
  const blocks = findBlocks(FILE);
  assert.deepEqual(blocks.map((b) => [b.kind, b.call, b.ticket, b.title, b.line]), [
    ['hook', 'beforeEach', null, null, 3],
    ['test', 'it', 'TICKET-42', '[TICKET-42][AC-1] shows the clear button', 4],
    ['test', 'it', null, 'an older behaviour', 8],
    ['test', 'test', 'TICKET-50', '[TICKET-50][AC-2] sorts', 10],
  ]);
  assert.match(blocks[1].text, /^it\('\[TICKET-42\]\[AC-1\] shows the clear button', \(\) => \{\nrender\(<App \/>\);\nexpect\(/, 'indentation and blank lines are dropped from the text');
});

test('the ticket tag must be [TICKET-N][AC-N]: a ticket name or a criterion alone is not a tag', () => {
  const tickets = (source: string) => findBlocks(source).map((b) => b.ticket);
  assert.deepEqual(tickets("it('[TICKET-42] no criterion', () => {});"), [null]);
  assert.deepEqual(tickets("it('[AC-1] no ticket', () => {});"), [null]);
  assert.deepEqual(tickets("it('[AB2-7] [AC-12] spaced', () => {});"), ['AB2-7']);
  assert.deepEqual(tickets('it(`[TICKET-9][AC-1] template title`, () => {});'), ['TICKET-9']);
  assert.deepEqual(tickets('it(\n  "[TICKET-9][AC-1] title on the next line",\n  () => {},\n);'), ['TICKET-9']);
});

test('brackets in strings, templates, comments and regular expressions do not end a test early', () => {
  const source = [
    "it('[TICKET-1][AC-1] odd text', () => {",
    "  const a = ')))';",
    '  const b = `)) ${ fn(")") + `(${ 1 })` } ((`;',
    '  // ) a comment with a bracket',
    '  /* ) another ( */',
    '  const c = /\\)+[)]/g.test(a);',
    "  expect(a).toBe(')');",
    '});',
    "it('after', () => {});",
  ].join('\n');
  const blocks = findBlocks(source);
  assert.deepEqual(blocks.map((b) => b.title), ['[TICKET-1][AC-1] odd text', 'after']);
  assert.ok(blocks[0].text.endsWith("expect(a).toBe(')');\n})"), blocks[0].text);
  const { code } = scan("const x = 'it(' + `test(${ 1 })`; // it( here\n");
  assert.ok(!code.includes('it(') && !code.includes('test('), 'calls named inside strings and comments are not code');
});

test('modifiers: skip and fixme are tests, describe, use and step are not, it.each takes its title from the second call', () => {
  // Built apart: the repository's own check (qa/check-tests.ts) refuses a skipped test written out in any test file.
  const skip = ['test', 'skip'].join('.');
  const source = `
${skip}('[TICKET-1][AC-1] skipped', () => {});
test.describe('[TICKET-2][AC-1] group', () => { test.use({ locale: 'fr' }); });
test.beforeEach(async ({ page }) => { await page.goto('/'); });
it.each([[1], [2]])('[TICKET-3][AC-1] row %s', (n) => { expect(n).toBeGreaterThan(0); });
expect.extend({});
foo.it('not a test', () => {});
`;
  assert.deepEqual(findBlocks(source).map((b) => [b.kind, b.call, b.title]), [
    ['test', 'test.skip', '[TICKET-1][AC-1] skipped'],
    ['hook', 'test.beforeEach', null],
    ['test', 'it.each', '[TICKET-3][AC-1] row %s'],
  ]);
  assert.ok(findBlocks(source)[2].text.endsWith('toBeGreaterThan(0); })'), 'the whole of it.each(rows)(title, fn)');
});

test('a call that never closes runs to the end of the file, so cutting a test short is a change', () => {
  const whole = "it('[TICKET-1][AC-1] a', () => { expect(1).toBe(1); });\nit('b', () => {});\n";
  const cut = "it('[TICKET-1][AC-1] a', () => { expect(1).toBe(1);\nit('b', () => {});\n";
  assert.equal(findBlocks(cut).length, 2);
  assert.deepEqual(lostBlocks(whole, cut).map((b) => b.title), ['[TICKET-1][AC-1] a'], 'the test that follows is still found, and unchanged');
});

test('a test is unchanged when only its indentation or blank lines moved; a changed assertion, a removal or a move to another file is not', () => {
  assert.deepEqual(lostBlocks(FILE, FILE.replace(/\n {2}/g, '\n\n      ')), []);
  const weaker = FILE.replace('.toBeVisible()', '.toBeDefined()');
  assert.deepEqual(lostBlocks(FILE, weaker).map((b) => b.title), ['[TICKET-42][AC-1] shows the clear button']);
  assert.deepEqual(lostBlocks(FILE, FILE.replace(/it\('an older behaviour'.*\n/, '')).map((b) => b.title), ['an older behaviour']);
  assert.deepEqual(lostBlocks(FILE, null).length, 4, 'a deleted file loses every test and hook');
  assert.deepEqual(lostBlocks(FILE, `${FILE}\nit('[TICKET-77][AC-1] brand new', () => {});\n`), [], 'adding a test loses nothing');
  const twice = "it('same', () => {});\nit('same', () => {});\n";
  assert.deepEqual(lostBlocks(twice, "it('same', () => {});\n").length, 1, 'two identical tests are counted twice');
});

// A reader over two versions of some files.
const sides = (oldFiles: Record<string, string>, newFiles: Record<string, string>): Reader => (side, file) => (side === 'old' ? oldFiles : newFiles)[file] ?? null;

test('others: a pull request may not change the tests of a ticket it does not name', () => {
  const weaker = FILE.replace('.toBeVisible()', '.toBeDefined()');
  const files = ['src/App.test.tsx'];
  const found = violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': weaker }), 'others', []);
  assert.deepEqual(found.map((v) => [v.file, v.block.ticket, v.block.line]), [['src/App.test.tsx', 'TICKET-42', 4]]);
  assert.deepEqual(violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': weaker }), 'others', ['TICKET-42']), [],
    'the pull request that names the ticket is judged against the QA branch instead');
  assert.deepEqual(violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': weaker }), 'others', ['TICKET-50']).length, 1, 'naming another ticket does not help');
  assert.deepEqual(violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': FILE.replace("'an older behaviour'", "'an older behaviour, changed'") }), 'others', []), [],
    'a test that belongs to no ticket is not protected by this check');
  assert.equal(violations(files, sides({ 'src/App.test.tsx': FILE }, {}), 'others', []).length, 2, 'deleting the file removes both tickets\' tests');
  assert.deepEqual(violations(['src/App.tsx'], sides({ 'src/App.tsx': FILE }, { 'src/App.tsx': '' }), 'others', []), [], 'only test files are read');
  assert.deepEqual(violations(files, sides({}, { 'src/App.test.tsx': FILE }), 'others', []), [], 'a new test file has nothing to lose');
});

test('own: the QA agent may add tests and rewrite its own, never another test or a hook', () => {
  const files = ['src/App.test.tsx'];
  const check = (next: string, tickets = ['TICKET-42']) => violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': next }), 'own', tickets).map((v) => v.block.title ?? v.block.call);
  assert.deepEqual(check(`${FILE}\nit('[TICKET-42][AC-2] new', () => {});\n`), []);
  assert.deepEqual(check(FILE.replace('.toBeVisible()', '.toBeDefined()')), [], 'its own ticket\'s test may change');
  assert.deepEqual(check(FILE.replace('.toBeVisible()', '.toBeDefined()'), ['TICKET-99']), ['[TICKET-42][AC-1] shows the clear button'], 'the test of another ticket may not');
  assert.deepEqual(check(FILE.replace('toBe(1)', 'toBe(2)')), ['an older behaviour'], 'a test with no ticket may not');
  assert.deepEqual(check(FILE.replace('vi.resetModules()', 'vi.useFakeTimers()')), ['beforeEach'], 'a hook may not');
  assert.deepEqual(check(FILE.replace("await page.goto('/')", 'await page.goto("/other")')), ['[TICKET-50][AC-2] sorts']);
  assert.deepEqual(violations(files, sides({ 'src/App.test.tsx': FILE }, { 'src/App.test.tsx': FILE.replace('toBe(1)', 'toBe(2)') }), 'own', []).length, 1, 'with no ticket given, nothing may change');
});

// --- the program, on a real history

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function run(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

test('on a real history: main moving on does not count, a moved test file does, a named ticket is left to the frozen check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-test-blocks-'));
  try {
    git(dir, 'init', '-q');
    put(dir, 'src/App.test.tsx', FILE);
    put(dir, 'src/other.test.ts', "it('[TICKET-60][AC-1] other', () => { expect(2).toBe(2); });\n");
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');

    git(dir, 'switch', '-qc', 'fix/unnamed');
    put(dir, 'src/App.test.tsx', FILE.replace('.toBeVisible()', '.toBeDefined()'));
    git(dir, 'commit', '-qam', 'weaken a test');

    git(dir, 'switch', '-q', 'main');
    git(dir, 'switch', '-qc', 'feat/ok');
    put(dir, 'src/App.tsx', 'export const a = 1;\n');
    put(dir, 'src/App.test.tsx', `${FILE}\nit('[TICKET-42][AC-3] added later', () => {});\n`);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'add a test');

    git(dir, 'switch', '-q', 'main');
    git(dir, 'switch', '-qc', 'chore/moved');
    git(dir, 'mv', 'src/other.test.ts', 'src/renamed.test.ts');
    git(dir, 'commit', '-qm', 'rename a test file');

    // main moves on and changes a test: a branch made before that is not blamed for it.
    git(dir, 'switch', '-q', 'main');
    put(dir, 'src/other.test.ts', "it('[TICKET-60][AC-1] other', () => { expect(2).toBe(3); });\n");
    git(dir, 'commit', '-qam', 'main amends a test');
    git(dir, 'switch', '-qc', 'feat/old-branch', 'HEAD~1');
    put(dir, 'README.md', 'docs\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'docs');

    const unnamed = run(dir, 'others', 'main', 'fix/unnamed');
    assert.equal(unnamed.code, 1, unnamed.out);
    assert.match(unnamed.out, /src\/App\.test\.tsx:4 {2}\[TICKET-42\] \[TICKET-42\]\[AC-1\] shows the clear button/);
    assert.match(unnamed.out, /does not name/);
    assert.equal(run(dir, 'others', 'main', 'fix/unnamed', 'TICKET-42').code, 0, 'named: the frozen check judges it');
    assert.match(run(dir, 'others', 'main', 'feat/ok').out, /respected/);
    const moved = run(dir, 'others', 'main', 'chore/moved');
    assert.equal(moved.code, 1, 'a moved test file is a removed one');
    assert.match(moved.out, /src\/other\.test\.ts:1 {2}\[TICKET-60\]/);
    assert.equal(run(dir, 'others', 'main', 'feat/old-branch').code, 0, 'the amendment is on main, not in this branch');
    assert.equal(run(dir, 'own', 'main', 'feat/ok', 'TICKET-42').code, 0);
    assert.equal(run(dir, 'own', 'main', 'fix/unnamed', 'TICKET-99').code, 1);
    assert.match(run(dir, 'own', 'main', 'fix/unnamed', 'TICKET-99').out, /QA branch of TICKET-99 changes or removes tests that are not its own/);
    assert.equal(run(dir, 'others', 'main', 'nowhere').code, 2, 'an unknown ref is a usage error, not a pass');
    assert.equal(run(dir, 'both', 'main', 'feat/ok').code, 2);
    assert.equal(run(dir, 'others', 'main', 'feat/ok', 'not-a-ticket').code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
