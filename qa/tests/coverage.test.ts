import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { arithmeticProblems, coverageMarkdown, coverageProblems } from '../../.claude/hooks/coverage.ts';
import { buildManifest } from '../criteria-manifest.ts';
import { prepareReview, reviewMarkdown } from '../scenario-review.ts';

const root = resolve(import.meta.dirname, '../..');
const good = (id = 'AC-1') => ({
  id,
  cases: [{ data: '2 notebooks at €4.50 and 1 pen set at €6.00', expect: 'subtotal 2 × 4.50 + 6.00 = 15.00', rules_out: 'a subtotal that ignores quantities (10.50)' }],
  not_covered: ['an empty cart'],
});

test('the arithmetic of the expected amounts is recomputed, rounding to the cent allowed', () => {
  assert.deepEqual(arithmeticProblems('discount 53.50 × 10% = 5.35, total 53.50 − 5.35 = 48.15'), []);
  assert.deepEqual(arithmeticProblems('€4.50 + €6.00 = €10.50 + €4.90 = €15.40'), []);
  assert.deepEqual(arithmeticProblems('19.99 × 10% = 2.00; 3 x 1.00 = 3.00; 28,40 = 19,50 + 4,90 + 4,00'), []);
  // The wrong amounts of two false positives found by the evaluation.
  assert.deepEqual(arithmeticProblems('total 19.50 + 4.90 + 4.00 = 24.40'), ['19.50 + 4.90 + 4.00 = 24.40 does not add up: it is 28.40']);
  assert.deepEqual(arithmeticProblems('hint 50.00 - 29.90 - 12.00 - 4.50 = 5.40'), ['50.00 - 29.90 - 12.00 - 4.50 = 5.40 does not add up: it is 3.60']);
  // Text that is not arithmetic is left alone.
  assert.deepEqual(arithmeticProblems('AC-1 = the first criterion; Total = €22.90; 12 = 12'), []);
});

test('each criterion with written tests needs its cases, what each rules out, and what is not covered', () => {
  assert.deepEqual(coverageProblems([good()], ['AC-1']), []);
  assert.deepEqual(coverageProblems(undefined, []), [], 'nothing to cover without written tests');
  assert.match(coverageProblems(undefined, ['AC-1'])[0], /Add "coverage"/);
  assert.deepEqual(coverageProblems([good()], ['AC-1', 'AC-2']), ['coverage: AC-2 is missing.']);
  assert.match(coverageProblems([{ ...good(), cases: [] }], ['AC-1'])[0], /AC-1 needs its cases/);
  assert.match(coverageProblems([{ ...good(), cases: [{ data: 'x', expect: 'y', rules_out: '' }] }], ['AC-1'])[0], /rules_out/);
  assert.match(coverageProblems([{ ...good(), not_covered: [] }], ['AC-1'])[0], /needs "not_covered"/);
  const wrong = { ...good(), cases: [{ ...good().cases[0], expect: 'subtotal 2 × 4.50 + 6.00 = 16.00' }] };
  assert.deepEqual(coverageProblems([wrong], ['AC-1']), ['coverage: AC-1 case 1: 2 × 4.50 + 6.00 = 16.00 does not add up: it is 15.00.']);
  const lines = coverageMarkdown(good());
  assert.match(lines.join('\n'), /What the tests cover[\s\S]*2 notebooks at €4.50 and 1 pen set at €6.00: subtotal 2 × 4.50 \+ 6.00 = 15.00\. Rules out: a subtotal that ignores quantities[\s\S]*Not covered[\s\S]*- an empty cart/);
  assert.deepEqual(coverageMarkdown(undefined), []);
});

// A phase 1 project whose RED evidence is valid, for the Stop hook in strict mode.
function project(coverage?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-coverage-'));
  const spec = '- AC-1: the subtotal is the sum of price times quantity\n';
  for (const sub of ['reports', 'specs', 'e2e', 'src']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'specs/TICKET-42.md'), spec);
  writeFileSync(join(dir, 'reports/TICKET-42-criteria.json'), JSON.stringify(buildManifest('TICKET-42', spec)));
  writeFileSync(join(dir, 'e2e/TICKET-42.spec.ts'), "test('[TICKET-42][AC-1] shell subtotal', () => {});\n");
  writeFileSync(join(dir, 'src/Cart.test.tsx'), "test('[TICKET-42][AC-1] MFE subtotal', () => {});\n");
  writeFileSync(join(dir, 'reports/vitest.json'), JSON.stringify({ numFailedTests: 1, numPassedTests: 0, testResults: [{
    name: join(dir, 'src/Cart.test.tsx'),
    assertionResults: [{ fullName: '[TICKET-42][AC-1] MFE subtotal', status: 'failed', failureMessages: ['expected "€10.50" to be "€15.00"'] }],
  }] }));
  writeFileSync(join(dir, 'reports/playwright.json'), JSON.stringify({ stats: { expected: 0, unexpected: 1, flaky: 0 }, suites: [{
    title: 'TICKET-42.spec.ts', file: 'TICKET-42.spec.ts', specs: [{ title: '[TICKET-42][AC-1] shell subtotal', file: 'TICKET-42.spec.ts',
      tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'Error: expect(locator).toContainText(expected) failed' } }] }] }],
  }] }));
  const verdict = {
    ticket: 'TICKET-42', phase: 1, verdict: 'ready',
    criteria: ['mfe', 'shell'].map((level) => ({ id: 'AC-1', level, status: 'written', evidence: `[TICKET-42][AC-1] ${level} test` })),
    ...(coverage === undefined ? {} : { coverage }), flaky_tests: [], spec_questions: [], alerts: [],
  };
  const hook = spawnSync(process.execPath, [join(root, '.claude/hooks/verdict-check.ts'), '1', '--final'], {
    input: JSON.stringify({ last_assistant_message: `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`` }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, QA_PHASE: '1', QA_STRICT_EVIDENCE: '1',
      QA_SPEC_PATH: join(dir, 'specs/TICKET-42.md'), QA_MANIFEST_PATH: join(dir, 'reports/TICKET-42-criteria.json') },
  });
  return { dir, hook, verdict };
}

test('the Stop hook sends back a phase 1 verdict without its coverage or with a wrong amount', () => {
  for (const [coverage, expected] of [
    [undefined, /Add "coverage" to the verdict/],
    [[{ ...good(), cases: [{ ...good().cases[0], expect: '2 × 4.50 + 6.00 = 14.00' }] }], /AC-1 case 1: 2 × 4.50 \+ 6.00 = 14.00 does not add up: it is 15.00/],
  ] as const) {
    const p = project(coverage);
    try {
      assert.equal(p.hook.status, 2, p.hook.stdout);
      assert.match(p.hook.stderr, expected);
    } finally { rmSync(p.dir, { recursive: true, force: true }); }
  }
  const ok = project([good()]);
  try {
    assert.equal(ok.hook.status, 0, ok.hook.stderr);
    assert.deepEqual(JSON.parse(ok.hook.stdout).coverage, [good()], 'the launcher keeps the coverage in the phase 1 verdict');
    // The review pull request shows it, criterion by criterion.
    writeFileSync(join(ok.dir, 'reports/TICKET-42-phase1.json'), ok.hook.stdout);
    prepareReview({ root: ok.dir, ticket: 'TICKET-42', specPath: join(ok.dir, 'specs/TICKET-42.md') });
    assert.match(reviewMarkdown({ root: ok.dir, ticket: 'TICKET-42' }),
      /### AC-1: the subtotal[\s\S]*Unit test[\s\S]*What the tests cover[\s\S]*Rules out: a subtotal that ignores quantities[\s\S]*Not covered[\s\S]*- an empty cart[\s\S]*### How to approve/);
    assert.doesNotMatch(reviewMarkdown({ root: ok.dir, ticket: 'TICKET-42' }), /longer number|already pass/);
    // A unit test that already passed before the feature existed is listed with its criterion (OMNI-1 had two).
    writeFileSync(join(ok.dir, 'reports/TICKET-42-red-vitest.json'), JSON.stringify({ numFailedTests: 1, numPassedTests: 2, testResults: [{
      name: join(ok.dir, 'src/Cart.test.tsx'), assertionResults: [
        { fullName: '[TICKET-42][AC-1] MFE subtotal', status: 'failed', failureMessages: ['expected "€10.50" to be "€15.00"'] },
        { fullName: ' Cart [TICKET-42][AC-1] MFE subtotal of an empty cart', status: 'passed', failureMessages: [] },
        { fullName: 'Cart keeps its lines', status: 'passed', failureMessages: [] },
      ] }] }));
    assert.match(reviewMarkdown({ root: ok.dir, ticket: 'TICKET-42' }),
      /### Tests that already pass without the feature\nThe kit accepts them as long as another test of the same criterion fails[^\n]*\n- AC-1, unit test `Cart \[TICKET-42\]\[AC-1\] MFE subtotal of an empty cart`\n\n### How to approve/);
    // A browser assertion that a longer number would still pass is listed for the reviewer, with that number.
    writeFileSync(join(ok.dir, 'e2e/TICKET-42.spec.ts'), "test('[TICKET-42][AC-1] shell subtotal', async ({ page }) => {\n"
      + "  await expect(page.getByRole('row', { name: 'Total' })).toContainText('€15.00');\n"
      + "  await expect(page.getByText('3 items')).toBeVisible();\n});\n");
    assert.match(reviewMarkdown({ root: ok.dir, ticket: 'TICKET-42' }),
      /- an empty cart[\s\S]*### Assertions that also pass on a longer number\nPlaywright finds a text by its part[^\n]*\n- `e2e\/TICKET-42\.spec\.ts`, line 3: `getByText\('3 items'\)` also accepts "13 items"\nCheck that another assertion[^\n]*`\/\(\?<!\\d\)4 products\/`\.\n\n### How to approve/);
  } finally { rmSync(ok.dir, { recursive: true, force: true }); }
});
