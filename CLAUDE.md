# Working on the Agent QA Kit

This file is for Claude Code sessions that develop the kit. The kit's QA agents do not load it: they start with `--setting-sources ""` (`qa/kit-integrity.sh`), the eval bundle leaves it out, and `init` does not copy it into a project.

Start with `docs/STATE.md`: the objectives, where things stand, the decisions and the next steps. Update it at the end of a session.

## Checks

- `npm run check`: the whole suite. It runs the typecheck, the tests of `qa/` and `eval/`, the guard, verdict and scope scripts, and the test-file integrity check. Run it before every commit, and read its exit code, not only the last lines.
- `node --test qa/tests/<name>.test.ts`: one test file.
- `node eval/validate-corpus.ts`: the eval corpus, with no model call. It needs `npm ci` in `examples/shop` and Chromium.
- `node eval/history.ts check`: the history of campaigns. `build` rebuilds it, and needs every campaign's commit: `git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`.
- `node eval/required.ts origin/main HEAD`: whether the branch changes what the agents see or can do, and so needs a QA eval.
- `node eval/validate.ts --candidate <campaign> --baseline <campaign>`: a release decision, with no model call.

## Rules

- Ask before anything that spends API credit (QA eval, QA write tests, QA verify), opens or merges a pull request, or deletes a branch. The owner merges, tags and deletes branches.
- A change of the agents' surface needs a QA eval (`tickets: smoke`) or, if it only removes unused context, the label `qa-eval-waived`. The surface is the prompts, the models, the tools, the settings, the hooks, `qa/run-qa.sh`, `qa/kit-integrity.sh`, `qa/criteria-manifest.ts` and the Claude Code version.
- Commits are signed `Gleaming <284604818+Gleaming0427@users.noreply.github.com>`, with no co-author line.
- Never claim what was not measured. Write down what ran, with which version, and what did not run.

## When compacting

Keep, word for word where it matters:
- every file changed in the session, with its path, and whether it is committed and pushed (branch, commit);
- the test commands run and their last result, with the number passed, failed and skipped;
- the open pull requests and branches, and the state of their checks;
- the QA eval runs started (run id, branch, tickets, cost), and those still running;
- the decisions made with the owner, and their reasons;
- what the owner asked for and has not been done, and what waits for their answer;
- the API credit spent in the session;
- the next step.

Drop the content of files that can be read again, long command outputs and logs, and the steps that led to a result that is kept.
