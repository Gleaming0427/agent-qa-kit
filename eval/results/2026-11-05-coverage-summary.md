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
