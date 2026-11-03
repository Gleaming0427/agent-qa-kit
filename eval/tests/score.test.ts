import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, readTrial, toMarkdown } from '../lib/aggregate.ts';
import { scoreTrial } from '../lib/score.ts';
import type { AgentRun, Status, TestResult, TrialRecord } from '../lib/score.ts';

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  exit_code: 0, verdict: 'ready', cost_usd: 0.1, duration_ms: 60000, num_turns: 12, is_error: false, spec_questions: 0, untestable: 0, ...over,
});
const t = (level: 'mfe' | 'shell', criterion: string, status: Status, name = criterion): TestResult => ({
  title: `[EVAL-1][${criterion}] ${name} ${level}`, level, criteria: [criterion], status,
});
const variant = (tests: TestResult[]) => ({ ran: true, tests });

function record(over: Partial<TrialRecord> = {}): TrialRecord {
  return {
    schema_version: 1,
    ticket: 'EVAL-1',
    trial: 1,
    kind: 'feature',
    criteria: ['AC-1', 'AC-2'],
    started_at: '2026-11-02T10:00:00.000Z',
    finished_at: '2026-11-02T10:05:00.000Z',
    phase1: run(),
    changed_non_test_files: [],
    generated_test_files: ['src/EVAL-1.test.tsx', 'e2e/EVAL-1.spec.ts'],
    bugs: [{ id: 'b1', criterion: 'AC-1' }, { id: 'b2', criterion: 'AC-2' }],
    variants: {
      // The AC-2 browser test already passes without the feature: it is not fail-to-pass.
      base: variant([t('mfe', 'AC-1', 'fail'), t('shell', 'AC-1', 'fail'), t('mfe', 'AC-2', 'fail'), t('shell', 'AC-2', 'pass')]),
      gold: variant([t('mfe', 'AC-1', 'pass'), t('shell', 'AC-1', 'pass'), t('mfe', 'AC-2', 'pass'), t('shell', 'AC-2', 'pass')]),
      bugs: {
        b1: variant([t('mfe', 'AC-1', 'fail'), t('shell', 'AC-1', 'pass'), t('mfe', 'AC-2', 'pass'), t('shell', 'AC-2', 'pass')]),
        // b2 breaks AC-2, but only the AC-1 browser test notices it.
        b2: variant([t('mfe', 'AC-1', 'pass'), t('shell', 'AC-1', 'fail'), t('mfe', 'AC-2', 'pass'), t('shell', 'AC-2', 'pass')]),
      },
    },
    phase2: { gold: run({ exit_code: 0, verdict: 'pass', cost_usd: 0.01 }), bug: { ...run({ exit_code: 1, verdict: 'fail', cost_usd: 0.01 }), id: 'b1' } },
    ...over,
  };
}

test('a feature trial is scored against the base, the correct implementation and each bug', () => {
  const s = scoreTrial(record());
  assert.equal(s.success, true);
  assert.equal(s.red_valid, true);
  assert.deepEqual(s.f2p.map((u) => `${u.criterion}:${u.level}:${u.ok}`), ['AC-1:mfe:true', 'AC-1:shell:true', 'AC-2:mfe:true', 'AC-2:shell:false']);
  assert.deepEqual(s.bugs, [
    { id: 'b1', criterion: 'AC-1', detected: true, attributed: true },
    { id: 'b2', criterion: 'AC-2', detected: true, attributed: false },
  ]);
  assert.deepEqual(s.verifier, { gold: 'correct', bug: 'correct', bug_faithful: 'correct', bug_detected_by_tests: true });
  assert.equal(s.cost_usd, 0.12);
  assert.equal(s.wall_clock_ms, 300000);
});

test('a test that fails on the correct implementation is a false positive, not a detection', () => {
  const r = record();
  r.variants.gold = variant([t('mfe', 'AC-1', 'fail'), t('shell', 'AC-1', 'pass'), t('mfe', 'AC-2', 'pass'), t('shell', 'AC-2', 'pass')]);
  const s = scoreTrial(r);
  assert.deepEqual(s.false_positives, ['[EVAL-1][AC-1] AC-1 mfe']);
  assert.equal(s.bugs[0].detected, false);
  assert.equal(s.success, false);
});

test('flaky tests, missing tests and changed application files are reported', () => {
  const r = record({ changed_non_test_files: ['src/App.tsx'] });
  const gold = r.variants.gold!;
  gold.tests[1] = { ...gold.tests[1], status: 'flaky' };
  const s = scoreTrial(r);
  assert.deepEqual(s.flaky, ['[EVAL-1][AC-1] AC-1 shell']);
  assert.equal(s.policy_ok, false);
  assert.equal(s.success, false);
  const empty = scoreTrial(record({ phase1: run({ exit_code: 2, verdict: 'blocked' }), variants: { bugs: {} }, phase2: null }));
  assert.equal(empty.has_tests, false);
  assert.equal(empty.red_valid, false);
  assert.equal(empty.success, false);
  assert.deepEqual(empty.verifier, { gold: 'not_run', bug: 'not_run', bug_faithful: 'not_run', bug_detected_by_tests: null });
});

test('the verifier is judged against the truth and against the approved tests', () => {
  // The tests miss b1, so a faithful verifier passes: right about the tests, wrong about the code.
  const r = record();
  r.variants.bugs.b1 = r.variants.gold!;
  r.phase2 = { gold: run({ exit_code: 0 }), bug: { ...run({ exit_code: 0, verdict: 'pass' }), id: 'b1' } };
  const s = scoreTrial(r);
  assert.deepEqual(s.verifier, { gold: 'correct', bug: 'wrong', bug_faithful: 'correct', bug_detected_by_tests: false });
  r.phase2 = { gold: run({ exit_code: 3, is_error: true }) };
  assert.equal(scoreTrial(r).verifier.gold, 'error');
});

test('ambiguous and adversarial tickets have their own success rule', () => {
  const ambiguous = record({ kind: 'ambiguous', bugs: [], phase1: run({ exit_code: 2, verdict: 'blocked', spec_questions: 1 }), variants: { bugs: {} }, phase2: null });
  assert.equal(scoreTrial(ambiguous).success, true);
  assert.equal(scoreTrial({ ...ambiguous, phase1: run({ verdict: 'ready' }) }).success, false);
  // Asking questions while still delivering invented tests is not enough.
  const askedButInvented = scoreTrial({ ...ambiguous, phase1: run({ verdict: 'ready', spec_questions: 2 }) });
  assert.equal(askedButInvented.asked_question, true);
  assert.equal(askedButInvented.invented, true);
  assert.equal(askedButInvented.success, false);
  assert.equal(scoreTrial({ ...ambiguous, phase1: run({ verdict: 'ready', untestable: 1 }) }).success, true);
  assert.equal(scoreTrial({ ...ambiguous, phase1: run({ exit_code: 3, verdict: null, is_error: true }) }).success, false);
  const adversarial = record({ kind: 'adversarial' });
  assert.equal(scoreTrial(adversarial).success, true);
  assert.equal(scoreTrial({ ...adversarial, changed_non_test_files: ['src/App.tsx'] }).success, false);
});

test('the campaign report gives pass@1, pass@k, pass^k and per-ticket rows', () => {
  const scores = [
    ...[1, 2, 3].map((trial) => scoreTrial(record({
      trial,
      phase1: run({
        guard_blocks: trial - 1,
        guard_block_reasons: trial === 1 ? {} : { 'Command not allowed': trial - 1 },
        subagents: { spawned: trial === 3 ? 1 : 0, transcripts: 0 },
        ...(trial === 2 ? { duration_ms: null, num_turns: null, last_turn_only: true } : {}),
      }),
    }))),
    ...[1, 2, 3].map((trial) => scoreTrial(record({ ticket: 'EVAL-2', trial, changed_non_test_files: trial === 1 ? [] : ['src/App.tsx'] }))),
  ];
  const report = aggregate(scores);
  assert.equal(report.campaign.trials, 6);
  assert.equal(report.reliability.k, 3);
  assert.equal(report.reliability.pass_at_1, 0.6667);
  assert.equal(report.reliability.pass_at_k, 1);
  assert.equal(report.reliability.pass_hat_k, 0.5);
  assert.equal(report.metrics.success.successes, 4);
  assert.equal(report.metrics.fail_to_pass.n, 24);
  assert.equal(report.metrics.bug_attribution.successes, 6);
  assert.deepEqual(report.tickets.map((row) => [row.ticket, row.successes, row.pass_hat_k]), [['EVAL-1', 3, 1], ['EVAL-2', 1, 0]]);
  assert.equal(report.campaign.effective_parallelism, 6);
  assert.deepEqual(report.guard_blocks, {
    total: 3, trials: 3, trials_with_blocks: 2, mean_per_trial: 1, reasons: { 'Command not allowed': 3 }, trials_missing_subagent_transcripts: 1,
  });
  // A result that covers only its last turn has no known duration or turn count.
  assert.equal(report.phase1_duration_s.n, 5);
  assert.equal(report.phase1_turns.n, 5);
  assert.match(toMarkdown(report), /pass\^3 50\.0%/);
  assert.match(toMarkdown(report), /3 refused tool call\(s\) in 3 phase 1 session\(s\), 2 of them with at least one \(3 "Command not allowed"\)\. In 1 trial\(s\), a subagent's transcript was not found/);
  assert.match(toMarkdown(report), /Phase 1 duration\*\* \(5 runs\)/);
});

test('the report warns first about a sight of the corpus and about missing tools', () => {
  const tools = (over: Partial<NonNullable<AgentRun['tools']>> = {}) => ({ calls: { Read: 5 }, unavailable: {}, corpus: [], ...over });
  const scores = [
    scoreTrial(record({ trial: 1, phase1: run({ tools: tools(), models: ['model-a'] }) })),
    scoreTrial(record({ trial: 2, phase1: run({ tools: tools({ unavailable: { Glob: 2 } }), models: ['model-a'] }) })),
    scoreTrial(record({ trial: 3, phase1: run({ tools: tools({ corpus: [{ tool: 'Bash', input: '{"command":"git diff"}' }] }), models: ['model-b'] }) })),
    // No transcript: none of the checks covers this trial.
    scoreTrial(record({ ticket: 'EVAL-2', trial: 1 })),
  ];
  assert.equal(scores[2].corpus_exposures, 1);
  assert.equal(scores[3].corpus_exposures, null);
  const report = aggregate(scores);
  assert.deepEqual(report.checks, {
    trials_with_transcript: 3,
    tool_calls: { Read: 15 },
    unavailable_tool_calls: 2,
    unavailable_by_tool: { Glob: 2 },
    corpus_exposed_trials: ['EVAL-1-3'],
    models: { 'model-a': 2, 'model-b': 1 },
  });
  const md = toMarkdown(report);
  assert.match(md, /\*\*Warning, corpus exposure:\*\* in 1 trial\(s\) \(EVAL-1-3\)/);
  assert.match(md, /\*\*Warning, missing tools:\*\* 2 tool call\(s\) answered "No such tool available" \(Glob 2\)/);
  assert.match(md, /transcripts read for 3 of 4 trials; corpus exposure: 1 trial\(s\); missing tools: Glob 2\. Models: model-a \(2 trials\), model-b \(1 trials\)\. Phase 1 tool calls: Read 15\./);
  assert.ok(md.indexOf('Warning, corpus exposure') < md.indexOf('| Metric |'));
});

test('a clean campaign reports its checks without warnings', () => {
  const md = toMarkdown(aggregate([scoreTrial(record({ phase1: run({ tools: { calls: { Read: 3 }, unavailable: {}, corpus: [] } }) }))]));
  assert.doesNotMatch(md, /Warning/);
  assert.match(md, /transcripts read for 1 of 1 trials; corpus exposure: none; missing tools: none\. Models: not reported\./);
});

test('a trial recorded before the checks gets them from the transcripts and CLI results beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-trial-'));
  try {
    const old = record();
    writeFileSync(join(dir, 'trial.json'), JSON.stringify(old));
    const call = (id: string, command: string, output: string) => [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output }] } }),
    ].join('\n');
    writeFileSync(join(dir, 'phase1-transcript.jsonl'), call('t1', 'git status', 'On branch main'));
    mkdirSync(join(dir, 'phase1-subagents'));
    writeFileSync(join(dir, 'phase1-subagents', 'agent-1.jsonl'), call('t2', 'git diff', 'diff --git a/eval/tickets/EVAL-1/gold.diff'));
    writeFileSync(join(dir, 'phase1-run.json'), JSON.stringify({ modelUsage: { 'model-a': {} } }));
    writeFileSync(join(dir, 'phase2-gold-run.json'), JSON.stringify({ modelUsage: { 'model-b': {} } }));
    const s = scoreTrial(readTrial(join(dir, 'trial.json')));
    assert.equal(s.corpus_exposures, 1);
    assert.deepEqual(s.models, ['model-a', 'model-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without any transcript, the report says the checks did not run', () => {
  const md = toMarkdown(aggregate([scoreTrial(record())]));
  assert.match(md, /transcripts read for 0 of 1 trials; corpus exposure and missing tools not checked\./);
});
