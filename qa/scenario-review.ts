#!/usr/bin/env node
// A human reviews generated assertions and the initial RED failures before
// development begins. This receipt detects changes; it is not authentication.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageMarkdown } from '../.claude/hooks/coverage.ts';
import type { CriterionCoverage } from '../.claude/hooks/coverage.ts';
import { cleanMessage, extractPlaywrightTests, validateEvidence } from '../.claude/hooks/strict-evidence.ts';
import type { Level, Manifest, PlaywrightReport, Verdict, VitestReport } from '../.claude/hooks/strict-evidence.ts';
import { buildManifest } from './criteria-manifest.ts';

interface ReviewedCriterion { id: string; description: string; failures: { level: Level; title: string; message: string }[] }
export interface ReviewRequest {
  schema_version: number;
  ticket: string;
  spec_sha256: string;
  manifest_sha256: string;
  phase1_verdict_sha256: string;
  red_vitest_sha256: string;
  red_playwright_sha256: string;
  tests: { path: string; sha256: string }[];
  criteria: ReviewedCriterion[];
}
interface ReviewDecision { reviewer?: string; red_reasons?: Record<string, string> }
export interface Approval {
  schema_version: number;
  ticket: string;
  request_sha256: string;
  reviewer: string;
  red_reasons: Record<string, string>;
  approved_at: string;
}
interface ReviewArgs { root: string; ticket: string; specPath: string }
export interface ReviewContext { ticket: string; mfe: string; spec: string }
/** A person changed approved tests: who, why, which files, and the review request before and after. */
export interface Amendment {
  at: string;
  author: string;
  reason: string;
  files: { path: string; before: string; after: string }[];
  previous_request_sha256: string;
  request_sha256: string;
}

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const fileDigest = (path: string) => digest(readFileSync(path));
const reportPath = (root: string, ticket: string, suffix: string) => resolve(root, 'reports', `${ticket}-${suffix}.json`);
const redReports = (root: string, ticket: string) => ({
  vitest: reportPath(root, ticket, 'red-vitest'),
  playwright: reportPath(root, ticket, 'red-playwright'),
});
function checkTicket(ticket: string) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket)) throw new Error(`Invalid ticket: ${ticket}`);
}
function insideProject(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const local = relative(root, absolute);
  if (!local || local === '..' || local.startsWith('../') || isAbsolute(local)) {
    throw new Error(`Test file must be inside the project: ${path}`);
  }
  if (!existsSync(absolute)) throw new Error(`Test file missing: ${absolute}`);
  const realLocal = relative(realpathSync(root), realpathSync(absolute));
  if (!realLocal || realLocal === '..' || realLocal.startsWith('../') || isAbsolute(realLocal) ||
      !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(realLocal)) {
    throw new Error(`Test file resolves outside a test source: ${path}`);
  }
  return local;
}
function buildRequest(root: string, ticket: string, specFile: string, red: { vitest: string; playwright: string }): ReviewRequest {
  const specText = readFileSync(specFile, 'utf8');
  const manifestFile = reportPath(root, ticket, 'criteria');
  const manifest = readJson<Manifest>(manifestFile);
  if (JSON.stringify(manifest) !== JSON.stringify(buildManifest(ticket, specText))) {
    throw new Error('Criteria manifest does not match the ticket spec.');
  }
  const verdictFile = reportPath(root, ticket, 'phase1');
  const verdict = readJson<Verdict>(verdictFile);
  const vitest = readJson<VitestReport>(red.vitest);
  const playwright = readJson<PlaywrightReport>(red.playwright);
  if (verdict.verdict !== 'ready') throw new Error('Phase 1 must have a ready verdict before review.');
  const { problems } = validateEvidence({ manifest, verdict, phase: 1, vitest, playwright, specText, root });
  if (problems.length) throw new Error(`Invalid phase 1 evidence: ${problems.join(' ')}`);

  const files = new Set([insideProject(root, `e2e/${ticket}.spec.ts`)]);
  const named = (title: string, id: string) => title.includes(`[${ticket}]`) && title.includes(`[${id}]`);
  const criteria = manifest.criteria.map(({ id, description }) => {
    const failures: ReviewedCriterion['failures'] = [];
    for (const file of vitest.testResults ?? []) {
      for (const item of file.assertionResults ?? []) {
        const title = item.fullName ?? item.title ?? '';
        if (item.status !== 'failed' || !named(title, id)) continue;
        const message = cleanMessage((item.failureMessages ?? []).join(' '));
        if (!message) throw new Error(`${id}: failed assertion has no diagnostic message to review.`);
        files.add(insideProject(root, file.name ?? ''));
        failures.push({ level: 'mfe', title, message: message.slice(0, 500) });
      }
    }
    if (!failures.length) throw new Error(`${id}: no individual RED assertion to review.`);
    // validateEvidence has already required an expect() failure for every browser scenario.
    for (const test of extractPlaywrightTests(playwright)) {
      if (test.status !== 'unexpected' || !named(test.title, id) || !test.file.endsWith(`${ticket}.spec.ts`)) continue;
      const last = test.results.at(-1);
      const message = cleanMessage(last?.error?.message ?? last?.errors?.map((e) => e.message).join(' '));
      failures.push({ level: 'shell', title: test.title, message: message.slice(0, 500) });
    }
    return { id, description, failures };
  });
  return {
    schema_version: 2, ticket,
    spec_sha256: digest(specText),
    manifest_sha256: fileDigest(manifestFile),
    phase1_verdict_sha256: fileDigest(verdictFile),
    red_vitest_sha256: fileDigest(red.vitest),
    red_playwright_sha256: fileDigest(red.playwright),
    tests: [...files].sort().map((path) => ({ path, sha256: fileDigest(resolve(root, path)) })),
    criteria,
  };
}
function checkCurrentFiles(root: string, ticket: string, specFile: string, request: ReviewRequest) {
  if (request.schema_version !== 2 || request.ticket !== ticket) throw new Error('Review request does not match the ticket.');
  const current = buildRequest(root, ticket, specFile, redReports(root, ticket));
  if (request.spec_sha256 !== current.spec_sha256) throw new Error('Ticket spec changed after review preparation.');
  if (request.manifest_sha256 !== current.manifest_sha256) throw new Error('Criteria manifest changed after review preparation.');
  if (request.phase1_verdict_sha256 !== current.phase1_verdict_sha256) throw new Error('Phase 1 verdict changed after review preparation.');
  if (request.red_vitest_sha256 !== current.red_vitest_sha256 || request.red_playwright_sha256 !== current.red_playwright_sha256) {
    throw new Error('Initial RED reports changed after review preparation.');
  }
  if (JSON.stringify(request.tests) !== JSON.stringify(current.tests)) throw new Error('Reviewed test changed after review preparation.');
  if (JSON.stringify(request.criteria) !== JSON.stringify(current.criteria)) throw new Error('RED failure review request changed.');
}

export function prepareReview({ root, ticket, specPath }: ReviewArgs): ReviewRequest {
  root = resolve(root); checkTicket(ticket);
  const reportDir = resolve(root, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const red = redReports(root, ticket);
  for (const [source, copy] of [['vitest.json', red.vitest], ['playwright.json', red.playwright]]) {
    const report = resolve(reportDir, source);
    if (!existsSync(report)) throw new Error(`reports/${source} missing: run the unit tests and the browser scenarios first.`);
    copyFileSync(report, copy);
  }
  // Project-relative test paths keep the review valid on another machine, such as CI.
  const vitest = readJson<VitestReport>(red.vitest);
  for (const file of vitest.testResults ?? []) {
    if (file.name && isAbsolute(file.name) && !relative(root, file.name).startsWith('..')) file.name = relative(root, file.name);
  }
  writeFileSync(red.vitest, `${JSON.stringify(vitest)}\n`);
  const request = buildRequest(root, ticket, resolve(specPath), red);
  writeFileSync(reportPath(root, ticket, 'review-request'), `${JSON.stringify(request, null, 2)}\n`);
  const template = { reviewer: '', red_reasons: Object.fromEntries(request.criteria.map(({ id }) => [id, ''])) };
  writeFileSync(reportPath(root, ticket, 'review-decision.template'), `${JSON.stringify(template, null, 2)}\n`);
  rmSync(reportPath(root, ticket, 'approved'), { force: true });
  rmSync(reportPath(root, ticket, 'verify-attempts'), { force: true });
  return request;
}

const amendmentsPath = (root: string, ticket: string) => reportPath(root, ticket, 'amendments');
export function readAmendments(root: string, ticket: string): Amendment[] {
  const path = amendmentsPath(resolve(root), ticket);
  return existsSync(path) ? readJson<Amendment[]>(path) : [];
}
// Amended tests are reviewed as a whole again: the log must end with the request being approved.
function checkAmendmentLog(root: string, ticket: string) {
  const last = readAmendments(root, ticket).at(-1);
  if (last && last.request_sha256 !== fileDigest(reportPath(root, ticket, 'review-request'))) {
    throw new Error('The amendment log does not match the review request: run the amend command again.');
  }
}

/**
 * A person corrects approved tests that turned out to be wrong, with a reason. The same test files,
 * the same criteria: each one must still fail for the right reason on the application without the
 * feature, as at the first review. The amendment is logged and the tests need a new approval.
 */
export function amendReview({ root, ticket, specPath, author, reason }: ReviewArgs & { author: string; reason: string }): Amendment {
  root = resolve(root); checkTicket(ticket);
  author = author.trim(); reason = reason.trim().replace(/\s+/g, ' ');
  if (!author) throw new Error('An amendment needs its author.');
  if (reason.length < 20) throw new Error('Say why the approved tests were wrong, in 20 characters or more: the reason is logged.');
  const requestFile = reportPath(root, ticket, 'review-request');
  if (!existsSync(requestFile)) throw new Error(`No reviewed tests for ${ticket}: an amendment changes tests that were approved.`);
  const previous = readJson<ReviewRequest>(requestFile);
  const previousDigest = fileDigest(requestFile);
  const files = previous.tests.flatMap(({ path, sha256 }) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new Error(`${path} was reviewed and is gone: removing a test file needs a new QA writing cycle.`);
    const after = fileDigest(absolute);
    return after === sha256 ? [] : [{ path, before: sha256, after }];
  });
  if (!files.length) throw new Error('No reviewed test changed: there is nothing to amend.');
  // A refused amendment leaves the review as it was.
  const touched = ['red-vitest', 'red-playwright', 'review-request', 'review-decision.template', 'approved', 'verify-attempts']
    .map((suffix) => reportPath(root, ticket, suffix));
  const saved = touched.map((path) => (existsSync(path) ? readFileSync(path) : null));
  try {
    const request = prepareReview({ root, ticket, specPath });
    if (JSON.stringify(request.tests.map((t) => t.path)) !== JSON.stringify(previous.tests.map((t) => t.path))) {
      throw new Error('An amendment changes reviewed test files only: adding or removing one needs a new QA writing cycle.');
    }
  } catch (error) {
    touched.forEach((path, i) => (saved[i] === null ? rmSync(path, { force: true }) : writeFileSync(path, saved[i]!)));
    throw error;
  }
  const amendment: Amendment = {
    at: new Date().toISOString(), author, reason, files, previous_request_sha256: previousDigest, request_sha256: fileDigest(requestFile),
  };
  writeFileSync(amendmentsPath(root, ticket), `${JSON.stringify([...readAmendments(root, ticket), amendment], null, 2)}\n`);
  return amendment;
}

/** The criteria whose reason is missing or too short to say why the failure shows missing behavior. */
export function missingReasons(ids: string[], reasons: Record<string, string> | undefined): string[] {
  return ids.filter((id) => String(reasons?.[id] ?? '').trim().length < 12);
}

/** The reasons of a pull request review: one "AC-N: reason" line per criterion. */
export function reviewReasons(text: string): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    // Accepts Markdown such as "- AC-1: reason", "**AC-1**: reason" or "`AC-1` — reason".
    const match = line.match(/^\s*(?:[-*+]\s+)?[*_`]*(AC-[1-9]\d*)[*_`]*\s*[:—–-]\s*[*_`]*\s*(.+)$/);
    if (match) reasons[match[1]] = match[2].trim();
  }
  return reasons;
}

export function approveReview({ root, ticket, specPath }: ReviewArgs): Approval {
  root = resolve(root); checkTicket(ticket);
  const request = readJson<ReviewRequest>(reportPath(root, ticket, 'review-request'));
  checkCurrentFiles(root, ticket, resolve(specPath), request);
  checkAmendmentLog(root, ticket);
  const decision = readJson<ReviewDecision>(reportPath(root, ticket, 'review-decision'));
  const reviewer = String(decision.reviewer ?? '').trim();
  if (!reviewer) throw new Error('Reviewer name is required.');
  const [missing] = missingReasons(request.criteria.map(({ id }) => id), decision.red_reasons);
  if (missing) throw new Error(`${missing}: explain why this RED failure shows missing behavior, not a broken test or environment.`);
  const approval: Approval = {
    schema_version: 1, ticket, request_sha256: fileDigest(reportPath(root, ticket, 'review-request')),
    reviewer, red_reasons: decision.red_reasons ?? {}, approved_at: new Date().toISOString(),
  };
  writeFileSync(reportPath(root, ticket, 'approved'), `${JSON.stringify(approval, null, 2)}\n`);
  return approval;
}

export function verifyReview({ root, ticket, specPath }: ReviewArgs): Approval {
  root = resolve(root); checkTicket(ticket);
  const requestFile = reportPath(root, ticket, 'review-request');
  const request = readJson<ReviewRequest>(requestFile);
  const approval = readJson<Approval>(reportPath(root, ticket, 'approved'));
  checkCurrentFiles(root, ticket, resolve(specPath), request);
  checkAmendmentLog(root, ticket);
  if (approval.schema_version !== 1 || approval.ticket !== ticket || approval.request_sha256 !== fileDigest(requestFile)) {
    throw new Error('Scenario approval does not match the current review request.');
  }
  if (!String(approval.reviewer ?? '').trim()) throw new Error('Scenario approval has no reviewer.');
  const [missing] = missingReasons(request.criteria.map(({ id }) => id), approval.red_reasons);
  if (missing) throw new Error(`${missing}: RED failure reason is missing.`);
  return approval;
}

export function reserveVerifyAttempt({ root, ticket, specPath, maxAttempts = 3 }: ReviewArgs & { maxAttempts?: number }): number {
  root = resolve(root);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Maximum verify attempts must be a positive integer.');
  const approval = verifyReview({ root, ticket, specPath });
  const path = reportPath(root, ticket, 'verify-attempts');
  let previous: { request_sha256?: string; count: number } | null;
  try { previous = readJson(path); } catch { previous = null; }
  const count = previous && previous.request_sha256 === approval.request_sha256 ? previous.count : 0;
  if (count >= maxAttempts) {
    throw new Error(`${maxAttempts} verification attempts used. Reassess the tests and RED baseline before another QA cycle.`);
  }
  const attempt = count + 1;
  writeFileSync(path, `${JSON.stringify({ ticket, request_sha256: approval.request_sha256, count: attempt }, null, 2)}\n`);
  return attempt;
}

// The review package is committed with the tests, so that CI can verify the approval.
const PACKAGE_FILES = ['criteria', 'phase1', 'red-vitest', 'red-playwright', 'review-request'];
const packageDir = (root: string, ticket: string) => resolve(root, 'qa-reviews', ticket);

export function exportReview({ root, ticket, specPath, mfe }: ReviewArgs & { mfe: string }): string {
  root = resolve(root); checkTicket(ticket);
  if (!/^[a-z0-9-]+$/.test(mfe)) throw new Error(`Invalid MFE name: ${mfe}`);
  const dir = packageDir(root, ticket);
  mkdirSync(dir, { recursive: true });
  for (const name of PACKAGE_FILES) copyFileSync(reportPath(root, ticket, name), join(dir, `${ticket}-${name}.json`));
  // The amendment log travels with the package, once there is one.
  if (existsSync(amendmentsPath(root, ticket))) copyFileSync(amendmentsPath(root, ticket), join(dir, `${ticket}-amendments.json`));
  const context: ReviewContext = { ticket, mfe, spec: relative(root, resolve(specPath)) };
  writeFileSync(join(dir, 'context.json'), `${JSON.stringify(context, null, 2)}\n`);
  return dir;
}

export function importReview({ root, ticket }: { root: string; ticket: string }): ReviewContext {
  root = resolve(root); checkTicket(ticket);
  const dir = packageDir(root, ticket);
  mkdirSync(resolve(root, 'reports'), { recursive: true });
  for (const name of PACKAGE_FILES) copyFileSync(join(dir, `${ticket}-${name}.json`), reportPath(root, ticket, name));
  const log = join(dir, `${ticket}-amendments.json`);
  if (existsSync(log)) copyFileSync(log, amendmentsPath(root, ticket)); else rmSync(amendmentsPath(root, ticket), { force: true });
  const context = readJson<ReviewContext>(join(dir, 'context.json'));
  if (context.ticket !== ticket) throw new Error('Review package belongs to another ticket.');
  return context;
}

/** Pull request text: what to check, the RED evidence, and how to approve. */
export function reviewMarkdown({ root, ticket }: { root: string; ticket: string }): string {
  const request = readJson<ReviewRequest>(reportPath(resolve(root), ticket, 'review-request'));
  const amendments = readAmendments(root, ticket);
  const plain = (text: string) => text.replace(/`/g, "'");
  // The writer's coverage summary, from its phase 1 verdict (absent from verdicts made before it existed).
  const verdictFile = reportPath(resolve(root), ticket, 'phase1');
  const coverage = existsSync(verdictFile) ? (readJson<{ coverage?: CriterionCoverage[] }>(verdictFile).coverage ?? []) : [];
  const sections = request.criteria.map(({ id, description, failures }) => [
    `### ${id}: ${plain(description)}`,
    ...failures.map((f) => `- **${f.level === 'mfe' ? 'Unit' : 'Browser'} test** \`${plain(f.title)}\`\n  > ${plain(f.message).slice(0, 300)}`),
    ...(Array.isArray(coverage) ? ['', ...coverageMarkdown(coverage.find((c) => c?.id === id))] : []),
  ].join('\n').trimEnd());
  const log = amendments.length ? [[
    '### Amendments',
    'Approved tests were changed by hand. Check that each change fixes the test, not the bar: the tests must still say what the ticket asks.',
    ...amendments.map((a) => `- ${a.at.slice(0, 10)}, by ${plain(a.author)}: ${plain(a.reason)}\n  Changed: ${a.files.map((f) => `\`${plain(f.path)}\``).join(', ')}`),
  ].join('\n')] : [];
  return [
    amendments.length ? `## Amended QA tests for ${ticket}` : `## QA tests for ${ticket}`,
    'The QA writer turned each acceptance criterion into a unit test and a browser test. They fail on purpose: the feature does not exist yet.',
    ...log,
    'Before approving, check for each criterion that the assertions test what the ticket asks for, and that the failure below comes from the missing feature, not from a broken test or environment. Then read what the tests do not cover: a case that matters for the ticket and is missing will not show in the test code.',
    ...sections,
    '### How to approve',
    'Approve this pull request with a review comment that has one line per criterion:',
    `\`\`\`text\n${request.criteria.map(({ id }) => `${id}: why this failure shows the feature is missing`).join('\n')}\n\`\`\``,
    'Approve first, then merge. The **QA approval** status of this pull request stays red until a collaborator approves its latest commit with these lines, and says what is missing. QA verify reads them again later and refuses an approval without them.',
    `Merging into \`feat/${ticket}\` then makes these tests the reference for the developer. Prefer **Create a merge commit**: after a squash, a later amendment may have to be merged by hand.`,
  ].join('\n\n') + '\n';
}

/** Records an approval given in a pull request review: one "AC-N: reason" line per criterion. */
export function approveFromReview({ root, ticket, specPath, reviewer, text }: ReviewArgs & { reviewer: string; text: string }): Approval {
  root = resolve(root); checkTicket(ticket);
  const red_reasons = reviewReasons(text);
  writeFileSync(reportPath(root, ticket, 'review-decision'), `${JSON.stringify({ reviewer, red_reasons }, null, 2)}\n`);
  return approveReview({ root, ticket, specPath });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ticket, specPath, ...rest] = process.argv.slice(2);
    const root = process.cwd();
    const needsSpec = ['prepare', 'approve', 'verify', 'reserve', 'export', 'approve-review', 'amend'].includes(command);
    if (!['import', 'pr-body'].includes(command) && !needsSpec || !ticket || needsSpec && !specPath) {
      throw new Error('Usage: node qa/scenario-review.ts <prepare|approve|verify|reserve> TICKET SPEC\n'
        + '       node qa/scenario-review.ts export TICKET SPEC MFE | import TICKET | pr-body TICKET\n'
        + '       node qa/scenario-review.ts approve-review TICKET SPEC REVIEWER REVIEW_TEXT_FILE\n'
        + '       node qa/scenario-review.ts amend TICKET SPEC AUTHOR REASON_FILE');
    }
    const args = { root, ticket, specPath };
    if (command === 'amend') {
      if (!rest[0] || !rest[1]) throw new Error('amend needs AUTHOR and REASON_FILE');
      const amendment = amendReview({ ...args, author: rest[0], reason: readFileSync(rest[1], 'utf8') });
      console.log(`Amendment of ${ticket} by ${amendment.author} logged: ${amendment.files.map((f) => f.path).join(', ')}. The tests need a new approval.`);
    } else if (command === 'export') {
      console.log(`Review package: ${relative(root, exportReview({ ...args, mfe: rest[0] ?? '' }))}`);
    } else if (command === 'import') {
      console.log(JSON.stringify(importReview({ root, ticket })));
    } else if (command === 'pr-body') {
      process.stdout.write(reviewMarkdown({ root, ticket }));
    } else if (command === 'approve-review') {
      if (!rest[0] || !rest[1]) throw new Error('approve-review needs REVIEWER and REVIEW_TEXT_FILE');
      const approval = approveFromReview({ ...args, reviewer: rest[0], text: readFileSync(rest[1], 'utf8') });
      console.log(`Scenario review recorded for ${ticket} by ${approval.reviewer}.`);
    } else if (command === 'prepare') {
      const request = prepareReview(args);
      console.log(`Review ${request.tests.length} test file(s) and the RED failures in reports/${ticket}-review-request.json.`);
      console.log(`Fill reports/${ticket}-review-decision.template.json, save as reports/${ticket}-review-decision.json, then run the approve command.`);
    } else if (command === 'approve') {
      const approval = approveReview(args);
      console.log(`Scenario review recorded for ${ticket} by ${approval.reviewer}.`);
    } else if (command === 'verify') {
      const approval = verifyReview(args);
      console.log(`Scenario review valid for ${ticket} by ${approval.reviewer}.`);
    } else {
      const maxAttempts = Number(process.env.QA_MAX_VERIFY_ATTEMPTS ?? 3);
      const attempt = reserveVerifyAttempt({ ...args, maxAttempts });
      console.log(`QA verification attempt ${attempt}/${maxAttempts} reserved for ${ticket}.`);
    }
  } catch (error) {
    console.error(`Scenario review: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
