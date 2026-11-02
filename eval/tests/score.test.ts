import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregate, toMarkdown } from '../lib/aggregate.ts';
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
    ...[1, 2, 3].map((trial) => scoreTrial(record({ trial, phase1: run({ guard_blocks: trial - 1 }) }))),
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
  assert.deepEqual(report.guard_blocks, { total: 3, trials: 3, trials_with_blocks: 2, mean_per_trial: 1 });
  assert.match(toMarkdown(report), /pass\^3 50\.0%/);
  assert.match(toMarkdown(report), /3 refused action\(s\) in 3 phase 1 transcript\(s\)/);
});
