#!/usr/bin/env node
// How many trials each ticket needs, from the history, with no model call. See eval/lib/trials.ts.
//   node eval/trials.ts allocate [--tickets all|smoke|"EVAL-1 EVAL-2"] [--json <out>]
//     Each ticket's trials for an adaptive campaign (QA eval: trials adaptive), with the reasons.
//   node eval/trials.ts retro [--max <k>] [--json <out>]
//     What 1 to k trials per ticket (default 3) would have concluded at each change of version.
//   node eval/trials.ts backtest [--json <out>]
//     Uniform 1, 2 and 3 trials against the adaptive allocation, with and without follow-up.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Policy } from './lib/compare.ts';
import { selectSmoke } from './lib/smoke.ts';
import { allocate, allocationMarkdown, backtestStrategies, retroMarkdown, retrospect, strategiesMarkdown } from './lib/trials.ts';
import type { Allocation, TrialsPolicy } from './lib/trials.ts';
import { currentCorpus, smokeInputs } from './smoke.ts';
import { KIT } from './lib/workspace.ts';

export function trialsPolicy(): TrialsPolicy {
  const policy = JSON.parse(readFileSync(join(KIT, 'eval/trials-policy.json'), 'utf8')) as TrialsPolicy;
  if (policy.schema_version !== 1) throw new Error(`eval/trials-policy.json: unknown schema ${policy.schema_version}`);
  return policy;
}

/** The allocation for the tickets a QA eval run asked for: all, a smoke selection, or a list. */
export function adaptiveAllocation(tickets: string): { allocation: Allocation[]; markdown: string } {
  const { policy: smokePolicy, critical, campaigns } = smokeInputs();
  const corpus = currentCorpus();
  const wanted = tickets.trim() === 'smoke'
    ? selectSmoke(campaigns, corpus, smokePolicy, critical, new Date().toISOString()).tickets.map((p) => p.ticket)
    : tickets.trim() === 'all' || !tickets.trim() ? corpus.map((t) => t.ticket) : tickets.split(/[\s,]+/).filter(Boolean);
  const unknown = wanted.filter((t) => !corpus.some((c) => c.ticket === t));
  if (unknown.length) throw new Error(`unknown eval ticket(s): ${unknown.join(', ')}`);
  const policy = trialsPolicy();
  const allocation = allocate(campaigns, corpus.filter((c) => wanted.includes(c.ticket)), policy, critical)
    .sort((a, b) => wanted.indexOf(a.ticket) - wanted.indexOf(b.ticket));
  const cost = new Map<string, number>();
  for (const t of wanted) {
    const os = campaigns.flatMap((c) => c.observations.filter((o) => o.ticket === t && o.status === 'ok'));
    if (os.length) cost.set(t, os.reduce((n, o) => n + o.cost_usd, 0) / os.length);
  }
  return { allocation, markdown: allocationMarkdown(allocation, policy, cost) };
}

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (process.argv[1]?.endsWith('trials.ts')) {
  try {
    const json = flag('--json');
    const { critical, campaigns } = smokeInputs();
    if (command === 'allocate') {
      const { allocation, markdown } = adaptiveAllocation(flag('--tickets') ?? 'all');
      if (json) writeFileSync(json, `${JSON.stringify(allocation, null, 2)}\n`);
      console.log(markdown);
    } else if (command === 'retro') {
      const max = Number(flag('--max') ?? 3);
      if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error('--max must be a whole number from 1 to 10');
      const comparePolicy = JSON.parse(readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8')) as Policy;
      const steps = retrospect(campaigns, Array.from({ length: max }, (_, i) => i + 1), comparePolicy);
      if (json) writeFileSync(json, `${JSON.stringify(steps, null, 2)}\n`);
      console.log(retroMarkdown(steps));
    } else if (command === 'backtest') {
      const policy = trialsPolicy();
      const steps = backtestStrategies(campaigns, policy, critical);
      if (json) writeFileSync(json, `${JSON.stringify(steps, null, 2)}\n`);
      console.log(strategiesMarkdown(steps, policy));
    } else {
      throw new Error('usage: node eval/trials.ts <allocate [--tickets all|smoke|list]|retro [--max k]|backtest> [--json <out>]');
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
  }
}
