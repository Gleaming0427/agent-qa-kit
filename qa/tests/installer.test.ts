import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

// The installer, run as a person would run it (npx runs the same file), on throwaway git repositories.
const kit = resolve(import.meta.dirname, '../..');
const BIN = join(kit, 'bin/agent-qa-kit.mjs');
const VERSION = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')).version;
const WORKFLOWS = ['qa-write-tests.yml', 'qa-verify.yml', 'qa-branches.yml', 'qa-amend-tests.yml'];
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// What a repository needs from the kit, read from the kit itself: a script added to qa/ or a hook
// added to .claude/hooks/ that the installer does not copy fails the first test.
function expectedFiles(): string[] {
  const list = (dir: string, keep: (name: string) => boolean) =>
    readdirSync(join(kit, dir)).filter((name) => statSync(join(kit, dir, name)).isFile() && keep(name)).map((name) => `${dir}/${name}`);
  return [
    ...list('.claude/agents', (n) => n.endsWith('.md')),
    ...list('.claude/hooks', () => true),
    '.claude/qa-settings.json', '.claude/repair-settings.json',
    // qa/visual-review.ts needs the Anthropic SDK and only runs in the kit's own workflow.
    ...list('qa', (n) => /\.(sh|ts)$/.test(n) && !n.startsWith('test-') && n !== 'visual-review.ts'),
    'qa/package.json', '.claude/hooks/package.json',
    ...WORKFLOWS.map((name) => `.github/workflows/${name}`),
  ].sort();
}

function run(cwd: string, command: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}
const cli = (cwd: string, ...args: string[]) => run(cwd, process.execPath, [BIN, ...args]);
function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, 'git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'init.defaultBranch=main', ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.out}`);
  return result.out.trim();
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
const read = (root: string, path: string) => readFileSync(join(root, path), 'utf8');
const manifestOf = (root: string) => JSON.parse(read(root, '.agent-qa-kit.json'));

interface AppOptions { indent?: number | string; crlf?: boolean; scripts?: Record<string, string>; smoke?: boolean; extra?: object; lock?: boolean }
// An application the kit can work with: Vitest and Playwright, their JSON reports, a smoke journey.
function makeApp(root: string, folder: string, o: AppOptions = {}) {
  const at = (path: string) => (folder === '.' ? path : `${folder}/${path}`);
  const pkg = { name: 'web', private: true, scripts: { build: 'vite build', ...(o.scripts ?? {}) },
    devDependencies: { '@playwright/test': '1.55.1', vitest: '4.1.12' }, ...(o.extra ?? {}) };
  let text = `${JSON.stringify(pkg, null, o.indent ?? 2)}\n`;
  if (o.crlf) text = text.replace(/\n/g, '\r\n');
  write(root, at('package.json'), text);
  if (o.lock !== false) write(root, at('package-lock.json'), '{ "lockfileVersion": 3 }\n');
  write(root, at('playwright.config.ts'), "export default { testDir: './e2e', reporter: [['json', { outputFile: 'reports/playwright.json' }]],\n"
    + "  webServer: { command: 'npm run serve', url: 'http://127.0.0.1:4173' } };\n");
  write(root, at('vite.config.ts'), "export default { test: { include: ['src/**/*.test.ts'], reporters: ['default', 'json'], outputFile: { json: 'reports/vitest.json' } } };\n");
  write(root, at('e2e/smoke.spec.ts'), `test('checkout${o.smoke === false ? '' : ' @smoke'}', async () => {});\n`);
  write(root, at('src/cart.ts'), 'export const total = (n: number) => n;\n');
}
function repo(folder = 'apps/web', o: AppOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-installer-'));
  git(dir, 'init', '-q');
  makeApp(dir, folder, o);
  write(dir, 'README.md', '# shop\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'app');
  return dir;
}
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all');
const commitAll = (dir: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'kit'); };
const isExecutable = (path: string) => (statSync(path).mode & 0o111) !== 0;

test('init installs the kit for an application in a sub-folder, and doctor passes', () => {
  const dir = repo('apps/web', { indent: 4, scripts: { 'test:e2e': 'playwright test --project=desktop' } });
  try {
    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /application apps\/web, feature area "web", pull requests into main/);

    const manifest = manifestOf(dir);
    assert.deepEqual(Object.keys(manifest.files).sort(), expectedFiles());
    assert.equal(manifest.version, VERSION);
    assert.deepEqual([manifest.app, manifest.mfe, manifest.branch], ['apps/web', 'web', 'main']);
    for (const [path, digest] of Object.entries(manifest.files)) {
      assert.equal(sha256(readFileSync(join(dir, path))), digest, path);
      if (!path.startsWith('.github/') && !path.endsWith('package.json')) assert.equal(read(dir, path), read(kit, path), `${path} is copied as it is`);
      assert.equal(isExecutable(join(dir, path)), path.endsWith('.sh'), `${path} mode`);
    }
    assert.equal(read(dir, 'qa/package.json'), '{\n  "type": "module"\n}\n');

    // The workflows default to this application and feature area, and verify pull requests into main.
    const write_ = read(dir, '.github/workflows/qa-write-tests.yml');
    assert.match(write_, /\n {8}default: 'web'\n/);
    assert.match(write_, /\n {8}default: 'apps\/web'\n/);
    assert.doesNotMatch(write_, /examples\/shop|default: shop/);
    assert.match(read(dir, '.github/workflows/qa-amend-tests.yml'), /\n {8}default: 'apps\/web'\n/);
    assert.match(read(dir, '.github/workflows/qa-verify.yml'), /\n {4}branches: \['main'\]\n/);
    assert.equal(read(dir, '.github/workflows/qa-branches.yml'), read(kit, '.github/workflows/qa-branches.yml'));

    // The missing scripts are added, the existing ones kept, the file's indentation too.
    const text = read(dir, 'apps/web/package.json');
    const pkg = JSON.parse(text);
    assert.equal(pkg.scripts['test:e2e'], 'playwright test --project=desktop');
    assert.equal(pkg.scripts.build, 'vite build');
    assert.equal(pkg.scripts['test:unit'], 'vitest run', 'vite.config already writes reports/vitest.json');
    assert.equal(pkg.scripts['test:affected'], 'vitest run');
    assert.equal(pkg.scripts['test:summary'], 'node ../../qa/summary.ts');
    assert.equal(text, `${JSON.stringify(pkg, null, 4)}\n`);

    assert.match(read(dir, 'apps/web/.gitignore'), /^# Agent QA Kit: test reports and agent verdicts\n\/reports\/\n$/);
    assert.equal(run(dir, 'git', ['check-ignore', '-q', 'apps/web/reports/vitest.json']).code, 0);
    assert.match(r.out, /git add \.agent-qa-kit\.json \.claude qa \.github\/workflows\/qa-write-tests\.yml .* apps\/web\/package\.json apps\/web\/\.gitignore/);

    const d = cli(dir, 'doctor');
    assert.equal(d.code, 0, d.out);
    assert.doesNotMatch(d.out, /FAIL/);
    assert.match(d.out, /ok {4}\d+ files of version/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init a second time changes nothing', () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, 'init').code, 0);
    commitAll(dir);
    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /same {6}32 file\(s\) already up to date/);
    assert.match(r.out, /Already installed and up to date/);
    assert.equal(status(dir), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init does not overwrite a file changed after the install; --force only when git can give it back', () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, 'init').code, 0);
    commitAll(dir);
    write(dir, 'qa/run-qa.sh', '#!/usr/bin/env bash\necho changed here\n');
    let r = cli(dir, 'init');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /CONFLICT {2}qa\/run-qa\.sh {3}exists and differs from the kit/);
    assert.match(r.out, /Nothing was written: 1 file\(s\) would be overwritten/);
    assert.match(read(dir, 'qa/run-qa.sh'), /changed here/);

    // Uncommitted: --force would lose it.
    r = cli(dir, 'init', '--force');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /has changes git could not give back/);
    assert.match(read(dir, 'qa/run-qa.sh'), /changed here/);

    git(dir, 'commit', '-qam', 'local change');
    r = cli(dir, 'init', '--force');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /replace {3}qa\/run-qa\.sh/);
    assert.equal(read(dir, 'qa/run-qa.sh'), read(kit, 'qa/run-qa.sh'));
    assert.ok(isExecutable(join(dir, 'qa/run-qa.sh')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init upgrades the files it installed, keeps the choices made, and reports the files the kit dropped', () => {
  const dir = repo();
  try {
    assert.equal(cli(dir, 'init', '--mfe', 'checkout').code, 0);
    // As if an older version had installed another qa/summary.ts and a script the kit no longer has.
    const manifest = manifestOf(dir);
    write(dir, 'qa/summary.ts', '// old version\n');
    write(dir, 'qa/old-helper.sh', 'echo old\n');
    manifest.version = '0.1.0';
    manifest.files['qa/summary.ts'] = sha256('// old version\n');
    manifest.files['qa/old-helper.sh'] = sha256('echo old\n');
    write(dir, '.agent-qa-kit.json', JSON.stringify(manifest));
    commitAll(dir);
    assert.match(cli(dir, 'doctor').out, /Installed version 0\.1\.0; this installer is/);

    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /update {4}qa\/summary\.ts/);
    assert.match(r.out, /obsolete {2}qa\/old-helper\.sh {3}no longer part of the kit, left in place/);
    assert.match(r.out, /feature area "checkout"/);
    assert.equal(read(dir, 'qa/summary.ts'), read(kit, 'qa/summary.ts'));
    assert.ok(existsSync(join(dir, 'qa/old-helper.sh')));
    const after = manifestOf(dir);
    assert.equal(after.version, VERSION);
    assert.equal(after.mfe, 'checkout');
    assert.equal(after.files['qa/old-helper.sh'], undefined);
    assert.match(read(dir, '.github/workflows/qa-write-tests.yml'), /default: 'checkout'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init writes nothing at all when a file is in the way, and --dry-run writes nothing', () => {
  const dir = repo();
  try {
    write(dir, '.github/workflows/qa-verify.yml', 'name: my own check\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'own workflow');
    let r = cli(dir, 'init');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /CONFLICT {2}\.github\/workflows\/qa-verify\.yml/);
    assert.equal(status(dir), '', 'no file created, package.json and .gitignore unchanged');

    rmSync(join(dir, '.github'), { recursive: true });
    git(dir, 'commit', '-qam', 'drop it');
    r = cli(dir, 'init', '--dry-run');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /create {4}qa\/run-qa\.sh/);
    assert.match(r.out, /scripts {3}apps\/web\/package\.json: test:unit, test:affected, test:e2e, test:summary\n {12}"test:unit": "vitest run"/);
    assert.match(r.out, /Dry run: nothing was written/);
    assert.equal(status(dir), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an application at the root of a CommonJS package: the installed scripts run', () => {
  const dir = repo('.', { crlf: true, extra: { type: 'commonjs' } });
  try {
    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /application at the root/);
    const text = read(dir, 'package.json');
    assert.ok(text.endsWith('}\r\n') && !/[^\r]\n/.test(text), 'CRLF line endings kept');
    assert.equal(JSON.parse(text).scripts['test:summary'], 'node qa/summary.ts');
    assert.match(read(dir, '.github/workflows/qa-write-tests.yml'), /\n {8}default: '\.'\n/);
    assert.equal(run(dir, 'git', ['check-ignore', '-q', 'reports/vitest.json']).code, 0);

    // ES modules in a "type": "commonjs" package: qa/package.json makes Node read them as such.
    write(dir, 'specs/SHOP-1.md', '# SHOP-1\n\n- AC-1: the cart shows its total.\n');
    let s = run(dir, process.execPath, ['qa/criteria-manifest.ts', 'SHOP-1', 'specs/SHOP-1.md', 'reports/SHOP-1-criteria.json']);
    assert.equal(s.code, 0, s.out);
    assert.equal(s.out.trim(), 'Manifest: AC-1', 'no module warning');
    // --final: the hook's rejection counter (in the temporary folder) stays out of it.
    s = run(dir, 'bash', ['-c', "echo '{}' | node .claude/hooks/verdict-check.ts --final"]);
    assert.equal(s.code, 2);
    assert.match(s.out, /Expected phase 1 or 2/);
    assert.doesNotMatch(s.out, /ES module|MODULE_TYPELESS|SyntaxError/);
    s = run(dir, process.execPath, ['qa/summary.ts']);
    assert.match(s.out, /No report found/);
    assert.doesNotMatch(s.out, /ES module|MODULE_TYPELESS|SyntaxError/);

    // The launcher, as the workflow starts it, up to the agent call (a stand-in claude on the PATH).
    write(dir, 'stub/claude', '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(dir, 'stub/claude'), 0o755);
    s = run(dir, 'bash', ['qa/run-qa.sh', 'SHOP-1', '1', 'specs/SHOP-1.md', 'shop'],
      { QA_DRY_RUN: '1', QA_PROJECT_DIR: dir, PATH: `${join(dir, 'stub')}:${process.env.PATH}` });
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /Preview only: ticket=SHOP-1 phase=1 model=\S+ effort=\S+ budget=\$1\.00/);
    s = run(dir, 'bash', ['.claude/hooks/qa-guard.sh'], { CLAUDE_PROJECT_DIR: dir });
    assert.notEqual(s.code, 127, 'the guard hook starts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('init finds the application, or says why it cannot', () => {
  const plain = mkdtempSync(join(tmpdir(), 'qa-installer-plain-'));
  const two = repo('apps/web');
  try {
    let r = cli(plain, 'init');
    assert.equal(r.code, 2);
    assert.match(r.out, /Not inside a git repository/);

    git(plain, 'init', '-q');
    write(plain, 'package.json', '{ "name": "lib", "devDependencies": { "vitest": "4.1.12" } }\n');
    r = cli(plain, 'init');
    assert.equal(r.code, 2);
    assert.match(r.out, /No application found: the kit needs a package\.json with vitest and @playwright\/test/);
    assert.equal(status(plain), '?? package.json');

    makeApp(two, 'apps/admin');
    r = cli(two, 'init');
    assert.equal(r.code, 2);
    assert.match(r.out, /Several applications have vitest and @playwright\/test: apps\/admin, apps\/web\. Choose one with --app/);
    // From inside one of them, or with --app, there is no doubt.
    r = cli(join(two, 'apps/admin'), 'init', '--dry-run');
    assert.match(r.out, /application apps\/admin, feature area "admin"/);
    r = cli(join(two, 'apps'), 'init', '--app', 'web', '--dry-run');
    assert.match(r.out, /application apps\/web, feature area "web"/);

    for (const [args, message] of [
      [['--mfe', 'Web App'], /feature area "Web App" can only use lowercase letters/],
      [['--app', '../elsewhere'], /is outside the repository/],
      [['--app', 'apps/none'], /there is no package\.json/],
      [['--app'], /--app needs a value/],
      [['--branch', '-x'], /not a branch name/],
      [['--color'], /Unknown option: --color/],
      [['--run'], /--run is an option of doctor/],
    ] as const) {
      r = cli(two, 'init', '--app', 'apps/web', ...args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, message);
    }
    assert.match(cli(two, 'deploy').out, /Unknown command: deploy/);
    assert.equal(status(two), '?? apps/admin/e2e/smoke.spec.ts\n?? apps/admin/package-lock.json\n?? apps/admin/package.json\n'
      + '?? apps/admin/playwright.config.ts\n?? apps/admin/src/cart.ts\n?? apps/admin/vite.config.ts');

    r = cli(kit, 'init', '--dry-run');
    assert.equal(r.code, 2);
    assert.match(r.out, /This is the Agent QA Kit repository itself/);
    assert.match(cli(two, '--help').out, /Usage:\n {2}npx github:Gleaming0427\/agent-qa-kit init/);
    assert.equal(cli(two, '--version').out.trim(), VERSION);
    assert.equal(cli(two, 'init', '--version').out.trim(), VERSION, '--version never installs');
    assert.match(cli(two, '--help', 'init').out, /^Agent QA Kit /);
    assert.match(cli(two, 'init', 'doctor').out, /Unexpected argument: doctor/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(two, { recursive: true, force: true });
  }
});

test('the branch QA verify watches is the remote default branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-installer-remote-'));
  try {
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'trunk');
    makeApp(origin, 'web');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'app');
    git(dir, 'clone', '-q', origin, 'clone');
    const clone = join(dir, 'clone');
    git(clone, 'checkout', '-qb', 'add-qa');
    const r = cli(clone, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pull requests into trunk/);
    assert.match(read(clone, '.github/workflows/qa-verify.yml'), /branches: \['trunk'\]/);
    assert.match(read(clone, '.github/workflows/qa-write-tests.yml'), /default: 'web'\n[\s\S]*default: 'web'\n/);
    assert.doesNotMatch(cli(clone, 'doctor').out, /remote's default branch/);
    assert.equal(cli(clone, 'init', '--branch', 'main').code, 0);
    assert.match(cli(clone, 'doctor').out, /pull requests into main, but the remote's default branch is trunk: run init --branch trunk/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('where git does not record file modes, the scripts are staged with their executable bit', () => {
  const dir = repo();
  try {
    git(dir, 'config', 'core.fileMode', 'false');
    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /core\.fileMode is off here: .*qa\/run-qa\.sh.* staged with the executable bit/);
    for (const line of git(dir, 'ls-files', '-s', '--', '*.sh').split('\n')) assert.match(line, /^100755 /, line);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a symbolic link on the way is a conflict, never followed', () => {
  const dir = repo();
  const outside = mkdtempSync(join(tmpdir(), 'qa-installer-outside-'));
  try {
    symlinkSync(outside, join(dir, '.claude'));
    const r = cli(dir, 'init', '--force');
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /CONFLICT {2}\.claude\/agents\/qa-writer\.md {3}a symbolic link or a file is on its path/);
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('doctor names what the workflows still need', () => {
  const dir = repo('apps/web', { smoke: false, lock: false });
  try {
    let d = cli(dir, 'doctor');
    assert.equal(d.code, 1);
    assert.match(d.out, /FAIL {2}Not installed in .*: run npx github:Gleaming0427\/agent-qa-kit init/);

    write(dir, 'yarn.lock', '');
    write(dir, 'tsconfig.json', '{\n  // the whole repository\n  "compilerOptions": { "strict": true, },\n}\n');
    assert.equal(cli(dir, 'init').code, 0);
    d = cli(dir, 'doctor');
    assert.equal(d.code, 1);
    assert.match(d.out, /FAIL {2}The application uses yarn\.lock, but the workflows install it with npm ci/);
    assert.match(d.out, /FAIL {2}No browser test is tagged @smoke/);
    assert.match(d.out, /warn {2}The repository's tsconfig\.json would also type-check qa\/ and \.claude\/hooks\//);

    write(dir, 'apps/web/package-lock.json', '{}\n');
    write(dir, 'apps/web/e2e/smoke.spec.ts', "test('checkout', { tag: '@smoke' }, async () => {});\n");
    write(dir, 'tsconfig.json', '{ "include": ["**/*.ts"], "exclude": ["node_modules", "qa", ".claude"] }\n');
    d = cli(dir, 'doctor');
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /warn {2}apps\/web\/package-lock\.json is not committed yet/);
    assert.doesNotMatch(d.out, /tsconfig/);

    // Broken afterwards: a file removed, the hook without its executable bit, reports no longer ignored.
    rmSync(join(dir, 'qa/full-suite.ts'));
    chmodSync(join(dir, '.claude/hooks/qa-guard.sh'), 0o644);
    write(dir, 'apps/web/.gitignore', '');
    write(dir, '.gitignore', 'qa/summary.ts\n');
    const pkg = JSON.parse(read(dir, 'apps/web/package.json'));
    delete pkg.scripts['test:summary'];
    write(dir, 'apps/web/package.json', JSON.stringify(pkg));
    d = cli(dir, 'doctor');
    assert.equal(d.code, 1);
    assert.match(d.out, /FAIL {2}Missing: qa\/full-suite\.ts\. Run init again/);
    assert.match(d.out, /FAIL {2}Not executable: \.claude\/hooks\/qa-guard\.sh/);
    assert.match(d.out, /FAIL {2}Ignored by git, so the workflows would not have them: qa\/summary\.ts/);
    assert.match(d.out, /FAIL {2}Missing npm scripts: test:summary/);
    assert.match(d.out, /FAIL {2}apps\/web\/reports\/ is not ignored by git/);

    // init repairs what it installed; the .gitignore rule it adds is the application's.
    write(dir, '.gitignore', '');
    const r = cli(dir, 'init');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /create {4}qa\/full-suite\.ts/);
    assert.match(r.out, /chmod \+x {2}\.claude\/hooks\/qa-guard\.sh/);
    assert.equal(cli(dir, 'doctor').code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor --run runs the scripts as the full suite does, and reads only fresh reports', () => {
  // Stand-ins for Vitest and Playwright: each script writes the report the kit reads.
  const dir = repo('apps/web', { scripts: {
    'test:unit': 'node fake.mjs vitest', 'test:affected': 'node fake.mjs vitest', 'test:e2e': 'node fake.mjs playwright',
  } });
  try {
    const vitest = { testResults: [{ name: 'src/cart.test.ts', assertionResults: [{ fullName: 'total', status: 'passed' }] }] };
    const spec = (title: string, tags: string[], status: string) => ({ title, tags, tests: [{ status, results: [] }] });
    const report = (specs: object[]) => ({ suites: [{ title: 'smoke.spec.ts', file: 'smoke.spec.ts', specs }], errors: [] });
    write(dir, 'apps/web/fake.mjs', `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const kind = process.argv[2];
if (process.env.ANTHROPIC_API_KEY) { console.error('the tests saw the API key'); process.exit(9); }
mkdirSync('reports', { recursive: true });
const data = JSON.parse(readFileSync('fixtures.json', 'utf8'))[kind];
if (data) writeFileSync('reports/' + kind + '.json', JSON.stringify(data));
`);
    const fixtures = (playwright: object | null) => write(dir, 'apps/web/fixtures.json', JSON.stringify({ vitest, playwright }));
    assert.equal(cli(dir, 'init').code, 0);

    fixtures(report([spec('checkout', ['smoke'], 'expected'), spec('search', [], 'expected')]));
    let d = run(dir, process.execPath, [BIN, 'doctor', '--run'], { ANTHROPIC_API_KEY: 'sk-test' });
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /ok {4}npm run test:unit: 1 tests pass, reports\/vitest\.json written/);
    assert.match(d.out, /ok {4}npm run test:e2e: 2 tests pass, reports\/playwright\.json written/);
    assert.match(d.out, /ok {4}1 @smoke test\(s\) passed/);
    assert.match(d.out, /ok {4}npm run test:summary reads both reports/);

    fixtures(report([spec('checkout @smoke', [], 'unexpected')]));
    d = cli(dir, 'doctor', '--run');
    assert.equal(d.code, 1);
    assert.match(d.out, /FAIL {2}npm run test:e2e: 1 of 1 tests fail or are flaky/);
    assert.match(d.out, /FAIL {2}No test tagged @smoke passed/);

    // A report left by an earlier run does not count.
    const old = new Date(Date.now() - 3_600_000);
    fixtures(null);
    write(dir, 'apps/web/reports/playwright.json', JSON.stringify(report([spec('checkout', ['smoke'], 'expected')])));
    spawnSync('touch', ['-d', old.toISOString(), join(dir, 'apps/web/reports/playwright.json')]);
    d = cli(dir, 'doctor', '--run');
    assert.equal(d.code, 1);
    assert.match(d.out, /FAIL {2}npm run test:e2e did not write reports\/playwright\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every script an installed file calls is installed too', () => {
  const installed = new Set(expectedFiles());
  const missing: string[] = [];
  for (const path of installed) {
    if (!existsSync(join(kit, path))) continue; // generated
    const text = read(kit, path);
    if (path.endsWith('.ts')) {
      for (const [, spec] of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        const target = join(dirname(path), spec).split('\\').join('/');
        if (!installed.has(target)) missing.push(`${path} imports ${target}`);
      }
    }
    for (const [ref] of text.matchAll(/(?<![\w/.-])(?:qa|\.claude\/hooks)\/[\w.-]+\.(?:ts|sh)\b/g)) {
      if (!installed.has(ref) && !/qa\/(test-|visual-review)/.test(ref) && !/^qa\/(tests)/.test(ref)) missing.push(`${path} calls ${ref}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the npm package that npx installs holds the installer and every file it copies', () => {
  const r = run(kit, 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
  assert.equal(r.code, 0, r.out);
  const packed = new Set((JSON.parse(r.out.slice(r.out.indexOf('['))) as { files: { path: string }[] }[])[0].files.map((f) => f.path));
  const needed = ['bin/agent-qa-kit.mjs', 'package.json', ...expectedFiles().filter((p) => existsSync(join(kit, p)))];
  assert.deepEqual(needed.filter((p) => !packed.has(p)), []);
  assert.ok(isExecutable(join(kit, 'bin/agent-qa-kit.mjs')));
  assert.equal(JSON.parse(read(kit, 'package.json')).bin['agent-qa-kit'], 'bin/agent-qa-kit.mjs');
});
