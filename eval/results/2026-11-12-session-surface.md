# The agents without the project's configuration, smoke run, 12 November 2026

QA eval run [43168175641](https://github.com/Gleaming0427/agent-qa-kit/actions/runs/43168175641) (run 49), on the branch of the pull request that starts the agents with `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands` and `--tools` from their file (6 tools for the writer, 4 for the verifier, instead of 24). It was the first time agents ran with these options against the real model. Smoke selection, 3 trials per ticket, with phase 2: EVAL-1, EVAL-4, EVAL-8, EVAL-9 (ambiguous), EVAL-10 (adversarial), EVAL-15. Claude Code 2.1.303; served models: claude-sonnet-5-5 (writer) and claude-haiku-5-5 (verifier).

## Results

| | Run 49 |
|---|---|
| Trial success | 16/18 (88.9%, 95% interval 67.2% – 96.9%) |
| pass@1, pass@3, pass^3 | 88.9%, 100%, 66.7% |
| Valid RED | 15/15 |
| Injected bugs detected | 26/27 |
| No false positive | 12/15 trials |
| Policy (only test files changed) | 18/18 |
| Ambiguous ticket, nothing invented | 3/3 |
| Agent or API errors | 0/18 |
| Missing tools ("No such tool available") | none |
| Guard refusals | 0 |
| Cost | $1.32 in all, $0.073 per trial, $0.083 per successful trial |

Phase 1 used Read (73 calls), Write (30), Glob (18), Bash (17), Grep (5) and Edit (2): all within the six tools, and none was asked for that the session lacked. The transcripts of all 18 trials were read, with no sight of the corpus.

| Ticket | Run 49 | Last two runs in the history |
|---|---|---|
| EVAL-1 | 3/3 | 2/3, 3/3 |
| EVAL-4 | 3/3 | 3/3, 3/3 |
| EVAL-8 | 2/3, 1 false positive | 3/3, 3/3 (and 1 false positive in 3 at run 45) |
| EVAL-9 | 3/3 | 3/3, 3/3 |
| EVAL-10 | 3/3, 1 false positive | 3/3, 3/3 |
| EVAL-15 | 2/3, 1 false positive | 6/6, 3/3 |

The cost per trial was lower on every ticket than in its last two runs (EVAL-1 $0.090 against $0.107 – $0.109, EVAL-15 $0.077 against $0.089 – $0.095). Fewer tools make a shorter system prompt; this run alone does not show how much of the difference comes from that.

## The three false positives

Each is a generated test that fails on the reference implementation, for a reading of the page or the ticket that is too strict, as seen in earlier campaigns:

- **EVAL-10, trial 2:** both of its tests look for `/(?<!\d)4 products(?!\w)/` in the text of the whole Shop section, where the count is directly followed by the first product's name ("4 productsNotebook"), so the lookahead never matches. The other two trials looked for the count's own element.
- **EVAL-8, trial 2:** the unit test expects the bar to show `€4.50` and `€4.90`, amounts the ticket does not ask the bar to show. Run 45 had a false positive of the same kind on the same criterion.
- **EVAL-15, trial 2:** the unit test counts the items of the product list after a search that matches nothing, while the ticket says the message replaces the list.

None of them comes from a missing tool or from the project's configuration being left out.

## Release decision

**Review**, with no comparable ticket: the release baseline (D clean) ran on another version of the demo shop (its browser test stopped comparing screenshots, #50) and was scored by older code (the report gained the cost per success, #55). Both make the history block the comparison, as it should. A comparison would need a reference measured on the current shop and code: the agents of `main` on the same six tickets.

## Against a reference on the same shop and code

QA eval run [43173061289](https://github.com/Gleaming0427/agent-qa-kit/actions/runs/43173061289) (run 50) measured the agents of `main` before this change (commit `7ab7106`), on the same six tickets, 3 trials each, with phase 2. Both runs have the same shop and scoring code, so the history lets them be compared on all six tickets (`node eval/validate.ts --candidate gh-43168175641 --baseline gh-43173061289`).

| | Run 50, `main` before | Run 49, session options |
|---|---|---|
| Trial success | 17/18 | 16/18 |
| Injected bugs detected | 25/27 | 26/27 |
| Trials without a false positive | 14/15 | 12/15 |
| Policy respected | 18/18 | 18/18 |
| Guard refusals | 1 (a Grep on the whole project) | 0 |
| Cost per trial | $0.0835 | $0.0734 (−12%) |
| Cost per successful trial | $0.0884 | $0.0826 |
| Tokens per trial | 292,450 | 164,980 (−44%) |
| Phase 1 duration, p50 | 41.1 s | 43 s |

| Ticket | Run 50 | Run 49 | Change |
|---|---|---|---|
| EVAL-1 | 2/3 | 3/3 | unstable, better (the shipping bug found 3 times of 3, against 2) |
| EVAL-4 | 3/3 | 3/3 | pass in both |
| EVAL-8 | 3/3 | 2/3 | unstable, worse (1 false positive) |
| EVAL-9 (critical) | 3/3 | 3/3 | pass in both |
| EVAL-10 (critical) | 3/3 | 3/3 | pass in both (1 false positive on each side) |
| EVAL-15 | 3/3 | 2/3 | unstable, worse (1 false positive) |

**Decision: review.** Every rule passed but one: EVAL-8 and EVAL-15 are unstable and worse (3/3 → 2/3), which the trials neither confirm nor rule out. No regression is confirmed, no critical ticket changed, and the sign test finds no difference (1 ticket better, 2 worse, p = 1.0). The policy's next step is a rerun of EVAL-8 and EVAL-15, 3 trials, then the decision again with both runs as the candidate.

The tokens per trial fell by 44%, mostly in cache reads (2.47 million against 4.63 million over the campaign): the session's system prompt no longer lists 24 tools, the skills and the commands.
