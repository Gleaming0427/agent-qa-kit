import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCampaign, checkHistory, compatibility, flatten, hasCommit } from '../lib/history.ts';
import type { AgentVersion, Campaign, CampaignInput, Environment } from '../lib/history.ts';
import { scoreTrial } from '../lib/score.ts';
import type { AgentRun, TrialRecord, TrialScore } from '../lib/score.ts';
import { KIT } from '../lib/workspace.ts';
import { compare } from '../lib/compare.ts';
import type { Policy } from '../lib/compare.ts';

const HISTORY = join(KIT, 'eval/history');
const sources = JSON.parse(readFileSync(join(HISTORY, 'sources.json'), 'utf8')) as { campaigns: { run_id: number; commit: string; scoring: { commit: string }; corrections: string[]; source: { file: string } }[] };
const committed = readdirSync(join(HISTORY, 'campaigns')).sort().map((f) => JSON.parse(readFileSync(join(HISTORY, 'campaigns', f), 'utf8')) as Campaign);
const byLabel = (label: string) => committed.find((c) => c.label === label)!;

const commitsHere = sources.campaigns.every((c) => hasCommit(KIT, c.commit) && hasCommit(KIT, c.scoring.commit));

test('the history is rebuilt from its sources, byte for byte, with no model call', { skip: !commitsHere && 'needs the campaigns\' commits (git fetch --unshallow)' }, () => {
  const out = mkdtempSync(join(tmpdir(), 'eval-history-'));
  try {
    const run = spawnSync(process.execPath, [join(KIT, 'eval/history.ts'), 'build', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const rebuilt = readdirSync(out).sort();
    assert.deepEqual(rebuilt, readdirSync(join(HISTORY, 'campaigns')).sort());
    for (const file of rebuilt) assert.equal(readFileSync(join(out, file), 'utf8'), readFileSync(join(HISTORY, 'campaigns', file), 'utf8'), file);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the history holds the 13 rechecked campaigns and the campaigns run since, with no error', () => {
  assert.equal(committed.length, sources.campaigns.length);
  const sourceTrials = sources.campaigns.reduce((n, e) => n + (JSON.parse(readFileSync(join(HISTORY, e.source.file), 'utf8')) as { trials: unknown[] }).trials.length, 0);
  assert.equal(committed.reduce((n, c) => n + c.observations.length, 0), sourceTrials);
  assert.deepEqual(checkHistory(committed).filter((p) => p.level === 'error'), []);
  const rechecked = committed.filter((c) => c.scoring.kind === 'recomputed');
  assert.equal(rechecked.length, 13);
  assert.equal(rechecked.reduce((n, c) => n + c.observations.length, 0), 272);
  for (const c of committed) {
    // A campaign run since is scored by its own run, and records how it chose its tickets.
    if (c.scoring.kind === 'original') assert.equal(c.scoring.run_id, c.source.run_id, c.label);
    assert.equal(c.config.selection === null, c.scoring.kind === 'recomputed', c.label);
    assert.ok(c.provenance.sha256 && c.provenance.artifact?.digest.startsWith('sha256:'), c.id);
  }
  assert.equal(byLabel('smoke, run 30').config.selection, 'smoke');
  // A campaign run since records its inputs and is complete.
  const split = byLabel('D clean, split runners');
  assert.deepEqual(split.config.inferred, []);
  assert.deepEqual(split.missing, {});
  assert.equal(split.agent.id, byLabel('D, clean').agent.id, 'the same agent as D clean');
});

test('build refuses to delete a campaign file that has no source', () => {
  const out = mkdtempSync(join(tmpdir(), 'eval-history-orphan-'));
  try {
    writeFileSync(join(out, 'gh-1.json'), '{}');
    const run = spawnSync(process.execPath, [join(KIT, 'eval/history.ts'), 'build', out], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Not in sources\.json, so build would delete them: gh-1\.json/);
    assert.ok(readdirSync(out).includes('gh-1.json'), 'the file is still there');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the tokens are known for every trial a model answered', () => {
  const all = committed.flatMap((c) => c.observations.map((o) => ({ label: c.label, o })));
  assert.ok(all.filter(({ o }) => o.models.length).every(({ o }) => o.tokens));
  // The trials without: stopped before any model answered, by the spend limit (B's regression check, 18)
  // or by the API credit (6 of run 36).
  const without = all.filter(({ o }) => !o.tokens);
  assert.ok(without.every(({ o }) => o.status === 'agent_error' && o.models.length === 0));
  assert.equal(without.filter(({ label }) => label === 'B, regression check').length, 18);
  assert.equal(without.filter(({ label }) => label === 'follow-up of rule 5, run 36').length, 6);
});

test('each campaign keeps the metrics of its source report, corrections aside', () => {
  for (const entry of sources.campaigns) {
    const report = JSON.parse(readFileSync(join(HISTORY, entry.source.file), 'utf8')) as { metrics: Record<string, { successes: number; n: number }>; trials: TrialScore[] };
    const c = committed.find((x) => x.source.run_id === entry.run_id)!;
    const bugs = c.observations.flatMap((o) => o.bugs);
    assert.equal(bugs.filter((b) => b.detected).length, report.metrics.bug_detection.successes, `${c.label}: bugs detected`);
    assert.equal(bugs.length, report.metrics.bug_detection.n, `${c.label}: bugs`);
    assert.equal(c.observations.reduce((n, o) => n + o.cost_usd, 0).toFixed(6), report.trials.reduce((n, t) => n + t.cost_usd, 0).toFixed(6));
    const original = c.observations.map((o) => o.corrected?.original.success ?? o.success).filter(Boolean).length;
    assert.equal(original, report.metrics.success.successes, `${c.label}: successes before corrections`);
    if (!entry.corrections.length) assert.ok(c.observations.every((o) => !o.corrected), c.label);
  }
});

test('the pilot\'s correction gives the published figures and keeps the original values', () => {
  const pilot = byLabel('Pilot');
  assert.deepEqual(pilot.scoring.corrections.map((x) => [x.id, x.trials]), [['sandbox-placeholders', 30]]);
  // eval/results/2026-11-02-pilot.md: 23 of 30 trials succeed once the placeholders are set aside.
  assert.equal(pilot.observations.filter((o) => o.success).length, 23);
  assert.equal(pilot.observations.filter((o) => o.policy_ok).length, 30);
  assert.ok(pilot.observations.every((o) => o.corrected?.original.policy_ok === false && o.corrected.by[0] === 'sandbox-placeholders'));
  assert.equal(pilot.observations.filter((o) => o.corrected?.original.success).length, 0);
});

test('the published figures of every campaign are found again in the history', () => {
  const figures = (label: string) => {
    const c = byLabel(label);
    const ok = c.observations.filter((o) => o.status === 'ok');
    const bugs = ok.flatMap((o) => o.bugs);
    return [c.observations.filter((o) => o.success).length, bugs.filter((b) => b.detected).length, bugs.length];
  };
  // Successes, detected bugs and bugs, from eval/results.
  assert.deepEqual(figures('Pilot 2'), [22, 45, 51]);
  assert.deepEqual(figures('A'), [8, 26, 36]);
  assert.deepEqual(figures('B'), [14, 32, 36]);
  assert.deepEqual(figures('C'), [17, 36, 36]);
  assert.deepEqual(figures('C, regression check'), [27, 47, 51]);
  assert.deepEqual(figures('D'), [17, 36, 36]);
  assert.deepEqual(figures('D, regression check'), [29, 50, 51]);
  assert.deepEqual(figures('D, clean'), [18, 36, 36]);
  assert.deepEqual(figures('D, clean regression check'), [27, 50, 51]);
});

test('compatibility follows the versions: what the agent changed, and what blocks a comparison', () => {
  const ac = compatibility(byLabel('A'), byLabel('C'));
  assert.deepEqual(ac.blocking, []);
  assert.deepEqual(ac.agent_changes, ['writer prompt']);
  assert.deepEqual(ac.comparable_tickets, ['EVAL-11', 'EVAL-12', 'EVAL-13', 'EVAL-14', 'EVAL-15', 'EVAL-16']);
  assert.ok(ac.warnings.some((w) => w.startsWith('A: 18 trial(s) saw the corpus')));
  assert.deepEqual(compatibility(byLabel('Pilot'), byLabel('Pilot 2')).agent_changes, [], 'the same agent, measured twice');
  assert.ok(compatibility(byLabel('Pilot'), byLabel('Pilot 2')).warnings.some((w) => w.startsWith('the harness that ran the variants changed')));
  assert.ok(compatibility(byLabel('D, control trial'), byLabel('D')).blocking.some((b) => b.includes('control run')));
  const c = byLabel('C');
  const otherScorer: Campaign = { ...c, scoring: { ...c.scoring, scorer: 'something-else' } };
  assert.ok(compatibility(otherScorer, byLabel('D, clean')).blocking.some((b) => b.startsWith('different scoring code')));
  assert.deepEqual(compatibility(otherScorer, byLabel('D, clean')).comparable_tickets, []);
  const changedCorpus: Campaign = { ...c, environment: { ...c.environment, corpus: { ...c.environment.corpus, 'EVAL-13': 'changed' } } };
  const result = compatibility(changedCorpus, byLabel('D, clean'));
  assert.deepEqual(result.excluded_tickets, [{ ticket: 'EVAL-13', reason: 'its corpus changed' }]);
  assert.equal(result.comparable_tickets.length, 5);
});

test('duplicates and inconsistencies are errors; missing data is reported', () => {
  const d = byLabel('D, clean');
  const copy = (over: Partial<Campaign>): Campaign => ({ ...structuredClone(d), ...over });
  const problems = (cs: Campaign[]) => checkHistory(cs).filter((p) => p.level === 'error').map((p) => p.message);
  assert.ok(problems([d, d]).includes('campaign imported 2 times'));
  assert.ok(problems([d, copy({ id: 'gh-1' })]).some((m) => m.startsWith('same source file as')));
  assert.ok(problems([d, copy({ id: 'gh-1', provenance: { ...d.provenance, sha256: 'x' } })]).some((m) => m.includes('is the same trial as in gh-41605000003')));
  const twice = copy({ id: 'gh-2', provenance: { ...d.provenance, sha256: 'y' }, observations: [d.observations[0], d.observations[0]].map((o, i) => ({ ...o, fingerprint: `f${i}` })) });
  assert.ok(problems([twice]).includes(`duplicate observation ${d.observations[0].key}`));
  assert.ok(problems([twice]).includes('2 observations for 18 trials'));
  assert.ok(checkHistory([d]).some((p) => p.level === 'warning' && p.message === 'missing data: isolation_check 18/18'));
});

// A small campaign built from scores, as the report job does.
const run = (over: Partial<AgentRun> = {}): AgentRun => ({ exit_code: 0, verdict: 'ready', cost_usd: 0.1, duration_ms: 1000, num_turns: 5, is_error: false, spec_questions: 0, untestable: 0, ...over });
const record = (trial: number, over: Partial<TrialRecord> = {}): TrialRecord => ({
  schema_version: 2, ticket: 'EVAL-1', trial, kind: 'feature', criteria: ['AC-1'], started_at: `2026-11-04T10:0${trial}:00.000Z`, finished_at: `2026-11-04T10:0${trial}:30.000Z`,
  phase1: run({ tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 } }), changed_non_test_files: [], generated_test_files: ['e2e/EVAL-1.spec.ts'], bugs: [{ id: 'b1', criterion: 'AC-1' }],
  variants: {
    base: { ran: true, tests: [{ title: '[EVAL-1][AC-1] t', level: 'shell', criteria: ['AC-1'], status: 'fail' }] },
    gold: { ran: true, tests: [{ title: '[EVAL-1][AC-1] t', level: 'shell', criteria: ['AC-1'], status: 'pass' }] },
    bugs: { b1: { ran: true, tests: [{ title: '[EVAL-1][AC-1] t', level: 'shell', criteria: ['AC-1'], status: 'fail' }] } },
  },
  phase2: null, isolation: { scoring_sandbox: 'bwrap', findings: [] }, ...over,
});
const agent: AgentVersion = {
  id: 'a', commit: 'c', writer: { prompt: 'w'.repeat(40), model: 'sonnet', effort: 'medium' }, verifier: { prompt: 'v'.repeat(40), model: 'haiku', effort: 'low' },
  hooks: 'h', settings: 's', scripts: 'q', claude_code: '2.1.303',
};
const versions = { agent, environment: { corpus: { 'EVAL-1': 't' }, app: 'app', harness: 'h', harness_commit: 'c' } as Environment, scorer: 's' };
const input = (over: Partial<CampaignInput> = {}): CampaignInput => ({
  label: 'test', role: 'campaign', repository: 'o/r', run_id: 7, run_number: 1, branch: 'b', started_at: null, commit: 'c',
  scoring: { kind: 'original', commit: 'c', run_id: 7 }, corrections: [], provenance: { file: 'f', sha256: 'h', artifact: null, doc: null }, notes: [], ...over,
});

test('a campaign records the workflow inputs it was given, and infers the others', () => {
  const scores = [scoreTrial(record(1)), scoreTrial(record(2))];
  const given = buildCampaign(scores, input({ inputs: { trials: '2', verify: false, dry_run: false } }), versions);
  assert.deepEqual(given.config, { tickets: ['EVAL-1'], selection: null, trials: 2, trials_per_ticket: 2, trials_mode: 'uniform', verify: false, dry_run: false, inferred: [] });
  assert.equal(buildCampaign(scores, input({ inputs: { tickets: 'smoke' } }), versions).config.selection, 'smoke');
  assert.equal(buildCampaign(scores, input({ inputs: { tickets: 'EVAL-1 EVAL-2' } }), versions).config.selection, 'list');
  assert.equal(buildCampaign(scores, input({ inputs: { tickets: 'all' } }), versions).config.selection, 'all');
  assert.equal(given.observations[0].tokens?.cache_read, 3);
  assert.equal(given.observations[0].isolation_findings, 0);
  assert.deepEqual(given.missing, { guard_blocks: 2, corpus_check: 2, models: 2 });
  const inferred = buildCampaign(scores, input(), versions);
  assert.deepEqual(inferred.config.inferred, ['verify', 'dry_run', 'trials_per_ticket']);
  // A dry run is never a campaign to compare.
  assert.equal(buildCampaign([scoreTrial(record(1, { phase1: run({ cost_usd: 0 }) }))], input({ inputs: { dry_run: true } }), versions).role, 'dry-run');
  assert.throws(() => buildCampaign(scores, input({ corrections: ['unknown'] }), versions), /unknown correction/);
  const rows = flatten(given);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bug, 'b1');
  assert.equal(rows[0].tokens, 10);
});

test('a trial whose scoring runner sent nothing back is a scoring error, left out of comparisons', () => {
  // Run 31: GitHub never created four scoring jobs, and their trials were assembled without scores.
  const window = (m: number) => ({ started_at: `2026-11-04T10:0${m}:00.000Z`, finished_at: `2026-11-04T10:0${m}:30.000Z` });
  const split = (trial: number, scored: boolean) => record(trial, scored
    ? { runners: { agent: window(trial), score: window(trial + 1) } }
    : { runners: { agent: window(trial) }, variants: { bugs: {} }, isolation: undefined });
  const c = buildCampaign([scoreTrial(split(1, true)), scoreTrial(split(2, false))], input({ inputs: { trials: '2', verify: false, dry_run: false } }), versions);
  assert.deepEqual(c.observations.map((o) => o.status), ['ok', 'scoring_error']);
  assert.equal(c.observations[1].bugs[0].detected, false, 'nothing ran its tests against the bug');
  assert.ok(checkHistory([c]).some((p) => p.message === '1 trial(s) whose scoring runner sent nothing back: they measure the infrastructure'));
  // A trial run before the split has no runners: it is never flagged.
  assert.equal(buildCampaign([scoreTrial(record(1, { variants: { bugs: {} }, isolation: undefined }))], input(), versions).observations[0].status, 'ok');
  // The comparison leaves it out, counts it apart from agent errors, and says so.
  const reference = buildCampaign([scoreTrial(split(1, true)), scoreTrial(split(2, true))], input({ run_id: 8, provenance: { file: 'g', sha256: 'i', artifact: null, doc: null }, inputs: { trials: '2', verify: false, dry_run: false } }), versions);
  assert.ok(compatibility(reference, c).warnings.includes('test: 1 trial(s) whose scoring runner sent nothing back are left out'));
  const policy = JSON.parse(readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8')) as Policy;
  const result = compare({ label: 'ref', campaigns: [reference] }, { label: 'new', campaigns: [c] }, policy, JSON.stringify(policy));
  assert.equal(result.b.scoring_errors, 1);
  assert.equal(result.measurements.tickets[0].b.trials, 1);
  assert.ok(result.decision.reasons.some((r) => r.rule === 'b_agent_errors' && r.message === '1 of 2 trial(s) of new were lost to the infrastructure: 0 to an agent or API error, 1 to a scoring runner that sent nothing back'));
});

test('from-report turns the report job\'s output into a campaign file', { skip: !hasCommit(KIT, 'HEAD') && 'needs a git checkout' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-from-report-'));
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: KIT, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(work, 'report.json'), JSON.stringify({ campaign: { first_start: '2026-11-04T10:01:00.000Z' }, trials: [scoreTrial(record(1))] }));
    const env = { ...process.env, GITHUB_RUN_ID: '123', GITHUB_RUN_NUMBER: '9', GITHUB_SHA: head, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'o/r', EVAL_INPUTS: JSON.stringify({ tickets: 'EVAL-1', trials: '1', verify: false, dry_run: false, max_parallel: '6', recheck: '' }) };
    const cli = spawnSync(process.execPath, [join(KIT, 'eval/history.ts'), 'from-report', join(work, 'report.json'), join(work, 'out.json')], { encoding: 'utf8', env });
    assert.equal(cli.status, 0, cli.stderr);
    const c = JSON.parse(readFileSync(join(work, 'out.json'), 'utf8')) as Campaign;
    assert.equal(c.id, 'gh-123');
    assert.equal(c.scoring.kind, 'original');
    assert.equal(c.agent.commit, head);
    assert.deepEqual(c.config.inferred, []);
    assert.equal(c.agent.writer.model, 'sonnet');
    assert.ok(c.environment.corpus['EVAL-1']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
