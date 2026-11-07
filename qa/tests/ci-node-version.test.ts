import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// qa/ci-node-version.sh, which picks the Node.js the workflows give the application, on
// throwaway repositories; and the installer's doctor, which must say the same.
const kit = resolve(import.meta.dirname, '../..');
const SCRIPT = join(kit, 'qa/ci-node-version.sh');
const BIN = join(kit, 'bin/agent-qa-kit.mjs');
const pkg = JSON.stringify({ name: 'web', devDependencies: { vitest: '4.1.12', '@playwright/test': '1.55.1' } });

function repo(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-node-version-')));
  spawnSync('git', ['init', '-q'], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}
function choose(root: string, ...apps: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...apps], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// [name, files, application folder, expected output or the refusal]
const cases: [string, Record<string, string>, string, string | RegExp][] = [
  ['nothing named', { 'web/package.json': pkg }, 'web', 'node=22\nnode_from=default'],
  ['the application\'s .nvmrc, with a v', { 'web/package.json': pkg, 'web/.nvmrc': 'v26.13.0\n' }, 'web', 'node=26.13.0\nnode_from=web/.nvmrc'],
  ['the root\'s .node-version, after a comment and a blank line', { 'web/package.json': pkg, '.node-version': '# CI\n\n  24\r\n' }, 'web', 'node=24\nnode_from=.node-version'],
  ['the closest file wins', { 'web/package.json': pkg, 'web/.node-version': '24.11.1', '.nvmrc': '26' }, 'web', 'node=24.11.1\nnode_from=web/.node-version'],
  ['22 with no minor: setup-node takes the latest 22', { 'package.json': pkg, '.nvmrc': '22' }, '.', 'node=22\nnode_from=.nvmrc'],
  ['22.18 exactly', { 'package.json': pkg, '.nvmrc': '22.18.0' }, '.', 'node=22.18.0\nnode_from=.nvmrc'],
  ['lts/*', { 'package.json': pkg, '.nvmrc': 'lts/*' }, '.', 'node=lts/*\nnode_from=.nvmrc'],
  ['too old a 22', { 'package.json': pkg, '.nvmrc': '22.12.0' }, '.', /\.nvmrc names Node\.js 22\.12\.0; the kit's scripts need 22\.18 or later/],
  ['20', { 'package.json': pkg, '.nvmrc': '20' }, '.', /names Node\.js 20; the kit's scripts need 22\.18/],
  ['a codename', { 'package.json': pkg, '.nvmrc': 'lts/iron' }, '.', /names "lts\/iron": write a version number/],
  ['a range', { 'package.json': pkg, '.node-version': '>=22' }, '.', /names ">=22": write a version number/],
  ['an empty file', { 'package.json': pkg, '.nvmrc': '\n  \n' }, '.', /\.nvmrc is empty/],
];

for (const [name, files, app, expected] of cases) {
  test(`Node.js version: ${name}`, () => {
    const root = repo(files);
    try {
      const r = choose(root, app);
      if (typeof expected === 'string') {
        assert.equal(r.code, 0, r.err);
        assert.equal(r.out, expected);
      } else {
        assert.equal(r.code, 1, r.out);
        assert.equal(r.out, '', 'nothing for $GITHUB_OUTPUT');
        assert.match(r.err, expected);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('several applications must agree on one version', () => {
  const root = repo({ 'a/package.json': pkg, 'a/.nvmrc': '24', 'b/package.json': pkg, 'b/.nvmrc': '24', 'c/package.json': pkg, 'c/.nvmrc': '26' });
  try {
    assert.equal(choose(root, 'a', 'b').out, 'node=24\nnode_from=b/.nvmrc');
    const r = choose(root, 'a', 'c');
    assert.equal(r.code, 1);
    assert.match(r.err, /different Node\.js versions: 24 \(a\/\.nvmrc\) and 26 \(c\/\.nvmrc\)/);
    assert.match(choose(root, '../a').err, /No application folder "\.\.\/a"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor says what the workflows will choose', () => {
  for (const [name, files, app, expected] of cases) {
    const root = repo(files);
    try {
      const doctor = spawnSync(process.execPath, [BIN, 'doctor', '--app', app], { cwd: root, encoding: 'utf8' }).stdout;
      const line = doctor.split('\n').find((l) => /Node\.js|\.nvmrc|\.node-version/.test(l) && /^ {2}(ok|FAIL)/.test(l)) ?? '';
      if (typeof expected === 'string') {
        const version = expected.match(/^node=(.*)$/m)?.[1];
        const from = expected.match(/^node_from=(.*)$/m)?.[1];
        assert.match(line, /^ {2}ok/, `${name}: ${line}`);
        assert.ok(line.includes(`Node.js ${version} (`), `${name}: ${line}`);
        assert.ok(from === 'default' ? line.includes('names none') : line.includes(`from ${from}`), `${name}: ${line}`);
      } else {
        assert.match(line, /^ {2}FAIL/, `${name}: ${line}`);
        assert.match(line, expected, name);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
