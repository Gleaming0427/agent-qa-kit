#!/usr/bin/env node
// The track record of QA verify: whether the check has earned the right to block a merge.
//
// QA verify appends one JSON line per ticket and step to its record (qa/ci-verify.sh), in
// advisory mode as in blocking mode. Download the qa-verify-record artifacts of a period, then:
//
//   node qa/verify-record.ts [--labels labels.json] [--min-prs N] <record.jsonl or folder>...
//
// Each run that failed, or would have failed in advisory mode, has an id (<pr>:<sha>:<ticket>).
// A person labels it in labels.json: "false_block" when the pull request was fine (a wrong test, a
// wrong verdict, a broken environment) or "caught" when the check found a real problem. The check is
// ready to block when it saw at least N pull requests (10 by default), with no false block and no
// failure left unlabeled. With no model call.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Outcome {
  at: string; mode: 'blocking' | 'advisory'; pr: string; sha: string; ticket: string;
  step: 'prepare' | 'agent' | 'suite'; result: 'pass' | 'fail'; detail: string; agent: string;
}
export type Label = 'false_block' | 'caught';
export interface Run { id: string; pr: string; sha: string; ticket: string; mode: string; agent: string; failed: Outcome[] }
export interface TrackRecord {
  runs: number;
  pull_requests: number;
  failed_runs: Run[];
  by_step: Record<string, { pass: number; fail: number }>;
  by_agent: Record<string, { runs: number; failed: number }>;
  labels: { false_block: number; caught: number; unlabeled: string[] };
  ready_to_block: boolean;
  reasons: string[];
}

export const runId = (o: Pick<Outcome, 'pr' | 'sha' | 'ticket'>) => `${o.pr || '?'}:${(o.sha || '?').slice(0, 7)}:${o.ticket}`;

export function readOutcomes(paths: string[]): Outcome[] {
  const files = paths.flatMap((path) => (statSync(path).isDirectory()
    ? readdirSync(path, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')).map((f) => join(path, f))
    : [path]));
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line, i) => {
    const o = JSON.parse(line) as Outcome;
    if (!o.ticket || !['prepare', 'agent', 'suite'].includes(o.step) || !['pass', 'fail'].includes(o.result)) {
      throw new Error(`${file}:${i + 1}: not a QA verify outcome`);
    }
    return o;
  }));
}

export function trackRecord(outcomes: Outcome[], labels: Record<string, Label> = {}, minPrs = 10): TrackRecord {
  const runs = new Map<string, Run>();
  const byStep: TrackRecord['by_step'] = {};
  for (const o of outcomes) {
    const id = runId(o);
    const run = runs.get(id) ?? { id, pr: o.pr, sha: o.sha, ticket: o.ticket, mode: o.mode, agent: o.agent, failed: [] };
    if (o.result === 'fail') run.failed.push(o);
    runs.set(id, run);
    byStep[o.step] ??= { pass: 0, fail: 0 };
    byStep[o.step][o.result] += 1;
  }
  const all = [...runs.values()];
  const failed = all.filter((r) => r.failed.length);
  const byAgent: TrackRecord['by_agent'] = {};
  for (const r of all) {
    byAgent[r.agent] ??= { runs: 0, failed: 0 };
    byAgent[r.agent].runs += 1;
    if (r.failed.length) byAgent[r.agent].failed += 1;
  }
  for (const [id, label] of Object.entries(labels)) {
    if (label !== 'false_block' && label !== 'caught') throw new Error(`labels: ${id} must be "false_block" or "caught", got "${label}"`);
  }
  const falseBlocks = failed.filter((r) => labels[r.id] === 'false_block').length;
  const unlabeled = failed.filter((r) => !labels[r.id]).map((r) => r.id);
  const prs = new Set(all.map((r) => r.pr)).size;
  const reasons = [
    ...(prs < minPrs ? [`${prs} pull request(s) checked, ${minPrs} needed`] : []),
    ...(falseBlocks ? [`${falseBlocks} false block(s): the check failed on a pull request that was fine`] : []),
    ...(unlabeled.length ? [`${unlabeled.length} failure(s) not labeled yet`] : []),
  ];
  return {
    runs: all.length, pull_requests: prs, failed_runs: failed, by_step: byStep, by_agent: byAgent,
    labels: { false_block: falseBlocks, caught: failed.filter((r) => labels[r.id] === 'caught').length, unlabeled },
    ready_to_block: reasons.length === 0, reasons,
  };
}

export function recordMarkdown(t: TrackRecord, labels: Record<string, Label> = {}): string {
  const steps = Object.entries(t.by_step).map(([step, n]) => `${step} ${n.pass} pass, ${n.fail} fail`).join('; ');
  return [
    '# QA verify track record',
    '',
    `${t.runs} run(s) on ${t.pull_requests} pull request(s): ${steps || 'nothing recorded'}.`,
    '',
    `**Ready to block: ${t.ready_to_block ? 'yes' : 'not yet'}.**${t.reasons.length ? ` ${t.reasons.join('; ')}.` : ' Every failure was a real problem.'}`,
    '',
    ...(t.failed_runs.length ? [
      'Runs that failed or would have failed. Label each one in labels.json, `"<id>": "false_block"` or `"caught"`:',
      '',
      '| Id | Mode | Failed | Label |',
      '|---|---|---|---|',
      ...t.failed_runs.map((r) => `| \`${r.id}\` | ${r.mode} | ${r.failed.map((o) => `${o.step}: ${o.detail}`.replace(/\|/g, '/')).join('<br>')} | ${labels[r.id] ?? 'to label'} |`),
      '',
    ] : []),
    'By version of the agents (the `.claude` tree):',
    '',
    ...Object.entries(t.by_agent).map(([agent, n]) => `- \`${agent}\`: ${n.runs} run(s), ${n.failed} failed`),
    '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const take = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
    const labelsFile = take('--labels');
    const minArg = take('--min-prs');
    const minPrs = minArg === undefined ? 10 : Number(minArg);
    if (!Number.isInteger(minPrs) || minPrs < 1) throw new Error('--min-prs must be a whole number of 1 or more');
    if (!args.length) throw new Error('usage: node qa/verify-record.ts [--labels labels.json] [--min-prs N] <record.jsonl or folder>...');
    for (const path of args) if (!existsSync(path)) throw new Error(`${path} does not exist`);
    const labels = labelsFile ? JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<string, Label> : {};
    const t = trackRecord(readOutcomes(args), labels, minPrs);
    console.log(recordMarkdown(t, labels));
    process.exitCode = t.ready_to_block ? 0 : 1;
  } catch (error) {
    console.error(`QA verify record: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
