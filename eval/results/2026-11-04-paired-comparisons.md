# Paired comparisons of the recorded versions, 4 November 2026

`eval/compare.ts`, run on the campaigns of the history with the rules of `eval/compare-policy.json`. No model was called. The decisions taken in `results/` used a rule written for each measurement. This note shows what the paired comparison says about the same pairs, and what it says about the method itself.

## The comparisons

Each side pools a version's campaigns: the new tickets (EVAL-11 to EVAL-16) and the regression check (EVAL-1 to EVAL-10), when both exist. The categories count tickets: pass in both / fail in both / improved / regressed / unstable. The sign test counts the tickets whose success rate rose (+) or fell (−).

| A → B | Tickets | Trial success | Bugs detected | Tickets: both pass / both fail / improved / regressed / unstable | Sign test, success | Cost | Decision |
|---|---|---|---|---|---|---|---|
| A → B (new tickets) | 6 | 8/18 → 14/18 | 26/36 → 32/36 | 1 / 0 / 1 / 0 / 4 | 3+ 0−, p = 0.25 | +3.6% | rejected |
| A → C (A: pilot 2 and A) | 16 | 30/48 → 44/48 | 71/87 → 83/87 | 6 / 0 / 3 / 0 / 7 | 8+ 1−, p = 0.039 | +2.2% | rejected |
| C → D | 16 | 44/48 → 46/48 | 83/87 → 86/87 | 13 / 0 / 0 / 0 / 3 | 2+ 0−, p = 0.50 | −15.4% | rejected |
| D → D clean | 16 | 46/48 → 45/48 | 86/87 → 86/87 | 13 / 0 / 0 / 0 / 3 | 1+ 2−, p = 1 | −1.1% | review |
| C → D clean | 16 | 44/48 → 45/48 | 83/87 → 86/87 | 13 / 0 / 0 / 0 / 3 | 1+ 0−, p = 1 | −16.3% | review |
| Pilot → pilot 2 (same agent) | 10 | 23/30 → 22/30 | 46/51 → 45/51 | 5 / 1 / 0 / 0 / 4 | 1+ 2−, p = 1 | −4.3% | rejected |

- **Rejected** in every comparison whose new version ran before D clean. The reason is always the same: its trials had the corpus file names in their context (rule `b_corpus_exposure`). The recheck found no use of them, but a version measured that way cannot be accepted on those trials.
- **Review** for D clean:
  - against D and C, the reference saw the corpus (`a_corpus_exposure`);
  - against D, EVAL-1 (2/3 → 1/3) and EVAL-8 (3/3 → 2/3) are unstable and lower. These are the false positives and the miss described in [2026-11-03-clean-campaign.md](2026-11-03-clean-campaign.md).
- **No ticket and no bug regressed** in any of these comparisons: no unit went from every trial passing to every trial failing.
- **The one significant result** is A → C over 16 tickets: 8 tickets better, 1 worse, p = 0.039. The one worse is EVAL-8, 3/3 → 2/3. On the 6 new tickets alone (A → C in [2026-11-02-writer-partitions.md](2026-11-02-writer-partitions.md)), 4 tickets changed and none could reach p < 0.05: the smallest possible p is 0.125.

## What the comparison with itself shows

The two pilots ran the same agent; only the harness's measurement code changed between them.
- 4 of their 10 tickets are unstable.
- 3 tickets changed rate: 1 up, 2 down.

With 3 trials per ticket, this is the variation to expect between two campaigns of one version. A difference of one trial on one ticket is not a signal; the rules treat it as "review" (`unstable_worse`), not as a regression.

## Limits

- The sign test only sees the direction of each ticket's change. To reach p < 0.05, the split between tickets that rose and tickets that fell must be at least:
  - 6 to 0 when 6 tickets change;
  - 9 to 1 when 10 change;
  - 13 to 3 when all 16 change.
- The categories need trials: with one trial per side, every unit is "stable", and the rule `enough_trials` asks for a review.
- The critical tickets (EVAL-9, EVAL-10) passed in every trial of every version here: the rule for a critical regression has not been met in the data yet.
