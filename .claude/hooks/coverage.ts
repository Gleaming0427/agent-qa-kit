// The coverage summary of a phase 1 verdict: what a reviewer needs to see what the tests miss.
//
// Reading test code shows what is wrong in it, not what is missing. So the writer states, for each
// criterion, the cases its tests use (the data, the expected values with the arithmetic that gives
// them, and the wrong implementation each case rules out) and what they do not cover. The review
// pull request shows it. The arithmetic is recomputed here: a wrong expected amount makes a test
// fail on a correct implementation, and the RED check cannot see it, since the feature is missing.

export interface CoverageCase { data: string; expect: string; rules_out: string }
export interface CriterionCoverage { id: string; cases: CoverageCase[]; not_covered: string[] }

const NUMBER = String.raw`€?\s*\d+(?:[.,]\d{1,2})?\s*%?`;
const OP = String.raw`\s*[+\-−×*/÷]\s*|\s+x\s+`;
// The arithmetic expression that ends right before an "=", and the number right after it.
const LEFT = new RegExp(String.raw`(${NUMBER}(?:(?:${OP})${NUMBER})+)\s*$`);
const RIGHT = new RegExp(String.raw`^\s*(-?\s*${NUMBER})`);

const value = (token: string): number => {
  const text = token.replace(/[€\s]/g, '').replace(',', '.');
  return text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
};

/** Evaluates "a op b op c", with × and / before + and −. */
function evaluate(expression: string): number | null {
  const tokens = expression.match(new RegExp(String.raw`${NUMBER}|[+\-−×*/÷]|(?<=\s)x(?=\s)`, 'g'));
  if (!tokens || tokens.length < 3 || tokens.length % 2 === 0) return null;
  const terms: number[] = [value(tokens[0])];
  const signs: number[] = [1];
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i];
    const n = value(tokens[i + 1]);
    if (!Number.isFinite(n)) return null;
    if (op === '+' || op === '-' || op === '−') { terms.push(n); signs.push(op === '+' ? 1 : -1); continue; }
    const last = terms.length - 1;
    if (op === '/' || op === '÷') { if (n === 0) return null; terms[last] /= n; } else terms[last] *= n;
  }
  return terms.reduce((sum, t, i) => sum + signs[i] * t, 0);
}

/** Every "a op b = c" in a text that does not add up, rounding to the cent allowed. */
export function arithmeticProblems(text: string): string[] {
  const problems: string[] = [];
  const parts = text.split('=');
  for (let i = 0; i < parts.length - 1; i++) {
    const left = parts[i].match(LEFT);
    const right = parts[i + 1].match(RIGHT);
    if (!left || !right) continue;
    const computed = evaluate(left[1]);
    const stated = value(right[1].replace(/\s/g, ''));
    if (computed === null || !Number.isFinite(stated)) continue;
    if (Math.abs(computed - stated) > 0.0051) {
      problems.push(`${left[1].trim()} = ${right[1].trim()} does not add up: it is ${(Math.round(computed * 100) / 100).toFixed(2)}`);
    }
  }
  return problems;
}

const text = (x: unknown) => typeof x === 'string' && x.trim().length > 0;

/** What is wrong with the coverage of a phase 1 verdict, for the criteria that have written tests. */
export function coverageProblems(coverage: unknown, written: string[]): string[] {
  if (!written.length) return [];
  if (!Array.isArray(coverage)) {
    return ['Add "coverage" to the verdict: for each criterion, the cases the tests use and what they do not cover.'];
  }
  const problems: string[] = [];
  const byId = new Map<string, unknown>();
  for (const entry of coverage) {
    const id = (entry as { id?: unknown })?.id;
    if (typeof id === 'string') byId.set(id, entry);
  }
  for (const id of written) {
    const entry = byId.get(id) as Partial<CriterionCoverage> | undefined;
    if (!entry) { problems.push(`coverage: ${id} is missing.`); continue; }
    if (!Array.isArray(entry.cases) || !entry.cases.length) {
      problems.push(`coverage: ${id} needs its cases, each with "data", "expect" and "rules_out".`);
    } else {
      entry.cases.forEach((c, i) => {
        const where = `coverage: ${id} case ${i + 1}`;
        if (!text(c?.data) || !text(c?.expect) || !text(c?.rules_out)) {
          problems.push(`${where} needs "data", "expect" and the wrong implementation it rules out, in "rules_out".`);
          return;
        }
        for (const p of [...arithmeticProblems(c.data), ...arithmeticProblems(c.expect)]) problems.push(`${where}: ${p}.`);
      });
    }
    if (!Array.isArray(entry.not_covered) || !entry.not_covered.some(text)) {
      problems.push(`coverage: ${id} needs "not_covered": the inputs or edges its tests leave out, for the reviewer to judge.`);
    }
  }
  return problems;
}

/** The coverage of one criterion, as the review pull request shows it. */
export function coverageMarkdown(entry: CriterionCoverage | undefined): string[] {
  if (!entry) return [];
  const plain = (s: string) => s.replace(/`/g, "'");
  return [
    '**What the tests cover.** Each case, and the wrong implementation it rules out:',
    ...entry.cases.map((c) => `- ${plain(c.data)}: ${plain(c.expect)}. Rules out: ${plain(c.rules_out)}.`),
    '',
    '**Not covered.** A missing case does not show in the test code. Ask for one of these if the ticket needs it:',
    ...entry.not_covered.filter(text).map((s) => `- ${plain(s)}`),
  ];
}
