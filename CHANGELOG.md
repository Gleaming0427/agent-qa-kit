# Changelog

## Unreleased

- **A coverage summary for the reviewer.** Reading test code shows what is wrong in a test, not what is missing: the evaluation's missed bugs came from tests that looked right.
  - The writer's phase 1 verdict now states, for each criterion, the cases its tests use (data, expected values with their arithmetic, the wrong implementation each one rules out) and what they leave out.
  - The Stop hook sends back a verdict without it, and one whose arithmetic does not add up (`.claude/hooks/coverage.ts`).
  - The review pull request shows the summary under each criterion.
  - Verdicts approved before this change stay valid.
- **Amending approved tests.** A wrong approved test had no clean way out: the repair agent may not touch it, and QA verify refuses a test edited on the developer's branch. Now:
  - a person fixes it on `qa/<TICKET>`, then runs the new **QA amend tests** workflow with the reason;
  - no agent runs: every test of the ticket must still fail for the right reason on the application without the feature;
  - the amendment is logged with its author and reason in the review package, and the tests need a new approval;
  - QA verify lists the amendments in its summary.
- **An advisory mode for QA verify.** The repository variable `QA_VERIFY_MODE=advisory` makes every failure a warning that says it would have blocked, and lets the check pass.
  - In both modes, each run records the outcome of each step, ticket by ticket, in a `qa-verify-record` artifact.
  - `node qa/verify-record.ts` reads these records and lists the failures for a person to label as false blocks or real problems. It says when the check can block: enough pull requests, no false block, nothing left unlabeled.

## v0.2.0, 4 November 2026

Since v0.1.0 the kit has an evaluation framework that measures its QA agents, without letting them see what they are measured on. The agents' prompts are those of the "D clean" campaign, the release baseline (`eval/release-baseline.json`).

### QA workflow

- The repair loop, an AI visual review and the QA agents run in CI.
- The agents are kept out of `node_modules` and `.git`, and the security model is documented.
- The example application is a shop, with CI screenshot baselines. It replaces the server console.
- The QA workflow, the demo and the costs are documented.

### Evaluating the agents

- **An evaluation harness**, `eval/`. Each ticket of a corpus comes with a spec, hidden tests, a reference implementation and injected bugs. `node eval/validate-corpus.ts` checks the corpus with no model call.
  - There are 17 tickets, among them an ambiguous one and an adversarial one.
  - EVAL-11 to EVAL-17 were written as tickets the agents were not tuned on.
- **The writer's choice of cases is measured.** It chooses cases that separate a right implementation from a wrong one, and unit tests that cannot pass on any implementation are sent back.
- **The corpus is isolated from the agent.** Each trial runs on three runners:
  - the agent, with a bundle and no checkout;
  - the scoring, with the corpus and no secret;
  - the verifier, with two implementations under neutral names.

  The bundle is scanned for any trace of the corpus. The agent's tests are scored in a sandbox that fails closed. Every campaign was rechecked for a sight of the corpus.
- **A versioned history** of every campaign, `eval/history`. Each campaign is rebuilt from its source report and records the agent version, environment, scorer, provenance and corrections. It holds 20 campaigns.
- **Paired comparisons**, `eval/compare.ts`. Two agent versions are compared ticket by ticket, with an exact sign test (McNemar when every ticket is stable), under rules fixed in `eval/compare-policy.json`: accepted, review or rejected.
- **Smoke runs**, `tickets: smoke`. A few tickets are chosen from the history: the critical ones, one of each kind, the risky ones, and a rotation slot. The choice is deterministic and backtested.
- **A release decision in CI**, under the rules at the candidate's commit. A rejection fails the job. A ticket rerun for its results gets one follow-up, then a human review.
- **Trials per ticket**, `trials: adaptive`. Each ticket gets its number of trials from its history (`eval/trials-policy.json`). `eval/trials.ts` replays what more or fewer trials change.
- **A cost cap**, `max_cost_usd`, 5 dollars by default. The plan estimates a campaign's cost from the history and starts nothing above the cap.

### Fixes found by the campaigns

- The parallelism counts each runner's working time, not the wait between runners.
- A trial whose scoring runner sent nothing back is recorded as a scoring error, not as missed bugs.
- Glob and Grep are back for the agents, and the verifier's transcripts are checked too.

### Measured and not kept

- **Asking the writer for one case per plausible wrong implementation.** It found EVAL-1's shipping bug 3 times out of 3, but false positives rose from 2 to 5 in 48 trials. It was reverted ([eval/results/2026-11-04-rule-5.md](eval/results/2026-11-04-rule-5.md)).

The results of each campaign and analysis are in [eval/results](eval/results).

## v0.1.0, 30 October 2026

The first version: the QA writer and verifier agents, their guard hooks, the `qa/` scripts, and a server console example.
