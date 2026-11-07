import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// qa/ci-install-app.sh on throwaway repositories, with stand-ins for npm, npx and pnpm that log
// what they are asked to do and where. The installer's doctor must take the same decision.
const kit = resolve(import.meta.dirname, '../..');
const SCRIPT = join(kit, 'qa/ci-install-app.sh');
const BIN = join(kit, 'bin/agent-qa-kit.mjs');

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const pkg = (extra: object = {}) => JSON.stringify({ name: 'web', devDependencies: { vitest: '4.1.12', '@playwright/test': '1.55.1' }, ...extra });
const LOCK = "lockfileVersion: '9.0'\n";

// A repository with the files given, a git root, and stand-ins on the PATH.
function repo(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-install-app-')));
  const root = join(dir, 'repo');
  mkdirSync(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  const log = join(dir, 'calls.log');
  // npm install --global pnpm@X makes pnpm X the one on the PATH; PNPM_ON_PATH overrides it.
  const stub = (name: string, body = '') => {
    write(dir, `bin/${name}`, `#!/usr/bin/env bash\necho "${name} $* @ $PWD" >> "${log}"\n${body}\n`);
    chmodSync(join(dir, `bin/${name}`), 0o755);
  };
  stub('npm', `if [[ "$1 $2" == 'install --global' ]]; then echo "\${@: -1}" | sed 's/^pnpm@//' > "${dir}/pnpm-version"; fi`);
  stub('npx');
  stub('pnpm', `if [[ "$1" == --version ]]; then echo "\${PNPM_ON_PATH:-$(cat "${dir}/pnpm-version" 2>/dev/null)}"; fi`);
  return { dir, root, log };
}
function install(r: { dir: string; root: string }, app: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, app, ...args], { cwd: r.root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}
const calls = (r: { dir: string; root: string; log: string }) => {
  try { return readFileSync(r.log, 'utf8').trim().split('\n').map((line) => line.replace(r.root, '<repo>')); } catch { return []; }
};

test('an npm application: npm ci and Playwright\'s browser, in its folder', () => {
  const r = repo({ 'apps/web/package.json': pkg(), 'apps/web/package-lock.json': '{}' });
  try {
    const out = install(r, 'apps/web');
    assert.equal(out.code, 0, out.out);
    assert.deepEqual(calls(r), ['npm ci --no-audit --no-fund @ <repo>/apps/web', 'npx playwright install --with-deps chromium @ <repo>/apps/web']);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('a pnpm application: the pnpm of packageManager, a frozen install, then the browser', () => {
  const r = repo({ 'package.json': pkg({ packageManager: 'pnpm@12.18.0+sha512.0123abcd' }), 'pnpm-lock.yaml': LOCK });
  try {
    const out = install(r, '.');
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /Installing .* with pnpm 12\.18\.0, from the lockfile in /);
    assert.deepEqual(calls(r), [
      'npm install --global --no-audit --no-fund pnpm@12.18.0 @ <repo>',
      'pnpm --version @ <repo>',
      'pnpm install --frozen-lockfile @ <repo>',
      'pnpm exec playwright install --with-deps chromium @ <repo>',
    ]);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('in a workspace, the install runs where the lockfile is and the browser in the application', () => {
  const pnpmWs = repo({ 'package.json': JSON.stringify({ name: 'mono', packageManager: 'pnpm@10.34.9' }), 'pnpm-lock.yaml': LOCK,
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n', 'apps/web/package.json': pkg() });
  const npmWs = repo({ 'package.json': JSON.stringify({ name: 'mono', workspaces: ['apps/*'] }), 'package-lock.json': '{}',
    'apps/web/package.json': pkg() });
  try {
    assert.equal(install(pnpmWs, 'apps/web').code, 0);
    assert.deepEqual(calls(pnpmWs).slice(2), ['pnpm install --frozen-lockfile @ <repo>', 'pnpm exec playwright install --with-deps chromium @ <repo>/apps/web']);
    assert.equal(install(npmWs, 'apps/web').code, 0);
    assert.deepEqual(calls(npmWs), ['npm ci --no-audit --no-fund @ <repo>', 'npx playwright install --with-deps chromium @ <repo>/apps/web']);
  } finally {
    rmSync(pnpmWs.dir, { recursive: true, force: true });
    rmSync(npmWs.dir, { recursive: true, force: true });
  }
});

// Each refusal happens before anything is installed or downloaded.
const refusals: [string, Record<string, string>, RegExp][] = [
  ['pnpm without a version', { 'package.json': pkg(), 'pnpm-lock.yaml': LOCK }, /Name the pnpm version in .*"packageManager": "pnpm@<version>"/],
  ['a packageManager that is not pnpm', { 'package.json': pkg({ packageManager: 'yarn@4.5.0' }), 'pnpm-lock.yaml': LOCK }, /\(it says "yarn@4\.5\.0"\)/],
  ['a version with shell characters', { 'package.json': pkg({ packageManager: 'pnpm@10.0.0;rm -rf /' }), 'pnpm-lock.yaml': LOCK }, /Name the pnpm version/],
  ['two lockfiles and no packageManager', { 'package.json': pkg(), 'pnpm-lock.yaml': LOCK, 'package-lock.json': '{}' }, /has both package-lock\.json and pnpm-lock\.yaml/],
  ['yarn', { 'package.json': pkg(), 'yarn.lock': '' }, /uses yarn\.lock: the kit installs applications with npm or pnpm only/],
  ['no lockfile', { 'package.json': pkg() }, /No package-lock\.json or pnpm-lock\.yaml/],
];
for (const [name, files, message] of refusals) {
  test(`refused, with nothing installed: ${name}`, () => {
    const r = repo(files);
    try {
      const out = install(r, '.');
      assert.equal(out.code, 1, out.out);
      assert.match(out.out, /^::error title=Install the application::/m);
      assert.match(out.out, message);
      assert.deepEqual(calls(r), []);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
}

test('a lockfile above the application counts only in a workspace', () => {
  const r = repo({ 'package.json': JSON.stringify({ name: 'site', packageManager: 'pnpm@10.34.9' }), 'pnpm-lock.yaml': LOCK, 'apps/web/package.json': pkg() });
  try {
    const out = install(r, 'apps/web');
    assert.equal(out.code, 1);
    assert.match(out.out, /pnpm-lock\.yaml is not the application's: there is no pnpm-workspace\.yaml next to it/);
    write(r.root, 'package-lock.json', '{}');
    write(r.root, 'package.json', JSON.stringify({ name: 'site', packageManager: 'npm@10.9.0' }));
    assert.match(install(r, 'apps/web').out, /package-lock\.json is not the application's: its package\.json has no "workspaces"/);
    assert.deepEqual(calls(r), []);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('two lockfiles: packageManager decides', () => {
  const r = repo({ 'package.json': pkg({ packageManager: 'pnpm@11.28.9' }), 'pnpm-lock.yaml': LOCK, 'package-lock.json': '{}' });
  try {
    assert.equal(install(r, '.', ['--detect']).out.trim(), `pnpm ${r.root} 11.28.9`);
    write(r.root, 'package.json', pkg({ packageManager: 'npm@10.9.0' }));
    assert.equal(install(r, '.', ['--detect']).out.trim(), `npm ${r.root} -`);
    assert.deepEqual(calls(r), [], '--detect installs nothing');
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test('another pnpm first on the PATH stops the install', () => {
  const r = repo({ 'package.json': pkg({ packageManager: 'pnpm@12.18.0' }), 'pnpm-lock.yaml': LOCK });
  try {
    const out = install(r, '.', [], { PNPM_ON_PATH: '9.15.9' });
    assert.equal(out.code, 1);
    assert.match(out.out, /pnpm 12\.18\.0 was installed, but pnpm --version says 9\.15\.9/);
    assert.ok(!calls(r).some((call) => call.startsWith('pnpm install')));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// doctor tells before CI what the install step will do: same manager, same folder, same version,
// and a refusal where the step refuses.
test('doctor and the install step take the same decision', () => {
  const layouts: [string, Record<string, string>, string][] = [
    ['npm', { 'apps/web/package.json': pkg(), 'apps/web/package-lock.json': '{}' }, 'apps/web'],
    ['pnpm', { 'package.json': pkg({ packageManager: 'pnpm@12.18.0+sha512.ab' }), 'pnpm-lock.yaml': LOCK }, '.'],
    ['pnpm workspace', { 'package.json': JSON.stringify({ name: 'm', packageManager: 'pnpm@10.34.9' }), 'pnpm-lock.yaml': LOCK,
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n', 'apps/web/package.json': pkg() }, 'apps/web'],
    ['npm workspace', { 'package.json': JSON.stringify({ name: 'm', workspaces: ['apps/*'] }), 'package-lock.json': '{}', 'apps/web/package.json': pkg() }, 'apps/web'],
    ['two lockfiles, pnpm', { 'package.json': pkg({ packageManager: 'pnpm@11.28.9' }), 'pnpm-lock.yaml': LOCK, 'package-lock.json': '{}' }, '.'],
    ...refusals.map(([name, files]) => [name, files, '.'] as [string, Record<string, string>, string]),
    ['a lockfile above, no workspace', { 'package.json': JSON.stringify({ name: 's', packageManager: 'pnpm@10.34.9' }), 'pnpm-lock.yaml': LOCK, 'apps/web/package.json': pkg() }, 'apps/web'],
  ];
  for (const [name, files, app] of layouts) {
    const r = repo(files);
    try {
      const step = install(r, app, ['--detect']);
      const doctor = spawnSync(process.execPath, [BIN, 'doctor', '--app', app], { cwd: r.root, encoding: 'utf8',
        env: { ...process.env, PATH: `${join(r.dir, 'bin')}:${process.env.PATH}` } }).stdout;
      const line = doctor.split('\n').find((l) => /install the application|package-lock|pnpm|yarn\.lock|lockfile/.test(l) && /^ {2}(ok|warn|FAIL)/.test(l)) ?? '';
      if (step.code !== 0) {
        assert.match(line, /^ {2}FAIL/, `${name}: the step refuses, doctor says ${line || 'nothing'}`);
        continue;
      }
      const [manager, lockDir, version] = step.out.trim().split(' ');
      const lock = `${lockDir === r.root ? '' : `${lockDir.slice(r.root.length + 1)}/`}${manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml'}`;
      assert.match(line, /^ {2}(ok|warn)/, `${name}: ${line}`);
      assert.ok(line.includes(lock), `${name}: doctor names ${lock}: ${line}`);
      assert.ok(line.includes(manager === 'npm' ? 'with npm ci' : `with pnpm ${version}`), `${name}: ${line}`);
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  }
});
