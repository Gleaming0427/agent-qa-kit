#!/usr/bin/env node
// Validates the inputs of the "QA eval" workflow and prints the trial matrix, and the tickets whose
// specs go into the agent bundle, for GITHUB_OUTPUT.
// Inputs come from the environment: TICKETS ("all", "smoke" for a selection from the history made by
// eval/smoke.ts, whose reasons go to the run's summary, or keys separated by spaces or commas),
// TRIALS (1-10, or "adaptive": each ticket's trials from eval/trials-policy.json, see eval/trials.ts),
// TRIALS (1-10) and MAX_PARALLEL (1-20). RECHECK lists earlier QA eval run ids, separated by spaces
// or commas, to aggregate again with the current code instead of running trials.
import { appendFileSync } from 'node:fs';
import { listTickets, loadTicket } from './lib/workspace.ts';
import { selectionMarkdown, selectSmoke } from './lib/smoke.ts';
import { currentCorpus, smokeInputs } from './smoke.ts';
import { adaptiveAllocation } from './trials.ts';

function integer(name: string, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    console.error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    process.exit(1);
  }
  return Number(raw);
}

const requested = (process.env.TICKETS ?? 'all').trim();
let tickets: string[];
if (requested === 'smoke') {
  const { policy, critical, campaigns } = smokeInputs();
  const selection = selectSmoke(campaigns, currentCorpus(), policy, critical, new Date().toISOString());
  tickets = selection.tickets.map((p) => p.ticket);
  const report = selectionMarkdown(selection, policy);
  console.error(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
} else {
  tickets = requested === 'all' || requested === '' ? listTickets() : [...new Set(requested.split(/[\s,]+/).filter(Boolean))];
}
for (const ticket of tickets) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) { console.error(`Invalid ticket key: ${ticket}`); process.exit(1); }
  try { loadTicket(ticket); } catch { console.error(`Unknown eval ticket: ${ticket}`); process.exit(1); }
}
// TRIALS=adaptive: each ticket gets the trials of eval/trials-policy.json, fixed from the history now.
const adaptive = (process.env.TRIALS ?? '').trim() === 'adaptive';
const trialsOf = new Map<string, number>();
if (adaptive) {
  const { allocation, markdown } = adaptiveAllocation(tickets.join(' '));
  for (const a of allocation) trialsOf.set(a.ticket, a.trials);
  console.error(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
const trials = adaptive ? 0 : integer('TRIALS', 1, 10);
const maxParallel = integer('MAX_PARALLEL', 1, 20);
const include = tickets.flatMap((ticket) => Array.from({ length: adaptive ? trialsOf.get(ticket)! : trials }, (_, i) => ({ ticket, trial: i + 1 })));
if (!include.length || include.length > 256) { console.error(`The matrix must hold 1 to 256 trials, got ${include.length}`); process.exit(1); }
const recheck = [...new Set((process.env.RECHECK ?? '').split(/[\s,]+/).filter(Boolean))];
for (const run of recheck) {
  if (!/^\d{1,20}$/.test(run)) { console.error(`Invalid run id: ${run}`); process.exit(1); }
}
if (recheck.length > 32) { console.error(`At most 32 runs to recheck, got ${recheck.length}`); process.exit(1); }
console.log(`include=${JSON.stringify(include)}`);
console.log(`tickets=${tickets.join(' ')}`);
console.log(`max_parallel=${maxParallel}`);
console.log(`recheck=${JSON.stringify(recheck)}`);
console.error(recheck.length
  ? `Recheck of ${recheck.length} earlier run(s): ${recheck.join(', ')}`
  : `${include.length} trial(s): ${tickets.length} ticket(s) x ${adaptive ? 'adaptive' : trials}, ${maxParallel} at a time`);
