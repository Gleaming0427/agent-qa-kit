# A field found by its label, a value checked as part of a text, 9 November 2026

The campaign of every ticket on main after Gleaming0427/agent-qa-kit#40 found a weakness of the writer on EVAL-15: it looked up a field the ticket names by a role it assumed. The fix was measured, and the measurement found a second weakness of the same kind on EVAL-8: a value the ticket gives was looked up as an element whose whole text the writer assumed. This note gives the campaigns, the two changes to the writer's instructions and the release decisions.

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

## First change: a field found by its label

EVAL-15 asks for a "Search products" field above the product list. The reference implementation renders it as `<input type="search" aria-label="Search products" …>`, whose role is `searchbox`.

In runs 42 and 43, 3 of the 6 trials looked up the field with `getByRole('textbox', { name: 'Search products' })`: their tests failed on the correct implementation. The 3 others used `getByLabelText('Search products')` (Testing Library) or `getByLabel('Search products')` (Playwright), and passed. So did every EVAL-15 trial of the campaign "rule 5, run 35". The ticket names the field, not its kind.

The writer's step 6 now says: a field the ticket names, but the markup does not have yet, is found by its label, never by a role it assumes. Checked with the demo's Testing Library and Playwright 1.55.1 on the reference markup: the label finds the field, the `textbox` role does not.

Measured at `20a763b`:
- run 42598786785, EVAL-15, 6 trials: 6/6, all by the label;
- run 42598796372, the smoke selection then (EVAL-3, EVAL-8, EVAL-9, EVAL-10, EVAL-12, EVAL-17): 17/18;
- run 42610044168, EVAL-8, 3 trials, the follow-up the smoke run's release decision asked for: 2/3.

## Second change: a value checked as part of the element's text

The two EVAL-8 failures of runs 45 and 46 had the same cause. EVAL-8 asks for a bar fixed at the bottom of a phone screen that shows the order total and a "Checkout" button. Both unit tests looked up the bar's total as an element whose whole text is the amount (`getAllByText('€9.40')`, exact by default in Testing Library). The reference shows it as "Total €9.40", in one element, so the lookup found only the order summary's cell. The four other trials checked the bar's text with `toHaveTextContent`, which matches a part of it, and passed.

Before these changes, EVAL-8 had 9/9 in its last three campaigns (runs 38, 40 and 42). Earlier, it failed in some trials of "Pilot", "C", "D clean", "smoke, run 32" and "rule 5". The two failures of "rule 5", the only ones whose trials were read for this note, had other causes: a total computed wrong, and two "Checkout" buttons expected where the reference hides the cart's on phones.

The writer's step 6 now also says: a value the ticket gives without the text around it, such as a total or a count, is checked as part of the text of the element that shows it (`toHaveTextContent` with Testing Library, `toContainText` with Playwright), never as an element whose whole text it assumes; when a longer number would still contain it, it is bounded with a regular expression. Checked with the demo's Testing Library on the reference markup of EVAL-8: `getAllByText('€9.40')` finds only the order summary's cell; `toHaveTextContent('€9.40')` on the bar's container ("Total €9.40Checkout") passes, and so does the bounded expression.

Measured at `a0d03fa`:
- run 42653321823, the smoke selection now (EVAL-1, EVAL-2, EVAL-8, EVAL-9, EVAL-10, EVAL-15): 18/18;
- run 42653327754, EVAL-8, 3 trials, run alongside so that EVAL-8 has 6 trials: 3/3.

| | Runs 47 and 48 |
|---|---|
| Successful trials | 21/21 |
| Injected bugs detected | 33/33 |
| No generated test fails on the correct implementation | 18/18 trials |
| Verifier: pass on the correct implementation / fail on a buggy one | 18/18, 18/18 |
| Agent or API errors | 0/21 |
| Guard refusals | writer 0; verifier 1 (`echo` to note that it stopped, EVAL-1) |
| Cost | $1.60 + $0.37 = $1.97, $0.094 per trial |

- **EVAL-8**: 6/6. Each trial checked the bar's total with `toHaveTextContent` or `toContainText`; none used `getAllByText` with an amount. With the first change only: 4/6. With 6 trials on each side, the difference is not significant (Fisher's exact test, two-sided p ≈ 0.45).
- **EVAL-15**: 3/3, all by the label. With the label instruction, in both versions of the prompt: 9/9, against 3/6 before (two-sided p ≈ 0.044, on one ticket).
- **EVAL-2**: 3/3, but in one trial the bug "removes-first-line" (AC-1) was caught by AC-2 tests only: the AC-1 test removed the cart's first line each time, which is the line the bug removes. The same happened in runs 40 and 42, before these changes.

## Release decisions

The last version (`a0d03fa`, runs 47 and 48 as one candidate):

| Against | Comparable tickets | Changes | Cost per trial | Decision |
|---|---|---|---|---|
| "D clean", the release baseline | 6 | EVAL-1 1/3 → 3/3, EVAL-8 2/3 → 6/6, the 4 others pass in both | −6.3% | **accepted** |
| main (runs 42 and 43) | 6 | EVAL-1 2/3 → 3/3, EVAL-15 3/6 → 3/3, the 4 others pass in both | +3.3% | **accepted** |

Every rule passed in both. The sign tests detect no difference: with 2 tickets that changed, no result could reach p < 0.05. Against main, the history records a change of the writer's prompt only.

The intermediate version (`20a763b`, runs 44, 45 and 46) was **review** against both, for EVAL-8 alone.

## Limits

- The last version ran on 6 of the 17 tickets, 3 trials each (6 on EVAL-8). The intermediate version, whose instructions it extends, ran on EVAL-3, EVAL-12 and EVAL-17 with 3/3 each. The others did not run after the changes.
- No change on a single ticket is significant except EVAL-15's, at p ≈ 0.044 with 15 trials; the policy decides on no p-value alone.
- Both changes are about a guess on markup that does not exist yet. Other guesses of the same kind, such as a landmark role or the number of buttons, are not covered.
- Cost of the five campaigns on the branch: $4.61.
