import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalStatus, findApproval, findQaPull, lastMergedQaPull } from '../github-approval.ts';
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

test('the tests feat/<ticket> holds come from the latest merged QA pull request', () => {
  const merged = (number: number) => pull({ number, state: 'closed', merged_at: '2026-11-01T10:00:00Z', merge_commit_sha: 'c'.repeat(40) });
  const fromFork = pull({ number: 9, state: 'closed', merged_at: '2026-11-02T10:00:00Z', head: { ref: 'qa/TICKET-43', sha: latest, repo: { full_name: 'someone/shop' } } });
  assert.equal(lastMergedQaPull([merged(5), merged(7), pull({ number: 8 }), pull({ number: 10, state: 'closed' }), fromFork], 'TICKET-43', repo)?.number, 7);
  assert.equal(lastMergedQaPull([pull()], 'TICKET-43', repo), null);
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

test('the QA approval status says, before the merge, what the approval is missing', () => {
  const criteria = ['AC-1', 'AC-2', 'AC-3'];
  const full = 'AC-1: the Delivery choice does not exist yet.\nAC-2: there is no Express radio to select yet.\nAC-3: the empty cart has no express option yet.';
  const status = (reviews: Review[], change: Partial<PullRequest> = {}) => approvalStatus(pull(change), reviews, criteria);
  const merged = { state: 'closed', merged_at: '2026-11-07T10:41:14Z' };

  assert.deepEqual(status([]), { state: 'failure', description: 'Not approved yet. Approve with one line per criterion (AC-1, AC-2, AC-3), then merge.' });
  assert.equal(status([review('alice', 'COMMENTED', { body: full })]).state, 'failure', 'a comment is not an approval');
  // In the trial, both test pull requests were merged before they were approved.
  assert.deepEqual(status([], merged),
    { state: 'failure', description: 'Merged before approval. Approve it now, one line per criterion (AC-1, AC-2, AC-3): QA verify needs it.' });
  // And one was first approved with no text.
  assert.deepEqual(status([review('alice', 'APPROVED', { body: null })]),
    { state: 'failure', description: '@alice approved without a reason for AC-1, AC-2, AC-3. Approve again with one line per criterion.' });
  assert.match(status([review('alice', 'APPROVED', { body: 'AC-1: the Delivery choice does not exist yet.\nAC-3: ok' })]).description,
    /^@alice approved without a reason for AC-2, AC-3\./, 'a reason too short to explain the failure does not count');
  assert.deepEqual(status([review('alice', 'APPROVED', { body: full, commit_id: older })]), { state: 'failure',
    description: 'This pull request has no valid approval: @alice approved an older version of the tests (aaaaaaa, latest bbbbbbb).' });
  assert.deepEqual(status([review('alice', 'APPROVED', { body: full }), review('bob', 'CHANGES_REQUESTED', { body: 'AC-2 is wrong' })]),
    { state: 'failure', description: '@bob requested changes on the QA pull request #7.' });

  assert.deepEqual(status([review('alice', 'APPROVED', { body: null }), review('alice', 'APPROVED', { body: full })]),
    { state: 'success', description: 'Approved by @alice, with a reason per criterion. Ready to merge.' });
  assert.deepEqual(status([review('alice', 'APPROVED', { body: full })], merged),
    { state: 'success', description: 'Approved by @alice, with a reason per criterion.' });
  assert.equal(approvalStatus(pull(), [], ['AC-1']).description, 'Not approved yet. Approve with one line per criterion (AC-1), then merge.');
});
