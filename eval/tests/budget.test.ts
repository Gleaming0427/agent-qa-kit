import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { estimateCost, parseCap } from '../lib/budget.ts';
import { loadCampaigns } from '../lib/history.ts';
import type { Campaign } from '../lib/history.ts';
import { KIT } from '../lib/workspace.ts';

const campaigns = loadCampaigns(join(KIT, 'eval/history/campaigns'));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('each trial is priced at its ticket\'s mean cost in the history, a new ticket at the mean over all', () => {
  const pick = (c: Campaign): Campaign => ({ ...c, observations: c.observations.slice(0, 2) });
  const one = pick(campaigns.find((c) => c.role === 'campaign' && c.observations.length >= 2 && c.observations.every((o) => o.status === 'ok'))!);
  const [a, b] = one.observations;
  const e = estimateCost([{ ticket: a.ticket }, { ticket: a.ticket }, { ticket: 'EVAL-99' }], [one]);
  const mean = (os: typeof one.observations) => os.reduce((n, o) => n + o.cost_usd, 0) / os.length;
  const same = one.observations.filter((o) => o.ticket === a.ticket);
  close(e.per_ticket[0].mean_usd, mean(same));
  assert.deepEqual(e.per_ticket.map((t) => [t.ticket, t.trials, t.from_history]), [[a.ticket, 2, true], ['EVAL-99', 1, false]]);
  close(e.per_ticket[1].mean_usd, mean([a, b]));
  close(e.total_usd, 2 * mean(same) + mean([a, b]));
  // A dry run, at no cost, and trials lost to an error are left out of the prices.
  const dry: Campaign = { ...one, id: 'gh-dry', role: 'dry-run', observations: one.observations.map((o) => ({ ...o, cost_usd: 0 })) };
  const lost: Campaign = { ...one, id: 'gh-lost', observations: one.observations.map((o) => ({ ...o, status: 'agent_error', cost_usd: 0 })) };
  close(estimateCost([{ ticket: a.ticket }], [one, dry, lost]).total_usd, mean(same));
});

test('the cap is an amount in dollars, or nothing', () => {
  assert.equal(parseCap(''), null);
  assert.equal(parseCap(undefined), null);
  assert.equal(parseCap(' 7.50 '), 7.5);
  assert.throws(() => parseCap('ten'), /max_cost_usd must be an amount in dollars/);
  assert.throws(() => parseCap('-1'), /max_cost_usd must be an amount in dollars/);
});

test('the QA eval planner starts nothing above max_cost_usd, and a dry run costs nothing', () => {
  const plan = (env: Record<string, string>) => spawnSync(process.execPath, [join(KIT, 'eval/plan.ts')], {
    encoding: 'utf8', env: { ...process.env, TICKETS: 'EVAL-1 EVAL-2', TRIALS: '3', MAX_PARALLEL: '6', RECHECK: '', EVAL_DRY_RUN: '0', GITHUB_STEP_SUMMARY: '', ...env },
  });
  const under = plan({ MAX_COST_USD: '100' });
  assert.equal(under.status, 0, under.stderr);
  assert.match(under.stderr, /^# Estimated cost: \$\d+\.\d\d \(max_cost_usd: \$100\.00\)$/m);
  assert.match(under.stdout, /^include=/m);
  const over = plan({ MAX_COST_USD: '0.01' });
  assert.equal(over.status, 1);
  assert.match(over.stderr, /is above max_cost_usd \(\$0\.01\): nothing was started/);
  assert.doesNotMatch(over.stdout, /^include=/m);
  assert.equal(plan({ MAX_COST_USD: '0.01', EVAL_DRY_RUN: '1' }).status, 0);
  assert.equal(plan({ MAX_COST_USD: '' }).status, 0);
});
