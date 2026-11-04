#!/usr/bin/env node
// Validates the inputs of the "QA eval" workflow and prints the trial matrix, and the tickets whose
// specs go into the agent bundle, for GITHUB_OUTPUT.
// Inputs come from the environment: TICKETS ("all", "smoke" for a selection from the history made by
// eval/smoke.ts, whose reasons go to the run's summary, or keys separated by spaces or commas),
// TRIALS (1-10, or "adaptive": each ticket's trials from eval/trials-policy.json, see eval/trials.ts)
// and MAX_PARALLEL (1-20). MAX_COST_USD caps the campaign's estimated cost (eval/lib/budget.ts): empty
// means no cap, and a dry run or a recheck costs nothing. RECHECK lists earlier QA eval run ids,
// separated by spaces or commas, to aggregate again with the current code instead of running trials.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost, estimateMarkdown, parseCap } from './lib/budget.ts';
import { loadCampaigns } from './lib/history.ts';
import { KIT, listTickets, loadTicket } from './lib/workspace.ts';
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

// TRIALS=adaptive: each ticket gets the trials of eval/trials-policy.json, fixed from the history now.
const adaptive = (process.env.TRIALS ?? '').trim() === 'adaptive';
const trials = adaptive ? 0 : integer('TRIALS', 1, 10);
const requested = (process.env.TICKETS ?? 'all').trim();
let tickets: string[];
if (requested === 'smoke') {
  const { policy, critical, campaigns } = smokeInputs();
  const selection = selectSmoke(campaigns, currentCorpus(), policy, critical, new Date().toISOString());
  tickets = selection.tickets.map((p) => p.ticket);
  const report = selectionMarkdown(selection, policy, adaptive ? 'with the trials of the adaptive allocation' : `${trials} trial(s) each`);
  console.error(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
} else {
  tickets = requested === 'all' || requested === '' ? listTickets() : [...new Set(requested.split(/[\s,]+/).filter(Boolean))];
}
for (const ticket of tickets) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) { console.error(`Invalid ticket key: ${ticket}`); process.exit(1); }
  try { loadTicket(ticket); } catch { console.error(`Unknown eval ticket: ${ticket}`); process.exit(1); }
}
const trialsOf = new Map<string, number>();
if (adaptive) {
  const { allocation, markdown } = adaptiveAllocation(tickets.join(' '));
  for (const a of allocation) trialsOf.set(a.ticket, a.trials);
  console.error(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
const maxParallel = integer('MAX_PARALLEL', 1, 20);
const include = tickets.flatMap((ticket) => Array.from({ length: adaptive ? trialsOf.get(ticket)! : trials }, (_, i) => ({ ticket, trial: i + 1 })));
if (!include.length || include.length > 256) { console.error(`The matrix must hold 1 to 256 trials, got ${include.length}`); process.exit(1); }
const recheck = [...new Set((process.env.RECHECK ?? '').split(/[\s,]+/).filter(Boolean))];
for (const run of recheck) {
  if (!/^\d{1,20}$/.test(run)) { console.error(`Invalid run id: ${run}`); process.exit(1); }
}
if (recheck.length > 32) { console.error(`At most 32 runs to recheck, got ${recheck.length}`); process.exit(1); }
// The cost, before anything runs: a campaign whose estimate is above MAX_COST_USD does not start.
if (!recheck.length && process.env.EVAL_DRY_RUN !== '1') {
  let cap: number | null = null;
  try { cap = parseCap(process.env.MAX_COST_USD); } catch (error) { console.error((error as Error).message); process.exit(1); }
  const estimate = estimateCost(include, loadCampaigns(join(KIT, 'eval/history/campaigns')));
  const report = estimateMarkdown(estimate, cap);
  console.error(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  if (cap !== null && estimate.total_usd > cap) {
    console.error(`The estimated cost, $${estimate.total_usd.toFixed(2)}, is above max_cost_usd ($${cap.toFixed(2)}): nothing was started. Run fewer tickets or trials (tickets: smoke, trials: adaptive), or raise max_cost_usd.`);
    process.exit(1);
  }
}
console.log(`include=${JSON.stringify(include)}`);
console.log(`tickets=${tickets.join(' ')}`);
console.log(`max_parallel=${maxParallel}`);
console.log(`recheck=${JSON.stringify(recheck)}`);
console.error(recheck.length
  ? `Recheck of ${recheck.length} earlier run(s): ${recheck.join(', ')}`
  : `${include.length} trial(s): ${tickets.length} ticket(s) x ${adaptive ? 'adaptive' : trials}, ${maxParallel} at a time`);
