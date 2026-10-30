#!/usr/bin/env node
// Automated Red -> Green -> Regression: same acceptance tests, intentionally
// buggy code flag toggled. Red must fail and green must pass; no tests changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Observation { title: string; status?: string; message: string }
interface VitestReport { testResults?: { assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[] }[] }
interface PlaywrightSuite {
  specs?: { title?: string; tests?: { status?: string; results?: { error?: { message?: string }; errors?: { message?: string }[] }[] }[] }[];
  suites?: PlaywrightSuite[];
}
interface PlaywrightReport { suites?: PlaywrightSuite[] }
interface StageResult {
  stage: string; bugEnabled: boolean; passed: boolean; expectedPass: boolean;
  evidenceMatches: boolean; failedTests: string[]; report: string | null;
}

const e2e = process.argv.includes('--e2e');
const root = resolve(import.meta.dirname, '..');
const steps = [
  { name: '01-red', bug: '1', expectPass: false },
  { name: '02-green', bug: '0', expectPass: true },
  { name: '03-regression', bug: '1', expectPass: false },
];
function observations(report: VitestReport & PlaywrightReport): Observation[] {
  if (!e2e) return (report.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).map((item) => ({
    title: item.fullName ?? item.title ?? '',
    status: item.status,
    message: (item.failureMessages ?? []).join(' '),
  })));
  const found: Observation[] = [];
  function visit(suites: PlaywrightSuite[] | undefined) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const item of spec.tests ?? []) {
          const last = item.results?.at(-1);
          found.push({ title: spec.title ?? '', status: item.status, message: last?.error?.message ?? last?.errors?.[0]?.message ?? '' });
        }
      }
      visit(suite.suites);
    }
  }
  visit(report.suites);
  return found;
}
mkdirSync(resolve(root, 'reports'), { recursive: true });
const results: StageResult[] = [];
for (const step of steps) {
  console.log(`\n========== ${step.name} / ${e2e ? 'E2E' : 'MFE'} ==========`);
  const report = resolve(root, 'reports', e2e ? 'playwright.json' : 'vitest.json');
  const savedReport = resolve(root, 'reports', `${step.name}-${e2e ? 'playwright' : 'vitest'}.json`);
  rmSync(report, { force: true });
  rmSync(savedReport, { force: true });
  const args = e2e ? ['run', 'test:e2e', '--', 'e2e/TICKET-42.spec.ts'] : ['run', 'test:unit'];
  const run = spawnSync('npm', args, {
    cwd: root, encoding: 'utf8', stdio: 'inherit',
    env: { ...process.env, VITE_DEMO_BUG: step.bug },
  });
  const passed = run.status === 0;
  if (existsSync(report)) copyFileSync(report, savedReport);
  let tests: Observation[] = [];
  try { tests = observations(JSON.parse(readFileSync(report, 'utf8'))); } catch {}
  const failures = tests.filter((item) => item.status === (e2e ? 'unexpected' : 'failed'));
  const expectedRed = failures.length === 1 && failures[0].title.includes('[TICKET-42][AC-2]') && Boolean(failures[0].message);
  const expectedGreen = failures.length === 0 && tests.every((item) => item.status === (e2e ? 'expected' : 'passed'));
  const evidenceMatches = tests.length === 3 && (step.expectPass ? expectedGreen : expectedRed);
  results.push({ stage: step.name, bugEnabled: step.bug === '1', passed, expectedPass: step.expectPass,
    evidenceMatches, failedTests: failures.map(({ title }) => title), report: existsSync(savedReport) ? savedReport : null });
  if (run.error || run.status === null || passed !== step.expectPass || !existsSync(report) || !evidenceMatches) {
    console.error(`Unexpected result at ${step.name}: expected ${step.expectPass ? 'pass' : 'fail'} with matching AC-2 evidence, got ${passed ? 'pass' : 'fail'} (${tests.length} tests, ${failures.length} failures).`);
    process.exitCode = 1;
    break;
  }
}
writeFileSync(resolve(root, 'reports/demo-cycle.json'), `${JSON.stringify(results, null, 2)}\n`);
if (!process.exitCode) console.log('\nDEMO OK: bug detected -> fixed -> regression detected.');
