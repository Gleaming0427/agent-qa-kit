# Security

What the kit protects against, how, and what it does not. The README has the short version.

The kit defends against one threat above all: **an AI agent that cheats to obtain a pass**, by editing the approved tests, faking the results or patching the test tools, or that is **manipulated by text it reads** in the ticket, the code or the test output. It does not defend against a person who has write access to the repository.

| Layer | What it does |
|---|---|
| Guard hook and permissions | Each agent writes only what its role needs: tests for the writer, nothing for the verifier, the application for the repair agent, which may not touch the tests, their configuration, the kit, `node_modules/` or `.git/`. Commands come from a short allowlist, without chaining, redirection or network tools. Secret files, paths outside the project and symbolic links are refused. |
| Operating-system sandbox | The commands an agent runs have no network access (bubblewrap on Linux, Seatbelt on macOS). If the sandbox cannot start, Claude Code stops instead of running without it. |
| No credentials for agent commands | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` removes the API key from the commands an agent starts. On Linux, they cannot read other processes' environments either. |
| Deterministic checks | A script compares the agent's verdict with the test reports. Hashes protect the ticket, the approved tests and the first reports, and the tests stay frozen on every pull request. During repairs, `node_modules/` and the git files are compared with a snapshot after every step. The launcher runs the full suite itself. |
| CI | The API key exists only in the agent's step. The full suite, which runs the pull request's code, has a step of its own without it. The agent workflows keep no GitHub token on disk and have minimal permissions, and their inputs reach the scripts through environment variables, so they cannot inject commands. Pull requests from forks receive no secrets. Only a collaborator's approval of the latest version of the tests counts. |
| Dependencies | Exact versions, committed lockfiles, and releases at least two weeks old when they were chosen. In November 2026, `npm audit` reported no known vulnerability in either package. |

Each rule has regression tests, which `npm run check` runs in CI.

**Known gaps**, to fix before a team relies on the kit:

- The CI approval check trusts GitHub's author association: owner, member or collaborator. A collaborator with read-only access would therefore count, whereas GitHub's required reviews only count people with write access.
- The GitHub Actions are referenced by tag (`@v5`), not by commit SHA. A hijacked tag would run with the job's permissions and secrets.

**Limits that no tool removes:**

- Code under test can lie about its own results, or detect that it is being tested. A person must still review the diff.
- A pull request opened from a branch of this repository can change the workflows that judge it, and the code it runs in a job can read that job's secrets. Protect `.github/`, `qa/` and `.claude/` with a `CODEOWNERS` file and the ruleset option "Require review from Code Owners", and use a dedicated API key with a low spending limit.
- The local approval receipt detects changes but does not prove who approved. In CI, the approval is a GitHub review.
- Hooks and the sandbox are guardrails, not a disposable environment: the commands in the sandbox can still read most of the disk. When you can, run the agents in a container or in CI, without personal credentials.
- Traces and screenshots uploaded as CI artifacts can contain session data: use test accounts, never real credentials, in browser tests.
- The visual review sends screenshots to the Anthropic API: keep it off for pages that show sensitive data.

**Recommended repository settings:** require the checks on `main` (without them, nothing blocks a merge), and turn on secret scanning with push protection and Dependabot alerts.

