#!/usr/bin/env node
// Verdict check for the QA agents: a Claude Code stop hook
// (Stop for a session, turned into SubagentStop for a subagent).
//
// When an agent wants to stop, Claude Code passes its last message as JSON on
// standard input. If the verdict is incomplete or contradicts the test reports,
// the script refuses to let it stop (exit code 2) and explains what to fix:
// the agent goes back to work. The check is deterministic and costs no tokens.
//
// Usage:
//   node verdict-check.mjs <phase>          as a hook (phase 1 or 2, or the QA_PHASE variable)
//   node verdict-check.mjs <phase> --final  final validation by qa/run-qa.sh:
//                                           prints the verdict if valid, otherwise exit code 2.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REJECTIONS = 3; // beyond this, stopping is allowed and the launcher rejects the verdict
const args = process.argv.slice(2);
const FINAL = args.includes('--final');
const PHASE = Number(args.find((a) => a === '1' || a === '2') ?? process.env.QA_PHASE);
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const VERDICTS = { 1: ['ready', 'blocked'], 2: ['pass', 'fail', 'blocked'] };
const STATUSES = { 1: ['written', 'untestable'], 2: ['pass', 'fail', 'not_run', 'untestable'] };
const LEVELS = ['mfe', 'shell'];
const LISTS = ['criteria', 'flaky_tests', 'spec_questions', 'alerts'];

// Refuses to stop and sends the agent back to work, at most MAX_REJECTIONS times per run.
function reject(problems, run = 'unknown') {
  const message = `Verdict check: fix these points before finishing.\n- ${problems.join('\n- ')}`;
  if (FINAL) {
    console.error(message);
    process.exit(2);
  }
  const counter = join(tmpdir(), `verdict-check-${String(run).replace(/[^\w-]/g, '_')}.txt`);
  let rejections = 0;
  try {
    rejections = Number(readFileSync(counter, 'utf8')) || 0;
  } catch {}
  if (rejections >= MAX_REJECTIONS) {
    console.error(`${message}\n(Limit of ${MAX_REJECTIONS} rejections reached: stopping allowed, verdict to be rejected.)`);
    process.exit(0);
  }
  try {
    writeFileSync(counter, String(rejections + 1));
  } catch {}
  console.error(message);
  process.exit(2);
}

// The verdict may be raw JSON, a ```json block, or JSON surrounded by text.
function extractVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const candidates = [text.trim()];
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) candidates.push(blocks.at(-1));
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

// null: missing report; undefined: unreadable report.
function readReport(name) {
  const path = join(PROJECT, 'reports', name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function checkStructure(v) {
  const p = [];
  if (typeof v.ticket !== 'string' || !v.ticket.trim()) p.push('The "ticket" field is missing.');
  if (v.phase !== PHASE) p.push(`The "phase" field must be ${PHASE}.`);
  if (!VERDICTS[PHASE].includes(v.verdict)) {
    p.push(`The "verdict" field must be ${VERDICTS[PHASE].join(' or ')}.`);
  }
  for (const field of LISTS) {
    if (!Array.isArray(v[field])) p.push(`The "${field}" field must be a list, even if empty.`);
  }
  return p;
}

function checkCriteria(v) {
  const p = [];
  if (v.criteria.length === 0) return ['The "criteria" list is empty.'];

  const byCriterion = new Map();
  v.criteria.forEach((c, i) => {
    const where = `criteria[${i}]`;
    if (!c || typeof c !== 'object') return p.push(`${where} is not an object.`);
    if (typeof c.id !== 'string' || !c.id.trim()) p.push(`${where}: "id" is missing.`);
    if (!LEVELS.includes(c.level)) p.push(`${where}: "level" must be mfe or shell.`);
    if (!STATUSES[PHASE].includes(c.status)) p.push(`${where}: "status" must be ${STATUSES[PHASE].join(', ')}.`);
    if (typeof c.evidence !== 'string' || !c.evidence.trim()) p.push(`${where}: "evidence" is missing.`);
    if (typeof c.id === 'string' && LEVELS.includes(c.level)) {
      if (!byCriterion.has(c.id)) byCriterion.set(c.id, new Map());
      byCriterion.get(c.id).set(c.level, c.status);
    }
  });

  // Each testable criterion needs both levels: the MFE on its own, and the shell.
  for (const [id, levels] of byCriterion) {
    if ([...levels.values()].every((s) => s === 'untestable')) continue;
    for (const level of LEVELS) {
      if (!levels.has(level)) p.push(`Criterion ${id} has no test at the ${level} level.`);
    }
  }
  if (v.criteria.some((c) => c?.status === 'untestable') && v.spec_questions.length === 0) {
    p.push('An "untestable" criterion must come with a question in "spec_questions".');
  }
  return p;
}

// Phase 1: the tests exist and fail before implementation.
function checkPhase1(v) {
  const p = [];
  const shell = v.criteria.filter((c) => c.level === 'shell' && c.status === 'written');
  if (shell.length && !existsSync(join(PROJECT, 'e2e', `${v.ticket}.spec.ts`))) {
    p.push(`The file e2e/${v.ticket}.spec.ts was not found: write the shell-level scenarios.`);
  }
  const mfe = v.criteria.filter((c) => c.level === 'mfe' && c.status === 'written');
  if (mfe.length) {
    const vitest = readReport('vitest.json');
    if (vitest === null) {
      p.push('Run npm run test:affected: the new tests must fail before implementation.');
    } else if (vitest === undefined) {
      p.push('The report reports/vitest.json is unreadable: run npm run test:affected again.');
    } else if ((vitest.numFailedTests ?? 0) < mfe.length) {
      p.push(
        `Only ${vitest.numFailedTests ?? 0} failing test(s) for ${mfe.length} MFE-level criterion/criteria: ` +
          'a test that passes before implementation does not test the new behavior.',
      );
    }
  }
  return p;
}

// Phase 2: the verdict must match the actual test reports.
function checkPhase2(v) {
  const vitest = readReport('vitest.json');
  const playwright = readReport('playwright.json');
  if (vitest === undefined || playwright === undefined) return ['A test report is unreadable: run the tests again.'];
  if (!vitest && !playwright) return ['No test report: run the tests before giving your verdict.'];

  const p = [];
  const mfeFailures = vitest?.numFailedTests ?? 0;
  const failures = mfeFailures + (playwright?.stats?.unexpected ?? 0);
  const flaky = playwright?.stats?.flaky ?? 0;
  const statuses = v.criteria.map((c) => c.status);

  if (v.verdict === 'pass') {
    if (failures > 0) p.push(`Your verdict is "pass", but the reports contain ${failures} failing test(s).`);
    if (!playwright) p.push('The shell level was not run: a "pass" verdict requires both levels.');
    if (statuses.some((s) => s !== 'pass')) p.push('A "pass" verdict requires the "pass" status for every criterion, at both levels.');
  }
  if (v.verdict === 'fail') {
    if (failures === 0) p.push('Your verdict is "fail", but the reports contain no failing test.');
    if (!statuses.includes('fail')) p.push('A "fail" verdict must point to at least one failing criterion.');
  }
  if (statuses.includes('not_run') && mfeFailures === 0) {
    p.push('The "not_run" status is only allowed when the MFE level failed.');
  }
  if (flaky > 0 && v.flaky_tests.length === 0) {
    p.push(`${flaky} flaky test(s) in the Playwright report: list them in "flaky_tests".`);
  }
  return p;
}

function check(v) {
  if (!v) return ['End with the verdict JSON, and nothing else.'];
  const structure = checkStructure(v);
  if (structure.length) return structure;
  if (v.verdict === 'blocked') {
    return v.spec_questions.length ? [] : ['A "blocked" verdict must ask at least one question in "spec_questions".'];
  }
  const criteria = checkCriteria(v);
  if (criteria.length) return criteria;
  return PHASE === 1 ? checkPhase1(v) : checkPhase2(v);
}

try {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    reject(['Unreadable check input.']);
  }
  // The rejection counter is specific to each run: a run-qa.sh launch (QA_RUN_ID),
  // otherwise a subagent invocation (agent_id), otherwise the session.
  const run = process.env.QA_RUN_ID || input.agent_id || input.session_id;
  if (PHASE !== 1 && PHASE !== 2) reject(['Unknown phase: expected 1 or 2.'], run);

  const verdict = extractVerdict(input.last_assistant_message);
  const problems = check(verdict);
  if (problems.length) reject(problems, run);
  if (FINAL) console.log(JSON.stringify(verdict));
  process.exit(0);
} catch (error) {
  reject([`internal error in the check (${error.message}).`], 'error');
}
