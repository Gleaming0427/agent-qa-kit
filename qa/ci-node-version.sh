#!/usr/bin/env bash
# The Node.js version the workflows give an application: the one its .nvmrc or .node-version
# names, looked for in the application's folder, then in the folders above it up to the
# repository's root; 22 when there is none. The kit's own scripts need 22.18 or later (Node
# runs their TypeScript directly), so an older version is refused rather than installed.
#
# Usage: bash qa/ci-node-version.sh <application folder>...
# Prints, for $GITHUB_OUTPUT:
#   node=<version for actions/setup-node>
#   node_from=<the file it comes from, relative to the repository, or "default">
# Several applications must agree: a job has one Node.js. Exits 1 with the reason on stderr.
set -euo pipefail
fail() { echo "$1" >&2; exit 1; }
[[ $# -ge 1 ]] || { echo 'usage: qa/ci-node-version.sh <application folder>...' >&2; exit 2; }

# The version a folder's files name, as "version<US>file" (the unit separator: a .nvmrc may be
# empty, and read drops empty fields around whitespace separators), or nothing.
named() {
  local app="$1" dir root file text rel
  dir="$(cd "$app" && pwd -P)"
  root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || echo "$dir")"
  root="$(cd "$root" && pwd -P)"
  while :; do
    for file in .nvmrc .node-version; do
      if [[ -f "$dir/$file" ]]; then
        # The first line that is not a comment, without spaces.
        text="$(grep -v '^[[:space:]]*#' "$dir/$file" | grep -m1 '[^[:space:]]' | tr -d '[:space:]' || true)"
        rel="${dir#"$root"}"; rel="${rel#/}"
        printf '%s\037%s\n' "$text" "${rel:+$rel/}$file"
        return 0
      fi
    done
    [[ "$dir" == "$root" || "$dir" == / ]] && return 0
    dir="$(dirname "$dir")"
  done
}

chosen=''; from=''
for app in "$@"; do
  [[ "$app" =~ ^[A-Za-z0-9._/-]+$ && "/$app/" != */../* && -d "$app" ]] || fail "No application folder \"$app\"."
  text=''; file=''
  IFS=$'\037' read -r text file < <(named "$app") || true
  file="${file:-default}"
  if [[ -z "${text:-}" ]]; then
    [[ "$file" == default ]] || fail "$file is empty: write a Node.js version in it, such as 22 or 24.11.1."
    version=22
  else
    version="${text#v}"
    if [[ "$version" =~ ^([0-9]+)(\.([0-9]+))?(\.[0-9]+)?$ ]]; then
      major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[3]:-}"
      if (( major < 22 )) || { (( major == 22 )) && [[ -n "$minor" ]] && (( minor < 18 )); }; then
        fail "$file names Node.js $text; the kit's scripts need 22.18 or later. Use a later version in CI, or run the kit's workflows on a branch that does."
      fi
    elif [[ "$version" != lts/\* && "$version" != latest && "$version" != current && "$version" != node ]]; then
      fail "$file names \"$text\": write a version number, such as 22 or 24.11.1 (or lts/*), so that the kit can check it is 22.18 or later."
    fi
  fi
  if [[ -n "$chosen" && "$version" != "$chosen" ]]; then
    fail "The applications need different Node.js versions: $chosen ($from) and $version ($file). A job has one."
  fi
  chosen="$version"; from="$file"
done
echo "node=$chosen"
echo "node_from=$from"
