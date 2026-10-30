#!/usr/bin/env node
// Automated Red -> Green -> Regression: same acceptance tests, intentionally
// buggy code flag toggled. Red must fail and green must pass; no tests changed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const e2e = process.argv.includes('--e2e');
const root = resolve(import.meta.dirname, '..');
const steps = [
  { name: '01-red', bug: '1', expectPass: false },
  { name: '02-green', bug: '0', expectPass: true },
  { name: '03-regression', bug: '1', expectPass: false },
];
mkdirSync(resolve(root, 'reports'), { recursive: true });
const results = [];
for (const step of steps) {
  console.log(`\n========== ${step.name} / ${e2e ? 'E2E' : 'MFE'} ==========`);
  const run = spawnSync('npm', ['run', e2e ? 'test:e2e' : 'test:unit'], {
    cwd: root, encoding: 'utf8', stdio: 'inherit',
    env: { ...process.env, VITE_DEMO_BUG: step.bug },
  });
  const passed = run.status === 0;
  const report = resolve(root, 'reports', e2e ? 'playwright.json' : 'vitest.json');
  const savedReport = resolve(root, 'reports', `${step.name}-${e2e ? 'playwright' : 'vitest'}.json`);
  if (existsSync(report)) copyFileSync(report, savedReport);
  results.push({ stage: step.name, bugEnabled: step.bug === '1', passed, expectedPass: step.expectPass, report: existsSync(savedReport) ? savedReport : null });
  if (run.error || run.status === null || passed !== step.expectPass || !existsSync(report)) {
    console.error(`Unexpected result at ${step.name}: expected ${step.expectPass ? 'pass' : 'fail'}, got ${passed ? 'pass' : 'fail'}`);
    process.exitCode = 1;
    break;
  }
}
writeFileSync(resolve(root, 'reports/demo-cycle.json'), `${JSON.stringify(results, null, 2)}\n`);
if (!process.exitCode) console.log('\nDEMO OK: bug detected -> fixed -> regression detected.');
