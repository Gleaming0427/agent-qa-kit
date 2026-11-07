# The QA approval status and an amendment after a squash, on GitHub, 7 November 2026

After the trial on two real tickets (`2026-11-07-real-tickets.md`), two changes went into `main`:
- the **QA approval** status on the test pull request (Gleaming0427/agent-qa-kit#33);
- QA amend tests recording a squash-merged copy of the tests on `qa/<ticket>` (Gleaming0427/agent-qa-kit#34).

Both had only run in the kit's tests, with a stand-in for the GitHub CLI. This trial ran them on GitHub, on one small ticket of the demo shop, SHOP-2: the cart's heading shows the number of items, "Cart (3)". It ran on a trial branch, `trial/approval`, so nothing reached `main`. The repository's owner did the reviews and the merges. Both test pull requests were squash-merged on purpose.

## Timeline (UTC)

| Time | Step | Result |
|---|---|---|
| 14:01–14:03 | QA write tests | verdict `ready`, $0.14; one unit test and one browser test per criterion, each failing on the missing heading |
| 14:03:24 | #35 opened | QA approval **red**: "Not approved yet. Approve with one line per criterion (AC-1, AC-2), then merge." |
| 14:18:53 | approval with no text | 14:19:02, still **red**: "@Gleaming0427 approved without a reason for AC-1, AC-2. Approve again with one line per criterion." |
| 14:23:17 | approval with a line per criterion | 14:23:28, **green**: "Approved by @Gleaming0427, with a reason per criterion. Ready to merge." |
| 14:36:55 | #35 squash-merged | `feat/SHOP-2` got a copy of the tests (`2914979`), with the same files as the approved commit (`ba87c83`) |
| 14:37–14:38 | QA amend tests, no model call | the amended tests still fail for the right reason; the copy recorded on `qa/SHOP-2` by a merge that changes no file (`cf3dc16`); #36 opened with the 5 files of the amendment, QA approval **red** |
| 14:43:25 | approval of #36 with a line per criterion | 14:43:35, **green** |
| 14:45:52 | #36 squash-merged | no conflict; `feat/SHOP-2` has the same files as `qa/SHOP-2` |

Model calls: $0.14, for QA write tests only.

## What it showed

- **The QA approval status works on GitHub.**
  - QA write tests and QA amend tests set it when they open the pull request.
  - A review by a person starts the QA approval workflow, on a pull request opened by a workflow too.
  - Its status replaces the earlier one of the same name within about 10 seconds of the review.
- **An amendment merges after a squash.** In the omni-tools trial, the same situation gave conflicts on 4 files and a merge by hand. Here the amendment's pull request showed only the amendment and merged on GitHub.
- **The amendment was a real one.** The writer's browser test looked up the heading with `getByRole('heading', { name: 'Cart (3)' })`. Playwright compares that name as a case-insensitive substring (checked with Playwright 1.63): "cart (3)" or "Cart (3) items" passed, while the ticket asks for "Cart (3)". The amendment added `exact: true`. The unit test, with Testing Library, already compared the whole name. Nobody saw it in the review of #35.

## Other observations

- The kit's own checks ("React MFE + Playwright red/green/regression", "Eval corpus is valid") were created on #35 when it opened, at 14:03, and started at 14:15, from the owner's account (attempt 2). They failed, as on the earlier trial branches: they require every test of the demo to pass, and a test pull request adds tests that fail on purpose. A project that installs the kit does not get these two workflows.
- The order "approve, then merge" was followed on both pull requests. The owner was following the trial's steps, so this does not show what the status changes on its own.

## Limits

- One ticket, in the demo, with the person who asked for the changes doing the reviews.
- The case where the squash also holds other changes (the warning and the merge by hand) did not occur here. It is covered by the kit's tests and was checked on the commits of the omni-tools trial.
