# State of the work on the kit

A working file for long tasks on the kit, by a person or an agent. Read it at the start of a session and update it at the end: what the work is for, what was decided and why, what changed, what comes next. It records facts with their pull request or file. The reasons in full are in the changelog, `SECURITY.md` and `eval/results/`.

**As of 17 November 2026.** `main` is at `c560781`: v0.3.2 (tagged), with #55 to #64. The agents of `main` are those of `8ff5e3d` (#61), measured by QA eval run 58, the release baseline: #62 to #64 changed no file the agents see. The fixes of the security review of 13 November are on `claude/magical-feynman-bhdsbc`. Their first smoke run (59) found that a read-only `.git` stopped the agents' sandbox on a runner; fixed on the branch, and measured by smoke run 60 and its follow-up run 61: release decision "review", EVAL-8 4/6 against 3/3, both failures from tests that expect two Checkout buttons. The pull request is #65.

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
| #62 | This state file after #61 | merged |
| #63 | QA eval run 58 in the history, and the release baseline changed to it | merged |
| #64 | v0.3.2: the changelog's entries under a v0.3.2 heading, the version, and the gaps found on 13 November in `SECURITY.md` | merged, tagged `v0.3.2` |
| #65 | The fixes of the security review of 13 November: git refused to the writer and the verifier by the guard, the git folder's entries read-only and the home folder's credential files unreadable in the sandbox, no git hook in the publish steps of QA write tests and QA amend tests, no token on disk in `qa-guard.yml` | open, on `claude/magical-feynman-bhdsbc`; smoke run 59 failed, runs 60 and 61 in `eval/history` (below); release decision "review" |

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

Every ticket on `main`, on 13 November ($4.34; in `eval/history` with #63; `eval/results/2026-11-13-every-ticket.md`):

| Run | Agents (commit) | Tickets | Result |
|---|---|---|---|
| 58 | `8ff5e3d`, the agents of runs 56 and 57 | all 17 × 3 | 50/51, 96/96 bugs; one trial of EVAL-13 with a test failing on the correct code (the cart line expected to show its discounted amount, which the ticket does not ask for); verifier 47, 48 and 48 of 48, no API error and no invalid verdict in 96 sessions; its own release decision "review", against "D clean" |

QA eval runs on the branch of the security fixes, on 17 November ($3.28 in all; runs 60 and 61 are in `eval/history`):

| Run | Agents (commit) | Tickets | Result |
|---|---|---|---|
| 59 | `2006cf3`, the first commit of the security fixes | EVAL-1, 2, 8, 9, 10, 13 × 3 | 6/18 (only the ambiguous and the adversarial tickets); release decision "review" against run 58. In 15 of 15 trials that write tests, every Bash command failed: `bwrap: Can't create file at .../.git/config.lock: Read-only file system`. The writer's tests were right (54/54 fail-to-pass units, 27/27 bugs, no false positive) but it could not run them, and answered "blocked"; the verifier did not run. $1.49. |
| 60 | `b41f920`, the git folder's entries read-only instead | same | 17/18, 26/27 bugs; verifier pass on the correct implementation 14/15, fail on a bug 15/15; no API error, no sandbox error in the 18 trials. EVAL-8 trial 3: its browser test expects two Checkout buttons on the page (`toHaveCount(2)`), the reference has one. Release decision "review" against run 58: EVAL-8 unstable and worse (3/3 → 2/3); it suggests EVAL-8 × 3 again. $1.46. |
| 61 | `01b390f`, the agents of run 60 (history and documentation added) | EVAL-8 × 3 | 2/3, 5/6 bugs; trial 2 failed for the same reason (two Checkout buttons expected). In runs 60 and 61, every EVAL-8 writer read the same files and ran one command; in runs 56 and 58 they made the same number of tool calls (5 Read, 1 Glob, 2 Write, 1 Bash; one more Edit in trial 2 of run 58). Runs 60 and 61 together against run 58: 19/21 against 17/18; EVAL-8 4/6 against 3/3, 10/12 bugs against 6/6; decision "review", which now asks a person: one follow-up per ticket. $0.33. |

## Decisions, and why

- **Artifacts, not conversations.** Each agent runs in a new `claude -p` session. Between steps, only files pass: the criteria, the tests, the verdicts, the review and its receipt, and the failure summary for repairs. The verifier does not read the writer's explanations. Since #56, the agents can no longer start sub-agents.
- **What a session reads (#56, #58):** `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools` from the agent's `tools:` line, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, all set by `kit_session_args` in `qa/kit-integrity.sh`. Only one alternative is accepted: `QA_SETTING_SOURCES=user`, for a login set in `~/.claude`. These were measured with a stand-in for the API that recorded what was sent, then in QA eval.
- **#56 kept after a human review.** Runs 49 and 51 against run 50:
  - trials successful: 22/24 against 17/18;
  - cost per trial −10.5%, tokens per trial −38%;
  - EVAL-8 and EVAL-15 are 5/6 against 3/3. Their two failures are tests written too strictly, a kind EVAL-8 already had before the change.

  The policy allows one follow-up per ticket, then asks a person (`eval/results/2026-11-12-session-surface.md`).
- **An evaluation for every change of the agents' surface (#55).** The surface is the prompts, the models, the effort, the tools, the settings, the hooks, `qa/run-qa.sh`, `qa/kit-integrity.sh`, `qa/criteria-manifest.ts` and the Claude Code version. The label `qa-eval-waived` is for a change that only removes unused context from the agents (used once, #58). A prompt change always gets an evaluation.
- **The release baseline is run 58 (#63, the owner's decision of 16 November).** "D clean" could not be compared with any campaign since the demo shop changed in #50 and the scoring code in #55: every campaign from run 49 to run 58 got the decision "review" for that reason, which QA eval required lets through without saying that the baseline was met. With run 58 as the baseline, a smoke run is compared ticket by ticket: computed again with no model call, run 56 (the same agents) is accepted and run 49 (the agents before #61) is "review" (EVAL-8, EVAL-15 and one bug of EVAL-10 unstable and worse).
  - **The order:** `eval/README.md` says to change the baseline after a release. Here it changes before the tag of v0.3.2, on the version to be released, so that the next change of the agents (the security fixes below) is the first to be compared with a baseline.
  - Two tests named the campaigns of "D clean" where they meant the release baseline (`eval/tests/validate.test.ts`, `eval/tests/required.test.ts`). They now read the campaigns of `eval/release-baseline.json`, and pass with the old file and with the new one.
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
  - `eval/results/2026-11-13-every-ticket.md` (run 58, the baseline);
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

1. **The fixes of the security review of 13 November (#65):** the owner's decision on its "review". EVAL-8 is 4/6 on the branch (runs 60 and 61) against 9/9 with the agents of `main` (runs 56, 57 and 58); both failures are tests that expect two Checkout buttons. The writers' tool calls on EVAL-8 are the same in number in runs 56, 58, 60 and 61 (run 57 not looked at), and the changes do not touch the prompts; no cause in the change was found, and none is ruled out.
   - **How the review measured:** the kit's launcher (`qa/run-qa.sh`, phase 1) with Claude Code 2.1.303 against a stand-in for the API, as an unprivileged user on Linux, on 13 November and again on 17 November with the fixes. Nothing was billed. It is not a run on a GitHub-hosted runner.
   - **What held on 13 November:** the commands an agent starts could not write to the project's `qa/`, `.claude/` and `.github/`, to `.git/hooks`, `.git/config` or `package.json`; they had no API key and no network; they could not read the `.env` files, `~/.ssh` or `~/.aws`. Read and Write outside the project were refused, a path under `~` included. `npm test`, which the settings do not list, was refused. A file written in the project's copy of the kit stopped the launcher.
   - **"Permission mode forced to default"**, which every agent log prints: the transcript records the mode `default`. A command outside the allow list was refused ("This command requires approval"); a read-only one ran without an allow rule. The guard is what refuses the others.
   - **Fixed on the branch, measured on 17 November:** `git status` refused by the guard; the writes to `HEAD`, `info/attributes`, `.git/hooks` and `.git/config` refused (read-only file system) and `git add` failing; `~/.git-credentials`, `~/.netrc`, `~/.config/gh/hosts.yml` and the five other credential files unreadable; `npm run` still working with `~/.npmrc` unreadable. The hooks of the publish steps were checked by the tests of `qa/tests/ci-write-tests.test.ts` and `qa/tests/ci-amend.test.ts`, not on a runner.
   - **Why the first version failed on a runner (run 59):** it made the whole `.git` read-only. With `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, Claude Code 2.1.303 also refuses writes to paths of its own in `.git`, some of which do not exist (`.git/config.lock`). It skips those under a folder already read-only, unless it cannot work out the read rules: when a path it refuses to read cannot be resolved for another reason than its absence. Then bubblewrap must create them, and cannot in a read-only `.git`. Reproduced on the bench by making `/run/containerd` (Claude Code refuses to read `/run/containerd/containerd.sock`) unreadable to the job's user, as it presumably is on a GitHub-hosted runner (not checked there). The fix makes each entry of the git folder read-only instead: on the bench, in that condition, the commands start, the writes above are refused, git's read commands work; a new file directly in `.git` can still be created.
   - **Still open** (`SECURITY.md`, known gaps): writes to `node_modules/` and to files such as `.gitattributes`, `.husky/` or `CLAUDE.md`; a new file directly in `.git`; reads of the rest of the home folder.
   - **Not concluded:** writes outside the project (the test folders were under `/tmp`, which the sandbox allows); which rule kept a `.env` out of a Grep (it was also in `.gitignore`).
   - **Not reviewed:** the installer (`bin/agent-qa-kit.mjs`), `qa/ci-verify.sh`, `qa/ci-amend-tests.sh` apart from the hooks of its publish step, the isolation of the evaluation, the repair agent's settings, phase 2. `npm audit` was not run again.
2. **Writer tests that assume markup or a display the ticket does not give**, seen three times since 12 November: run 49, EVAL-15 trial 2 (a list counted where a message replaces it); run 58, EVAL-13 trial 2 (the cart line expected to show its discounted amount); runs 60 and 61, EVAL-8 trials 3 and 2 (two Checkout buttons expected on the page). One trial in 51 in run 58, two in 21 in runs 60 and 61. No rule or check was written for it.
3. **`--exclude-dynamic-system-prompt-sections`.** It moves the working directory, the environment and the git status from the system prompt into the first message, so that the system prompt is the same in every project folder (measured). The cache gain is small; it needs an evaluation.
4. **Context in the eval report.** Add the first-call and peak context per session, measured from the transcripts. No credit needed. Measured by hand on 12 November: writer peak about 20,000 tokens, verifier about 14,000.
5. **The repair loop on a real runner.** It has never run there. After that, consider a repair log passed from one attempt to the next: the failing criteria, the files changed, the result.
6. **Known gaps of `SECURITY.md`:**
   - GitHub Actions pinned by tag, not by SHA;
   - the install scripts of `npm ci`;
   - install steps that wait ten minutes when the runner's network fails;
   - measurements on new tickets and other applications.

**For the owner:** delete the branches of merged or closed pull requests: `claude/confident-brown-bn2ttv` (#55), `claude/session-surface` (#56), `claude/eval-reference` (#57), `claude/no-auto-memory` (#58), `claude/verifier-one-command` (#61), `claude/keep-approval-reasons` (#53, #54) and `feat/TICKET-44` (the trial of #49, closed). `claude/magical-feynman-bhdsbc` held #64 and now holds the security fixes: delete it once their pull request is merged.

## How to update this file

At the end of a working session:
- move what was done into "Where things stand";
- add each decision, with its reason and its pull request;
- keep "Next steps" in order, and remove what is done or dropped.

Facts only, short. The details belong in the changelog, `SECURITY.md` or `eval/results/`.
