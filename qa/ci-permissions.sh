#!/usr/bin/env bash
# What each reviewer of a pull request may do in the repository.
#
# GitHub's author association on a review says that a person belongs to the repository (owner, member
# of the organization, collaborator), not what they may do there: someone with read access only counts
# as a member or a collaborator too. Their approval would not count for GitHub's own required reviews,
# so it must not count for the kit's either. This asks GitHub for the permission of everyone whose review
# could count (qa/github-approval.ts uses the result to narrow who may approve).
#
# Usage: qa/ci-permissions.sh reviews.json permissions.json
#   reviews.json      gh api --paginate --slurp "repos/OWNER/REPO/pulls/NUMBER/reviews"
#   permissions.json  written: {"login in lower case": "admin" | "write" | "read" | "none", ...}
# Needs GH_TOKEN and GITHUB_REPOSITORY. A login whose permission cannot be read (the token may not be
# allowed to, or the account is a bot) is left out of the file and named in a warning: the approval then
# falls back to the association alone, which is how the kit worked before.
set -euo pipefail
reviews="${1:-}"; out="${2:-}"
[[ -f "$reviews" && -n "$out" ]] || { echo 'usage: qa/ci-permissions.sh reviews.json permissions.json' >&2; exit 2; }
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
# Workflow commands need %, CR and LF escaped.
escape() { local text="${1//%/%25}"; text="${text//$'\r'/%0D}"; printf '%s' "${text//$'\n'/%0A}"; }

# Only reviews that give a decision, from people the association says belong to the repository. Logins are
# not case sensitive on GitHub: one request per person, in lower case.
mapfile -t logins < <(jq -r '[.[] | if type == "array" then .[] else . end
  | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED" or .state == "DISMISSED")
  | select(.author_association == "OWNER" or .author_association == "MEMBER" or .author_association == "COLLABORATOR")
  | .user.login // empty | ascii_downcase] | unique[]' "$reviews")

echo '{}' > "$out"
unknown=()
for login in ${logins[@]+"${logins[@]}"}; do
  # A GitHub login holds letters, digits and single dashes: nothing else goes into the request.
  if [[ "$login" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] \
    && permission="$(gh api "repos/$GITHUB_REPOSITORY/collaborators/$login/permission" --jq .permission 2>/dev/null)" \
    && [[ "$permission" =~ ^[a-z]+$ ]]; then
    jq --arg login "$login" --arg permission "$permission" '. + {($login): $permission}' "$out" > "$out.tmp"
    mv "$out.tmp" "$out"
  else
    unknown+=("$login")
  fi
done
if (( ${#unknown[@]} > 0 )); then
  echo "::warning title=QA approval::$(escape "Could not read the repository permission of ${unknown[*]}: their review counts if GitHub calls them an owner, a member or a collaborator, even with read access only.")"
fi
