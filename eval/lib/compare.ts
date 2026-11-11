// Paired comparison of two agent versions, A (the reference) and B (the new version), from the
// campaigns of the history. Pure: it reads campaign files and a policy, and computes three things,
// kept apart so that a reader can check each one:
//   measurements  what each version did, ticket by ticket and bug by bug, with cost and duration;
//   analysis      how each ticket and bug changed, and the paired tests across tickets;
//   decision      accepted, review or rejected, with the rule behind each reason (compare-policy.json).
//
// The independent unit is the ticket. The trials of a ticket are correlated, and so are its bugs:
// the tests count tickets, never trials or bugs. A side may pool several campaigns of the same agent
// (the regression check and the campaign on new tickets, say), as long as each ticket's corpus is
// the same in all of them.
import { createHash } from 'node:crypto';
import { compatibility } from './history.ts';
import type { Campaign, Observation } from './history.ts';
import { mcnemarExact, percentile, signTest, wilson } from './stats.ts';
import type { Proportion } from './stats.ts';

export type Category = 'both_pass' | 'both_fail' | 'improved' | 'regressed' | 'unstable';
export type Verdict = 'accepted' | 'review' | 'rejected';
export const CATEGORIES: Category[] = ['both_pass', 'both_fail', 'improved', 'regressed', 'unstable'];

export interface Policy {
  schema_version: 1;
  alpha: number;
  /** Which verdicts fail the release decision in CI (eval/validate.ts --ci). */
  ci?: { fail_on: Verdict[]; why: string };
  critical: { kinds: string[]; tickets: string[]; why: string };
  rules: Record<string, { on_failure: 'review' | 'reject'; why: string; min?: number; max_rate?: number; max_increase?: number; scope?: 'all' | 'changed_or_critical' }>;
}

/** Successes over trials (or bug x trial items) of one unit on one side. */
export interface Outcome { trials: number; successes: number; rate: number }
export interface TicketChange {
  ticket: string;
  kind: string;
  critical: boolean;
  a: Outcome;
  b: Outcome;
  category: Category;
  /** Sign of B's rate minus A's: 1 better, -1 worse, 0 the same. */
  direction: 1 | 0 | -1;
  /** Bug detection over the ticket's bugs and trials: the ticket-level unit of the detection test. */
  detection: { a: Outcome; b: Outcome; direction: 1 | 0 | -1 } | null;
  false_positive_trials: { a: number; b: number };
  mean_cost_usd: { a: number; b: number };
  mean_duration_s: { a: number | null; b: number | null };
}
export interface BugChange { ticket: string; bug: string; criterion: string; critical: boolean; a: Outcome; b: Outcome; category: Category; direction: 1 | 0 | -1 }
export interface SideSummary {
  label: string;
  campaigns: string[];
  agent: string;
  trials: number;
  /** Trials lost to the infrastructure: agent or API errors, and the scoring errors among them. */
  agent_errors: number;
  scoring_errors: number;
  success: Proportion;
  bug_detection: Proportion;
  no_false_positive: Proportion;
  policy_ok: Proportion;
  corpus_exposed_trials: number;
  isolation_flagged_trials: number;
  mean_cost_usd: number | null;
  /** The cost of the comparable trials over their successes: what one success cost. Null without a success. */
  cost_per_success_usd: number | null;
  duration_p50_s: number | null;
  mean_tokens: number | null;
  min_trials_per_ticket: number | null;
}
export interface Reason { rule: string; level: 'review' | 'reject'; message: string; why: string }
export interface Comparison {
  schema_version: 1;
  a: SideSummary;
  b: SideSummary;
  comparability: { comparable_tickets: string[]; excluded_tickets: { ticket: string; reason: string }[]; blocking: string[]; warnings: string[]; agent_changes: string[] };
  measurements: { tickets: TicketChange[]; bugs: BugChange[]; cost: { a: number | null; b: number | null; relative_change: number | null }; duration_p50_s: { a: number | null; b: number | null } };
  analysis: {
    tickets: Record<Category, number>;
    bugs: Record<Category, number>;
    sign_test_success: ReturnType<typeof signTest>;
    sign_test_detection: ReturnType<typeof signTest>;
    /** Only when every comparable ticket has a stable outcome on both sides; otherwise null, with the reason. */
    mcnemar_success: (ReturnType<typeof mcnemarExact> & { applicable: true }) | { applicable: false; reason: string };
  };
  decision: { verdict: Verdict; reasons: Reason[]; checks: { rule: string; passed: boolean; detail: string }[]; policy_sha256: string };
}

const byTicket = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const outcome = (successes: number, trials: number): Outcome => ({ trials, successes, rate: trials ? successes / trials : 0 });
const sign = (x: number): 1 | 0 | -1 => (x > 1e-12 ? 1 : x < -1e-12 ? -1 : 0);

/**
 * The category of a unit from its outcomes on both sides. A side is stable when all its trials agree.
 * With one stable outcome on each side: both pass, both fail, improved (fail to pass) or regressed
 * (pass to fail). With a side whose trials disagree: unstable, whatever the rates.
 */
export function classify(a: Outcome, b: Outcome): Category {
  const stable = (o: Outcome) => o.successes === 0 || o.successes === o.trials;
  if (!stable(a) || !stable(b)) return 'unstable';
  const pa = a.successes > 0;
  const pb = b.successes > 0;
  return pa && pb ? 'both_pass' : !pa && !pb ? 'both_fail' : pb ? 'improved' : 'regressed';
}

interface Side { label: string; campaigns: Campaign[] }

function sideTickets(side: Side): Map<string, { observations: Observation[]; errors: number; corpus: Set<string>; kind: string }> {
  const tickets = new Map<string, { observations: Observation[]; errors: number; corpus: Set<string>; kind: string }>();
  for (const c of side.campaigns) {
    for (const o of c.observations) {
      const t = tickets.get(o.ticket) ?? { observations: [], errors: 0, corpus: new Set<string>(), kind: o.kind };
      if (o.status === 'ok') t.observations.push(o); else t.errors += 1;
      t.corpus.add(c.environment.corpus[o.ticket] ?? 'unknown');
      tickets.set(o.ticket, t);
    }
  }
  return tickets;
}

function summary(side: Side, tickets: string[]): SideSummary {
  const agents = [...new Set(side.campaigns.map((c) => c.agent.id))];
  const all = side.campaigns.flatMap((c) => c.observations);
  const ok = all.filter((o) => o.status === 'ok');
  const inScope = ok.filter((o) => tickets.includes(o.ticket));
  const withTests = inScope.filter((o) => o.kind !== 'ambiguous');
  const bugs = inScope.flatMap((o) => o.bugs);
  const perTicket = tickets.map((t) => inScope.filter((o) => o.ticket === t).length);
  const tokens = inScope.flatMap((o) => (o.tokens ? [o.tokens.input + o.tokens.output + o.tokens.cache_read + o.tokens.cache_creation] : []));
  const durations = inScope.flatMap((o) => (o.duration_ms === null ? [] : [o.duration_ms / 1000]));
  const round = (x: number | null, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const successes = inScope.filter((o) => o.success).length;
  return {
    label: side.label,
    campaigns: side.campaigns.map((c) => `${c.id} (${c.label})`),
    agent: agents.join(', '),
    trials: all.length,
    agent_errors: all.length - ok.length,
    scoring_errors: all.filter((o) => o.status === 'scoring_error').length,
    success: wilson(successes, inScope.length),
    bug_detection: wilson(bugs.filter((b) => b.detected).length, bugs.length),
    no_false_positive: wilson(withTests.filter((o) => o.false_positives === 0).length, withTests.length),
    // Rules about the new version's behavior look at all its trials, not only the comparable tickets.
    policy_ok: wilson(ok.filter((o) => o.policy_ok).length, ok.length),
    corpus_exposed_trials: all.filter((o) => o.corpus_exposed).length,
    isolation_flagged_trials: all.filter((o) => (o.isolation_findings ?? 0) > 0).length,
    mean_cost_usd: round(mean(inScope.map((o) => o.cost_usd))),
    cost_per_success_usd: successes ? round(inScope.reduce((n, o) => n + o.cost_usd, 0) / successes) : null,
    duration_p50_s: round(percentile(durations, 50), 1),
    mean_tokens: tokens.length ? Math.round(mean(tokens)!) : null,
    min_trials_per_ticket: perTicket.length ? Math.min(...perTicket) : null,
  };
}

const count = (cats: Category[]) => Object.fromEntries(CATEGORIES.map((c) => [c, cats.filter((x) => x === c).length])) as Record<Category, number>;

export function compare(sideA: Side, sideB: Side, policy: Policy, policyText: string): Comparison {
  for (const side of [sideA, sideB]) {
    if (!side.campaigns.length) throw new Error(`side ${side.label} has no campaign`);
    const agents = new Set(side.campaigns.map((c) => c.agent.id));
    if (agents.size > 1) throw new Error(`side ${side.label} mixes agent versions (${[...agents].join(', ')}): a side is one version`);
  }
  // Compatibility of every pair of campaigns across the sides that share a ticket.
  const blocking = new Set<string>();
  const warnings = new Set<string>();
  const changes = new Set<string>();
  const excluded = new Map<string, string>();
  for (const a of sideA.campaigns) {
    for (const b of sideB.campaigns) {
      if (!a.config.tickets.some((t) => b.config.tickets.includes(t))) continue;
      const result = compatibility(a, b);
      for (const x of result.blocking) blocking.add(x);
      for (const x of result.warnings) warnings.add(x);
      for (const x of result.agent_changes) changes.add(x);
      for (const x of result.excluded_tickets) if (x.reason === 'its corpus changed') excluded.set(x.ticket, x.reason);
    }
  }
  const ta = sideTickets(sideA);
  const tb = sideTickets(sideB);
  for (const [name, side] of [[sideA.label, ta], [sideB.label, tb]] as const) {
    for (const [ticket, t] of side) if (t.corpus.size > 1) excluded.set(ticket, `its corpus differs between the campaigns of ${name}`);
  }
  for (const ticket of new Set([...ta.keys(), ...tb.keys()])) {
    if (excluded.has(ticket)) continue;
    if (!ta.has(ticket) || !tb.has(ticket)) excluded.set(ticket, `only in ${ta.has(ticket) ? sideA.label : sideB.label}`);
    else if (!ta.get(ticket)!.observations.length || !tb.get(ticket)!.observations.length) excluded.set(ticket, 'no trial without an agent or scoring error on one side');
  }
  const comparable = blocking.size ? [] : [...ta.keys()].filter((t) => tb.has(t) && !excluded.has(t)).sort(byTicket);
  const isCritical = (ticket: string, kind: string) => policy.critical.kinds.includes(kind) || policy.critical.tickets.includes(ticket);

  // ---------------------------------------------------------------- measurements
  const ticketChanges: TicketChange[] = [];
  const bugChanges: BugChange[] = [];
  for (const ticket of comparable) {
    const oa = ta.get(ticket)!.observations;
    const ob = tb.get(ticket)!.observations;
    const kind = ta.get(ticket)!.kind;
    const a = outcome(oa.filter((o) => o.success).length, oa.length);
    const b = outcome(ob.filter((o) => o.success).length, ob.length);
    const bugs = (os: Observation[]) => os.flatMap((o) => o.bugs);
    const da = outcome(bugs(oa).filter((x) => x.detected).length, bugs(oa).length);
    const db = outcome(bugs(ob).filter((x) => x.detected).length, bugs(ob).length);
    const durations = (os: Observation[]) => mean(os.flatMap((o) => (o.duration_ms === null ? [] : [o.duration_ms / 1000])));
    ticketChanges.push({
      ticket, kind, critical: isCritical(ticket, kind), a, b, category: classify(a, b), direction: sign(b.rate - a.rate),
      detection: da.trials || db.trials ? { a: da, b: db, direction: sign(db.rate - da.rate) } : null,
      false_positive_trials: { a: oa.filter((o) => o.false_positives > 0).length, b: ob.filter((o) => o.false_positives > 0).length },
      mean_cost_usd: { a: mean(oa.map((o) => o.cost_usd)) ?? 0, b: mean(ob.map((o) => o.cost_usd)) ?? 0 },
      mean_duration_s: { a: durations(oa), b: durations(ob) },
    });
    const ids = [...new Set([...bugs(oa), ...bugs(ob)].map((x) => x.id))].sort();
    for (const id of ids) {
      const of = (os: Observation[]) => os.flatMap((o) => o.bugs.filter((x) => x.id === id));
      const ba = outcome(of(oa).filter((x) => x.detected).length, of(oa).length);
      const bb = outcome(of(ob).filter((x) => x.detected).length, of(ob).length);
      if (!ba.trials || !bb.trials) continue;
      bugChanges.push({ ticket, bug: id, criterion: of(oa)[0]?.criterion ?? of(ob)[0].criterion, critical: isCritical(ticket, kind), a: ba, b: bb, category: classify(ba, bb), direction: sign(bb.rate - ba.rate) });
    }
  }
  const sa = summary(sideA, comparable);
  const sb = summary(sideB, comparable);
  // Cost is compared ticket by ticket: the mean over tickets of each ticket's mean cost per trial.
  const costA = mean(ticketChanges.map((t) => t.mean_cost_usd.a));
  const costB = mean(ticketChanges.map((t) => t.mean_cost_usd.b));
  const relativeCost = costA && costB !== null ? (costB - costA) / costA : null;

  // ---------------------------------------------------------------- analysis
  const plus = (xs: (1 | 0 | -1)[]) => xs.filter((d) => d === 1).length;
  const minus = (xs: (1 | 0 | -1)[]) => xs.filter((d) => d === -1).length;
  const successDirections = ticketChanges.map((t) => t.direction);
  const detectionDirections = ticketChanges.flatMap((t) => (t.detection ? [t.detection.direction] : []));
  const binary = ticketChanges.every((t) => t.category !== 'unstable');
  const analysis: Comparison['analysis'] = {
    tickets: count(ticketChanges.map((t) => t.category)),
    bugs: count(bugChanges.map((x) => x.category)),
    sign_test_success: signTest(plus(successDirections), minus(successDirections)),
    sign_test_detection: signTest(plus(detectionDirections), minus(detectionDirections)),
    mcnemar_success: !ticketChanges.length
      ? { applicable: false, reason: 'no comparable ticket' }
      : binary
        ? { applicable: true, ...mcnemarExact(ticketChanges.filter((t) => t.category === 'regressed').length, ticketChanges.filter((t) => t.category === 'improved').length) }
        : { applicable: false, reason: 'some tickets have trials that disagree: their outcome is not binary, and the sign test on their success rates applies' },
  };

  // ---------------------------------------------------------------- decision
  const reasons: Reason[] = [];
  const checks: { rule: string; passed: boolean; detail: string }[] = [];
  const rule = (id: string, passed: boolean, detail: string) => {
    const r = policy.rules[id];
    if (!r) throw new Error(`the policy has no rule "${id}"`);
    checks.push({ rule: id, passed, detail });
    if (!passed) reasons.push({ rule: id, level: r.on_failure, message: detail, why: r.why });
  };
  const confirmed = (o: { a: Outcome; b: Outcome }) => Math.min(o.a.trials, o.b.trials) >= (policy.rules.enough_trials.min ?? 3);
  const trialsMin = Math.min(sa.min_trials_per_ticket ?? 0, sb.min_trials_per_ticket ?? 0);
  rule('comparable', !blocking.size, blocking.size ? `not comparable: ${[...blocking].join('; ')}` : 'the history allows the comparison');
  rule('enough_tickets', comparable.length >= (policy.rules.enough_tickets.min ?? 0), `${comparable.length} comparable ticket(s), ${policy.rules.enough_tickets.min} needed`);
  // scope "all" (the default): every ticket needs the minimum on both sides. "changed_or_critical": a
  // ticket below it is fine when it is not critical and its outcome did not change (pass or fail in
  // both, every trial agreeing), which lets an adaptive campaign run fewer trials on stable tickets.
  const minTrials = policy.rules.enough_trials.min ?? 0;
  const short = ticketChanges.filter((t) => Math.min(t.a.trials, t.b.trials) < minTrials
    && (policy.rules.enough_trials.scope !== 'changed_or_critical' || t.critical || (t.category !== 'both_pass' && t.category !== 'both_fail')));
  rule('enough_trials', comparable.length > 0 && !short.length, policy.rules.enough_trials.scope === 'changed_or_critical'
    ? (short.length ? `fewer than ${minTrials} trials on a critical or changed ticket: ${short.map((t) => `${t.ticket} (${t.a.trials} and ${t.b.trials})`).join(', ')}` : `${minTrials} trials or more on every critical or changed ticket (at least ${comparable.length ? trialsMin : 0} on any ticket)`)
    : `at least ${comparable.length ? trialsMin : 0} trial(s) per ticket and version, ${minTrials} needed`);
  const violations = sideB.campaigns.flatMap((c) => c.observations).filter((o) => o.status === 'ok' && !o.policy_ok).map((o) => o.key);
  rule('b_policy', !violations.length, violations.length ? `${violations.length} trial(s) of ${sideB.label} changed a file other than tests: ${violations.join(', ')}` : `every trial of ${sideB.label} changed test files only`);
  rule('b_corpus_exposure', !sb.corpus_exposed_trials, `${sb.corpus_exposed_trials} trial(s) of ${sideB.label} saw the corpus`);
  rule('b_isolation', !sb.isolation_flagged_trials, `${sb.isolation_flagged_trials} trial(s) of ${sideB.label} sent back a trace of the corpus`);
  rule('a_corpus_exposure', !sa.corpus_exposed_trials, `${sa.corpus_exposed_trials} trial(s) of ${sideA.label} saw the corpus`);
  const errorRate = sb.trials ? sb.agent_errors / sb.trials : 0;
  rule('b_agent_errors', errorRate <= (policy.rules.b_agent_errors.max_rate ?? 1), sb.scoring_errors
    ? `${sb.agent_errors} of ${sb.trials} trial(s) of ${sideB.label} were lost to the infrastructure: ${sb.agent_errors - sb.scoring_errors} to an agent or API error, ${sb.scoring_errors} to a scoring runner that sent nothing back`
    : `${sb.agent_errors} of ${sb.trials} trial(s) of ${sideB.label} ended with an agent or API error`);
  const units = [...ticketChanges.map((t) => ({ name: t.ticket, ...t })), ...bugChanges.map((x) => ({ name: `${x.ticket} bug ${x.bug}`, ...x }))];
  const regressed = units.filter((u) => u.category === 'regressed');
  const criticalConfirmed = regressed.filter((u) => u.critical && confirmed(u));
  rule('critical_regression', !criticalConfirmed.length, criticalConfirmed.length ? `confirmed regression on a critical ticket: ${criticalConfirmed.map((u) => u.name).join(', ')}` : 'no confirmed regression on a critical ticket');
  const others = regressed.filter((u) => !criticalConfirmed.includes(u));
  rule('regressions', !others.length, others.length ? `regression of ${others.map((u) => `${u.name} (${u.a.successes}/${u.a.trials} → ${u.b.successes}/${u.b.trials}${confirmed(u) ? '' : ', not confirmed'})`).join(', ')}` : 'no other regression');
  const unstableWorse = units.filter((u) => u.category === 'unstable' && u.direction === -1);
  rule('unstable_worse', !unstableWorse.length, unstableWorse.length ? `unstable and worse in ${sideB.label}: ${unstableWorse.map((u) => `${u.name} (${u.a.successes}/${u.a.trials} → ${u.b.successes}/${u.b.trials})`).join(', ')}` : 'no unstable unit is worse');
  const worse = [analysis.sign_test_success, analysis.sign_test_detection].filter((t) => t.minus > t.plus && t.p < policy.alpha);
  rule('significant_worsening', !worse.length, worse.length ? `the sign test finds ${sideB.label} worse across tickets (p = ${worse.map((t) => t.p.toFixed(4)).join(', ')})` : `no significant worsening at alpha ${policy.alpha}`);
  rule('cost', relativeCost === null || relativeCost <= (policy.rules.cost.max_increase ?? Infinity), relativeCost === null ? 'cost not compared' : `cost per trial ${relativeCost >= 0 ? '+' : ''}${(relativeCost * 100).toFixed(1)}%`);
  const verdict: Verdict = reasons.some((r) => r.level === 'reject') ? 'rejected' : reasons.length ? 'review' : 'accepted';

  return {
    schema_version: 1,
    a: sa,
    b: sb,
    comparability: { comparable_tickets: comparable, excluded_tickets: [...excluded].map(([ticket, reason]) => ({ ticket, reason })).sort((x, y) => byTicket(x.ticket, y.ticket)), blocking: [...blocking], warnings: [...warnings], agent_changes: [...changes] },
    measurements: { tickets: ticketChanges, bugs: bugChanges, cost: { a: costA, b: costB, relative_change: relativeCost }, duration_p50_s: { a: sa.duration_p50_s, b: sb.duration_p50_s } },
    analysis,
    decision: { verdict, reasons, checks, policy_sha256: createHash('sha256').update(policyText).digest('hex') },
  };
}

// ---------------------------------------------------------------- report

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const prop = (p: Proportion) => `${p.successes}/${p.n}, ${pct(p.rate)}${p.low === null ? '' : ` (${pct(p.low)}–${pct(p.high)})`}`;
const ratio = (o: Outcome) => `${o.successes}/${o.trials}`;
const LABEL: Record<Category, string> = { both_pass: 'pass in both', both_fail: 'fail in both', improved: 'improved', regressed: 'regressed', unstable: 'unstable' };
const ARROW = { 1: 'better', 0: 'same', [-1]: 'worse' } as const;

function testLine(name: string, t: ReturnType<typeof signTest>, alpha: number, b: string): string {
  if (!t.n) return `- **${name}:** no ticket changed: the test has nothing to count. This is not evidence that the versions are equivalent.`;
  const base = `- **${name}:** ${t.plus} ticket(s) better in ${b}, ${t.minus} worse, the others tied; exact two-sided p = ${t.p.toFixed(4)}.`;
  const floor = t.min_p >= alpha ? ` With ${t.n} ticket(s) that changed, no result could reach p < ${alpha} (the smallest possible p is ${t.min_p.toFixed(4)}).` : '';
  const reading = t.p < alpha ? ` The difference is unlikely to be chance alone, at alpha ${alpha}.` : ' No difference is detected; this is not evidence that the versions are equivalent.';
  return base + floor + reading;
}

export function toMarkdown(c: Comparison, policy: Policy): string {
  const { a, b } = c;
  const lines = [
    `# ${a.label} → ${b.label}`,
    '',
    `**Decision: ${c.decision.verdict.toUpperCase()}.** ${c.decision.verdict === 'accepted' ? 'Every rule passed.' : `${c.decision.reasons.length} rule(s) did not pass; see Decision.`}`,
    '',
    `- **${a.label}** (reference): ${a.campaigns.join(', ')}; agent ${a.agent}.`,
    `- **${b.label}** (new version): ${b.campaigns.join(', ')}; agent ${b.agent}.`,
    `- **What changed in the agent:** ${c.comparability.agent_changes.length ? c.comparability.agent_changes.join(', ') : 'nothing: the same agent, measured twice'}.`,
    `- **Policy:** eval/compare-policy.json, sha256 \`${c.decision.policy_sha256.slice(0, 12)}\`, alpha ${policy.alpha}.`,
    '',
    '## Comparability',
    '',
    `${c.comparability.comparable_tickets.length} comparable ticket(s): ${c.comparability.comparable_tickets.join(' ') || 'none'}.`,
    ...c.comparability.blocking.map((x) => `- **Blocking:** ${x}`),
    ...c.comparability.excluded_tickets.map((x) => `- Excluded ${x.ticket}: ${x.reason}.`),
    ...c.comparability.warnings.map((x) => `- Warning: ${x}`),
    '',
    '## Measurements',
    '',
    'Over the comparable tickets, trials with an agent error left out. Intervals are 95% Wilson intervals over trials (or bug × trial items): they describe each version, and are narrower than they should be, since the trials of a ticket are correlated.',
    '',
    `| | ${a.label} | ${b.label} |`,
    '|---|---|---|',
    `| Trial success | ${prop(a.success)} | ${prop(b.success)} |`,
    `| Injected bugs detected | ${prop(a.bug_detection)} | ${prop(b.bug_detection)} |`,
    `| Trials without a false positive | ${prop(a.no_false_positive)} | ${prop(b.no_false_positive)} |`,
    `| Policy respected (all trials) | ${prop(a.policy_ok)} | ${prop(b.policy_ok)} |`,
    `| Trials per ticket (minimum) | ${a.min_trials_per_ticket ?? 'n/a'} | ${b.min_trials_per_ticket ?? 'n/a'} |`,
    `| Agent or API errors (all trials) | ${a.agent_errors - a.scoring_errors}/${a.trials} | ${b.agent_errors - b.scoring_errors}/${b.trials} |`,
    ...(a.scoring_errors || b.scoring_errors ? [`| Scoring runner sent nothing back (all trials) | ${a.scoring_errors}/${a.trials} | ${b.scoring_errors}/${b.trials} |`] : []),
    `| Trials that saw the corpus | ${a.corpus_exposed_trials} | ${b.corpus_exposed_trials} |`,
    `| Mean cost per trial (by ticket) | ${c.measurements.cost.a === null ? 'n/a' : `$${c.measurements.cost.a.toFixed(4)}`} | ${c.measurements.cost.b === null ? 'n/a' : `$${c.measurements.cost.b.toFixed(4)}`} (${c.measurements.cost.relative_change === null ? 'n/a' : `${c.measurements.cost.relative_change >= 0 ? '+' : ''}${(c.measurements.cost.relative_change * 100).toFixed(1)}%`}) |`,
    `| Cost per successful trial | ${a.cost_per_success_usd === null ? 'no success' : `$${a.cost_per_success_usd.toFixed(4)}`} | ${b.cost_per_success_usd === null ? 'no success' : `$${b.cost_per_success_usd.toFixed(4)}`} |`,
    `| Phase 1 duration, p50 | ${a.duration_p50_s ?? 'n/a'} s | ${b.duration_p50_s ?? 'n/a'} s |`,
    `| Tokens per trial, mean | ${a.mean_tokens ?? 'not recorded'} | ${b.mean_tokens ?? 'not recorded'} |`,
    '',
    '## Changes',
    '',
    'A unit is stable on a side when all its trials agree. Stable on both sides: pass in both, fail in both, improved (fail → pass) or regressed (pass → fail). Otherwise: unstable, with the direction of the rates.',
    '',
    '| | Pass in both | Fail in both | Improved | Regressed | Unstable |',
    '|---|---|---|---|---|---|',
    `| Tickets (trial success) | ${CATEGORIES.map((k) => c.analysis.tickets[k]).join(' | ')} |`,
    `| Bugs (detection) | ${CATEGORIES.map((k) => c.analysis.bugs[k]).join(' | ')} |`,
    '',
    `| Ticket | Kind | ${a.label} | ${b.label} | Change | Bugs detected (${a.label} → ${b.label}) | Trials with a false positive | Mean cost |`,
    '|---|---|---|---|---|---|---|---|',
    ...c.measurements.tickets.map((t) => `| ${t.ticket}${t.critical ? ' (critical)' : ''} | ${t.kind} | ${ratio(t.a)} | ${ratio(t.b)} | ${LABEL[t.category]}${t.category === 'unstable' ? `, ${ARROW[t.direction]}` : ''} | ${t.detection ? `${ratio(t.detection.a)} → ${ratio(t.detection.b)}` : 'n/a'} | ${t.false_positive_trials.a} → ${t.false_positive_trials.b} | $${t.mean_cost_usd.a.toFixed(4)} → $${t.mean_cost_usd.b.toFixed(4)} |`),
    '',
    ...(c.measurements.bugs.some((x) => x.category !== 'both_pass')
      ? [`Bugs that did not pass in both (detections over trials):`, '', `| Ticket | Bug | Criterion | ${a.label} | ${b.label} | Change |`, '|---|---|---|---|---|---|',
        ...c.measurements.bugs.filter((x) => x.category !== 'both_pass').map((x) => `| ${x.ticket} | ${x.bug} | ${x.criterion} | ${ratio(x.a)} | ${ratio(x.b)} | ${LABEL[x.category]}${x.category === 'unstable' ? `, ${ARROW[x.direction]}` : ''} |`), '']
      : ['Every bug was detected in every trial of both versions.', '']),
    '## Statistics',
    '',
    'The unit is the ticket: the trials and the bugs of a ticket are not independent. Each test compares, ticket by ticket, the rate of the new version with the rate of the reference.',
    '',
    testLine('Sign test, trial success', c.analysis.sign_test_success, policy.alpha, b.label),
    testLine('Sign test, bug detection', c.analysis.sign_test_detection, policy.alpha, b.label),
    c.analysis.mcnemar_success.applicable
      ? `- **Exact McNemar, trial success:** ${c.analysis.mcnemar_success.b} ticket(s) passed with ${a.label} only, ${c.analysis.mcnemar_success.c} with ${b.label} only; p = ${c.analysis.mcnemar_success.p.toFixed(4)}.`
      : `- **Exact McNemar:** not applicable: ${c.analysis.mcnemar_success.reason}.`,
    '- The two sign tests are not corrected for multiple testing. No rule decides on a p-value alone.',
    '',
    '## Decision',
    '',
    `**${c.decision.verdict.toUpperCase()}**`,
    '',
    '| Rule | Result | Detail |',
    '|---|---|---|',
    ...c.decision.checks.map((x) => {
      const reason = c.decision.reasons.find((r) => r.rule === x.rule);
      return `| ${x.rule} | ${x.passed ? 'passed' : reason?.level === 'reject' ? '**reject**' : '**review**'} | ${x.detail.replace(/\|/g, '/')} |`;
    }),
    '',
    ...c.decision.reasons.map((r) => `- **${r.rule}** (${r.level}): ${r.why}`),
    '',
  ];
  return lines.join('\n');
}
