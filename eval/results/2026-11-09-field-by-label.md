# A field found by its label, 9 November 2026

The campaign of every ticket on main after Gleaming0427/agent-qa-kit#40 found one weakness of the writer: on EVAL-15, it looked up a field the ticket names by a role it assumed. This note gives that campaign, the change to the writer's instructions, the campaigns that measured it, and the release decision.

## Every ticket on main (run 42)

Run 42588473594, 17 tickets, 3 trials each, with the verifier, on main at `5bbe246`. Run 41 (42467417000) stopped after 45 of 51 trials on a low credit balance; it is not recorded.

| | Run 42 |
|---|---|
| Successful trials | 49/51 |
| Injected bugs detected | 93/96 |
| No generated test fails on the correct implementation | 47/48 trials |
| Verifier: pass on the correct implementation / fail on a buggy one | 47/48, 47/48 |
| Agent or API errors | 0/51 |
| Cost | $4.84, $0.095 per trial |

The two failed trials: EVAL-1 missed a bug in one trial, and EVAL-15 failed on the correct implementation in one. Its release decision was **review**: EVAL-15 3/3 → 2/3 against the release baseline ("D clean"). The follow-up it asked for (run 42596342131, EVAL-15, 3 trials) gave 1/3.

## What failed on EVAL-15

EVAL-15 asks for a "Search products" field above the product list. The reference implementation renders it as `<input type="search" aria-label="Search products" …>`, whose role is `searchbox`.

In runs 42 and 43, 3 of the 6 trials looked up the field with `getByRole('textbox', { name: 'Search products' })`: their tests failed on the correct implementation. The 3 others used `getByLabelText('Search products')` (Testing Library) or `getByLabel('Search products')` (Playwright), and passed. So did every EVAL-15 trial of the campaign "rule 5, run 35".

The ticket names the field, not its kind: it does not say whether it is a textbox, a searchbox, a spinbutton or a combobox.

## What changed

The writer's step 6 now says: a field the ticket names, but the markup does not have yet, is found by its label (`getByLabelText` with Testing Library, `getByLabel` with Playwright), never by a role it assumes. Checked with the demo's Testing Library and Playwright 1.55.1 on the reference markup: the label finds the field, the `textbox` role does not.

Nothing else in the agent changed: between the two versions, the history records a change of the writer's prompt only.

## Measured

Three campaigns on the branch, at `20a763b`:
- run 42598786785: EVAL-15, 6 trials;
- run 42598796372: the smoke selection (EVAL-3, EVAL-8, EVAL-9, EVAL-10, EVAL-12, EVAL-17), 3 trials each;
- run 42610044168: EVAL-8, 3 trials, the follow-up the release decision of the smoke run asked for.

**EVAL-15.** All 6 trials looked up the field by its label; none used a `textbox` or `searchbox` role. 6/6 successful, 12/12 bugs detected, no test failing on the correct implementation. Before the change: 3/6. With 6 trials on each side, the difference is not significant (Fisher's exact test, two-sided p ≈ 0.18).

**EVAL-8.** 4/6 successful (2/3 in each run). The two failed trials failed for the same reason: their unit test looked up the bar's total as an element whose whole text is "€9.40" (`getAllByText('€9.40')`, exact by default), and the reference shows it as "Total €9.40", in one element. The four other trials checked the bar's text with `toHaveTextContent`, which matches a part of it, and passed. Before the change, EVAL-8 had 9/9 in its last three campaigns (runs 38, 40 and 42). Earlier, it failed in some trials of "Pilot", "C", "D clean", "smoke, run 32" and "rule 5". The two failures of "rule 5", the only ones whose trials were read for this note, had other causes: a total computed wrong, and two "Checkout" buttons expected where the reference hides the cart's on phones. The new sentence is about fields; the bar is not one, and these trials do not show whether it changed how the writer looked up the total.

**The other tickets** of the smoke run: 3/3 each. Guard refusals: 3 for the writer, all on EVAL-17 (`sed -i` twice, `npx node -e` once), 0 for the verifier. Cost of the three campaigns: $0.57 + $1.71 + $0.36 = $2.64.

## Release decision

With the three campaigns as one candidate, against the release baseline ("D clean"): **review**. 6 tickets are comparable, as the policy needs; no regression is confirmed; cost per trial −8.0%. The one rule that did not pass is `unstable_worse`: EVAL-8 detected 5 of 6 of each bug, against 3 of 3.

Against main (runs 42 and 43), the version this change starts from, also **review**: 7 comparable tickets; EVAL-15 3/6 → 6/6 (unstable, better), EVAL-8 3/3 → 4/6 (unstable, worse), the others unchanged; cost per trial +4.7%. The sign tests detect no difference: with 2 tickets that changed, no result could reach p < 0.05.

EVAL-8 already had its one follow-up. The policy asks a person to read its trials and decide whether the agent has a weakness to fix or a variation to accept.

## Limits

- 6 trials on EVAL-15 and 6 on EVAL-8 for the new version: neither the gain on EVAL-15 nor the loss on EVAL-8 is significant.
- Only 7 of the 17 tickets ran with the new version.
- The cause found on EVAL-8, a total looked up as an exact text that the ticket does not give, is of the same kind as EVAL-15's: a guess about markup that does not exist yet. The instruction does not cover it.
