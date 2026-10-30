#!/usr/bin/env node
// Additional safety check, after every edit and independently in CI.
// Conservative text scanner; not a substitute for the compiler or code review.
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const forbidden = [
  /\b(?:describe|test|it)\.(?:skip|only|fixme|todo)\s*\(/,
  /\b(?:xit|xdescribe|xtest)\s*\(/,
  /\b(?:test|it)\.skipIf\s*\(/,
];
function testFile(path) { return /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path); }
export function scanFiles(files) {
  const errors = [];
  for (const file of files.filter(testFile)) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const [i, line] of content.split(/\r?\n/).entries()) {
      if (forbidden.some((re) => re.test(line))) errors.push(`${file}:${i + 1}: disabled or focused test`);
    }
  }
  return errors;
}
function listFromDirectory(root = '.') {
  const found = [];
  function walk(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'reports', 'test-results', 'playwright-report'].includes(item.name)) continue;
      const file = dir === '.' ? item.name : `${dir}/${item.name}`;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) found.push(file);
    }
  }
  walk(root);
  return found;
}
function collectFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    return listFromDirectory(); // Useful in an unpacked ZIP without .git.
  }
}
if (process.argv[1] && process.argv[1].endsWith('/check-tests.mjs')) {
  try {
    const files = process.argv.slice(2).length ? process.argv.slice(2) : collectFiles();
    const errors = scanFiles(files);
    if (errors.length) { errors.forEach((e) => console.error(e)); process.exitCode = 1; }
    else console.log(`Test file integrity check passed (${files.filter(testFile).length} files).`);
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
