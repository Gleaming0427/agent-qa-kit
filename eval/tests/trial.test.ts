import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildBundle, corpusFingerprints, publicTexts, scanForCorpus } from '../lib/isolation.ts';
import { APP, KIT, TICKETS, listTickets } from '../lib/workspace.ts';
import { scoreTrial } from '../lib/score.ts';
import type { AgentRun, TrialRecord } from '../lib/score.ts';

const node = (cwd: string, env: Record<string, string>, ...args: string[]) => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('EVAL_')));
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...clean, ...env } });
};

test('the agent steps run from the bundle, without the corpus, and send back nothing of it', { skip: !existsSync(join(APP, 'node_modules')) && 'needs npm ci in examples/shop' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-agent-side-'));
  try {
    const bundle = join(work, 'bundle');
    buildBundle(bundle, ['EVAL-1'], { kit: KIT, ticketsDir: TICKETS });
    // As npm ci would on the runner.
    symlinkSync(join(APP, 'node_modules'), join(bundle, 'examples/shop/node_modules'), 'dir');
    const env = { EVAL_IN_PLACE: '1', EVAL_DRY_RUN: '1', EVAL_WORK: join(work, 'runs'), EVAL_BUNDLE_VERIFIED: '1' };
    for (const args of [['eval/bundle.ts', 'verify'], ['eval/trial.ts', 'prepare', 'EVAL-1', '1'], ['eval/trial.ts', 'write', 'EVAL-1', '1']]) {
      const run = node(bundle, env, ...args);
      assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
    }
    assert.equal(existsSync(join(bundle, 'eval/tickets')), false);
    const agent = join(work, 'runs/EVAL-1-1/agent');
    const state = JSON.parse(readFileSync(join(agent, 'state.json'), 'utf8')) as Record<string, unknown>;
    // The kind of ticket and its bugs are the scoring runner's to know.
    assert.deepEqual(Object.keys(state).sort(), ['bundle_verified', 'changed_non_test_files', 'criteria', 'dry_run', 'finished_at', 'generated_test_files', 'phase1', 'sandbox_placeholders', 'started_at', 'ticket', 'trial']);
    assert.ok(Date.parse(state.finished_at as string) >= Date.parse(state.started_at as string));
    assert.deepEqual(state.criteria, ['AC-1', 'AC-2']);
    assert.ok(existsSync(join(agent, 'workspace.tar')));
    const fp = corpusFingerprints(TICKETS, publicTexts(APP, listTickets().map((t) => join(TICKETS, t, 'spec.md'))));
    assert.deepEqual(scanForCorpus(agent, fp), []);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

const agentRun = (over: Partial<AgentRun> = {}): AgentRun => ({ exit_code: 0, verdict: 'pass', cost_usd: 0.01, duration_ms: 1000, num_turns: 3, is_error: false, spec_questions: 0, untestable: 0, ...over });

test('finish assembles the three runners\' parts and gives phase 2 its roles back', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-finish-'));
  try {
    const root = join(work, 'EVAL-1-2');
    const write = (path: string, value: unknown) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value)); };
    write('agent/state.json', { ticket: 'EVAL-1', trial: 2, criteria: ['AC-1', 'AC-2'], started_at: '2026-11-03T10:00:00.000Z', finished_at: '2026-11-03T10:02:00.000Z', dry_run: false, bundle_verified: true, phase1: agentRun({ verdict: 'ready', tokens: { input: 1, output: 2, cache_read: 3, cache_creation: 4 } }), generated_test_files: ['e2e/EVAL-1.spec.ts'], changed_non_test_files: [], sandbox_placeholders: [] });
    write('agent/out/phase1.log', 'phase 1');
    write('score/score.json', {
      schema_version: 1, ticket: 'EVAL-1', kind: 'feature', bugs: [{ id: 'b1', criterion: 'AC-1' }], variants: { bugs: {} },
      // The verifier saw "impl-2" first here: roles come from the mapping, not from the order.
      implementations: { 'impl-2': 'gold', 'impl-1': { bug: 'b1' } },
      isolation: { scoring_sandbox: 'bwrap', findings: [], bundle_verified: true },
      // The scoring job starts once every agent job is done: this trial waited 8 minutes.
      started_at: '2026-11-03T10:10:00.000Z', finished_at: '2026-11-03T10:11:00.000Z',
    });
    write('verify/phase2.json', { runs: { 'impl-1': agentRun({ exit_code: 1, verdict: 'fail' }), 'impl-2': agentRun() }, started_at: '2026-11-03T10:20:00.000Z', finished_at: '2026-11-03T10:23:00.000Z' });
    write('verify/out/phase2-impl-1.log', 'bug run');
    write('verify/out/phase2-impl-2-run.json', '{}');
    write('verify/out/phase2-impl-1-subagents/a.jsonl', '');
    const run = node(KIT, { EVAL_WORK: work }, 'eval/trial.ts', 'finish', 'EVAL-1', '2');
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(readFileSync(join(root, 'trial/trial.json'), 'utf8')) as TrialRecord;
    assert.equal(record.schema_version, 2);
    assert.equal(record.kind, 'feature');
    assert.equal(record.phase2?.gold?.exit_code, 0);
    assert.equal(record.phase2?.bug?.exit_code, 1);
    assert.equal(record.phase2?.bug?.id, 'b1');
    assert.deepEqual(record.isolation, { scoring_sandbox: 'bwrap', findings: [], bundle_verified: true });
    // The trial ends with its last runner, not when the report job assembles it.
    assert.equal(record.started_at, '2026-11-03T10:00:00.000Z');
    assert.equal(record.finished_at, '2026-11-03T10:23:00.000Z');
    assert.deepEqual(Object.keys(record.runners ?? {}).sort(), ['agent', 'score', 'verify']);
    const s = scoreTrial(record);
    assert.deepEqual(s.runner_ms, { agent: 120_000, score: 60_000, verify: 180_000 });
    assert.equal(s.wall_clock_ms, 360_000, 'working time, without the 17 minutes spent waiting between runners');
    for (const file of ['phase1.log', 'phase2-bug.log', 'phase2-gold-run.json', 'phase2-bug-subagents/a.jsonl', 'score.json']) {
      assert.ok(existsSync(join(root, 'trial', file)), file);
    }
    assert.ok(!existsSync(join(root, 'trial/phase2-impl-1.log')));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a trial whose agent runner sent nothing back is recorded as an agent error', () => {
  const work = mkdtempSync(join(tmpdir(), 'eval-finish-empty-'));
  try {
    const run = node(KIT, { EVAL_WORK: work }, 'eval/trial.ts', 'finish', 'EVAL-1', '1');
    assert.equal(run.status, 0, run.stderr);
    const record = JSON.parse(readFileSync(join(work, 'EVAL-1-1/trial/trial.json'), 'utf8')) as TrialRecord;
    assert.equal(record.phase1.exit_code, 3);
    assert.equal(record.phase1.error, 'the agent runner sent nothing back');
    assert.equal(record.bugs.length, 2, 'the ticket metadata comes from the corpus on the report runner');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
