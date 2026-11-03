# Did the agents see the corpus? Recheck of every campaign, 3 November 2026

Every campaign in `results/` ran while the agent could see the corpus ([2026-11-03-glob-grep.md](2026-11-03-glob-grep.md#the-corpus-was-visible-to-the-agent)). This recheck reads all 272 recorded trials to find out what reached the agents, and whether any of them used it.

## Answer

- **In every trial before the fix, the session started with the corpus file names in its context.**
  - Claude Code adds the repository's git status to each new session.
  - In place, that git status listed the corpus moved out of `eval/tickets` as deleted files.
  - This concerns 224 of 224 trials, in all eleven runs before the fix.
- **What was visible:** file names only, never their content.
  - The list is truncated at 2,000 characters: 43 of the corpus files, in alphabetical order.
  - Bug files are named after the bug. With the corpus of 16 tickets (campaigns A, B, C and D), the list showed:
    - the bug names of EVAL-1, EVAL-10 and EVAL-11 to EVAL-15;
    - one of the two bug names of EVAL-16;
    - for example `../../eval/tickets/EVAL-11/bugs/updates-first-line.diff`.
  - With the corpus of 10 tickets (the two pilots), it showed the bug names of EVAL-1 to EVAL-6, EVAL-10, and one of EVAL-7. This list was read in a trial of the second pilot.
  - The reference implementations, the bug diffs and the hidden tests themselves were never shown: no tool call's result contains them.
- **One agent acted on it, and was stopped.**
  - In C's regression check, EVAL-9-2 ran `grep -ril "loyal" src e2e ../../eval/tickets/EVAL-9 2>/dev/null | head`.
  - The guard refused it ("Shell chaining/redirection/escaping forbidden"). That trial then answered `blocked`, the right answer, and wrote no test.
  - No other tool call in the 272 trials names the corpus.
- **After the fix, none:** 0 of the 48 trials of the clean campaign have the corpus in their context or in a tool call.

## How it was checked

- **The workflow's new `recheck` input:**
  - QA eval downloads each earlier run's trial artifacts and aggregates them again with the current code;
  - the aggregator reads each trial's transcripts and the CLI's results;
  - nothing from the artifacts is run.
- **Two passes:**
  - Workflow run 41614512910 checked tool calls only. It found the EVAL-9-2 command. Its transcript showed how the agent knew that path: the git status in the session's context.
  - The check was extended to the session's own context: attachments such as that git status, system events and the request. API request copies and the agent's own words do not count.
  - Workflow run 41615412529 checked all thirteen runs again.

| Campaign | Run | Trials | Corpus in the context | Tool call naming the corpus | Glob or Grep answered "No such tool available" |
|---|---|---|---|---|---|
| Pilot | 41494361776 | 30 | 30 | 0 | 23 calls |
| Pilot 2, control trial | 41510675823 | 1 | 1 | 0 | 1 call |
| Pilot 2 | 41511327155 | 30 | 30 | 0 | 25 calls |
| A | 41529883599 | 18 | 18 | 0 | 15 calls |
| B | 41529927864 | 18 | 18 | 0 | 14 calls |
| B, regression check | 41531765991 | 30 (12 ran) | 30 | 0 | 10 calls |
| C | 41539064574 | 18 | 18 | 0 | 24 calls |
| C, regression check | 41539102400 | 30 | 30 | 1 (refused) | 38 calls |
| D, control trial | 41596586107 | 1 | 1 | 0 | none |
| D | 41597047860 | 18 | 18 | 0 | none |
| D, regression check | 41597084921 | 30 | 30 | 0 | none |
| D, clean | 41605000003 | 18 | 0 | 0 | none |
| D, clean regression check | 41605005317 | 30 | 0 | 0 | none |

- In B's regression check, the spend limit stopped 18 of the 30 trials after their session had started: their transcripts exist, with the git status, but no model answered.
- **The missing-tools column** repeats, without anyone reading a transcript, what the writer report found by hand: Glob and Grep were missing from every session until D.

## Did the names raise the scores?

Nothing in the data says they did.

- **D against D clean.** These are the same version, measured with the names in context and without them:
  - new tickets: 36/36 bugs and 36/36 bugs; 17/18 successes and 18/18;
  - EVAL-1 to EVAL-10: 50/51 bugs and 50/51.
- **The pilots and A missed bugs whose names were in front of them:**
  - the pilots missed "removes the first line" (EVAL-2) and "discount includes shipping" (EVAL-1) in most trials, with `removes-first-line.diff` and `discount-includes-shipping.diff` in the context;
  - A missed "sets the first line's quantity" (EVAL-11) in 3 of 3 trials, with `updates-first-line.diff` in the context.
- **B and C** improved on A with the same names in the context of both arms. Their gain comes from the change in the writer's prompt, not from the names. Whether the new rules made the writer use the names more cannot be ruled out from their campaigns alone. D, clean, reaches the same detection without them.

## Models

The CLI reports `claude-sonnet-5-5` for the writer and `claude-haiku-5-5` for the verifier in every campaign, from the first pilot on. The model behind each alias did not change between the arms that were compared. The writer report's caveat on this point no longer applies.

## Limits

- **Subagents of the first pilot:** they were not kept then. Their 6 sessions are not checked; their main sessions are.
- **The verifier's sessions** before #18 were not kept: phase 2 is not checked in these campaigns. It only runs the approved tests and cannot change them.
- **How the names were used:** the check finds the names in the context and in tool calls. Whether a trial's tests were shaped by a name it read, a script cannot tell. The comparisons above suggest no measurable effect, on these samples.
