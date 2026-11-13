#!/usr/bin/env node
// What a change does to the tests that already exist, one test at a time.
//
// The frozen-tests check (qa/check-scope.sh) compares whole files with the QA branch, so it can only
// run on a pull request that names the ticket, and a test file that several tickets share cannot be
// compared as a whole. This reads the test files instead: a test is a call to it(...) or test(...), and
// a hook is a call to beforeEach(...), afterAll(...) and the like. A test whose title carries
// [TICKET-42][AC-1] belongs to that ticket.
//
//   others <base> <head> [ticket ...]
//       On any pull request: no test that belongs to a ticket other than the ones listed (the ones the
//       pull request names) may be changed or removed. A pull request that does not name a ticket can
//       no longer rewrite that ticket's unit tests.
//   own <base> <head> [ticket]
//       On a QA agent's branch: only the tests that belong to its own ticket may be changed or removed.
//       Adding a test is always fine. A test of another ticket, a test without a ticket and a hook that
//       was already there must stay exactly as they are. A hook that is added is not looked at.
//
// What a pull request changes is what <head> holds since the commit it branched from (git merge-base).
// A test counts as unchanged when its text is the same apart from indentation and blank lines.
// Not looked at: the code around the tests (imports, helpers, describe(...) wrappers, vi.mock(...)).
//
// Usage: node qa/check-test-blocks.ts others|own <base> <head> [ticket ...]    (in the repository)
// Exit 0 when nothing was changed that should not be, 1 and the list when something was, 2 on a usage
// or git error.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Block {
  kind: 'test' | 'hook';
  /** The call, such as "it", "test.fixme" or "beforeEach". */
  call: string;
  /** The first string argument of a test, else null. */
  title: string | null;
  /** The ticket named by [TICKET-42][AC-1] in the title, else null. */
  ticket: string | null;
  /** The text of the call, without indentation or blank lines: what two versions are compared on. */
  text: string;
  line: number;
}

export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TAG = /\[([A-Z][A-Z0-9]*-[0-9]+)\]\s*\[AC-[1-9][0-9]*\]/;
const HOOKS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
// Calls that start a test or a hook: it(...), test(...), test.skip(...), it.each(rows)(...), test.beforeEach(...).
// Left out on purpose: test.describe(...), test.use(...), test.step(...), expect.*.
const CALL = /(?<![\w$.])(it|test|beforeEach|beforeAll|afterEach|afterAll)((?:\.[A-Za-z]+)*)\s*\(/g;
const TEST_MODIFIERS = new Set(['skip', 'only', 'todo', 'fixme', 'fails', 'fail', 'slow', 'concurrent', 'sequential', 'each', 'for', 'runIf', 'skipIf']);

/**
 * The code of a source text with the insides of strings, template texts, comments and regular
 * expressions blanked out (same length, same line breaks), so that brackets in them do not count; and the
 * string literals found, by the index of their opening quote.
 */
export function scan(source: string): { code: string; strings: Map<number, number> } {
  const out = source.split('');
  const strings = new Map<number, number>();
  const n = source.length;
  const blank = (from: number, to: number) => { for (let k = from; k < to && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };

  // The text of a template literal, from its opening backtick; its ${...} expressions are code.
  const template = (start: number): number => {
    let i = start + 1, segment = i;
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(segment, i); return i + 1; }
      if (c === '$' && source[i + 1] === '{') {
        blank(segment, i);
        i = code(i + 2, true);
        segment = ++i;
        continue;
      }
      i++;
    }
    blank(segment, n);
    return n;
  };

  // Code from `i` to the end of the text, or, inside a ${...}, to the brace that closes it.
  const code = (from: number, untilBrace: boolean): number => {
    let i = from, depth = 0, last = '';
    while (i < n) {
      const c = source[i], d = source[i + 1];
      if (c === '/' && d === '/') { const end = source.indexOf('\n', i); const to = end < 0 ? n : end; blank(i, to); i = to; continue; }
      if (c === '/' && d === '*') { const end = source.indexOf('*/', i + 2); const to = end < 0 ? n : end + 2; blank(i, to); i = to; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
        blank(i + 1, j);
        const end = Math.min(j + 1, n);
        strings.set(i, end);
        i = end; last = c;
        continue;
      }
      if (c === '`') { const end = template(i); strings.set(i, end); i = end; last = c; continue; }
      // A slash after one of these starts a regular expression, not a division.
      if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
        let j = i + 1, inClass = false;
        while (j < n && source[j] !== '\n') {
          const e = source[j];
          if (e === '\\') { j += 2; continue; }
          if (e === '[') inClass = true; else if (e === ']') inClass = false; else if (e === '/' && !inClass) break;
          j++;
        }
        if (source[j] === '/') {
          j++;
          while (j < n && /[a-z]/.test(source[j])) j++;
          blank(i, j); i = j; last = 'x';
          continue;
        }
      }
      if (c === '{') depth++;
      else if (c === '}') { if (untilBrace && depth === 0) return i; depth--; }
      if (!/\s/.test(c)) last = c;
      i++;
    }
    return i;
  };

  code(0, false);
  return { code: out.join(''), strings };
}

/** The index of the parenthesis that closes the one at `open`, in blanked-out code; -1 when there is none. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const normalize = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');

/** The tests and hooks of a test file, in order. A call that never closes runs to the end of the file. */
export function findBlocks(source: string): Block[] {
  const { code, strings } = scan(source);
  const blocks: Block[] = [];
  for (const match of code.matchAll(CALL)) {
    const name = match[1], modifiers = match[2].split('.').filter(Boolean);
    const isHook = HOOKS.has(name) || (name === 'test' && modifiers.length === 1 && HOOKS.has(modifiers[0]));
    if (!isHook && !modifiers.every((modifier) => TEST_MODIFIERS.has(modifier))) continue;
    let open = match.index + match[0].length - 1;
    let end = closing(code, open);
    // it.each(rows)('title', fn): the call that matters is the second one.
    if (end >= 0 && !isHook && modifiers.some((modifier) => modifier === 'each' || modifier === 'for')) {
      let next = end + 1;
      while (next < code.length && /\s/.test(code[next])) next++;
      if (code[next] === '(') { const second = closing(code, next); if (second >= 0) { open = next; end = second; } }
    }
    const stop = end < 0 ? source.length : end + 1;
    let title: string | null = null;
    if (!isHook) {
      let k = open + 1;
      while (k < code.length && /\s/.test(code[k])) k++;
      const literalEnd = strings.get(k);
      if (literalEnd !== undefined) title = source.slice(k + 1, literalEnd - 1);
    }
    blocks.push({
      kind: isHook ? 'hook' : 'test',
      call: name + match[2],
      title,
      ticket: title?.match(TAG)?.[1] ?? null,
      text: normalize(source.slice(match.index, stop)),
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return blocks;
}

/** The blocks of `before` that `after` does not hold unchanged: removed, or changed. */
export function lostBlocks(before: string, after: string | null): Block[] {
  const remaining = new Map<string, number>();
  for (const block of after === null ? [] : findBlocks(after)) remaining.set(block.text, (remaining.get(block.text) ?? 0) + 1);
  const lost: Block[] = [];
  for (const block of findBlocks(before)) {
    const left = remaining.get(block.text) ?? 0;
    if (left > 0) remaining.set(block.text, left - 1);
    else lost.push(block);
  }
  return lost;
}

export interface Violation { file: string; block: Block }
/** The text of a file on the old and the new side of the comparison, or null when it does not exist there. */
export type Reader = (side: 'old' | 'new', file: string) => string | null;

/**
 * The blocks a pull request may not have changed.
 * @param mode "others": a test of a ticket that is not in `tickets`; "own": anything but a test of `tickets[0]`
 */
export function violations(files: string[], read: Reader, mode: 'others' | 'own', tickets: string[] = []): Violation[] {
  const found: Violation[] = [];
  for (const file of files.filter((name) => TEST_FILE.test(name)).sort()) {
    const before = read('old', file);
    if (before === null) continue;
    for (const block of lostBlocks(before, read('new', file))) {
      const protectedBlock = mode === 'others'
        ? block.ticket !== null && !tickets.includes(block.ticket)
        : block.ticket === null || block.ticket !== tickets[0];
      if (protectedBlock) found.push({ file, block });
    }
  }
  return found;
}

export function explain(found: Violation[], mode: 'others' | 'own', tickets: string[]): string {
  const lines = found.slice(0, 20).map(({ file, block }) => {
    const what = block.ticket ? `[${block.ticket}] ${block.title}` : block.title ?? `${block.call}(...)`;
    return `  ${file}:${block.line}  ${block.kind === 'hook' ? 'hook ' : ''}${what}`;
  });
  if (found.length > 20) lines.push(`  and ${found.length - 20} more`);
  return mode === 'others'
    ? `These tests belong to a ticket that this pull request does not name, and it changes or removes them:\n${lines.join('\n')}\n`
      + `Name the ticket in the branch or the title, and its tests are compared with its QA branch; any change to an approved test must be reviewed by a person.`
    : `The QA branch${tickets[0] ? ` of ${tickets[0]}` : ''} changes or removes tests that are not its own:\n${lines.join('\n')}\n`
      + `The QA agent may add tests, and rewrite the ones it wrote for its own ticket: every other test and hook must stay as it was.`;
}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, base, head, ...tickets] = process.argv.slice(2);
  if ((mode !== 'others' && mode !== 'own') || !base || !head || tickets.some((ticket) => !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket))) {
    console.error('Usage: node qa/check-test-blocks.ts others|own <base> <head> [ticket ...]');
    process.exit(2);
  }
  const branchPoint = git(['merge-base', base, head]);
  // Renames off: a moved test file shows as a removed one, so that its tests cannot slip away.
  const diff = git(['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`]);
  if (branchPoint.status !== 0 || diff.status !== 0) {
    console.error(`Cannot compare ${base} with ${head}: ${(branchPoint.stderr || diff.stderr).trim()}`);
    process.exit(2);
  }
  const refs = { old: branchPoint.stdout.trim(), new: head };
  const read: Reader = (side, file) => {
    const shown = git(['show', `${refs[side]}:${file}`]);
    return shown.status === 0 ? shown.stdout : null;
  };
  const files = diff.stdout.split('\0').filter(Boolean);
  const found = violations(files, read, mode, tickets);
  if (found.length) {
    console.error(explain(found, mode, tickets));
    process.exit(1);
  }
  console.log(`Existing tests respected: ${files.filter((file) => TEST_FILE.test(file)).length} changed test file(s) checked, test by test.`);
}
