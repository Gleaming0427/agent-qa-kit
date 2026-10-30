#!/usr/bin/env node
/** A phase 2 pass only counts if the whole project still works: every unit
 * test and every browser test pass, fixed @smoke journeys included. The
 * launcher runs this suite itself, after the agent, so the agent cannot skip it.
 * Usage: node qa/full-suite.ts TICKET-42   (reads the reports in reports/)
 * Exit: 0 pass, 1 failures, 2 missing reports or invalid arguments.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanMessage, extractPlaywrightTests, extractVitestTests, validateEvidence } from '../.claude/hooks/strict-evidence.ts';
import type { Manifest, PlaywrightReport, Verdict, VitestReport } from '../.claude/hooks/strict-evidence.ts';

const MAX_PRINTED = 10;

interface FullSuiteInput { manifest: Manifest; verdict: Verdict; vitest: VitestReport; playwright: PlaywrightReport }

export function checkFullSuite({ manifest, verdict, vitest, playwright }: FullSuiteInput): string[] {
  const problems: string[] = [];
  const unit = extractVitestTests(vitest);
  const browser = extractPlaywrightTests(playwright);
  const smoke = browser.filter((t) => t.tags.includes('smoke') || /(^|\s)@smoke\b/.test(t.title));
  if (!unit.length) problems.push('The full unit suite ran no tests.');
  if (!browser.length) problems.push('The full browser suite ran no tests.');
  for (const error of playwright.errors ?? []) problems.push(`Browser suite error: ${cleanMessage(error.message).slice(0, 200)}`);
  for (const t of unit) if (t.status === 'failed') problems.push(`Unit test failed: ${t.title}`);
  for (const t of browser) {
    if (t.status === 'unexpected') problems.push(`Browser test failed: ${t.title}`);
    if (t.status === 'flaky') problems.push(`Browser test is flaky: ${t.title}`);
  }
  if (!smoke.some((t) => t.status === 'expected')) {
    problems.push(smoke.length ? 'No @smoke journey passed.' : 'No @smoke journey ran: the full browser suite must include the fixed smoke tests.');
  }
  // The ticket's own criteria must still pass when everything runs together.
  problems.push(...validateEvidence({ verdict, manifest, phase: 2, vitest, playwright }).problems);
  return [...new Set(problems)];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ticket = process.argv[2] ?? '';
  const read = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } };
  const manifest = read<Manifest>(`reports/${ticket}-criteria.json`);
  const verdict = read<Verdict>(`reports/${ticket}-phase2.json`);
  const vitest = read<VitestReport>('reports/vitest.json');
  const playwright = read<PlaywrightReport>('reports/playwright.json');
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket)) {
    console.error('Usage: node qa/full-suite.ts TICKET-42');
    process.exit(2);
  }
  if (!manifest || !verdict || !vitest || !playwright) {
    console.error('Full suite: missing manifest, phase 2 verdict, reports/vitest.json or reports/playwright.json.');
    process.exit(2);
  }
  const problems = checkFullSuite({ manifest, verdict, vitest, playwright });
  const unit = extractVitestTests(vitest).length;
  const browser = extractPlaywrightTests(playwright).length;
  const path = resolve(`reports/${ticket}-full-suite.json`);
  writeFileSync(path, `${JSON.stringify({ ticket, passed: problems.length === 0, unit_tests: unit, browser_tests: browser, problems }, null, 2)}\n`);
  console.log(`Full suite for ${ticket}: ${unit} unit tests, ${browser} browser tests: ${problems.length ? 'FAIL' : 'pass'} (${path})`);
  for (const p of problems.slice(0, MAX_PRINTED)) console.error(`FAIL: ${p}`);
  if (problems.length > MAX_PRINTED) console.error(`… and ${problems.length - MAX_PRINTED} more`);
  if (problems.length) process.exitCode = 1;
}
