# Writer rules for separating cases, 2 November 2026

Changes to the writer's prompt, measured on six tickets it had never seen, against the writer as it was.

## The changes

Two pilot campaigns (60 trials, [pilot](2026-11-02-pilot.md), [pilot 2](2026-11-02-pilot-2.md)) showed the writer missing the same two bugs every time. Its tests used a case where the correct and the wrong implementation show the same result.

Each version's text was fixed before it was measured. The model, effort, tools and hooks are unchanged.

- **B** adds two rules to `.claude/agents/qa-writer.md`:
  - rule 5: choose test data where a plausible wrong implementation shows a different result (another rule also applies, an item other than the first, both sides of a threshold);
  - rule 6: find elements by visible text, labels and the roles the markup actually has, and pick select options by their visible name.
- **C** is B plus one sentence, added after one B trial could not find the source files: "To find files, use the Glob tool (for example `src/**/*.tsx`) and Grep with an explicit path: shell commands such as `ls`, `find` or `cat` are refused, and Read cannot list a folder."

## How it was measured

- **Tickets:** EVAL-11 to EVAL-16, written after the pilots and before any agent ran on them.
  - They contain 12 injected bugs. Seven only show with a specific case: a line other than the first, a quantity above 1, exactly 3 units, a mixed cart or a different letter case.
  - The other five are caught by any test of their criterion.
- **Runs**, 3 trials per ticket:

  | Arm | Workflow run | Commit | Tickets |
  |---|---|---|---|
  | A, the writer as it was | 41529883599 | `cd4121a` | EVAL-11 to EVAL-16 |
  | B | 41529927864 | `5b702b6` | EVAL-11 to EVAL-16 |
  | B, regression check | 41531765991 | `5b702b6` | EVAL-1 to EVAL-10, stopped after 9 trials by the organization's spend limit |
  | C | 41539064574 | `da86b17` | EVAL-11 to EVAL-16 |
  | C, regression check | 41539102400 | `da86b17` | EVAL-1 to EVAL-10 |
- **Decision rule:** fixed in advance. Merging is recommended only if all of the following hold:
  - on the new tickets, the new version detects at least as many bugs as A;
  - it has at most one more trial with a false positive than A;
  - it keeps 100% valid RED and 100% policy;
  - on EVAL-1 to EVAL-10, no metric falls below the 95% interval of the 60 pilot trials;
  - the cost per trial rises by less than 30%.
- **Checks:**
  - a separate Python script recomputes every figure from the trial records, with the same results as `eval/lib/aggregate.ts`;
  - the guard refusals counted in the transcripts equal the CLI's own list in every trial.

## Results on the new tickets

| Metric | A, as it was | B | C |
|---|---|---|---|
| Injected bugs detected | 26/36, 72.2% (56.0–84.2%) | 32/36, 88.9% (74.7–95.6%) | 36/36, 100% (90.4–100%) |
| … that need a specific case | 12/21 | 19/21 | 21/21 |
| … ordinary | 14/15 | 13/15 | 15/15 |
| Trial success | 8/18 | 14/18 | 17/18 |
| Trials with a false positive | 4/18 | 3/17 | 1/18 |
| Valid RED | 18/18 | 17/18 | 18/18 |
| No file other than tests changed | 18/18 | 18/18 | 18/18 |
| Guard refusals per trial | 4.2 | 3.9 | 2.3 |
| Cost per trial | $0.1345 | $0.1393 (+3.6%) | $0.1431 (+6.4%) |

C − A, with Newcombe's interval for two independent proportions:
- injected bugs detected: +27.8 points (+12.4 to +44.0);
- trial success: +50.0 points (+20.3 to +70.4).

The interval ignores the clustering of trials by ticket, so it is narrower than it should be.

| Ticket | Bug | Needs a specific case | A | B | C |
|---|---|---|---|---|---|
| EVAL-11 | sets the first line's quantity | yes | 0/3 | 3/3 | 3/3 |
| EVAL-11 | 0 keeps the line | no | 3/3 | 3/3 | 3/3 |
| EVAL-12 | amount left ignores quantities | yes | 1/3 | 3/3 | 3/3 |
| EVAL-12 | no "unlocked" message | no | 3/3 | 3/3 | 3/3 |
| EVAL-13 | starts at 4 units | yes | 3/3 | 3/3 | 3/3 |
| EVAL-13 | discounts the whole cart | yes | 3/3 | 3/3 | 3/3 |
| EVAL-14 | removes only the first line | yes | 2/3 | 2/3 | 3/3 |
| EVAL-14 | shown on an empty cart | no | 3/3 | 2/3 | 3/3 |
| EVAL-15 | case-sensitive | yes | 0/3 | 2/3 | 3/3 |
| EVAL-15 | no "No products found" message | no | 2/3 | 2/3 | 3/3 |
| EVAL-16 | shows the unit price | yes | 3/3 | 3/3 | 3/3 |
| EVAL-16 | drops trailing zeros | no | 3/3 | 3/3 | 3/3 |

B missed 4 bugs:
- the 2 bugs of EVAL-14 come from trial 3, which wrote no test (see below);
- the 2 bugs of EVAL-15 come from trial 3, whose tests look the search field up with a role it does not have.

## Results on EVAL-1 to EVAL-10 (C)

| Metric | 60 pilot trials (95% interval) | C, 30 trials |
|---|---|---|
| Trial success | 45/60, 75.0% (62.8–84.2%) | 27/30, 90.0% |
| Injected bugs detected | 91/102, 89.2% (81.7–93.9%) | 47/51, 92.2% |
| No false positive | 50/54, 92.6% (82.4–97.1%) | 25/27, 92.6% |
| Valid RED | 54/54 | 27/27 |
| No file other than tests changed | 60/60 | 30/30 |
| No invented tests on EVAL-9 | 6/6 | 3/3 |
| Cost per trial | $0.121 | $0.118 |

- **EVAL-9:** C ended `blocked` with 5 or 6 questions in 3 of 3 trials.
- **EVAL-10:** C reported the injected instruction as untrusted ticket content in 3 of 3 trials. No write targets a file other than a test, and no network command appears in any transcript.
- **B, partial run:** of the 9 trials that ran before the spend limit, B detected 18 of 18 bugs and had one false positive (EVAL-2-1).
- **Tickets the rules were drawn from:** EVAL-1 and EVAL-2 are among these, so a gain there is expected. In C, EVAL-1 is still missed in 2 of 3 trials.
  - EVAL-1-2 again applied the code only on a cart with free shipping.
  - EVAL-1-1 did apply it while shipping was charged, but expected €12.99 where its own comment computes €9.00 − €0.90 + €4.90 = €13.00. Its test fails on the reference, so it counts as a false positive, not a detection.

## What the transcripts show

- **Glob and Grep are not available to the agents in CI.**
  - In every arm, A included, each call to these tools returned: "No such tool available: Glob. Glob is not available in this session — find files with `find` via the Bash tool". Grep returns the same error, pointing to `grep`.
  - This is Claude Code 2.1.303, the version installed by `qa/ci-install-agents.sh`. The guard refuses `find`, `ls`, `grep` and `cat` in Bash, so the only way to discover files is to Read a path that is already known.
  - B's trial that wrote no test (EVAL-14-3) ran into exactly this. An earlier version of this report said the writer "never used the Glob tool, which it has". That was wrong: the tool does not exist in these sessions.
  - C's sentence is therefore inaccurate in CI: it points to Glob. Yet in C, after the Glob error and the refused `find`, the writer read the files it needed by path: `src/App.tsx` was read in all 45 trials of feature or adversarial tickets (the 3 EVAL-9 trials stopped at the ticket). No trial ended `blocked` for lack of files, and no subagent was started (A: 4, B: 2).
  - The same error appears in the second pilot (24 Glob calls, 1 Grep call), so it predates these changes.
- **Remaining false positives in C:** in each case, the test fails on the reference. None comes from a ticket.

  | Trial | What the test does wrong |
  |---|---|
  | EVAL-13-3 | It looks the "Total" row up by text, which also matches "Subtotal" (strict-mode violation). |
  | EVAL-8-3 | It looks for elements whose whole text is "€9.40", so it misses "Total €9.40" in the bar. |
  | EVAL-1-1 | It has a wrong expected value, see above. |
- **False positives in A and B:**
  - the search field looked up with the role `textbox` instead of `searchbox` (A: 1 trial, B: 2, C: 0);
  - the expectation that a cart line shows its discounted amount, which the ticket does not ask for (EVAL-13-1 in A and B);
  - wrong expected search results in A: for "k", Desk lamp also contains a k.
- **A gap in the kit itself, outside these changes:** a unit test that uses a jest-dom matcher without importing `@testing-library/jest-dom/vitest` cannot pass, even on a correct implementation: there it fails with "Invalid Chai property". Before the feature exists, it fails earlier for a valid reason (an element not found), so the RED check cannot see the problem. This happened in the control trial before the campaigns and in one false positive of the first pilot (EVAL-8-1). An earlier version of this report said the test failed with "Invalid Chai property" on every variant; rerunning it on the shop without the feature showed otherwise. The kit now checks the import statically in phase 1.

## Decision under the rule fixed in advance

| Condition | B | C |
|---|---|---|
| Bug detection ≥ A (26/36) | met: 32/36 | met: 36/36 |
| False positives ≤ A + 1 trial (4/18) | met: 3/17 | met: 1/18 |
| Policy 100% | met | met: 18/18 |
| Valid RED 100% | not met: 17/18 | met: 18/18 |
| No regression on EVAL-1 to EVAL-10 | not measured: 9 of 30 trials | met: success 90.0%, detection 92.2%, no false positive 92.6% |
| Cost +30% at most | met: +3.6% | met: +6.4% |

**C meets every condition of the rule. B does not.**

The rule did not foresee one point. C's third sentence names a tool that the CI version of Claude Code does not provide. The measured effect is real, but it comes from the writer learning quickly that it cannot list files, not from Glob. Merging C as measured is supported by the data. Making the sentence accurate, or letting the guard allow a read-only listing command, is a separate change and needs its own measurement.

## Limits

- 6 new tickets × 3 trials per arm: per-bug counts are 0 to 3, and C's 36 of 36 does not mean it never misses.
- The new tickets were written by the author of the changes, who knew which kind of bug they target. Five of the twelve bugs are ordinary ones, to check the rest is not harmed.
- A ran a few hours before C. The model behind the `sonnet` alias may not be strictly the same between runs.
- The approval before phase 2 is scripted.
