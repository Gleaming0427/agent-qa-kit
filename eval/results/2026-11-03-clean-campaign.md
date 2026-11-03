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

EVAL-11 to EVAL-16:
- **Transcripts** read for 18 of 18 trials.
- **Corpus exposure:** none. No tool call's input or result names the corpus.
- **Missing tools:** none. No call was answered "No such tool available".
- **Glob and Grep:** called 18 and 3 times, and all of them answered. The other phase 1 tool calls are Read 84, Bash 59, Write 36 and Edit 4.
- **Models:** the CLI reports `claude-sonnet-5-5` and `claude-haiku-5-5` in every trial. The kit asks for the `sonnet` alias for the writer and `haiku` for the verifier. Claude Code may also use the smaller model for its own background tasks, so the list does not say which phase each one served.
- **Guard refusals:** 20 in 18 sessions, 1.1 per trial (C: 2.3 on the same tickets). 18 are shell chaining or redirection, one in each trial; 2 are commands outside the allowlist.

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
