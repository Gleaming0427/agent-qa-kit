# A coverage summary for the reviewer, 5 November 2026

A suggestion from a reader of the project: when a person approves the tests, show them what the tests cover and what they leave out, not only the test code. Reading code shows what is wrong in a test, not what is missing. The tests that missed EVAL-1's shipping bug looked right, and would have been approved ([2026-11-04-eval-1-ac-1.md](2026-11-04-eval-1-ac-1.md)).

What changed in the agent:

- **The verdict carries a summary.** The writer's phase 1 verdict now has a `coverage` summary. For each criterion, it gives the cases the tests use (the data, the expected values with their arithmetic, the wrong implementation each one rules out) and `not_covered`, what they leave out.
- **The Stop hook checks it.** It sends back a verdict without the summary, and one with an `a + b = c` that does not add up (`.claude/hooks/coverage.ts`).
- **Rule 5 stays as it is,** the one of D clean.

## The plan, written before the results

Committed before any campaign of this agent ran.

- **Two campaigns, same commit:**
  - EVAL-1 with 5 trials, the ticket the change is about;
  - EVAL-9, EVAL-10, EVAL-8, EVAL-12 and EVAL-17 with 3 trials each: the two critical tickets, and the three where the measured rule 5 wrote wrong amounts.

  The smoke selection leaves EVAL-1 out at the moment, hence a list. Both campaigns stay under `max_cost_usd`.
- **The decision** is the release decision on both campaigns together, against D clean, with run 34 for EVAL-17.
- **What would show the summary helps the reviewer**, read from the verdicts: on EVAL-1, in each trial whose AC-1 cases all have free shipping, whether `not_covered` names a cart under €50, where shipping is paid. That is the case a reviewer would have to ask for.
- **What it may change in the tests:**
  - EVAL-1's bug `discount-includes-shipping` detected more or less often than before (7 of 15);
  - false positives against 2 in 48 trials for the reference;
  - how often the hook sends back a wrong amount during a session.

  With 3 to 5 trials per ticket, only large changes can be read.
- **What would show a cost:**
  - trials that fail because the verdict is refused (the hook sends a verdict back three times, then the launcher refuses it);
  - a longer phase 1;
  - a higher cost per trial.
- **What this cannot measure:** whether a person who reads the summary asks for the missing case. There is no reviewer in an evaluation.
- **Nothing is concluded** from tickets whose trials disagree in one campaign. A ticket that gets worse gets one follow-up, budget allowing.

## The results

Three campaigns of agent 47cef1a039ad, commit 4af384d, $2.80 in all:
- run 37: EVAL-1, 5 trials;
- run 38: EVAL-9, EVAL-10, EVAL-8, EVAL-12 and EVAL-17, 3 trials each;
- run 39: the follow-up of EVAL-12, 3 trials.

| | D clean's agent | Coverage summary |
|---|---|---|
| Trial success | 15/18 | 22/23 |
| Injected bugs detected | 29/30 | 39/40 |
| Trials without a false positive | 13/15 | 20/20 |
| Mean cost per trial | $0.105 | $0.117 (+11%) |
| Phase 1 duration, p50 | 49.6 s | 57.9 s |

The reference is D clean, with run 34 for EVAL-17, on the same six tickets. Against every campaign of D clean's agent on those tickets, the reference gives:
- 49 of 60 trials successful;
- 81 of 90 bugs detected;
- 46 of 49 trials without a false positive.

### What the plan asked

- **Does the summary show the gap the reviewer needs?**
  - On EVAL-1 the planned measure had no case to read: none of the 5 trials kept to free-shipping carts. Each wrote two AC-1 cases, one of them under €50 with shipping paid, and detected the bug.
  - The one miss of the three campaigns is EVAL-12 trial 1 of run 38. It missed `ignores-quantities`, and its summary says, under `not_covered`: "quantities above 1 in the hint calculation". A reviewer who reads that list sees the case to ask for. That is the mechanism the suggestion described, seen once.
- **EVAL-1's bug** was detected 5 times out of 5, against 7 of 15 for D clean's agent (exact test, p = 0.055). Several summaries name it among the wrong implementations a case rules out, for instance "a discount taken on subtotal plus shipping (19.90 × 10% = 1.99, total 17.91)". On the ticket that motivated the change, with 5 trials, that is a hint, not a proof.
- **False positives:** none in 20 trials with tests, against 3 in 49 for every campaign of D clean's agent (p = 0.55). No wrong expected amount appears in the summaries, and no transcript shows the hook sending one back. The arithmetic check had nothing to catch here: it was written for the cases the measured rule 5 added, and that rule is not part of this agent.
- **Cost:** about 10% more per trial and 8 s more for phase 1 at the median. No trial failed on its verdict: all 23 phase 1 runs ended ready, or as planned on EVAL-9.

### The decision

- **Review.** One rule did not pass, `unstable_worse`: EVAL-12 at 5/6 against 3/3 (6/6 for every campaign of D clean's agent), through the trial above. Every other rule passed.
- **The human review it asks for:** the miss is one trial in six. Its summary named the case the tests left out, so a reviewer had what was needed to ask for it.
- **Not released yet.** The six tickets are a third of the corpus, and the release baseline stays D clean. Confirming the change on every ticket takes a full run, about $6.50.

## Limits

- 23 trials on 6 tickets, chosen before the results: EVAL-1, the two critical tickets, and three where an earlier change wrote wrong amounts. The other 11 tickets were not run with this agent.
- A summary written by the agent can only name the gaps the agent sees. Here the summaries of the 22 other trials list edges such as case-sensitivity, an empty cart or rounding, which a reviewer may or may not need.
- Whether a person reading the summary asks for the missing case is not measured.
