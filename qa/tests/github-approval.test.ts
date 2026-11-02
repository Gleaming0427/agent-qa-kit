import assert from 'node:assert/strict';
import test from 'node:test';
import { findApproval, findQaPull } from '../github-approval.ts';
import type { PullRequest, Review } from '../github-approval.ts';

const repo = 'acme/shop';
const latest = 'b'.repeat(40);
const older = 'a'.repeat(40);
const reasons = 'AC-1: the button does not exist yet, as expected.';
const pull = (change: Partial<PullRequest> = {}): PullRequest => ({
  number: 7, state: 'open', merged_at: null,
  head: { ref: 'qa/TICKET-43', sha: latest, repo: { full_name: repo } }, ...change,
});
let id = 0;
const review = (login: string, state: string, change: Partial<Review> = {}): Review => ({
  id: ++id, user: { login }, state, commit_id: latest, body: reasons, author_association: 'COLLABORATOR', ...change,
});

test('the QA pull request is the latest one opened from qa/<ticket> in the repository', () => {
  const fromFork = pull({ number: 9, head: { ref: 'qa/TICKET-43', sha: latest, repo: { full_name: 'someone/shop' } } });
  assert.equal(findQaPull([pull({ number: 5, state: 'closed' }), pull(), fromFork], 'TICKET-43', repo)?.number, 7);
  assert.equal(findQaPull([pull({ head: { ref: 'qa/TICKET-4', sha: latest, repo: { full_name: repo } } })], 'TICKET-43', repo), null);
  assert.throws(() => findQaPull([pull({ state: 'closed' })], 'TICKET-43', repo), /closed without merging/);
  assert.equal(findQaPull([pull({ state: 'closed', merged_at: '2026-11-01T10:00:00Z' })], 'TICKET-43', repo)?.number, 7);
});

test('a collaborator must approve the latest version of the tests', () => {
  assert.deepEqual(findApproval(pull(), [review('alice', 'COMMENTED', { body: 'Looking' }), review('alice', 'APPROVED')]),
    { number: 7, head_sha: latest, reviewer: '@alice', body: reasons });
  assert.throws(() => findApproval(pull(), []), /#7 has no valid approval\.$/);
  assert.throws(() => findApproval(pull(), [review('alice', 'APPROVED', { commit_id: older })]),
    /@alice approved an older version of the tests \(aaaaaaa, latest bbbbbbb\)/);
  assert.throws(() => findApproval(pull(), [review('mallory', 'APPROVED', { author_association: 'NONE' })]),
    /@mallory cannot approve: not a collaborator/);
});

test('a request for changes or a dismissal cancels the approval', () => {
  assert.throws(() => findApproval(pull(), [review('alice', 'APPROVED'), review('bob', 'CHANGES_REQUESTED')]), /@bob requested changes/);
  assert.throws(() => findApproval(pull(), [review('alice', 'DISMISSED')]), /no valid approval/);
  // A later approval by the same person replaces their request for changes.
  assert.equal(findApproval(pull(), [review('bob', 'CHANGES_REQUESTED'), review('bob', 'APPROVED')]).reviewer, '@bob');
});

test('the approval that gives a reason per criterion is preferred', () => {
  assert.equal(findApproval(pull(), [review('alice', 'APPROVED'), review('bob', 'APPROVED', { body: 'LGTM' })]).reviewer, '@alice');
});
