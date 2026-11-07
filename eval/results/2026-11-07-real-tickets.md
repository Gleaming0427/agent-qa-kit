# Two real tickets, end to end, 7 November 2026

Until now the agents had only run in QA eval, on hidden tests. This trial ran the product workflows the way a team would use them, on two tickets:
- QA write tests;
- a person's review;
- the developer's pull request;
- QA verify;
- and, when an approved test turned out to be wrong, QA amend tests.

Both tickets ran in this repository, on trial branches (`trial/shop`, `trial/omni-tools`), so nothing reached `main`. The kit was the one of this branch (after Gleaming0427/agent-qa-kit#26). I wrote the features, as the developer; the repository's owner did the reviews.

- **SHOP-1, the demo shop:** express delivery, €9.90 whatever the subtotal, also above the free-shipping threshold.
- **OMNI-1, [omni-tools](https://github.com/iib0011/omni-tools)** (commit 9244e02, MIT), a real React application of about 860 files: a "Reverse word order" option in its text-reversal tool. It was copied into `trials/omni-tools`, changed only where the kit needs it:
  - Playwright also runs `e2e/`, and only Chromium;
  - the four npm scripts with their JSON reports;
  - `/reports/` is ignored;
  - one browser test is tagged `@smoke`.

  The trial branches were deleted afterwards; the pull requests below keep the diffs.

## Results

| | SHOP-1 | OMNI-1 |
|---|---|---|
| Tests written | 3 unit, 3 browser; first run, about 1 min, $0.16 | 6 unit, 3 browser; third run, $1.43 for the three |
| Review | approved | approved; one weak case noticed (below) |
| QA verify | pass at the first run: verifier $0.005, 19 s; full suite 9 unit and 8 browser tests | blocked the first run (a wrong approved test); pass after QA amend tests: verifier $0.006, 88 s; full suite 705 unit and 9 browser tests |
| Model calls | $0.17 | $1.44 |

Not counted: the kit's own CI ran its AI visual review of the demo twice on the SHOP-1 branch, at most $0.17 each.

## SHOP-1

- **Pull requests:** tests Gleaming0427/agent-qa-kit#27, code Gleaming0427/agent-qa-kit#28.
- **The writer's tests** were right at the first run. All the amounts add up (4.50 + 4.90 = 9.40, 53.50 + 9.90 = 63.40). The coverage summary listed "exactly €50.00" as not covered, which no combination of the shop's prices reaches.
- **The screenshots.** The delivery choice changes the page, so the smoke journey's screenshots no longer matched. As the guide says, the old baselines were removed, the kit's CI made new ones on its runner, and they were checked by eye and committed.
- **QA verify** then passed: 6 pieces of evidence and the full suite, smoke journeys on desktop and mobile included.

## OMNI-1

- **Pull requests:** tests Gleaming0427/agent-qa-kit#29, amended tests Gleaming0427/agent-qa-kit#31, code Gleaming0427/agent-qa-kit#30.
- **First writer run: out of turns.** It reached its limit of 40 turns ($0.66), after the unit tests and before the browser test. It also lost turns to commands the guard refuses (`| tail`, `vitest -t`). The repository variable `QA_MAX_TURNS` now raises the limit; this trial used 60.
- **Second run: blocked, with a question** ($0.52). Rendering the tool's React component under Vitest crashed. The writer did not present those failures as evidence: it stopped as blocked and asked whether the unit tests should call the tool's service, and with which signature. No unit test in omni-tools renders a component. The answer went into the ticket.
- **Third run: ready** ($0.25, about 4.5 min). The second run had taken 57 turns.
- **The review** noticed one weak case: "a b c" on three lines gives the same result whether the words or the letters are reversed, so that test passed before the feature existed. The other test of the criterion does the work.
- **QA verify blocked the correct code** (verifier $0.007). The approved browser tests looked up the new checkbox by its label, and the page shows each option four times: in the tool and in its three example cards. Playwright refused to choose. Nobody had seen it: when the tests were written the option did not exist, so they failed on "not found".
- **QA amend tests**, its first real run, no model call:
  - the tests were fixed on `qa/OMNI-1` (`.first()`, the tool's own checkbox);
  - the workflow checked that they still failed for the right reason without the feature;
  - it logged who changed them and why, and opened #31, which the owner approved.
- **QA verify** then passed.

## What it showed about the kit

- **The human step is easy to get wrong.**
  - #27 was merged before it was approved.
  - #29 was approved without the line per criterion QA verify needs.

  Both were caught only later, by QA verify or by checking by hand. The test pull request should say, while it is open, what its approval is missing.
- **A squash-merged test pull request blocks a later amendment.** #29 was squash-merged, so `qa/OMNI-1` and `feat/OMNI-1` both added the test files and #31 could not be merged on GitHub. It was merged by hand, with the approved files unchanged. Test pull requests should be merged with a merge commit, or the amendment should start from the developer's branch.
- **A real application needs more turns than the demo,** hence `QA_MAX_TURNS`.
- **The writer's questions work.** On a setup it could not test, it stopped and asked instead of passing broken evidence.
- **QA verify did its job both ways.** It passed two correct changes, and refused one whose approved tests could not pass on any implementation. The fix went through a logged, re-approved amendment, not through the developer.

## Limits

- Two tickets, one run each through QA verify: this says the workflows work end to end, not how often the agents get it right. That is what QA eval measures.
- I wrote both features, knowing the tests. A developer who does not read them first might take more rounds.
- The trial branches change the kit's own checks: `qa-verify.yml` also runs on pull requests into `trial/**`. So the kit's "Guards" and "Eval corpus" checks fail there, which they would not do in a project that installs the kit.
