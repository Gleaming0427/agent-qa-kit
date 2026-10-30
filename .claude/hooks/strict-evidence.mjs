/** Deterministic, strict QA evidence validator. No LLM, no dependencies.
 * Agents do not get to choose which criteria exist: the ticket manifest is the authority.
 * Each test title MUST contain [TICKET-42][AC-1]. The reports must contain actual results.
 */
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const LEVELS = ['mfe', 'shell'];
const formatKey = (id, level) => `${id}:${level}`;
const cleanName = (s) => String(s ?? '');

function isNamedFor(title, ticket, id) {
  return title.includes(`[${ticket}]`) && title.includes(`[${id}]`);
}

export function extractVitestTests(report) {
  const tests = [];
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

export function extractPlaywrightTests(report) {
  const tests = [];
  function visit(suites, ancestor = [], inheritedFile = '') {
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

function classifyVitest(test) {
  if (test.status === 'passed') return 'pass';
  if (test.status === 'failed') return 'fail';
  return 'blocked'; // pending, skipped, todo, unknown
}
function classifyPlaywright(test) {
  if (test.status === 'unexpected') return 'fail';
  if (test.status !== 'expected') return 'blocked'; // flaky, skipped
  if (!test.results.length || !test.results.some((r) => r.status === 'passed')) return 'blocked';
  if (test.results.some((r) => r.status === 'failed' || r.status === 'timedOut')) return 'blocked';
  return 'pass';
}
function allSame(values) { return values.length === 1 ? values[0] : 'blocked'; }
function collectMatches(tests, ticket, id, level) {
  return tests.filter((t) => isNamedFor(t.title, ticket, id) && (
    level === 'mfe'
      ? /\.test\.[jt]sx?$/.test(t.file) || !t.file // Vitest custom reporters may omit filenames
      : t.file.endsWith(`${ticket}.spec.ts`) || t.file.endsWith(`${ticket}.spec.js`)
  ));
}

/** Returns problems and an evidence table. Does not trust agent-provided evidence strings. */
export function validateEvidence({ verdict, manifest, phase, vitest, playwright, specText, root = process.cwd() }) {
  const problems = [];
  const evidence = [];
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
  const declared = new Map();
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
      const matches = collectMatches(level === 'mfe' ? unitTests : e2eTests, verdict.ticket, id, level);
      const states = matches.map((t) => level === 'mfe' ? classifyVitest(t) : classifyPlaywright(t));
      const result = matches.length ? (states.includes('fail') ? 'fail' : allSame([...new Set(states)])) : 'not_run';
      evidence.push({ criterion: id, level, result, tests: matches.map((t) => ({ title: t.title, status: t.status, file: t.file })) });
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

export function readRequiredJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}
