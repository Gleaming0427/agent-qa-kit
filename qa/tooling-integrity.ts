#!/usr/bin/env node
// Detects changes to what the tests run on: the installed packages
// (node_modules/), the git configuration, hooks and info files, and the files the tests are set up
// with: package.json, the Vitest, Vite and Playwright configurations, the setup files they name (and
// what those import from the repository), and the files that are test support by their name (mocks,
// fixtures, helpers: isSupportFile in qa/check-tooling.ts). The repair agent may change the
// application, never these. Comparing two snapshots also catches a change made indirectly, by code
// that the tests run.
//
// Usage: node qa/tooling-integrity.ts snapshot > before.json
//        node qa/tooling-integrity.ts compare < before.json
// Run both in the project folder. compare exits 1 and lists the files that changed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isConfig, isSupportFile, setupFilesOf } from './check-tooling.ts';

// Caches that test tools rewrite on every run, inside node_modules/.
const CACHES = new Set(['.vite', '.vite-temp', '.vitest', '.cache', '.tmp']);

export type Snapshot = Record<string, string>;
export interface Difference { changed: string[]; added: string[]; removed: string[] }

function record(files: Snapshot, key: string, path: string, skip: (name: string) => boolean) {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (stat.isSymbolicLink()) {
    files[key] = `link:${readlinkSync(path)}`;
  } else if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (!skip(name)) record(files, `${key}/${name}`, join(path, name), () => false);
    }
  } else if (stat.isFile()) {
    files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
// A relative path after from, import or require, with or without parentheses, in single or double quotes: the project's own files only.
const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g;
const MAX_SETUP_FILES = 300;

/** The files of the project, relative to it: those git tracks or would add, else everything but node_modules/ and .git/. */
function projectFiles(root: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
    }).split('\0').filter(Boolean);
  } catch { /* not a git repository: walk the folder */ }
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path); else if (entry.isFile()) files.push(path);
    }
  };
  walk('');
  return files;
}

/**
 * The files the tests are set up with, relative to the project: package.json files, test configurations,
 * the files a configuration names as setup, what those import from the project (one level of helper after
 * another), and the files that are test support by their name. Only files that exist, outside node_modules.
 */
export function supportFiles(root: string): string[] {
  const listed = projectFiles(root);
  const present = new Set(listed.filter((file) => !file.split('/').includes('node_modules')));
  const found = new Set<string>();
  for (const file of present) {
    if (isConfig(file) || isSupportFile(file) || posix.basename(file) === 'package.json') found.add(file);
  }
  const read = (file: string) => { try { return readFileSync(join(root, file), 'utf8'); } catch { return ''; } };
  const queue: string[] = [];
  for (const config of [...present].filter(isConfig)) {
    for (const { file } of setupFilesOf(config, read(config))) if (present.has(file)) queue.push(file);
  }
  for (const start of queue) found.add(start);
  while (queue.length && found.size < MAX_SETUP_FILES) {
    const file = queue.shift()!;
    for (const match of read(file).matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[2]));
      const resolved = SOURCE_EXTENSIONS.map((extension) => target + extension).find((candidate) => present.has(candidate));
      if (resolved && !found.has(resolved)) { found.add(resolved); queue.push(resolved); }
    }
  }
  return [...found].sort();
}

/** Every file of every node_modules/ in the project, plus the git config, hooks and info files, and the files the tests are set up with. */
export function snapshot(root: string): Snapshot {
  root = resolve(root);
  const files: Snapshot = {};
  const findPackages = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') record(files, relative(root, path), path, (name) => CACHES.has(name));
      else findPackages(path);
    }
  };
  findPackages(root);
  let gitPaths: string[] = [];
  try {
    gitPaths = execFileSync('git', ['rev-parse', '--git-path', 'config', '--git-path', 'hooks', '--git-path', 'info'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n');
  } catch { /* not a git repository */ }
  for (const [index, name] of ['config', 'hooks', 'info'].entries()) {
    if (gitPaths[index]) record(files, `git:${name}`, resolve(root, gitPaths[index]), () => false);
  }
  for (const file of supportFiles(root)) record(files, `setup:${file}`, resolve(root, file), () => false);
  return files;
}

export function compare(before: Snapshot, after: Snapshot): Difference {
  const keys = (snapshot: Snapshot) => Object.keys(snapshot).sort();
  return {
    changed: keys(before).filter((key) => key in after && after[key] !== before[key]),
    added: keys(after).filter((key) => !(key in before)),
    removed: keys(before).filter((key) => !(key in after)),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === 'snapshot') {
    process.stdout.write(`${JSON.stringify(snapshot(process.cwd()))}\n`);
  } else if (command === 'compare') {
    const difference = compare(JSON.parse(readFileSync(0, 'utf8')) as Snapshot, snapshot(process.cwd()));
    const lines = (Object.entries(difference) as [string, string[]][])
      .flatMap(([kind, keys]) => keys.slice(0, 10).map((key) => `  ${kind}: ${key}`));
    if (lines.length) {
      console.error('Installed packages, git files or test setup files changed:');
      console.error(lines.join('\n'));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: node qa/tooling-integrity.ts snapshot > before.json | compare < before.json');
    process.exitCode = 2;
  }
}
