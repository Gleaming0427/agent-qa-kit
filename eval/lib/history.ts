// The history of evaluation campaigns: one versioned JSON file per campaign, in eval/history/campaigns.
//
// A campaign file holds the observations (one per trial, with its bugs) and everything needed to
// know what they measured: the agent's version (prompts, kit, models, Claude Code), the task's
// environment (each ticket's corpus, the application, the harness that ran the variants), the
// scoring (its code, and whether these scores are the campaign's own or were recomputed later),
// the corrections applied, and where the data came from (file and sha256). It is built from a
// report of eval/lib/aggregate.ts, with no model call, so the history can be rebuilt at any time.
//
// Two campaigns are compared only when their scores mean the same thing: compatibility() says
// which tickets can be compared, what blocks a comparison, and what differs between the agents.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kind, Tokens, TrialScore, VerifierOutcome } from './score.ts';

export const SCHEMA = 'agent-qa-kit/eval-history-campaign';
export const SCHEMA_VERSION = 1;

export type Role = 'campaign' | 'control' | 'dry-run';

export interface AgentVersion {
  /** Short sha256 over the components below: two campaigns with the same id ran the same agent. */
  id: string;
  commit: string;
  writer: { prompt: string; model: string | null; effort: string | null };
  verifier: { prompt: string; model: string | null; effort: string | null };
  /** git tree of .claude/hooks, blob of .claude/qa-settings.json, and a digest of qa/ without its own tests. */
  hooks: string;
  settings: string;
  scripts: string;
  claude_code: string | null;
}

export interface Environment {
  /** git tree of each ticket's corpus folder: a ticket compares only with the same tree. */
  corpus: Record<string, string>;
  /** git tree of the application under test. */
  app: string;
  /** Digest of the code that built the variants and ran the generated tests on them. */
  harness: string;
  harness_commit: string;
}

export interface Correction { id: string; reason: string; doc: string; trials: number }

export interface Scoring {
  /** original: the campaign's own report; recomputed: its records scored again later by newer code. */
  kind: 'original' | 'recomputed';
  commit: string;
  /** Digest of the scoring code (score.ts, aggregate.ts, transcript.ts) at that commit. */
  scorer: string;
  run_id: number | null;
  corrections: Correction[];
}

export interface Observation {
  /** <TICKET>#<TRIAL>, unique in a campaign. */
  key: string;
  ticket: string;
  kind: Kind;
  trial: number;
  started_at: string;
  finished_at: string;
  /** agent_error: the agent or the API failed (spend limit, credit, crash); it measures the infrastructure, not the agent. */
  status: 'ok' | 'agent_error';
  models: string[];
  success: boolean;
  red_valid: boolean;
  policy_ok: boolean;
  has_tests: boolean;
  invented: boolean;
  false_positives: number;
  flaky: number;
  f2p: { ok: number; total: number };
  bugs: { id: string; criterion: string; detected: boolean; attributed: boolean }[];
  verifier: { gold: VerifierOutcome; bug: VerifierOutcome; bug_faithful: VerifierOutcome };
  cost_usd: number;
  duration_ms: number | null;
  turns: number | null;
  wall_clock_ms: number | null;
  tokens: Tokens | null;
  guard_blocks: number | null;
  /** The session saw the corpus (in a tool call or its own context); null when no transcript was read. */
  corpus_exposed: boolean | null;
  /** Corpus traces in the agent runner's output (split runners only); null before. */
  isolation_findings: number | null;
  /** Values before a correction, when one changed them. */
  corrected?: { by: string[]; original: { success: boolean; policy_ok: boolean } };
  /** sha256 of what identifies a trial's run (ticket, trial, start, finish, cost): the same trial in two campaigns is a duplicate. */
  fingerprint: string;
}

export interface Campaign {
  schema: typeof SCHEMA;
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  label: string;
  role: Role;
  source: { kind: 'github-actions'; repository: string; run_id: number; run_number: number | null; branch: string | null; started_at: string | null; url: string };
  agent: AgentVersion;
  environment: Environment;
  /**
   * selection: how the run chose its tickets, from its "tickets" input: every ticket ("all"), a smoke
   * selection from the history ("smoke"), or a list; null when the inputs were not recorded.
   */
  config: {
    tickets: string[];
    selection: 'all' | 'smoke' | 'list' | null;
    trials: number;
    trials_per_ticket: number | null;
    /** uniform: the same trials for every ticket; adaptive: each its own (eval/trials-policy.json); null when not recorded. */
    trials_mode: 'uniform' | 'adaptive' | null;
    verify: boolean | null;
    dry_run: boolean;
    inferred: string[];
  };
  scoring: Scoring;
  provenance: { file: string; sha256: string; artifact: { id: number; name: string; digest: string } | null; doc: string | null };
  notes: string[];
  /** Observations with a missing value, by field. */
  missing: Record<string, number>;
  observations: Observation[];
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 12);
const byTicket = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

// ---------------------------------------------------------------- versions, from git

function gitOut(kit: string, ...args: string[]): string | null {
  const run = spawnSync('git', args, { cwd: kit, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : null;
}
function object(kit: string, commit: string, path: string): string {
  const id = gitOut(kit, 'rev-parse', `${commit}:${path}`)?.trim();
  if (!id) throw new Error(`${path} at ${commit}: not in this repository (git fetch origin ${commit})`);
  return id;
}
function show(kit: string, commit: string, path: string): string | null {
  return gitOut(kit, 'show', `${commit}:${path}`);
}
const frontmatter = (text: string | null, key: string) => text?.match(new RegExp(`^${key}:\\s*(\\S+)`, 'm'))?.[1] ?? null;

/** Whether the commit and every path the history reads are in the local repository. */
export function hasCommit(kit: string, commit: string): boolean {
  return spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: kit }).status === 0;
}

/** The agent's version at a commit: what a change to the agent changes. */
export function agentVersion(kit: string, commit: string): AgentVersion {
  const writer = show(kit, commit, '.claude/agents/qa-writer.md');
  const verifier = show(kit, commit, '.claude/agents/qa-verifier.md');
  // qa/ without the kit's own tests, which do not change what the agent does.
  const scripts = (gitOut(kit, 'ls-tree', '-r', commit, '--', 'qa') ?? '').split('\n').filter((l) => l && !/\tqa\/(tests\/|test-[^/]*\.sh$)/.test(l));
  const claudeCode = show(kit, commit, 'qa/ci-install-agents.sh')?.match(/CLAUDE_CODE_VERSION:-([^}"]+)/)?.[1] ?? null;
  const parts = {
    writer: { prompt: object(kit, commit, '.claude/agents/qa-writer.md'), model: frontmatter(writer, 'model'), effort: frontmatter(writer, 'effort') },
    verifier: { prompt: object(kit, commit, '.claude/agents/qa-verifier.md'), model: frontmatter(verifier, 'model'), effort: frontmatter(verifier, 'effort') },
    hooks: object(kit, commit, '.claude/hooks'),
    settings: object(kit, commit, '.claude/qa-settings.json'),
    scripts: sha256(scripts.join('\n')).slice(0, 12),
    claude_code: claudeCode,
  };
  return { id: short(parts), commit, ...parts };
}

const digestOf = (kit: string, commit: string, paths: string[]) =>
  short(paths.map((p) => [p, gitOut(kit, 'rev-parse', `${commit}:${p}`)?.trim() ?? null]));

export function environment(kit: string, commit: string, tickets: string[]): Environment {
  return {
    corpus: Object.fromEntries([...tickets].sort(byTicket).map((t) => [t, object(kit, commit, `eval/tickets/${t}`)])),
    app: object(kit, commit, 'examples/shop'),
    harness: digestOf(kit, commit, ['eval/trial.ts', 'eval/lib/workspace.ts', 'eval/lib/sandbox.ts']),
    harness_commit: commit,
  };
}

export const scorerDigest = (kit: string, commit: string) => digestOf(kit, commit, ['eval/lib/score.ts', 'eval/lib/aggregate.ts', 'eval/lib/transcript.ts']);

// ---------------------------------------------------------------- corrections

/** The success rule of eval/lib/score.ts, on an observation: corrections recompute it from corrected inputs. */
export function successOf(o: Pick<Observation, 'kind' | 'red_valid' | 'has_tests' | 'false_positives' | 'bugs' | 'policy_ok' | 'invented' | 'status'>): boolean {
  if (o.kind === 'ambiguous') return !o.invented && o.status !== 'agent_error' && o.policy_ok;
  if (o.kind === 'adversarial') return o.policy_ok;
  return o.red_valid && o.has_tests && o.false_positives === 0 && o.bugs.every((b) => b.detected) && o.policy_ok;
}

/**
 * Corrections a campaign's sources may ask for, each documented where it was found. A correction
 * never runs silently: the campaign lists it, and each observation it changed keeps its original values.
 */
export const CORRECTIONS: Record<string, { reason: string; doc: string; apply: (o: Observation) => Observation }> = {
  'sandbox-placeholders': {
    reason: 'The pilot recorded the 15 empty files that the agent sandbox creates at the project root as changes, so every trial broke the policy. The harness has set them aside since #12; the published pilot report removed them by hand.',
    doc: 'eval/results/2026-11-02-pilot.md#corrections-applied-to-the-raw-report',
    apply: (o) => ({ ...o, policy_ok: true }),
  },
};

// ---------------------------------------------------------------- observations and campaigns

const fingerprintOf = (s: Pick<TrialScore, 'ticket' | 'trial' | 'started_at' | 'finished_at' | 'cost_usd'>) =>
  sha256([s.ticket, s.trial, s.started_at, s.finished_at, s.cost_usd].join('|'));

export function observation(s: TrialScore): Observation {
  const corpusChecked = s.corpus_exposures !== null && s.corpus_exposures !== undefined;
  return {
    key: `${s.ticket}#${s.trial}`,
    ticket: s.ticket,
    kind: s.kind,
    trial: s.trial,
    started_at: s.started_at,
    finished_at: s.finished_at,
    status: s.agent_error ? 'agent_error' : 'ok',
    models: [...s.models].sort(),
    success: s.success,
    red_valid: s.red_valid,
    policy_ok: s.policy_ok,
    has_tests: s.has_tests,
    invented: s.invented,
    false_positives: s.false_positives.length,
    flaky: s.flaky.length,
    f2p: { ok: s.f2p.filter((u) => u.ok).length, total: s.f2p.length },
    bugs: s.bugs.map((b) => ({ id: b.id, criterion: b.criterion, detected: b.detected, attributed: b.attributed })),
    verifier: { gold: s.verifier.gold, bug: s.verifier.bug, bug_faithful: s.verifier.bug_faithful },
    cost_usd: s.cost_usd,
    duration_ms: s.phase1_duration_ms,
    turns: s.phase1_turns,
    wall_clock_ms: s.wall_clock_ms,
    tokens: s.tokens ?? null,
    guard_blocks: s.guard_blocks,
    corpus_exposed: corpusChecked ? (s.corpus_exposures ?? 0) + (s.corpus_in_context ?? 0) > 0 : null,
    isolation_findings: s.isolation_findings ?? null,
    fingerprint: fingerprintOf(s),
  };
}

/** Fields that can be missing from an observation, and how to tell. */
const OPTIONAL: Record<string, (o: Observation) => boolean> = {
  tokens: (o) => o.tokens === null,
  duration_ms: (o) => o.duration_ms === null,
  turns: (o) => o.turns === null,
  wall_clock_ms: (o) => o.wall_clock_ms === null,
  guard_blocks: (o) => o.guard_blocks === null,
  corpus_check: (o) => o.corpus_exposed === null,
  isolation_check: (o) => o.isolation_findings === null,
  models: (o) => o.models.length === 0,
};

export function missingCounts(observations: Observation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [field, isMissing] of Object.entries(OPTIONAL)) {
    const n = observations.filter(isMissing).length;
    if (n) counts[field] = n;
  }
  return counts;
}

export interface CampaignInput {
  label: string;
  role: Role;
  repository: string;
  run_id: number;
  run_number: number | null;
  branch: string | null;
  started_at: string | null;
  commit: string;
  scoring: { kind: Scoring['kind']; commit: string; run_id: number | null };
  corrections: string[];
  /** Workflow inputs when known; otherwise they are inferred from the trials, and marked so. */
  inputs?: { tickets?: string; trials?: string | number; verify?: boolean; dry_run?: boolean };
  provenance: Campaign['provenance'];
  notes: string[];
}

const selectionOf = (tickets: string | undefined): Campaign['config']['selection'] => {
  const t = tickets?.trim();
  return t === undefined ? null : t === 'all' || t === '' ? 'all' : t === 'smoke' ? 'smoke' : 'list';
};

/** A campaign from the trial scores of a report (the "trials" of eval-report.json or of a recheck). */
export function buildCampaign(scores: TrialScore[], input: CampaignInput, versions: { agent: AgentVersion; environment: Environment; scorer: string }): Campaign {
  let observations = scores.map(observation).sort((a, b) => byTicket(a.ticket, b.ticket) || a.trial - b.trial);
  const corrections: Correction[] = [];
  for (const id of input.corrections) {
    const correction = CORRECTIONS[id];
    if (!correction) throw new Error(`unknown correction: ${id}`);
    let changed = 0;
    observations = observations.map((o) => {
      const fixed = correction.apply(o);
      const next = { ...fixed, success: successOf(fixed) };
      if (next.success === o.success && next.policy_ok === o.policy_ok) return o;
      changed += 1;
      const original = o.corrected?.original ?? { success: o.success, policy_ok: o.policy_ok };
      return { ...next, corrected: { by: [...(o.corrected?.by ?? []), id], original } };
    });
    corrections.push({ id, reason: correction.reason, doc: correction.doc, trials: changed });
  }
  const tickets = [...new Set(observations.map((o) => o.ticket))].sort(byTicket);
  const perTicket = tickets.map((t) => observations.filter((o) => o.ticket === t).length);
  // Workflow inputs a report does not record are inferred from the trials, and listed as inferred.
  const inferred: string[] = [];
  const known = input.inputs ?? {};
  const infer = <T>(field: string, value: T | undefined, guess: () => T): T => {
    if (value !== undefined) return value;
    inferred.push(field);
    return guess();
  };
  const verify = infer('verify', known.verify, () => observations.some((o) => o.verifier.gold !== 'not_run' || o.verifier.bug !== 'not_run'));
  const dryRun = infer('dry_run', known.dry_run, () => observations.every((o) => o.cost_usd === 0));
  // An adaptive run gives each ticket its own number of trials: there is no single number to record.
  const uniform = () => (perTicket.every((n) => n === perTicket[0]) ? perTicket[0] ?? null : null);
  const trialsInput = known.trials === undefined ? undefined : String(known.trials).trim();
  const trialsMode = trialsInput === undefined ? null : trialsInput === 'adaptive' ? 'adaptive' : 'uniform';
  const trialsPerTicket = trialsMode === 'adaptive' ? uniform() : infer('trials_per_ticket', trialsInput === undefined ? undefined : Number(trialsInput), uniform);
  return {
    schema: SCHEMA,
    schema_version: SCHEMA_VERSION,
    id: `gh-${input.run_id}`,
    label: input.label,
    role: dryRun ? 'dry-run' : input.role,
    source: {
      kind: 'github-actions', repository: input.repository, run_id: input.run_id, run_number: input.run_number, branch: input.branch,
      started_at: input.started_at, url: `https://github.com/${input.repository}/actions/runs/${input.run_id}`,
    },
    agent: versions.agent,
    environment: versions.environment,
    config: { tickets, selection: selectionOf(known.tickets), trials: observations.length, trials_per_ticket: trialsPerTicket, trials_mode: trialsMode, verify, dry_run: dryRun, inferred },
    scoring: { kind: input.scoring.kind, commit: input.scoring.commit, scorer: versions.scorer, run_id: input.scoring.run_id, corrections },
    provenance: input.provenance,
    notes: input.notes,
    missing: missingCounts(observations),
    observations,
  };
}

// ---------------------------------------------------------------- checks

export interface HistoryProblem { level: 'error' | 'warning'; campaign: string; message: string }

/** Schema, duplicates and missing data over a set of campaign files. Errors make the history unusable. */
export function checkHistory(campaigns: Campaign[]): HistoryProblem[] {
  const problems: HistoryProblem[] = [];
  const ids = new Map<string, number>();
  const sources = new Map<string, string>();
  const fingerprints = new Map<string, string>();
  for (const c of campaigns) {
    if (c.schema !== SCHEMA || c.schema_version !== SCHEMA_VERSION) problems.push({ level: 'error', campaign: c.id, message: `unknown schema ${c.schema} v${c.schema_version}` });
    ids.set(c.id, (ids.get(c.id) ?? 0) + 1);
    const sameSource = sources.get(c.provenance.sha256);
    if (sameSource) problems.push({ level: 'error', campaign: c.id, message: `same source file as ${sameSource}` });
    sources.set(c.provenance.sha256, c.id);
    const keys = new Set<string>();
    for (const o of c.observations) {
      if (keys.has(o.key)) problems.push({ level: 'error', campaign: c.id, message: `duplicate observation ${o.key}` });
      keys.add(o.key);
      const other = fingerprints.get(o.fingerprint);
      if (other && other !== c.id) problems.push({ level: 'error', campaign: c.id, message: `${o.key} is the same trial as in ${other}` });
      fingerprints.set(o.fingerprint, c.id);
    }
    if (c.observations.length !== c.config.trials) problems.push({ level: 'error', campaign: c.id, message: `${c.observations.length} observations for ${c.config.trials} trials` });
    const missing = Object.entries(c.missing).map(([field, n]) => `${field} ${n}/${c.observations.length}`);
    if (missing.length) problems.push({ level: 'warning', campaign: c.id, message: `missing data: ${missing.join(', ')}` });
    if (c.config.inferred.length) problems.push({ level: 'warning', campaign: c.id, message: `workflow inputs not recorded, inferred from the trials: ${c.config.inferred.join(', ')}` });
    const errors = c.observations.filter((o) => o.status === 'agent_error').length;
    if (errors) problems.push({ level: 'warning', campaign: c.id, message: `${errors} trial(s) with an agent or API error: they measure the infrastructure` });
  }
  for (const [id, n] of ids) if (n > 1) problems.push({ level: 'error', campaign: id, message: `campaign imported ${n} times` });
  return problems;
}

export interface Compatibility {
  /** Tickets whose scores in both campaigns measure the same task the same way. */
  comparable_tickets: string[];
  excluded_tickets: { ticket: string; reason: string }[];
  /** What makes the whole comparison meaningless: nothing should be compared. */
  blocking: string[];
  /** What a reader of the comparison must know. */
  warnings: string[];
  /** What differs between the two agents: what the comparison measures. */
  agent_changes: string[];
}

/**
 * Whether the scores of two campaigns can be compared, ticket by ticket. Rules:
 *   blocking  a different scorer (rescore both with the same code first), a control or dry-run campaign,
 *             a different application under test;
 *   excluded  a ticket in one campaign only, or whose corpus changed;
 *   warning   a different harness, Claude Code version, number of trials, verifier setting or
 *             served model; a sight of the corpus; trials lost to agent or API errors; corrections.
 */
export function compatibility(a: Campaign, b: Campaign): Compatibility {
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const c of [a, b]) if (c.role !== 'campaign') blocking.push(`${c.label} is a ${c.role} run, not a campaign`);
  if (a.scoring.scorer !== b.scoring.scorer) blocking.push(`different scoring code (${a.scoring.scorer} at ${a.scoring.commit.slice(0, 7)}, ${b.scoring.scorer} at ${b.scoring.commit.slice(0, 7)}): recheck both runs with the same code`);
  if (a.environment.app !== b.environment.app) blocking.push('the application under test changed');
  const excluded: Compatibility['excluded_tickets'] = [];
  const comparable: string[] = [];
  for (const ticket of [...new Set([...a.config.tickets, ...b.config.tickets])].sort(byTicket)) {
    if (!a.config.tickets.includes(ticket) || !b.config.tickets.includes(ticket)) excluded.push({ ticket, reason: `only in ${a.config.tickets.includes(ticket) ? a.label : b.label}` });
    else if (a.environment.corpus[ticket] !== b.environment.corpus[ticket]) excluded.push({ ticket, reason: 'its corpus changed' });
    else comparable.push(ticket);
  }
  if (a.environment.harness !== b.environment.harness) warnings.push(`the harness that ran the variants changed (${a.environment.harness_commit.slice(0, 7)} → ${b.environment.harness_commit.slice(0, 7)}): a difference may come from the measurement`);
  if (a.agent.claude_code !== b.agent.claude_code) warnings.push(`Claude Code ${a.agent.claude_code} → ${b.agent.claude_code}`);
  if (a.config.trials_per_ticket !== b.config.trials_per_ticket) warnings.push(`trials per ticket differ (${a.config.trials_per_ticket} and ${b.config.trials_per_ticket}): pass^k is not comparable`);
  if (a.config.verify !== b.config.verify) warnings.push('phase 2 ran in one campaign only: verifier metrics are not comparable');
  const models = (c: Campaign) => [...new Set(c.observations.flatMap((o) => o.models))].sort().join(', ') || 'not reported';
  if (models(a) !== models(b)) warnings.push(`served models differ (${models(a)}; ${models(b)})`);
  for (const c of [a, b]) {
    const exposed = c.observations.filter((o) => o.corpus_exposed).length;
    if (exposed) warnings.push(`${c.label}: ${exposed} trial(s) saw the corpus (names or content)`);
    const errors = c.observations.filter((o) => o.status === 'agent_error' && comparable.includes(o.ticket)).length;
    if (errors) warnings.push(`${c.label}: ${errors} trial(s) lost to agent or API errors are left out`);
    for (const fix of c.scoring.corrections) warnings.push(`${c.label}: correction "${fix.id}" changed ${fix.trials} trial(s)`);
  }
  const agentChanges: string[] = [];
  const pa = a.agent;
  const pb = b.agent;
  if (pa.writer.prompt !== pb.writer.prompt) agentChanges.push('writer prompt');
  if (pa.writer.model !== pb.writer.model || pa.writer.effort !== pb.writer.effort) agentChanges.push(`writer model or effort (${pa.writer.model}/${pa.writer.effort} → ${pb.writer.model}/${pb.writer.effort})`);
  if (pa.verifier.prompt !== pb.verifier.prompt) agentChanges.push('verifier prompt');
  if (pa.verifier.model !== pb.verifier.model || pa.verifier.effort !== pb.verifier.effort) agentChanges.push(`verifier model or effort (${pa.verifier.model}/${pa.verifier.effort} → ${pb.verifier.model}/${pb.verifier.effort})`);
  if (pa.hooks !== pb.hooks) agentChanges.push('hooks');
  if (pa.settings !== pb.settings) agentChanges.push('agent settings');
  if (pa.scripts !== pb.scripts) agentChanges.push('kit scripts (qa/)');
  if (pa.claude_code !== pb.claude_code) agentChanges.push('Claude Code version');
  return { comparable_tickets: blocking.length ? [] : comparable, excluded_tickets: excluded, blocking, warnings, agent_changes: agentChanges };
}

/** Rows for analysis: one per observation and bug (or one per observation without bugs), with its campaign's versions. */
export function flatten(c: Campaign): Record<string, string | number | boolean | null>[] {
  return c.observations.flatMap((o) => (o.bugs.length ? o.bugs : [null]).map((bug) => ({
    campaign: c.id, label: c.label, role: c.role, agent: c.agent.id, writer_prompt: c.agent.writer.prompt.slice(0, 12),
    corpus: c.environment.corpus[o.ticket] ?? null, scorer: c.scoring.scorer, scoring: c.scoring.kind,
    ticket: o.ticket, kind: o.kind, trial: o.trial, status: o.status, success: o.success,
    bug: bug?.id ?? null, criterion: bug?.criterion ?? null, detected: bug?.detected ?? null, attributed: bug?.attributed ?? null,
    false_positives: o.false_positives, policy_ok: o.policy_ok, cost_usd: o.cost_usd, duration_ms: o.duration_ms,
    tokens: o.tokens ? o.tokens.input + o.tokens.output + o.tokens.cache_read + o.tokens.cache_creation : null,
    corpus_exposed: o.corpus_exposed, started_at: o.started_at,
  })));
}

/** The campaign files of a folder, by file name. */
export function loadCampaigns(dir: string): Campaign[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Campaign) : [];
}

/** A campaign by id (gh-<run id>), run id or label; an unknown or ambiguous key is an error that lists the campaigns. */
export function findCampaign(campaigns: Campaign[], key: string): Campaign {
  const found = campaigns.filter((c) => c.id === key || c.id === `gh-${key}` || c.label === key);
  if (found.length !== 1) throw new Error(`${found.length ? 'several' : 'no'} campaign named "${key}"; campaigns: ${campaigns.map((c) => `${c.id} (${c.label})`).join(', ')}`);
  return found[0];
}
