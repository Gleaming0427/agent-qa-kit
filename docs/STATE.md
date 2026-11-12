# State of the work on the kit

A working file for long tasks on the kit, by a person or an agent. Read it at the start of a session and update it at the end: what the work is for, what was decided and why, what changed, what comes next. It records facts with their pull request or file. The reasons in full are in the changelog, `SECURITY.md` and `eval/results/`.

**As of 12 November 2026.** `main` is at `30ae345`: v0.3.1 (tagged) and #55 to #58, which the changelog lists under "Unreleased".

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

Evaluation campaigns added to `eval/history` on 12 November ($3.42 in all):

| Run | Agents | Tickets | Result |
|---|---|---|---|
| 49 | #56 | EVAL-1, 4, 8, 9, 10, 15 × 3 | 16/18; release decision "review": no ticket comparable with the baseline |
| 50 | `main` before #56 (reference) | same | 17/18 |
| 51 | #56, follow-up | EVAL-8, EVAL-15 × 3 | 6/6 |

## Decisions, and why

- **Artifacts, not conversations.** Each agent runs in a new `claude -p` session. Between steps, only files pass: the criteria, the tests, the verdicts, the review and its receipt, and the failure summary for repairs. The verifier does not read the writer's explanations. Since #56, the agents can no longer start sub-agents.
- **What a session reads (#56, #58):** `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools` from the agent's `tools:` line, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, all set by `kit_session_args` in `qa/kit-integrity.sh`. Only one alternative is accepted: `QA_SETTING_SOURCES=user`, for a login set in `~/.claude`. These were measured with a stand-in for the API that recorded what was sent, then in QA eval.
- **#56 kept after a human review.** Runs 49 and 51 against run 50:
  - trials successful: 22/24 against 17/18;
  - cost per trial −10.5%, tokens per trial −38%;
  - EVAL-8 and EVAL-15 are 5/6 against 3/3. Their two failures are tests written too strictly, a kind EVAL-8 already had before the change.

  The policy allows one follow-up per ticket, then asks a person (`eval/results/2026-11-12-session-surface.md`).
- **An evaluation for every change of the agents' surface (#55).** The surface is the prompts, the models, the effort, the tools, the settings, the hooks, `qa/run-qa.sh`, `qa/kit-integrity.sh`, `qa/criteria-manifest.ts` and the Claude Code version. The label `qa-eval-waived` is for a change that only removes unused context from the agents (used once, #58). A prompt change always gets an evaluation.
- **The release baseline stays "D clean" for now.** No new campaign is comparable with it, since the demo shop changed in #50 and the scoring code in #55. It is replaced only after a full run.
- **Not done, on purpose:**
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

1. **Verifier through the test summary.** Its prompt runs `npm run test:affected` first, so the raw Vitest output enters its context: up to Claude Code's 30,000-character cap on a large application. It should run `npm run test:summary -- --run @<mfe>`, as the writer does. This is a prompt change, so it needs a smoke evaluation (about $1.30).
2. **A new release baseline.** A full QA eval on `main` (every ticket, 3 trials, about $6), then `eval/release-baseline.json` in a reviewed pull request. Then the next release (v0.3.2), with the "Unreleased" entries.
3. **`--exclude-dynamic-system-prompt-sections`.** It moves the working directory, the environment and the git status from the system prompt into the first message, so that the system prompt is the same in every project folder (measured). The cache gain is small; it needs an evaluation.
4. **Context in the eval report.** Add the first-call and peak context per session, measured from the transcripts. No credit needed. Measured by hand on 12 November: writer peak about 20,000 tokens, verifier about 14,000.
5. **The repair loop on a real runner.** It has never run there. After that, consider a repair log passed from one attempt to the next: the failing criteria, the files changed, the result.
6. **"Permission mode forced to default".** Claude Code prints this when `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set, so the agents may not run in `dontAsk` as the launchers ask. Check what this changes, with `--allowedTools`.
7. **Known gaps of `SECURITY.md`:**
   - GitHub Actions pinned by tag, not by SHA;
   - the install scripts of `npm ci`;
   - install steps that wait ten minutes when the runner's network fails;
   - measurements on new tickets and other applications.

**For the owner:** delete the branches of merged or closed pull requests: `claude/confident-brown-bn2ttv` (#55), `claude/session-surface` (#56), `claude/eval-reference` (#57), `claude/no-auto-memory` (#58), `claude/keep-approval-reasons` (#53, #54) and `feat/TICKET-44` (the trial of #49, closed). `claude/magical-feynman-bhdsbc` is not in `main`'s history: check before deleting it.

## How to update this file

At the end of a working session:
- move what was done into "Where things stand";
- add each decision, with its reason and its pull request;
- keep "Next steps" in order, and remove what is done or dropped.

Facts only, short. The details belong in the changelog, `SECURITY.md` or `eval/results/`.
