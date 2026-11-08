#!/usr/bin/env node
// Browser test assertions that would also pass on a longer number.
//
// Playwright matches text by its part: toContainText('× 1') passes on "× 12", and a lookup by text,
// label or accessible name without `exact: true` finds "4 products" in "14 products" (it also ignores
// case). Checked with @playwright/test 1.55.1. A number that starts the expected text, or a whole
// number that ends it, can therefore grow on a wrong implementation without failing the test. Text
// around the number protects it: "€4.90" is not found in "€14.90". The reviewer of the QA pull request
// gets the list; nothing is refused, since another assertion may already rule the longer value out.
//
// Usage: node qa/loose-assertions.ts FILE...   (prints one line per assertion found)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LooseAssertion {
  line: number;
  /** The assertion's text lookup or matcher, as written. */
  code: string;
  /** A longer value it would also accept. */
  accepts: string;
}

/** A longer value that still contains the expected text, when a number can grow at its start or end. */
export function longerValue(expected: string): string | null {
  if (expected.includes('${')) return null;
  if (/^\d/.test(expected)) return `1${expected}`;
  // A whole number at the end; a decimal part ("4.90") is a complete amount.
  if (/(^|[^\d.,])\d+$/.test(expected)) return `${expected}0`;
  return null;
}

const STRING = String.raw`(['"])((?:\\.|(?!\1)[^\\\n])*)\1`;
// getByText('…'), getByLabel('…', { … }), … : the text is the first argument.
const BY_TEXT = new RegExp(String.raw`getBy(?:Text|Label|Placeholder|AltText|Title)\(\s*${STRING}\s*(?:,\s*\{([^{}]*)\})?\s*\)`, 'g');
// getByRole('heading', { name: '…', … }): the text is the name option.
const BY_ROLE = /getByRole\(\s*(['"])[^'"\n]*\1\s*,\s*\{([^{}]*)\}\s*\)/g;
const NAME = new RegExp(String.raw`name\s*:\s*${STRING}`);
const CONTAINS = new RegExp(String.raw`\.toContainText\(\s*${STRING}`, 'g');

/** The ranges of the expect(...) arguments in a source, with what follows each one (its matcher). */
function expectations(source: string): { from: number; to: number; matcher: string }[] {
  const ranges: { from: number; to: number; matcher: string }[] = [];
  const opener = /\bexpect(?:\.soft)?\(/g;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      const char = source[i];
      if (char === "'" || char === '"' || char === '`') {
        // Skip a string literal.
        for (i++; i < source.length && source[i] !== char; i++) if (source[i] === '\\') i++;
      } else if (char === '(') depth++;
      else if (char === ')') depth--;
    }
    ranges.push({ from: match.index + match[0].length, to: i - 1, matcher: source.slice(i, i + 80) });
  }
  return ranges;
}

// A negated assertion, or one that expects nothing, gets stricter with a looser lookup, not weaker.
const negated = (matcher: string) => /^\s*\.not\./.test(matcher) || /^\s*\.toHaveCount\(\s*0\s*\)/.test(matcher);

/** The assertions of a Playwright test file that would also pass on a longer number. */
export function looseAssertions(source: string): LooseAssertion[] {
  const found: LooseAssertion[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  const ranges = expectations(source);
  const assertedAt = (index: number) => ranges.find((r) => index >= r.from && index < r.to);
  const add = (index: number, code: string, expected: string) => {
    const accepts = longerValue(expected);
    if (accepts) found.push({ line: lineOf(index), code: code.replace(/\s+/g, ' '), accepts });
  };
  const lookups: { index: number; code: string; expected: string; options: string }[] = [];
  for (const m of source.matchAll(BY_TEXT)) lookups.push({ index: m.index ?? 0, code: m[0], expected: m[2], options: m[3] ?? '' });
  for (const m of source.matchAll(BY_ROLE)) {
    const name = NAME.exec(m[2]);
    if (name) lookups.push({ index: m.index ?? 0, code: m[0], expected: name[2], options: m[2] });
  }
  for (const lookup of lookups) {
    const range = assertedAt(lookup.index);
    if (!range || negated(range.matcher) || /\bexact\s*:\s*true\b/.test(lookup.options)) continue;
    add(lookup.index, lookup.code, lookup.expected);
  }
  for (const m of source.matchAll(CONTAINS)) {
    const at = m.index ?? 0;
    if (/\.not\s*$/.test(source.slice(Math.max(0, at - 10), at))) continue;
    add(at, `${m[0].slice(1)})`, m[2]);
  }
  return found.sort((a, b) => a.line - b.line);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const file of process.argv.slice(2)) {
    for (const { line, code, accepts } of looseAssertions(readFileSync(file, 'utf8'))) {
      console.log(`${file}:${line}: ${code} also accepts "${accepts}"`);
    }
  }
}
