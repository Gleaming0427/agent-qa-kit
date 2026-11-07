#!/usr/bin/env node
// Condensed test results, for the QA agent.
//
// Instead of reading hundreds of log lines, the agent reads this summary:
// the counts, the failing tests with a truncated message, the flaky tests
// and the trace paths. This is the main token saving.
//
// Reads, if they exist:
//   reports/vitest.json      Vitest JSON report (MFE level)
//   reports/playwright.json  Playwright JSON report (shell level)
//
// Usage: node qa/summary.ts   (or npm run test:summary)
//        node qa/summary.ts --run @<mfe>   (or npm run test:summary -- --run @<mfe>)
//
// With --run, it first runs `npm run test:affected`, then `npm run test:e2e -- --grep @<mfe>`,
// keeps their full output out of the way, and prints the summary of both: one command for a
// whole test cycle. The agents kept chaining those three commands and cutting the output with
// `| tail`, which the guard refuses, a turn lost each time.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { PlaywrightReport, PlaywrightSuite, PlaywrightTest, VitestReport } from '../.claude/hooks/strict-evidence.ts';

interface Failure { title: string; message?: string; trace?: string }

const MAX_LENGTH = 300;
const MAX_FAILURES = 10;
// The last lines of a test command's output, shown when it wrote no report.
const OUTPUT_TAIL = 30;

const clean = (text: unknown = '') =>
  String(text)
    .replace(/\u001b\[[0-9;]*m/g, '') // color codes
    .replace(/\s+/g, ' ')
    .trim();

const truncate = (text: unknown) => {
  const cleaned = clean(text);
  return cleaned.length > MAX_LENGTH ? `${cleaned.slice(0, MAX_LENGTH)}…` : cleaned;
};

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    console.log(`${path}: unreadable report.`);
    return null;
  }
};

function summarizeVitest(report: VitestReport) {
  const failures: Failure[] = [];
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status === 'failed') {
        failures.push({
          title: test.fullName ?? test.title ?? '',
          message: truncate((test.failureMessages ?? []).join(' ')),
        });
      }
    }
  }
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? failures.length;
  console.log(`MFE level (Vitest): ${passed} passed, ${failed} failed`);
  printFailures(failures);
}

function walkSuites(suites: PlaywrightSuite[] | undefined, path: string[], tests: { title: string; test: PlaywrightTest }[]) {
  for (const suite of suites ?? []) {
    const titles = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        tests.push({ title: [...titles, spec.title].join(' › '), test });
      }
    }
    walkSuites(suite.suites, titles, tests);
  }
}

function summarizePlaywright(report: PlaywrightReport) {
  const tests: { title: string; test: PlaywrightTest }[] = [];
  walkSuites(report.suites, [], tests);

  const failures: Failure[] = [];
  const flaky: Omit<Failure, 'message'>[] = [];
  for (const { title, test } of tests) {
    const results = test.results ?? [];
    const last = results.at(-1);
    const trace = results
      .flatMap((r) => r.attachments ?? [])
      .find((a) => a.name === 'trace' && a.path)?.path;

    if (test.status === 'unexpected') {
      const error = last?.error?.message ?? last?.errors?.[0]?.message ?? 'failed without a message';
      failures.push({ title, message: truncate(error), trace });
    } else if (test.status === 'flaky') {
      flaky.push({ title, trace });
    }
  }

  const stats = report.stats ?? {};
  console.log(
    `Shell level (Playwright): ${stats.expected ?? 0} passed, ` +
      `${stats.unexpected ?? failures.length} failed, ${stats.flaky ?? flaky.length} flaky`,
  );
  printFailures(failures);
  for (const { title, trace } of flaky) {
    console.log(`  ~ flaky: ${title}${trace ? ` (trace: ${trace})` : ''}`);
  }
}

function printFailures(failures: Failure[]) {
  for (const { title, message, trace } of failures.slice(0, MAX_FAILURES)) {
    console.log(`  ✗ ${title}`);
    if (message) console.log(`    ${message}`);
    if (trace) console.log(`    trace: ${trace}`);
  }
  if (failures.length > MAX_FAILURES) {
    console.log(`  … and ${failures.length - MAX_FAILURES} more failures`);
  }
}

/** Runs the unit tests, then the browser tests of a feature area; says when one wrote no report, and why. */
function runTests(mfe: string) {
  const steps: [string[], string][] = [
    [['run', 'test:affected'], 'reports/vitest.json'],
    [['run', 'test:e2e', '--', '--grep', mfe], 'reports/playwright.json'],
  ];
  for (const [args, report] of steps) {
    // A report left by an earlier run would pass for this one's.
    rmSync(report, { force: true });
    const run = spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (existsSync(report)) continue;
    const ended = run.error ? run.error.message : run.signal ? `signal ${run.signal}` : `exit code ${run.status}`;
    const lines = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.split('\n').map(clean).filter(Boolean).slice(-OUTPUT_TAIL);
    console.log(`npm ${args.join(' ')} wrote no ${report} (${ended}). Its last lines:`);
    for (const line of lines) console.log(`  ${line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH)}…` : line}`);
  }
}

const options = process.argv.slice(2);
if (options.length) {
  if (options.length !== 2 || options[0] !== '--run' || !/^@[a-z0-9-]+$/.test(options[1])) {
    console.log('Usage: npm run test:summary, or npm run test:summary -- --run @<mfe> to run the tests first.');
    process.exit(2);
  }
  runTests(options[1]);
}

const vitest = readJson<VitestReport>('reports/vitest.json');
const playwright = readJson<PlaywrightReport>('reports/playwright.json');

if (!vitest && !playwright) {
  console.log('No report found: run the tests first.');
  process.exit(1);
}
if (vitest) summarizeVitest(vitest);
if (playwright) summarizePlaywright(playwright);
