#!/usr/bin/env node
// What a pull request changes in the way its own tests run.
//
// QA verify runs the application's tests from the pull request, and the verifier and the final suite
// read their reports. A pull request that also changes how those tests run can make them report what it
// wants: a test script that exits early, a Vitest or Playwright configuration that skips the approved
// tests or swaps the reporter, a setup file that patches the matchers. The approved tests are frozen
// (qa/check-scope.sh); this is what they run on.
//
// Reported, among the files a pull request changes compared with its base:
//   setup  the scripts of a package.json that run the tests or the install (test*, install, prepare,
//          qa:*), the Vitest, Vite and Playwright configurations, and the files those configurations
//          name as setupFiles, globalSetup or globalTeardown (found by reading their text)
//   kit    the kit's own files: qa/, .claude/, its workflows, .agent-qa-kit.json
// Not reported: dependencies, and what a configuration imports without naming it as a setup file.
//
// Usage: node qa/check-tooling.ts <base> [<head>]     (in the repository; prints JSON)
//   {"base": "...", "head": "...", "changes": [{"kind": "setup" | "kit", "file": "...", "why": "..."}]}
import { spawnSync } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Change { kind: 'setup' | 'kit'; file: string; why: string }
/** The text of a file on one side of the comparison, or null when it does not exist there. */
export type Reader = (side: 'base' | 'head', file: string) => string | null;

const KIT_FILE = /^(qa\/|\.claude\/|\.agent-qa-kit\.json$|\.github\/workflows\/qa-(write-tests|verify|branches|amend-tests|approval)\.yml$)/;
export const isConfig = (file: string) => /(^|\/)(vitest|vite|playwright)\.config\.[cm]?[jt]s$|(^|\/)vitest\.workspace\.[cm]?[jt]s$/.test(file);
const PACKAGE = /(^|\/)package\.json$/;
// The scripts that run the tests or the install: test, test:unit, pretest, install, postinstall, prepare, qa:setup.
const WATCHED_SCRIPT = /^(pre|post)?(test|install)(:|$)|^prepare$|^qa:/;
const SETUP_KEY = /\b(setupFiles|globalSetup|globalTeardown)\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/g;

/** The scripts of a package.json text that matter, by name. */
function watchedScripts(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    return Object.fromEntries(Object.entries(scripts).filter(([name, value]) => WATCHED_SCRIPT.test(name) && typeof value === 'string')) as Record<string, string>;
  } catch { return {}; }
}

/** The files a Vitest, Vite or Playwright configuration names as setup, relative to the repository. */
export function setupFilesOf(configFile: string, text: string): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const match of text.matchAll(SETUP_KEY)) {
    for (const quoted of match[2].matchAll(/"([^"]*)"|'([^']*)'|`([^`$]*)`/g)) {
      const name = quoted[1] ?? quoted[2] ?? quoted[3] ?? '';
      // A package ("@vitest/setup") or an absolute path is not a file of the repository.
      if (!name.startsWith('./') && !name.startsWith('../')) continue;
      found.push({ key: match[1], file: posix.normalize(posix.join(posix.dirname(configFile), name)) });
    }
  }
  return found;
}

/**
 * The changes to the test setup and to the kit among the files a pull request changes.
 * @param changed every file the pull request changes
 * @param configs every Vitest, Vite or Playwright configuration of the repository, changed or not:
 *   an unchanged one can name a setup file that changed
 */
export function toolingChanges(changed: string[], read: Reader, configs: string[] = []): Change[] {
  const changes: Change[] = [];
  const changedSet = new Set(changed);
  for (const file of [...changed].sort()) {
    if (KIT_FILE.test(file)) changes.push({ kind: 'kit', file, why: 'a file of the kit' });
    if (isConfig(file)) changes.push({ kind: 'setup', file, why: 'the configuration of the tests' });
    if (PACKAGE.test(file)) {
      const before = watchedScripts(read('base', file)), after = watchedScripts(read('head', file));
      for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        if (before[name] === after[name]) continue;
        const how = before[name] === undefined ? 'added' : after[name] === undefined ? 'removed' : 'changed';
        changes.push({ kind: 'setup', file, why: `script "${name}" ${how}` });
      }
    }
  }
  // The setup files a configuration names, as it was and as it is.
  for (const config of [...new Set([...configs, ...changed.filter(isConfig)])].sort()) {
    for (const side of ['base', 'head'] as const) {
      const text = read(side, config);
      if (!text) continue;
      for (const { key, file } of setupFilesOf(config, text)) {
        if (changedSet.has(file) && !changes.some((c) => c.kind === 'setup' && c.file === file)) {
          changes.push({ kind: 'setup', file, why: `named in ${config} as ${key}` });
        }
      }
    }
  }
  return changes;
}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) {
    console.error('Usage: node qa/check-tooling.ts <base> [<head>]');
    process.exit(2);
  }
  // What the pull request changes is what the head holds since the commit it branched from.
  const branchPoint = git(['merge-base', base, head]);
  const diff = git(['diff', '--name-only', '-z', `${base}...${head}`]);
  if (branchPoint.status !== 0 || diff.status !== 0) {
    console.error(`Cannot compare ${base} with ${head}: ${(branchPoint.stderr || diff.stderr).trim()}`);
    process.exit(2);
  }
  const refs = { base: branchPoint.stdout.trim(), head };
  const read: Reader = (side, file) => {
    const shown = git(['show', `${refs[side]}:${file}`]);
    return shown.status === 0 ? shown.stdout : null;
  };
  const tree = git(['ls-tree', '-r', '--name-only', '-z', head]);
  const configs = tree.status === 0 ? tree.stdout.split('\0').filter((file) => file && isConfig(file)) : [];
  console.log(JSON.stringify({ base, head, changes: toolingChanges(diff.stdout.split('\0').filter(Boolean), read, configs) }));
}
