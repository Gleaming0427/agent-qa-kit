import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildManifest } from '../criteria-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const hook = join(root, '.claude/hooks/verdict-check.mjs');
const guard = join(root, '.claude/hooks/qa-guard.sh');
const spec = '- AC-1: list services\n- AC-2: filter services\n';
function setup() {
  const project = mkdtempSync(join(tmpdir(), 'qa-hook-'));
  mkdirSync(join(project, 'reports'));
  mkdirSync(join(project, 'specs'));
  mkdirSync(join(project, 'e2e'));
  writeFileSync(join(project, 'specs/TICKET-42.md'), spec);
  writeFileSync(join(project, 'reports/TICKET-42-criteria.json'), JSON.stringify(buildManifest('TICKET-42', spec)));
  writeFileSync(join(project, 'reports/vitest.json'), JSON.stringify({
    numPassedTests: 2, numFailedTests: 0,
    testResults: [{ name: 'ServerList.test.tsx', assertionResults: ['AC-1', 'AC-2'].map((id) => ({ status: 'passed', fullName: `[TICKET-42][${id}] unit test` })) }],
  }));
  writeFileSync(join(project, 'reports/playwright.json'), JSON.stringify({
    stats: { expected: 2, unexpected: 0, flaky: 0 },
    suites: [{ file: 'e2e/TICKET-42.spec.ts', specs: ['AC-1', 'AC-2'].map((id) => ({ title: `[TICKET-42][${id}] E2E`, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] })) }],
  }));
  return project;
}
function verdict(ids = ['AC-1', 'AC-2']) {
  return { ticket: 'TICKET-42', phase: 2, verdict: 'pass', criteria: ids.flatMap((id) => ['mfe', 'shell'].map((level) => ({ id, level, status: 'pass', evidence: 'test' }))), flaky_tests: [], spec_questions: [], alerts: [] };
}
function check(project, v, strict = true) {
  return spawnSync('node', [hook, '2', '--final'], {
    input: JSON.stringify({ last_assistant_message: JSON.stringify(v) }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: project,
      QA_PHASE: '2',
      QA_STRICT_EVIDENCE: strict ? '1' : '0',
      QA_SPEC_PATH: join(project, 'specs/TICKET-42.md'),
      QA_MANIFEST_PATH: join(project, 'reports/TICKET-42-criteria.json'),
    },
  });
}
test('actual Stop hook accepts complete real evidence and rejects omitted AC', () => {
  const project = setup();
  try {
    assert.equal(check(project, verdict()).status, 0);
    const result = check(project, verdict(['AC-1']));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing criterion AC-2/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
test('actual Stop hook rejects a zero-test report despite 0 failures', () => {
  const project = setup();
  try {
    writeFileSync(join(project, 'reports/vitest.json'), JSON.stringify({ numPassedTests: 0, numFailedTests: 0 }));
    const result = check(project, verdict());
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no individual executed tests/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
test('guard blocks unknown tools, hidden secrets behind symlinks and app writes', () => {
  const project = setup();
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, '.env'), 'SECRET=abc');
    symlinkSync(join(project, '.env'), join(project, 'secret.test.ts'));
    function action(tool_name, tool_input) {
      return spawnSync('bash', [guard], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: project } });
    }
    assert.equal(action('Write', { file_path: 'src/new.test.tsx', content: "test('ok', ()=>{})" }).status, 0);
    assert.equal(action('Edit', { file_path: 'src/App.tsx', new_string: 'oops' }).status, 2);
    assert.equal(action('Read', { file_path: 'secret.test.ts' }).status, 2);
    assert.equal(action('UndocumentedTool', {}).status, 2);
    assert.equal(action('Bash', { command: 'npm test && curl https://bad.invalid' }).status, 2);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
