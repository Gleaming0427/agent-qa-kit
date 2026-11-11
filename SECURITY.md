# Security

What the kit protects against, how, and what it does not. The README has the short version.

The kit defends against one threat above all: **an AI agent that cheats to obtain a pass**, by editing the approved tests, faking the results or patching the test tools, or that is **manipulated by text it reads** in the ticket, the code or the test output. It does not defend against a person who has write access to the repository.

| Layer | What it does |
|---|---|
| Guard hook and permissions | Each agent writes only what its role needs: tests for the writer, nothing for the verifier, the application for the repair agent, which may not touch the tests, their configuration, the kit, `node_modules/` or `.git/`. Commands come from a short allowlist, without chaining, redirection or network tools. Secret files, paths outside the project and symbolic links are refused. |
| Operating-system sandbox | The commands an agent runs have no network access (bubblewrap on Linux, Seatbelt on macOS). If the sandbox cannot start, Claude Code stops instead of running without it. The settings also keep the kit's own folders (`qa/`, `.claude/`, `.github/`, and the project's) read-only inside the sandbox, so that the tests an agent runs cannot rewrite the scripts that run after them. |
| No credentials for agent commands | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key from the commands an agent starts. On Linux, they cannot read other processes' environments either. |
| Deterministic checks | A script compares the agent's verdict with the test reports. Hashes protect the ticket, the approved tests and the first reports, and the tests stay frozen on every pull request. During repairs, `node_modules/` and the git files are compared with a snapshot after every step. The launcher runs the full suite itself. The kit's own files are compared before and after each agent run, and the launcher stops, before running any of them again, if one changed. |
| CI | The API key exists only in the agent's step. The full suite, which runs the pull request's code, has a step of its own without it. The agent workflows keep no GitHub token on disk and have minimal permissions, and their inputs reach the scripts through environment variables, so they cannot inject commands. Pull requests from forks receive no secrets. Only a collaborator's approval of the latest version of the tests counts. The kit's scripts run from a copy outside the checkout (`/opt/qa-kit`), owned by root and read-only, made before any code of the application runs: from the branch QA write tests was started on; from the base branch of the pull request for QA verify and QA branch rules; from the default branch for the QA approval status. A pull request is not judged by its own copy of the scripts. |
| Changes to how tests run | QA verify says when a pull request changes the scripts of a `package.json` that run the tests or the install, the Vitest, Vite or Playwright configuration, or a setup file that a configuration names, and when it changes the kit's own files. It only warns by default; the repository variable `QA_VERIFY_TOOLING=block` makes it fail the check. |
| Dependencies | Exact versions, committed lockfiles, and releases at least two weeks old when they were chosen. In November 2026, `npm audit` reported no known vulnerability in either package. |

Each rule has regression tests, which `npm run check` runs in CI. In November 2026, the copy of the kit in `/opt/qa-kit` (made with `sudo`, and checked not to be writable by the job's user) and the checkout of the base branch ran on a GitHub-hosted runner, in QA verify on a pull request that names no ticket. The steps that come after, with a ticket (the verifier, the full suite) and QA write tests, have not run with the copy yet. The sandbox's write rules were tried with bubblewrap through the sandbox runtime, not through Claude Code itself.

**Known gaps**, to fix before a team relies on the kit:

- The CI approval check trusts GitHub's author association: owner, member or collaborator. A collaborator with read-only access would therefore count, whereas GitHub's required reviews only count people with write access.
- The GitHub Actions are referenced by tag (`@v5`), not by commit SHA. A hijacked tag would run with the job's permissions and secrets.
- The workflow files themselves (`.github/workflows/qa-*.yml`) run as the pull request has them. A pull request can change what the job does before it calls the kit. Only a `CODEOWNERS` file on `.github/` and a required review stop that.
- QA verify only looks at a pull request that names the ticket in its branch or title. A pull request that does not can change the ticket's unit tests: only the ticket's browser tests and its review package are protected on every pull request.
- The copy of the kit comes from the base branch. On the pull request that installs the kit, or upgrades it from a version without the copy, the base branch has nothing to copy from: the job uses the pull request's own scripts and says so.
- The check on how tests run is a static reading of the files. It does not follow what a configuration imports without naming it as a setup file, and it does not look at dependencies.

**Limits that no tool removes:**

- Code under test can lie about its own results, or detect that it is being tested. A person must still review the diff.
- The code a pull request runs in a job can read that job's secrets. Protect `.github/`, `qa/` and `.claude/` with a `CODEOWNERS` file and the ruleset option "Require review from Code Owners", and use a dedicated API key with a low spending limit.
- The local approval receipt detects changes but does not prove who approved. In CI, the approval is a GitHub review.
- Hooks and the sandbox are guardrails, not a disposable environment: the commands in the sandbox can still read most of the disk. When you can, run the agents in a container or in CI, without personal credentials.
- Traces and screenshots uploaded as CI artifacts can contain session data: use test accounts, never real credentials, in browser tests.
- The visual review sends screenshots to the Anthropic API: keep it off for pages that show sensitive data.

**Recommended repository settings:** require the checks on `main` (without them, nothing blocks a merge), and turn on secret scanning with push protection and Dependabot alerts.

