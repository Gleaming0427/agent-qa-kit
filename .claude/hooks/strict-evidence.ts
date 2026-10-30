/** Deterministic, strict QA evidence validator. No LLM, no dependencies.
 * Agents do not get to choose which criteria exist: the ticket manifest is the authority.
 * Each test title MUST contain [TICKET-42][AC-1]. The reports must contain actual results.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type Level = 'mfe' | 'shell';
export type Phase = 1 | 2;

export interface Criterion { id: string; description: string }
export interface Manifest { schema_version: number; ticket: string; spec_sha256: string; criteria: Criterion[] }

export interface VerdictCriterion { id: string; level: Level; status: string; evidence: string }
export interface Verdict {
  ticket: string;
  phase: number;
  verdict: string;
  criteria: VerdictCriterion[];
  flaky_tests?: unknown[];
  spec_questions?: unknown[];
  alerts?: unknown[];
}

// Only the fields of the Vitest and Playwright JSON reports that the kit reads.
export interface VitestAssertion { fullName?: string; title?: string; status?: string; duration?: number; failureMessages?: string[] }
export interface VitestReport {
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: { name?: string; assertionResults?: VitestAssertion[] }[];
}
export interface PlaywrightError { message?: string }
export interface PlaywrightResult {
  status?: string;
  error?: PlaywrightError;
  errors?: PlaywrightError[];
  attachments?: { name?: string; path?: string }[];
}
export interface PlaywrightTest { status?: string; results?: PlaywrightResult[] }
export interface PlaywrightSpec { title?: string; file?: string; tests?: PlaywrightTest[] }
export interface PlaywrightSuite { title?: string; file?: string; specs?: PlaywrightSpec[]; suites?: PlaywrightSuite[] }
export interface PlaywrightReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number };
  suites?: PlaywrightSuite[];
}

interface UnitTest { file: string; title: string; status?: string; duration?: number }
interface E2eTest { file: string; title: string; status?: string; results: PlaywrightResult[] }
type Result = 'pass' | 'fail' | 'blocked' | 'not_run';
export interface Evidence { criterion: string; level: Level; result: Result; tests: { title: string; status?: string; file: string }[] }

const LEVELS: Level[] = ['mfe', 'shell'];
const formatKey = (id: string, level: Level) => `${id}:${level}`;
const cleanName = (s: unknown) => String(s ?? '');

function isNamedFor(title: string, ticket: string, id: string): boolean {
  return title.includes(`[${ticket}]`) && title.includes(`[${id}]`);
}

export function extractVitestTests(report: VitestReport | null | undefined): UnitTest[] {
  const tests: UnitTest[] = [];
  for (const file of report?.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      tests.push({
        file: cleanName(file.name),
        title: cleanName(test.fullName || test.title),
        status: test.status,
        duration: test.duration,
      });
    }
  }
  return tests;
}

export function extractPlaywrightTests(report: PlaywrightReport | null | undefined): E2eTest[] {
  const tests: E2eTest[] = [];
  function visit(suites: PlaywrightSuite[] | undefined, ancestor: string[] = [], inheritedFile = '') {
    for (const suite of suites ?? []) {
      const path = suite.title ? [...ancestor, suite.title] : ancestor;
      const file = suite.file || inheritedFile;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          tests.push({
            file: cleanName(spec.file || file),
            title: [...path, spec.title].join(' '),
            status: test.status,
            results: test.results ?? [],
          });
        }
      }
      visit(suite.suites, path, file);
    }
  }
  visit(report?.suites);
  return tests;
}

function classifyVitest(test: UnitTest): Result {
  if (test.status === 'passed') return 'pass';
  if (test.status === 'failed') return 'fail';
  return 'blocked'; // pending, skipped, todo, unknown
}
function classifyPlaywright(test: E2eTest): Result {
  if (test.status === 'unexpected') return 'fail';
  if (test.status !== 'expected') return 'blocked'; // flaky, skipped
  if (!test.results.length || !test.results.some((r) => r.status === 'passed')) return 'blocked';
  if (test.results.some((r) => r.status === 'failed' || r.status === 'timedOut')) return 'blocked';
  return 'pass';
}
function allSame(values: Result[]): Result { return values.length === 1 ? values[0] : 'blocked'; }
function collectMatches<T extends { file: string; title: string }>(tests: T[], ticket: string, id: string, level: Level): T[] {
  return tests.filter((t) => isNamedFor(t.title, ticket, id) && (
    level === 'mfe'
      ? /\.test\.[jt]sx?$/.test(t.file) || !t.file // Vitest custom reporters may omit filenames
      : t.file.endsWith(`${ticket}.spec.ts`) || t.file.endsWith(`${ticket}.spec.js`)
  ));
}

export interface ValidateInput {
  verdict: Verdict;
  manifest: Manifest | null | undefined;
  phase: number;
  vitest?: VitestReport | null;
  playwright?: PlaywrightReport | null;
  specText?: string;
  root?: string;
}

/** Returns problems and an evidence table. Does not trust agent-provided evidence strings. */
export function validateEvidence({ verdict, manifest, phase, vitest, playwright, specText, root = process.cwd() }: ValidateInput): { problems: string[]; evidence: Evidence[] } {
  const problems: string[] = [];
  const evidence: Evidence[] = [];
  if (!manifest || manifest.ticket !== verdict?.ticket || !Array.isArray(manifest.criteria) || !manifest.criteria.length) {
    return { problems: ['Missing, empty or mismatched criteria manifest.'], evidence };
  }
  if (specText !== undefined) {
    const currentHash = createHash('sha256').update(specText).digest('hex');
    if (manifest.spec_sha256 !== currentHash) problems.push('Ticket spec changed since the criteria manifest was generated.');
  }
  if (!Array.isArray(verdict.criteria)) return { problems: [...problems, 'Missing verdict criteria.'], evidence };
  const expected = new Set(manifest.criteria.map((c) => c.id));
  if (expected.size !== manifest.criteria.length || manifest.criteria.some((c) => !/^AC-[1-9]\d*$/.test(c.id))) {
    problems.push('Manifest has duplicate or invalid criterion IDs.');
  }
  const declared = new Map<string, VerdictCriterion>();
  for (const c of verdict.criteria) {
    if (!c || !expected.has(c.id) || !LEVELS.includes(c.level)) {
      problems.push(`Unknown criterion or level: ${c?.id ?? '?'} / ${c?.level ?? '?'}`);
      continue;
    }
    const key = formatKey(c.id, c.level);
    if (declared.has(key)) problems.push(`Duplicate verdict entry for ${key}.`);
    declared.set(key, c);
  }
  for (const id of expected) {
    for (const level of LEVELS) {
      if (!declared.has(formatKey(id, level))) problems.push(`Missing criterion ${id} at ${level} level.`);
    }
  }
  if (verdict.verdict === 'blocked') return { problems, evidence };
  const unitTests = extractVitestTests(vitest);
  const e2eTests = extractPlaywrightTests(playwright);
  // Empty or summary-only reports are NOT evidence of a pass.
  if (!unitTests.length) problems.push('Vitest JSON report contains no individual executed tests.');
  if (phase === 2 && verdict.verdict === 'pass' && !e2eTests.length) {
    problems.push('Playwright JSON report contains no individual executed tests.');
  }
  if ((vitest?.numFailedTests ?? 0) > unitTests.filter((t) => t.status === 'failed').length) {
    problems.push('Vitest summary reports failures missing from individual assertions.');
  }
  if ((playwright?.stats?.unexpected ?? 0) > e2eTests.filter((t) => t.status === 'unexpected').length) {
    problems.push('Playwright summary reports failures missing from individual tests.');
  }
  for (const id of expected) {
    for (const level of LEVELS) {
      const c = declared.get(formatKey(id, level));
      if (!c) continue;
      const states = level === 'mfe'
        ? collectMatches(unitTests, verdict.ticket, id, level).map((t) => ({ t, state: classifyVitest(t) }))
        : collectMatches(e2eTests, verdict.ticket, id, level).map((t) => ({ t, state: classifyPlaywright(t) }));
      const stateList = states.map(({ state }) => state);
      const result: Result = states.length ? (stateList.includes('fail') ? 'fail' : allSame([...new Set(stateList)])) : 'not_run';
      evidence.push({ criterion: id, level, result, tests: states.map(({ t }) => ({ title: t.title, status: t.status, file: t.file })) });
      if (phase === 1) {
        if (level === 'mfe' && result !== 'fail') problems.push(`${id} MFE must have a failing [${verdict.ticket}][${id}] test before implementation (got ${result}).`);
        if (level === 'shell') {
          const shellPath = resolve(root, 'e2e', `${verdict.ticket}.spec.ts`);
          if (!existsSync(shellPath)) problems.push(`Missing ${shellPath}.`);
          else {
            const source = readFileSync(shellPath, 'utf8');
            if (!isNamedFor(source, verdict.ticket, id)) problems.push(`No [${verdict.ticket}][${id}] scenario in ${basename(shellPath)}.`);
          }
        }
      } else {
        if (c.status === 'not_run') {
          if (level !== 'shell' || (vitest?.numFailedTests ?? 0) === 0 || playwright) {
            problems.push(`${id} ${level}: not_run is allowed only when MFE failed and E2E did not run.`);
          }
        } else if (c.status !== result) {
          problems.push(`${id} ${level}: agent claimed ${c.status}, actual test evidence is ${result}.`);
        }
        if (verdict.verdict === 'pass' && result !== 'pass') problems.push(`${id} ${level}: cannot pass without executed passing tests.`);
      }
    }
  }
  if (phase === 2) {
    const hasFailure = evidence.some((e) => e.result === 'fail');
    if (verdict.verdict === 'fail' && !hasFailure) problems.push('Fail verdict not supported by any criterion test failure.');
  }
  return { problems, evidence };
}

export function readRequiredJson<T = unknown>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch { return null; }
}
