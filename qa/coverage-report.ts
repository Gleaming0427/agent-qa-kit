#!/usr/bin/env node
/** Human-readable, per-criterion proof from reports, not the agent's prose.
 * Usage: node qa/coverage-report.ts TICKET-42 [phase 1|2]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateEvidence } from '../.claude/hooks/strict-evidence.ts';
import type { Manifest, PlaywrightReport, Verdict, VitestReport } from '../.claude/hooks/strict-evidence.ts';

const ticket = process.argv[2] ?? '';
const phase = Number(process.argv[3] || 2);
if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket) || ![1, 2].includes(phase)) {
  console.error('Usage: node qa/coverage-report.ts TICKET-42 [1|2]');
  process.exit(2);
}
function read<T>(path: string): T | null { try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; } }
const manifest = read<Manifest>(`reports/${ticket}-criteria.json`);
const verdict = read<Verdict>(`reports/${ticket}-phase${phase}.json`);
const vitest = read<VitestReport>('reports/vitest.json');
const playwright = read<PlaywrightReport>('reports/playwright.json');
if (!manifest || !verdict) { console.error('Manifest or final verdict missing.'); process.exit(2); }
const { problems, evidence } = validateEvidence({ manifest, verdict, phase, vitest, playwright, root: process.cwd() });
const output = { ticket, phase, verdict: verdict.verdict, validated: problems.length === 0, problems, evidence };
const path = resolve(`reports/${ticket}-evidence-phase${phase}.json`);
writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Evidence report: ${path}`);
for (const e of evidence) console.log(`${e.criterion.padEnd(6)} ${e.level.padEnd(5)} ${e.result.padEnd(7)} ${e.tests.length} actual test(s)`);
for (const p of problems) console.error(`FAIL: ${p}`);
if (problems.length) process.exitCode = 1;
