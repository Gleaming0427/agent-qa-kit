// Runs untrusted code, the tests an agent generated, in a bubblewrap sandbox while they are scored.
//
// The scoring runner holds the corpus: reference implementations, injected bugs, hidden tests and
// their metadata. A generated test is code written by the agent, so while it runs it must not:
//   - read the corpus, the checkout or any home folder (they are hidden behind empty tmpfs mounts);
//   - read a secret from the environment (the environment is cleared, a short allowlist is set);
//   - reach the network (new network namespace, loopback only: the shop's preview server still works);
//   - keep state from one variant to the next, which would let it tell the base, the reference and
//     the bugs apart by their order (the only writable folders are the variant's own fresh copy and
//     a tmpfs /tmp; node_modules is read-only).
// EVAL_SANDBOX=bwrap turns it on, and then fails closed when bubblewrap cannot start. CI sets it in
// the scoring job. EVAL_SANDBOX=off (the default) runs the tests directly, for local development.
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export type SandboxMode = 'off' | 'bwrap';

export function sandboxMode(value = process.env.EVAL_SANDBOX): SandboxMode {
  const mode = (value ?? '').trim();
  if (mode === '' || mode === 'off') return 'off';
  if (mode === 'bwrap') return 'bwrap';
  throw new Error(`EVAL_SANDBOX must be "off" or "bwrap", got "${mode}"`);
}

export interface SandboxSpec {
  /** The only writable folder besides a private /tmp: the variant under test. */
  workdir: string;
  /** Folders hidden behind an empty tmpfs: home folders, the checkout and its corpus, runner temp. */
  hide: string[];
  /** Folders the command needs read-only, even inside a hidden folder: node_modules, browsers, node. */
  readOnly: string[];
  /** The whole environment of the command. Nothing else from the caller's environment passes. */
  env: Record<string, string>;
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const depth = (path: string) => path.split(sep).filter(Boolean).length;
const unique = (paths: string[]) => [...new Set(paths.map(real))];

/** The bwrap command line for a spec. Pure, so the isolation it describes can be unit-tested. */
export function bwrapArgs(spec: SandboxSpec, command: string[]): string[] {
  const workdir = real(spec.workdir);
  // Parents first: a tmpfs mounted later inside a hidden folder only hides more.
  const hide = unique(['/tmp', '/run', ...spec.hide]).filter((p) => p !== '/' && existsSync(p)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
  // A folder inside the variant is writable with it: the variant's bind would cover a read-only one anyway.
  const readOnly = unique(spec.readOnly).filter((p) => existsSync(p) && p !== workdir && !p.startsWith(`${workdir}${sep}`));
  return [
    '--die-with-parent', '--new-session',
    // New user, pid, network, ipc, uts and cgroup namespaces: no network but loopback, no other process.
    '--unshare-all',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    ...hide.flatMap((p) => ['--tmpfs', p]),
    ...readOnly.flatMap((p) => ['--ro-bind', p, p]),
    '--bind', workdir, workdir,
    '--chdir', workdir,
    '--clearenv',
    ...Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)).flatMap(([k, v]) => ['--setenv', k, v]),
    '--', ...command,
  ];
}

/** Folders hidden from generated tests by default; EVAL_SANDBOX_HIDE adds more (separated by ":"). */
export function defaultHidden(extra: string[] = []): string[] {
  const env = process.env;
  return [
    '/home', '/root', '/mnt', homedir(), tmpdir(),
    ...[env.RUNNER_TEMP, env.GITHUB_WORKSPACE, env.EVAL_WORK, env.EVAL_TICKETS].filter((p): p is string => Boolean(p)),
    ...(env.EVAL_SANDBOX_HIDE ?? '').split(':').filter(Boolean),
    ...extra,
  ];
}

/** Where Playwright's browsers are, if anywhere: they must stay readable when the home folder is hidden. */
export function browsersPath(): string | null {
  const path = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  return existsSync(path) ? real(path) : null;
}

let checked: { ok: boolean; reason: string } | null = null;

/** Whether bubblewrap can start a sandbox with the namespaces bwrapArgs asks for. */
export function bwrapAvailable(): { ok: boolean; reason: string } {
  if (checked) return checked;
  const run = spawnSync('bwrap', ['--die-with-parent', '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', 'true'], { encoding: 'utf8', timeout: 30_000 });
  checked = run.error ? { ok: false, reason: `bwrap not found: ${run.error.message}` }
    : run.status === 0 ? { ok: true, reason: 'bwrap works' } : { ok: false, reason: `bwrap cannot start a sandbox: ${run.stderr.trim()}` };
  return checked;
}

export interface IsolatedRun {
  /** Folder the command runs in, and the only writable one besides /tmp. */
  cwd: string;
  /** Variables for the command. With the sandbox on, they are the whole environment (plus PATH, HOME and the browsers' path). */
  env: Record<string, string>;
  /** Folders the command reads, kept visible inside the sandbox. */
  readOnly?: string[];
  timeout: number;
}

/** Runs a command on a variant, in the sandbox when EVAL_SANDBOX=bwrap. */
export function runIsolated(command: string, args: string[], opts: IsolatedRun): SpawnSyncReturns<string> {
  if (sandboxMode() === 'off') {
    return spawnSync(command, args, { cwd: opts.cwd, encoding: 'utf8', env: { ...process.env, ...opts.env }, timeout: opts.timeout });
  }
  const available = bwrapAvailable();
  if (!available.ok) throw new Error(`EVAL_SANDBOX=bwrap, but ${available.reason}`);
  const browsers = browsersPath();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
    ...(browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {}),
    ...opts.env,
  };
  const readOnly = [
    // node and npx, wherever the runner installed them.
    dirname(dirname(real(process.execPath))),
    ...(browsers ? [browsers] : []),
    ...(process.env.EVAL_CHROMIUM ? [dirname(real(process.env.EVAL_CHROMIUM))] : []),
    ...(opts.readOnly ?? []),
  ];
  const spec: SandboxSpec = { workdir: opts.cwd, hide: defaultHidden(), readOnly, env };
  // bwrap itself only needs PATH to be found; --clearenv gives the command the spec's variables only.
  return spawnSync('bwrap', bwrapArgs(spec, [command, ...args]), { cwd: opts.cwd, encoding: 'utf8', env: { PATH: env.PATH }, timeout: opts.timeout });
}
