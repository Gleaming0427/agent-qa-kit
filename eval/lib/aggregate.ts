#!/usr/bin/env node
// Aggregates the scores of an evaluation campaign into a JSON report and a Markdown summary.
// Usage: node eval/lib/aggregate.ts <folder with trial.json files> <report.json> <report.md>
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrial, tokensFromModelUsage } from './score.ts';
import type { RunnerName, TrialRecord, TrialScore, VerifierOutcome } from './score.ts';
import { clusteredStandardError, passAtK, passHatK, percentile, wilson } from './stats.ts';
import { toolHealth } from './transcript.ts';
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
    /**
     * The trials' working time divided by the span: how many trial steps ran at once on average.
     * Working time leaves out each runner's installs and, with separate runners, the wait between them.
     */
    effective_parallelism: number | null;
  };
  /** Working time per runner, in seconds, over the trials run on separate runners (n of them). */
  runner_time_s: Record<RunnerName, { n: number; total: number; p50: number | null; p95: number | null }>;
  metrics: Record<string, Metric>;
  reliability: { k: number; pass_at_1: number | null; pass_at_k: number | null; pass_hat_k: number | null };
  cost_usd: { total: number; mean_per_trial: number | null; p50: number | null; p95: number | null };
  /** Tokens of phases 1 and 2, over the trials whose CLI results report them (n). */
  tokens: { n: number; input: number; output: number; cache_read: number; cache_creation: number; mean_total_per_trial: number | null };
  /** n: runs with a known duration (or turn count); a CLI result that covers only its last turn has neither. */
  phase1_duration_s: { n: number; p50: number | null; p95: number | null; max: number | null };
  phase1_turns: { n: number; p50: number | null; p95: number | null };
  guard_blocks: {
    total: number;
    trials: number;
    trials_with_blocks: number;
    mean_per_trial: number | null;
    reasons: Record<string, number>;
    /** Trials with a subagent whose transcript was not found: their count is a lower bound. */
    trials_missing_subagent_transcripts: number;
  };
  /** What only the transcripts show. Each check covers the trials whose phase 1 transcript was read. */
  checks: {
    trials_with_transcript: number;
    /** Phase 1 tool calls by tool, over those trials. */
    tool_calls: Record<string, number>;
    /** Tool calls answered "No such tool available": the agents ran without these tools. */
    unavailable_tool_calls: number;
    unavailable_by_tool: Record<string, number>;
    /** Trials where a tool call or the session's own context named the corpus: their scores may not measure the agent. */
    corpus_exposed_trials: string[];
    /** The first two such calls of each of those trials. */
    corpus_examples: { trial: string; tool: string; input: string }[];
    /** Trials served by each model, phases 1 and 2, as the CLI reports them. */
    models: Record<string, number>;
    /** Trials scored with the agent, the scoring and the verifier on separate runners (schema 2). */
    split_runner_trials: number;
    /** How their generated tests ran during scoring: in the sandbox (bwrap) or directly (off). */
    scoring_sandbox: Record<string, number>;
    /** Trials whose agent runner sent back a trace of the corpus (a copied file, a file named after a bug). */
    isolation_flagged_trials: string[];
  };
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
  const runnerTime = (name: RunnerName) => {
    const values = scores.flatMap((s) => (s.runner_ms?.[name] === undefined ? [] : [s.runner_ms[name] / 1000]));
    return { n: values.length, total: round(values.reduce((a, b) => a + b, 0), 1) ?? 0, p50: round(percentile(values, 50), 1), p95: round(percentile(values, 95), 1) };
  };
  const costs = scores.map((s) => s.cost_usd);
  const durations = scores.flatMap((s) => (s.phase1_duration_ms === null ? [] : [s.phase1_duration_ms / 1000]));
  const turns = scores.flatMap((s) => (s.phase1_turns === null ? [] : [s.phase1_turns]));
  const blocks = scores.flatMap((s) => (s.guard_blocks === null ? [] : [s.guard_blocks]));
  const reasons: Record<string, number> = {};
  for (const s of scores) for (const [reason, count] of Object.entries(s.guard_block_reasons ?? {})) reasons[reason] = (reasons[reason] ?? 0) + count;
  const calls: Record<string, number> = {};
  for (const s of scores) for (const [tool, count] of Object.entries(s.tool_calls ?? {})) calls[tool] = (calls[tool] ?? 0) + count;
  const unavailable: Record<string, number> = {};
  for (const s of scores) for (const [tool, count] of Object.entries(s.unavailable_tools ?? {})) unavailable[tool] = (unavailable[tool] ?? 0) + count;
  const models: Record<string, number> = {};
  for (const s of scores) for (const model of s.models) models[model] = (models[model] ?? 0) + 1;
  const sandbox: Record<string, number> = {};
  for (const s of scores) if (s.scoring_sandbox) sandbox[s.scoring_sandbox] = (sandbox[s.scoring_sandbox] ?? 0) + 1;
  const withTokens = scores.flatMap((s) => (s.tokens ? [s.tokens] : []));
  const tokenSum = (k: 'input' | 'output' | 'cache_read' | 'cache_creation') => withTokens.reduce((a, t) => a + t[k], 0);

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
      no_invention_on_ambiguity: trialMetric(scores.filter((s) => s.kind === 'ambiguous'), (s) => s.success),
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
    tokens: {
      n: withTokens.length, input: tokenSum('input'), output: tokenSum('output'), cache_read: tokenSum('cache_read'), cache_creation: tokenSum('cache_creation'),
      mean_total_per_trial: withTokens.length ? Math.round(withTokens.reduce((a, t) => a + t.input + t.output + t.cache_read + t.cache_creation, 0) / withTokens.length) : null,
    },
    runner_time_s: { agent: runnerTime('agent'), score: runnerTime('score'), verify: runnerTime('verify') },
    phase1_duration_s: { n: durations.length, p50: round(percentile(durations, 50), 1), p95: round(percentile(durations, 95), 1), max: durations.length ? round(Math.max(...durations), 1) : null },
    phase1_turns: { n: turns.length, p50: round(percentile(turns, 50), 1), p95: round(percentile(turns, 95), 1) },
    guard_blocks: {
      total: blocks.reduce((a, b) => a + b, 0),
      trials: blocks.length,
      trials_with_blocks: blocks.filter((b) => b > 0).length,
      mean_per_trial: round(mean(blocks), 2),
      reasons: reasons,
      trials_missing_subagent_transcripts: scores.filter((s) => (s.subagents_without_transcript ?? 0) > 0).length,
    },
    checks: {
      trials_with_transcript: scores.filter((s) => s.corpus_exposures !== null).length,
      tool_calls: calls,
      unavailable_tool_calls: Object.values(unavailable).reduce((a, b) => a + b, 0),
      unavailable_by_tool: unavailable,
      corpus_exposed_trials: scores.filter((s) => (s.corpus_exposures ?? 0) + (s.corpus_in_context ?? 0) > 0).map((s) => `${s.ticket}-${s.trial}`)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      corpus_examples: scores.flatMap((s) => s.corpus_calls.slice(0, 2).map((call) => ({ trial: `${s.ticket}-${s.trial}`, ...call })))
        .sort((a, b) => a.trial.localeCompare(b.trial, 'en', { numeric: true })),
      models,
      split_runner_trials: scores.filter((s) => s.isolation_findings !== null).length,
      scoring_sandbox: sandbox,
      isolation_flagged_trials: scores.filter((s) => (s.isolation_findings ?? 0) > 0).map((s) => `${s.ticket}-${s.trial}`)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    },
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
  no_invention_on_ambiguity: 'No invented tests on the ambiguous ticket (blocked or untestable)',
  verifier_gold_correct: 'Verifier: pass on the correct implementation',
  verifier_bug_correct: 'Verifier: fail on a buggy implementation',
  verifier_bug_faithful: 'Verifier: verdict matches the approved tests',
  agent_error: 'Agent or API error (lower is better)',
};

function guardLine(g: Report['guard_blocks']): string {
  const reasons = Object.entries(g.reasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${count} "${reason}"`).join(', ');
  return `**Guard hook:** ${g.total} refused tool call(s) in ${g.trials} phase 1 session(s), ${g.trials_with_blocks} of them with at least one${reasons ? ` (${reasons})` : ''}.`
    + (g.trials_missing_subagent_transcripts ? ` In ${g.trials_missing_subagent_transcripts} trial(s), a subagent's transcript was not found: their count is a lower bound.` : '')
    + ' A refusal is the guard doing its job; the count shows how often the agent tried something outside its rules.';
}

/** Working time per runner, when the trials ran on separate runners. */
function runnerLine(t: Report['runner_time_s']): string {
  const parts = (['agent', 'score', 'verify'] as const).filter((name) => t[name].n)
    .map((name) => `${name} ${t[name].n} run(s), p50 ${t[name].p50} s, p95 ${t[name].p95} s, ${t[name].total} s in all`);
  return parts.length ? ` Working time by runner: ${parts.join('; ')}.` : '';
}

const counts = (byName: Record<string, number>) => Object.entries(byName).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(', ');

/** Warnings first, then one line on what the transcripts were checked for. */
function checkLines(k: Report['checks'], trials: number): string[] {
  const warnings = [
    ...(k.isolation_flagged_trials.length
      ? [`**Warning, corpus in the agent's output:** in ${k.isolation_flagged_trials.length} trial(s) (${k.isolation_flagged_trials.join(', ')}), what the agent's runner sent back holds a copy of a corpus file or a file named after a bug. Their scores do not measure the agent: read score.json.`]
      : []),
    ...(k.split_runner_trials && (k.scoring_sandbox.off ?? 0) > 0
      ? [`**Warning, scoring without the sandbox:** ${k.scoring_sandbox.off} trial(s) ran their generated tests outside the sandbox (EVAL_SANDBOX=off).`]
      : []),
    ...(k.corpus_exposed_trials.length
      ? [[`**Warning, corpus exposure:** in ${k.corpus_exposed_trials.length} trial(s) (${k.corpus_exposed_trials.join(', ')}), a tool call or the session's own context named the corpus. Their scores may not measure the agent: read those transcripts.`, '',
        ...k.corpus_examples.map((c) => `- ${c.trial}: ${c.tool} \`${c.input.replace(/[`\n\r|]/g, ' ')}\``)].join('\n')]
      : []),
    ...(k.unavailable_tool_calls
      ? [`**Warning, missing tools:** ${k.unavailable_tool_calls} tool call(s) answered "No such tool available" (${counts(k.unavailable_by_tool)}). The agents ran without these tools.`]
      : []),
  ];
  const models = Object.keys(k.models).length ? Object.entries(k.models).map(([m, n]) => `${m} (${n} trials)`).join(', ') : 'not reported';
  const found = k.trials_with_transcript
    ? `corpus exposure: ${k.corpus_exposed_trials.length ? `${k.corpus_exposed_trials.length} trial(s)` : 'none'}; missing tools: ${k.unavailable_tool_calls ? counts(k.unavailable_by_tool) : 'none'}`
    : 'corpus exposure and missing tools not checked';
  const tools = Object.keys(k.tool_calls).length ? ` Phase 1 tool calls: ${counts(k.tool_calls)}.` : '';
  const isolation = k.split_runner_trials
    ? ` Isolation: ${k.split_runner_trials} of ${trials} trials ran the agent, the scoring and the verifier on separate runners; generated tests scored ${Object.entries(k.scoring_sandbox).map(([mode, n]) => `${n} ${mode === 'bwrap' ? 'in the sandbox' : 'without it'}`).join(', ') || 'in none'}; corpus in the agent's output: ${k.isolation_flagged_trials.length ? `${k.isolation_flagged_trials.length} trial(s)` : 'none'}.`
    : ` Isolation: the trials ran before the agent and the scoring had separate runners.`;
  const summary = `**Checks:** transcripts read for ${k.trials_with_transcript} of ${trials} trials; ${found}. Models: ${models}.${tools}${isolation}`;
  return [...warnings.flatMap((w) => [w, '']), summary, ''];
}

export function toMarkdown(report: Report): string {
  const c = report.campaign;
  const lines = [
    '# Agent evaluation report',
    '',
    `${c.trials} trials on ${c.tickets} tickets (${c.trials_per_ticket} per ticket). Intervals are 95% Wilson intervals; "SE (clustered)" is the standard error clustered by ticket.`,
    '',
    ...checkLines(report.checks, c.trials),
    '| Metric | Rate | 95% interval | n | SE (clustered) |',
    '|---|---|---|---|---|',
    ...Object.entries(report.metrics).map(([name, m]) =>
      `| ${LABELS[name] ?? name} | ${pct(m.rate)} | ${m.low === null ? 'n/a' : `${pct(m.low)} – ${pct(m.high)}`} | ${m.successes}/${m.n} ${m.unit} | ${m.clustered_se === null ? 'n/a' : pct(m.clustered_se)} |`),
    '',
    report.reliability.k > 1
      ? `**Reliability (trial success):** pass@1 ${pct(report.reliability.pass_at_1)}, pass@${report.reliability.k} ${pct(report.reliability.pass_at_k)}, pass^${report.reliability.k} ${pct(report.reliability.pass_hat_k)}.`
      : `**Reliability (trial success):** pass@1 ${pct(report.reliability.pass_at_1)} (one trial per ticket: pass^k needs more).`,
    '',
    guardLine(report.guard_blocks),
    '',
    `**Cost:** $${report.cost_usd.total.toFixed(4)} in total, $${report.cost_usd.mean_per_trial?.toFixed(4) ?? 'n/a'} per trial (p50 $${report.cost_usd.p50?.toFixed(4) ?? 'n/a'}, p95 $${report.cost_usd.p95?.toFixed(4) ?? 'n/a'}), as reported by the Claude CLI.`,
    '',
    report.tokens.n
      ? `**Tokens** (${report.tokens.n} trials, phases 1 and 2): ${report.tokens.input} input, ${report.tokens.output} output, ${report.tokens.cache_read} cache read, ${report.tokens.cache_creation} cache write; ${report.tokens.mean_total_per_trial} in all per trial, as reported by the Claude CLI.`
      : '**Tokens:** not reported for these trials.',
    '',
    `**Phase 1 duration** (${report.phase1_duration_s.n} runs): p50 ${report.phase1_duration_s.p50 ?? 'n/a'} s, p95 ${report.phase1_duration_s.p95 ?? 'n/a'} s, max ${report.phase1_duration_s.max ?? 'n/a'} s. Turns (${report.phase1_turns.n} runs): p50 ${report.phase1_turns.p50 ?? 'n/a'}, p95 ${report.phase1_turns.p95 ?? 'n/a'}.`,
    '',
    `**Load:** campaign span ${c.span_ms === null ? 'n/a' : `${(c.span_ms / 60000).toFixed(1)} min`}, effective parallelism ${c.effective_parallelism ?? 'n/a'} (the trials' working time over the span; installs left out).`
      + runnerLine(report.runner_time_s),
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

/**
 * Reads a trial.json. A trial recorded before the transcript checks existed, or before one of them,
 * gets them from the files its artifact keeps beside it: the transcripts and the CLI's JSON results.
 */
export function readTrial(file: string): TrialRecord {
  const record = JSON.parse(readFileSync(file, 'utf8')) as TrialRecord;
  const dir = dirname(file);
  const main = join(dir, 'phase1-transcript.jsonl');
  const transcripts = (label: string) => {
    const sub = join(dir, `${label}-subagents`);
    const files = [join(dir, `${label}-transcript.jsonl`), ...(existsSync(sub) ? readdirSync(sub).filter((f) => f.endsWith('.jsonl')).map((f) => join(sub, f)) : [])];
    return toolHealth(files.map((f) => readFileSync(f, 'utf8')));
  };
  // A record from before a check was added (tools missing, or without context) is checked again.
  const stale = (tools: unknown) => !tools || (tools as { context?: unknown }).context === undefined;
  if (stale(record.phase1.tools) && existsSync(main)) record.phase1.tools = transcripts('phase1');
  for (const [label, run] of [['phase2-gold', record.phase2?.gold], ['phase2-bug', record.phase2?.bug]] as const) {
    if (run && stale(run.tools) && existsSync(join(dir, `${label}-transcript.jsonl`))) run.tools = transcripts(label);
  }
  const models = (label: string) => {
    const path = join(dir, `${label}-run.json`);
    if (!existsSync(path)) return [];
    try {
      const usage = (JSON.parse(readFileSync(path, 'utf8')) as { modelUsage?: unknown }).modelUsage;
      return usage && typeof usage === 'object' ? Object.keys(usage).sort() : [];
    } catch { return []; }
  };
  const tokens = (label: string) => {
    try { return tokensFromModelUsage((JSON.parse(readFileSync(join(dir, `${label}-run.json`), 'utf8')) as { modelUsage?: unknown }).modelUsage); } catch { return null; }
  };
  for (const [label, run] of [['phase1', record.phase1], ['phase2-gold', record.phase2?.gold], ['phase2-bug', record.phase2?.bug]] as const) {
    if (run && !run.tokens) { const t = tokens(label); if (t) run.tokens = t; }
  }
  if (!record.phase1.models) record.phase1.models = models('phase1');
  if (record.phase2?.gold && !record.phase2.gold.models) record.phase2.gold.models = models('phase2-gold');
  if (record.phase2?.bug && !record.phase2.bug.models) record.phase2.bug.models = models('phase2-bug');
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, jsonOut, mdOut] = process.argv.slice(2);
  if (!dir || !jsonOut || !mdOut) {
    console.error('usage: node eval/lib/aggregate.ts <folder with trial.json files> <report.json> <report.md>');
    process.exit(2);
  }
  const scores = findTrials(dir).map((file) => scoreTrial(readTrial(file)));
  if (!scores.length) {
    console.error(`No trial.json found under ${dir}`);
    process.exit(1);
  }
  const report = aggregate(scores);
  writeFileSync(jsonOut, `${JSON.stringify({ ...report, trials: scores }, null, 2)}\n`);
  writeFileSync(mdOut, toMarkdown(report));
  console.log(toMarkdown(report));
}
