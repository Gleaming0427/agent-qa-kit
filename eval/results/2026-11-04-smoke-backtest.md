# Smoke runs replayed on the history, 4 November 2026

`node eval/smoke.ts backtest`, on the 14 campaigns of the history, with no model call. Five agent versions follow one another: the writer as it was (pilots and A), B, C, D and D clean. That gives four changes of version.

For each change:
- the smoke selection is made from the campaigns that started before the new version, as it would have been on that day;
- the smoke run is replayed with the new version's own trials on the selected tickets;
- the "full run" is everything the new version's campaigns ran;
- a ticket is "worse" when its success rate fell against the latest earlier version that ran it with the same corpus.

## With the policy's 6 tickets

| Version (after) | Smoke selection | Worse in the full run | Caught | Better | Caught | Cost smoke / full |
|---|---|---|---|---|---|---|
| B (after the writer as it was) | EVAL-9 EVAL-10 EVAL-2 EVAL-4 EVAL-5 EVAL-1 | none | – | EVAL-1 EVAL-2 EVAL-11 EVAL-12 EVAL-15 | 2/5 | $1.28 / $4.16 |
| C (after B) | EVAL-9 EVAL-10 EVAL-4 EVAL-5 EVAL-8 EVAL-6 | EVAL-1 EVAL-8 | 1/2 | EVAL-2 EVAL-4 EVAL-5 EVAL-14 EVAL-15 | 2/5 | $1.89 / $6.11 |
| D (after C) | EVAL-9 EVAL-10 EVAL-1 EVAL-8 EVAL-13 EVAL-12 | none | – | EVAL-1 EVAL-8 | 2/2 | $1.85 / $5.17 |
| D clean (after D) | EVAL-9 EVAL-10 EVAL-1 EVAL-8 EVAL-13 EVAL-12 | EVAL-1 EVAL-8 | 2/2 | EVAL-13 | 1/1 | $2.04 / $5.45 |

- **Catch:** 3 of the 4 tickets that got worse; 7 of the 13 that got better.
- **Regressions:** no ticket regressed in the strict sense (every trial passing before, every trial failing after), so the backtest cannot tell how well the selection catches one.
- **Cost:** $7.06 for the smoke runs, $20.88 for the full runs (34%), 73 trials against 194.
- **The miss:** EVAL-1 when C followed B. Before C, EVAL-1 had failed every trial of the pilots (0/6), then passed every trial of B (3/3): stable in each version, and better, so no signal pointed to it. C passed it once in 3 trials.
- **What came back:** EVAL-1 and EVAL-8, worse with C and with D clean, are the two tickets the selection now picks for their regressions. The current selection is EVAL-9, EVAL-10, EVAL-1, EVAL-8, EVAL-12 and EVAL-13.

## The size

| Size | Worse tickets caught | Cost of the smoke runs |
|---|---|---|
| 4 | 1/4 | 22% of the full runs |
| 5 | 2/4 | 28% |
| 6 | 3/4 | 34% |
| 7 | 3/4 | 40% |

The policy's size went from 5, the first hypothesis, to 6: on this history, the sixth ticket catches one more worse ticket, and the seventh catches none.

## Limits

- 4 changes of version and 4 tickets that got worse, each by one or two trials of three: these are differences the same agent also shows between two campaigns (see [2026-11-04-paired-comparisons.md](2026-11-04-paired-comparisons.md)). The backtest measures how well the selection follows them, not how well it catches a real regression, which the history has none of.
- The replay uses the full run's own trials on the selected tickets: a real smoke run would have drawn other trials.
- The "full runs" are what each version's campaigns ran. B's regression check lost 21 of its 30 trials to the spend limit, so B's data on EVAL-1 to EVAL-10 is partial.
- The rotation only moves when smoke runs are added to the history (`eval/history`, see its README). Without that, every smoke run picks the same tickets.
