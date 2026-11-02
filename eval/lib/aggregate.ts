#!/usr/bin/env node
// Aggregates the scores of an evaluation campaign into a JSON report and a Markdown summary.
// Usage: node eval/lib/aggregate.ts <folder with trial.json files> <report.json> <report.md>
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrial } from './score.ts';
import type { TrialRecord, TrialScore, VerifierOutcome } from './score.ts';
import { clusteredStandardError, passAtK, passHatK, percentile, wilson } from './stats.ts';
import type { Proportion } from './stats.ts';

export interface Metric extends Proportion { clustered_se: number | null; unit: string }
export interface TicketRow {
  ticket: string;
  kind: string;
  trials: number;
  successes: number;
  pass_hat_k: number | null;
  red_valid: number;
  f2p: string;
  bugs_detected: string;
  false_positive_trials: number;
  mean_cost_usd: number;
}
export interface Report {
  schema_version: 1;
  generated_at: string;
  campaign: {
    trials: number;
    tickets: number;
    trials_per_ticket: number;
    first_start: string | null;
    last_finish: string | null;
    span_ms: number | null;
    effective_parallelism: number | null;
  };
  metrics: Record<string, Metric>;
  reliability: { k: number; pass_at_1: number | null; pass_at_k: number | null; pass_hat_k: number | null };
  cost_usd: { total: number; mean_per_trial: number | null; p50: number | null; p95: number | null };
  phase1_duration_s: { p50: number | null; p95: number | null; max: number | null };
  phase1_turns: { p50: number | null; p95: number | null };
  tickets: TicketRow[];
}

const round = (x: number | null, digits = 4) => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** A proportion over trial-level outcomes, with its Wilson interval and the standard error clustered by ticket. */
function trialMetric(scores: TrialScore[], pick: (s: TrialScore) => boolean | null, unit = 'trials'): Metric {
  const values = scores.flatMap((s) => {
    const v = pick(s);
    return v === null ? [] : [{ cluster: s.ticket, value: v ? 1 : 0 }];
  });
  const w = wilson(values.filter((v) => v.value === 1).length, values.length);
  return { ...w, clustered_se: round(clusteredStandardError(values)), unit };
}

/** A proportion over items inside trials (criteria, bugs), clustered by ticket. */
function itemMetric(scores: TrialScore[], items: (s: TrialScore) => boolean[], unit: string): Metric {
  const values = scores.flatMap((s) => items(s).map((ok) => ({ cluster: s.ticket, value: ok ? 1 : 0 })));
  const w = wilson(values.filter((v) => v.value === 1).length, values.length);
  return { ...w, clustered_se: round(clusteredStandardError(values)), unit };
}

const verifier = (o: VerifierOutcome) => (o === 'not_run' ? null : o === 'correct');

export function aggregate(scores: TrialScore[]): Report {
  const withTests = scores.filter((s) => s.kind !== 'ambiguous');
  const byTicket = new Map<string, TrialScore[]>();
  for (const s of scores) byTicket.set(s.ticket, [...(byTicket.get(s.ticket) ?? []), s]);
  const k = byTicket.size ? Math.min(...[...byTicket.values()].map((t) => t.length)) : 0;

  const ticketRows: TicketRow[] = [...byTicket.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([ticket, trials]) => {
    const f2p = trials.flatMap((t) => t.f2p);
    const bugs = trials.flatMap((t) => t.bugs);
    const successes = trials.filter((t) => t.success).length;
    return {
      ticket,
      kind: trials[0].kind,
      trials: trials.length,
      successes,
      pass_hat_k: round(passHatK(trials.length, successes, k)),
      red_valid: trials.filter((t) => t.red_valid).length,
      f2p: `${f2p.filter((u) => u.ok).length}/${f2p.length}`,
      bugs_detected: `${bugs.filter((b) => b.detected).length}/${bugs.length}`,
      false_positive_trials: trials.filter((t) => t.false_positives.length > 0).length,
      mean_cost_usd: round(mean(trials.map((t) => t.cost_usd))) ?? 0,
    };
  });

  const perTicket = [...byTicket.values()];
  const starts = scores.map((s) => Date.parse(s.started_at)).filter(Number.isFinite);
  const finishes = scores.map((s) => Date.parse(s.finished_at)).filter(Number.isFinite);
  const span = starts.length && finishes.length ? Math.max(...finishes) - Math.min(...starts) : null;
  const busy = scores.reduce((sum, s) => sum + (s.wall_clock_ms ?? 0), 0);
  const costs = scores.map((s) => s.cost_usd);
  const durations = scores.flatMap((s) => (s.phase1_duration_ms === null ? [] : [s.phase1_duration_ms / 1000]));
  const turns = scores.flatMap((s) => (s.phase1_turns === null ? [] : [s.phase1_turns]));

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    campaign: {
      trials: scores.length,
      tickets: byTicket.size,
      trials_per_ticket: k,
      first_start: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
      last_finish: finishes.length ? new Date(Math.max(...finishes)).toISOString() : null,
      span_ms: span,
      effective_parallelism: span ? round(busy / span, 2) : null,
    },
    metrics: {
      success: trialMetric(scores, (s) => s.success),
      red_valid: trialMetric(withTests, (s) => s.red_valid),
      no_false_positive: trialMetric(withTests, (s) => (s.has_tests ? s.false_positives.length === 0 : null)),
      no_flaky_test: trialMetric(withTests, (s) => (s.has_tests ? s.flaky.length === 0 : null)),
      fail_to_pass: itemMetric(withTests, (s) => s.f2p.map((u) => u.ok), 'criterion x level units'),
      bug_detection: itemMetric(withTests, (s) => s.bugs.map((b) => b.detected), 'injected bugs'),
      bug_attribution: itemMetric(withTests, (s) => s.bugs.filter((b) => b.detected).map((b) => b.attributed), 'detected bugs'),
      policy_ok: trialMetric(scores, (s) => s.policy_ok),
      asked_on_ambiguity: trialMetric(scores.filter((s) => s.kind === 'ambiguous'), (s) => s.asked_question),
      verifier_gold_correct: trialMetric(scores, (s) => verifier(s.verifier.gold), 'verifier runs on the correct implementation'),
      verifier_bug_correct: trialMetric(scores, (s) => verifier(s.verifier.bug), 'verifier runs on a buggy implementation'),
      verifier_bug_faithful: trialMetric(scores, (s) => verifier(s.verifier.bug_faithful), 'verifier runs on a buggy implementation'),
      agent_error: trialMetric(scores, (s) => s.agent_error),
    },
    reliability: {
      k,
      pass_at_1: round(mean(perTicket.map((t) => t.filter((s) => s.success).length / t.length))),
      pass_at_k: round(mean(perTicket.flatMap((t) => { const v = passAtK(t.length, t.filter((s) => s.success).length, k); return v === null ? [] : [v]; }))),
      pass_hat_k: round(mean(perTicket.flatMap((t) => { const v = passHatK(t.length, t.filter((s) => s.success).length, k); return v === null ? [] : [v]; }))),
    },
    cost_usd: {
      total: round(costs.reduce((a, b) => a + b, 0)) ?? 0,
      mean_per_trial: round(mean(costs)),
      p50: round(percentile(costs, 50)),
      p95: round(percentile(costs, 95)),
    },
    phase1_duration_s: { p50: round(percentile(durations, 50), 1), p95: round(percentile(durations, 95), 1), max: durations.length ? round(Math.max(...durations), 1) : null },
    phase1_turns: { p50: round(percentile(turns, 50), 1), p95: round(percentile(turns, 95), 1) },
    tickets: ticketRows,
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const LABELS: Record<string, string> = {
  success: 'Trial success',
  red_valid: 'Valid RED (phase 1 accepted by the kit)',
  no_false_positive: 'No generated test fails on the correct implementation',
  no_flaky_test: 'No flaky generated test (3 repeats)',
  fail_to_pass: 'Fail-to-pass coverage (criterion x level)',
  bug_detection: 'Injected bugs detected',
  bug_attribution: 'Detected bugs caught by a test of the right criterion',
  policy_ok: 'No file other than tests changed',
  asked_on_ambiguity: 'Asked instead of inventing (ambiguous ticket)',
  verifier_gold_correct: 'Verifier: pass on the correct implementation',
  verifier_bug_correct: 'Verifier: fail on a buggy implementation',
  verifier_bug_faithful: 'Verifier: verdict matches the approved tests',
  agent_error: 'Agent or API error (lower is better)',
};

export function toMarkdown(report: Report): string {
  const c = report.campaign;
  const lines = [
    '# Agent evaluation report',
    '',
    `${c.trials} trials on ${c.tickets} tickets (${c.trials_per_ticket} per ticket). Intervals are 95% Wilson intervals; "SE (clustered)" is the standard error clustered by ticket.`,
    '',
    '| Metric | Rate | 95% interval | n | SE (clustered) |',
    '|---|---|---|---|---|',
    ...Object.entries(report.metrics).map(([name, m]) =>
      `| ${LABELS[name] ?? name} | ${pct(m.rate)} | ${m.low === null ? 'n/a' : `${pct(m.low)} – ${pct(m.high)}`} | ${m.successes}/${m.n} ${m.unit} | ${m.clustered_se === null ? 'n/a' : pct(m.clustered_se)} |`),
    '',
    `**Reliability (trial success):** pass@1 ${pct(report.reliability.pass_at_1)}, pass@${report.reliability.k} ${pct(report.reliability.pass_at_k)}, pass^${report.reliability.k} ${pct(report.reliability.pass_hat_k)}.`,
    '',
    `**Cost:** $${report.cost_usd.total.toFixed(4)} in total, $${report.cost_usd.mean_per_trial?.toFixed(4) ?? 'n/a'} per trial (p50 $${report.cost_usd.p50?.toFixed(4) ?? 'n/a'}, p95 $${report.cost_usd.p95?.toFixed(4) ?? 'n/a'}), as reported by the Claude CLI.`,
    '',
    `**Phase 1 duration:** p50 ${report.phase1_duration_s.p50 ?? 'n/a'} s, p95 ${report.phase1_duration_s.p95 ?? 'n/a'} s, max ${report.phase1_duration_s.max ?? 'n/a'} s. Turns: p50 ${report.phase1_turns.p50 ?? 'n/a'}, p95 ${report.phase1_turns.p95 ?? 'n/a'}.`,
    '',
    `**Load:** campaign span ${c.span_ms === null ? 'n/a' : `${(c.span_ms / 60000).toFixed(1)} min`}, effective parallelism ${c.effective_parallelism ?? 'n/a'}.`,
    '',
    '| Ticket | Kind | Trials | Successes | pass^k | Valid RED | Fail-to-pass | Bugs detected | Trials with false positives | Mean cost |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...report.tickets.map((t) => `| ${t.ticket} | ${t.kind} | ${t.trials} | ${t.successes} | ${pct(t.pass_hat_k)} | ${t.red_valid} | ${t.f2p} | ${t.bugs_detected} | ${t.false_positive_trials} | $${t.mean_cost_usd.toFixed(4)} |`),
    '',
  ];
  return lines.join('\n');
}

function findTrials(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...findTrials(path));
    else if (name === 'trial.json') found.push(path);
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, jsonOut, mdOut] = process.argv.slice(2);
  if (!dir || !jsonOut || !mdOut) {
    console.error('usage: node eval/lib/aggregate.ts <folder with trial.json files> <report.json> <report.md>');
    process.exit(2);
  }
  const scores = findTrials(dir).map((file) => scoreTrial(JSON.parse(readFileSync(file, 'utf8')) as TrialRecord));
  if (!scores.length) {
    console.error(`No trial.json found under ${dir}`);
    process.exit(1);
  }
  const report = aggregate(scores);
  writeFileSync(jsonOut, `${JSON.stringify({ ...report, trials: scores }, null, 2)}\n`);
  writeFileSync(mdOut, toMarkdown(report));
  console.log(toMarkdown(report));
}
