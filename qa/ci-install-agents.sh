#!/usr/bin/env bash
# Installs what the QA agents need on a GitHub-hosted Ubuntu runner: the Claude
# Code CLI, pinned, and the OS sandbox that runs every agent command
# (.claude/qa-settings.json sets sandbox.failIfUnavailable).
# Usage: bash qa/ci-install-agents.sh
set -euo pipefail
CLAUDE_CODE_VERSION="${CLAUDE_CODE_VERSION:-2.1.303}"

# bubblewrap isolates the commands; socat relays the sandbox's network proxy.
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends bubblewrap socat >/dev/null

# Ubuntu 24.04 blocks unprivileged user namespaces through AppArmor: allow them for bwrap only.
if [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]]; then
  sudo tee /etc/apparmor.d/bwrap >/dev/null <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  include if exists <local/bwrap>
}
PROFILE
  # If the profile cannot load, lift the restriction on this disposable runner instead.
  sudo apparmor_parser -r /etc/apparmor.d/bwrap || sudo sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0
fi

# Stop here, before any token is spent, if the sandbox cannot start.
if ! bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent true; then
  echo '::error title=Agent sandbox::bubblewrap cannot create a sandbox on this runner'
  exit 1
fi

npm install --global --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"
claude --version
