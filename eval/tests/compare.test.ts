import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classify, compare, toMarkdown } from '../lib/compare.ts';
import type { Policy } from '../lib/compare.ts';
import { findCampaign, loadCampaigns } from '../lib/history.ts';
import type { Campaign, Observation } from '../lib/history.ts';
import { KIT } from '../lib/workspace.ts';

const campaigns = loadCampaigns(join(KIT, 'eval/history/campaigns'));
const policyText = readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8');
const policy = JSON.parse(policyText) as Policy;
const get = (label: string) => findCampaign(campaigns, label);
const side = (label: string, ...cs: Campaign[]) => ({ label, campaigns: cs });
const run = (a: ReturnType<typeof side>, b: ReturnType<typeof side>, p: Policy = policy) => compare(a, b, p, policyText);

/** A copy of a real campaign, as another agent version, with its observations changed. */
function variant(base: Campaign, agent: string, change: (o: Observation) => Partial<Observation> = () => ({})): Campaign {
  const c = structuredClone(base);
  c.id = `gh-${agent}`;
  c.label = agent;
  c.agent = { ...c.agent, id: agent };
  c.observations = c.observations.map((o) => ({ ...o, ...change(o), fingerprint: `${agent}-${o.key}` }));
  return c;
}
const failAll = (tickets: string[]) => (o: Observation): Partial<Observation> =>
  (tickets.includes(o.ticket) ? { success: false, bugs: o.bugs.map((b) => ({ ...b, detected: false })) } : {});

test('a unit is stable on a side when its trials agree, and unstable otherwise', () => {
  const o = (successes: number, trials = 3) => ({ successes, trials, rate: successes / trials });
  assert.equal(classify(o(3), o(3)), 'both_pass');
  assert.equal(classify(o(0), o(0)), 'both_fail');
  assert.equal(classify(o(0), o(3)), 'improved');
  assert.equal(classify(o(3), o(0)), 'regressed');
  assert.equal(classify(o(3), o(2)), 'unstable');
  assert.equal(classify(o(1, 1), o(0, 1)), 'regressed', 'one trial per side is always "stable": hence the enough_trials rule');
});

test('A against C gives the published figures, and is rejected because C saw the corpus', () => {
  const c = run(side('A', get('A')), side('C', get('C')));
  assert.deepEqual(c.comparability.agent_changes, ['writer prompt']);
  assert.equal(c.comparability.comparable_tickets.length, 6);
  // eval/results/2026-11-02-writer-partitions.md: 8/18 → 17/18 successes, 26/36 → 36/36 bugs, cost +6.4%.
  assert.deepEqual([c.a.success.successes, c.b.success.successes, c.a.bug_detection.successes, c.b.bug_detection.successes], [8, 17, 26, 36]);
  assert.equal(c.measurements.cost.relative_change?.toFixed(3), '0.064');
  const bug = (t: string, id: string) => c.measurements.bugs.find((x) => x.ticket === t && x.bug === id)!;
  assert.deepEqual([bug('EVAL-11', 'updates-first-line').a.successes, bug('EVAL-11', 'updates-first-line').b.successes], [0, 3]);
  assert.equal(bug('EVAL-15', 'case-sensitive').category, 'improved');
  assert.deepEqual(c.analysis.tickets, { both_pass: 1, both_fail: 0, improved: 2, regressed: 0, unstable: 3 });
  assert.deepEqual([c.analysis.sign_test_success.plus, c.analysis.sign_test_success.minus, c.analysis.sign_test_success.p], [4, 0, 0.125]);
  assert.equal(c.analysis.mcnemar_success.applicable, false);
  assert.equal(c.decision.verdict, 'rejected');
  assert.deepEqual(c.decision.reasons.map((r) => [r.rule, r.level]), [['b_corpus_exposure', 'reject'], ['a_corpus_exposure', 'review']]);
  const md = toMarkdown(c, policy);
  assert.match(md, /With 4 ticket\(s\) that changed, no result could reach p < 0\.05 \(the smallest possible p is 0\.1250\)/);
  assert.match(md, /this is not evidence that the versions are equivalent/);
});

test('a clean improvement with enough data and no regression is accepted', () => {
  const d = get('D, clean');
  const before = variant(d, 'before', failAll(['EVAL-11', 'EVAL-15']));
  const c = run(side('before', before), side('D clean', d));
  assert.deepEqual(c.comparability.agent_changes, []);
  assert.equal(c.analysis.tickets.improved, 2);
  assert.equal(c.analysis.tickets.regressed, 0);
  assert.equal(c.decision.verdict, 'accepted', JSON.stringify(c.decision.reasons));
  assert.ok(c.decision.checks.every((x) => x.passed));
  assert.match(toMarkdown(c, policy), /\*\*Decision: ACCEPTED\.\*\* Every rule passed\./);
});

test('each side gives what one successful trial cost, over the comparable trials', () => {
  const d = get('D, clean');
  const before = variant(d, 'before', failAll(['EVAL-11', 'EVAL-15']));
  const c = run(side('before', before), side('D clean', d));
  for (const [s, campaign] of [[c.a, before], [c.b, d]] as const) {
    const trials = campaign.observations.filter((o) => c.comparability.comparable_tickets.includes(o.ticket) && o.status === 'ok');
    const expected = trials.reduce((n, o) => n + o.cost_usd, 0) / trials.filter((o) => o.success).length;
    assert.ok(s.cost_per_success_usd !== null && Math.abs(s.cost_per_success_usd - expected) < 1e-4, `${s.label}: ${s.cost_per_success_usd} against ${expected}`);
  }
  assert.ok(c.a.cost_per_success_usd! > c.b.cost_per_success_usd!, 'the same cost for fewer successes');
  assert.match(toMarkdown(c, policy), /\| Cost per successful trial \| \$\d+\.\d{4} \| \$\d+\.\d{4} \|/);
});

test('McNemar applies when every ticket is stable on both sides', () => {
  const d = get('D, clean');
  const all = d.config.tickets;
  const c = run(side('before', variant(d, 'before', failAll(all))), side('D clean', d));
  assert.equal(c.analysis.tickets.improved, 6);
  assert.deepEqual(c.analysis.mcnemar_success, { applicable: true, b: 0, c: 6, p: 0.03125 });
  assert.equal(c.analysis.sign_test_success.p, 0.03125);
});

test('a confirmed regression on a critical ticket is rejected; unconfirmed, it is to be reviewed', () => {
  const ref = get('D, clean regression check');
  // EVAL-9 is the ambiguous ticket: inventing tests there is a trust failure.
  const invented = variant(ref, 'worse', (o) => (o.ticket === 'EVAL-9' ? { success: false, invented: true } : {}));
  const c = run(side('D clean', ref), side('worse', invented));
  assert.equal(c.measurements.tickets.find((t) => t.ticket === 'EVAL-9')?.category, 'regressed');
  assert.equal(c.decision.verdict, 'rejected');
  assert.ok(c.decision.reasons.some((r) => r.rule === 'critical_regression' && r.message.includes('EVAL-9')));
  // With one trial of the new version, the same change cannot be confirmed.
  const once = structuredClone(invented);
  once.observations = once.observations.filter((o) => o.trial === 1);
  const d = run(side('D clean', ref), side('worse', once));
  assert.equal(d.decision.verdict, 'review');
  assert.ok(d.decision.reasons.some((r) => r.rule === 'regressions' && r.message.includes('EVAL-9 (3/3 → 0/1, not confirmed)')));
  assert.ok(!d.decision.reasons.some((r) => r.rule === 'critical_regression'));
});

test('a change outside the test files rejects the new version', () => {
  const d = get('D, clean');
  const c = run(side('D clean', d), side('leaky', variant(d, 'leaky', (o) => (o.key === 'EVAL-12#2' ? { policy_ok: false } : {}))));
  assert.equal(c.decision.verdict, 'rejected');
  assert.ok(c.decision.reasons.some((r) => r.rule === 'b_policy' && r.message.includes('EVAL-12#2')));
});

test('a worse version across most tickets is flagged, never accepted on a p-value', () => {
  const d = get('D, clean');
  // One trial of three fails on every ticket: no stable regression, but worse everywhere.
  const worse = variant(d, 'worse', (o) => (o.trial === 3 ? { success: false } : {}));
  const c = run(side('D clean', d), side('worse', worse));
  assert.equal(c.analysis.tickets.unstable, 6);
  assert.equal(c.analysis.sign_test_success.minus, 6);
  assert.equal(c.analysis.sign_test_success.p, 0.03125);
  assert.equal(c.decision.verdict, 'review');
  assert.deepEqual(c.decision.reasons.map((r) => r.rule).sort(), ['significant_worsening', 'unstable_worse']);
});

test('too few tickets or trials is a review, and a changed corpus excludes the ticket', () => {
  const d = get('D, clean');
  const split = get('D clean, split runners');
  const c = run(side('D clean', d, get('D, clean regression check')), side('split', split));
  assert.deepEqual(c.comparability.comparable_tickets, ['EVAL-1', 'EVAL-11']);
  assert.ok(c.decision.reasons.some((r) => r.rule === 'enough_tickets'));
  assert.ok(c.decision.reasons.some((r) => r.rule === 'enough_trials'));
  assert.equal(c.decision.verdict, 'review');
  const moved = variant(d, 'moved');
  moved.environment = { ...moved.environment, corpus: { ...moved.environment.corpus, 'EVAL-13': 'another tree' } };
  const e = run(side('D clean', d), side('moved', moved));
  assert.deepEqual(e.comparability.excluded_tickets, [{ ticket: 'EVAL-13', reason: 'its corpus changed' }]);
  assert.equal(e.comparability.comparable_tickets.length, 5);
});

test('a side is one agent version, and a blocked comparison compares nothing', () => {
  assert.throws(() => run(side('mixed', get('A'), get('C')), side('D clean', get('D, clean'))), /mixes agent versions/);
  const d = get('D, clean');
  const rescored = variant(d, 'rescored');
  rescored.scoring = { ...rescored.scoring, scorer: 'other' };
  const c = run(side('D clean', d), side('rescored', rescored));
  assert.deepEqual(c.comparability.comparable_tickets, []);
  assert.ok(c.decision.reasons.some((r) => r.rule === 'comparable' && r.message.startsWith('not comparable: different scoring code')));
});

test('the command line exits with the verdict and writes both reports', () => {
  const cli = spawnSync(process.execPath, [join(KIT, 'eval/compare.ts'), '--a', 'A', '--b', 'C'], { encoding: 'utf8' });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stdout, /^# A → C/);
  const unknown = spawnSync(process.execPath, [join(KIT, 'eval/compare.ts'), '--a', 'nothing', '--b', 'C'], { encoding: 'utf8' });
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /no campaign named "nothing"/);
});
