#!/usr/bin/env bash
# What keeps the kit's own scripts and hooks out of reach of the code an agent runs.
#
# The commands an agent starts include the application's tests, which run code the agent wrote or
# repaired. The agent's sandbox lets them write in the project's folder. When the application is at
# the root of its repository, that folder also holds qa/ and .claude/: the launchers then run those
# files again, outside the sandbox and with the API key in their environment, and Claude Code reads
# the settings and hooks of .claude/.
#
# Sourced by qa/run-qa.sh and qa/repair-loop.sh before they start an agent, so the functions are
# already in memory when the agent runs and nothing it does can replace them. It defines functions
# only.
#
#   kit_settings SETTINGS_FILE PARENT...
#       Prints the settings with the qa, .claude and .github folders of each PARENT (those that exist)
#       added to the sandbox's denyWrite list, as absolute paths: the commands an agent starts cannot
#       write there. Pass the kit's folder and the project's.
#   kit_manifest DIR...
#       Prints one line per file below the folders given: path, executable bit and sha256 of the content.
#   kit_changes BEFORE DIR...
#       Compares the folders with a manifest taken earlier. Prints up to five paths that differ and
#       returns 1 when anything does. Taken before the agent and after it, it shows a change that the
#       sandbox did not stop.

kit_settings() {
  local settings="$1" parent dir list dirs=()
  shift
  for parent in "$@"; do
    for dir in qa .claude .github; do
      [[ -d "$parent/$dir" ]] && dirs+=("$(cd "$parent/$dir" && pwd -P)")
    done
  done
  if (( ${#dirs[@]} == 0 )); then jq -c . "$settings"; return; fi
  list="$(printf '%s\n' "${dirs[@]}" | jq -R . | jq -sc 'unique')" || return 1
  jq -c --argjson dirs "$list" '.sandbox.filesystem.denyWrite = ((.sandbox.filesystem.denyWrite // []) + $dirs | unique)' "$settings"
}

kit_manifest() {
  node -e '
    const { createHash } = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const lines = [];
    const walk = (dir, key) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name), here = key + "/" + name, stat = fs.lstatSync(full);
        if (stat.isDirectory()) { lines.push(here + "/\t-\t-"); walk(full, here); }
        else if (stat.isSymbolicLink()) lines.push(here + "\tlink\t" + fs.readlinkSync(full));
        else if (stat.isFile()) lines.push(here + "\t" + (stat.mode & 0o111 ? "x" : "-") + "\t" + createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
        else lines.push(here + "\tother\t-");
      }
    };
    for (const dir of process.argv.slice(1)) {
      if (!fs.existsSync(dir)) continue;
      const key = path.basename(dir);
      lines.push(key + "/\t-\t-");
      walk(dir, key);
    }
    console.log(lines.sort().join("\n"));
  ' "$@"
}

kit_changes() {
  local before="$1" after
  shift
  after="$(kit_manifest "$@")" || { echo '(the kit cannot be read)'; return 1; }
  [[ "$after" != "$before" ]] || return 0
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | awk -F'\t' '/^[<>] / { sub(/^[<>] /, "", $1); print $1 }' | sort -u | head -n 5
  return 1
}
