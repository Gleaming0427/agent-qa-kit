#!/usr/bin/env node
// Smoke evaluations, chosen from the history, with no model call. See eval/lib/smoke.ts.
//   node eval/smoke.ts select [--size <n>] [--as-of <date>] [--json <out>]
//     The tickets of the next smoke run, each with the reasons it was picked, and the others with
//     how soon the rotation reaches them. --as-of (default: now) only decides whether a full run is due.
//   node eval/smoke.ts backtest [--json <out>]
//     Replays the history: what each version's smoke run would have caught of its full run, and at what cost.
//   node eval/smoke.ts tickets
//     The selection alone, separated by spaces, for the QA eval workflow's "tickets" input.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backtest, backtestMarkdown, selectionMarkdown, selectSmoke } from './lib/smoke.ts';
import type { CorpusTicket, Critical, SmokePolicy } from './lib/smoke.ts';
import { loadCampaigns } from './lib/history.ts';
import { KIT, listTickets, loadTicket } from './lib/workspace.ts';

/** The corpus as it is in the checkout: each ticket's kind and the git tree of its folder at HEAD. */
export function currentCorpus(): CorpusTicket[] {
  return listTickets().map((ticket) => {
    const run = spawnSync('git', ['rev-parse', `HEAD:eval/tickets/${ticket}`], { cwd: KIT, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(`cannot read the git tree of eval/tickets/${ticket}: ${run.stderr.trim()}`);
    return { ticket, kind: loadTicket(ticket).kind, tree: run.stdout.trim() };
  });
}

export function smokeInputs(size?: number) {
  const policy = JSON.parse(readFileSync(join(KIT, 'eval/smoke-policy.json'), 'utf8')) as SmokePolicy;
  if (policy.schema_version !== 1) throw new Error(`eval/smoke-policy.json: unknown schema ${policy.schema_version}`);
  if (size !== undefined) policy.size = size;
  const critical = (JSON.parse(readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8')) as { critical: Critical }).critical;
  return { policy, critical, campaigns: loadCampaigns(join(KIT, 'eval/history/campaigns')) };
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (process.argv[1]?.endsWith('smoke.ts')) {
  try {
    const sizeArg = flag('--size');
    if (sizeArg !== undefined && !/^\d+$/.test(sizeArg)) throw new Error('--size must be a whole number');
    const { policy, critical, campaigns } = smokeInputs(sizeArg === undefined ? undefined : Number(sizeArg));
    const json = flag('--json');
    if (command === 'select' || command === 'tickets') {
      const selection = selectSmoke(campaigns, currentCorpus(), policy, critical, flag('--as-of') ?? new Date().toISOString());
      if (json) writeFileSync(json, `${JSON.stringify(selection, null, 2)}\n`);
      console.log(command === 'tickets' ? selection.tickets.map((p) => p.ticket).join(' ') : selectionMarkdown(selection, policy));
    } else if (command === 'backtest') {
      const steps = backtest(campaigns, policy, critical);
      if (json) writeFileSync(json, `${JSON.stringify(steps, null, 2)}\n`);
      console.log(backtestMarkdown(steps, policy));
    } else {
      throw new Error('usage: node eval/smoke.ts <select|tickets|backtest> [--size <n>] [--as-of <date>] [--json <out>]');
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
