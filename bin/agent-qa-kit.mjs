#!/usr/bin/env node
// @ts-check
/**
 * Installs the Agent QA Kit into a repository, then checks what its workflows need.
 *
 *   npx github:Gleaming0427/agent-qa-kit init     copy the kit, add the missing npm scripts
 *   npx github:Gleaming0427/agent-qa-kit doctor   check the setup; --run also runs the tests
 *
 * Plain JavaScript on purpose: npx runs this file from node_modules, where Node does not
 * strip TypeScript types.
 *
 * init plans every change before it writes anything. A file is created when it is missing,
 * left alone when it is already identical, and updated only if it is still the version the
 * last install wrote (.agent-qa-kit.json records a digest of each file). Any other existing
 * file is a conflict: nothing is written, unless --force, which only overwrites files that
 * git can give back (committed, no local change).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version;
const MANIFEST = '.agent-qa-kit.json';
const SOURCE = 'github:Gleaming0427/agent-qa-kit';

// Copied as they are. Left out: qa/visual-review.ts (it needs the Anthropic SDK), the kit's
// own tests, the evaluation, and the workflows that only develop the kit.
const KIT_FILES = [
  '.claude/agents/qa-writer.md',
  '.claude/agents/qa-verifier.md',
  '.claude/agents/qa-repairer.md',
  '.claude/hooks/qa-guard.sh',
  '.claude/hooks/verdict-check.ts',
  '.claude/hooks/strict-evidence.ts',
  '.claude/hooks/coverage.ts',
  '.claude/qa-settings.json',
  '.claude/repair-settings.json',
  'qa/check-scope.sh',
  'qa/check-tests.ts',
  'qa/ci-amend-tests.sh',
  'qa/ci-install-app.sh',
  'qa/ci-node-version.sh',
  'qa/ci-install-agents.sh',
  'qa/ci-verify.sh',
  'qa/ci-write-tests.sh',
  'qa/coverage-report.ts',
  'qa/criteria-manifest.ts',
  'qa/full-suite.sh',
  'qa/full-suite.ts',
  'qa/github-approval.ts',
  'qa/repair-loop.sh',
  'qa/run-qa.sh',
  'qa/scenario-review.ts',
  'qa/summary.ts',
  'qa/tooling-integrity.ts',
  'qa/verify-record.ts',
];
// The kit's scripts are ES modules: these make Node read them as such whatever the
// repository's own package.json says ("type": "commonjs", or nothing).
const MODULE_PACKAGE = '{\n  "type": "module"\n}\n';
const GENERATED = { 'qa/package.json': MODULE_PACKAGE, '.claude/hooks/package.json': MODULE_PACKAGE };
const WORKFLOWS = ['qa-write-tests.yml', 'qa-verify.yml', 'qa-branches.yml', 'qa-amend-tests.yml'];
const SCRIPT_NAMES = ['test:unit', 'test:affected', 'test:e2e', 'test:summary'];
const VITEST_REPORT = 'reports/vitest.json';
const PLAYWRIGHT_REPORT = 'reports/playwright.json';
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_NAME = /^[a-z0-9-]+$/;

const USAGE = `Agent QA Kit ${VERSION}

Usage:
  npx ${SOURCE} init [options]     install the kit in this git repository
  npx ${SOURCE} doctor [options]   check the setup (--run also runs the tests)

Options:
  --app DIR       the application folder (its package.json has vitest and @playwright/test);
                  found by itself when there is only one
  --mfe NAME      the feature area that tags the browser tests (default: the folder's name)
  --branch NAME   the branch that pull requests go into (default: the remote's default branch)
  --dry-run       init: show what would change, write nothing
  --force         init: overwrite conflicting files, if they are committed with no local change
  --run           doctor: also run test:unit, test:e2e and test:summary, and read their reports
  -h, --help      this help
  -v, --version   the kit's version
`;

class UserError extends Error {}

// ---------------------------------------------------------------- small helpers

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** @param {string} path */
const toPosix = (path) => path.split(sep).join('/');
/** @param {string} value */
const yamlQuote = (value) => `'${value}'`;
/** @param {string} path @returns {Buffer | null} */
function readBuffer(path) {
  try { return readFileSync(path); } catch { return null; }
}
/** @param {string} path @returns {string | null} */
function readText(path) {
  const data = readBuffer(path);
  return data === null ? null : data.toString('utf8');
}
/** @param {string} path @returns {any} */
function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return undefined; }
}
/** stdout is trimmed; raw keeps it as git wrote it (porcelain lines start with a space).
 * @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new UserError('git is not installed, or cannot be started.');
  return { status: result.status ?? 1, stdout: result.stdout.trim(), raw: result.stdout, stderr: result.stderr.trim() };
}
/** @param {string} command */
function hasCommand(command) {
  const probe = process.platform === 'win32' ? spawnSync('where', [command]) : spawnSync('sh', ['-c', `command -v ${command}`]);
  return probe.status === 0;
}
/** A path relative to the repository, as git and the workflows write it ("." for the root).
 * @param {string} root @param {string} abs */
const repoPath = (root, abs) => toPosix(relative(root, abs)) || '.';
/** @param {string} app @param {string} path */
const inApp = (app, path) => (app === '.' ? path : `${app}/${path}`);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ command: string, app?: string, mfe?: string, branch?: string, dryRun: boolean, force: boolean, run: boolean }} */
  const options = { command: '', dryRun: false, force: false, run: false };
  const valued = { '--app': 'app', '--mfe': 'mfe', '--branch': 'branch' };
  /** @type {string[]} */
  const positionals = [];
  let help = false; let version = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag in valued) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) throw new UserError(`${flag} needs a value.`);
      // @ts-ignore: the key comes from the table above
      options[valued[flag]] = value;
    } else if (inline !== undefined) {
      throw new UserError(`${flag} takes no value.`);
    } else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--run') options.run = true;
    else if (arg === '-h' || arg === '--help') help = true;
    else if (arg === '-v' || arg === '--version') version = true;
    else if (arg.startsWith('-')) throw new UserError(`Unknown option: ${arg}`);
    else positionals.push(arg);
  }
  // --help and --version answer whatever else the command line says; they never install anything.
  if (help || version) return { ...options, command: help ? 'help' : 'version' };
  if (positionals.length > 1) throw new UserError(`Unexpected argument: ${positionals[1]}`);
  options.command = positionals[0] ?? 'help';
  if (!['init', 'doctor', 'help'].includes(options.command)) throw new UserError(`Unknown command: ${options.command}`);
  if (options.command !== 'init' && (options.dryRun || options.force)) throw new UserError('--dry-run and --force are options of init.');
  if (options.command !== 'doctor' && options.run) throw new UserError('--run is an option of doctor.');
  return options;
}

// ---------------------------------------------------------------- the repository and the app

/** @param {string} cwd */
function findRoot(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout) {
    throw new UserError('Not inside a git repository. Run this from the repository that holds your application (git init first if it has none).');
  }
  const root = realpathSync(top.stdout);
  if (realpathSync(KIT) === root || readJson(join(root, 'package.json'))?.name === 'agent-qa-kit') {
    throw new UserError('This is the Agent QA Kit repository itself: run init in the repository of your application.');
  }
  return root;
}

/** @param {any} pkg */
function testTools(pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  return { vitest: typeof deps.vitest === 'string', playwright: typeof deps['@playwright/test'] === 'string' };
}
/** @param {any} pkg */
const hasTestTools = (pkg) => { const t = testTools(pkg); return t.vitest && t.playwright; };

/** Every package.json of the repository, tracked or not, outside ignored folders.
 * @param {string} root */
function packageFolders(root) {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(glob)**/package.json']);
  if (listed.status !== 0) throw new UserError(`git cannot list the repository's files: ${listed.stderr}`);
  return [...new Set(listed.stdout.split('\0').filter(Boolean)
    .filter((path) => !path.split('/').includes('node_modules'))
    .map((path) => dirname(path).replace(/^\.$/, '') || '.'))]
    .filter((folder) => existsSync(join(root, folder, 'package.json')))
    .sort();
}

/** @param {string} root @param {string} cwd @param {string | undefined} option */
function findApp(root, cwd, option) {
  if (option !== undefined) {
    const abs = resolve(cwd, option);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new UserError(`--app ${option} is outside the repository (${root}).`);
    if (!existsSync(join(abs, 'package.json'))) throw new UserError(`--app ${option}: there is no package.json in ${abs}.`);
    return checkAppPath(repoPath(root, abs));
  }
  const here = repoPath(root, realpathSync(cwd));
  if (hasTestTools(readJson(join(root, here, 'package.json')))) return checkAppPath(here);
  const candidates = packageFolders(root).filter((folder) => hasTestTools(readJson(join(root, folder, 'package.json'))));
  if (candidates.length === 1) return checkAppPath(candidates[0]);
  if (candidates.length === 0) {
    throw new UserError('No application found: the kit needs a package.json with vitest and @playwright/test in its devDependencies. '
      + 'Install them (npm install -D vitest @playwright/test), or give the folder with --app.');
  }
  throw new UserError(`Several applications have vitest and @playwright/test: ${candidates.join(', ')}. Choose one with --app.`);
}

/** @param {string} app */
function checkAppPath(app) {
  if (!SAFE_PATH.test(app) || app.split('/').includes('..') || app.startsWith('-')) {
    throw new UserError(`The application folder "${app}" can only use letters, digits, ".", "_", "-" and "/": the workflows refuse other names.`);
  }
  if (app.split('/').includes('node_modules')) throw new UserError(`${app} is inside node_modules.`);
  return app;
}

/** @param {string} root @param {string} app */
function defaultMfe(root, app) {
  const name = (app === '.' ? basename(root) : basename(app)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'app';
}

/** @param {string} root */
function remoteDefaultBranch(root) {
  const head = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return head.status === 0 && head.stdout.startsWith('origin/') ? head.stdout.slice('origin/'.length) : null;
}
/** @param {string} root */
function defaultBranch(root) {
  const remote = remoteDefaultBranch(root);
  if (remote) return remote;
  for (const name of ['main', 'master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0) return name;
  }
  const current = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return current.status === 0 && current.stdout ? current.stdout : 'main';
}

/** @param {string} root @returns {{ version: string, app: string, mfe: string, branch: string, files: Record<string, string> } | null} */
function readManifest(root) {
  const manifest = readJson(join(root, MANIFEST));
  if (manifest === null) return null;
  const valid = manifest && typeof manifest === 'object' && typeof manifest.app === 'string' && typeof manifest.mfe === 'string'
    && typeof manifest.branch === 'string' && manifest.files && typeof manifest.files === 'object'
    && Object.values(manifest.files).every((digest) => typeof digest === 'string');
  if (!valid) throw new UserError(`${MANIFEST} is not a manifest this installer can read: restore it from git, or delete it to install from scratch.`);
  return manifest;
}

// ---------------------------------------------------------------- what to install

/** @param {string} text @param {string} from @param {string} to @param {string} file */
function replaceOnce(text, from, to, file) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${file}: expected ${JSON.stringify(from)} once, found it ${count} times. The installer and the workflow disagree.`);
  return text.replace(from, () => to);
}

/** The workflows with this repository's application, feature area and branch.
 * @param {string} name @param {string} text @param {{ app: string, mfe: string, branch: string }} target */
function patchWorkflow(name, text, { app, mfe, branch }) {
  if (name === 'qa-write-tests.yml') {
    text = replaceOnce(text, '        default: shop\n', `        default: ${yamlQuote(mfe)}\n`, name);
    return replaceOnce(text, '        default: examples/shop\n', `        default: ${yamlQuote(app)}\n`, name);
  }
  if (name === 'qa-amend-tests.yml') return replaceOnce(text, '        default: examples/shop\n', `        default: ${yamlQuote(app)}\n`, name);
  if (name === 'qa-verify.yml') return replaceOnce(text, '    branches: [main]\n', `    branches: [${yamlQuote(branch)}]\n`, name);
  return text;
}

/** @param {{ app: string, mfe: string, branch: string }} target @returns {{ path: string, content: Buffer }[]} */
function kitFiles(target) {
  const files = KIT_FILES.map((path) => ({ path, content: readFileSync(join(KIT, path)) }));
  for (const [path, text] of Object.entries(GENERATED)) files.push({ path, content: Buffer.from(text) });
  for (const name of WORKFLOWS) {
    const text = readFileSync(join(KIT, '.github/workflows', name), 'utf8');
    files.push({ path: `.github/workflows/${name}`, content: Buffer.from(patchWorkflow(name, text, target)) });
  }
  return files;
}

/** The first existing file among a folder's candidates.
 * @param {string} dir @param {string[]} names */
function firstFile(dir, names) {
  for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}
const configExtensions = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
/** @param {string} appDir */
const playwrightConfig = (appDir) => firstFile(appDir, configExtensions.map((ext) => `playwright.config.${ext}`));
/** @param {string} appDir */
const vitestConfig = (appDir) => firstFile(appDir, [...configExtensions.map((ext) => `vitest.config.${ext}`), ...configExtensions.map((ext) => `vite.config.${ext}`)]);

/** The npm scripts the agents and the workflows call. A script that exists is never changed.
 * @param {string} root @param {string} app */
function wantedScripts(root, app) {
  const appDir = join(root, app);
  const fromRoot = toPosix(relative(appDir, root));
  const vitestWrites = readText(vitestConfig(appDir) ?? '')?.includes(VITEST_REPORT);
  const playwrightWrites = readText(playwrightConfig(appDir) ?? '')?.includes(PLAYWRIGHT_REPORT);
  const unit = vitestWrites ? 'vitest run' : `vitest run --reporter=default --reporter=json --outputFile.json=${VITEST_REPORT}`;
  return {
    'test:unit': unit,
    'test:affected': unit,
    'test:e2e': playwrightWrites ? 'playwright test' : `PLAYWRIGHT_JSON_OUTPUT_FILE=${PLAYWRIGHT_REPORT} playwright test --reporter=list,json`,
    'test:summary': `node ${fromRoot ? `${fromRoot}/` : ''}qa/summary.ts`,
  };
}

/** The package.json text with the missing scripts added, its indentation and line endings kept.
 * @param {string} text @param {Record<string, string>} add */
function withScripts(text, add) {
  const pkg = JSON.parse(text);
  if (pkg.scripts !== undefined && (typeof pkg.scripts !== 'object' || pkg.scripts === null || Array.isArray(pkg.scripts))) {
    throw new UserError('The application\'s package.json has a "scripts" field that is not an object.');
  }
  pkg.scripts = { ...(pkg.scripts ?? {}), ...add };
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
  let out = JSON.stringify(pkg, null, indent);
  if (/\r?\n$/.test(text)) out += '\n';
  return text.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out;
}

/** The part of a path that stops the installer from writing a plain file there: a symbolic link
 * (it could lead outside the repository), a file where a folder should be, or a folder where
 * the file should be. null when the path is clear.
 * @param {string} root @param {string} path */
function blockedBy(root, path) {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    let stat;
    try { stat = lstatSync(join(root, ...parts.slice(0, i))); } catch { return null; }
    const last = i === parts.length;
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && !stat.isFile())) return parts.slice(0, i).join('/');
  }
  return null;
}

/** The paths git could not give back as they are now: untracked, ignored, or changed since the
 * last commit. --force only overwrites the others.
 * @param {string} root @param {string[]} paths @returns {Set<string>} */
function uncommitted(root, paths) {
  if (!paths.length) return new Set();
  const tracked = git(root, ['ls-files', '-z', '--', ...paths]);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]);
  if (tracked.status !== 0 || status.status !== 0) return new Set(paths);
  const clean = new Set(tracked.raw.split('\0').filter(Boolean));
  // Each entry is "XY path"; a rename adds its old path as the next entry, which matches nothing here.
  for (const entry of status.raw.split('\0')) if (entry.length > 3) clean.delete(entry.slice(3));
  return new Set(paths.filter((path) => !clean.has(path)));
}

/** @param {string} root @param {ReturnType<typeof parseArgs>} options @param {string} cwd */
function plan(root, options, cwd) {
  const manifest = readManifest(root);
  const app = options.app !== undefined ? findApp(root, cwd, options.app)
    : manifest && existsSync(join(root, manifest.app, 'package.json')) ? checkAppPath(manifest.app) : findApp(root, cwd, undefined);
  const mfe = options.mfe ?? (manifest && manifest.app === app ? manifest.mfe : defaultMfe(root, app));
  if (!SAFE_NAME.test(mfe)) throw new UserError(`The feature area "${mfe}" can only use lowercase letters, digits and dashes.`);
  const branch = options.branch ?? manifest?.branch ?? defaultBranch(root);
  if (!SAFE_PATH.test(branch) || branch.startsWith('-')) throw new UserError(`"${branch}" is not a branch name the installer accepts.`);

  const previous = manifest?.files ?? {};
  /** @type {{ path: string, content: Buffer, action: string, executable: boolean }[]} */
  const files = [];
  for (const { path, content } of kitFiles({ app, mfe, branch })) {
    const executable = path.endsWith('.sh');
    if (blockedBy(root, path)) { files.push({ path, content, action: 'blocked', executable }); continue; }
    const current = readBuffer(join(root, path));
    let action;
    if (current === null) action = 'create';
    else if (current.equals(content)) {
      action = executable && process.platform !== 'win32' && (statSync(join(root, path)).mode & 0o111) === 0 ? 'chmod' : 'unchanged';
    } else if (previous[path] === sha256(current)) action = 'update';
    else action = 'conflict';
    files.push({ path, content, action, executable });
  }
  if (options.force) {
    const dirty = uncommitted(root, files.filter((f) => f.action === 'conflict').map((f) => f.path));
    for (const file of files) if (file.action === 'conflict') file.action = dirty.has(file.path) ? 'dirty' : 'overwrite';
  }
  const obsolete = Object.keys(previous).filter((path) => !files.some((f) => f.path === path) && existsSync(join(root, path)));

  const pkgPath = join(root, app, 'package.json');
  const pkgText = readText(pkgPath) ?? '';
  let pkg;
  try { pkg = JSON.parse(pkgText); } catch { throw new UserError(`${inApp(app, 'package.json')} is not valid JSON.`); }
  const wanted = wantedScripts(root, app);
  /** @type {Record<string, string>} */
  const scripts = {};
  for (const name of SCRIPT_NAMES) if (!(pkg.scripts && Object.hasOwn(pkg.scripts, name))) scripts[name] = wanted[/** @type {keyof typeof wanted} */ (name)];
  const pkgNext = Object.keys(scripts).length ? withScripts(pkgText, scripts) : null;

  const ignored = git(root, ['check-ignore', '-q', '--', inApp(app, VITEST_REPORT)]);
  if (ignored.status > 1) throw new UserError(`git check-ignore failed: ${ignored.stderr}`);
  const gitignore = ignored.status === 0 ? null : inApp(app, '.gitignore');
  if (gitignore && existsSync(join(root, gitignore)) && blockedBy(root, gitignore)) {
    throw new UserError(`${gitignore} is a symbolic link or not a file: add "/reports/" to the application's ignore rules yourself, then run init again.`);
  }

  return { app, mfe, branch, files, obsolete, scripts, pkgPath, pkgNext, gitignore };
}

// ---------------------------------------------------------------- writing

/** Writes every file through a temporary file and a rename: a file is either the old one or the
 * new one, never half written. If a write fails, the temporary files are removed and nothing
 * has changed.
 * @param {string} root @param {{ path: string, content: Buffer | string, mode: number }[]} writes */
function writeAll(root, writes) {
  const staged = [];
  try {
    for (const { path, content, mode } of writes) {
      const abs = join(root, path);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.agent-qa-kit-${process.pid}.tmp`;
      writeFileSync(tmp, content, { mode });
      chmodSync(tmp, mode);
      staged.push({ tmp, abs });
    }
  } catch (error) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw error;
  }
  for (const { tmp, abs } of staged) renameSync(tmp, abs);
}

/** @param {string} root @param {ReturnType<typeof plan>} p */
function apply(root, p) {
  const changed = p.files.filter((f) => ['create', 'update', 'overwrite'].includes(f.action));
  /** @type {{ path: string, content: Buffer | string, mode: number }[]} */
  const writes = changed.map((f) => ({ path: f.path, content: f.content, mode: f.executable ? 0o755 : 0o644 }));
  if (p.pkgNext !== null) writes.push({ path: repoPath(root, p.pkgPath), content: p.pkgNext, mode: statSync(p.pkgPath).mode & 0o777 });
  writeAll(root, writes);
  for (const f of p.files) if (f.action === 'chmod') chmodSync(join(root, f.path), 0o755);
  if (p.gitignore) {
    const abs = join(root, p.gitignore);
    const before = readText(abs) ?? '';
    appendFileSync(abs, `${before && !before.endsWith('\n') ? '\n' : ''}# Agent QA Kit: test reports and agent verdicts\n/reports/\n`);
  }
  // Where git does not record file modes (core.fileMode false, the default on Windows), the hook
  // would reach CI without its executable bit: record it in the index.
  /** @type {string[]} */
  const staged = [];
  if (git(root, ['config', '--type=bool', '--get', 'core.fileMode']).stdout === 'false') {
    const scripts = p.files.filter((f) => f.executable).map((f) => f.path);
    const added = git(root, ['add', '--chmod=+x', '--', ...scripts]);
    if (added.status !== 0) throw new UserError(`The kit is installed, but git could not record the executable bit of its scripts: ${added.stderr} Run git add --chmod=+x -- ${scripts.join(' ')}`);
    staged.push(...scripts);
  }
  const manifest = {
    kit: 'agent-qa-kit',
    version: VERSION,
    app: p.app,
    mfe: p.mfe,
    branch: p.branch,
    files: Object.fromEntries(p.files.map((f) => [f.path, sha256(f.content)]).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeAll(root, [{ path: MANIFEST, content: `${JSON.stringify(manifest, null, 2)}\n`, mode: 0o644 }]);
  return staged;
}

// ---------------------------------------------------------------- checking

/** @typedef {{ level: 'ok' | 'warn' | 'fail', text: string }} Check */

/** @param {string} dir @param {(path: string) => boolean} keep @param {number} [limit] */
function walk(dir, keep, limit = 2000) {
  /** @type {string[]} */
  const found = [];
  const stack = [dir];
  while (stack.length && found.length < limit) {
    const current = /** @type {string} */ (stack.pop());
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && keep(abs)) found.push(abs);
    }
  }
  return found;
}

/** Comments and trailing commas out, so that a tsconfig parses as JSON.
 * @param {string} text */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = text.slice(i).match(/^"(?:[^"\\]|\\.)*"/);
      if (!end) return undefined;
      out += end[0]; i += end[0].length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return undefined;
      i = close + 1;
    } else out += c;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return undefined; }
}

/** Whether a tsconfig at the repository's root would type-check the kit's scripts without the
 * option their imports need (they end in .ts, as Node runs them).
 * @param {any} config */
function tsconfigCoversKit(config) {
  if (!config || typeof config !== 'object' || config.compilerOptions?.allowImportingTsExtensions === true) return false;
  const excluded = (config.exclude ?? []).some((/** @type {unknown} */ e) => typeof e === 'string' && /^(\.\/)?qa(\/|$)/.test(e));
  if (excluded) return false;
  if (config.include === undefined) return config.files === undefined;
  return (config.include ?? []).some((/** @type {unknown} */ i) => typeof i === 'string' && /^(\.\/)?(\*\*|\*\/|qa(\/|$))/.test(i));
}

/** How the workflows will install the application: the same decision as qa/ci-install-app.sh,
 * which the tests compare with this one on the same repositories.
 * @param {string} root @param {string} appDir
 * @returns {{ manager: 'npm' | 'pnpm', lockDir: string, version: string } | { problem: string }} */
function installPlan(root, appDir) {
  /** @param {string} dir */
  const declared = (dir) => { const value = readJson(join(dir, 'package.json'))?.packageManager; return typeof value === 'string' ? value : ''; };
  for (let dir = appDir; ; dir = dirname(dir)) {
    const npm = existsSync(join(dir, 'package-lock.json'));
    const pnpm = existsSync(join(dir, 'pnpm-lock.yaml'));
    const rel = repoPath(root, dir);
    if (npm || pnpm) {
      /** @type {'npm' | 'pnpm'} */
      let manager = pnpm ? 'pnpm' : 'npm';
      if (npm && pnpm) {
        if (declared(dir).startsWith('pnpm@')) manager = 'pnpm';
        else if (declared(dir).startsWith('npm@')) manager = 'npm';
        else return { problem: `${rel} has both package-lock.json and pnpm-lock.yaml: delete the one you do not use, or name the package manager in "packageManager".` };
      }
      if (dir !== appDir && manager === 'pnpm' && !existsSync(join(dir, 'pnpm-workspace.yaml'))) {
        return { problem: `${inApp(rel, 'pnpm-lock.yaml')} is not the application's: there is no pnpm-workspace.yaml next to it. Commit the application's own lockfile.` };
      }
      if (dir !== appDir && manager === 'npm' && !Array.isArray(readJson(join(dir, 'package.json'))?.workspaces)) {
        return { problem: `${inApp(rel, 'package-lock.json')} is not the application's: its package.json has no "workspaces". Commit the application's own lockfile.` };
      }
      if (manager === 'npm') return { manager, lockDir: dir, version: '-' };
      const match = declared(dir).match(/^pnpm@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)(\+[0-9A-Za-z.]+)?$/);
      if (!match) {
        const local = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
        const yours = local.status === 0 && /^\d+\.\d+\.\d+/.test(local.stdout.trim()) ? local.stdout.trim() : '<version>';
        return { problem: `Name the pnpm version in ${inApp(rel, 'package.json')}: "packageManager": "pnpm@${yours}"${yours === '<version>' ? ', the output of pnpm --version' : ' (your pnpm --version)'}. Every pnpm version writes the same lockfile format, so the workflows cannot tell which one to install.` };
      }
      return { manager, lockDir: dir, version: match[1] };
    }
    const other = ['yarn.lock', 'bun.lock', 'bun.lockb'].find((name) => existsSync(join(dir, name)));
    if (other) return { problem: `The application uses ${other}: the workflows install applications with npm or pnpm only.` };
    if (dir === root || dirname(dir) === dir) break;
  }
  return { problem: 'No package-lock.json or pnpm-lock.yaml: install the application with npm or pnpm and commit the lockfile. The workflows install from it.' };
}

/** The Node.js version the workflows give the application: the same decision as
 * qa/ci-node-version.sh, which the tests compare with this one.
 * @param {string} root @param {string} appDir @returns {{ version: string, from: string } | { problem: string }} */
function nodePlan(root, appDir) {
  for (let dir = appDir; ; dir = dirname(dir)) {
    for (const name of ['.nvmrc', '.node-version']) {
      const text = readText(join(dir, name));
      if (text === null) continue;
      const from = repoPath(root, join(dir, name));
      const line = (text.split('\n').find((l) => !/^\s*#/.test(l) && /\S/.test(l)) ?? '').replace(/\s+/g, '');
      if (!line) return { problem: `${from} is empty: write a Node.js version in it, such as 22 or 24.11.1.` };
      const version = line.replace(/^v/, '');
      const match = version.match(/^(\d+)(\.(\d+))?(\.\d+)?$/);
      if (match) {
        const major = Number(match[1]);
        if (major < 22 || (major === 22 && match[3] !== undefined && Number(match[3]) < 18)) {
          return { problem: `${from} names Node.js ${line}; the kit's scripts need 22.18 or later. Use a later version in CI, or run the kit's workflows on a branch that does.` };
        }
      } else if (!['lts/*', 'latest', 'current', 'node'].includes(version)) {
        return { problem: `${from} names "${line}": write a version number, such as 22 or 24.11.1 (or lts/*), so that the kit can check it is 22.18 or later.` };
      }
      return { version, from };
    }
    if (dir === root || dirname(dir) === dir) break;
  }
  return { version: '22', from: 'default' };
}

/** The runtime entry a package.json gives: exports, then main.
 * @param {any} pkg @returns {string | null} */
function entryOf(pkg) {
  /** @param {any} value @returns {string | null} */
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return null;
    for (const key of ['.', 'import', 'default', 'require', 'node']) {
      const found = pick(value[key]);
      if (found) return found;
    }
    return null;
  };
  return pick(pkg?.exports) ?? (typeof pkg?.main === 'string' ? pkg.main : null);
}

/** Packages of the repository the application depends on whose entry is not committed but
 * made by their build script: missing after a fresh install, as in CI.
 * @param {string} root @param {any} pkg @returns {{ name: string, entry: string }[]} */
function unbuiltWorkspaceDeps(root, pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  /** @type {Map<string, { folder: string, pkg: any }>} */
  const local = new Map();
  for (const folder of packageFolders(root)) {
    const found = readJson(join(root, folder, 'package.json'));
    if (found && typeof found.name === 'string' && !local.has(found.name)) local.set(found.name, { folder, pkg: found });
  }
  const unbuilt = [];
  for (const name of Object.keys(deps).sort()) {
    const found = local.get(name);
    const entry = found && typeof found.pkg.scripts?.build === 'string' ? entryOf(found.pkg) : null;
    if (!found || !entry) continue;
    const path = toPosix(join(found.folder, entry)).replace(/^\.\//, '');
    if (git(root, ['ls-files', '--error-unmatch', '--', path]).status !== 0) unbuilt.push({ name, entry: path });
  }
  return unbuilt;
}

/** @param {string} root @param {string} cwd @param {ReturnType<typeof parseArgs>} options @returns {{ app: string | null, sections: [string, Check[]][] }} */
function doctor(root, cwd, options) {
  /** @type {[string, Check[]][]} */
  const sections = [];
  /** @type {Check[]} */
  const kit = [];
  sections.push(['The kit', kit]);
  let manifest = null;
  try { manifest = readManifest(root); } catch (error) { kit.push({ level: 'fail', text: /** @type {Error} */ (error).message }); }
  if (!manifest && !kit.length) kit.push({ level: 'fail', text: `Not installed in ${root}: run npx ${SOURCE} init` });
  if (manifest) {
    const missing = []; const changed = []; const notExecutable = [];
    for (const [path, digest] of Object.entries(manifest.files)) {
      const content = readBuffer(join(root, path));
      if (content === null) { missing.push(path); continue; }
      if (sha256(content) !== digest) changed.push(path);
      if (path.endsWith('.sh')) {
        const index = git(root, ['ls-files', '-s', '--', path]).stdout;
        const fsMode = process.platform === 'win32' ? 0o755 : statSync(join(root, path)).mode;
        if ((index && !index.startsWith('100755')) || (fsMode & 0o111) === 0) notExecutable.push(path);
      }
    }
    // A file git ignores never reaches CI.
    const ignored = git(root, ['check-ignore', '--', ...Object.keys(manifest.files)]).stdout.split('\n').filter(Boolean);
    if (ignored.length) kit.push({ level: 'fail', text: `Ignored by git, so the workflows would not have them: ${ignored.join(', ')}. Change the .gitignore rules that match them.` });
    const count = Object.keys(manifest.files).length;
    if (missing.length) kit.push({ level: 'fail', text: `Missing: ${missing.join(', ')}. Run init again to restore them.` });
    if (changed.length) kit.push({ level: 'warn', text: `Changed since the install: ${changed.join(', ')}. init will not update them; --force overwrites them.` });
    if (notExecutable.length) {
      kit.push({ level: 'fail', text: `Not executable: ${notExecutable.join(', ')}. The guard hook is started directly: run git add --chmod=+x -- ${notExecutable.join(' ')}` });
    }
    if (!missing.length && !changed.length) kit.push({ level: 'ok', text: `${count} files of version ${manifest.version}, as installed` });
    if (manifest.version !== VERSION) kit.push({ level: 'warn', text: `Installed version ${manifest.version}; this installer is ${VERSION}: run init to upgrade.` });
    const remote = remoteDefaultBranch(root);
    if (remote && remote !== manifest.branch) {
      kit.push({ level: 'warn', text: `QA verify runs on pull requests into ${manifest.branch}, but the remote's default branch is ${remote}: run init --branch ${remote}` });
    }
  }

  let app = null;
  try {
    app = options.app !== undefined ? findApp(root, cwd, options.app)
      : manifest && existsSync(join(root, manifest.app, 'package.json')) ? manifest.app : findApp(root, cwd, undefined);
  } catch (error) {
    kit.push({ level: 'fail', text: /** @type {Error} */ (error).message });
  }
  if (app === null) return { app, sections };

  /** @type {Check[]} */
  const checks = [];
  sections.push([`The application, ${app}`, checks]);
  const appDir = join(root, app);
  const pkg = readJson(join(appDir, 'package.json'));
  if (!pkg || typeof pkg !== 'object') {
    checks.push({ level: 'fail', text: `${inApp(app, 'package.json')} is not valid JSON.` });
    return { app, sections };
  }
  const tools = testTools(pkg);
  if (tools.vitest && tools.playwright) checks.push({ level: 'ok', text: 'vitest and @playwright/test are dependencies' });
  if (!tools.vitest) checks.push({ level: 'fail', text: 'vitest is not a dependency: npm install -D vitest' });
  if (!tools.playwright) checks.push({ level: 'fail', text: '@playwright/test is not a dependency: npm install -D @playwright/test' });

  const scripts = pkg.scripts ?? {};
  const absent = SCRIPT_NAMES.filter((name) => typeof scripts[name] !== 'string');
  checks.push(absent.length
    ? { level: 'fail', text: `Missing npm scripts: ${absent.join(', ')}. init adds them.` }
    : { level: 'ok', text: `npm scripts ${SCRIPT_NAMES.join(', ')}` });

  // The workflows install the application as qa/ci-install-app.sh decides, from its lockfile.
  const install = installPlan(root, appDir);
  if ('problem' in install) checks.push({ level: 'fail', text: install.problem });
  else {
    const how = install.manager === 'npm' ? 'with npm ci' : `with pnpm ${install.version}`;
    const needed = [join(install.lockDir, install.manager === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml')];
    if (install.manager === 'pnpm' && existsSync(join(install.lockDir, 'pnpm-workspace.yaml'))) needed.push(join(install.lockDir, 'pnpm-workspace.yaml'));
    const untracked = needed.map((abs) => repoPath(root, abs)).filter((path) => git(root, ['ls-files', '--error-unmatch', '--', path]).status !== 0);
    checks.push(untracked.length
      ? { level: 'warn', text: `${untracked.join(' and ')} not committed yet: the workflows install the application ${how}, from what is committed.` }
      : { level: 'ok', text: `${repoPath(root, needed[0])} is committed: the workflows install the application ${how}` });
  }

  // The Node.js the workflows set up for it (qa/ci-node-version.sh).
  const node = nodePlan(root, appDir);
  checks.push('problem' in node ? { level: 'fail', text: node.problem }
    : { level: 'ok', text: `the workflows run it on Node.js ${node.version} (${node.from === 'default' ? 'it names none in .nvmrc or .node-version' : `from ${node.from}`})` });

  // A step it needs after the install: qa:setup, which the install step runs.
  if (typeof scripts['qa:setup'] === 'string') {
    checks.push({ level: 'ok', text: `qa:setup runs after the install: ${scripts['qa:setup']}` });
  } else {
    const unbuilt = unbuiltWorkspaceDeps(root, pkg);
    if (unbuilt.length) {
      const pnpm = !('problem' in install) && install.manager === 'pnpm';
      const build = unbuilt.map(({ name }) => (pnpm ? `pnpm --filter ${name} build` : `npm run build --workspace ${name}`)).join(' && ');
      checks.push({ level: 'warn', text: `It uses ${unbuilt.map(({ name, entry }) => `${name} (${entry})`).join(', ')} from the repository, made by a build script and not committed: a fresh install, as in CI, does not have it. Add a script that builds it, which the install step runs: "qa:setup": "${build}"` });
    }
  }

  const vConfig = vitestConfig(appDir);
  const vText = readText(vConfig ?? '') ?? '';
  const unitScripts = `${scripts['test:unit'] ?? ''} ${scripts['test:affected'] ?? ''}`;
  const unitBoth = [scripts['test:unit'], scripts['test:affected']].every((s) => typeof s === 'string' && (s.includes(VITEST_REPORT) || vText.includes(VITEST_REPORT)));
  checks.push(unitBoth ? { level: 'ok', text: `test:unit and test:affected write ${VITEST_REPORT}` }
    : { level: 'warn', text: `Cannot see test:unit and test:affected writing ${VITEST_REPORT}: the checks read that report. Add --reporter=default --reporter=json --outputFile.json=${VITEST_REPORT}, or confirm with doctor --run.` });
  if (!vConfig) {
    checks.push({ level: 'warn', text: 'No vitest.config or vite.config: Vitest\'s default pattern would also collect the browser tests in e2e/. Set test.include, for instance [\'src/**/*.test.{ts,tsx}\'].' });
  } else if (!/\b(include|exclude)\s*:/.test(vText) && !unitScripts.includes('--exclude') && !unitScripts.includes('--dir')) {
    checks.push({ level: 'warn', text: `${repoPath(root, vConfig)} sets no test.include: Vitest would also collect the browser tests in e2e/. Set test.include, for instance ['src/**/*.test.{ts,tsx}'].` });
  }

  const pConfig = playwrightConfig(appDir);
  const pText = readText(pConfig ?? '') ?? '';
  const e2eScript = typeof scripts['test:e2e'] === 'string' ? scripts['test:e2e'] : '';
  checks.push(e2eScript.includes(PLAYWRIGHT_REPORT) || (pText.includes(PLAYWRIGHT_REPORT) && !/--reporter\b/.test(e2eScript))
    ? { level: 'ok', text: `test:e2e writes ${PLAYWRIGHT_REPORT}` }
    : { level: 'warn', text: `Cannot see test:e2e writing ${PLAYWRIGHT_REPORT}: add ['json', { outputFile: '${PLAYWRIGHT_REPORT}' }] to the reporters in playwright.config, or confirm with doctor --run.` });
  let testDir = 'e2e';
  if (!pConfig) {
    checks.push({ level: 'warn', text: 'No playwright.config: the browser tests need one, with testDir: \'./e2e\' and a webServer that starts the application.' });
  } else {
    const dir = pText.match(/\btestDir\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    const normalized = dir === undefined ? '' : toPosix(dir).replace(/^\.\//, '').replace(/\/+$/, '');
    if (dir !== undefined && normalized !== 'e2e' && normalized !== '.' && normalized !== '') {
      testDir = normalized;
      checks.push({ level: 'warn', text: `Playwright's testDir is ${dir}: the QA agents write their browser tests in e2e/, which Playwright would not run.` });
    } else if ((normalized === '' || normalized === '.') && !/\btestMatch\s*:/.test(pText)) {
      checks.push({ level: 'warn', text: 'Playwright looks for tests in the whole application, unit tests included: set testDir: \'./e2e\'.' });
    } else checks.push({ level: 'ok', text: 'Playwright runs the browser tests in e2e/' });
    if (!/\bwebServer\s*:/.test(pText)) {
      checks.push({ level: 'warn', text: 'playwright.config has no webServer: in CI, Playwright has to start the application itself.' });
    }
  }
  const specDir = join(appDir, testDir);
  const specs = existsSync(specDir) ? walk(specDir, (path) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path)) : [];
  if (!specs.length) {
    checks.push({ level: 'fail', text: `No browser test in ${inApp(app, testDir)}/ yet. QA verify's full suite needs at least one passing test tagged @smoke, a journey that must always work.` });
  } else if (!specs.some((path) => readText(path)?.includes('@smoke'))) {
    checks.push({ level: 'fail', text: 'No browser test is tagged @smoke. QA verify\'s full suite needs at least one passing smoke journey: add @smoke to the title of a test that must always work, or { tag: \'@smoke\' }.' });
  } else checks.push({ level: 'ok', text: 'a browser test is tagged @smoke' });

  const ignored = git(root, ['check-ignore', '-q', '--', inApp(app, VITEST_REPORT)]).status === 0;
  checks.push(ignored ? { level: 'ok', text: `${inApp(app, 'reports/')} is ignored by git` }
    : { level: 'fail', text: `${inApp(app, 'reports/')} is not ignored by git: the agents' reports would be committed. init adds it to .gitignore.` });

  for (const name of ['tsconfig.json']) {
    const config = parseJsonc(readText(join(root, name)) ?? '');
    if (tsconfigCoversKit(config)) {
      checks.push({ level: 'warn', text: `The repository's ${name} would also type-check qa/ and .claude/hooks/, whose imports end in .ts (allowImportingTsExtensions): add "qa" and ".claude" to its "exclude", next to "node_modules".` });
    }
  }

  /** @type {Check[]} */
  const machine = [];
  sections.push(['This computer (only to run the agents here; CI installs its own)', machine]);
  const [major, minor] = process.versions.node.split('.').map(Number);
  machine.push(major > 22 || (major === 22 && minor >= 18) ? { level: 'ok', text: `Node.js ${process.versions.node}` }
    : { level: 'warn', text: `Node.js ${process.versions.node}: the kit's scripts need 22.18 or later.` });
  const ciNode = 'version' in node ? node.version : '';
  const ciMajor = Number(ciNode.split('.')[0]);
  if (Number.isInteger(ciMajor) && ciMajor > 0 && ciMajor !== major) {
    machine.push({ level: 'warn', text: `The workflows will use Node.js ${ciNode}, this computer has ${process.versions.node}: doctor --run may not show what CI will.` });
  }
  if (process.platform === 'win32') machine.push({ level: 'warn', text: 'The agents run on Linux or macOS. On Windows, use the GitHub workflows.' });
  const missingTools = ['bash', 'jq', 'claude'].filter((tool) => !hasCommand(tool));
  machine.push(missingTools.length ? { level: 'warn', text: `Not found: ${missingTools.join(', ')}. Only needed to run the agents on this computer.` }
    : { level: 'ok', text: 'bash, jq and the Claude Code CLI' });
  return { app, sections };
}

/** @param {any} report @returns {{ total: number, failed: number, smoke: number }} */
function playwrightCounts(report) {
  let total = 0; let failed = 0; let smoke = 0;
  /** @param {any[] | undefined} suites @param {string[]} path */
  const visit = (suites, path) => {
    for (const suite of suites ?? []) {
      const titles = suite.title ? [...path, suite.title] : path;
      for (const spec of suite.specs ?? []) {
        const title = [...titles, spec.title].join(' ');
        const tagged = (spec.tags ?? []).includes('smoke') || /(^|\s)@smoke\b/.test(title);
        for (const test of spec.tests ?? []) {
          total++;
          if (test.status === 'unexpected' || test.status === 'flaky') failed++;
          if (tagged && test.status === 'expected') smoke++;
        }
      }
      visit(suite.suites, titles);
    }
  };
  visit(report?.suites, []);
  return { total, failed, smoke };
}

/** Runs the application's scripts as QA verify's full suite does, and reads their reports.
 * @param {string} root @param {string} app @returns {Check[]} */
function runChecks(root, app) {
  const appDir = join(root, app);
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  /** @param {string} script */
  const run = (script) => {
    console.log(`\n$ npm run ${script}   (in ${app})`);
    const result = spawnSync('npm', ['run', script], { cwd: appDir, stdio: 'inherit', env, shell: process.platform === 'win32' });
    return result.status ?? 1;
  };
  /** @param {string} path @param {number} since */
  const fresh = (path, since) => { try { return statSync(path).mtimeMs >= since ? readJson(path) : null; } catch { return null; } };
  /** @type {Check[]} */
  const checks = [];

  // The install step runs qa:setup after the install: so does this check, before the tests.
  if (typeof readJson(join(appDir, 'package.json'))?.scripts?.['qa:setup'] === 'string') {
    const setupCode = run('qa:setup');
    checks.push(setupCode === 0 ? { level: 'ok', text: 'npm run qa:setup' } : { level: 'fail', text: `npm run qa:setup failed (code ${setupCode}).` });
  }

  let since = Date.now() - 2000;
  const unitCode = run('test:unit');
  const vitest = fresh(join(appDir, VITEST_REPORT), since);
  const unitTests = (vitest?.testResults ?? []).reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (f.assertionResults ?? []).length, 0);
  const unitFailed = (vitest?.testResults ?? []).reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (f.assertionResults ?? []).filter((/** @type {any} */ t) => t.status === 'failed').length, 0);
  if (!vitest) checks.push({ level: 'fail', text: `npm run test:unit did not write ${VITEST_REPORT} (code ${unitCode}).` });
  else if (!unitTests) checks.push({ level: 'fail', text: `npm run test:unit ran no test (${VITEST_REPORT}).` });
  else if (unitFailed || unitCode !== 0) checks.push({ level: 'fail', text: `npm run test:unit: ${unitFailed} of ${unitTests} tests fail (code ${unitCode}). QA verify's full suite needs them to pass.` });
  else checks.push({ level: 'ok', text: `npm run test:unit: ${unitTests} tests pass, ${VITEST_REPORT} written` });

  since = Date.now() - 2000;
  const e2eCode = run('test:e2e');
  const playwright = fresh(join(appDir, PLAYWRIGHT_REPORT), since);
  const counts = playwrightCounts(playwright);
  if (!playwright) checks.push({ level: 'fail', text: `npm run test:e2e did not write ${PLAYWRIGHT_REPORT} (code ${e2eCode}).` });
  else if (!counts.total) checks.push({ level: 'fail', text: `npm run test:e2e ran no test (${PLAYWRIGHT_REPORT}).` });
  else if (counts.failed || e2eCode !== 0 || (playwright.errors ?? []).length) {
    checks.push({ level: 'fail', text: `npm run test:e2e: ${counts.failed} of ${counts.total} tests fail or are flaky (code ${e2eCode}). QA verify's full suite needs them to pass.` });
  } else checks.push({ level: 'ok', text: `npm run test:e2e: ${counts.total} tests pass, ${PLAYWRIGHT_REPORT} written` });
  if (playwright && !counts.smoke) checks.push({ level: 'fail', text: 'No test tagged @smoke passed: QA verify\'s full suite needs one.' });
  else if (playwright) checks.push({ level: 'ok', text: `${counts.smoke} @smoke test(s) passed` });

  const summaryCode = run('test:summary');
  checks.push(summaryCode === 0 ? { level: 'ok', text: 'npm run test:summary reads both reports' }
    : { level: 'fail', text: `npm run test:summary failed (code ${summaryCode}).` });
  return checks;
}

/** @param {[string, Check[]][]} sections */
function printChecks(sections) {
  const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  for (const [title, checks] of sections) {
    if (!checks.length) continue;
    console.log(`\n${title}`);
    for (const check of checks) console.log(`  ${mark[check.level]}  ${check.text}`);
  }
  return sections.flatMap(([, checks]) => checks).filter((c) => c.level === 'fail').length;
}

/** @param {string} root @param {string} app @param {string} branch */
function nextSteps(root, app, branch) {
  return `
Then, on GitHub (this cannot be checked from here):
  1. Settings > Secrets and variables > Actions: add the secret ANTHROPIC_API_KEY.
  2. Same page, Variables: QA_VERIFY_MODE = advisory. QA verify then only warns, and keeps a
     record of what it would have blocked; node qa/verify-record.ts says when it can block.
  3. Settings > Actions > General: tick "Allow GitHub Actions to create and approve pull requests".
  4. Once it can block: protect ${branch} and require the checks "QA verify" and
     "QA branch rules (scope + frozen tests)".

The first ticket:
  - write specs/PROJ-1.md, one line per acceptance criterion: "- AC-1: ...", and push it to ${branch};
  - Actions > QA write tests > Run workflow, with the ticket PROJ-1 (application ${app});
  - approve the pull request of tests it opens, then build the feature on feat/PROJ-1.
Guide: https://github.com/Gleaming0427/agent-qa-kit/blob/main/HOW_TO_APPLY.md`;
}

// ---------------------------------------------------------------- commands

/** @param {ReturnType<typeof parseArgs>} options @param {string} cwd */
function init(options, cwd) {
  const root = findRoot(cwd);
  const p = plan(root, options, cwd);
  console.log(`Agent QA Kit ${VERSION}, in ${root}`);
  console.log(`  application ${p.app === '.' ? 'at the root' : p.app}, feature area "${p.mfe}", pull requests into ${p.branch}\n`);
  const label = { create: 'create', update: 'update', overwrite: 'replace', chmod: 'chmod +x', conflict: 'CONFLICT', dirty: 'CONFLICT', blocked: 'CONFLICT' };
  const unchanged = p.files.filter((f) => f.action === 'unchanged').length;
  for (const f of p.files) {
    if (f.action === 'unchanged') continue;
    const why = f.action === 'conflict' ? '   exists and differs from the kit'
      : f.action === 'dirty' ? '   has changes git could not give back: commit them first'
        : f.action === 'blocked' ? '   a symbolic link or a file is on its path' : '';
    console.log(`  ${label[/** @type {keyof typeof label} */ (f.action)].padEnd(9)} ${f.path}${why}`);
  }
  if (unchanged) console.log(`  ${'same'.padEnd(9)} ${unchanged} file(s) already up to date`);
  const added = Object.keys(p.scripts);
  if (added.length) console.log(`  ${'scripts'.padEnd(9)} ${inApp(p.app, 'package.json')}: ${added.join(', ')}`);
  for (const [name, value] of Object.entries(p.scripts)) console.log(`            "${name}": ${JSON.stringify(value)}`);
  if (p.gitignore) console.log(`  ${'ignore'.padEnd(9)} ${p.gitignore}: /reports/`);
  for (const path of p.obsolete) console.log(`  ${'obsolete'.padEnd(9)} ${path}   no longer part of the kit, left in place`);

  const conflicts = p.files.filter((f) => ['conflict', 'dirty', 'blocked'].includes(f.action));
  if (conflicts.length) {
    const hint = p.files.some((f) => f.action === 'conflict')
      ? 'Move them aside, or run init --force to replace them (only files committed with no local change).'
      : 'Commit or stash those changes, so that the replaced files can be restored with git, then run init --force again.';
    throw new UserError(`Nothing was written: ${conflicts.length} file(s) would be overwritten. ${hint}`);
  }
  if (options.dryRun) {
    console.log('\nDry run: nothing was written.');
    return 0;
  }
  const staged = apply(root, p);
  if (staged.length) console.log(`\ncore.fileMode is off here: ${staged.join(', ')} staged with the executable bit.`);
  const writes = p.files.filter((f) => f.action !== 'unchanged').length + (p.pkgNext ? 1 : 0) + (p.gitignore ? 1 : 0);
  console.log(writes ? `\nInstalled. ${MANIFEST} records the version and a digest of each file: commit it with the rest.` : '\nAlready installed and up to date.');

  const { sections } = doctor(root, cwd, { ...options, app: undefined });
  const failures = printChecks(sections);
  console.log(failures ? `\n${failures} thing(s) to fix before the workflows can pass (FAIL above). Check again with: npx ${SOURCE} doctor`
    : `\nThe repository is ready. To run the tests the way QA verify will: npx ${SOURCE} doctor --run`);
  const paths = [MANIFEST, '.claude', 'qa', ...WORKFLOWS.map((name) => `.github/workflows/${name}`), inApp(p.app, 'package.json'), p.gitignore ?? inApp(p.app, '.gitignore')];
  console.log(`\nCommit the kit:\n  git add ${[...new Set(paths)].join(' ')}\n  git commit -m "Add the Agent QA Kit"${nextSteps(root, p.app, p.branch)}`);
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} options @param {string} cwd */
function runDoctor(options, cwd) {
  const root = findRoot(cwd);
  console.log(`Agent QA Kit ${VERSION}, checking ${root}`);
  const { app, sections } = doctor(root, cwd, options);
  if (options.run && app !== null) sections.push(['Running the tests (as QA verify\'s full suite)', runChecks(root, app)]);
  const failures = printChecks(sections);
  if (failures) console.log(`\n${failures} problem(s) to fix (FAIL above).`);
  else console.log(options.run ? '\nAll checks pass.' : '\nNo problem found. doctor --run also runs the tests, as QA verify does.');
  return failures ? 1 : 0;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === 'help') { console.log(USAGE); return 0; }
    if (options.command === 'version') { console.log(VERSION); return 0; }
    return options.command === 'init' ? init(options, process.cwd()) : runDoctor(options, process.cwd());
  } catch (error) {
    if (error instanceof UserError) {
      console.error(`agent-qa-kit: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = main();
