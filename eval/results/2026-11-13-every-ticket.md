# Every ticket on `main` after #61, and a new release baseline, 13 November 2026

QA eval run [43431804429](https://github.com/Gleaming0427/agent-qa-kit/actions/runs/43431804429) (run 58), on `main` at `8ff5e3d`: every ticket of the corpus (17), 3 trials each, with phase 2. These are the agents after #61: the verifier runs one test command and reads a summary that lists the passed tests of each criterion, and the writer has two new rules, against a word bound after a text and on the amounts a test expects. The run started on 13 November at 13:13 UTC and ended at 14:00. It was asked for to replace the release baseline, "D clean", which no campaign could be compared with any more.

The `eval-report`, `eval-trials` and `release-decision` artifacts were read; their zips match the digests GitHub records.

## Results

| | Run 58 |
|---|---|
| Trial success | 50/51 (98.0%, 95% interval 89.7% – 99.7%) |
| pass@1, pass@3, pass^3 | 98.0%, 100%, 94.1% |
| Valid RED | 48/48 |
| Injected bugs detected | 96/96 |
| Detected bugs caught by a test of the right criterion | 95/96 |
| No test failing on the correct implementation | 47/48 trials |
| No flaky test (3 repeats) | 48/48 trials |
| Policy (only test files changed) | 51/51 |
| Ambiguous ticket, nothing invented | 3/3 |
| Verifier: pass on the correct implementation | 47/48 |
| Verifier: fail on a buggy implementation | 48/48 |
| Verifier: verdict matches the approved tests | 48/48 |
| Agent or API errors | 0/51 |
| Missing tools, sight of the corpus | none |
| Cost | $4.34 in all, $0.085 per trial, $0.087 per successful trial |

- **Phase 1** used Read (231 calls), Write (96), Bash (58), Glob (53), Edit (16) and Grep (13). Its duration was 54.1 s at the median and 163.6 s at the 95th percentile, in 10 turns at the median.
- **Tokens:** 136,498 per trial, phases 1 and 2 together.
- **Isolation:** the 51 trials ran the agent, the scoring and the verifier on separate runners, and the transcripts of all of them were read.

| Ticket | Kind | Run 58 | Bugs detected | Mean cost | Run 42, 9 November |
|---|---|---|---|---|---|
| EVAL-1 | feature | 3/3 | 6/6 | $0.093 | 2/3, bugs 5/6 |
| EVAL-2 | feature | 3/3 | 6/6 | $0.096 | 3/3 |
| EVAL-3 | feature | 3/3 | 6/6 | $0.089 | 3/3 |
| EVAL-4 | feature | 3/3 | 6/6 | $0.071 | 3/3 |
| EVAL-5 | feature | 3/3 | 6/6 | $0.082 | 3/3 |
| EVAL-6 | feature | 3/3 | 6/6 | $0.072 | 3/3 |
| EVAL-7 | feature | 3/3 | 6/6 | $0.091 | 3/3 |
| EVAL-8 | feature | 3/3 | 6/6 | $0.114 | 3/3 |
| EVAL-9 | ambiguous | 3/3 | none planted | $0.027 | 3/3 |
| EVAL-10 | adversarial | 3/3 | 3/3 | $0.060 | 3/3 |
| EVAL-11 | feature | 3/3 | 6/6 | $0.095 | 3/3 |
| EVAL-12 | feature | 3/3 | 6/6 | $0.100 | 3/3 |
| EVAL-13 | feature | 2/3, 1 false positive | 6/6 | $0.106 | 3/3 |
| EVAL-14 | feature | 3/3 | 6/6 | $0.088 | 3/3 |
| EVAL-15 | feature | 3/3 | 6/6 | $0.072 | 2/3, 1 false positive, bugs 4/6 |
| EVAL-16 | feature | 3/3 | 6/6 | $0.080 | 3/3 |
| EVAL-17 | feature | 3/3 | 9/9 | $0.111 | 3/3 |

Run 42 was the previous run of every ticket (49 of 51 trials). It is given for reading only: it ran on an earlier version of the demo shop and was scored by earlier code, so the history does not compare the two runs (0 comparable ticket).

## The one unsuccessful trial

**EVAL-13, trial 2.** The ticket says that a cart line of 3 units or more "gets 10% off its amount, rounded to the cent, and shows a −10% badge". The writer's unit test and browser test of AC-1 expect the cart line itself to show the discounted amount (`€12.15` for 3 notebooks). The reference implementation shows the badge on the line and takes the discount off the subtotal; the line shows no amount (it reads "Notebook−× 3−10%+"), so both tests fail on it.

- The amount is right (3 × 4.50 = 13.50, minus 1.35): this is not the wrong amount that rule 7 of the writer's prompt is for, and not a word bound. The test assumes a display the ticket does not ask for.
- In the same trial, the bug `discount-from-four-units` was detected, but not by a test of its own criterion: this is the one bug in 96 that the report does not attribute.
- The verifier reported "fail" on the reference implementation in that trial, as the tests do: its verdict matched the approved tests in the 48 trials.
- EVAL-13 had one trial in three with a test failing on the correct code in the first four campaigns of the history (2 and 3 November), and none in the four after them. Their causes were not read again for this document.

A test that assumes markup or a display the ticket does not give was seen once before with these session options: run 49, EVAL-15 trial 2, a list counted where the ticket says a message replaces it. Two cases in the campaigns since 12 November do not give a rate.

## The verifier

96 sessions: 48 trials with tests, each on the reference implementation and on one bug.

- No API error, no invalid verdict, and no verdict sent back by the verdict check.
- 97 Bash calls, all of them `npm run test:summary -- --run @shop --stop-on-unit-failure`, with 98 Read calls and 3 Grep calls, counted once per tool call (the transcripts repeat each block).
- The summary each session read listed passed tests with a `✓` (96 of 96).

## The guard and the checks of phase 1

- **4 refused tool calls in 51 writer sessions:** a chained shell command in two trials of EVAL-17, and a Grep on the whole project in two trials of EVAL-9. The four trials succeeded.
- **The check on word bounds** (`textBoundProblem`) sent back no test: its message is in none of the 51 writer transcripts, and run again on the 96 test files the writer generated, it flags none.
- No phase 1 ended on a verdict that the verdict check refused.

## The release decision, and the new baseline

The run's own decision, against "D clean", was **review**, as for every campaign since run 49: the scoring code differs (`939a3d87c514` at `efa197e`, `ecdbaa9d14e8` at `8ff5e3d`) and the demo shop changed, so no ticket was comparable. The other rules passed: every trial changed test files only, none saw the corpus, none ended on an agent or API error.

On 16 November 2026 the owner accepted this version as the release baseline: `eval/release-baseline.json` names `gh-43431804429`. Decisions computed again with it, with `node eval/validate.ts --candidate <campaign>`, no model call, and the rules of each candidate's own commit:

| Candidate | Agents | Comparable tickets | Decision |
|---|---|---|---|
| Run 56, smoke, 13 November | the same as run 58 | 6 (EVAL-1, 5, 8, 9, 10, 15) | accepted: every rule passed |
| Run 49, smoke, 12 November | before #61 | 6 | review: EVAL-8 (3/3 → 2/3), EVAL-15 (3/3 → 2/3) and the bug `wrong-count` of EVAL-10 (3/3 → 2/3) are unstable and worse |

These two lines show that the comparison now works, in both directions. They are not a test of #61: run 49 is the earlier version, read here as if it were the candidate.

## The smoke runs before it, on the branch of #61

Six tickets each, 3 trials, with phase 2. Only run 56 is in the history. Verifier: right verdict on the reference implementation, on a bug, and matching the approved tests, out of 15.

| Run | Agents (commit) | Trials | Verifier | What it found |
|---|---|---|---|---|
| 52 | `80e14ec` | 18/18 | not measured | The API credit ran out: the 30 verifier sessions ended on "Credit balance is too low". |
| 53 | `80e14ec` | 18/18 | 14, 13, 12 | 2 invalid verdicts: the summary listed only the failed tests. EVAL-10: a word bound after a text. |
| 54 | `012193d` | 18/18 | 15, 15, 15 | With the `✓` lines: no invalid verdict. |
| 55 | `13073eb` | 16/18 | 13, 15, 14 | 2 trials of EVAL-8 with a wrong expected amount. |
| 56 | `ecd4abf` | 18/18 | 15, 15, 15 | With rule 7 of the writer's prompt. |
| 57 | `bb5ef36` | 18/18 | 15, 15, 15 | The agents of run 56, a second series. |

## Limits

- **3 trials per ticket.** One failure in 51 trials is compatible with a rate of a few percent on any ticket. Runs 56, 57 and 58 together are 86 successful trials of 87 on these agents.
- **One corpus:** 17 tickets on one small shop. It says how the agents do there.
- **The effect of each change of #61 is not isolated.** Run 55 had two trials with a wrong amount on EVAL-8 and runs 56 to 58 have none in 9 trials of that ticket, which is too few to say that rule 7 is the reason.
- **Not measured:** the repair agent, which the evaluation does not run.
- **Cost:** $4.34 for this run, as reported by the Claude CLI; the cap given to the run was $8.
