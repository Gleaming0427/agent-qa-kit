#!/usr/bin/env node
// The history of evaluation campaigns (eval/history). No model call: everything is rebuilt from reports.
//
//   node eval/history.ts build
//     Rebuilds eval/history/campaigns/<id>.json and eval/history/index.json from eval/history/sources.json:
//     each source report is checked against its sha256, then normalized, versioned from git (the
//     agent, the corpus, the harness and the scorer at the recorded commits) and corrected only
//     where the source says so. The output is deterministic: a rebuild changes no byte. Every
//     campaign comes from a source: build refuses to remove a campaign file that has none.
//   node eval/history.ts check
//     Schema, duplicates (a campaign or a trial imported twice), missing data, and campaign files
//     without a source (the next build could not rebuild them). Exits 1 on an error.
//   node eval/history.ts compat <campaign id or label> <campaign id or label>
//     Which tickets the two campaigns can be compared on, what blocks it, and what changed in the agent.
//   node eval/history.ts from-report <eval-report.json> <out.json>
//     In the QA eval workflow: the campaign file of the run that produced the report, from the
//     GitHub environment (GITHUB_RUN_ID, GITHUB_SHA, ...) and EVAL_INPUTS (the workflow inputs).
//     It is the preview of what build gives once the report is added to the sources.
//   node eval/history.ts rows <campaign id or label>
//     One JSON line per trial and bug, with the campaign's versions, for analysis elsewhere.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { KIT } from './lib/workspace.ts';
import { agentVersion, buildCampaign, checkHistory, compatibility, environment, findCampaign, flatten, hasCommit, loadCampaigns, scorerDigest, sha256 } from './lib/history.ts';
import type { Campaign, CampaignInput } from './lib/history.ts';
import type { TrialScore } from './lib/score.ts';

const HISTORY = join(KIT, 'eval/history');
const CAMPAIGNS = join(HISTORY, 'campaigns');

interface SourceEntry {
  run_id: number;
  run_number: number | null;
  branch: string | null;
  started_at: string | null;
  commit: string;
  label: string;
  role: CampaignInput['role'];
  scoring: { kind: 'original' | 'recomputed'; run_id: number | null; commit: string };
  corrections: string[];
  source: { file: string; sha256: string; artifact: { id: number; name: string; digest: string } | null };
  doc: string | null;
  notes: string[];
  /** The workflow inputs, when known (from the run's dispatch); otherwise they are inferred from the trials. */
  inputs?: CampaignInput['inputs'];
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const readCampaigns = (dir = CAMPAIGNS): Campaign[] => loadCampaigns(dir);

function campaignFor(entry: SourceEntry, repository: string, report: { trials?: TrialScore[] }, raw: Buffer, inputs?: CampaignInput['inputs']): Campaign {
  const scores = report.trials;
  if (!Array.isArray(scores) || !scores.length) throw new Error(`${entry.source.file}: no trials in the report`);
  for (const commit of [entry.commit, entry.scoring.commit]) {
    if (!hasCommit(KIT, commit)) throw new Error(`commit ${commit} is not in this repository: git fetch origin ${commit}`);
  }
  const tickets = [...new Set(scores.map((s) => s.ticket))];
  return buildCampaign(scores, {
    label: entry.label, role: entry.role, repository, run_id: entry.run_id, run_number: entry.run_number, branch: entry.branch,
    started_at: entry.started_at, commit: entry.commit, scoring: entry.scoring, corrections: entry.corrections, inputs,
    provenance: { file: entry.source.file, sha256: sha256(raw), artifact: entry.source.artifact, doc: entry.doc }, notes: entry.notes,
  }, {
    agent: agentVersion(KIT, entry.commit),
    environment: environment(KIT, entry.commit, tickets),
    scorer: scorerDigest(KIT, entry.scoring.commit),
  });
}

/** One line per campaign, for people. */
function indexOf(campaigns: Campaign[]) {
  return campaigns.map((c) => {
    const ok = c.observations.filter((o) => o.status === 'ok');
    const bugs = ok.flatMap((o) => o.bugs);
    return {
      id: c.id, label: c.label, role: c.role, started_at: c.source.started_at, commit: c.agent.commit.slice(0, 7), agent: c.agent.id,
      writer_prompt: c.agent.writer.prompt.slice(0, 7), scoring: `${c.scoring.kind} at ${c.scoring.commit.slice(0, 7)}`,
      tickets: c.config.tickets.length, trials: c.observations.length, agent_errors: c.observations.length - ok.length,
      successes: ok.filter((o) => o.success).length, bugs_detected: `${bugs.filter((b) => b.detected).length}/${bugs.length}`,
      trials_with_false_positives: ok.filter((o) => o.false_positives > 0).length,
      corpus_exposed_trials: c.observations.filter((o) => o.corpus_exposed).length,
      corrections: c.scoring.corrections.map((x) => x.id), cost_usd: Math.round(c.observations.reduce((a, o) => a + o.cost_usd, 0) * 1e4) / 1e4,
    };
  });
}

const find = findCampaign;

const [command, ...args] = process.argv.slice(2);

if (command === 'build') {
  const sources = JSON.parse(readFileSync(join(HISTORY, 'sources.json'), 'utf8')) as { repository: string; campaigns: SourceEntry[] };
  const out = args[0] ?? CAMPAIGNS;
  const campaigns = sources.campaigns.map((entry) => {
    const raw = readFileSync(join(HISTORY, entry.source.file));
    if (sha256(raw) !== entry.source.sha256) throw new Error(`${entry.source.file} does not match its sha256 in sources.json`);
    return campaignFor(entry, sources.repository, JSON.parse(raw.toString('utf8')) as { trials?: TrialScore[] }, raw, entry.inputs);
  });
  // A campaign file without a source would be lost: it must come from sources.json, or be removed by hand.
  const built = new Set(campaigns.map((c) => `${c.id}.json`));
  const orphans = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith('.json') && !built.has(f)) : [];
  if (orphans.length) {
    console.error(`Not in sources.json, so build would delete them: ${orphans.join(', ')}. Add each report to eval/history/sources and an entry to sources.json, or remove the file.`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const c of campaigns) writeFileSync(join(out, `${c.id}.json`), json(c));
  if (!args[0]) writeFileSync(join(HISTORY, 'index.json'), json(indexOf(campaigns)));
  const problems = checkHistory(campaigns);
  console.log(`${campaigns.length} campaign(s), ${campaigns.reduce((n, c) => n + c.observations.length, 0)} observation(s) in ${out}; ${problems.filter((p) => p.level === 'error').length} error(s), ${problems.filter((p) => p.level === 'warning').length} warning(s) (node eval/history.ts check).`);
} else if (command === 'check') {
  const campaigns = readCampaigns(args[0]);
  const problems = checkHistory(campaigns);
  if (!args[0]) {
    const sourced = new Set((JSON.parse(readFileSync(join(HISTORY, 'sources.json'), 'utf8')) as { campaigns: SourceEntry[] }).campaigns.map((e) => `gh-${e.run_id}`));
    for (const c of campaigns) if (!sourced.has(c.id)) problems.push({ level: 'error', campaign: c.id, message: 'no entry in sources.json: the next build would delete it' });
  }
  for (const c of campaigns) {
    console.log(`${c.id.padEnd(15)} ${c.label.padEnd(28)} ${c.role.padEnd(8)} agent ${c.agent.id} scorer ${c.scoring.scorer} (${c.scoring.kind}) ${c.observations.length} trials`);
  }
  for (const p of problems) console.log(`${p.level === 'error' ? 'ERROR' : 'warning'} ${p.campaign}: ${p.message}`);
  const errors = problems.filter((p) => p.level === 'error').length;
  console.log(`${campaigns.length} campaign(s): ${errors} error(s), ${problems.length - errors} warning(s).`);
  if (errors) process.exit(1);
} else if (command === 'compat') {
  const campaigns = readCampaigns();
  const [a, b] = [find(campaigns, args[0] ?? ''), find(campaigns, args[1] ?? '')];
  const result = compatibility(a, b);
  console.log(`${a.label} (${a.id}) → ${b.label} (${b.id})`);
  console.log(`Agent changes: ${result.agent_changes.length ? result.agent_changes.join(', ') : 'none (the same agent, measured twice)'}`);
  for (const line of result.blocking) console.log(`BLOCKING: ${line}`);
  for (const line of result.warnings) console.log(`warning: ${line}`);
  for (const t of result.excluded_tickets) console.log(`excluded ${t.ticket}: ${t.reason}`);
  console.log(`Comparable tickets (${result.comparable_tickets.length}): ${result.comparable_tickets.join(' ') || 'none'}`);
  if (result.blocking.length) process.exit(1);
} else if (command === 'from-report') {
  const [reportPath, outPath] = args;
  if (!reportPath || !outPath) { console.error('usage: node eval/history.ts from-report <eval-report.json> <out.json>'); process.exit(2); }
  const env = process.env;
  const runId = Number(env.GITHUB_RUN_ID);
  const commit = env.GITHUB_SHA ?? '';
  if (!Number.isInteger(runId) || !/^[0-9a-f]{40}$/.test(commit)) { console.error('from-report needs GITHUB_RUN_ID and GITHUB_SHA'); process.exit(2); }
  const raw = readFileSync(reportPath);
  const report = JSON.parse(raw.toString('utf8')) as { trials?: TrialScore[]; campaign?: { first_start?: string | null } };
  const inputs = env.EVAL_INPUTS ? JSON.parse(env.EVAL_INPUTS) as { tickets?: string; trials?: string; verify?: boolean; dry_run?: boolean } : undefined;
  const entry: SourceEntry = {
    run_id: runId, run_number: env.GITHUB_RUN_NUMBER ? Number(env.GITHUB_RUN_NUMBER) : null, branch: env.GITHUB_REF_NAME ?? null,
    started_at: report.campaign?.first_start ?? null, commit, label: env.HISTORY_LABEL || `run ${env.GITHUB_RUN_NUMBER ?? runId}`, role: 'campaign',
    scoring: { kind: 'original', run_id: runId, commit }, corrections: [],
    source: { file: `eval-report.json of run ${runId}`, sha256: sha256(raw), artifact: null }, doc: null, notes: [],
  };
  const campaign = campaignFor(entry, env.GITHUB_REPOSITORY ?? 'unknown', report, raw, inputs && {
    tickets: inputs.tickets, trials: inputs.trials, verify: inputs.verify, dry_run: inputs.dry_run,
  });
  writeFileSync(outPath, json(campaign));
  console.log(`Campaign ${campaign.id} (${campaign.observations.length} trials, agent ${campaign.agent.id}) in ${basename(outPath)}. To keep it, add eval-report.json to eval/history/sources and an entry to sources.json (with these inputs), then run node eval/history.ts build.`);
} else if (command === 'rows') {
  const campaign = find(readCampaigns(), args[0] ?? '');
  for (const row of flatten(campaign)) console.log(JSON.stringify(row));
} else {
  console.error('usage: node eval/history.ts <build|check|compat <a> <b>|from-report <report> <out>|rows <campaign>>');
  process.exit(2);
}
