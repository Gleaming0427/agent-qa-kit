#!/usr/bin/env node
// Finds the human approval of a ticket's QA pull request (head qa/<TICKET>).
// It counts only if someone who can write to the repository approved the latest commit of the tests,
// and none of those people's latest review asks for changes. Each reviewer's latest decision counts, but
// a later approval without text does not take back the reasons they gave on the same commit.
//
// Who can write: GitHub's author association on the review (OWNER, MEMBER or COLLABORATOR) says that a
// person belongs to the repository, not what they may do there: a member of the organization, or a
// collaborator, can have read access only. When permissions.json is given, the person must also have
// write access in it. The file only narrows: a login it does not list falls back to the association
// alone (qa/ci-permissions.sh says so when it cannot read someone's permission).
//
// Usage: node qa/github-approval.ts pull TICKET OWNER/REPO pulls.json
//        node qa/github-approval.ts approval TICKET OWNER/REPO pulls.json reviews.json [permissions.json]
//        node qa/github-approval.ts merged TICKET OWNER/REPO pulls.json
//        node qa/github-approval.ts status pull.json reviews.json review-request.json [permissions.json]
//   pulls.json    gh api --paginate --slurp "repos/OWNER/REPO/pulls?state=all&head=OWNER:qa/TICKET"
//   pull.json     gh api "repos/OWNER/REPO/pulls/NUMBER"
//   reviews.json  gh api --paginate --slurp "repos/OWNER/REPO/pulls/NUMBER/reviews"
//   permissions.json  {"login in lower case": "admin" | "maintain" | "write" | "triage" | "read" | "none"}
// Prints the pull request {number, head_sha} (null when the ticket has none), or
// the approval {number, head_sha, reviewer, body}, as JSON; otherwise explains
// the refusal (exit 1). "merged" prints the latest merged QA pull request
// {number, head_sha, merge_commit_sha}, or null. "status" prints the "QA approval" commit status of a QA
// pull request, {state, description}: what its approval still misses, if anything.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingReasons, reviewReasons } from './scenario-review.ts';

export interface PullRequest {
  number: number;
  state: string;
  merged_at?: string | null;
  // The commit that the merge put on the base branch: a merge commit, or the copy a squash or a rebase made.
  merge_commit_sha?: string | null;
  head: { ref: string; sha: string; repo?: { full_name?: string } | null };
}
export interface Review {
  id: number;
  user?: { login?: string } | null;
  state: string;
  commit_id?: string | null;
  body?: string | null;
  author_association?: string;
  submitted_at?: string | null;
}
export interface FoundApproval { number: number; head_sha: string; reviewer: string; body: string }

// People who belong to the repository; anyone else's review is only a comment.
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
// What GitHub calls a role that can push.
const CAN_WRITE = new Set(['admin', 'maintain', 'write']);
export type Permissions = Record<string, string>;
const decided = (review: Review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state);
// An approval gives its reasons as lines "AC-N: reason".
const givesReasons = (review: Review) => /AC-[1-9]\d*/.test(review.body ?? '');

/** Whether a review counts, for or against: it comes from someone who belongs to the repository and, when known, can write to it. */
function counts(login: string, review: Review, permissions?: Permissions): boolean {
  if (!TRUSTED.has(review.author_association ?? '')) return false;
  const permission = permissions?.[login.toLowerCase()];
  return permission === undefined || CAN_WRITE.has(permission);
}
const short = (sha: string) => sha.slice(0, 7);

/** The QA pull request of a ticket: the latest one opened from qa/<TICKET> in this repository. */
export function findQaPull(pulls: PullRequest[], ticket: string, repo: string): PullRequest | null {
  const own = pulls
    .filter((pull) => pull.head.ref === `qa/${ticket}` && pull.head.repo?.full_name === repo)
    .sort((a, b) => b.number - a.number);
  if (!own.length) return null;
  const [pull] = own;
  if (pull.state === 'closed' && !pull.merged_at) {
    throw new Error(`The QA pull request #${pull.number} was closed without merging: its tests were not accepted.`);
  }
  return pull;
}

/** The latest QA pull request of a ticket that was merged: the one whose tests feat/<TICKET> holds. */
export function lastMergedQaPull(pulls: PullRequest[], ticket: string, repo: string): PullRequest | null {
  return pulls
    .filter((pull) => pull.head.ref === `qa/${ticket}` && pull.head.repo?.full_name === repo && pull.merged_at)
    .sort((a, b) => b.number - a.number)[0] ?? null;
}

export function findApproval(pull: PullRequest, reviews: Review[], permissions?: Permissions): FoundApproval {
  // Each reviewer's latest decision; comments do not change it.
  const latest = new Map<string, Review>();
  // What each reviewer approved since their last request for changes or dismissal, oldest first.
  const approved = new Map<string, Review[]>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const login = review.user?.login;
    if (!login || !decided(review)) continue;
    latest.set(login, review);
    if (review.state === 'APPROVED') approved.set(login, [...(approved.get(login) ?? []), review]);
    else approved.delete(login);
  }
  const decisions = [...latest.entries()];
  // Anyone with a GitHub account can leave a review on a public repository: a request for changes blocks
  // only when it comes from someone whose approval would count, as on GitHub's own required reviews.
  const blocking = decisions.filter(([login, review]) => review.state === 'CHANGES_REQUESTED' && counts(login, review, permissions)).map(([login]) => `@${login}`);
  if (blocking.length) throw new Error(`${blocking.join(', ')} requested changes on the QA pull request #${pull.number}.`);

  const approvals = decisions.filter(([, review]) => review.state === 'APPROVED');
  // A later approval without text does not take back the reasons that the same person gave for the same
  // commit: only a request for changes or a dismissal does. An approval of an older commit gives none.
  const withTheirReasons = (login: string, review: Review): Review => {
    if (givesReasons(review)) return review;
    const earlier = (approved.get(login) ?? []).filter((other) => other.commit_id === review.commit_id && givesReasons(other));
    return earlier.sort((a, b) => b.id - a.id)[0] ?? review;
  };
  const valid = approvals
    .filter(([login, review]) => counts(login, review, permissions) && review.commit_id === pull.head.sha)
    .map(([login, review]): [string, Review] => [login, withTheirReasons(login, review)]);
  if (!valid.length) {
    const reasons = approvals.map(([login, review]) => !TRUSTED.has(review.author_association ?? '')
      ? `@${login} cannot approve: not a collaborator of the repository`
      : !counts(login, review, permissions)
        ? `@${login} cannot approve: only has ${permissions?.[login.toLowerCase()]} access to the repository, and writing needs write access`
        : `@${login} approved an older version of the tests (${short(review.commit_id ?? '')}, latest ${short(pull.head.sha)})`);
    throw new Error(`The QA pull request #${pull.number} has no valid approval${reasons.length ? `: ${reasons.join('; ')}` : ''}.`);
  }
  // Prefer the latest approval that gives reasons, written as "AC-N: reason".
  const withReasons = valid.filter(([, review]) => givesReasons(review));
  const [reviewer, review] = (withReasons.length ? withReasons : valid).sort(([, a], [, b]) => b.id - a.id)[0];
  return { number: pull.number, head_sha: pull.head.sha, reviewer: `@${reviewer}`, body: review.body ?? '' };
}

export interface ApprovalStatus { state: 'success' | 'failure'; description: string }

/**
 * The "QA approval" status of a QA pull request, shown next to its merge button: red until a
 * collaborator approves its latest commit with a reason per criterion, as QA verify will require.
 * It does not check the files themselves: QA verify does, against the approved commit.
 */
export function approvalStatus(pull: PullRequest, reviews: Review[], criteria: string[], permissions?: Permissions): ApprovalStatus {
  const lines = criteria.join(', ');
  const merged = Boolean(pull.merged_at);
  let approval: FoundApproval;
  try {
    approval = findApproval(pull, reviews, permissions);
  } catch (error) {
    const description = reviews.some(decided)
      ? (error as Error).message.replace(/^The QA pull request #\d+ /, 'This pull request ')
      : merged
        ? `Merged before approval. Approve it now, one line per criterion (${lines}): QA verify needs it.`
        : `Not approved yet. Approve with one line per criterion (${lines}), then merge.`;
    return { state: 'failure', description };
  }
  const missing = missingReasons(criteria, reviewReasons(approval.body));
  if (missing.length) {
    return {
      state: 'failure',
      description: `${approval.reviewer} approved without a reason for ${missing.join(', ')}. Approve again with one line per criterion.`,
    };
  }
  return { state: 'success', description: `Approved by ${approval.reviewer}, with a reason per criterion.${merged ? '' : ' Ready to merge.'}` };
}

/** The permissions file of qa/ci-permissions.sh: {login: permission}, with the logins in lower case. */
function readPermissions(file?: string): Permissions | undefined {
  if (!file) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new Error(`${file} must map each login to a permission.`);
  }
  return Object.fromEntries(Object.entries(parsed as Permissions).map(([login, permission]) => [login.toLowerCase(), permission]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // With --slurp, gh writes every page as one array of pages.
    const items = <T>(file: string) => (JSON.parse(readFileSync(file, 'utf8')) as (T | T[])[]).flat() as T[];
    if (process.argv[2] === 'status') {
      const [pullFile, reviewsFile, requestFile, permissionsFile] = process.argv.slice(3);
      if (!pullFile || !reviewsFile || !requestFile) {
        throw new Error('Usage: node qa/github-approval.ts status pull.json reviews.json review-request.json [permissions.json]');
      }
      const request = JSON.parse(readFileSync(requestFile, 'utf8')) as { criteria?: { id?: unknown }[] };
      const criteria = (request.criteria ?? []).map(({ id }) => String(id));
      if (!criteria.length || criteria.some((id) => !/^AC-[1-9]\d*$/.test(id))) throw new Error(`${requestFile} lists no valid criterion.`);
      const status = approvalStatus(JSON.parse(readFileSync(pullFile, 'utf8')) as PullRequest, items<Review>(reviewsFile), criteria, readPermissions(permissionsFile));
      // GitHub refuses a status description longer than 140 characters.
      console.log(JSON.stringify({ ...status, description: status.description.length > 140 ? `${status.description.slice(0, 139)}…` : status.description }));
    } else {
      const [command, ticket, repo, pullsFile, reviewsFile, permissionsFile] = process.argv.slice(2);
      if (!ticket || !repo || !pullsFile || !(['pull', 'merged'].includes(command) || command === 'approval' && reviewsFile)) {
        throw new Error('Usage: node qa/github-approval.ts pull TICKET OWNER/REPO pulls.json\n'
          + '       node qa/github-approval.ts approval TICKET OWNER/REPO pulls.json reviews.json [permissions.json]\n'
          + '       node qa/github-approval.ts merged TICKET OWNER/REPO pulls.json\n'
          + '       node qa/github-approval.ts status pull.json reviews.json review-request.json [permissions.json]');
      }
      const pulls = items<PullRequest>(pullsFile);
      if (command === 'merged') {
        const merged = lastMergedQaPull(pulls, ticket, repo);
        console.log(JSON.stringify(merged && { number: merged.number, head_sha: merged.head.sha, merge_commit_sha: merged.merge_commit_sha ?? null }));
      } else {
        const pull = findQaPull(pulls, ticket, repo);
        if (command === 'pull') {
          console.log(JSON.stringify(pull && { number: pull.number, head_sha: pull.head.sha }));
        } else {
          if (!pull) throw new Error(`No pull request from qa/${ticket}: run the "QA write tests" workflow for ${ticket} first.`);
          console.log(JSON.stringify(findApproval(pull, items<Review>(reviewsFile!), readPermissions(permissionsFile))));
        }
      }
    }
  } catch (error) {
    console.error(`QA approval: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
