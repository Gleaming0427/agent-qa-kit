import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { backtest, selectSmoke, versionsOf } from '../lib/smoke.ts';
import type { CorpusTicket, Critical, SmokePolicy } from '../lib/smoke.ts';
import { loadCampaigns } from '../lib/history.ts';
import type { Campaign, Observation } from '../lib/history.ts';
import { KIT } from '../lib/workspace.ts';

const everything = loadCampaigns(join(KIT, 'eval/history/campaigns'));
// The history as eval/results/2026-11-04-smoke-backtest.md read it, before the first smoke run.
const campaigns = everything.filter((c) => (c.source.started_at ?? '') < '2026-11-04T07:00:00Z');
const policy = JSON.parse(readFileSync(join(KIT, 'eval/smoke-policy.json'), 'utf8')) as SmokePolicy;
const critical = (JSON.parse(readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8')) as { critical: Critical }).critical;
const latest = campaigns.find((c) => c.label === 'D, clean regression check')!;
const newer = campaigns.find((c) => c.label === 'D, clean')!;
// The corpus as the latest campaigns ran it.
const corpus: CorpusTicket[] = [...latest.observations, ...newer.observations]
  .filter((o, i, all) => all.findIndex((x) => x.ticket === o.ticket) === i)
  .map((o) => ({ ticket: o.ticket, kind: o.kind, tree: (o.ticket in latest.environment.corpus ? latest : newer).environment.corpus[o.ticket] }))
  .sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true }));
const asOf = '2026-11-04T12:00:00.000Z';
const select = (cs = campaigns, c = corpus, p = policy) => selectSmoke(cs, c, p, critical, asOf);

test('the selection is reproducible, whatever the order of the campaigns', () => {
  const a = select();
  const b = select([...campaigns].reverse());
  assert.deepEqual(b, a);
  assert.equal(a.tickets.length, policy.size);
  assert.match(a.inputs_digest, /^[0-9a-f]{64}$/);
  // Another policy is another input.
  assert.notEqual(select(campaigns, corpus, { ...policy, size: 4 }).inputs_digest, a.inputs_digest);
});

test('every critical ticket and every kind is in every selection, each pick with its reasons', () => {
  for (const size of [1, 3, 4, 6, 8]) {
    const s = select(campaigns, corpus, { ...policy, size });
    const picked = s.tickets.map((p) => p.ticket);
    assert.ok(picked.includes('EVAL-9') && picked.includes('EVAL-10'), `size ${size}: ${picked.join(' ')}`);
    for (const kind of ['feature', 'ambiguous', 'adversarial']) assert.ok(s.tickets.some((p) => p.kind === kind), `size ${size}: no ${kind}`);
    assert.ok(s.tickets.every((p) => p.reasons.length > 0 && p.reasons.some((r) => r.startsWith('last run '))));
    assert.equal(picked.length + s.not_selected.length, corpus.length);
  }
  const s = select();
  assert.deepEqual(s.tickets.map((p) => [p.ticket, p.because]), [
    ['EVAL-9', 'critical'], ['EVAL-10', 'critical'], ['EVAL-1', 'kind'], ['EVAL-8', 'regressed'], ['EVAL-12', 'rotation'], ['EVAL-13', 'rotation'],
  ]);
  assert.ok(s.tickets.find((p) => p.ticket === 'EVAL-8')!.reasons.some((r) => r.startsWith('regressed from D to D, clean: 3/3 → 2/3')));
});

test('the first real smoke run moved the rotation on', () => {
  const before = select().tickets.map((p) => p.ticket);
  const after = select(everything).tickets;
  assert.deepEqual(before, ['EVAL-9', 'EVAL-10', 'EVAL-1', 'EVAL-8', 'EVAL-12', 'EVAL-13']);
  // EVAL-12 and EVAL-13 ran in smoke run 30: the rotation now takes the next ones.
  assert.deepEqual(after.map((p) => p.ticket), ['EVAL-9', 'EVAL-10', 'EVAL-1', 'EVAL-8', 'EVAL-14', 'EVAL-15']);
  assert.deepEqual(after.filter((p) => p.because === 'rotation').map((p) => p.ticket), ['EVAL-14', 'EVAL-15']);
  // A smoke run is not a full run: the backtest leaves it out of its version's full run.
  assert.deepEqual(backtest(everything, policy, critical), backtest(campaigns, policy, critical));
});

test('a ticket whose corpus changed comes first after the critical ones', () => {
  const changed = corpus.map((t) => (t.ticket === 'EVAL-5' ? { ...t, tree: 'a new tree' } : t));
  const s = select(campaigns, changed);
  const pick = s.tickets.find((p) => p.ticket === 'EVAL-5');
  assert.ok(pick, s.tickets.map((p) => p.ticket).join(' '));
  assert.ok(pick.reasons.includes('never run with its current corpus'));
  assert.ok(pick.reasons.includes('last run never'));
});

/** A smoke campaign of the latest agent on the given tickets, all trials passing. */
function smokeRun(n: number, tickets: string[]): Campaign {
  const c = structuredClone(newer);
  const start = new Date(Date.parse('2026-11-05T00:00:00.000Z') + n * 86_400_000).toISOString();
  c.id = `gh-smoke-${n}`;
  c.label = `smoke ${n}`;
  c.source = { ...c.source, run_id: n, started_at: start };
  c.provenance = { ...c.provenance, sha256: `smoke-${n}` };
  c.environment = { ...c.environment, corpus: Object.fromEntries(corpus.map((t) => [t.ticket, t.tree])) };
  const template = newer.observations[0];
  c.observations = tickets.flatMap((ticket) => [1, 2, 3].map((trial): Observation => ({
    ...template, key: `${ticket}#${trial}`, ticket, trial, kind: corpus.find((t) => t.ticket === ticket)!.kind as Observation['kind'],
    started_at: start, finished_at: start, success: true, status: 'ok', bugs: [], fingerprint: `smoke-${n}-${ticket}-${trial}`,
  })));
  c.config = { ...c.config, tickets, trials: c.observations.length };
  return c;
}

test('no ticket stays out: the rotation reaches each one, as long as smoke runs are recorded', () => {
  let history = [...campaigns];
  const lastSeen = new Map<string, number>();
  const outside = corpus.filter((t) => !critical.kinds.includes(t.kind)).length;
  for (let n = 0; n < 2 * outside; n++) {
    const s = select(history);
    for (const p of s.tickets) lastSeen.set(p.ticket, n);
    // Whatever is left out says how soon the rotation comes, and never later than the bound.
    for (const x of s.not_selected) assert.ok(x.runs_until_rotation <= outside, `${x.ticket}: ${x.runs_until_rotation}`);
    for (const t of corpus) assert.ok(n - (lastSeen.get(t.ticket) ?? -1) <= outside, `round ${n}: ${t.ticket} not seen for more than ${outside} smoke runs`);
    history = [...history, smokeRun(n, s.tickets.map((p) => p.ticket))];
  }
  assert.equal(lastSeen.size, corpus.length);
});

test('a full run is due after the policy\'s number of days', () => {
  assert.equal(select().full_run.due, false);
  const later = selectSmoke(campaigns, corpus, policy, critical, '2026-12-01T00:00:00.000Z');
  assert.equal(later.full_run.due, true);
  assert.match(later.full_run.reason, /more than 14 days/);
  const missing = select(campaigns, [...corpus, { ticket: 'EVAL-99', kind: 'feature', tree: 'x' }]);
  assert.equal(missing.full_run.due, true);
});

test('the backtest uses only the history before each version, and measures catch and cost', () => {
  const steps = backtest(campaigns, policy, critical);
  assert.deepEqual(steps.map((s) => s.version), ['B', 'C', 'D', 'D, clean']);
  // Dropping the campaigns of the last version leaves the earlier steps as they were: no look-ahead.
  const last = versionsOf(campaigns).at(-1)!;
  const earlier = backtest(campaigns.filter((c) => c.agent.id !== last.agent), policy, critical);
  assert.deepEqual(earlier, steps.slice(0, -1));
  for (const s of steps) {
    assert.ok(s.selection.includes('EVAL-9') && s.selection.includes('EVAL-10'));
    assert.ok(s.cost_usd.smoke <= s.cost_usd.full && s.trials.smoke < s.trials.full);
    assert.deepEqual(s.worse_caught, s.worse.filter((t) => s.selection.includes(t)));
  }
  // eval/results/2026-11-04-smoke-backtest.md, with the policy's size of 6.
  const caught = steps.reduce((n, s) => n + s.worse_caught.length, 0);
  const worse = steps.reduce((n, s) => n + s.worse.length, 0);
  assert.deepEqual([caught, worse], [3, 4]);
  assert.equal(steps.reduce((n, s) => n + s.regressed.length, 0), 0);
});

test('the QA eval planner turns "smoke" into the selection, with its reasons in the run summary', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-smoke-plan-'));
  try {
    const summary = join(work, 'summary.md');
    const run = spawnSync(process.execPath, [join(KIT, 'eval/plan.ts')], {
      encoding: 'utf8', env: { ...process.env, TICKETS: 'smoke', TRIALS: '3', MAX_PARALLEL: '6', RECHECK: '', GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(run.status, 0, run.stderr);
    const tickets = run.stdout.match(/^tickets=(.*)$/m)?.[1].split(' ') ?? [];
    assert.equal(tickets.length, policy.size);
    assert.ok(tickets.includes('EVAL-9') && tickets.includes('EVAL-10'));
    assert.match(run.stdout, new RegExp(`include=.*"ticket":"${tickets[0]}","trial":3`));
    assert.match(readFileSync(summary, 'utf8'), /^# Smoke selection: /);
    const cli = spawnSync(process.execPath, [join(KIT, 'eval/smoke.ts'), 'tickets'], { encoding: 'utf8' });
    assert.equal(cli.stdout.trim(), tickets.join(' '));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
