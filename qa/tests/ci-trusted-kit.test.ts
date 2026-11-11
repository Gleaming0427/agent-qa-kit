import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, '../ci-trusted-kit.sh');

function write(root: string, path: string, content: string, mode = 0o644) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  chmodSync(join(root, path), mode);
}
// A checkout holding the kit, as a git repository so that the version of the agents can be read.
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-trusted-kit-'));
  const src = join(dir, 'checkout');
  write(src, 'qa/run-qa.sh', '#!/usr/bin/env bash\necho running from "$0"\n', 0o755);
  write(src, 'qa/hello.ts', "import { sep } from 'node:path';\nconsole.log(`hello${sep}`);\n");
  write(src, '.claude/hooks/qa-guard.sh', '#!/usr/bin/env bash\n', 0o755);
  write(src, 'src/App.tsx', 'export const App = () => null;\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'kit']]) {
    const result = spawnSync('git', args, { cwd: src, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { dir, src, dest: join(dir, 'trusted', 'qa-kit') };
}
function copy(src: string, dest: string, folder = src) {
  const result = spawnSync('bash', [script, folder], { cwd: src, encoding: 'utf8', env: { ...process.env, QA_TRUSTED_KIT: dest } });
  return { code: result.status, output: result.stdout + result.stderr };
}
function everything(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((e) => join(e.parentPath, e.name));
}
const writable = (path: string) => (lstatSync(path).mode & 0o222) !== 0;

test('the kit is copied where the job\'s code cannot change it: nothing in the copy is writable', () => {
  const c = checkout();
  try {
    const r = copy(c.src, c.dest);
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Trusted kit: .*qa-kit, copied from /);
    assert.ok(existsSync(join(c.dest, 'qa/run-qa.sh')));
    assert.ok(existsSync(join(c.dest, '.claude/hooks/qa-guard.sh')));
    assert.ok(!existsSync(join(c.dest, 'src')), 'only qa/ and .claude/ are copied');
    assert.deepEqual(everything(c.dest).filter(writable), [], 'no file or folder of the copy is writable');
    assert.equal(writable(c.dest), false);
    assert.ok(lstatSync(join(c.dest, 'qa/run-qa.sh')).mode & 0o111, 'executable bits are kept');
    // Whoever is not root cannot write to it either; root is the owner on a runner (sudo).
    assert.equal(readFileSync(join(c.dest, 'package.json'), 'utf8'), '{\n  "type": "module"\n}\n');
  } finally { spawnSync('chmod', ['-R', 'u+w', c.dir]); rmSync(c.dir, { recursive: true, force: true }); }
});

test('the copy records the version of the agents and runs the kit\'s TypeScript as modules', () => {
  const c = checkout();
  try {
    assert.equal(copy(c.src, c.dest).code, 0);
    const tree = spawnSync('git', ['rev-parse', '--short', 'HEAD:.claude'], { cwd: c.src, encoding: 'utf8' }).stdout.trim();
    assert.equal(readFileSync(join(c.dest, '.claude-tree'), 'utf8').trim(), tree);
    const ran = spawnSync('node', [join(c.dest, 'qa/hello.ts')], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /^hello\//);
  } finally { spawnSync('chmod', ['-R', 'u+w', c.dir]); rmSync(c.dir, { recursive: true, force: true }); }
});

test('what the job does to the checkout afterwards does not reach the copy, and a second copy replaces the first', () => {
  const c = checkout();
  try {
    assert.equal(copy(c.src, c.dest).code, 0);
    writeFileSync(join(c.src, 'qa/run-qa.sh'), 'echo tampered\n');
    assert.match(readFileSync(join(c.dest, 'qa/run-qa.sh'), 'utf8'), /running from/);
    assert.equal(copy(c.src, c.dest).code, 0, 'a read-only copy from an earlier run can be replaced');
    assert.match(readFileSync(join(c.dest, 'qa/run-qa.sh'), 'utf8'), /tampered/);
  } finally { spawnSync('chmod', ['-R', 'u+w', c.dir]); rmSync(c.dir, { recursive: true, force: true }); }
});

test('a link in the kit, a missing folder and an unsafe destination are refused', () => {
  const c = checkout();
  try {
    symlinkSync('/etc', join(c.src, 'qa/etc'));
    let r = copy(c.src, c.dest);
    assert.equal(r.code, 1);
    assert.match(r.output, /symbolic link, which would escape the copy: qa\/etc/);
    rmSync(join(c.src, 'qa/etc'));

    r = copy(c.src, c.dest, join(c.dir, 'nothing-here'));
    assert.equal(r.code, 1);
    assert.match(r.output, /usage: bash qa\/ci-trusted-kit\.sh/);

    for (const dest of ['/', 'relative/path', c.src, join(c.src, 'inside')]) {
      r = copy(c.src, dest);
      assert.equal(r.code, 1, dest);
      assert.match(r.output, /unsafe destination/, dest);
    }
    assert.ok(existsSync(join(c.src, 'qa/run-qa.sh')), 'the source is untouched');
  } finally { spawnSync('chmod', ['-R', 'u+w', c.dir]); rmSync(c.dir, { recursive: true, force: true }); }
});
