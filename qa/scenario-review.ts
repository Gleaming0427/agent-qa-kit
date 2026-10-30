#!/usr/bin/env node
// A human reviews generated assertions and the initial RED failures before
// development begins. This receipt detects changes; it is not authentication.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEvidence } from '../.claude/hooks/strict-evidence.ts';
import type { Manifest, Verdict, VitestReport } from '../.claude/hooks/strict-evidence.ts';
import { buildManifest } from './criteria-manifest.ts';

interface ReviewedCriterion { id: string; description: string; failures: { title: string; message: string }[] }
export interface ReviewRequest {
  schema_version: number;
  ticket: string;
  spec_sha256: string;
  manifest_sha256: string;
  phase1_verdict_sha256: string;
  red_report_sha256: string;
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

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const fileDigest = (path: string) => digest(readFileSync(path));
const reportPath = (root: string, ticket: string, suffix: string) => resolve(root, 'reports', `${ticket}-${suffix}.json`);
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
function buildRequest(root: string, ticket: string, specFile: string, vitestFile: string): ReviewRequest {
  const specText = readFileSync(specFile, 'utf8');
  const manifestFile = reportPath(root, ticket, 'criteria');
  const manifest = readJson<Manifest>(manifestFile);
  if (JSON.stringify(manifest) !== JSON.stringify(buildManifest(ticket, specText))) {
    throw new Error('Criteria manifest does not match the ticket spec.');
  }
  const verdictFile = reportPath(root, ticket, 'phase1');
  const verdict = readJson<Verdict>(verdictFile);
  const vitest = readJson<VitestReport>(vitestFile);
  if (verdict.verdict !== 'ready') throw new Error('Phase 1 must have a ready verdict before review.');
  const { problems } = validateEvidence({ manifest, verdict, phase: 1, vitest, specText, root });
  if (problems.length) throw new Error(`Invalid phase 1 evidence: ${problems.join(' ')}`);

  const files = new Set([insideProject(root, `e2e/${ticket}.spec.ts`)]);
  const criteria = manifest.criteria.map(({ id, description }) => {
    const failures: ReviewedCriterion['failures'] = [];
    for (const file of vitest.testResults ?? []) {
      for (const item of file.assertionResults ?? []) {
        const title = item.fullName ?? item.title ?? '';
        if (item.status !== 'failed' || !title.includes(`[${ticket}]`) || !title.includes(`[${id}]`)) continue;
        const message = (item.failureMessages ?? []).join(' ').replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
        if (!message) throw new Error(`${id}: failed assertion has no diagnostic message to review.`);
        files.add(insideProject(root, file.name ?? ''));
        failures.push({ title, message: message.slice(0, 500) });
      }
    }
    if (!failures.length) throw new Error(`${id}: no individual RED assertion to review.`);
    return { id, description, failures };
  });
  return {
    schema_version: 1, ticket,
    spec_sha256: digest(specText),
    manifest_sha256: fileDigest(manifestFile),
    phase1_verdict_sha256: fileDigest(verdictFile),
    red_report_sha256: fileDigest(vitestFile),
    tests: [...files].sort().map((path) => ({ path, sha256: fileDigest(resolve(root, path)) })),
    criteria,
  };
}
function checkCurrentFiles(root: string, ticket: string, specFile: string, request: ReviewRequest) {
  if (request.schema_version !== 1 || request.ticket !== ticket) throw new Error('Review request does not match the ticket.');
  const current = buildRequest(root, ticket, specFile, reportPath(root, ticket, 'red-vitest'));
  if (request.spec_sha256 !== current.spec_sha256) throw new Error('Ticket spec changed after review preparation.');
  if (request.manifest_sha256 !== current.manifest_sha256) throw new Error('Criteria manifest changed after review preparation.');
  if (request.phase1_verdict_sha256 !== current.phase1_verdict_sha256) throw new Error('Phase 1 verdict changed after review preparation.');
  if (request.red_report_sha256 !== current.red_report_sha256) throw new Error('Initial RED report changed after review preparation.');
  if (JSON.stringify(request.tests) !== JSON.stringify(current.tests)) throw new Error('Reviewed test changed after review preparation.');
  if (JSON.stringify(request.criteria) !== JSON.stringify(current.criteria)) throw new Error('RED failure review request changed.');
}

export function prepareReview({ root, ticket, specPath }: ReviewArgs): ReviewRequest {
  root = resolve(root); checkTicket(ticket);
  const reportDir = resolve(root, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const redFile = reportPath(root, ticket, 'red-vitest');
  copyFileSync(resolve(root, 'reports/vitest.json'), redFile);
  const request = buildRequest(root, ticket, resolve(specPath), redFile);
  writeFileSync(reportPath(root, ticket, 'review-request'), `${JSON.stringify(request, null, 2)}\n`);
  const template = { reviewer: '', red_reasons: Object.fromEntries(request.criteria.map(({ id }) => [id, ''])) };
  writeFileSync(reportPath(root, ticket, 'review-decision.template'), `${JSON.stringify(template, null, 2)}\n`);
  rmSync(reportPath(root, ticket, 'approved'), { force: true });
  rmSync(reportPath(root, ticket, 'verify-attempts'), { force: true });
  return request;
}

export function approveReview({ root, ticket, specPath }: ReviewArgs): Approval {
  root = resolve(root); checkTicket(ticket);
  const request = readJson<ReviewRequest>(reportPath(root, ticket, 'review-request'));
  checkCurrentFiles(root, ticket, resolve(specPath), request);
  const decision = readJson<ReviewDecision>(reportPath(root, ticket, 'review-decision'));
  const reviewer = String(decision.reviewer ?? '').trim();
  if (!reviewer) throw new Error('Reviewer name is required.');
  for (const { id } of request.criteria) {
    if (String(decision.red_reasons?.[id] ?? '').trim().length < 12) {
      throw new Error(`${id}: explain why this RED failure shows missing behavior, not a broken test or environment.`);
    }
  }
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
  if (approval.schema_version !== 1 || approval.ticket !== ticket || approval.request_sha256 !== fileDigest(requestFile)) {
    throw new Error('Scenario approval does not match the current review request.');
  }
  if (!String(approval.reviewer ?? '').trim()) throw new Error('Scenario approval has no reviewer.');
  for (const { id } of request.criteria) {
    if (String(approval.red_reasons?.[id] ?? '').trim().length < 12) throw new Error(`${id}: RED failure reason is missing.`);
  }
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ticket, specPath] = process.argv.slice(2);
    if (!['prepare', 'approve', 'verify', 'reserve'].includes(command) || !ticket || !specPath) {
      throw new Error('Usage: node qa/scenario-review.ts <prepare|approve|verify|reserve> TICKET specs/TICKET.md');
    }
    const args = { root: resolve(import.meta.dirname, '..'), ticket, specPath };
    if (command === 'prepare') {
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
