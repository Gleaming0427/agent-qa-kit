import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyDiff, classifyChanges, criteriaOf } from '../lib/workspace.ts';

const DIFF = `diff --git a/src/a.txt b/src/a.txt
--- a/src/a.txt
+++ b/src/a.txt
@@ -1 +1 @@
-before
+after
`;

function git(cwd: string, ...args: string[]) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
}

test('a diff applies to an application in a subfolder of a repository', () => {
  // Plain git apply would read src/a.txt from the repository root and skip it without an error.
  const repo = mkdtempSync(join(tmpdir(), 'eval-apply-'));
  try {
    const app = join(repo, 'examples/shop');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'src/a.txt'), 'before\n');
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    writeFileSync(join(repo, 'change.diff'), DIFF);
    applyDiff(app, join(repo, 'change.diff'));
    assert.equal(readFileSync(join(app, 'src/a.txt'), 'utf8'), 'after\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a diff applies to a workspace that is its own repository', () => {
  const ws = mkdtempSync(join(tmpdir(), 'eval-apply-ws-'));
  try {
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src/a.txt'), 'before\n');
    git(ws, 'init', '-q');
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'base');
    const diff = join(tmpdir(), `eval-apply-${process.pid}.diff`);
    writeFileSync(diff, DIFF);
    applyDiff(ws, diff);
    rmSync(diff);
    assert.equal(readFileSync(join(ws, 'src/a.txt'), 'utf8'), 'after\n');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('empty sandbox placeholders are set aside; any other change still counts', () => {
  const result = classifyChanges([
    { code: '??', path: 'e2e/EVAL-1.spec.ts', size: 900 },
    { code: '??', path: 'src/EVAL-1.test.tsx', size: 700 },
    { code: '??', path: '.env', size: 0 },
    { code: '??', path: 'yarn.lock', size: 0 },
    // A placeholder name with content, or below the root, is a real change.
    { code: '??', path: '.npmrc', size: 42 },
    { code: '??', path: 'src/.env', size: 0 },
    { code: ' M', path: 'src/App.tsx', size: 2000 },
    { code: ' M', path: 'e2e/smoke.spec.ts', size: 900 },
  ]);
  assert.deepEqual(result.tests, ['e2e/EVAL-1.spec.ts', 'src/EVAL-1.test.tsx']);
  assert.deepEqual(result.placeholders, ['.env', 'yarn.lock']);
  assert.deepEqual(result.others, ['.npmrc', 'src/.env', 'src/App.tsx', 'e2e/smoke.spec.ts']);
});

test('criteria are read from the ticket tags of a test title', () => {
  assert.deepEqual(criteriaOf('[EVAL-1][AC-1] something [EVAL-1][AC-2]', 'EVAL-1'), ['AC-1', 'AC-2']);
  assert.deepEqual(criteriaOf('[EVAL-10][AC-1] count', 'EVAL-1'), []);
});
