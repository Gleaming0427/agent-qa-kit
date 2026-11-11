#!/usr/bin/env bash
# Puts a copy of the kit (qa/ and .claude/) where the code of a job cannot change it.
#
# In a workflow, the kit's scripts run again after the application's code has run: the tests an agent
# wrote, the code of the pull request. A kit that stays in the checkout can be rewritten by that code,
# and its scripts then run with the API key or a write token. A pull request can also change the
# scripts that judge it. The workflows run the kit from this copy instead: owned by root and
# read-only for everyone else (default /opt/qa-kit, or QA_TRUSTED_KIT).
#
# The workflow chooses what is copied, before any code of the application runs:
#   QA write tests  its own checkout, the branch the person started it on;
#   QA verify       the base branch of the pull request, so that a pull request is not judged by
#                   its own copy of the scripts.
#
# Usage: bash qa/ci-trusted-kit.sh <folder holding qa/ and .claude/>
# Writing below /opt needs sudo, as on GitHub's runners. Where the destination is a folder the
# current user can write to (a test, a developer machine), no sudo is used and the copy is made
# read-only for its owner too, which protects less: the owner can undo it.
set -euo pipefail
fail() { echo "::error title=Trusted kit::$1" >&2; exit 1; }
SRC="${1:-}"
DEST="${QA_TRUSTED_KIT:-/opt/qa-kit}"
[[ -n "$SRC" && -d "$SRC/qa" && -d "$SRC/.claude" ]] \
  || fail 'usage: bash qa/ci-trusted-kit.sh <folder holding qa/ and .claude/>'
SRC="$(cd "$SRC" && pwd -P)"
[[ "$DEST" == /* && "$DEST" != / && "$DEST" != "$SRC" && "$DEST" != "$SRC"/* && "$SRC" != "$DEST"/* ]] \
  || fail "unsafe destination: $DEST (source: $SRC)"
# A link could lead out of the copy to a place the job can write to.
link="$(find "$SRC/qa" "$SRC/.claude" -type l -print -quit)"
[[ -z "$link" ]] || fail "the kit holds a symbolic link, which would escape the copy: ${link#"$SRC"/}"

as_root=()
if [[ ! -w "$(dirname "$DEST")" && $EUID -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || fail "cannot write to $(dirname "$DEST"): run as root or install sudo, or set QA_TRUSTED_KIT to a folder you can write to"
  as_root=(sudo)
fi
run() { "${as_root[@]+"${as_root[@]}"}" "$@"; }

# A previous copy is read-only: make it removable first.
if [[ -e "$DEST" ]]; then run chmod -R u+w "$DEST"; run rm -rf "$DEST"; fi
run mkdir -p "$DEST"
run cp -R "$SRC/qa" "$SRC/.claude" "$DEST/"
# The kit's scripts are ES modules, whatever the repository's own package.json says.
printf '{\n  "type": "module"\n}\n' | run tee "$DEST/package.json" >/dev/null
# The version of the agents, as QA verify records it (the git tree of .claude).
tree="$(git -C "$SRC" rev-parse --short HEAD:.claude 2>/dev/null || true)"
[[ -z "$tree" ]] || printf '%s\n' "$tree" | run tee "$DEST/.claude-tree" >/dev/null
if (( ${#as_root[@]} )) || [[ $EUID -eq 0 ]]; then run chown -R root:root "$DEST"; fi
run chmod -R a-w "$DEST"

# On a runner, the job's user must not be able to write to the copy.
if [[ $EUID -ne 0 && -w "$DEST/qa/run-qa.sh" && ${#as_root[@]} -gt 0 ]]; then
  fail "$DEST is still writable by the job's user"
fi
echo "Trusted kit: $DEST, copied from $SRC${tree:+ (.claude tree $tree)}."
