#!/usr/bin/env node
// Release decision: the new version (candidate) against the release baseline, with no model call.
// See eval/lib/validate.ts.
//   node eval/validate.ts --candidate <campaign file or id or label> [--candidate ...]
//                         [--baseline <id or label> ...] [--policy-current] [--ci] [--md <out>] [--json <out>]
// --candidate: a campaign file (the eval-history.json of a QA eval run) or a campaign of the history;
//   several form one version, such as a run and the rerun of some of its tickets.
// --baseline: the reference campaigns; by default those of eval/release-baseline.json.
// The rules are eval/compare-policy.json at the candidate's commit. --policy-current applies today's
// file to a campaign that ran before the rules existed, and the report says so.
// --ci: annotations for the run page, the report in the step summary, and a failing exit code only
//   for the verdicts of the policy's ci.fail_on. Without --ci: 0 accepted, 1 review, 2 rejected.
// 3: usage or data error.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare, toMarkdown } from './lib/compare.ts';
import type { Policy } from './lib/compare.ts';
import { findCampaign, loadCampaigns } from './lib/history.ts';
import type { Campaign } from './lib/history.ts';
import { annotations, failsCi, nextSteps, policyAt, validationMarkdown } from './lib/validate.ts';
import type { PolicySource } from './lib/validate.ts';
import { KIT } from './lib/workspace.ts';

const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []));
const one = (flag: string) => values(flag).at(-1);
const has = (flag: string) => args.includes(flag);

try {
  const history = loadCampaigns(join(KIT, 'eval/history/campaigns'));
  const load = (key: string): Campaign => (key.endsWith('.json') && existsSync(key) ? JSON.parse(readFileSync(key, 'utf8')) as Campaign : findCampaign(history, key));
  const candidates = values('--candidate').map(load);
  if (!candidates.length) throw new Error('usage: node eval/validate.ts --candidate <campaign>... [--baseline <campaign>...] [--policy-current] [--ci] [--md <out>] [--json <out>]');
  if (candidates.every((c) => c.role === 'dry-run')) {
    const note = 'No release decision for a dry run: no agent ran.';
    console.log(note);
    if (has('--ci') && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# Release decision\n\n${note}\n`);
    process.exit(0);
  }
  const baselineFile = JSON.parse(readFileSync(join(KIT, 'eval/release-baseline.json'), 'utf8')) as { label: string; campaigns: string[] };
  const baselineKeys = values('--baseline').length ? values('--baseline') : baselineFile.campaigns;
  const baseline = baselineKeys.map((k) => findCampaign(history, k));

  // The rules in force when the candidate ran: the policy file at its commit.
  const first = [...candidates].sort((a, b) => (a.source.started_at ?? '').localeCompare(b.source.started_at ?? ''))[0];
  const commit = first.agent.commit;
  const current = readFileSync(join(KIT, 'eval/compare-policy.json'), 'utf8');
  const texts = new Set(candidates.map((c) => policyAt(KIT, c.agent.commit)));
  if (texts.size > 1) throw new Error('the candidate campaigns ran under different rules (eval/compare-policy.json differs between their commits): validate them one by one');
  let policyText = [...texts][0];
  let source: PolicySource = { commit, from: 'commit', differs_from_current: policyText !== current };
  if (policyText === null) {
    if (!has('--policy-current')) {
      throw new Error(`the candidate's commit ${commit.slice(0, 7)} has no eval/compare-policy.json: its rules would be written after its results. Pass --policy-current to apply today's rules anyway; the report will say so.`);
    }
    policyText = current;
    source = { commit, from: 'current', differs_from_current: false };
  }
  const policy = JSON.parse(policyText) as Policy;
  const result = compare(
    { label: values('--baseline').length ? baseline.map((c) => c.label).join(' + ') : baselineFile.label, campaigns: baseline },
    { label: candidates.map((c) => c.label).join(' + '), campaigns: candidates },
    policy, policyText,
  );
  const steps = nextSteps(result, policy);
  const md = validationMarkdown(result, policy, steps, source, toMarkdown(result, policy));
  const json = one('--json');
  if (json) writeFileSync(json, `${JSON.stringify({ policy_source: source, next_steps: steps, comparison: result }, null, 2)}\n`);
  const mdOut = one('--md');
  if (mdOut) writeFileSync(mdOut, md);
  if (has('--ci')) {
    for (const line of annotations(result, policy)) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    console.log(`Release decision: ${result.decision.verdict}`);
    process.exitCode = failsCi(result.decision.verdict, policy) ? 1 : 0;
  } else {
    if (!mdOut) console.log(md);
    process.exitCode = { accepted: 0, review: 1, rejected: 2 }[result.decision.verdict];
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 3;
}
