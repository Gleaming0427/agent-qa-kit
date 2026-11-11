// What a pull request must show before it changes the QA agents: an evaluation of the new version.
//
// An agent is evaluated again at every change of its prompt, its model, its tools or the version of
// the SDK that runs it. This reads, with git, what the agents see and can do at a commit (their
// surface): the files of the writer and the verifier (prompt, model, effort, tools), their settings,
// the hooks, the launcher and what it builds the request with, and the version of Claude Code the
// workflows install. A pull request that changes one of them needs a campaign of the history that
// ran the same surface; the release decision of that campaign (eval/validate.ts) then applies.
//
// The surface is narrower than the agent's version of the history (agentVersion in history.ts), which
// also counts every script of qa/: a change to a CI script changes that version, so that two campaigns
// are not compared as if nothing changed, but not what the agents do, and asks for no evaluation.
// The repair agent is not in it either: the evaluation does not run it.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCodeVersion } from './history.ts';
import type { Campaign } from './history.ts';

/** The paths whose content is the agents' surface: a file or a folder, as git stores it. */
export const SURFACE_PATHS = [
  '.claude/agents/qa-writer.md',
  '.claude/agents/qa-verifier.md',
  '.claude/qa-settings.json',
  '.claude/hooks',
  'qa/run-qa.sh',
  'qa/kit-integrity.sh',
  'qa/criteria-manifest.ts',
] as const;
export const CLAUDE_CODE = 'Claude Code version (qa/ci-install-agents.sh)';

/** The git object of each path of the surface (null when it does not exist), and the Claude Code version. */
export type Surface = Record<string, string | null>;

function git(repo: string, ...args: string[]): string | null {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return run.status === 0 ? run.stdout : null;
}
const isCommit = (repo: string, commit: string) => /^[0-9a-f]{7,64}$/i.test(commit) && git(repo, 'cat-file', '-e', `${commit}^{commit}`) !== null;

export function agentSurface(repo: string, commit: string): Surface {
  const surface: Surface = {};
  for (const path of SURFACE_PATHS) surface[path] = git(repo, 'rev-parse', '--verify', '--quiet', `${commit}:${path}`)?.trim() || null;
  surface[CLAUDE_CODE] = claudeCodeVersion(git(repo, 'show', `${commit}:qa/ci-install-agents.sh`));
  return surface;
}

/** The parts of the surface that differ, in the order of SURFACE_PATHS. */
export const surfaceChanges = (a: Surface, b: Surface) => [...SURFACE_PATHS, CLAUDE_CODE].filter((key) => a[key] !== b[key]);

export interface EvaluatedBy { file: string; id: string; label: string; commit: string }
export interface Requirement {
  /** not_needed: the surface did not change; waived: it did, and a person said no evaluation is needed;
   * missing: no campaign of the history ran it; evaluated: at least one did. */
  status: 'not_needed' | 'waived' | 'missing' | 'evaluated';
  branch_point: string;
  changes: string[];
  campaigns: EvaluatedBy[];
  /** Campaigns of the history whose commit is not in the repository: they could not be compared. */
  unreadable: string[];
}

/**
 * What the pull request from `base` to `head` needs. What it changes is what `head` holds since the
 * commit it branched from (git merge-base), so a change on `base` since then does not count.
 * The campaigns are those of `<repo>/eval/history/campaigns`; only a real campaign counts, not a
 * control or a dry run.
 */
export function requirement(repo: string, base: string, head: string, options: { waived?: boolean } = {}): Requirement {
  for (const commit of [base, head]) if (git(repo, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`) === null) throw new Error(`${commit}: not a commit of ${repo}`);
  const point = git(repo, 'merge-base', base, head)?.trim();
  if (!point) throw new Error(`${base} and ${head} have no common commit`);
  const after = agentSurface(repo, head);
  const changes = surfaceChanges(agentSurface(repo, point), after);
  const result: Requirement = { status: 'not_needed', branch_point: point, changes, campaigns: [], unreadable: [] };
  if (!changes.length) return result;
  if (options.waived) return { ...result, status: 'waived' };
  const dir = join(repo, 'eval/history/campaigns');
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
  for (const name of files) {
    const campaign = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Campaign;
    if (campaign.role !== 'campaign') continue;
    const commit = campaign.agent?.commit ?? '';
    if (!isCommit(repo, commit)) { result.unreadable.push(campaign.id); continue; }
    if (surfaceChanges(agentSurface(repo, commit), after).length === 0) {
      result.campaigns.push({ file: join(dir, name), id: campaign.id, label: campaign.label, commit });
    }
  }
  return { ...result, status: result.campaigns.length ? 'evaluated' : 'missing' };
}

/** What to do when the evaluation is missing, for a person reading the check. */
export function missingMessage(r: Requirement, branch: string): string {
  return [
    `This pull request changes what the QA agents see or can do: ${r.changes.join(', ')}.`,
    'An evaluation of this version is needed before it is merged, and the history has none:',
    `1. Actions → QA eval → Run workflow, on the branch ${branch}, with tickets "smoke" (under $5) or "all";`,
    '2. add the run\'s eval-report.json to the history (eval/history/README.md, "Adding a campaign") and push it to the branch.',
    'The check then applies the release decision of that campaign (eval/validate.ts).',
    'A change that needs no evaluation, such as a comment in a prompt: add the label qa-eval-waived to the pull request.',
  ].join('\n');
}
