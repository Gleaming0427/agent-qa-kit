// How many trials each ticket needs: what more or fewer trials change, measured on the history, and
// an adaptive allocation fixed before a campaign from the history alone.
//
// Exact, not sampled. A version ran n trials of a ticket, s of them successful. What k of those
// trials would have said is averaged over every order the n trials could have come in, which gives
// exact probabilities: no random draw, and no dependence on which trial happened to be numbered 1.
// A conclusion is the one a release decision cares about: the ticket got worse, its success rate
// below the previous version's.
//
// No early stopping. A strategy fixes each ticket's trials before the campaign. Its only second stage
// is a follow-up on tickets whose first trials disagree or look worse: the decision then pools all
// their trials. A ticket never stops early because its first trials look good.
import { compare } from './compare.ts';
import type { Policy } from './compare.ts';
import type { Campaign, Observation } from './history.ts';
import { okWithCorpus, signals, startOf, versionsOf } from './smoke.ts';
import type { CorpusTicket, Critical, Version } from './smoke.ts';
import { wilson } from './stats.ts';

export interface TrialsPolicy {
  schema_version: 1;
  stable_trials: number;
  default_trials: number;
  risky_trials: number;
  critical_trials: number;
  follow_up_trials: number;
  stable: { versions: number; min_trials: number };
  regression_lookback: number;
  why: Record<string, string>;
}
export type TicketClass = 'critical' | 'risky' | 'stable' | 'default';
export interface Allocation { ticket: string; kind: string; class: TicketClass; trials: number; reasons: string[] }

const byTicket = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Each ticket's trials for the next campaign, and why. A pure function of the history, the corpus and the policy. */
export function allocate(campaigns: Campaign[], corpus: CorpusTicket[], policy: TrialsPolicy, critical: Critical): Allocation[] {
  return signals(campaigns, corpus, policy, critical).map((s) => {
    const recent = s.versions.slice(-policy.stable.versions);
    const stable = recent.length >= policy.stable.versions && recent.every((v) => v.successes === v.trials)
      && recent.reduce((n, v) => n + v.trials, 0) >= policy.stable.min_trials;
    const reasons: string[] = [];
    let cls: TicketClass;
    if (s.critical) { cls = 'critical'; reasons.push(`critical (${s.kind})`); }
    else if (!s.trials || s.regressions.length || s.unstable_latest) {
      cls = 'risky';
      if (!s.trials) reasons.push('never run with its current corpus');
      for (const r of s.regressions) reasons.push(`regressed from ${r.from} to ${r.to}: ${r.before} → ${r.after}`);
      if (s.unstable_latest) { const v = s.versions.at(-1)!; reasons.push(`unstable in ${v.label}: ${v.successes}/${v.trials}`); }
    } else if (stable) { cls = 'stable'; reasons.push(`every trial passed in ${recent.map((v) => `${v.label} (${v.successes}/${v.trials})`).join(' and ')}`); }
    else { cls = 'default'; reasons.push(s.versions.length ? `latest: ${s.versions.at(-1)!.label} ${s.versions.at(-1)!.successes}/${s.versions.at(-1)!.trials}` : 'no history'); }
    const trials = { critical: policy.critical_trials, risky: policy.risky_trials, stable: policy.stable_trials, default: policy.default_trials }[cls];
    return { ticket: s.ticket, kind: s.kind, class: cls, trials, reasons };
  });
}

// ---------------------------------------------------------------- exact replay of fewer or more trials

/** Every arrangement of s successes among n trials, each as likely as the others. */
function arrangements(n: number, s: number): boolean[][] {
  const out: boolean[][] = [];
  const walk = (prefix: boolean[], left: number) => {
    if (prefix.length === n) { if (left === 0) out.push(prefix); return; }
    const room = n - prefix.length;
    if (left > 0) walk([...prefix, true], left - 1);
    if (room > left) walk([...prefix, false], left);
  };
  walk([], s);
  return out;
}

/** A strategy for one ticket: trials before any result, and follow-up trials when the first ones disagree or look worse. */
export interface Plan { initial: number; follow_up: number }
export interface TicketReplay {
  ticket: string;
  /** Trials the version ran, successes, and the previous version's rate. */
  n: number; s: number; prior: number;
  worse_full: boolean;
  /** Probability that the strategy concludes "worse", over every order of the n trials. */
  p_worse: number;
  /** Expected trials the strategy asks for (it may ask more than the n that ran: then n are replayed). */
  expected_trials: number;
  capped: boolean;
  mean_cost_usd: number;
}

/**
 * Replays a plan on a ticket's trials. Stage 1 takes the first `initial` trials of an order; it is
 * flagged when it looks worse than the previous rate or its trials disagree; a flagged ticket gets
 * `follow_up` more trials, and the conclusion pools them. Exact over every order.
 */
export function replay(outcomes: boolean[], prior: number, plan: Plan): { p_worse: number; expected_trials: number; capped: boolean } {
  const n = outcomes.length;
  const s = outcomes.filter(Boolean).length;
  const all = arrangements(n, s);
  let worse = 0;
  let trials = 0;
  for (const order of all) {
    const first = order.slice(0, Math.min(plan.initial, n));
    const rate = first.filter(Boolean).length / first.length;
    const flagged = rate < prior - 1e-12 || (first.some(Boolean) && !first.every(Boolean));
    const used = flagged ? order.slice(0, Math.min(plan.initial + plan.follow_up, n)) : first;
    if (used.filter(Boolean).length / used.length < prior - 1e-12) worse += 1;
    trials += plan.initial + (flagged ? plan.follow_up : 0);
  }
  return { p_worse: worse / all.length, expected_trials: trials / all.length, capped: plan.initial + plan.follow_up > n };
}

interface Transition { previous: Version; earlier: Version[]; version: Version; corpus: CorpusTicket[]; before: Campaign[] }

/** The changes of version of the history; a version's full run leaves out its smoke runs. */
export function transitions(campaigns: Campaign[]): Transition[] {
  const versions = versionsOf(campaigns);
  const out: Transition[] = [];
  for (let k = 1; k < versions.length; k++) {
    const version = { ...versions[k], campaigns: versions[k].campaigns.filter((c) => c.config.selection !== 'smoke') };
    if (!version.campaigns.length) continue;
    const trees = new Map<string, CorpusTicket>();
    for (const c of version.campaigns) for (const o of c.observations) trees.set(o.ticket, { ticket: o.ticket, kind: o.kind, tree: c.environment.corpus[o.ticket] });
    out.push({ previous: versions[k - 1], earlier: versions.slice(0, k), version, corpus: [...trees.values()].sort((a, b) => byTicket(a.ticket, b.ticket)), before: campaigns.filter((c) => c.role === 'campaign' && startOf(c) < version.start) });
  }
  return out;
}

const ordered = (os: Observation[]) => [...os].sort((a, b) => a.started_at.localeCompare(b.started_at) || a.trial - b.trial);

function replayTransition(t: Transition, planOf: (ticket: string) => Plan): TicketReplay[] {
  return t.corpus.flatMap((c) => {
    const now = ordered(okWithCorpus(t.version, c.ticket, c.tree));
    // The reference is the latest earlier version that ran the ticket with this corpus, as in the smoke backtest.
    const prior = [...t.earlier].reverse().map((v) => okWithCorpus(v, c.ticket, c.tree)).find((os) => os.length) ?? [];
    if (!now.length || !prior.length) return [];
    const outcomes = now.map((o) => o.success);
    const p0 = prior.filter((o) => o.success).length / prior.length;
    const s = outcomes.filter(Boolean).length;
    const r = replay(outcomes, p0, planOf(c.ticket));
    return [{ ticket: c.ticket, n: outcomes.length, s, prior: p0, worse_full: s / outcomes.length < p0 - 1e-12, ...r, mean_cost_usd: now.reduce((x, o) => x + o.cost_usd, 0) / now.length }];
  });
}

export interface StrategyResult {
  strategy: string;
  /** Expected share of the tickets worse in the full run that the strategy also finds worse. */
  recall: number | null;
  worse_full: number;
  /** Expected number of tickets the strategy finds worse that the full run does not. */
  false_alarms: number;
  /** Expected share of tickets whose conclusion (worse or not) is the full run's. */
  stability: number;
  expected_trials: number;
  expected_cost_usd: number;
  capped_tickets: number;
  /** Tickets replayed: the previous version also ran them with the same corpus. */
  tickets: number;
}

function summarize(strategy: string, replays: TicketReplay[]): StrategyResult {
  const worse = replays.filter((r) => r.worse_full);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    strategy,
    recall: worse.length ? sum(worse.map((r) => r.p_worse)) / worse.length : null,
    worse_full: worse.length,
    false_alarms: sum(replays.filter((r) => !r.worse_full).map((r) => r.p_worse)),
    stability: replays.length ? sum(replays.map((r) => (r.worse_full ? r.p_worse : 1 - r.p_worse))) / replays.length : 1,
    expected_trials: sum(replays.map((r) => r.expected_trials)),
    expected_cost_usd: sum(replays.map((r) => r.expected_trials * r.mean_cost_usd)),
    capped_tickets: replays.filter((r) => r.capped).length,
    tickets: replays.length,
  };
}

// ---------------------------------------------------------------- retrospective: 1, 2 or 3 trials

export interface RetroStep {
  version: string;
  previous: string;
  by_k: (StrategyResult & {
    k: number;
    /** Rules that fail when the version's first k trials of each ticket are compared with the previous version (enough_trials left out). */
    failing_rules: string[];
    verdict: string;
    /** Width of the 95% Wilson interval of the version's trial success over its first k trials. */
    success_interval_width: number | null;
  })[];
}

/** For each change of version: what 1 to max trials per ticket would have concluded, against all the trials that ran. */
export function retrospect(campaigns: Campaign[], ks: number[], comparePolicy: Policy): RetroStep[] {
  const policyText = JSON.stringify(comparePolicy);
  // The number of trials is what varies here: its own rule is left out, so the others show.
  const relaxed: Policy = { ...comparePolicy, rules: { ...comparePolicy.rules, enough_trials: { ...comparePolicy.rules.enough_trials, min: 0 } } };
  return transitions(campaigns).map((t) => ({
    version: t.version.label,
    previous: t.previous.label,
    by_k: ks.map((k) => {
      const replays = replayTransition(t, () => ({ initial: k, follow_up: 0 }));
      // The version's first k trials of each ticket, for the comparison and the interval.
      const keep = new Set<string>();
      for (const c of t.corpus) for (const o of ordered(okWithCorpus(t.version, c.ticket, c.tree)).slice(0, k)) keep.add(o.fingerprint);
      const firstK = t.version.campaigns.map((c) => ({ ...c, observations: c.observations.filter((o) => o.status !== 'ok' || keep.has(o.fingerprint)) }));
      const cmp = compare({ label: t.previous.label, campaigns: t.previous.campaigns }, { label: t.version.label, campaigns: firstK }, relaxed, policyText);
      const kept = firstK.flatMap((c) => c.observations.filter((o) => o.status === 'ok'));
      const w = wilson(kept.filter((o) => o.success).length, kept.length);
      return {
        k, ...summarize(`${k} trial(s)`, replays),
        failing_rules: cmp.decision.reasons.map((r) => r.rule),
        verdict: cmp.decision.verdict,
        success_interval_width: w.low === null || w.high === null ? null : w.high - w.low,
      };
    }),
  }));
}

// ---------------------------------------------------------------- strategies on the history

export interface BacktestStep { version: string; previous: string; results: StrategyResult[]; allocation: Allocation[] }

/**
 * For each change of version: uniform 1, 2 and 3 trials, the adaptive allocation made from the
 * history before the version without follow-up, and with it.
 */
export function backtestStrategies(campaigns: Campaign[], policy: TrialsPolicy, critical: Critical): BacktestStep[] {
  return transitions(campaigns).map((t) => {
    const allocation = allocate(t.before, t.corpus, policy, critical);
    const trialsOf = (ticket: string) => allocation.find((a) => a.ticket === ticket)?.trials ?? policy.default_trials;
    return {
      version: t.version.label,
      previous: t.previous.label,
      allocation,
      results: [
        summarize('uniform, 1 trial', replayTransition(t, () => ({ initial: 1, follow_up: 0 }))),
        summarize('uniform, 2 trials', replayTransition(t, () => ({ initial: 2, follow_up: 0 }))),
        summarize('uniform, 3 trials', replayTransition(t, () => ({ initial: 3, follow_up: 0 }))),
        summarize('adaptive', replayTransition(t, (ticket) => ({ initial: trialsOf(ticket), follow_up: 0 }))),
        summarize('adaptive + follow-up', replayTransition(t, (ticket) => ({ initial: trialsOf(ticket), follow_up: policy.follow_up_trials }))),
      ],
    };
  });
}

// ---------------------------------------------------------------- reports

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
const num = (x: number, d = 1) => x.toFixed(d);

export function allocationMarkdown(a: Allocation[], policy: TrialsPolicy, meanCost: Map<string, number>): string {
  const total = a.reduce((n, x) => n + x.trials, 0);
  const uniform = a.length * policy.default_trials;
  const cost = (trials: (x: Allocation) => number) => a.reduce((n, x) => n + trials(x) * (meanCost.get(x.ticket) ?? 0), 0);
  return [
    `# Adaptive trials: ${total} trials on ${a.length} ticket(s)`,
    '',
    `Under eval/trials-policy.json, fixed from the history before the campaign. A uniform campaign of ${policy.default_trials} trials would run ${uniform}. Estimated cost, at each ticket's mean cost per trial in the history: $${cost((x) => x.trials).toFixed(2)} against $${cost(() => policy.default_trials).toFixed(2)}, before follow-ups.`,
    '',
    '| Ticket | Kind | Class | Trials | Why |',
    '|---|---|---|---|---|',
    ...a.map((x) => `| ${x.ticket} | ${x.kind} | ${x.class} | ${x.trials} | ${x.reasons.join('; ')} |`),
    '',
    `A ticket whose first trials disagree or look worse gets ${policy.follow_up_trials} follow-up trials when the release decision asks for a rerun; no ticket stops early because its first trials look good.`,
    '',
  ].join('\n');
}

export function retroMarkdown(steps: RetroStep[]): string {
  const ks = steps[0]?.by_k.map((x) => x.k) ?? [];
  const total = (k: number, pick: (r: RetroStep['by_k'][number]) => number) => steps.reduce((n, s) => n + pick(s.by_k.find((x) => x.k === k)!), 0);
  const worse = total(ks[0] ?? 1, (r) => r.worse_full);
  return [
    `# Trials per ticket, replayed on ${steps.length} change(s) of version`,
    '',
    'For each version, what its first k trials of each ticket would have concluded, averaged exactly over every order of the trials that ran. "Worse": the success rate below the previous version\'s. Recall: the share of the tickets worse in the full run found worse with k trials; false alarms: tickets found worse that the full run does not find worse; stability: the share of tickets whose conclusion is the full run\'s. The rules are those that fail when the first k trials are compared with the previous version, the rule on the number of trials left out.',
    '',
    '| Version (after) | Trials | Recall | False alarms | Stability | Trials run | Cost | Success interval width | Failing rules |',
    '|---|---|---|---|---|---|---|---|---|',
    ...steps.flatMap((s) => s.by_k.map((r) => `| ${s.version} (after ${s.previous}) | ${r.k} | ${r.worse_full ? `${pct(r.recall)} of ${r.worse_full}` : 'none worse'} | ${num(r.false_alarms, 2)} | ${pct(r.stability)} | ${num(r.expected_trials, 0)} | $${num(r.expected_cost_usd, 2)} | ${r.success_interval_width === null ? 'n/a' : pct(r.success_interval_width)} | ${r.failing_rules.join(', ') || 'none'} |`)),
    '',
    ...ks.map((k) => `- **${k} trial(s):** recall ${worse ? pct(total(k, (r) => (r.recall ?? 0) * r.worse_full) / worse) : 'n/a'} of ${worse} worse ticket(s), ${num(total(k, (r) => r.false_alarms), 2)} false alarm(s) expected, ${num(total(k, (r) => r.expected_trials), 0)} trials, $${num(total(k, (r) => r.expected_cost_usd), 2)}.`),
    '',
  ].join('\n');
}

export function strategiesMarkdown(steps: BacktestStep[], policy: TrialsPolicy): string {
  const names = steps[0]?.results.map((r) => r.strategy) ?? [];
  const total = (name: string, pick: (r: StrategyResult) => number) => steps.reduce((n, s) => n + pick(s.results.find((r) => r.strategy === name)!), 0);
  const worse = total(names[0] ?? '', (r) => r.worse_full);
  const baseCost = total('uniform, 3 trials', (r) => r.expected_cost_usd);
  return [
    `# Trial strategies on ${steps.length} change(s) of version`,
    '',
    `Each version's tickets get their trials from each strategy; the adaptive allocation is made from the history before the version (eval/trials-policy.json: stable ${policy.stable_trials}, default ${policy.default_trials}, risky ${policy.risky_trials}, critical ${policy.critical_trials}, follow-up ${policy.follow_up_trials}). Exact over every order of the trials that ran. When a strategy asks for more trials than ran, the trials that ran are replayed, and the cost counts the trials asked for: such tickets are "capped".`,
    '',
    '| Strategy | Recall of the worse tickets | False alarms (expected) | Stability | Trials (expected) | Cost (expected) | Against 3 uniform trials | Capped tickets |',
    '|---|---|---|---|---|---|---|---|',
    ...names.map((name) => {
      const cost = total(name, (r) => r.expected_cost_usd);
      const tickets = total(name, (r) => r.tickets);
      return `| ${name} | ${worse ? pct(total(name, (r) => (r.recall ?? 0) * r.worse_full) / worse) : 'n/a'} of ${worse} | ${num(total(name, (r) => r.false_alarms), 2)} | ${pct(tickets ? total(name, (r) => r.stability * r.tickets) / tickets : null)} | ${num(total(name, (r) => r.expected_trials), 0)} | $${num(cost, 2)} | ${baseCost ? `${cost >= baseCost ? '+' : ''}${(((cost - baseCost) / baseCost) * 100).toFixed(0)}%` : 'n/a'} | ${total(name, (r) => r.capped_tickets)} |`;
    }),
    '',
    ...steps.map((s) => `- **${s.version} (after ${s.previous}):** ${s.results.map((r) => `${r.strategy} $${num(r.expected_cost_usd, 2)}`).join(', ')}. Allocation: ${s.allocation.filter((a) => a.class !== 'default').map((a) => `${a.ticket} ${a.class} (${a.trials})`).join(', ') || 'every ticket at the default'}.`),
    '',
  ].join('\n');
}

