#!/usr/bin/env node
/** Claude Code Stop/SubagentStop and launcher verdict validation.
 * Strict evidence is required by qa/run-qa.sh; older direct demo mode stays
 * compatible with the original lightweight validation.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEvidence, readRequiredJson } from './strict-evidence.mjs';

const args = process.argv.slice(2);
const FINAL = args.includes('--final');
const PHASE = Number(args.find((a) => a === '1' || a === '2') ?? process.env.QA_PHASE);
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STRICT = process.env.QA_STRICT_EVIDENCE === '1';
const VERDICTS = { 1: ['ready', 'blocked'], 2: ['pass', 'fail', 'blocked'] };
const STATUSES = { 1: ['written', 'untestable'], 2: ['pass', 'fail', 'not_run', 'untestable'] };
const LEVELS = ['mfe', 'shell'];
const LISTS = ['criteria', 'flaky_tests', 'spec_questions', 'alerts'];

function reject(problems, run = 'unknown') {
  const msg = `Verdict check: fix these points before finishing.\n- ${problems.join('\n- ')}`;
  if (FINAL) { console.error(msg); process.exit(2); }
  const counter = join(tmpdir(), `verdict-check-${String(run).replace(/[^\w-]/g, '_')}.txt`);
  let count = 0;
  try { count = Number(readFileSync(counter, 'utf8')) || 0; } catch {}
  if (count >= 3) {
    console.error(`${msg}\n(Three rejections reached: launcher will reject invalid verdict.)`);
    process.exit(0);
  }
  try { writeFileSync(counter, String(count + 1)); } catch {}
  console.error(msg);
  process.exit(2);
}
function extractVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const values = [text.trim()];
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  if (blocks.length) values.push(blocks.at(-1)[1]);
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) values.push(text.slice(start, end + 1));
  for (const str of values) {
    try { const v = JSON.parse(str); if (v && typeof v === 'object' && !Array.isArray(v)) return v; }
    catch {}
  }
  return null;
}
function readReport(name) {
  const path = join(PROJECT, 'reports', name);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return undefined; }
}
function checkStructure(v) {
  const problems = [];
  if (typeof v.ticket !== 'string' || !v.ticket.trim()) problems.push('Missing ticket.');
  if (v.phase !== PHASE) problems.push(`Phase must be ${PHASE}.`);
  if (!VERDICTS[PHASE]?.includes(v.verdict)) problems.push(`Verdict must be ${VERDICTS[PHASE]?.join(' or ')}.`);
  for (const f of LISTS) if (!Array.isArray(v[f])) problems.push(`${f} must be a list.`);
  return problems;
}
function checkCriteria(v) {
  const problems = [];
  if (!v.criteria.length) return ['Criteria list is empty.'];
  const by = new Map();
  for (const [i, c] of v.criteria.entries()) {
    const where = `criteria[${i}]`;
    if (!c || typeof c !== 'object') { problems.push(`${where} is not an object.`); continue; }
    if (typeof c.id !== 'string' || !c.id.trim()) problems.push(`${where}: id missing.`);
    if (!LEVELS.includes(c.level)) problems.push(`${where}: invalid level.`);
    if (!STATUSES[PHASE].includes(c.status)) problems.push(`${where}: invalid status.`);
    if (typeof c.evidence !== 'string' || !c.evidence.trim()) problems.push(`${where}: missing evidence.`);
    if (typeof c.id === 'string' && LEVELS.includes(c.level)) {
      if (!by.has(c.id)) by.set(c.id, new Set());
      by.get(c.id).add(c.level);
    }
  }
  for (const [id, levels] of by) {
    for (const level of LEVELS) if (!levels.has(level)) problems.push(`${id} has no ${level} test.`);
  }
  if (v.criteria.some((c) => c?.status === 'untestable') && !v.spec_questions.length) problems.push('Untestable requires a question.');
  return problems;
}
function checkPhase1(v) {
  const problems = [];
  const shell = v.criteria.filter((c) => c.level === 'shell' && c.status === 'written');
  if (shell.length && !existsSync(join(PROJECT, 'e2e', `${v.ticket}.spec.ts`))) problems.push(`Missing e2e/${v.ticket}.spec.ts.`);
  const mfe = v.criteria.filter((c) => c.level === 'mfe' && c.status === 'written');
  if (mfe.length) {
    const report = readReport('vitest.json');
    if (report === null) problems.push('Run npm run test:affected before completing phase 1.');
    else if (report === undefined) problems.push('Vitest report unreadable.');
    else if ((report.numFailedTests ?? 0) < mfe.length) problems.push('Not enough failing MFE tests before implementation.');
  }
  return problems;
}
function checkPhase2(v) {
  const vitest = readReport('vitest.json');
  const playwright = readReport('playwright.json');
  if (vitest === undefined || playwright === undefined) return ['Unreadable report.'];
  if (!vitest && !playwright) return ['No test report found.'];
  const problems = [];
  const mfeFailures = vitest?.numFailedTests ?? 0;
  const failures = mfeFailures + (playwright?.stats?.unexpected ?? 0);
  const statuses = v.criteria.map((c) => c.status);
  if (v.verdict === 'pass') {
    if (failures) problems.push(`Pass claimed despite ${failures} failure(s).`);
    if (!playwright) problems.push('Shell-level report missing.');
    if (statuses.some((s) => s !== 'pass')) problems.push('All criteria must pass.');
  }
  if (v.verdict === 'fail') {
    if (!failures) problems.push('Fail verdict without failing test report.');
    if (!statuses.includes('fail')) problems.push('Fail verdict without failing criterion.');
  }
  if (statuses.includes('not_run') && !mfeFailures) problems.push('not_run requires an MFE failure.');
  if ((playwright?.stats?.flaky ?? 0) && !v.flaky_tests.length) problems.push('Flaky tests must be reported.');
  return problems;
}
function check(v) {
  if (!v) return ['End with the verdict JSON.'];
  const basic = checkStructure(v);
  if (basic.length) return basic;
  if (v.verdict === 'blocked') {
    const problems = v.spec_questions.length ? [] : ['Blocked verdict must ask a question.'];
    if (STRICT) {
      const manifest = readRequiredJson(process.env.QA_MANIFEST_PATH || '');
      if (!manifest || manifest.ticket !== v.ticket) problems.push('Missing or mismatched manifest.');
    }
    return problems;
  }
  const problems = checkCriteria(v);
  if (problems.length) return problems;
  problems.push(...(PHASE === 1 ? checkPhase1(v) : checkPhase2(v)));
  if (STRICT) {
    const manifest = readRequiredJson(process.env.QA_MANIFEST_PATH || '');
    let specText;
    try { specText = readFileSync(process.env.QA_SPEC_PATH, 'utf8'); }
    catch { return [...problems, 'Cannot read the authoritative ticket spec.']; }
    const strict = validateEvidence({
      verdict: v, manifest, phase: PHASE,
      vitest: readReport('vitest.json'), playwright: readReport('playwright.json'),
      specText, root: PROJECT,
    });
    problems.push(...strict.problems);
  }
  return [...new Set(problems)];
}
try {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { reject(['Unreadable hook input.']); }
  const run = process.env.QA_RUN_ID || input.agent_id || input.session_id;
  if (PHASE !== 1 && PHASE !== 2) reject(['Expected phase 1 or 2.'], run);
  const verdict = extractVerdict(input.last_assistant_message);
  const problems = check(verdict);
  if (problems.length) reject(problems, run);
  if (FINAL) console.log(JSON.stringify(verdict));
} catch (error) {
  reject([`Internal validator error: ${error.message}`], 'internal');
}
