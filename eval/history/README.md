# Campaign history

Every evaluation campaign, as one versioned JSON file. It is built from a report of `eval/lib/aggregate.ts`, with no model call, and can be rebuilt at any time.

| Path | Role |
|---|---|
| `sources.json` | What to import. For each campaign: its run, commit, label and role; whether its scores are its own or recomputed; the corrections it needs; the source file, with its sha256 and the GitHub artifact it came from. |
| `sources/` | The source reports, as downloaded. GitHub deletes artifacts after 90 days; these copies keep the history rebuildable. |
| `campaigns/<id>.json` | One campaign, normalized and versioned (schema below). Written by `node eval/history.ts build`. |
| `index.json` | One line per campaign, for people. Written by the same command. |

```bash
node eval/history.ts build                  # rebuild campaigns/ and index.json from sources.json
node eval/history.ts check                  # schema, duplicates, missing data; exits 1 on an error
node eval/history.ts compat A "D, clean"    # can two campaigns be compared, and on which tickets?
node eval/history.ts rows C                 # one JSON line per trial and bug, for analysis elsewhere
```

`build` checks each source against its sha256, and reads the versions from git at the recorded commits. A rebuild changes no byte; `eval/tests/history.test.ts` checks this.

## A campaign file (schema `agent-qa-kit/eval-history-campaign`, version 1)

| Field | What it holds |
|---|---|
| `id`, `label`, `role` | `gh-<run id>`; the name used in `results/`; `campaign`, `control` (a trial run to check the harness, not part of any figure) or `dry-run`. Only campaigns are compared. |
| `source` | The GitHub Actions run: repository, run id and number, branch, start. |
| `agent` | The agent's version at the campaign's commit: the writer's and the verifier's prompts (git blobs), models and efforts; the hooks (git tree), the settings, a digest of `qa/` without the kit's own tests, and the Claude Code version. `id` is a digest of all of them: the same id means the same agent. |
| `environment` | The task's version: the git tree of each ticket's corpus folder, of the shop, and a digest of the harness that built the variants and ran the tests (`eval/trial.ts`, `workspace.ts`, `sandbox.ts`). |
| `config` | Tickets, how they were chosen (`selection`: `all`, `smoke`, a `list`, or `null` when the inputs were not recorded), trials, trials per ticket, verifier on or off, dry run. A report made before this history does not record the workflow's inputs: those values are inferred from the trials and listed in `inferred`. |
| `scoring` | `original` (the campaign's own report) or `recomputed` (its trial records scored again later), the commit and a digest of the scoring code (`score.ts`, `aggregate.ts`, `transcript.ts`), and the corrections applied. |
| `provenance` | The source file, its sha256, the artifact and its digest, and the document in `results/`. |
| `notes` | What the documents say about the campaign that the data does not show. |
| `missing` | Observations with a missing value, by field. |
| `observations` | One per trial. See below. |

An **observation** holds:
- `key` (`<TICKET>#<TRIAL>`), the ticket, its kind, the trial number and its start and finish;
- `status`: `ok`, or `agent_error` when the agent or the API failed. A spend limit, for instance, measures the infrastructure, not the agent;
- the served models;
- success, valid RED, policy, whether tests were written, invented tests on the ambiguous ticket;
- the number of false positives and flaky tests, fail-to-pass;
- each bug with its criterion, detection and attribution;
- the verifier's outcomes;
- cost, duration, turns, wall clock and tokens;
- guard refusals, whether the session saw the corpus, and traces of the corpus in the agent runner's output;
- `corrected`: the values before a correction, when one changed them;
- `fingerprint`: a digest of what identifies the run of a trial. The same trial imported in two campaigns is an error.

## Rules

- **A comparison needs the same scorer.**
  - Campaigns scored by different code are blocked: recheck both runs with the same code first.
  - The 13 imported campaigns were all scored by the recheck run 41785127300, with the code of `efa197e`. A campaign scored by later code needs a new recheck of these runs, with no model call, before it is compared with them.
- **A ticket compares only with the same corpus.** When its folder changed, the ticket is left out, and the others can still be compared.
- **Corrections are explicit.**
  - A correction is listed in `sources.json` and defined in `CORRECTIONS` (`eval/lib/history.ts`), with its reason and the document that found it.
  - Each observation it changes keeps its original values, and `compat` warns about it.
- **Nothing is inferred silently.** Inferred inputs, missing values, agent errors and corpus exposure are reported by `check` and `compat`.
- **Statistics stay out of this file.** The history records measurements. Comparisons and decisions belong to the tools that read it.

## Adding a campaign

Every campaign comes from a source, so that `build` can rebuild it. `build` refuses to delete a file of `campaigns/` that has no entry in `sources.json`, and `check` reports one as an error.

To add a campaign:
1. Add its report to `sources/`:
   - for a QA eval run, its `eval-report.json`, as `eval-report-<run id>.json`;
   - for a recheck, its `recheck-<run>.json`.
2. Add an entry to `sources.json`: the run, its commit, a label and role, the scoring, the source with its sha256 and artifact, and, for a QA eval run, the inputs of its dispatch.
3. Run `node eval/history.ts build`.

The report job of a QA eval run also writes `eval-history.json` (`from-report`), a preview of what `build` gives. Two fields differ:
- the provenance;
- `source.started_at`: the first trial's start in the preview, the run's creation in `build`, as for the imported campaigns.

Example: run 41783970323, "D clean, split runners".
