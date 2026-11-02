#!/usr/bin/env node
// One evaluation trial of the QA agents on one ticket, in separate steps so that CI can keep
// the API key out of the steps that run tests on the application:
//   prepare  fresh workspace (copy of the shop, own node_modules, git baseline) and the ticket
//   write    phase 1 with the unchanged kit (qa/run-qa.sh); needs the claude CLI and the API key
//   score    no model call: the generated tests run on the shop as it is, on the reference
//            implementation (3 repeats) and on each injected bug
//   verify   phase 2 on the reference implementation, then on the first bug, after an approval
//            that is scripted and labelled as such; needs the API key
//   finish   writes trial.json, the input of eval/lib/aggregate.ts
// Usage: node eval/trial.ts <prepare|write|score|verify|finish> <TICKET> <TRIAL>
// Folders: EVAL_WORK (default: <tmp>/agent-qa-eval) holds <TICKET>-<TRIAL>/{ws,out,state.json}.
// EVAL_IN_PLACE=1 (CI, one fresh runner per trial): the agents work in examples/shop of the
// checkout itself, with the dependencies npm ci installed, exactly as in "QA write tests". The
// copied workspace used otherwise had the shop's dev server drop connections inside the sandbox.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { APP, KIT, applyDiff, classifyChanges, copyApp, loadTicket, makeVariant, merge, runPlaywright, runVitest } from './lib/workspace.ts';
import { scoreTrial } from './lib/score.ts';
import { buildManifest } from '../qa/criteria-manifest.ts';
import type { AgentRun, TrialRecord, VariantResult } from './lib/score.ts';

const [command, ticketName, trialArg] = process.argv.slice(2);
if (!['prepare', 'write', 'score', 'verify', 'finish'].includes(command) || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticketName ?? '') || !/^\d+$/.test(trialArg ?? '')) {
  console.error('usage: node eval/trial.ts <prepare|write|score|verify|finish> <TICKET> <TRIAL>');
  process.exit(2);
}
const trial = Number(trialArg);
const root = join(process.env.EVAL_WORK || join(tmpdir(), 'agent-qa-eval'), `${ticketName}-${trial}`);
const IN_PLACE = process.env.EVAL_IN_PLACE === '1';
const ws = IN_PLACE ? APP : join(root, 'ws');
// In place, the untouched shop is saved here first: the variants are built from it.
const pristine = IN_PLACE ? join(root, 'pristine') : APP;
const out = join(root, 'out');
const statePath = join(root, 'state.json');
const specPath = join(root, 'spec.md');

interface State {
  ticket: string;
  trial: number;
  kind: TrialRecord['kind'];
  criteria: string[];
  bugs: TrialRecord['bugs'];
  started_at: string;
  finished_at?: string;
  phase1?: AgentRun;
  generated_test_files?: string[];
  changed_non_test_files?: string[];
  sandbox_placeholders?: string[];
  variants?: TrialRecord['variants'];
  phase2?: TrialRecord['phase2'];
}

const readState = (): State => JSON.parse(readFileSync(statePath, 'utf8')) as State;
const saveState = (state: State) => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const readJson = (path: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
};

function git(...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'core.quotepath=false', ...args], { cwd: ws, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

/** Files changed in the workspace since its baseline, with paths relative to the workspace. */
function changedFiles(): { code: string; path: string }[] {
  // Porcelain paths are relative to the repository root; in place, that root is two folders up.
  const prefix = git('rev-parse', '--show-prefix').trim();
  return git('status', '--porcelain', '--untracked-files=all', '--', '.').split('\n').filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).replace(/^"|"$/g, '') }))
    .map((f) => ({ ...f, path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path }));
}

/** The last JSON object of a model's answer, when the kit could not validate it. */
function lastJsonObject(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  for (const candidate of [...blocks.reverse(), start >= 0 && end > start ? text.slice(start, end + 1) : '']) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  }
  return null;
}

/** Runs qa/run-qa.sh for one phase and reads what it produced. */
function runPhase(phase: 1 | 2, label: string): AgentRun {
  const started = Date.now();
  const run = spawnSync('bash', [join(KIT, 'qa/run-qa.sh'), ticketName, String(phase), specPath, 'shop'], {
    cwd: KIT,
    encoding: 'utf8',
    timeout: 45 * 60_000,
    // Phase 2 measures the verifier's verdict only: the full suite stays out of this process, which
    // holds the API key, as in qa-verify.yml. CI keeps its value, so Playwright runs one worker, as
    // in phase 1 and in the kit's own CI: several workers against one dev server in the sandbox
    // made the browser tests time out.
    env: { ...process.env, QA_PROJECT_DIR: ws, ...(phase === 2 ? { QA_FULL_SUITE: 'later' } : {}) },
  });
  writeFileSync(join(out, `${label}.log`), `${run.stdout ?? ''}\n--- stderr ---\n${run.stderr ?? ''}`);
  const runJson = readJson(join(ws, `reports/${ticketName}-phase${phase}-run.json`));
  const verdictJson = readJson(join(ws, `reports/${ticketName}-phase${phase}.json`)) ?? lastJsonObject(runJson?.result);
  for (const suffix of ['', '-run']) {
    const file = join(ws, `reports/${ticketName}-phase${phase}${suffix}.json`);
    if (existsSync(file)) copyFileSync(file, join(out, `${label}${suffix}.json`));
  }
  const exit = run.status ?? 3;
  const criteria = Array.isArray(verdictJson?.criteria) ? verdictJson.criteria as { status?: string }[] : [];
  const isError = runJson?.is_error === true || (exit === 3 && !runJson);
  return {
    exit_code: exit,
    verdict: exit === 3 ? null : typeof verdictJson?.verdict === 'string' ? verdictJson.verdict : null,
    cost_usd: typeof runJson?.total_cost_usd === 'number' ? runJson.total_cost_usd : 0,
    duration_ms: typeof runJson?.duration_ms === 'number' ? runJson.duration_ms : Date.now() - started,
    num_turns: typeof runJson?.num_turns === 'number' ? runJson.num_turns : null,
    is_error: isError,
    ...(exit === 3 ? { error: (run.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 500) } : {}),
    spec_questions: Array.isArray(verdictJson?.spec_questions) ? verdictJson.spec_questions.length : 0,
    untestable: criteria.filter((c) => c?.status === 'untestable').length,
  };
}

function findTranscript(sessionId: string): string | null {
  const projects = join(homedir(), '.claude/projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

const ticket = loadTicket(ticketName);

if (command === 'prepare') {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  if (IN_PLACE) {
    const dirty = changedFiles();
    if (dirty.length) throw new Error(`examples/shop must be untouched before a trial in place: ${dirty.map((f) => f.path).join(', ')}`);
    copyApp(pristine);
  } else {
    copyApp(ws, { link: false });
    // The shop finds the kit's summary script through a path relative to examples/shop; the
    // workspace lives elsewhere, so it points to the script directly (part of the baseline commit).
    const pkgPath = join(ws, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts['test:summary'] = `node ${join(KIT, 'qa/summary.ts')}`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'baseline');
  }
  copyFileSync(ticket.spec, specPath);
  const criteria = buildManifest(ticketName, readFileSync(specPath, 'utf8')).criteria.map((c) => c.id);
  saveState({ ticket: ticketName, trial, kind: ticket.kind, criteria, bugs: ticket.bugs, started_at: new Date().toISOString() });
  console.log(`Prepared ${ticketName} trial ${trial} in ${root}`);
}

if (command === 'write') {
  const state = readState();
  const dryRun = process.env.EVAL_DRY_RUN_TESTS;
  if (dryRun) {
    // Checks the harness without a model: the given files stand in for the agent's tests.
    const copy = (from: string, rel = '') => {
      for (const name of readdirSync(join(from, rel))) {
        const path = join(rel, name);
        if (statSync(join(from, path)).isDirectory()) { copy(from, path); continue; }
        mkdirSync(dirname(join(ws, path)), { recursive: true });
        copyFileSync(join(from, path), join(ws, path));
      }
    };
    copy(dryRun);
    state.phase1 = { exit_code: 0, verdict: 'ready', cost_usd: 0, duration_ms: 0, num_turns: 0, is_error: false, error: 'dry run: no agent', spec_questions: 0, untestable: 0 };
  } else {
    state.phase1 = runPhase(1, 'phase1');
  }
  // Only new test files are allowed: a changed tracked file or any other new file breaks the writer's rules.
  const changes = classifyChanges(changedFiles().map((f) => {
    const full = join(ws, f.path);
    return { ...f, size: existsSync(full) && statSync(full).isFile() ? statSync(full).size : -1 };
  }));
  state.generated_test_files = changes.tests;
  state.changed_non_test_files = changes.others;
  state.sandbox_placeholders = changes.placeholders;
  for (const file of state.generated_test_files) {
    mkdirSync(dirname(join(out, 'generated', file)), { recursive: true });
    copyFileSync(join(ws, file), join(out, 'generated', file));
  }
  const runJson = readJson(join(ws, `reports/${ticketName}-phase1-run.json`));
  const transcript = typeof runJson?.session_id === 'string' ? findTranscript(runJson.session_id) : null;
  if (transcript) {
    copyFileSync(transcript, join(out, 'phase1-transcript.jsonl'));
    // Each action the guard hook refused shows up once in the transcript.
    state.phase1.guard_blocks = (readFileSync(transcript, 'utf8').match(/Blocked by QA guard/g) ?? []).length;
  }
  saveState(state);
  console.log(`Phase 1: exit ${state.phase1.exit_code}, verdict ${state.phase1.verdict}, $${state.phase1.cost_usd}, ${state.generated_test_files.length} new test file(s), ${state.changed_non_test_files.length} other change(s)`);
}

if (command === 'score') {
  const state = readState();
  const files = state.generated_test_files ?? [];
  const unit = files.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f));
  const e2e = files.filter((f) => /\.spec\.[cm]?[jt]sx?$/.test(f));
  const variants: TrialRecord['variants'] = { bugs: {} };
  if (ticket.kind !== 'ambiguous' && existsSync(join(ticket.dir, 'gold.diff')) && files.length) {
    const run = (variant: string, repeatEach: number): VariantResult => {
      const dir = join(root, 'variants', variant);
      makeVariant(ticket, variant, dir, pristine);
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(join(ws, file), join(dir, file));
      }
      const result = merge(runVitest(dir, unit, ticketName), runPlaywright(dir, e2e, ticketName, { repeatEach }));
      rmSync(dir, { recursive: true, force: true });
      console.log(`  ${variant}: ${result.tests.map((t) => t.status).join(' ') || 'no test'}${result.error ? ` (${result.error.slice(0, 120)})` : ''}`);
      return result;
    };
    variants.base = run('base', 1);
    variants.gold = run('gold', 3);
    for (const bug of ticket.bugs) variants.bugs[bug.id] = run(bug.id, 1);
  }
  state.variants = variants;
  saveState(state);
  writeFileSync(join(out, 'variants.json'), `${JSON.stringify(variants, null, 2)}\n`);
  console.log(`Scored ${files.length} generated test file(s) on ${Object.keys(variants.bugs).length + (variants.gold ? 2 : 0)} variant(s).`);
}

if (command === 'verify') {
  const state = readState();
  const firstBug = ticket.bugs[0];
  if (state.phase1?.verdict !== 'ready' || ticket.kind === 'ambiguous' || !existsSync(join(ticket.dir, 'gold.diff'))) {
    console.log('Phase 2 skipped: phase 1 did not produce approved-ready tests, or the ticket has no reference implementation.');
  } else {
    // A scripted approval, used only to measure phase 2: it is not a human review.
    const reasons = join(root, 'approval.txt');
    writeFileSync(reasons, `${state.criteria.map((id) => `${id}: automated evaluation approval, not a human review`).join('\n')}\n`);
    const approve = spawnSync('node', [join(KIT, 'qa/scenario-review.ts'), 'approve-review', ticketName, specPath, 'eval-harness', reasons], { cwd: ws, encoding: 'utf8' });
    if (approve.status !== 0) throw new Error(`scripted approval failed: ${approve.stderr}`);
    state.phase2 = {};
    applyDiff(ws, join(ticket.dir, 'gold.diff'));
    state.phase2.gold = runPhase(2, 'phase2-gold');
    if (firstBug) {
      applyDiff(ws, join(ticket.dir, 'bugs', `${firstBug.id}.diff`));
      state.phase2.bug = { ...runPhase(2, 'phase2-bug'), id: firstBug.id };
    }
    console.log(`Phase 2: gold exit ${state.phase2.gold.exit_code}${state.phase2.bug ? `, bug ${firstBug.id} exit ${state.phase2.bug.exit_code}` : ''}`);
  }
  saveState(state);
}

if (command === 'finish') {
  const state = readState();
  const failedPhase1: AgentRun = { exit_code: 3, verdict: null, cost_usd: 0, duration_ms: null, num_turns: null, is_error: true, error: 'phase 1 did not run', spec_questions: 0, untestable: 0 };
  const record: TrialRecord = {
    schema_version: 1,
    ticket: state.ticket,
    trial: state.trial,
    kind: state.kind,
    criteria: state.criteria,
    started_at: state.started_at,
    finished_at: new Date().toISOString(),
    phase1: state.phase1 ?? failedPhase1,
    changed_non_test_files: state.changed_non_test_files ?? [],
    sandbox_placeholders: state.sandbox_placeholders ?? [],
    generated_test_files: state.generated_test_files ?? [],
    bugs: state.bugs,
    variants: state.variants ?? { bugs: {} },
    phase2: state.phase2 ?? null,
  };
  writeFileSync(join(out, 'trial.json'), `${JSON.stringify(record, null, 2)}\n`);
  const score = scoreTrial(record);
  console.log(JSON.stringify({ ticket: score.ticket, trial: score.trial, success: score.success, red_valid: score.red_valid, f2p: `${score.f2p.filter((u) => u.ok).length}/${score.f2p.length}`, bugs: score.bugs, false_positives: score.false_positives.length, policy_ok: score.policy_ok, verifier: score.verifier, cost_usd: score.cost_usd }));
  const size = (dir: string): number => readdirSync(dir).reduce((sum, name) => { const p = join(dir, name); const s = statSync(p); return sum + (s.isDirectory() ? size(p) : s.size); }, 0);
  console.log(`Artifacts in ${out} (${Math.round(size(out) / 1024)} KiB)`);
}
