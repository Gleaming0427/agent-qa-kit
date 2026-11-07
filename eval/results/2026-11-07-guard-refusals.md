# Fewer turns lost to refused commands, 7 November 2026

Each tool call the guard refuses costs the agent a turn. On omni-tools, the writer reached its turn limit, and it had lost turns to refused commands. This note gives what the agents tried, what changed (Gleaming0427/agent-qa-kit#38), and the smoke campaign that measured it: run 42401051963, 6 tickets, 3 trials each, with the verifier.

## What the agents tried

The campaign reports count refusals by reason only. The transcripts of the campaign of 5 November (run 41996325075, "coverage summary, run 38", 15 trials) give each refused call, with its command:

| Agent | Refusals | What it tried | Count |
|---|---|---|---|
| Writer (phase 1) | 16 | its three test commands chained with `;`, output cut with `\| tail` or `\| head` | 12 |
| | | Glob or Grep with the project root as the path | 4 |
| Verifier (phase 2) | 41 | `cat reports/<ticket>-criteria.json`, often tried again after the refusal | 23 |
| | | `npm run test:affected 2>&1 \| tail -n 80` | 12 |
| | | commands chained with `;` | 4 |
| | | Glob or Grep from the root, an unsafe browser test option | 2 |

The writer's chained command was, in most trials, `npm run test:affected >/dev/null 2>&1; npm run test:e2e -- --grep @shop >/dev/null 2>&1; npm run test:summary 2>&1 | tail -60`: it wanted the summary of a test cycle, in one turn, without the raw output.

Across the 10 campaign reports of the history, the writer had 137 refusals in 139 trials, 119 of them "Shell chaining/redirection/escaping forbidden".

The writer's instructions said that `ls`, `find` and `cat` are refused; it never tried `cat`. The verifier's did not say so.

## What changed

- `npm run test:summary -- --run @<mfe>` runs the unit tests, then the browser tests of the feature area, and prints the summary of both. The writer's instructions use it for a test cycle.
- The guard's refusals say what to do instead: one command per call, the Read, Glob and Grep tools rather than `cat`, `ls` or `find`, a folder for Grep.
- Glob may search from the project root; Grep still may not.
- The verifier's instructions say what the writer's said about shell commands.

## Measured

On the five tickets the two campaigns share (EVAL-8, EVAL-9, EVAL-10, EVAL-12, EVAL-17), 15 trials on each side:

| | 5 November (run 41996325075) | 7 November (run 42401051963) |
|---|---|---|
| Writer refusals | 16 | 1 |
| Verifier refusals | 41 | 0 |
| Writer turns, mean (median) | 11.3 (12) | 9.0 (10) |
| Cost per trial, mean | $0.1109 | $0.0939 |
| Successful trials | 14/15 | 15/15 |

The refusals are counted from the transcripts, once per refused call, as the campaign report does for the writer. Over the whole new campaign (18 trials, EVAL-2 included), there were 2 refusals:
- the writer gave Grep the project root on the ambiguous ticket (EVAL-9);
- the verifier tried `echo "…" >/dev/null` to note that it had stopped (EVAL-2).

Every score of the campaign is 100%: trial success 18/18, injected bugs detected 30/30, the verifier right on all 15 correct and 15 buggy implementations. Its cost was $1.73, for an estimate of $2.08.

The release decision is **review**, not reject. Against the release baseline ("D clean"), 5 tickets are comparable, and the policy needs 6 before a direction of change can be significant. It asks for a run of every ticket. On the 5 comparable tickets, nothing got worse: EVAL-8 went from 2/3 to 3/3, the others stayed at 3/3.

## Limits

- One campaign of 3 trials per ticket, on 5 shared tickets, two days apart. The phase 1 duration did not change (p50 53.4 s, then 53.9 s).
- The turns and the cost fell together with the refusals, but this campaign cannot tell how much of it comes from the one-command test cycle and how much from the refusals.
- The verifier's turns are not in the report; only its refusals were counted, from the transcripts.
- The release decision asks for every ticket before a release.
