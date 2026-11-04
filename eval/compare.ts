#!/usr/bin/env node
// Compares two agent versions from the campaigns of the history (eval/history/campaigns), with no
// model call. See eval/lib/compare.ts for the method, and eval/compare-policy.json for the rules.
// Usage:
//   node eval/compare.ts --a <campaign> [--a <campaign>...] --b <campaign> [--b <campaign>...]
//                        [--label-a <name>] [--label-b <name>] [--policy <file>] [--json <out.json>] [--md <out.md>]
// A campaign is named by its id (gh-<run id>), run id or label. Several campaigns of one agent can
// form a side (a campaign and its regression check, for instance). The Markdown report goes to the
// standard output unless --md is given. Exit codes: 0 accepted, 1 review, 2 rejected, 3 usage or data error.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compare, toMarkdown } from './lib/compare.ts';
import type { Policy } from './lib/compare.ts';
import { findCampaign, loadCampaigns } from './lib/history.ts';
import { KIT } from './lib/workspace.ts';

const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]] : []));
const one = (flag: string) => values(flag).at(-1);

try {
  const a = values('--a');
  const b = values('--b');
  if (!a.length || !b.length) throw new Error('usage: node eval/compare.ts --a <campaign>... --b <campaign>... [--label-a <name>] [--label-b <name>] [--policy <file>] [--json <out>] [--md <out>]');
  const campaigns = loadCampaigns(join(KIT, 'eval/history/campaigns'));
  const policyPath = one('--policy') ?? join(KIT, 'eval/compare-policy.json');
  const policyText = readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(policyText) as Policy;
  if (policy.schema_version !== 1) throw new Error(`${policyPath}: unknown policy schema ${policy.schema_version}`);
  const side = (keys: string[], label: string | undefined) => {
    const found = keys.map((k) => findCampaign(campaigns, k));
    return { label: label ?? found.map((c) => c.label).join(' + '), campaigns: found };
  };
  const result = compare(side(a, one('--label-a')), side(b, one('--label-b')), policy, policyText);
  const md = toMarkdown(result, policy);
  const json = one('--json');
  if (json) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  const mdOut = one('--md');
  if (mdOut) writeFileSync(mdOut, md);
  else console.log(md);
  if (mdOut || json) console.error(`${result.a.label} → ${result.b.label}: ${result.decision.verdict}`);
  process.exitCode = result.decision.verdict === 'accepted' ? 0 : result.decision.verdict === 'review' ? 1 : 2;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 3;
}
