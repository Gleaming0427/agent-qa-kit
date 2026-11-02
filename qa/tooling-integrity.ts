#!/usr/bin/env node
// Detects changes to what the tests run on: the installed packages
// (node_modules/) and the git configuration, hooks and info files. The repair
// agent may change the application, never these. Comparing two snapshots also
// catches a change made indirectly, by code that the tests run.
//
// Usage: node qa/tooling-integrity.ts snapshot > before.json
//        node qa/tooling-integrity.ts compare < before.json
// Run both in the project folder. compare exits 1 and lists the files that changed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Every file of every node_modules/ in the project, plus the git config, hooks and info files. */
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
      console.error('Installed packages or git files changed:');
      console.error(lines.join('\n'));
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: node qa/tooling-integrity.ts snapshot > before.json | compare < before.json');
    process.exitCode = 2;
  }
}
