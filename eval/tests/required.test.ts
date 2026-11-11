import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import type { Campaign } from '../lib/history.ts';
import { CLAUDE_CODE, requirement } from '../lib/required.ts';
import { KIT } from '../lib/workspace.ts';

// A repository with the kit's agents, its evaluation code, the release baseline's two campaigns and its
// policy, on which pull requests are simulated with real commits. No model is called.
const COPIED = [
  'package.json', '.claude/agents/qa-writer.md', '.claude/agents/qa-verifier.md', '.claude/qa-settings.json', '.claude/hooks',
  'qa/run-qa.sh', 'qa/kit-integrity.sh', 'qa/criteria-manifest.ts', 'qa/ci-install-agents.sh', 'qa/ci-approval.sh',
  'eval/lib', 'eval/validate.ts', 'eval/required.ts', 'eval/compare-policy.json', 'eval/release-baseline.json',
  'eval/history/campaigns/gh-41605000003.json', 'eval/history/campaigns/gh-41605005317.json',
];

function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'qa-eval-required-'));
  for (const path of COPIED) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(KIT, path), join(dir, path), { recursive: true });
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD') };
}
function commit(dir: string, files: Record<string, string>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}
const append = (dir: string, path: string, text: string) => readFileSync(join(dir, path), 'utf8') + text;
/** A campaign of the history that ran the agents of `at`: a copy of a baseline campaign, as another version. */
function campaign(dir: string, at: string, id: string, change: Partial<Campaign['observations'][number]> = {}, role: Campaign['role'] = 'campaign'): Record<string, string> {
  const c = JSON.parse(readFileSync(join(dir, 'eval/history/campaigns/gh-41605000003.json'), 'utf8')) as Campaign;
  c.id = id;
  c.label = `candidate ${id}`;
  c.role = role;
  c.agent = { ...c.agent, id: `agent-${id}`, commit: at };
  c.observations = c.observations.map((o) => ({ ...o, ...change, fingerprint: `${id}-${o.key}` }));
  return { [`eval/history/campaigns/${id}.json`]: `${JSON.stringify(c, null, 2)}\n` };
}
function cli(dir: string, base: string, head: string, ...extra: string[]) {
  const r = spawnSync(process.execPath, [join(dir, 'eval/required.ts'), base, head, ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  return { code: r.status, out: r.stdout + r.stderr };
}
function inRepository(body: (r: ReturnType<typeof repository>) => void) {
  const r = repository();
  try { body(r); } finally { rmSync(r.dir, { recursive: true, force: true }); }
}

test('a pull request that leaves the agents alone needs no evaluation', () => inRepository(({ dir, base }) => {
  // A CI script, the installer outside its version line, and a document are not what the agents see.
  const head = commit(dir, {
    'README.md': 'notes\n',
    'qa/ci-approval.sh': append(dir, 'qa/ci-approval.sh', '# a comment\n'),
    'qa/ci-install-agents.sh': append(dir, 'qa/ci-install-agents.sh', '# another comment\n'),
  });
  assert.equal(requirement(dir, base, head).status, 'not_needed');
  const r = cli(dir, base, head);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /No change to what the QA agents see or can do/);
}));

test('a change of prompt, model, tools, settings, hooks, launcher or Claude Code version asks for one', () => inRepository(({ dir, base }) => {
  const cases: [string, Record<string, string>, string][] = [
    ['prompt', { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') }, '.claude/agents/qa-writer.md'],
    ['model', { '.claude/agents/qa-verifier.md': readFileSync(join(dir, '.claude/agents/qa-verifier.md'), 'utf8').replace(/^model: .*$/m, 'model: sonnet') }, '.claude/agents/qa-verifier.md'],
    ['settings', { '.claude/qa-settings.json': readFileSync(join(dir, '.claude/qa-settings.json'), 'utf8').replace('"WebSearch",', '') }, '.claude/qa-settings.json'],
    ['hook', { '.claude/hooks/qa-guard.sh': append(dir, '.claude/hooks/qa-guard.sh', '# x\n') }, '.claude/hooks'],
    ['launcher', { 'qa/run-qa.sh': append(dir, 'qa/run-qa.sh', '# x\n') }, 'qa/run-qa.sh'],
    ['session options', { 'qa/kit-integrity.sh': append(dir, 'qa/kit-integrity.sh', '# x\n') }, 'qa/kit-integrity.sh'],
    ['request', { 'qa/criteria-manifest.ts': append(dir, 'qa/criteria-manifest.ts', '// x\n') }, 'qa/criteria-manifest.ts'],
    ['Claude Code', { 'qa/ci-install-agents.sh': readFileSync(join(dir, 'qa/ci-install-agents.sh'), 'utf8').replace(/CLAUDE_CODE_VERSION:-[^}"]+/, 'CLAUDE_CODE_VERSION:-9.9.9') }, CLAUDE_CODE],
  ];
  for (const [what, files, part] of cases) {
    git(dir, 'checkout', '-q', '-B', `pr-${what.replace(/ /g, '-')}`, base);
    const head = commit(dir, files, what);
    const r = requirement(dir, base, head);
    assert.equal(r.status, 'missing', what);
    assert.deepEqual(r.changes, [part], what);
  }
}));

test('a change made on the base branch since the pull request branched off is not the pull request\'s', () => inRepository(({ dir, base }) => {
  git(dir, 'checkout', '-q', '-b', 'pr');
  const head = commit(dir, { 'README.md': 'notes\n' });
  git(dir, 'checkout', '-q', 'main');
  const main = commit(dir, { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') });
  assert.equal(requirement(dir, main, head).status, 'not_needed');
  assert.equal(requirement(dir, base, main).status, 'missing', 'the change is the base branch\'s own');
}));

test('without a campaign of the new version, the check fails and says what to do; a waiver lets it through', () => inRepository(({ dir, base }) => {
  const head = commit(dir, { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') });
  const r = cli(dir, base, head, '--branch', 'feature/x');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error title=QA eval required::This pull request changes what the QA agents see or can do: \.claude\/agents\/qa-writer\.md\./);
  assert.match(r.out, /QA eval → Run workflow, on the branch feature\/x, with tickets "smoke"/);
  assert.match(r.out, /add the label qa-eval-waived/);
  // The campaigns of the baseline ran on commits that are not in this repository: not compared, and said so.
  assert.match(r.out, /2 campaign\(s\) of the history ran on a commit that is not in this repository/);
  const waived = cli(dir, base, head, '--waived');
  assert.equal(waived.code, 0, waived.out);
  assert.match(waived.out, /::warning title=QA eval waived::/);
}));

test('a campaign of the new version lets the check through when its release decision does', () => inRepository(({ dir, base }) => {
  const evaluated = commit(dir, { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') });
  // The campaign is added after the run, with a document: the agents are those it ran.
  const head = commit(dir, { ...campaign(dir, evaluated, 'gh-1'), 'README.md': 'notes\n' });
  const r = requirement(dir, base, head);
  assert.equal(r.status, 'evaluated');
  assert.deepEqual(r.campaigns.map((c) => [c.id, c.commit]), [['gh-1', evaluated]]);
  const out = cli(dir, base, head);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /Evaluated by: gh-1 \(candidate gh-1, commit [0-9a-f]{7}\)/);
  assert.match(out.out, /Release decision: (accepted|review)/);
}));

test('a campaign whose release decision is rejected fails the check', () => inRepository(({ dir, base }) => {
  const evaluated = commit(dir, { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') });
  // Every trial changed a file other than a test: the main rule of the writer broke.
  const head = commit(dir, campaign(dir, evaluated, 'gh-2', { policy_ok: false, success: false }));
  const out = cli(dir, base, head);
  assert.equal(out.code, 1, out.out);
  assert.match(out.out, /Release decision: rejected/);
}));

test('a campaign of another version, a control or a dry run does not count', () => inRepository(({ dir, base }) => {
  const evaluated = commit(dir, { '.claude/agents/qa-writer.md': append(dir, '.claude/agents/qa-writer.md', '\nOne more rule.\n') });
  commit(dir, { ...campaign(dir, evaluated, 'gh-3'), ...campaign(dir, evaluated, 'gh-4', {}, 'control'), ...campaign(dir, evaluated, 'gh-5', {}, 'dry-run') });
  assert.deepEqual(requirement(dir, base, 'HEAD').campaigns.map((c) => c.id), ['gh-3']);
  // The settings changed after the campaign ran: it no longer measures the pull request's agents.
  const head = commit(dir, { '.claude/qa-settings.json': readFileSync(join(dir, '.claude/qa-settings.json'), 'utf8').replace('"WebSearch",', '') });
  const r = requirement(dir, base, head);
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.changes, ['.claude/agents/qa-writer.md', '.claude/qa-settings.json']);
}));
