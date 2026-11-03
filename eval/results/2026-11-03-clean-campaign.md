# Clean campaign after the corpus fix, 3 November 2026

Version D measured again, once the agent could no longer see the corpus ([2026-11-03-glob-grep.md](2026-11-03-glob-grep.md#the-corpus-was-visible-to-the-agent)). This is the first campaign whose report checks the transcripts itself.

## What changed since D's campaigns

- **The agents' environment:**
  - the workspace has a git repository of its own, so `git status` and `git diff` no longer show the corpus;
  - the guard refuses Glob patterns outside the project.
- **Unchanged:** the writer's and the verifier's prompts, models, effort, hooks and settings.
- **The harness:** each trial now checks the tool calls of its phase 1 transcripts, and records the models that served it.

| Tickets | Workflow run | Commit |
|---|---|---|
| EVAL-11 to EVAL-16, 3 trials each | 41605000003 | `15a1dd3` |
| EVAL-1 to EVAL-10, 3 trials each | 41605005317 | `15a1dd3` |

Same configuration as before: phases 1 and 2, 6 trials at a time, Claude Code 2.1.303. The figures are the workflow's own report, which the report job prints in its log.

## Checks from the transcripts

| Check | EVAL-11 to EVAL-16 | EVAL-1 to EVAL-10 |
|---|---|---|
| Transcripts read | 18 of 18 trials | 30 of 30 trials |
| Corpus exposure (a tool call's input or result names the corpus) | none | none |
| Missing tools (a call answered "No such tool available") | none | none |
| Glob calls, Grep calls | 18, 3 | 30, 11 |
| Other phase 1 tool calls | Read 84, Bash 59, Write 36, Edit 4 | Read 126, Bash 82, Write 54, Edit 1 |
| Guard refusals per trial | 1.1 (C: 2.3) | 1.0 |

- **Glob and Grep:** every call answered. The fix of #17 works in CI.
- **Guard refusals:**
  - EVAL-11 to EVAL-16: 18 are shell chaining or redirection, one in each trial, and 2 are commands outside the allowlist.
  - EVAL-1 to EVAL-10: 27 are shell chaining or redirection, and 2 are an edit of the project root.
- **Models:** the CLI reports `claude-sonnet-5-5` in all 48 trials and `claude-haiku-5-5` in the 45 that have a phase 2. The 3 EVAL-9 trials stop after phase 1 and report no Haiku model. So the writer's `sonnet` alias served `claude-sonnet-5-5`, and the verifier's `haiku` alias served `claude-haiku-5-5`.

## Results on the new tickets

| Metric | A, as it was | C (`main` before #17) | D, from the job logs | D, clean |
|---|---|---|---|---|
| Injected bugs detected | 26/36 | 36/36 | 36/36 | 36/36, 100% (90.4–100%) |
| Trial success | 8/18 | 17/18 | 17/18 | 18/18, 100% (82.4–100%) |
| Trials with a false positive | 4/18 | 1/18 | 1/18 | 0/18 |
| Valid RED | 18/18 | 18/18 | 18/18 | 18/18 |
| No file other than tests changed | 18/18 | 18/18 | 18/18 | 18/18 |
| Verifier: pass on the correct implementation | n/a | n/a | 17/18 | 18/18 |
| Verifier: fail on a buggy implementation | n/a | n/a | 18/18 | 18/18 |
| Guard refusals per trial | 4.2 | 2.3 | not read | 1.1 |
| Cost per trial | $0.1345 | $0.1431 | $0.1156 | $0.1180 |

- Fail-to-pass is 72 of 72 criterion × level units, and no test is flaky over 3 runs on the reference.
- pass^3 is 100%.
- Phase 1 takes 50.1 s at the median, 89.5 s at p95, and 12 turns at the median.

| Ticket | Trials | Successes | Fail-to-pass | Bugs detected | Trials with false positives | Mean cost |
|---|---|---|---|---|---|---|
| EVAL-11 | 3 | 3 | 12/12 | 6/6 | 0 | $0.1266 |
| EVAL-12 | 3 | 3 | 12/12 | 6/6 | 0 | $0.1377 |
| EVAL-13 | 3 | 3 | 12/12 | 6/6 | 0 | $0.1193 |
| EVAL-14 | 3 | 3 | 12/12 | 6/6 | 0 | $0.1235 |
| EVAL-15 | 3 | 3 | 12/12 | 6/6 | 0 | $0.1030 |
| EVAL-16 | 3 | 3 | 12/12 | 6/6 | 0 | $0.0976 |

## Results on EVAL-1 to EVAL-10

| Metric | 60 pilot trials (95% interval) | C | D, from the job logs | D, clean |
|---|---|---|---|---|
| Trial success | 45/60, 75.0% (62.8–84.2%) | 27/30 | 29/30 | 27/30, 90.0% (74.4–96.5%) |
| Injected bugs detected | 91/102, 89.2% (81.7–93.9%) | 47/51 | 50/51 | 50/51, 98.0% (89.7–99.7%) |
| No false positive | 50/54, 92.6% (82.4–97.1%) | 25/27 | 27/27 | 25/27, 92.6% (76.6–97.9%) |
| Valid RED | 54/54 | 27/27 | 27/27 | 27/27 |
| No file other than tests changed | 60/60 | 30/30 | 30/30 | 30/30 |
| No invented tests on EVAL-9 | 6/6 | 3/3 | 3/3 | 3/3 |
| Cost per trial | $0.121 | $0.118 | $0.1029 | $0.0996 |

- **Verifier:**
  - it passed the reference implementation in 25 of 27 runs, and failed the bug in 25 of 27;
  - its verdict matched what the approved tests show in 26 of 27 runs.
  - Two trials have a test that fails on the reference, and with such tests a faithful verifier fails the reference too. Whether these are the same two runs, and which run is the unfaithful one, the scores alone do not say.
- **Reliability:** pass@3 100%, pass^3 80.0%.
- **Phase 1:** 42.9 s at the median, 60.6 s at p95, 12 turns at the median.

| Ticket | Kind | Trials | Successes | Fail-to-pass | Bugs detected | Trials with false positives | Mean cost |
|---|---|---|---|---|---|---|---|
| EVAL-1 | feature | 3 | 1 | 12/12 | 5/6 | 1 | $0.1157 |
| EVAL-2 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.1089 |
| EVAL-3 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.1039 |
| EVAL-4 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.0980 |
| EVAL-5 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.1106 |
| EVAL-6 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.0966 |
| EVAL-7 | feature | 3 | 3 | 12/12 | 6/6 | 0 | $0.1159 |
| EVAL-8 | feature | 3 | 2 | 10/12 | 6/6 | 1 | $0.1227 |
| EVAL-9 | ambiguous | 3 | 3 | 0/6 | 0/0 | 0 | $0.0383 |
| EVAL-10 | adversarial | 3 | 3 | 6/6 | 3/3 | 0 | $0.0849 |

The three failed trials are on tickets that failed before:
- EVAL-1 twice: one missed bug, and one false positive;
- EVAL-8 once: a false positive.

Their causes are in the transcripts, which were not read for this report.

## Decision under the rule

The rule of the writer report, with C as the reference.

| Condition | Reference C | D, clean |
|---|---|---|
| Bug detection ≥ reference | 36/36 | met: 36/36 |
| False positives ≤ reference + 1 trial | 1/18 | met: 0/18 |
| Policy 100% | 18/18 | met: 18/18 and 30/30 |
| Valid RED 100% | 18/18 | met: 18/18 and 27/27 |
| No regression on EVAL-1 to EVAL-10 | pilot intervals | met: success 90.0% and detection 98.0%, above them; no false positive 92.6%, inside |
| Cost +30% at most | $0.1431 | met: $0.1180, −17.5% |

**D, clean, meets every condition of the rule.** It confirms D's campaign, measured before the fix.

## What this says about the corpus exposure

- **For this version:** no trial saw the corpus, and the scores are in line with D's campaign, which could have.
  - On the new tickets, the clean campaign does as well or better: 18/18 successes against 17/18.
  - On EVAL-1 to EVAL-10 it does slightly worse: 27/30 against 29/30, and 2 trials with a false positive against 0. These gaps are within the intervals.
  - If D's trials saw the corpus, it did not raise their scores in a way these samples can show.
- **For the earlier campaigns** (the pilots, A, B and C), it says nothing. They had no Glob, and their writer read files differently. Whether any of them ran `git status` or `git diff` still needs their artifacts: see [How to check a past campaign](2026-11-03-glob-grep.md#the-corpus-was-visible-to-the-agent).
- **The reference arms A and C** were measured under the same exposure. The decision above compares D, clean, with them as recorded.

## Limits

- 16 tickets × 3 trials. The new tickets have been used to measure B, C and D: they are no longer held out, and the clean campaign's 100% there shows that they no longer separate versions.
- The model behind each alias is now recorded: `claude-sonnet-5-5` and `claude-haiku-5-5`. The earlier campaigns did not record it.
- The approval before phase 2 is scripted.
