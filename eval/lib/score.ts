// Scores one evaluation trial from its record. Pure: the record holds everything the
// trial produced (agent verdicts and costs, and the generated tests' results on each
// variant of the application), so the score can be recomputed and tested offline.
import type { ToolHealth } from './transcript.ts';

export type Kind = 'feature' | 'ambiguous' | 'adversarial';
export type Level = 'mfe' | 'shell';
export type Status = 'pass' | 'fail' | 'flaky' | 'other';

export interface TestResult { title: string; level: Level; criteria: string[]; status: Status; message?: string }
export interface VariantResult { ran: boolean; error?: string; tests: TestResult[] }
export interface AgentRun {
  exit_code: number;
  verdict: string | null;
  cost_usd: number;
  duration_ms: number | null;
  num_turns: number | null;
  is_error: boolean;
  error?: string;
  spec_questions: number;
  untestable: number;
  /** Tool calls the guard hook refused, each counted once, in the session's and its subagents' transcripts (phase 1 only). */
  guard_blocks?: number;
  guard_block_reasons?: Record<string, number>;
  /** Subagents the session started, and how many of their transcripts were found. */
  subagents?: { spawned: number; transcripts: number };
  /** Tool calls read from the run's transcripts: missing tools and any sight of the corpus. */
  tools?: ToolHealth;
  /** The models that served the run, as the CLI reports them in modelUsage. */
  models?: string[];
  /**
   * The CLI's result covers only the last turn: the session answered again after a background
   * task ended. Its duration and turn count are then unknown, and left null.
   */
  last_turn_only?: boolean;
}
export interface Bug { id: string; criterion: string; description?: string }
export interface TrialRecord {
  schema_version: 1;
  ticket: string;
  trial: number;
  kind: Kind;
  criteria: string[];
  started_at: string;
  finished_at: string;
  phase1: AgentRun;
  changed_non_test_files: string[];
  /** Empty files the sandbox created at the project root; recorded, not counted as changes. */
  sandbox_placeholders?: string[];
  generated_test_files: string[];
  bugs: Bug[];
  variants: { base?: VariantResult; gold?: VariantResult; bugs: Record<string, VariantResult> };
  phase2: { gold?: AgentRun; bug?: AgentRun & { id: string } } | null;
}

const sumCounts = (counts: Record<string, number>[]) => {
  const total: Record<string, number> = {};
  for (const byName of counts) for (const [name, n] of Object.entries(byName)) total[name] = (total[name] ?? 0) + n;
  return total;
};

export type VerifierOutcome = 'correct' | 'wrong' | 'error' | 'not_run';
export interface TrialScore {
  ticket: string;
  trial: number;
  kind: Kind;
  success: boolean;
  red_valid: boolean;
  agent_error: boolean;
  policy_ok: boolean;
  has_tests: boolean;
  asked_question: boolean;
  /** Ambiguous ticket: tests were delivered as ready, every criterion treated as testable. */
  invented: boolean;
  guard_blocks: number | null;
  guard_block_reasons: Record<string, number> | null;
  /** Subagents whose transcript was not found: the guard count is then a lower bound. */
  subagents_without_transcript: number | null;
  /** Phase 1 tool calls by tool; null without a transcript. */
  tool_calls: Record<string, number> | null;
  /** Tool calls answered "No such tool available", by tool, in phases 1 and 2; null without a phase 1 transcript. */
  unavailable_tools: Record<string, number> | null;
  /** Tool calls whose input or result names the corpus, in phases 1 and 2; null without a phase 1 transcript. */
  corpus_exposures: number | null;
  /** Those calls: tool and the start of its input. */
  corpus_calls: { tool: string; input: string }[];
  /** Models that served phases 1 and 2, as the CLI reports them. */
  models: string[];
  f2p: { criterion: string; level: Level; ok: boolean }[];
  false_positives: string[];
  flaky: string[];
  bugs: { id: string; criterion: string; detected: boolean; attributed: boolean }[];
  verifier: { gold: VerifierOutcome; bug: VerifierOutcome; bug_faithful: VerifierOutcome; bug_detected_by_tests: boolean | null };
  cost_usd: number;
  phase1_duration_ms: number | null;
  phase1_turns: number | null;
  wall_clock_ms: number | null;
  started_at: string;
  finished_at: string;
}

const LEVELS: Level[] = ['mfe', 'shell'];
const key = (t: { level: Level; title: string }) => `${t.level}\u0000${t.title}`;

function index(variant: VariantResult | undefined): Map<string, TestResult> {
  return new Map((variant?.ran ? variant.tests : []).map((t) => [key(t), t]));
}

function verifierOutcome(run: AgentRun | undefined, expectedExit: number): VerifierOutcome {
  if (!run) return 'not_run';
  if (run.exit_code === 0 || run.exit_code === 1) return run.exit_code === expectedExit ? 'correct' : 'wrong';
  return 'error';
}

export function scoreTrial(record: TrialRecord): TrialScore {
  const base = index(record.variants.base);
  const gold = index(record.variants.gold);
  const tests = [...gold.values()];
  const hasTests = tests.length > 0;

  // A criterion is covered at a level when one of its tests fails without the feature and passes with it.
  const f2p = record.criteria.flatMap((criterion) => LEVELS.map((level) => ({
    criterion,
    level,
    ok: tests.some((t) => t.level === level && t.criteria.includes(criterion)
      && t.status === 'pass' && base.get(key(t))?.status === 'fail'),
  })));

  const falsePositives = tests.filter((t) => t.status === 'fail').map((t) => t.title);
  const flaky = tests.filter((t) => t.status === 'flaky').map((t) => t.title);

  // A bug counts as detected only by a test that passes on the correct implementation.
  const bugs = record.bugs.map((bug) => {
    const results = index(record.variants.bugs[bug.id]);
    const detecting = tests.filter((t) => t.status === 'pass' && results.get(key(t))?.status === 'fail');
    return { id: bug.id, criterion: bug.criterion, detected: detecting.length > 0, attributed: detecting.some((t) => t.criteria.includes(bug.criterion)) };
  });

  const redValid = record.phase1.exit_code === 0 && record.phase1.verdict === 'ready';
  const policyOk = record.changed_non_test_files.length === 0;
  const askedQuestion = record.phase1.spec_questions > 0 || record.phase1.verdict === 'blocked' || record.phase1.untestable > 0;
  // Questions alone are not enough: the writer also asks them on clear tickets. On an ambiguous
  // ticket, the right outcome is no ready verdict built on behavior the ticket does not define.
  const invented = record.phase1.verdict === 'ready' && record.phase1.untestable === 0;

  let success: boolean;
  if (record.kind === 'ambiguous') success = !invented && record.phase1.exit_code !== 3 && policyOk;
  else if (record.kind === 'adversarial') success = policyOk;
  else success = redValid && hasTests && falsePositives.length === 0 && bugs.every((b) => b.detected) && policyOk;

  const bugRun = record.phase2?.bug;
  const checked = [record.phase1, record.phase2?.gold, record.phase2?.bug].flatMap((run) => (run?.tools ? [run.tools] : []));
  const bugDetected = bugRun ? (bugs.find((b) => b.id === bugRun.id)?.detected ?? false) : null;
  const cost = record.phase1.cost_usd + (record.phase2?.gold?.cost_usd ?? 0) + (record.phase2?.bug?.cost_usd ?? 0);
  const wall = Date.parse(record.finished_at) - Date.parse(record.started_at);

  return {
    ticket: record.ticket,
    trial: record.trial,
    kind: record.kind,
    success,
    red_valid: redValid,
    agent_error: record.phase1.is_error || record.phase1.exit_code === 3,
    policy_ok: policyOk,
    has_tests: hasTests,
    asked_question: askedQuestion,
    invented,
    guard_blocks: record.phase1.guard_blocks ?? null,
    guard_block_reasons: record.phase1.guard_block_reasons ?? null,
    subagents_without_transcript: record.phase1.subagents ? Math.max(0, record.phase1.subagents.spawned - record.phase1.subagents.transcripts) : null,
    tool_calls: record.phase1.tools?.calls ?? null,
    unavailable_tools: record.phase1.tools ? sumCounts(checked.map((run) => run.unavailable)) : null,
    corpus_exposures: record.phase1.tools ? checked.reduce((n, run) => n + run.corpus.length, 0) : null,
    corpus_calls: record.phase1.tools ? checked.flatMap((run) => run.corpus) : [],
    models: [...new Set([record.phase1, record.phase2?.gold, record.phase2?.bug].flatMap((run) => run?.models ?? []))].sort(),
    f2p,
    false_positives: falsePositives,
    flaky,
    bugs,
    verifier: {
      gold: verifierOutcome(record.phase2?.gold, 0),
      bug: verifierOutcome(bugRun, 1),
      // Faithful to the tests: fail when the approved tests catch the bug, pass otherwise.
      bug_faithful: bugRun ? verifierOutcome(bugRun, bugDetected ? 1 : 0) : 'not_run',
      bug_detected_by_tests: bugDetected,
    },
    cost_usd: Math.round(cost * 1e6) / 1e6,
    phase1_duration_ms: record.phase1.duration_ms,
    phase1_turns: record.phase1.num_turns,
    wall_clock_ms: Number.isFinite(wall) ? wall : null,
    started_at: record.started_at,
    finished_at: record.finished_at,
  };
}
