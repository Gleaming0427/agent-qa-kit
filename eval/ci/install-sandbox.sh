#!/usr/bin/env bash
# Installs bubblewrap on a GitHub-hosted Ubuntu runner for the scoring sandbox (eval/lib/sandbox.ts),
# where the agents' generated tests run without the network, the secrets or a view of the corpus.
# The same steps as qa/ci-install-agents.sh, without Claude Code: the scoring runner has no agent.
# They are repeated here so that the kit (qa/, .claude/) stays unchanged by the evaluation.
# Usage: bash eval/ci/install-sandbox.sh
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends bubblewrap >/dev/null

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

# The namespaces the scoring sandbox asks for, network included. Stop here if they cannot be created.
if ! bwrap --die-with-parent --unshare-all --ro-bind / / --dev /dev --proc /proc true; then
  echo '::error title=Scoring sandbox::bubblewrap cannot create a sandbox on this runner'
  exit 1
fi
bwrap --version
