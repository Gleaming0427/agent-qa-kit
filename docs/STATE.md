# State of the work on the kit

A working file for long tasks on the kit, by a person or an agent. Read it at the start of a session and update it at the end: what the work is for, what was decided and why, what changed, what comes next. It records facts with their pull request or file. The reasons in full are in the changelog, `SECURITY.md` and `eval/results/`.

**As of 13 November 2026.** `main` is at `8ff5e3d`: v0.3.1 (tagged) and #55 to #61. The changelog lists their changes of the agents and of the evaluation under "Unreleased".

## Objectives

1. **The agents cannot cheat, and cannot be steered by what they read.** Every check that judges an agent runs outside its reach. The security review's five gaps are closed (v0.3.1).
2. **Every change of what the agents see or can do is measured before it is merged**, against a reference measured on the same application and scoring code, with deterministic graders.
3. **The agents' context holds only what the kit puts there**, kept small: the tools of their role, the kit's prompt, the request, and short tool outputs.

## Where things stand

| Pull request | What | State |
|---|---|---|
| #46 to #53 | Security review, first runs on a real runner, v0.3.1 | merged, tagged `v0.3.1` |
| #54 | Session options (first attempt) | closed: its checks were stuck in a GitHub Actions outage; replaced by #56 |
| #55 | QA eval required on pull requests; cost per success in the eval report | merged |
| #56 | Agents start without the project's configuration, with the tools of their file only | merged after a smoke evaluation and its reference |
| #57 | Reference run of `main` before #56, comparison, follow-up | merged |
| #58 | No Claude Code auto memory for the agents | merged with the label `qa-eval-waived` |
| #59 | This state file | merged |
| #60 | `CLAUDE.md`, for the sessions that develop the kit | merged |
| #61 | The verifier runs one test command, with three tools; and, found by its evaluation, `✓` lines in the verifier's summary, a writer rule against a word bound after a text, and a writer rule on expected amounts | merged after a smoke evaluation of its final version (runs 56 and 57): release decision "review" |

Evaluation campaigns added to `eval/history` on 12 November ($3.42 in all):

| Run | Agents | Tickets | Result |
|---|---|---|---|
| 49 | #56 | EVAL-1, 4, 8, 9, 10, 15 × 3 | 16/18; release decision "review": no ticket comparable with the baseline |
| 50 | `main` before #56 (reference) | same | 17/18 |
| 51 | #56, follow-up | EVAL-8, EVAL-15 × 3 | 6/6 |

QA eval runs on the branch of #61, on 12 and 13 November ($7.82 in all; only run 56 is in `eval/history`). Six tickets each, 3 trials, with phase 2. Verifier: right verdict on the correct implementation, on a buggy one, and matching the approved tests, out of 15.

| Run | Agents (commit) | Tickets | Result |
|---|---|---|---|
| 52 | `80e14ec`, the first commit | EVAL-1, 4, 8, 9, 10, 15 | writer 18/18; verifier not measured: the API credit ran out, the 30 sessions ended on "Credit balance is too low" |
| 53 | `80e14ec` | EVAL-1, 5, 8, 9, 10, 15 | 18/18; verifier 14, 13 and 12 of 15, with 2 verdicts invalid (the summary listed only the failed tests); EVAL-10: one test failing on the correct code |
| 54 | `012193d`, with the `✓` lines | same as run 53 | 18/18; verifier 15, 15, 15 |
| 55 | `13073eb`, with the writer rule on word bounds | same | 16/18; 2 EVAL-8 trials with a wrong expected amount |
| 56 | `ecd4abf`, with the writer rule on amounts | same | 18/18, 27/27 bugs; verifier 15, 15, 15; in `eval/history` |
| 57 | `bb5ef36`, the agents of run 56 | EVAL-1, 6, 8, 9, 10, 15 | 18/18, 27/27 bugs; verifier 15, 15, 15 |

## Decisions, and why

- **Artifacts, not conversations.** Each agent runs in a new `claude -p` session. Between steps, only files pass: the criteria, the tests, the verdicts, the review and its receipt, and the failure summary for repairs. The verifier does not read the writer's explanations. Since #56, the agents can no longer start sub-agents.
- **What a session reads (#56, #58):** `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools` from the agent's `tools:` line, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, all set by `kit_session_args` in `qa/kit-integrity.sh`. Only one alternative is accepted: `QA_SETTING_SOURCES=user`, for a login set in `~/.claude`. These were measured with a stand-in for the API that recorded what was sent, then in QA eval.
- **#56 kept after a human review.** Runs 49 and 51 against run 50:
  - trials successful: 22/24 against 17/18;
  - cost per trial −10.5%, tokens per trial −38%;
  - EVAL-8 and EVAL-15 are 5/6 against 3/3. Their two failures are tests written too strictly, a kind EVAL-8 already had before the change.

  The policy allows one follow-up per ticket, then asks a person (`eval/results/2026-11-12-session-surface.md`).
- **An evaluation for every change of the agents' surface (#55).** The surface is the prompts, the models, the effort, the tools, the settings, the hooks, `qa/run-qa.sh`, `qa/kit-integrity.sh`, `qa/criteria-manifest.ts` and the Claude Code version. The label `qa-eval-waived` is for a change that only removes unused context from the agents (used once, #58). A prompt change always gets an evaluation.
- **The release baseline stays "D clean" for now.** No new campaign is comparable with it, since the demo shop changed in #50 and the scoring code in #55. It is replaced only after a full run. Until then, each campaign gets the decision "review" (runs 49 to 57), which QA eval required lets through: it does not say that the baseline was met.
- **#61 merged on the measures of its final version.** Its evaluation found two defects of its own, fixed on the branch: the verifier's summary listed only the failed tests, so the verifier had no evidence for the other criteria (2 invalid verdicts of 15, run 53; `✓` lines added); and two causes of writer false positives (next bullet). Runs 56 and 57, on the final agents: 36 of 36 trials successful, 54 of 54 injected bugs detected, the verifier right in 30 of 30 trials, no test failing on the correct code. A small sample: 3 trials per ticket, and 7 tickets of 17 (EVAL-1, 5, 6, 8, 9, 10, 15).
- **Two causes of writer false positives, found on the way.**
  - A word bound after a text in a text matcher (`toHaveTextContent(/(?<!\d)4 products(?!\w)/)`; EVAL-10, 3 of 12 trials in runs 49, 50, 52 and 53): the text of a section joins its elements without a space (`4 productsNotebook`). Writer prompt rule 6 and a phase 1 check (`textBoundProblem`).
  - A wrong expected amount (EVAL-8: shipping left out of the order total, or a total kept after the cart changed; 2 of 3 trials in run 55, one in run 49). Writer prompt rule 7, with no check.
- **Not done, on purpose:**
  - a check of the amounts a test asserts against the arithmetic of the coverage: run offline on runs 53 to 55, it flagged 19 of 45 trials, almost all correct, and did not separate the two failing ones;
  - replacing Claude Code's system prompt (`--system-prompt`): it carries the tool-use instructions;
  - a `CODEOWNERS` file: with one owner, a required code-owner review would block the owner's own pull requests;
  - a lower `Read` cap: not without a measurement, since it adds turns.
- **Working rules.** Commits are signed Gleaming, with no co-author. Ask before spending API credit, opening or merging a pull request, or deleting anything. The owner merges, tags and deletes branches.

## Files that hold the state

- **The evaluation:**
  - `eval/history/` (campaigns, sources, `index.json`);
  - `eval/results/2026-11-12-session-surface.md`;
  - `eval/release-baseline.json`;
  - `eval/compare-policy.json` (the rules of the release decision).
- **A ticket in a project:**
  - `reports/<TICKET>-criteria.json`;
  - the review package, the decision and its receipt (`qa/scenario-review.ts`);
  - `reports/<TICKET>-phase1.json` and `-phase2.json`;
  - `reports/<TICKET>-repair<N>.json`;
  - the `qa/<TICKET>` and `feat/<TICKET>` branches and their pull request.
- **The session options:** `qa/kit-integrity.sh` (`kit_session_args`), used by `qa/run-qa.sh` and `qa/repair-loop.sh`.

## Next steps, in order

1. **A new release baseline, and v0.3.2.** Run 58: QA eval on `main` (`8ff5e3d`), every ticket, 3 trials, started on 13 November at 13:13 UTC (cost cap $8). Its result is not read yet. Then a human review of it; if it is accepted, release v0.3.2 with the "Unreleased" entries, and make that version the baseline (`eval/release-baseline.json`) with the campaign added to `eval/history`, in a reviewed pull request (`eval/README.md`: the baseline changes after a release).
2. **Writer false positives of a third kind**, seen once: run 49, EVAL-15 trial 2, a role `list` named `Products` assumed where a message replaces the list. Its frequency is not measured; run 58 covers every ticket.
3. **`--exclude-dynamic-system-prompt-sections`.** It moves the working directory, the environment and the git status from the system prompt into the first message, so that the system prompt is the same in every project folder (measured). The cache gain is small; it needs an evaluation.
4. **Context in the eval report.** Add the first-call and peak context per session, measured from the transcripts. No credit needed. Measured by hand on 12 November: writer peak about 20,000 tokens, verifier about 14,000.
5. **The repair loop on a real runner.** It has never run there. After that, consider a repair log passed from one attempt to the next: the failing criteria, the files changed, the result.
6. **"Permission mode forced to default".** Claude Code prints this when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set, so the agents may not run in `dontAsk` as the launchers ask. It is printed in every phase 1 and phase 2 log of runs 53 to 57 (240 of 240). Check what this changes, with `--allowedTools`.
7. **Known gaps of `SECURITY.md`:**
   - GitHub Actions pinned by tag, not by SHA;
   - the install scripts of `npm ci`;
   - install steps that wait ten minutes when the runner's network fails;
   - measurements on new tickets and other applications.

**For the owner:** delete the branches of merged or closed pull requests: `claude/confident-brown-bn2ttv` (#55), `claude/session-surface` (#56), `claude/eval-reference` (#57), `claude/no-auto-memory` (#58), `claude/verifier-one-command` (#61), `claude/keep-approval-reasons` (#53, #54) and `feat/TICKET-44` (the trial of #49, closed). `claude/magical-feynman-bhdsbc` is not in `main`'s history: check before deleting it.

## How to update this file

At the end of a working session:
- move what was done into "Where things stand";
- add each decision, with its reason and its pull request;
- keep "Next steps" in order, and remove what is done or dropped.

Facts only, short. The details belong in the changelog, `SECURITY.md` or `eval/results/`.
