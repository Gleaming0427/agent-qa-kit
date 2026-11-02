#!/usr/bin/env node
// Checks the evaluation corpus itself, with no model call: a grader is only as good as its tasks.
// For each ticket with a reference implementation:
//   - gold.diff and each bug diff apply to the current shop, and every variant type-checks;
//   - each criterion has a hidden test that fails on the shop as it is (the feature is missing);
//   - gold passes every hidden test and the shop's existing suite (screenshots aside);
//   - each bug fails at least one hidden test of the criterion it breaks.
// Usage: node eval/validate-corpus.ts [TICKET...]   (needs npm ci and Chromium in examples/shop)
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTickets, loadTicket, makeVariant, merge, runPlaywright, runVitest, typeCheck } from './lib/workspace.ts';
import type { VariantResult } from './lib/score.ts';

const HIDDEN = 'e2e/__hidden__.spec.ts';
const tickets = process.argv.slice(2).length ? process.argv.slice(2) : listTickets();
const work = mkdtempSync(join(tmpdir(), 'eval-corpus-'));
const problems: string[] = [];
const summary: Record<string, unknown> = {};

function hidden(ticket: ReturnType<typeof loadTicket>, variant: string): VariantResult {
  const dir = join(work, `${ticket.ticket}-${variant}`);
  makeVariant(ticket, variant, dir);
  copyFileSync(join(ticket.dir, 'hidden.spec.ts'), join(dir, HIDDEN));
  if (variant !== 'base') {
    const tsc = typeCheck(dir);
    if (!tsc.ok) problems.push(`${ticket.ticket} ${variant}: does not type-check: ${tsc.output}`);
  }
  const result = runPlaywright(dir, [HIDDEN], ticket.ticket);
  if (!result.ran) problems.push(`${ticket.ticket} ${variant}: hidden tests did not run: ${result.error}`);
  if (variant === 'gold') {
    // The reference implementation must not break the existing suite.
    const existing = merge(runVitest(dir, ['src'], ticket.ticket), runPlaywright(dir, ['e2e'], ticket.ticket));
    const broken = existing.tests.filter((t) => t.status !== 'pass').map((t) => t.title);
    if (!existing.ran) problems.push(`${ticket.ticket} gold: existing suite did not run: ${existing.error}`);
    if (broken.length) problems.push(`${ticket.ticket} gold: existing tests fail: ${broken.join('; ')}`);
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

try {
  for (const name of tickets) {
    const ticket = loadTicket(name);
    if (ticket.kind === 'ambiguous') { summary[name] = 'ambiguous: no reference implementation'; continue; }
    const base = hidden(ticket, 'base');
    const gold = hidden(ticket, 'gold');
    const criteria = [...new Set(gold.tests.flatMap((t) => t.criteria))];
    for (const criterion of criteria) {
      const failing = base.tests.filter((t) => t.criteria.includes(criterion) && t.status === 'fail');
      if (!failing.length) problems.push(`${name}: no hidden test of ${criterion} fails on the shop as it is`);
    }
    const notPassing = gold.tests.filter((t) => t.status !== 'pass');
    if (notPassing.length) problems.push(`${name} gold: hidden tests do not pass: ${notPassing.map((t) => `${t.title} (${t.status})`).join('; ')}`);
    const bugs: Record<string, string> = {};
    for (const bug of ticket.bugs) {
      const result = hidden(ticket, bug.id);
      const caught = result.tests.filter((t) => t.status === 'fail' && t.criteria.includes(bug.criterion));
      bugs[bug.id] = caught.length ? `caught by ${caught.length} hidden test(s) of ${bug.criterion}` : 'NOT caught';
      if (!caught.length) problems.push(`${name} bug ${bug.id}: no hidden test of ${bug.criterion} fails`);
    }
    summary[name] = { criteria, hidden_tests: gold.tests.length, base_failures: base.tests.filter((t) => t.status === 'fail').length, bugs };
    console.log(`${name}: ${JSON.stringify(summary[name])}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

writeFileSync(process.env.EVAL_CORPUS_REPORT || '/dev/null', `${JSON.stringify({ problems, summary }, null, 2)}\n`);
if (problems.length) {
  console.error(`\nCorpus INVALID (${problems.length} problem(s)):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`\nCorpus valid: ${tickets.length} ticket(s) checked.`);
