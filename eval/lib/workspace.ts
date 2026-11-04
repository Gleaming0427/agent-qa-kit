// Builds variants of the demo application (base, gold, gold + bug) and runs tests in them.
// Shared by the corpus validation and the trial scoring. Test results are read with the
// kit's own report parsers, so the evaluation sees the same evidence as the kit.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { extractPlaywrightTests, extractVitestTests } from '../../.claude/hooks/strict-evidence.ts';
import type { PlaywrightReport, VitestReport } from '../../.claude/hooks/strict-evidence.ts';
import { runIsolated } from './sandbox.ts';
import type { Level, Status, TestResult, VariantResult } from './score.ts';

export const KIT = resolve(import.meta.dirname, '../..');
export const APP = join(KIT, 'examples/shop');
// CI moves the corpus out of the checkout while an agent runs, and points here to it.
export const TICKETS = process.env.EVAL_TICKETS || join(KIT, 'eval/tickets');
const SKIP = new Set(['node_modules', 'reports', 'test-results', 'playwright-report', 'dist', '.git']);

export interface Ticket { ticket: string; kind: 'feature' | 'ambiguous' | 'adversarial'; mfe: string; bugs: { id: string; criterion: string; description?: string }[] }

export function loadTicket(ticket: string): Ticket & { dir: string; spec: string } {
  const dir = join(TICKETS, ticket);
  const meta = JSON.parse(readFileSync(join(dir, 'ticket.json'), 'utf8')) as Ticket;
  if (meta.ticket !== ticket) throw new Error(`${dir}/ticket.json names ${meta.ticket}`);
  return { ...meta, dir, spec: join(dir, 'spec.md') };
}

export function listTickets(): string[] {
  return spawnSync('ls', [TICKETS], { encoding: 'utf8' }).stdout.split('\n').filter((name) => /^[A-Z][A-Z0-9]*-\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** Caches that tools write inside node_modules; a variant gets its own, empty. */
const MODULE_CACHES = new Set(['.vite', '.vite-temp', '.cache']);

/**
 * Copies the application without build output or dependencies, then gives it the installed
 * node_modules in one of three ways:
 *   - link (default): a symlink to the installed folder;
 *   - copy: a full copy, for an agent's workspace, whose sandbox only writes inside the project
 *     while the test tools write caches there;
 *   - farm: a folder of its own holding one symlink per installed package. A variant's tools write
 *     their caches (Vite's .vite and .vite-temp) in that folder, so the installed one can stay
 *     read-only in the scoring sandbox, and nothing a test writes there reaches the next variant.
 */
export function copyApp(dest: string, { from = APP, mode = 'link' as 'link' | 'copy' | 'farm', modules = join(from, 'node_modules') } = {}): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(from, dest, { recursive: true, filter: (src) => !SKIP.has(basename(src)) || src === from });
  if (!existsSync(modules)) throw new Error(`${modules} is missing: run npm ci in ${APP} first`);
  if (mode === 'link') symlinkSync(modules, join(dest, 'node_modules'), 'dir');
  else if (mode === 'copy') cpSync(modules, join(dest, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  else {
    const shared = realpathSync(modules);
    mkdirSync(join(dest, 'node_modules'));
    for (const name of readdirSync(shared)) {
      if (!MODULE_CACHES.has(name)) symlinkSync(join(shared, name), join(dest, 'node_modules', name));
    }
  }
  // Local development only: use a Chromium that is already installed (CI installs its own).
  if (process.env.EVAL_CHROMIUM && !readFileSync(join(dest, 'playwright.config.ts'), 'utf8').includes('launchOptions')) {
    const config = join(dest, 'playwright.config.ts');
    const text = readFileSync(config, 'utf8');
    const anchor = "    trace: 'retain-on-failure',\n";
    if (!text.includes(anchor)) throw new Error('EVAL_CHROMIUM: unexpected playwright.config.ts');
    writeFileSync(config, text.replace(anchor, `${anchor}    launchOptions: { executablePath: ${JSON.stringify(process.env.EVAL_CHROMIUM)}, args: ['--no-sandbox'] },\n`));
  }
}

/**
 * Applies a diff whose paths are relative to dir. Inside a subfolder of a repository, git apply
 * reads paths from the repository root and silently skips the others, so git is kept from
 * looking above dir: a repository at dir itself still counts.
 */
export function applyDiff(dir: string, diff: string): void {
  const run = spawnSync('git', ['apply', '--whitespace=nowarn', diff], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(resolve(dir)) },
  });
  if (run.status !== 0) throw new Error(`git apply ${diff} failed in ${dir}: ${run.stderr.trim()}`);
}

/** variant: 'base', 'gold' or a bug id (applied on top of gold). `from` is the untouched application. */
export function makeVariant(ticket: Ticket & { dir: string }, variant: string, dest: string, from = APP): void {
  copyApp(dest, { from, mode: 'farm', modules: join(APP, 'node_modules') });
  if (variant === 'base') return;
  applyDiff(dest, join(ticket.dir, 'gold.diff'));
  if (variant !== 'gold') applyDiff(dest, join(ticket.dir, 'bugs', `${variant}.diff`));
}

/**
 * Empty files that the agents' sandbox creates at the project root so that it can protect
 * those paths. They appeared, all fifteen, in every trial of the first pilot (workflow run
 * 41494361776), with no agent tool call touching them.
 */
export const SANDBOX_PLACEHOLDERS = new Set([
  '.env', '.env.development', '.env.development.local', '.env.local', '.env.production', '.env.production.local',
  '.env.test', '.env.test.local', '.gitmodules', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', 'pnpm-lock.yaml', 'yarn.lock',
]);

const isTestFile = (path: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/**
 * Sorts the workspace changes after phase 1: new test files are the writer's output; new, empty
 * sandbox placeholders at the root are left aside; anything else breaks the writer's rules.
 * A placeholder name with content still counts as a change.
 */
export function classifyChanges(files: { code: string; path: string; size: number }[]): { tests: string[]; placeholders: string[]; others: string[] } {
  const tests: string[] = [];
  const placeholders: string[] = [];
  const others: string[] = [];
  for (const f of files) {
    if (f.code === '??' && isTestFile(f.path)) tests.push(f.path);
    else if (f.code === '??' && f.size === 0 && !f.path.includes('/') && SANDBOX_PLACEHOLDERS.has(f.path)) placeholders.push(f.path);
    else others.push(f.path);
  }
  return { tests, placeholders, others };
}

export function criteriaOf(title: string, ticket: string): string[] {
  const escaped = ticket.replace(/[-]/g, '\\-');
  return [...title.matchAll(new RegExp(`\\[${escaped}\\]\\[(AC-[1-9]\\d*)\\]`, 'g'))].map((m) => m[1]);
}

// Screenshots are compared only when CI is set: variants change the page on purpose.
const TEST_ENV = { CI: '', FORCE_COLOR: '0' };

/** The installed node_modules a variant's farm points to: it stays readable, read-only, in the sandbox. */
function sharedModules(dir: string): string[] {
  const modules = join(dir, 'node_modules');
  const first = existsSync(modules) ? readdirSync(modules)[0] : undefined;
  return first ? [dirname(realpathSync(join(modules, first)))] : [];
}

/** Runs the given Vitest files; returns one result per test. */
export function runVitest(dir: string, files: string[], ticket: string): VariantResult {
  if (!files.length) return { ran: false, tests: [] };
  const report = join(dir, 'reports/vitest.json');
  rmSync(report, { force: true });
  const run = runIsolated('npx', ['vitest', 'run', ...files], { cwd: dir, env: TEST_ENV, readOnly: sharedModules(dir), timeout: 300_000 });
  if (!existsSync(report)) return { ran: false, error: `vitest produced no report (exit ${run.status}): ${run.stderr.slice(-400)}`, tests: [] };
  const tests = extractVitestTests(JSON.parse(readFileSync(report, 'utf8')) as VitestReport);
  return {
    ran: true,
    tests: tests.map((t) => ({
      title: t.title,
      level: 'mfe' as Level,
      criteria: criteriaOf(t.title, ticket),
      status: (t.status === 'passed' ? 'pass' : t.status === 'failed' ? 'fail' : 'other') as Status,
    })),
  };
}

/**
 * Runs the given Playwright files. With repeatEach > 1, a test is "flaky" when its repeats disagree.
 * The timeout bounds a test that waits for an element that does not exist on a variant.
 */
export function runPlaywright(dir: string, files: string[], ticket: string, { repeatEach = 1, timeoutMs = 15_000 } = {}): VariantResult {
  if (!files.length) return { ran: false, tests: [] };
  const report = join(dir, 'reports/playwright.json');
  rmSync(report, { force: true });
  // One worker, as in the kit's CI: parallel workers against one dev server make timeouts likelier.
  const args = ['playwright', 'test', ...files, `--repeat-each=${repeatEach}`, `--timeout=${timeoutMs}`, '--retries=0', '--workers=1'];
  const run = runIsolated('npx', args, { cwd: dir, env: TEST_ENV, readOnly: sharedModules(dir), timeout: 900_000 });
  if (!existsSync(report)) return { ran: false, error: `playwright produced no report (exit ${run.status}): ${run.stderr.slice(-400)}`, tests: [] };
  const parsed = JSON.parse(readFileSync(report, 'utf8')) as PlaywrightReport;
  if (parsed.errors?.length) return { ran: false, error: `playwright could not run: ${String(parsed.errors[0].message).slice(0, 400)}`, tests: [] };
  const byTitle = new Map<string, string[]>();
  for (const t of extractPlaywrightTests(parsed)) byTitle.set(t.title, [...(byTitle.get(t.title) ?? []), t.status ?? 'unknown']);
  return {
    ran: true,
    tests: [...byTitle.entries()].map(([title, statuses]): TestResult => {
      const pass = statuses.every((s) => s === 'expected');
      const fail = statuses.every((s) => s === 'unexpected');
      const mixed = statuses.some((s) => s === 'expected') && statuses.some((s) => s === 'unexpected');
      return { title, level: 'shell', criteria: criteriaOf(title, ticket), status: pass ? 'pass' : fail ? 'fail' : mixed ? 'flaky' : 'other' };
    }),
  };
}

export function typeCheck(dir: string): { ok: boolean; output: string } {
  const run = spawnSync('npx', ['tsc', '--noEmit'], { cwd: dir, encoding: 'utf8', timeout: 300_000 });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.slice(-1500) };
}

export function merge(...results: VariantResult[]): VariantResult {
  const ran = results.filter((r) => r.ran);
  const errors = results.flatMap((r) => (r.error ? [r.error] : []));
  return { ran: ran.length > 0, ...(errors.length ? { error: errors.join(' | ') } : {}), tests: ran.flatMap((r) => r.tests) };
}
