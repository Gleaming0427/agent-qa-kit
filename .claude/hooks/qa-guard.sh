#!/usr/bin/env bash
# QA guard: a Claude Code PreToolUse hook.
#
# Claude Code calls this script before every action of a QA agent and passes
# the action as JSON on standard input.
#   - exit code 0: the action is allowed;
#   - exit code 2: the action is blocked, and the message (stderr) is sent back to the agent.
# Any other exit code does NOT block the action, so the script fails closed:
# it blocks as soon as anything unexpected happens.
#
# What it enforces:
#   - reads: inside the project only, never secret files;
#   - writes: test files only, without disabling any test;
#   - commands: test commands and read-only git only.

deny() { echo "Blocked by the QA guard: $1" >&2; exit 2; }

command -v jq >/dev/null 2>&1 || deny "jq is required."
[[ -n "${CLAUDE_PROJECT_DIR:-}" ]] || deny "CLAUDE_PROJECT_DIR is not set."
PROJECT="${CLAUDE_PROJECT_DIR%/}"

INPUT="$(cat)" || deny "unreadable input."
TOOL="$(jq -r '.tool_name // empty' <<<"$INPUT" 2>/dev/null)" || deny "invalid JSON."
[[ -n "$TOOL" ]] || deny "missing tool name."

# Checks that a path stays inside the project, and prints it relative to the project.
relative_path() {
  local path="$1"
  [[ -n "$path" ]] || deny "missing path."
  [[ "$path" != *..* ]] || deny "paths containing \"..\" are not allowed ($path)."
  if [[ "$path" == /* ]]; then
    [[ "$path" == "$PROJECT" || "$path" == "$PROJECT"/* ]] || deny "access outside the project is not allowed ($path)."
    path="${path#"$PROJECT"}"
    path="${path#/}"
  fi
  printf '%s' "${path#./}"
}

# Blocks files and folders that hold secrets.
check_not_secret() {
  local rel="$1" name="${1##*/}"
  case "$name" in
    .env.example|.env.sample) return 0 ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|.npmrc|.yarnrc.yml|.netrc|.pgpass)
      deny "reading a secrets file is not allowed ($rel)." ;;
  esac
  case "/$rel/" in
    */.ssh/*|*/.aws/*|*/.gnupg/*|*/.kube/*|*/secrets/*)
      deny "reading a secrets folder is not allowed ($rel)." ;;
  esac
}

case "$TOOL" in
  Read)
    REL="$(relative_path "$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")")" || exit 2
    check_not_secret "$REL"
    exit 0
    ;;

  Grep|Glob)
    SEARCH_PATH="$(jq -r '.tool_input.path // empty' <<<"$INPUT")"
    [[ -z "$SEARCH_PATH" ]] && exit 0  # no path: search inside the project
    REL="$(relative_path "$SEARCH_PATH")" || exit 2
    check_not_secret "$REL"
    exit 0
    ;;

  Write|Edit)
    REL="$(relative_path "$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")")" || exit 2
    case "$REL" in
      e2e/*.spec.ts|*.test.ts|*.test.tsx) ;;
      *) deny "the QA agent only writes test files ($REL)." ;;
    esac
    CONTENT="$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$INPUT")"
    DISABLED='(^|[^A-Za-z0-9_$])((it|test|describe)\.(skip|only|fixme|todo)|x(it|describe|test))[[:space:]]*\('
    if grep -Eq "$DISABLED" <<<"$CONTENT"; then
      deny "disabling or isolating a test is not allowed (.skip, .only, .fixme, .todo)."
    fi
    exit 0
    ;;

  Bash)
    CMD="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"
    [[ -n "$CMD" ]] || deny "empty command."
    # One command, one action: no chaining, redirection or subshell.
    [[ "$CMD" != *$'\n'* ]] || deny "multi-line commands are not allowed."
    META='[;&|<>`]'
    if [[ "$CMD" =~ $META || "$CMD" == *'$('* ]]; then
      deny "chaining or redirection is not allowed ($CMD)."
    fi
    # Updating snapshots would rewrite the expected result.
    UPDATE='(^| )(-u|--update[A-Za-z-]*)( |=|$)'
    [[ "$CMD" =~ $UPDATE ]] && deny "updating snapshots is not allowed ($CMD)."
    ALLOWED='^(npm (test|run test(:[a-z0-9-]+)?)|npx (vitest run|playwright test)|git (diff|status|log))( |$)'
    [[ "$CMD" =~ $ALLOWED ]] && exit 0
    deny "command not allowed for the QA agent ($CMD)."
    ;;

  *)
    exit 0
    ;;
esac
