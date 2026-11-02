# Writer rules for separating cases, 2 November 2026

A change to the writer's prompt, measured on six tickets it had never seen, against the writer as it was.

## The change

Two pilot campaigns (60 trials, [pilot](2026-11-02-pilot.md), [pilot 2](2026-11-02-pilot-2.md)) showed the writer missing the same two bugs every time. Its tests used a case where the correct and the wrong implementation show the same result. Two rules were added to `.claude/agents/qa-writer.md`, with the text fixed before any measurement:

- rule 5: choose test data where a plausible wrong implementation shows a different result (another rule also applies, an item other than the first, both sides of a threshold);
- rule 6: find elements by visible text, labels and the roles the markup actually has, and pick select options by their visible name.

The model, effort, tools and hooks are unchanged.

## How it was measured

- **Tickets:** EVAL-11 to EVAL-16, written after the pilots and before any agent ran on them.
  - They contain 12 injected bugs. Seven only show with a specific case: a line other than the first, a quantity above 1, exactly 3 units, a mixed cart or a different letter case.
  - The other five are caught by any test of their criterion.
- **Arm A**, the writer as it was: workflow run 41529883599 on `main` at `cd4121a`, 6 tickets × 3 trials.
- **Arm B**, with the two rules: workflow run 41529927864 on `5b702b6`, the same 6 tickets × 3 trials.
- **Regression check:** arm B on EVAL-1 to EVAL-10 × 3, workflow run 41531765991. It was cut short, see below.
- **Decision rule:** fixed in advance. Merging is recommended only if, on the new tickets:
  - B detects at least as many bugs as A;
  - B has at most one more trial with a false positive than A;
  - B keeps 100% valid RED and 100% policy.

  In addition, on EVAL-1 to EVAL-10, no metric of B may fall below the 95% interval of the 60 pilot trials, and the cost per trial must rise by less than 30%.
- **Checks:** a separate Python script recomputes every figure from the trial records, with the same results as `eval/lib/aggregate.ts`.

## Results on the new tickets

| Metric | A, as it was | B, with the rules | B − A, 95% interval |
|---|---|---|---|
| Injected bugs detected | 26/36, 72.2% (56.0–84.2%) | 32/36, 88.9% (74.7–95.6%) | +16.7 pts (−1.9 to +34.2) |
| … that need a specific case | 12/21, 57.1% (36.5–75.5%) | 19/21, 90.5% (71.1–97.3%) | |
| … ordinary | 14/15, 93.3% (70.2–98.8%) | 13/15, 86.7% (62.1–96.3%) | |
| Trial success | 8/18 | 14/18 | +33.3 pts (+1.6 to +57.2) |
| Trials with a false positive | 4/18 | 3/17 | |
| Valid RED | 18/18 | 17/18 | |
| No file other than tests changed | 18/18 | 18/18 | |
| Cost per trial | $0.1345 | $0.1393 | +3.6% |

Differences are given with Newcombe's interval for two independent proportions. It ignores the clustering of trials by ticket, so it is narrower than it should be.

| Ticket | Bug | Needs a specific case | A | B |
|---|---|---|---|---|
| EVAL-11 | sets the first line's quantity | yes | 0/3 | 3/3 |
| EVAL-11 | 0 keeps the line | no | 3/3 | 3/3 |
| EVAL-12 | amount left ignores quantities | yes | 1/3 | 3/3 |
| EVAL-12 | no "unlocked" message | no | 3/3 | 3/3 |
| EVAL-13 | starts at 4 units | yes | 3/3 | 3/3 |
| EVAL-13 | discounts the whole cart | yes | 3/3 | 3/3 |
| EVAL-14 | removes only the first line | yes | 2/3 | 2/3 |
| EVAL-14 | shown on an empty cart | no | 3/3 | 2/3 |
| EVAL-15 | case-sensitive | yes | 0/3 | 2/3 |
| EVAL-15 | no "No products found" message | no | 2/3 | 2/3 |
| EVAL-16 | shows the unit price | yes | 3/3 | 3/3 |
| EVAL-16 | drops trailing zeros | no | 3/3 | 3/3 |

B missed 4 bugs:
- the 2 bugs of EVAL-14 come from trial 3, which wrote no test (see below);
- the 2 bugs of EVAL-15 come from trial 3, whose tests look the search field up with a role it does not have.

## Results on EVAL-1 to EVAL-10 (incomplete)

The regression run stopped after 9 trials: EVAL-1 to EVAL-3, with phase 2 missing for EVAL-3. From then on, every request failed with HTTP 400, "You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC". According to the [Anthropic documentation](https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit), this is a spend limit set by the organization itself, which can be raised on the Billing page of the Claude Console. EVAL-4 stopped during phase 1, and EVAL-5 to EVAL-10 did not run.

On the 9 trials that ran:
- B detects 18 of 18 bugs and succeeds in 8 trials. The 18 pilot trials of the same tickets detected 25 of 36 bugs and succeeded in 7.
- B has one false positive, in EVAL-2 trial 1. Its test checks that the product name disappears from the page after a removal, but the name is still in the product list.

These three tickets include the two from which the rules were drawn, so the gain there is expected and proves nothing on its own.

## What the transcripts show

- **The trial without a valid RED (B, EVAL-14-3) did not write any test.**
  - The guard refused `ls`, `find` and `git ls-files`, for the session and for its `Explore` subagent.
  - The writer never used the Glob tool, which it has, and guessed a file that does not exist (`src/Cart.tsx`).
  - It ended `blocked`, asking for the file paths. Nothing in the two new rules is about finding files, and none of the 74 earlier trials on tickets that are not ambiguous ended this way, but one trial cannot rule out a link.
- **False positives that remain in both arms:**
  - The search field is looked up with the role `textbox` (A: 1 trial, B: 2). The reference uses `<input type="search">`, whose role is `searchbox`. The field does not exist before the feature, so the writer cannot check its role in the markup, and rule 6 did not prevent this.
  - EVAL-13 trial 1, in both arms, expects the cart line to show its discounted amount. The ticket says a line "gets 10% off its amount" but does not say that lines show an amount, and the shop's lines do not.
- **False positives that disappeared in B:** two trials of A (EVAL-15-1, EVAL-15-2) computed wrong expected search results. For "k", one expected Notebook and Backpack, but Desk lamp also contains a k. For "o", the other expected Backpack.
- **A gap in the kit itself, outside this change:** the control trial before the campaigns wrote a unit test with a jest-dom matcher and no `@testing-library/jest-dom/vitest` import. It failed with "Invalid Chai property" on every variant, and the kit accepted that failure as a valid RED. The same cause explains one false positive of the first pilot (EVAL-8-1), now corrected in its report.

## Decision under the rule fixed in advance

| Condition | Result |
|---|---|
| Bug detection, B ≥ A | met: 32/36 against 26/36 |
| False positives, B ≤ A + 1 trial | met: 3/17 against 4/18 |
| Policy 100% | met: 18/18 |
| Valid RED 100% | **not met: 17/18** (EVAL-14-3, files not found) |
| No regression on EVAL-1 to EVAL-10 | **not measured**: 9 of 30 trials, stopped by the spend limit |
| Cost +30% at most | met: +3.6% |

Under this rule, the change is not recommended yet.

The gain on bugs that need a specific case is large (12/21 to 19/21). Its interval for all bugs still includes zero. To decide, the remaining regression trials must run once the spend limit allows. The trial that could not find its files also calls for its own fix, measured separately.

## Limits

- 6 new tickets × 3 trials per arm: only a large difference can be read, and per-bug counts are 0 to 3.
- The new tickets were written by the author of the change, who knew which kind of bug it targets. Five of the twelve bugs are ordinary ones, to check the rest is not harmed.
- The approval before phase 2 is scripted.
