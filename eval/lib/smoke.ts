// Smoke evaluations: which few tickets to run after a change, chosen from the history.
//
// A ticket's signals come from the campaigns of the history, counting only the trials run with the
// ticket's current corpus. The selection is a pure function of the history, the current corpus and
// the policy (eval/smoke-policy.json): the same inputs give the same tickets, in the same order, with
// the same reasons. In order:
//   1. every critical ticket (the critical kinds and tickets of eval/compare-policy.json);
//   2. one ticket of each kind not yet covered;
//   3. risky tickets: never run with their current corpus, then regressed between two consecutive
//      versions (in the last regression_lookback changes of version), then unstable in the latest
//      version that ran them; within a group, the longest without a run first;
//   4. rotation: the tickets that have gone longest without a run, whatever their signals;
//   5. if slots remain, more of the same rotation.
// backtest() replays the history: for each version, the selection the history before it gives, what
// its full run found against the previous version, how much of it the smoke run would have caught,
// and what each would have cost. A version's full run leaves out its smoke runs (config.selection).
import { createHash } from 'node:crypto';
import { classify } from './compare.ts';
import type { Campaign, Observation } from './history.ts';

export interface SmokePolicy {
  schema_version: 1;
  size: number;
  trials: number;
  rotation_slots: number;
  regression_lookback: number;
  full_every_days: number;
  why: Record<string, string>;
}
export interface Critical { kinds: string[]; tickets: string[] }
/** A ticket of the corpus as it is now: its kind and the git tree of its folder. */
export interface CorpusTicket { ticket: string; kind: string; tree: string }

interface Version { agent: string; label: string; start: string; campaigns: Campaign[] }
export interface VersionResult { agent: string; label: string; successes: number; trials: number }
export interface TicketSignals {
  ticket: string;
  kind: string;
  critical: boolean;
  /** Start of the latest trial run with the current corpus; null when there is none. */
  last_run: string | null;
  /** Trials run with the current corpus, agent errors left out. */
  trials: number;
  /** Results by version, oldest first, with the current corpus. */
  versions: VersionResult[];
  /** Falls of the success rate between consecutive versions that ran the ticket, within the lookback. */
  regressions: { from: string; to: string; before: string; after: string; drop: number }[];
  unstable_latest: boolean;
}
export interface Pick { ticket: string; kind: string; because: string; reasons: string[] }
export interface Selection {
  schema_version: 1;
  size: number;
  tickets: Pick[];
  not_selected: { ticket: string; last_run: string | null; runs_until_rotation: number; signals: string[] }[];
  full_run: { due: boolean; last_full: string | null; reason: string };
  /** sha256 of everything the selection depends on: the same digest gives the same selection. */
  inputs_digest: string;
}

const byTicket = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');
const startOf = (c: Campaign) => c.source.started_at ?? c.observations.map((o) => o.started_at).sort()[0] ?? '';

/** The versions of the history, oldest first: one per agent, with the campaigns that ran it. */
export function versionsOf(campaigns: Campaign[]): Version[] {
  const byAgent = new Map<string, Version>();
  for (const c of campaigns.filter((x) => x.role === 'campaign').sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.id.localeCompare(b.id))) {
    const v = byAgent.get(c.agent.id) ?? { agent: c.agent.id, label: c.label, start: startOf(c), campaigns: [] };
    v.campaigns.push(c);
    byAgent.set(c.agent.id, v);
  }
  return [...byAgent.values()].sort((a, b) => a.start.localeCompare(b.start) || a.agent.localeCompare(b.agent));
}

const okWithCorpus = (v: Version, ticket: string, tree: string): Observation[] =>
  v.campaigns.filter((c) => c.environment.corpus[ticket] === tree).flatMap((c) => c.observations.filter((o) => o.ticket === ticket && o.status === 'ok'));

export function signals(campaigns: Campaign[], corpus: CorpusTicket[], policy: SmokePolicy, critical: Critical): TicketSignals[] {
  const versions = versionsOf(campaigns);
  const firstCounted = Math.max(0, versions.length - policy.regression_lookback);
  return corpus.map((t) => {
    const results: (VersionResult & { index: number })[] = [];
    let last: string | null = null;
    versions.forEach((v, index) => {
      const os = okWithCorpus(v, t.ticket, t.tree);
      if (!os.length) return;
      results.push({ agent: v.agent, label: v.label, successes: os.filter((o) => o.success).length, trials: os.length, index });
      for (const o of os) if (!last || o.started_at > last) last = o.started_at;
    });
    const regressions: TicketSignals['regressions'] = [];
    for (let i = 1; i < results.length; i++) {
      const [p, n] = [results[i - 1], results[i]];
      const drop = p.successes / p.trials - n.successes / n.trials;
      if (drop > 1e-12 && n.index >= firstCounted) regressions.push({ from: p.label, to: n.label, before: `${p.successes}/${p.trials}`, after: `${n.successes}/${n.trials}`, drop });
    }
    const latest = results.at(-1);
    return {
      ticket: t.ticket,
      kind: t.kind,
      critical: critical.kinds.includes(t.kind) || critical.tickets.includes(t.ticket),
      last_run: last,
      trials: results.reduce((n, r) => n + r.trials, 0),
      versions: results.map(({ index: _, ...r }) => r),
      regressions,
      unstable_latest: Boolean(latest && latest.successes > 0 && latest.successes < latest.trials),
    };
  });
}

/** What a ticket's signals say, in words, for the report. */
function describe(s: TicketSignals): string[] {
  const out: string[] = [];
  if (s.critical) out.push(`critical (${s.kind})`);
  if (!s.trials) out.push('never run with its current corpus');
  for (const r of s.regressions) out.push(`regressed from ${r.from} to ${r.to}: ${r.before} → ${r.after}`);
  if (s.unstable_latest) { const v = s.versions.at(-1)!; out.push(`unstable in ${v.label}: ${v.successes}/${v.trials}`); }
  return out;
}

/** Oldest run first; never run first of all; then by ticket. */
const staleness = (a: TicketSignals, b: TicketSignals) => (a.last_run ?? '').localeCompare(b.last_run ?? '') || byTicket(a.ticket, b.ticket);
const risk = (s: TicketSignals) => (!s.trials ? 0 : s.regressions.length ? 1 : s.unstable_latest ? 2 : 3);
const byRisk = (a: TicketSignals, b: TicketSignals) => risk(a) - risk(b)
  || (risk(a) === 1 ? b.regressions.reduce((x, r) => x + r.drop, 0) - a.regressions.reduce((x, r) => x + r.drop, 0) : 0)
  || staleness(a, b);

export function selectSmoke(campaigns: Campaign[], corpus: CorpusTicket[], policy: SmokePolicy, critical: Critical, asOf: string): Selection {
  const all = signals(campaigns, corpus, policy, critical);
  const picks: Pick[] = [];
  const taken = new Set<string>();
  const take = (s: TicketSignals, because: string, extra: string[] = []) => {
    taken.add(s.ticket);
    picks.push({ ticket: s.ticket, kind: s.kind, because, reasons: [...extra, ...describe(s), `last run ${day(s.last_run)}`] });
  };
  const free = () => all.filter((s) => !taken.has(s.ticket));
  // 1. Critical tickets.
  for (const s of all.filter((x) => x.critical).sort((a, b) => byTicket(a.ticket, b.ticket))) take(s, 'critical');
  // 2. One ticket of each kind.
  for (const kind of [...new Set(corpus.map((t) => t.kind))].sort()) {
    if (picks.some((p) => p.kind === kind)) continue;
    const best = free().filter((s) => s.kind === kind).sort(byRisk)[0];
    if (best) take(best, 'kind', [`represents the kind "${kind}"`]);
  }
  // 3. Risky tickets, leaving the rotation its slots.
  const riskSlots = Math.max(0, policy.size - picks.length - policy.rotation_slots);
  for (const s of free().filter((x) => risk(x) < 3).sort(byRisk).slice(0, riskSlots)) take(s, ['new', 'regressed', 'unstable'][risk(s)]);
  // 4. and 5. Rotation: the longest without a run.
  for (const s of free().sort(staleness).slice(0, Math.max(0, policy.size - picks.length))) {
    take(s, 'rotation', [s.last_run ? `rotation: the longest without a run among the others (${day(s.last_run)})` : 'rotation: never run']);
  }
  const remaining = free().sort(staleness);
  const versions = versionsOf(campaigns);
  // A full run: one version that ran every current ticket with its current corpus.
  const full = versions.filter((v) => corpus.every((t) => okWithCorpus(v, t.ticket, t.tree).length > 0));
  const lastFull = full.length ? full.at(-1)!.campaigns.flatMap((c) => c.observations.map((o) => o.started_at)).sort().at(-1) ?? null : null;
  const days = lastFull ? (Date.parse(asOf) - Date.parse(lastFull)) / 86_400_000 : Infinity;
  const due = days > policy.full_every_days;
  const digest = createHash('sha256').update(JSON.stringify({
    campaigns: campaigns.map((c) => [c.id, c.provenance.sha256]).sort(),
    corpus: [...corpus].sort((a, b) => byTicket(a.ticket, b.ticket)),
    policy,
    critical,
  })).digest('hex');
  return {
    schema_version: 1,
    size: policy.size,
    tickets: picks,
    not_selected: remaining.map((s, i) => ({
      ticket: s.ticket,
      last_run: s.last_run,
      // The rotation takes the longest without a run first, so each smoke run moves every other ticket up.
      runs_until_rotation: Math.ceil((i + 1) / Math.max(1, policy.rotation_slots)),
      signals: describe(s),
    })),
    full_run: {
      due,
      last_full: lastFull,
      reason: !lastFull ? 'no version has run every current ticket with its current corpus' : due
        ? `the last full run ended ${day(lastFull)}, more than ${policy.full_every_days} days before ${day(asOf)}`
        : `the last full run ended ${day(lastFull)}, within ${policy.full_every_days} days of ${day(asOf)}`,
    },
    inputs_digest: digest,
  };
}

// ---------------------------------------------------------------- backtest

export interface BacktestStep {
  version: string;
  agent: string;
  previous: string;
  selection: string[];
  /** Tickets of the selection that this version did not run, so the replay cannot use them. */
  not_run: string[];
  /** Tickets whose success rate fell against the previous version's, in the full run; and those the smoke run had. */
  worse: string[];
  worse_caught: string[];
  regressed: string[];
  regressed_caught: string[];
  better: string[];
  better_caught: string[];
  cost_usd: { full: number; smoke: number };
  trials: { full: number; smoke: number };
}

/**
 * Replays the history. For each version after the first: the selection made from the campaigns
 * that started before it, with the corpus its campaigns ran; then its full run against the previous
 * data of each ticket; the smoke run is the full run's own trials on the selected tickets.
 */
export function backtest(campaigns: Campaign[], policy: SmokePolicy, critical: Critical): BacktestStep[] {
  const versions = versionsOf(campaigns);
  const steps: BacktestStep[] = [];
  for (let k = 1; k < versions.length; k++) {
    // A smoke run is a chosen subset: the version's full run is everything else it ran.
    const v = { ...versions[k], campaigns: versions[k].campaigns.filter((c) => c.config.selection !== 'smoke') };
    if (!v.campaigns.length) continue;
    const before = campaigns.filter((c) => c.role === 'campaign' && startOf(c) < v.start);
    const trees = new Map<string, CorpusTicket>();
    for (const c of v.campaigns) {
      for (const o of c.observations) trees.set(o.ticket, { ticket: o.ticket, kind: o.kind, tree: c.environment.corpus[o.ticket] });
    }
    const corpus = [...trees.values()].sort((a, b) => byTicket(a.ticket, b.ticket));
    const selection = selectSmoke(before, corpus, policy, critical, v.start).tickets.map((p) => p.ticket);
    const previous = versionsOf(before);
    const worse: string[] = []; const regressed: string[] = []; const better: string[] = [];
    for (const t of corpus) {
      const now = okWithCorpus(v, t.ticket, t.tree);
      const prior = [...previous].reverse().map((p) => okWithCorpus(p, t.ticket, t.tree)).find((os) => os.length);
      if (!now.length || !prior) continue;
      const a = { successes: prior.filter((o) => o.success).length, trials: prior.length, rate: 0 };
      const b = { successes: now.filter((o) => o.success).length, trials: now.length, rate: 0 };
      a.rate = a.successes / a.trials; b.rate = b.successes / b.trials;
      if (b.rate < a.rate - 1e-12) worse.push(t.ticket);
      if (b.rate > a.rate + 1e-12) better.push(t.ticket);
      if (classify(a, b) === 'regressed') regressed.push(t.ticket);
    }
    const all = v.campaigns.flatMap((c) => c.observations);
    const smoke = all.filter((o) => selection.includes(o.ticket));
    const sum = (os: Observation[]) => Math.round(os.reduce((n, o) => n + o.cost_usd, 0) * 1e4) / 1e4;
    const ran = new Set(all.map((o) => o.ticket));
    steps.push({
      version: v.label, agent: v.agent, previous: versions[k - 1].label, selection,
      not_run: selection.filter((t) => !ran.has(t)),
      worse, worse_caught: worse.filter((t) => selection.includes(t)),
      regressed, regressed_caught: regressed.filter((t) => selection.includes(t)),
      better, better_caught: better.filter((t) => selection.includes(t)),
      cost_usd: { full: sum(all), smoke: sum(smoke) },
      trials: { full: all.length, smoke: smoke.length },
    });
  }
  return steps;
}

// ---------------------------------------------------------------- reports

export function selectionMarkdown(s: Selection, policy: SmokePolicy): string {
  return [
    `# Smoke selection: ${s.tickets.map((p) => p.ticket).join(' ')}`,
    '',
    `${s.tickets.length} ticket(s), ${policy.trials} trial(s) each, under eval/smoke-policy.json. Inputs digest \`${s.inputs_digest.slice(0, 12)}\`: the same history, corpus and policy give the same selection.`,
    '',
    '| Ticket | Kind | Picked as | Why |',
    '|---|---|---|---|',
    ...s.tickets.map((p) => `| ${p.ticket} | ${p.kind} | ${p.because} | ${p.reasons.join('; ')} |`),
    '',
    `**Full run:** ${s.full_run.due ? 'due' : 'not due'}: ${s.full_run.reason}.`,
    '',
    'Not selected, with the number of smoke runs before the rotation reaches each one (if every smoke run is added to the history, and nothing new comes first):',
    '',
    '| Ticket | Last run | Rotation within | Signals |',
    '|---|---|---|---|',
    ...s.not_selected.map((n) => `| ${n.ticket} | ${day(n.last_run)} | ${n.runs_until_rotation} run(s) | ${n.signals.join('; ') || 'stable'} |`),
    '',
  ].join('\n');
}

export function backtestMarkdown(steps: BacktestStep[], policy: SmokePolicy): string {
  const total = (pick: (s: BacktestStep) => number) => steps.reduce((n, s) => n + pick(s), 0);
  const cost = { full: total((s) => s.cost_usd.full), smoke: total((s) => s.cost_usd.smoke) };
  const list = (xs: string[]) => xs.join(' ') || 'none';
  return [
    `# Smoke backtest: ${steps.length} change(s) of version`,
    '',
    `Each version's smoke selection is made from the history before it, under eval/smoke-policy.json (size ${policy.size}, ${policy.rotation_slots} rotation slot(s)). The smoke run is replayed with the version's own trials on the selected tickets, and compared with its full run.`,
    '',
    '| Version (after) | Smoke selection | Worse in the full run | Caught | Regressed (stable pass → fail) | Caught | Better | Caught | Cost smoke / full |',
    '|---|---|---|---|---|---|---|---|---|',
    ...steps.map((s) => `| ${s.version} (after ${s.previous}) | ${list(s.selection)}${s.not_run.length ? ` (not run: ${s.not_run.join(' ')})` : ''} | ${list(s.worse)} | ${s.worse_caught.length}/${s.worse.length} | ${list(s.regressed)} | ${s.regressed_caught.length}/${s.regressed.length} | ${list(s.better)} | ${s.better_caught.length}/${s.better.length} | $${s.cost_usd.smoke.toFixed(2)} / $${s.cost_usd.full.toFixed(2)} |`),
    '',
    `**In all:** worse tickets caught ${total((s) => s.worse_caught.length)}/${total((s) => s.worse.length)}, regressions caught ${total((s) => s.regressed_caught.length)}/${total((s) => s.regressed.length)}, better tickets seen ${total((s) => s.better_caught.length)}/${total((s) => s.better.length)}; cost $${cost.smoke.toFixed(2)} for the smoke runs against $${cost.full.toFixed(2)} for the full runs (${cost.full ? ((cost.smoke / cost.full) * 100).toFixed(0) : 'n/a'}%), ${total((s) => s.trials.smoke)} trials against ${total((s) => s.trials.full)}.`,
    '',
  ].join('\n');
}
