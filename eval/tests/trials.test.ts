import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compare } from '../lib/compare.ts';
import type { Policy } from '../lib/compare.ts';
import { buildCampaign, findCampaign, loadCampaigns } from '../lib/history.ts';
import type { AgentVersion, Campaign, Environment, Observation } from '../lib/history.ts';
import { scoreTrial } from '../lib/score.ts';
import type { TrialRecord } from '../lib/score.ts';
import type { CorpusTicket, Critical } from '../lib/smoke.ts';
import { allocate, backtestStrategies, replay, retrospect } from '../lib/trials.ts';
import type { TrialsPolicy } from '../lib/trials.ts';
import { KIT } from '../lib/workspace.ts';

// The history as eval/results/2026-11-04-trials.md read it, the first smoke run included.
const campaigns = loadCampaigns(join(KIT, 'eval/history/campaigns')).filter((c) => (c.source.started_at ?? '') < '2026-11-04T08:00:00Z');
const policy = JSON.parse(readFileSync(join(KIT, 'eval/trials-policy.json'), 'utf8')) as TrialsPolicy;
const comparePolicyText = readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8');
const comparePolicy = JSON.parse(comparePolicyText) as Policy;
const critical = comparePolicy.critical as Critical;
const get = (label: string) => findCampaign(campaigns, label);
const latest = [get('D, clean regression check'), get('D, clean')];
const corpus: CorpusTicket[] = latest.flatMap((c) => c.config.tickets.map((t) => ({ ticket: t, kind: c.observations.find((o) => o.ticket === t)!.kind, tree: c.environment.corpus[t] })))
  .sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true }));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test('a replay is exact over every order of the trials that ran', () => {
  // Two passes and a failure, against a reference that always passed.
  const outcomes = [true, true, false];
  close(replay(outcomes, 1, { initial: 1, follow_up: 0 }).p_worse, 1 / 3);
  close(replay(outcomes, 1, { initial: 2, follow_up: 0 }).p_worse, 2 / 3);
  close(replay(outcomes, 1, { initial: 3, follow_up: 0 }).p_worse, 1);
  // One trial, and two more when it fails: worse only if the first one failed; 1 + 2 x 1/3 trials.
  const follow = replay(outcomes, 1, { initial: 1, follow_up: 2 });
  close(follow.p_worse, 1 / 3);
  close(follow.expected_trials, 1 + 2 / 3);
  assert.equal(follow.capped, false);
  // Half the trials pass, as in the reference: worse only when both first trials fail (1 order in 6).
  close(replay([true, false, true, false], 0.5, { initial: 2, follow_up: 0 }).p_worse, 1 / 6);
  // Asking for more trials than ran replays those that ran, and says so.
  assert.equal(replay(outcomes, 1, { initial: 5, follow_up: 0 }).capped, true);
  assert.equal(replay(outcomes, 1, { initial: 5, follow_up: 0 }).expected_trials, 5);
});

test('the allocation follows each ticket\'s history: critical and risky get more trials, stable ones fewer', () => {
  const a = new Map(allocate(campaigns, corpus, policy, critical).map((x) => [x.ticket, x]));
  assert.deepEqual([a.get('EVAL-9')!.class, a.get('EVAL-9')!.trials], ['critical', 5]);
  assert.deepEqual([a.get('EVAL-10')!.class, a.get('EVAL-10')!.trials], ['critical', 5]);
  assert.deepEqual([a.get('EVAL-1')!.class, a.get('EVAL-8')!.class], ['risky', 'risky']);
  assert.deepEqual([a.get('EVAL-2')!.class, a.get('EVAL-2')!.trials], ['stable', 2]);
  assert.ok(a.get('EVAL-2')!.reasons[0].startsWith('every trial passed in D (3/3) and D, clean (3/3)'));
  assert.equal([...a.values()].reduce((n, x) => n + x.trials, 0), 45);
  // A ticket never run with its current corpus is risky.
  const changed = allocate(campaigns, corpus.map((t) => (t.ticket === 'EVAL-5' ? { ...t, tree: 'new' } : t)), policy, critical);
  assert.deepEqual(changed.find((x) => x.ticket === 'EVAL-5')!.reasons, ['never run with its current corpus']);
});

test('the retrospective and the strategies give the figures of the results note, with no look-ahead', () => {
  const retro = retrospect(campaigns, [1, 2, 3], comparePolicy);
  assert.equal(retro.length, 4);
  const recall = (k: number) => {
    const rows = retro.map((s) => s.by_k.find((x) => x.k === k)!);
    const worse = rows.reduce((n, r) => n + r.worse_full, 0);
    return rows.reduce((n, r) => n + (r.recall ?? 0) * r.worse_full, 0) / worse;
  };
  assert.equal(retro.reduce((n, s) => n + s.by_k[0].worse_full, 0), 4);
  assert.equal(Math.round(recall(1) * 100), 46);
  assert.equal(Math.round(recall(2) * 100), 79);
  assert.equal(Math.round(recall(3) * 100), 88);
  assert.ok(retro.every((s) => s.by_k[2].false_alarms === 0));
  const steps = backtestStrategies(campaigns, policy, critical);
  const last = steps.at(-1)!;
  assert.deepEqual(last.results.map((r) => r.strategy), ['uniform, 1 trial', 'uniform, 2 trials', 'uniform, 3 trials', 'adaptive', 'adaptive + follow-up']);
  // Once most tickets are stable, the adaptive allocation costs less than 3 uniform trials.
  assert.ok(last.results[3].expected_cost_usd < last.results[2].expected_cost_usd);
  // Dropping the last version leaves the earlier steps as they were.
  const lastAgent = get('D, clean').agent.id;
  assert.deepEqual(backtestStrategies(campaigns.filter((c) => c.agent.id !== lastAgent), policy, critical), steps.slice(0, -1));
});

test('with scope changed_or_critical, a stable ticket with fewer trials does not ask for a review', () => {
  const d = get('D, clean');
  // Two trials per ticket: the first two of each.
  const two: Campaign = { ...structuredClone(d), id: 'gh-two', label: 'two', observations: d.observations.filter((o) => o.trial <= 2).map((o) => ({ ...o, fingerprint: `two-${o.key}` })) };
  const run = (p: Policy) => compare({ label: 'D clean', campaigns: [d] }, { label: 'two', campaigns: [two] }, p, JSON.stringify(p));
  const scoped = run(comparePolicy);
  assert.equal(comparePolicy.rules.enough_trials.scope, 'changed_or_critical');
  assert.ok(!scoped.decision.reasons.some((r) => r.rule === 'enough_trials'), JSON.stringify(scoped.decision.reasons));
  const strict = run({ ...comparePolicy, rules: { ...comparePolicy.rules, enough_trials: { ...comparePolicy.rules.enough_trials, scope: 'all' } } });
  assert.ok(strict.decision.reasons.some((r) => r.rule === 'enough_trials'));
  // A change on a ticket with two trials still asks for one.
  const failing: Campaign = { ...two, observations: two.observations.map((o): Observation => (o.key === 'EVAL-12#1' ? { ...o, success: false } : o)) };
  const changed = compare({ label: 'D clean', campaigns: [d] }, { label: 'two', campaigns: [failing] }, comparePolicy, comparePolicyText);
  assert.ok(changed.decision.reasons.some((r) => r.rule === 'enough_trials' && r.message.includes('EVAL-12 (3 and 2)')));
});

test('an adaptive run is recorded as such in the history', () => {
  const agent = { id: 'a', commit: 'c', writer: { prompt: 'w', model: null, effort: null }, verifier: { prompt: 'v', model: null, effort: null }, hooks: 'h', settings: 's', scripts: 'q', claude_code: null } as AgentVersion;
  const environment = { corpus: { 'EVAL-1': 't', 'EVAL-2': 't' }, app: 'app', harness: 'h', harness_commit: 'c' } as Environment;
  const record = (ticket: string, trial: number): TrialRecord => ({
    schema_version: 2, ticket, trial, kind: 'feature', criteria: ['AC-1'], started_at: `2026-11-05T10:0${trial}:00.000Z`, finished_at: `2026-11-05T10:0${trial}:30.000Z`,
    phase1: { exit_code: 0, verdict: 'ready', cost_usd: 0.1, duration_ms: 1, num_turns: 1, is_error: false, spec_questions: 0, untestable: 0 },
    changed_non_test_files: [], generated_test_files: [], bugs: [], variants: { bugs: {} }, phase2: null,
  });
  const scores = [scoreTrial(record('EVAL-1', 1)), scoreTrial(record('EVAL-1', 2)), scoreTrial(record('EVAL-1', 3)), scoreTrial(record('EVAL-2', 1)), scoreTrial(record('EVAL-2', 2))];
  const c = buildCampaign(scores, {
    label: 'adaptive', role: 'campaign', repository: 'o/r', run_id: 1, run_number: 1, branch: 'b', started_at: null, commit: 'c',
    scoring: { kind: 'original', commit: 'c', run_id: 1 }, corrections: [], inputs: { tickets: 'all', trials: 'adaptive', verify: false, dry_run: false },
    provenance: { file: 'f', sha256: 'h', artifact: null, doc: null }, notes: [],
  }, { agent, environment, scorer: 's' });
  assert.deepEqual([c.config.trials_mode, c.config.trials_per_ticket, c.config.inferred], ['adaptive', null, []]);
});

test('the QA eval planner turns trials "adaptive" into each ticket\'s trials', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-adaptive-plan-'));
  try {
    const summary = join(work, 'summary.md');
    const run = spawnSync(process.execPath, [join(KIT, 'eval/plan.ts')], {
      encoding: 'utf8', env: { ...process.env, TICKETS: 'EVAL-2 EVAL-9', TRIALS: 'adaptive', MAX_PARALLEL: '6', RECHECK: '', GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(run.status, 0, run.stderr);
    const include = JSON.parse(run.stdout.match(/^include=(.*)$/m)![1]) as { ticket: string; trial: number }[];
    const count = (t: string) => include.filter((x) => x.ticket === t).length;
    assert.ok(count('EVAL-9') === policy.critical_trials, `EVAL-9: ${count('EVAL-9')}`);
    assert.ok(count('EVAL-2') >= policy.stable_trials && count('EVAL-2') <= policy.risky_trials);
    assert.match(readFileSync(summary, 'utf8'), /^# Adaptive trials: /);
    assert.equal(spawnSync(process.execPath, [join(KIT, 'eval/plan.ts')], { encoding: 'utf8', env: { ...process.env, TICKETS: 'EVAL-2', TRIALS: 'many', MAX_PARALLEL: '6' } }).status, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
