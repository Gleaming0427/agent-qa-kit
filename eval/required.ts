#!/usr/bin/env node
// Whether a pull request that changes the QA agents was evaluated, with no model call (eval/lib/required.ts).
//   node eval/required.ts <base> <head> [--repo <dir>] [--waived] [--branch <name>]
// --repo: the repository holding the pull request (default: this kit). In CI, this script runs from a
//   copy of the base branch and --repo is the pull request's checkout, so that a pull request does not
//   judge itself; both share the git objects.
// --waived: a person said this change needs no evaluation (the label qa-eval-waived).
// When a campaign of the history ran the pull request's agents, its release decision against the
// baseline decides, as in QA eval: eval/validate.ts --ci, with the rules at the campaign's commit.
// Exit: 0 no evaluation needed, waived, or a decision that the policy lets through; 1 an evaluation is
// missing, or its decision fails; 3 usage or data error.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { missingMessage, requirement } from './lib/required.ts';
import { KIT } from './lib/workspace.ts';

const args = process.argv.slice(2);
const option = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--repo', '--branch'].includes(args[i - 1]));
const summary = (text: string) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`); };

try {
  const [base, head] = positional;
  if (!base || !head || positional.length > 2) throw new Error('usage: node eval/required.ts <base> <head> [--repo <dir>] [--waived] [--branch <name>]');
  const repo = resolve(option('--repo') ?? KIT);
  const r = requirement(repo, base, head, { waived: args.includes('--waived') });
  const changed = r.changes.map((c) => `- ${c}`).join('\n');
  // Most campaigns ran on branches merged by squash since: their commits are gone, which is expected.
  if (r.unreadable.length) console.log(`${r.unreadable.length} campaign(s) of the history ran on a commit that is not in this repository, and were not compared.`);
  if (r.status === 'not_needed') {
    const text = 'No change to what the QA agents see or can do: no evaluation is needed.';
    console.log(text);
    summary(`# QA eval required\n\n${text}`);
  } else if (r.status === 'waived') {
    console.log(`::warning title=QA eval waived::The agents changed (${r.changes.join(', ')}), and the label qa-eval-waived says no evaluation is needed.`);
    summary(`# QA eval required\n\nThe agents changed, and the label \`qa-eval-waived\` says no evaluation is needed:\n\n${changed}`);
  } else if (r.status === 'missing') {
    // A branch name comes from the pull request: only a plain one goes into the message.
    const branch = option('--branch');
    const message = missingMessage(r, branch && /^[\w./-]{1,200}$/.test(branch) ? branch : 'of this pull request');
    console.log(`::error title=QA eval required::${message.replace(/\n/g, '%0A')}`);
    console.error(message);
    summary(`# QA eval required\n\n${message.split('\n').join('\n\n')}`);
    process.exitCode = 1;
  } else {
    const list = r.campaigns.map((c) => `${c.id} (${c.label}, commit ${c.commit.slice(0, 7)})`);
    console.log(`The agents changed (${r.changes.join(', ')}). Evaluated by: ${list.join(', ')}.`);
    summary(`# QA eval required\n\nThe agents changed:\n\n${changed}\n\nThe history holds campaigns of this version: ${list.join(', ')}. Their release decision follows.\n`);
    // The decision of these campaigns, against the baseline of this copy of the kit.
    const validate = spawnSync(process.execPath, [join(KIT, 'eval/validate.ts'), ...r.campaigns.flatMap((c) => ['--candidate', c.file]), '--ci'], { stdio: 'inherit' });
    process.exitCode = validate.status === 0 ? 0 : validate.status === 1 ? 1 : 3;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 3;
}
