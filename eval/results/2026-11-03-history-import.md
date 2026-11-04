# History of the campaigns, imported from the recheck, 3 November 2026

The 13 runs of `results/` are now one versioned file each, in `eval/history/campaigns`. They hold 272 trials. No model was called: the import reads the reports of a recheck, which scored every campaign again with the same code. See [history/README.md](../history/README.md) for the format.

> **Update, 4 November 2026:** the sources are now the reports of a second recheck.
> - **Run:** 41785127300, with the code of `efa197e`. The first recheck was run 41615412529, with the code of `c84386e`.
> - **Metrics:** identical in all 272 trials. Only the fields added since differ: tokens, isolation and time per runner.
> - **Tokens:** they are now known for 254 trials (see Missing data).
> - **Scorer:** the history now has the one that scores new campaigns, so `compat` no longer blocks a comparison between them. Run 41783970323, two trials on EVAL-1 and EVAL-11 with the split runners, compares with D clean on EVAL-11 and with D clean's regression check on EVAL-1. The same agent ran in all three; the harness and the number of trials per ticket differ, and `compat` warns about both.

## How it was checked

- **Sources.** The 13 `recheck-<run>.json` files come from that run's artifacts.
  - The zip of each one matches, byte for byte, the sha256 that GitHub records for its artifact.
  - Each file's own sha256 is in `sources.json`, and `build` checks it.
- **Metrics.** For each campaign, the history gives the source report's detected bugs, bugs, successes and total cost. Successes are counted before corrections. `eval/tests/history.test.ts` checks this for the 13 campaigns.
- **Published figures.** The test also finds again the successes and the detected bugs that `results/` publishes for the nine campaigns it reports in full: the second pilot, A, B, C, D and D clean, and the regression checks of C, D and D clean. The pilot's figures need a correction (below).
- **Reproducibility.** `node eval/history.ts build` rebuilds the 13 files from the sources and git, byte for byte.
- **Versions.** Each campaign's versions are read from git at its commit:
  - the agent: prompts, hooks, settings, kit scripts, models, Claude Code;
  - the corpus, ticket by ticket, and the shop;
  - the harness, and the scorer at the recheck's commit.

## The pilot's recheck did not match its report

The recheck of the pilot (run 41494361776) gives 0 successes and 0 trials within the policy, out of 30. Its document gives 23 successes and 30 within the policy.

- **Cause:** the pilot's records list the 15 empty files the agent sandbox creates at the project root as changes. The document removed them by hand (correction 1 of [2026-11-02-pilot.md](2026-11-02-pilot.md#corrections-applied-to-the-raw-report)), and the harness has set them aside since #12. The recheck scored the records as they are.
- **In the history:** the correction `sandbox-placeholders` is applied to the pilot only, and listed in its file.
  - It sets the policy as respected in the 30 trials, and success is recomputed with the scorer's own rule. That gives 23 of 30, as published.
  - Each of the 30 observations keeps its original values (`corrected.original`).
  - `compat` warns about the correction whenever the pilot is compared.
- **The other twelve campaigns** need no correction.

## What the versions show

Five distinct agents ran in these campaigns. The changes the history finds between them are the ones the documents describe:

| Agents | Campaigns | Changed from the previous agent |
|---|---|---|
| `3feacd29b806` | Pilot, Pilot 2, A | none: A is "the writer as it was" |
| `d067cc44ed83` | B, B regression check | writer prompt (rules 5 and 6) |
| `fbb68aa6e035` | C, C regression check | writer prompt (the Glob sentence) |
| `badfb419a6f8` | D, D regression check, D control trial | hooks and kit scripts (#16, and `--allowedTools` in `qa/run-qa.sh`) |
| `43cb10d883b4` | D clean, D clean regression check | hooks (the guard checks Glob patterns) |

- **Unchanged in all 13 campaigns:**
  - the shop;
  - the corpus of each ticket;
  - the writer's and the verifier's models and efforts (`sonnet`/`medium`, `haiku`/`low`);
  - Claude Code 2.1.303;
  - the served models, `claude-sonnet-5-5` and `claude-haiku-5-5`.
- **The harness changed twice:**
  - between the pilot and the second pilot (#12);
  - before D clean (its own git repository in the workspace).

  `compat` warns about both. The comparisons made in `results/` (A, B, C, D and D clean, and the pilots) pass the compatibility check, with these warnings.

## Missing data

- **Tokens:** known for 254 of the 272 trials since the second recheck. The aggregator reads them from the CLI results each artifact keeps. 118,743,142 tokens in all, cache reads included: 467,000 per trial on average.
  - The 18 without are trials of B's regression check that the spend limit stopped before any model answered. Their sessions have no token count.
  - The first recheck's code did not read them.
- **Workflow inputs:** not recorded by the reports. Whether phase 2 ran, the dry run and the trials per ticket are inferred from the trials. They agree with the documents.
- **The isolation check:** missing from all 272 trials. They ran before the agent and the scoring had separate runners.
- **Sight of the corpus:** 224 trials, every campaign before D clean, have the corpus file names in their context, as the recheck found. Each observation records it, and `compat` warns about it.
- **B's regression check:** 21 of its 30 trials ended with an agent or API error, when the spend limit stopped the campaign. They are marked `agent_error`.
- **Duration and turns:** missing for 1 trial of B, whose CLI result covered only its last turn.

## Limits

- The history records what the reports measured; it adds no measurement.
- The compatibility rules are a first version. They block a different scorer, application or role; they exclude tickets whose corpus changed; they warn about the rest. They do not judge whether a difference between two campaigns is significant.
