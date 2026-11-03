#!/usr/bin/env node
// Validates the inputs of the "QA eval" workflow and prints the trial matrix, and the tickets whose
// specs go into the agent bundle, for GITHUB_OUTPUT.
// Inputs come from the environment: TICKETS ("all" or keys separated by spaces or commas),
// TRIALS (1-10) and MAX_PARALLEL (1-20). RECHECK lists earlier QA eval run ids, separated by spaces
// or commas, to aggregate again with the current code instead of running trials.
import { listTickets, loadTicket } from './lib/workspace.ts';

function integer(name: string, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    console.error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
    process.exit(1);
  }
  return Number(raw);
}

const requested = (process.env.TICKETS ?? 'all').trim();
const tickets = requested === 'all' || requested === '' ? listTickets() : [...new Set(requested.split(/[\s,]+/).filter(Boolean))];
for (const ticket of tickets) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) { console.error(`Invalid ticket key: ${ticket}`); process.exit(1); }
  try { loadTicket(ticket); } catch { console.error(`Unknown eval ticket: ${ticket}`); process.exit(1); }
}
const trials = integer('TRIALS', 1, 10);
const maxParallel = integer('MAX_PARALLEL', 1, 20);
const include = tickets.flatMap((ticket) => Array.from({ length: trials }, (_, i) => ({ ticket, trial: i + 1 })));
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
  : `${include.length} trial(s): ${tickets.length} ticket(s) x ${trials}, ${maxParallel} at a time`);
