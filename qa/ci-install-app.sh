#!/usr/bin/env bash
# Installs an application's dependencies and Playwright's Chromium on a CI runner, with the
# package manager its lockfile belongs to: npm (package-lock.json) or pnpm (pnpm-lock.yaml).
# The QA agents and the full suite run the application's scripts with "npm run" either way:
# npm run only starts a script of package.json, and pnpm's node_modules/.bin holds the same
# commands. So the agents' allowed commands, and what was measured, stay the same.
#
# The lockfile is looked for in the application's folder, then in the folders above it up to
# the repository's root: a lockfile above the application covers it in a workspace only
# (pnpm-workspace.yaml for pnpm, "workspaces" in package.json for npm). The pnpm version is
# the one package.json names in "packageManager", as every pnpm version writes the same
# lockfile format.
#
# Usage: bash qa/ci-install-app.sh <application folder> [--detect]
#   --detect  prints "<npm|pnpm> <folder of the lockfile> <pnpm version, or ->" and installs nothing
set -euo pipefail
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }
fail() { echo "::error title=Install the application::$(escape "$1")"; exit 1; }
# A top-level field of a package.json: its text, "array" for an array, nothing otherwise.
field() {
  node -e 'try {
    const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    process.stdout.write(Array.isArray(v) ? "array" : typeof v === "string" ? v : "");
  } catch {}' "$1/package.json" "$2"
}

[[ $# -ge 1 && $# -le 2 && ( $# -eq 1 || "$2" == --detect ) ]] || { echo 'usage: qa/ci-install-app.sh <application folder> [--detect]' >&2; exit 2; }
[[ -f "$1/package.json" ]] || fail "No package.json in \"$1\"."
APP="$(cd "$1" && pwd -P)"
ROOT="$(git -C "$APP" rev-parse --show-toplevel 2>/dev/null || echo "$APP")"
ROOT="$(cd "$ROOT" && pwd -P)"

manager=''; lock_dir=''; dir="$APP"
while :; do
  has_npm=0; has_pnpm=0
  [[ -f "$dir/package-lock.json" ]] && has_npm=1
  [[ -f "$dir/pnpm-lock.yaml" ]] && has_pnpm=1
  if (( has_npm || has_pnpm )); then
    declared="$(field "$dir" packageManager)"
    if (( has_npm && has_pnpm )); then
      case "$declared" in
        pnpm@*) manager=pnpm ;;
        npm@*) manager=npm ;;
        *) fail "$dir has both package-lock.json and pnpm-lock.yaml: delete the one you do not use, or name the package manager in \"packageManager\"." ;;
      esac
    elif (( has_pnpm )); then manager=pnpm
    else manager=npm
    fi
    if [[ "$dir" != "$APP" ]]; then
      if [[ "$manager" == pnpm && ! -f "$dir/pnpm-workspace.yaml" ]]; then
        fail "$dir/pnpm-lock.yaml is not the application's: there is no pnpm-workspace.yaml next to it. Commit the application's own lockfile."
      fi
      if [[ "$manager" == npm && "$(field "$dir" workspaces)" != array ]]; then
        fail "$dir/package-lock.json is not the application's: its package.json has no \"workspaces\". Commit the application's own lockfile."
      fi
    fi
    lock_dir="$dir"
    break
  fi
  for other in yarn.lock bun.lock bun.lockb; do
    [[ -f "$dir/$other" ]] && fail "The application uses $other: the kit installs applications with npm or pnpm only."
  done
  [[ "$dir" == "$ROOT" || "$dir" == / ]] && break
  dir="$(dirname "$dir")"
done
[[ -n "$manager" ]] || fail "No package-lock.json or pnpm-lock.yaml for $APP: commit the lockfile, the workflows install from it."

version=-
if [[ "$manager" == pnpm ]]; then
  declared="$(field "$lock_dir" packageManager)"
  # "pnpm@10.12.1", maybe followed by "+sha512.<hash>", which npm's own integrity check replaces.
  if [[ ! "$declared" =~ ^pnpm@([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)(\+[0-9A-Za-z.]+)?$ ]]; then
    fail "Name the pnpm version in $lock_dir/package.json: \"packageManager\": \"pnpm@<version>\", the output of pnpm --version${declared:+ (it says \"$declared\")}. Every pnpm version writes the same lockfile format, so the lockfile cannot tell."
  fi
  version="${BASH_REMATCH[1]}"
fi

if [[ "${2:-}" == --detect ]]; then
  echo "$manager $lock_dir $version"
  exit 0
fi

echo "Installing $APP with $manager$([[ $manager == pnpm ]] && echo " $version"), from the lockfile in $lock_dir"
if [[ "$manager" == npm ]]; then
  (cd "$lock_dir" && npm ci --no-audit --no-fund)
  (cd "$APP" && npx playwright install --with-deps chromium)
else
  npm install --global --no-audit --no-fund "pnpm@$version"
  installed="$(pnpm --version)"
  [[ "$installed" == "$version" ]] || fail "pnpm $version was installed, but pnpm --version says $installed: another pnpm comes first on the PATH."
  (cd "$lock_dir" && pnpm install --frozen-lockfile)
  (cd "$APP" && pnpm exec playwright install --with-deps chromium)
fi
