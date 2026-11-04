#!/usr/bin/env node
// One evaluation trial of the QA agents on one ticket, in steps that CI runs on separate runners,
// so that no runner where an agent works ever holds the corpus, and the code an agent wrote never
// runs next to a secret:
//
//   agent runner (the agent bundle, no corpus; the API key in the write step only)
//     prepare  the workspace and the ticket's spec. Reads no other file of the corpus.
//     write    phase 1 with the unchanged kit (qa/run-qa.sh), then packs what the agent produced.
//   scoring runner (a checkout with the corpus; no secret)
//     score    no model call: the generated tests run, in a sandbox (EVAL_SANDBOX=bwrap), on the
//              shop as it is, on the reference implementation (3 repeats) and on each injected bug.
//              Writes the implementations for phase 2 under neutral names.
//   verifier runner (the agent bundle, no corpus; the API key)
//     verify   phase 2 on the two implementations it was given, after an approval that is scripted
//              and labelled as such. It does not know which one is the reference.
//   report runner
//     finish   assembles trial.json, the input of eval/lib/aggregate.ts, from the three parts.
//
// Usage: node eval/trial.ts <prepare|write|score|verify|finish> <TICKET> <TRIAL>
//        node eval/trial.ts finish-all          (every trial folder under EVAL_WORK)
// Folders: EVAL_WORK (default: <tmp>/agent-qa-eval) holds <TICKET>-<TRIAL>/, with one folder per
// runner: agent/, score/, verify-input/, verify/, and trial/ for the assembled record. In CI, each
// is that runner's artifact. Locally, all steps run on one machine and share them.
// EVAL_IN_PLACE=1 (CI, one fresh runner per job): the agents work in examples/shop itself, with the
// dependencies npm ci installed, as in "QA write tests", in a git repository of its own. The copied
// workspace used otherwise had the shop's dev server drop connections inside the sandbox.
// EVAL_DRY_RUN=1: no model call. The agent step writes nothing; the scoring step puts the hidden
// tests in place of the agent's, and gives the ambiguous ticket its right answer, blocked.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { APP, KIT, TICKETS, applyDiff, classifyChanges, copyApp, loadTicket, makeVariant, merge, runPlaywright, runVitest } from './lib/workspace.ts';
import { BUNDLE_SPECS, corpusFingerprints, isGenerated, listFiles, publicTexts, scanForCorpus, sha256 } from './lib/isolation.ts';
import type { BundleManifest } from './lib/isolation.ts';
import { sandboxMode } from './lib/sandbox.ts';
import { scoreTrial, tokensFromModelUsage } from './lib/score.ts';
import { guardBlocks, toolHealth } from './lib/transcript.ts';
import { buildManifest } from '../qa/criteria-manifest.ts';
import type { AgentRun, Bug, Isolation, Kind, TrialRecord, VariantResult } from './lib/score.ts';

const WORK = process.env.EVAL_WORK || join(tmpdir(), 'agent-qa-eval');
const IN_PLACE = process.env.EVAL_IN_PLACE === '1';
const DRY_RUN = process.env.EVAL_DRY_RUN === '1';

/** What the agent's runner sends back. It never holds the ticket's kind, bugs or anything of the corpus but the spec. */
interface AgentState {
  ticket: string;
  trial: number;
  criteria: string[];
  /** The agent runner's own work, from prepare to the end of write: installs and queueing are left out. */
  started_at: string;
  finished_at?: string;
  dry_run: boolean;
  bundle_verified: boolean;
  phase1?: AgentRun;
  generated_test_files?: string[];
  changed_non_test_files?: string[];
  sandbox_placeholders?: string[];
}
/** What the scoring runner adds. */
interface ScoreState {
  schema_version: 1;
  ticket: string;
  kind: Kind;
  bugs: Bug[];
  /** Dry run: phase 1's stand-in verdict and the hidden tests that stood in for the agent's. */
  dry_run?: { phase1: AgentRun; generated_test_files: string[] };
  variants: TrialRecord['variants'];
  /** Which neutral name the verifier got for which implementation. */
  implementations: Record<string, 'gold' | { bug: string }>;
  isolation: Isolation;
  error?: string;
  /** The scoring runner's own work. */
  started_at: string;
  finished_at: string;
}
/** What the verifier's runner sends back, by the neutral name of the implementation; times only when phase 2 ran. */
interface VerifyState { skipped?: string; runs: Record<string, AgentRun>; started_at?: string; finished_at?: string }

const readJson = <T = Record<string, unknown>>(path: string): T | null => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
};
const writeJson = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

function trialPaths(ticket: string, trial: number) {
  const root = join(WORK, `${ticket}-${trial}`);
  return {
    root,
    agent: join(root, 'agent'),
    agentOut: join(root, 'agent/out'),
    agentState: join(root, 'agent/state.json'),
    spec: join(root, 'agent/spec.md'),
    workspaceTar: join(root, 'agent/workspace.tar'),
    ws: IN_PLACE ? APP : join(root, 'ws'),
    // In place, the untouched shop is saved here first when the scoring runs on the same machine.
    pristine: join(root, 'pristine'),
    score: join(root, 'score/score.json'),
    scoreDir: join(root, 'score'),
    verifyInput: join(root, 'verify-input'),
    verify: join(root, 'verify/phase2.json'),
    verifyOut: join(root, 'verify/out'),
    trial: join(root, 'trial'),
  };
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
const insideRepository = (cwd: string) => spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8' }).status === 0;

/** Files changed in the workspace since its baseline, with paths relative to the workspace. */
function changedFiles(ws: string): { code: string; path: string }[] {
  // Porcelain paths are relative to the repository root. In place, before the workspace gets its own
  // repository, that root is the checkout's, two folders up.
  const prefix = git(ws, 'rev-parse', '--show-prefix').trim();
  return git(ws, 'status', '--porcelain', '--untracked-files=all', '--', '.').split('\n').filter(Boolean)
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

function findTranscript(sessionId: string): string | null {
  const projects = join(homedir(), '.claude/projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Copies a session's transcript into out/ as <label>-transcript.jsonl, and its subagents' into
 * <label>-subagents/ (they sit in <project>/<session id>/subagents/), and returns their text.
 */
function keepTranscripts(out: string, sessionId: string, label: string): { texts: string[]; subagents: number } | null {
  const transcript = findTranscript(sessionId);
  if (!transcript) return null;
  copyFileSync(transcript, join(out, `${label}-transcript.jsonl`));
  const subagentDir = join(dirname(transcript), sessionId, 'subagents');
  const subagents = existsSync(subagentDir) ? readdirSync(subagentDir).filter((f) => f.endsWith('.jsonl')) : [];
  if (subagents.length) mkdirSync(join(out, `${label}-subagents`), { recursive: true });
  for (const file of subagents) copyFileSync(join(subagentDir, file), join(out, `${label}-subagents`, file));
  return { texts: [transcript, ...subagents.map((f) => join(subagentDir, f))].map((f) => readFileSync(f, 'utf8')), subagents: subagents.length };
}

/** Runs qa/run-qa.sh for one phase in the workspace and reads what it produced; logs go to out/<label>*. */
function runPhase(ticket: string, ws: string, spec: string, out: string, phase: 1 | 2, label: string): AgentRun {
  mkdirSync(out, { recursive: true });
  const started = Date.now();
  const run = spawnSync('bash', [join(KIT, 'qa/run-qa.sh'), ticket, String(phase), spec, 'shop'], {
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
  const runJson = readJson(join(ws, `reports/${ticket}-phase${phase}-run.json`));
  const verdictJson = readJson(join(ws, `reports/${ticket}-phase${phase}.json`)) ?? lastJsonObject(runJson?.result);
  for (const suffix of ['', '-run']) {
    const file = join(ws, `reports/${ticket}-phase${phase}${suffix}.json`);
    if (existsSync(file)) copyFileSync(file, join(out, `${label}${suffix}.json`));
  }
  const exit = run.status ?? 3;
  const criteria = Array.isArray(verdictJson?.criteria) ? verdictJson.criteria as { status?: string }[] : [];
  const isError = runJson?.is_error === true || (exit === 3 && !runJson);
  // When a background task (a subagent, for instance) ends after the session's answer, the session
  // answers again, and the CLI's result then reports the duration and turns of that last turn only.
  // The cost is the session's total either way.
  const lastTurnOnly = typeof runJson?.result_index === 'number' && runJson.result_index > 0;
  // Phase 1's transcripts are kept by the write step, with the guard count; the verifier's here.
  const kept = phase === 2 && typeof runJson?.session_id === 'string' ? keepTranscripts(out, runJson.session_id, label) : null;
  const tokens = tokensFromModelUsage(runJson?.modelUsage);
  return {
    exit_code: exit,
    verdict: exit === 3 ? null : typeof verdictJson?.verdict === 'string' ? verdictJson.verdict : null,
    cost_usd: typeof runJson?.total_cost_usd === 'number' ? runJson.total_cost_usd : 0,
    duration_ms: lastTurnOnly ? null : typeof runJson?.duration_ms === 'number' ? runJson.duration_ms : Date.now() - started,
    num_turns: !lastTurnOnly && typeof runJson?.num_turns === 'number' ? runJson.num_turns : null,
    ...(lastTurnOnly ? { last_turn_only: true } : {}),
    is_error: isError,
    ...(exit === 3 ? { error: (run.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 500) } : {}),
    spec_questions: Array.isArray(verdictJson?.spec_questions) ? verdictJson.spec_questions.length : 0,
    untestable: criteria.filter((c) => c?.status === 'untestable').length,
    models: runJson?.modelUsage && typeof runJson.modelUsage === 'object' ? Object.keys(runJson.modelUsage).sort() : [],
    ...(tokens ? { tokens } : {}),
    ...(kept ? { tools: toolHealth(kept.texts) } : {}),
  };
}

/**
 * The ticket's spec, and only it: from EVAL_SPECS/<TICKET>.md, the bundle's eval/specs (an agent's
 * runner), or the corpus folder of a local checkout. No other file of the corpus is read.
 */
function publicSpec(ticket: string): string {
  const candidates = [
    ...(process.env.EVAL_SPECS ? [join(process.env.EVAL_SPECS, `${ticket}.md`)] : []),
    join(KIT, BUNDLE_SPECS, `${ticket}.md`),
    join(TICKETS, ticket, 'spec.md'),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`No spec for ${ticket} in ${candidates.join(', ')}`);
  return found;
}

const failedPhase1 = (error: string): AgentRun => ({ exit_code: 3, verdict: null, cost_usd: 0, duration_ms: null, num_turns: null, is_error: true, error, spec_questions: 0, untestable: 0 });

// ---------------------------------------------------------------- agent runner

function prepare(ticket: string, trial: number): void {
  const p = trialPaths(ticket, trial);
  rmSync(p.root, { recursive: true, force: true });
  mkdirSync(p.agentOut, { recursive: true });
  if (IN_PLACE) {
    if (existsSync(join(p.ws, '.git'))) throw new Error('examples/shop already has its own repository: run a trial in place on a fresh checkout');
    // In a checkout, the shop must be untouched; in a bundle there is no repository, and the bundle
    // was checked against its manifest (node eval/bundle.ts verify) before this step.
    if (insideRepository(p.ws)) {
      const dirty = changedFiles(p.ws);
      if (dirty.length) throw new Error(`examples/shop must be untouched before a trial in place: ${dirty.map((f) => f.path).join(', ')}`);
    }
    copyApp(p.pristine);
  } else {
    copyApp(p.ws, { mode: 'copy' });
    // The shop finds the kit's summary script through a path relative to examples/shop; the
    // workspace lives elsewhere, so it points to the script directly (part of the baseline commit).
    const pkgPath = join(p.ws, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts['test:summary'] = `node ${join(KIT, 'qa/summary.ts')}`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  // The workspace gets a repository of its own: in a checkout, the agent's git status and git diff
  // would otherwise run on the whole repository, corpus included.
  git(p.ws, 'init', '-q');
  git(p.ws, 'add', '-A');
  git(p.ws, 'commit', '-qm', 'baseline');
  copyFileSync(publicSpec(ticket), p.spec);
  const criteria = buildManifest(ticket, readFileSync(p.spec, 'utf8')).criteria.map((c) => c.id);
  const state: AgentState = {
    ticket, trial, criteria, started_at: new Date().toISOString(), dry_run: DRY_RUN,
    bundle_verified: process.env.EVAL_BUNDLE_VERIFIED === '1',
  };
  writeJson(p.agentState, state);
  console.log(`Prepared ${ticket} trial ${trial} in ${p.root}`);
}

function write(ticket: string, trial: number): void {
  const p = trialPaths(ticket, trial);
  const state = readJson<AgentState>(p.agentState);
  if (!state) throw new Error(`${p.agentState} is missing: run prepare first`);
  // A dry run has no agent. The scoring runner, which knows the ticket, puts the hidden tests in place.
  state.phase1 = DRY_RUN
    ? { exit_code: 0, verdict: null, cost_usd: 0, duration_ms: 0, num_turns: 0, is_error: false, error: 'dry run: no agent', spec_questions: 0, untestable: 0 }
    : runPhase(ticket, p.ws, p.spec, p.agentOut, 1, 'phase1');
  // Only new test files are allowed: a changed tracked file or any other new file breaks the writer's rules.
  const changes = classifyChanges(changedFiles(p.ws).map((f) => {
    const full = join(p.ws, f.path);
    return { ...f, size: existsSync(full) && statSync(full).isFile() ? statSync(full).size : -1 };
  }));
  state.generated_test_files = changes.tests;
  state.changed_non_test_files = changes.others;
  state.sandbox_placeholders = changes.placeholders;
  for (const file of changes.tests) {
    mkdirSync(dirname(join(p.agentOut, 'generated', file)), { recursive: true });
    copyFileSync(join(p.ws, file), join(p.agentOut, 'generated', file));
  }
  const runJson = readJson(join(p.ws, `reports/${ticket}-phase1-run.json`));
  const kept = !DRY_RUN && typeof runJson?.session_id === 'string' ? keepTranscripts(p.agentOut, runJson.session_id, 'phase1') : null;
  if (kept) {
    const blocks = guardBlocks(kept.texts);
    state.phase1.guard_blocks = blocks.total;
    state.phase1.guard_block_reasons = blocks.reasons;
    state.phase1.tools = toolHealth(kept.texts);
    const spawned = Number((runJson?.subagent_stats as { spawned?: unknown } | undefined)?.spawned ?? 0);
    state.phase1.subagents = { spawned: Number.isFinite(spawned) ? spawned : 0, transcripts: kept.subagents };
  }
  // The verifier's runner starts from this workspace: its own repository, phase 1's reports, the tests.
  const tar = spawnSync('tar', ['--exclude=./node_modules', '-cf', p.workspaceTar, '-C', p.ws, '.'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`cannot pack the workspace: ${tar.stderr}`);
  state.finished_at = new Date().toISOString();
  writeJson(p.agentState, state);
  console.log(`Phase 1: exit ${state.phase1.exit_code}, verdict ${state.phase1.verdict}, $${state.phase1.cost_usd}, ${changes.tests.length} new test file(s), ${changes.others.length} other change(s)`);
}

// ---------------------------------------------------------------- scoring runner

/** The shop the variants are built from must be the one the agent worked on: same files as in the bundle. */
function checkShopMatchesBundle(pristine: string): void {
  const manifestPath = process.env.EVAL_BUNDLE_MANIFEST;
  if (!manifestPath) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundleManifest;
  const prefix = 'examples/shop/';
  const expected = Object.entries(manifest.files).filter(([f]) => f.startsWith(prefix)).map(([f, h]) => [f.slice(prefix.length), h] as const);
  const onDisk = listFiles(pristine).filter((f) => !isGenerated(f));
  const differ = expected.filter(([f, h]) => !existsSync(join(pristine, f)) || sha256(readFileSync(join(pristine, f))) !== h).map(([f]) => f);
  const extra = onDisk.filter((f) => !expected.some(([e]) => e === f));
  if (differ.length || extra.length) throw new Error(`the shop differs from the agent bundle: ${[...differ, ...extra].join(', ')}`);
}

function score(ticketName: string, trial: number): void {
  const startedAt = new Date().toISOString();
  const p = trialPaths(ticketName, trial);
  const ticket = loadTicket(ticketName);
  const agent = readJson<AgentState>(p.agentState);
  const pristine = existsSync(p.pristine) ? p.pristine : APP;
  checkShopMatchesBundle(pristine);
  // What the agent's runner sent back is checked for the corpus: a whole copy of a private file, or
  // a file named after a bug. Lines are not compared, since an agent's own test can share a line with
  // a hidden test without having seen it; the transcripts are checked by the report.
  const fingerprints = corpusFingerprints(TICKETS, publicTexts(APP, [ticket.spec]));
  const findings = existsSync(p.agent)
    ? scanForCorpus(p.agent, fingerprints, { lines: false, mentions: false }).filter((f) => !f.path.endsWith('workspace.tar'))
    : [];
  const state: ScoreState = {
    schema_version: 1, ticket: ticketName, kind: ticket.kind, bugs: ticket.bugs, variants: { bugs: {} }, implementations: {},
    isolation: { scoring_sandbox: sandboxMode(), findings, ...(agent ? { bundle_verified: agent.bundle_verified } : {}) },
    started_at: startedAt, finished_at: startedAt,
  };
  if (!agent) state.error = 'the agent runner sent nothing back';
  const generated = join(p.scoreDir, 'generated');
  rmSync(generated, { recursive: true, force: true });
  let files = agent?.generated_test_files ?? [];
  for (const file of files) {
    mkdirSync(dirname(join(generated, file)), { recursive: true });
    copyFileSync(join(p.agentOut, 'generated', file), join(generated, file));
  }
  let phase1 = agent?.phase1;
  if (agent?.dry_run) {
    // The hidden tests stand in for the agent's, and the ambiguous ticket gets its right answer, so
    // that a dry run of a working harness succeeds on every ticket.
    const hidden = join(ticket.dir, 'hidden.spec.ts');
    files = existsSync(hidden) ? [`e2e/${ticketName}.spec.ts`] : [];
    if (files.length) { mkdirSync(join(generated, 'e2e'), { recursive: true }); copyFileSync(hidden, join(generated, files[0])); }
    const verdict = ticket.kind === 'ambiguous' ? 'blocked' : 'ready';
    phase1 = { exit_code: verdict === 'blocked' ? 2 : 0, verdict, cost_usd: 0, duration_ms: 0, num_turns: 0, is_error: false, error: 'dry run: no agent', spec_questions: 0, untestable: 0 };
    state.dry_run = { phase1, generated_test_files: files };
  }
  const unit = files.filter((f) => /\.test\.[cm]?[jt]sx?$/.test(f));
  const e2e = files.filter((f) => /\.spec\.[cm]?[jt]sx?$/.test(f));
  const hasGold = existsSync(join(ticket.dir, 'gold.diff'));
  if (ticket.kind !== 'ambiguous' && hasGold && files.length) {
    const run = (variant: string, repeatEach: number): VariantResult => {
      // A neutral, random folder name: a test that reads its own path learns nothing about the variant.
      const dir = join(p.root, 'variants', `v-${randomBytes(6).toString('hex')}`);
      makeVariant(ticket, variant, dir, pristine);
      for (const file of files) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(join(generated, file), join(dir, file));
      }
      const result = merge(runVitest(dir, unit, ticketName), runPlaywright(dir, e2e, ticketName, { repeatEach }));
      rmSync(dir, { recursive: true, force: true });
      console.log(`  ${variant}: ${result.tests.map((t) => t.status).join(' ') || 'no test'}${result.error ? ` (${result.error.slice(0, 120)})` : ''}`);
      return result;
    };
    state.variants.base = run('base', 1);
    state.variants.gold = run('gold', 3);
    for (const bug of ticket.bugs) state.variants.bugs[bug.id] = run(bug.id, 1);
  }
  // Phase 2 gets the two implementations under neutral names, the reference first.
  rmSync(p.verifyInput, { recursive: true, force: true });
  mkdirSync(p.verifyInput, { recursive: true });
  const firstBug = ticket.bugs[0];
  const runVerifier = phase1?.verdict === 'ready' && ticket.kind !== 'ambiguous' && hasGold && Boolean(firstBug);
  if (runVerifier) {
    copyFileSync(join(ticket.dir, 'gold.diff'), join(p.verifyInput, 'impl-1.diff'));
    copyFileSync(join(ticket.dir, 'bugs', `${firstBug.id}.diff`), join(p.verifyInput, 'impl-2.diff'));
    state.implementations = { 'impl-1': 'gold', 'impl-2': { bug: firstBug.id } };
  }
  writeJson(join(p.verifyInput, 'verify.json'), runVerifier
    ? { run: true, implementations: ['impl-1', 'impl-2'] }
    : { run: false, reason: 'phase 1 did not produce ready tests, or the ticket has no reference implementation' });
  state.finished_at = new Date().toISOString();
  writeJson(p.score, state);
  writeJson(join(p.scoreDir, 'variants.json'), state.variants);
  if (findings.length) console.log(`Warning: ${findings.length} trace(s) of the corpus in what the agent's runner sent back: ${findings.map((f) => `${f.path} (${f.reason})`).join('; ')}`);
  console.log(`Scored ${files.length} generated test file(s) on ${Object.keys(state.variants.bugs).length + (state.variants.gold ? 2 : 0)} variant(s), sandbox ${state.isolation.scoring_sandbox}.`);
}

// ---------------------------------------------------------------- verifier runner

function verify(ticket: string, trial: number): void {
  const startedAt = new Date().toISOString();
  const p = trialPaths(ticket, trial);
  const input = readJson<{ run: boolean; reason?: string; implementations?: string[] }>(join(p.verifyInput, 'verify.json'));
  const agent = readJson<AgentState>(p.agentState);
  if (!input?.run || !agent) {
    writeJson(p.verify, { skipped: input?.reason ?? 'no input for phase 2', runs: {} } satisfies VerifyState);
    console.log(`Phase 2 skipped: ${input?.reason ?? 'no input for phase 2'}.`);
    return;
  }
  // The implementations are read, then their files deleted before any agent starts: the verifier
  // sees each one as the code of its workspace, not as a diff it could read beside it.
  const implementations = (input.implementations ?? []).map((name) => ({ name, diff: readFileSync(join(p.verifyInput, `${name}.diff`), 'utf8') }));
  rmSync(p.verifyInput, { recursive: true, force: true });
  if (IN_PLACE) {
    if (existsSync(join(p.ws, '.git'))) throw new Error('examples/shop already has its own repository: run phase 2 in place on a fresh runner');
    const untar = spawnSync('tar', ['-xf', p.workspaceTar, '-C', p.ws], { encoding: 'utf8' });
    if (untar.status !== 0) throw new Error(`cannot restore the workspace: ${untar.stderr}`);
  } else if (!existsSync(join(p.ws, '.git'))) {
    throw new Error(`${p.ws} is missing: run prepare and write first`);
  }
  // A scripted approval, used only to measure phase 2: it is not a human review.
  const reasons = join(p.root, 'approval.txt');
  writeFileSync(reasons, `${agent.criteria.map((id) => `${id}: automated evaluation approval, not a human review`).join('\n')}\n`);
  const approve = spawnSync('node', [join(KIT, 'qa/scenario-review.ts'), 'approve-review', ticket, p.spec, 'eval-harness', reasons], { cwd: p.ws, encoding: 'utf8' });
  if (approve.status !== 0) throw new Error(`scripted approval failed: ${approve.stderr}`);
  const state: VerifyState = { runs: {}, started_at: startedAt };
  for (const impl of implementations) {
    // Each implementation applies on top of the previous one: the second is the first with one bug.
    const diff = join(tmpdir(), `eval-${process.pid}-${randomBytes(4).toString('hex')}.diff`);
    writeFileSync(diff, impl.diff);
    try { applyDiff(p.ws, diff); } finally { rmSync(diff, { force: true }); }
    state.runs[impl.name] = runPhase(ticket, p.ws, p.spec, p.verifyOut, 2, `phase2-${impl.name}`);
  }
  state.finished_at = new Date().toISOString();
  writeJson(p.verify, state);
  console.log(`Phase 2: ${Object.entries(state.runs).map(([name, r]) => `${name} exit ${r.exit_code}`).join(', ')}`);
}

// ---------------------------------------------------------------- report runner

/** Copies a runner's files into the trial folder; phase 2's neutral names become the reference's and the bug's. */
function copyOut(from: string, to: string, rename: (name: string) => string = (n) => n): void {
  if (!existsSync(from)) return;
  for (const file of listFiles(from, { all: true })) {
    const dest = join(to, rename(file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(from, file), dest);
  }
}

function finish(ticket: string, trial: number): TrialRecord {
  const p = trialPaths(ticket, trial);
  const agent = readJson<AgentState>(p.agentState);
  const scored = readJson<ScoreState>(p.score);
  const verified = readJson<VerifyState>(p.verify);
  const meta = scored ?? (() => { const t = loadTicket(ticket); return { kind: t.kind, bugs: t.bugs }; })();
  const nameOf = (role: 'gold' | 'bug') => Object.entries(scored?.implementations ?? {})
    .find(([, v]) => (role === 'gold' ? v === 'gold' : typeof v === 'object'))?.[0];
  const goldName = nameOf('gold');
  const bugName = nameOf('bug');
  const bugImpl = bugName ? scored?.implementations[bugName] : undefined;
  const gold = goldName ? verified?.runs[goldName] : undefined;
  const bug = bugName ? verified?.runs[bugName] : undefined;
  // Each runner's own working time. The trial ends when its last runner did, not when it is assembled:
  // between runners, a trial waits for the other trials' jobs of the same stage.
  const window = (w: { started_at?: string; finished_at?: string } | null | undefined) =>
    w?.started_at && w.finished_at ? { started_at: w.started_at, finished_at: w.finished_at } : undefined;
  const runners = Object.fromEntries(Object.entries({ agent: window(agent), score: window(scored), verify: window(verified) })
    .filter(([, w]) => w)) as NonNullable<TrialRecord['runners']>;
  const ends = Object.values(runners).map((w) => w.finished_at).sort();
  const record: TrialRecord = {
    schema_version: 2,
    ticket,
    trial,
    kind: meta.kind,
    criteria: agent?.criteria ?? [],
    started_at: agent?.started_at ?? scored?.started_at ?? new Date().toISOString(),
    finished_at: ends.at(-1) ?? new Date().toISOString(),
    runners,
    phase1: scored?.dry_run?.phase1 ?? agent?.phase1 ?? failedPhase1(agent ? 'phase 1 did not run' : 'the agent runner sent nothing back'),
    changed_non_test_files: agent?.changed_non_test_files ?? [],
    sandbox_placeholders: agent?.sandbox_placeholders ?? [],
    generated_test_files: scored?.dry_run?.generated_test_files ?? agent?.generated_test_files ?? [],
    bugs: meta.bugs,
    variants: scored?.variants ?? { bugs: {} },
    phase2: gold || bug ? { ...(gold ? { gold } : {}), ...(bug && typeof bugImpl === 'object' ? { bug: { ...bug, id: bugImpl.bug } } : {}) } : null,
    ...(scored ? { isolation: scored.isolation } : {}),
  };
  rmSync(p.trial, { recursive: true, force: true });
  mkdirSync(p.trial, { recursive: true });
  copyOut(p.agentOut, p.trial);
  for (const file of ['score.json', 'variants.json']) if (existsSync(join(p.scoreDir, file))) copyFileSync(join(p.scoreDir, file), join(p.trial, file));
  const roles: Record<string, string> = { ...(goldName ? { [`phase2-${goldName}`]: 'phase2-gold' } : {}), ...(bugName ? { [`phase2-${bugName}`]: 'phase2-bug' } : {}) };
  copyOut(p.verifyOut, p.trial, (name) => {
    const [first, ...rest] = name.split('/');
    const label = Object.keys(roles).find((l) => first === l || first.startsWith(`${l}.`) || first.startsWith(`${l}-`));
    return label ? [roles[label] + first.slice(label.length), ...rest].join('/') : name;
  });
  writeJson(join(p.trial, 'trial.json'), record);
  // Its bugs would read as not detected: the history records it as a scoring error, left out of comparisons.
  if (runners.agent && !runners.score) console.error(`::warning::${ticket} trial ${trial}: the scoring runner sent nothing back; the history records a scoring error`);
  const s = scoreTrial(record);
  console.log(JSON.stringify({ ticket: s.ticket, trial: s.trial, success: s.success, red_valid: s.red_valid, f2p: `${s.f2p.filter((u) => u.ok).length}/${s.f2p.length}`, bugs: s.bugs, false_positives: s.false_positives.length, policy_ok: s.policy_ok, verifier: s.verifier, cost_usd: s.cost_usd, tokens: s.tokens, isolation_findings: s.isolation_findings }));
  return record;
}

// ---------------------------------------------------------------- command line

const [command, ticketName, trialArg] = process.argv.slice(2);
if (command === 'finish-all') {
  const dirs = existsSync(WORK) ? readdirSync(WORK).filter((d) => /^[A-Z][A-Z0-9]*-\d+-\d+$/.test(d)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : [];
  for (const dir of dirs) {
    const [, t, n] = /^(.*)-(\d+)$/.exec(dir)!;
    finish(t, Number(n));
  }
  console.log(`Assembled ${dirs.length} trial(s) in ${relative(process.cwd(), WORK) || WORK}/*/trial`);
} else if (!['prepare', 'write', 'score', 'verify', 'finish'].includes(command) || !/^[A-Z][A-Z0-9]*-\d+$/.test(ticketName ?? '') || !/^\d+$/.test(trialArg ?? '')) {
  console.error('usage: node eval/trial.ts <prepare|write|score|verify|finish> <TICKET> <TRIAL> | finish-all');
  process.exit(2);
} else {
  const trial = Number(trialArg);
  ({ prepare, write, score, verify, finish } as Record<string, (t: string, n: number) => unknown>)[command](ticketName, trial);
}
