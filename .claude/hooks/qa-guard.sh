#!/usr/bin/env bash
# Claude Code PreToolUse guard. Exit 2 to BLOCK; any unexpected situation denies.
# Defense in depth: also rely on OS sandbox, tool permissions, and trusted CI.
deny() { echo "Blocked by QA guard: $1" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || deny 'jq required'
[[ -n "${CLAUDE_PROJECT_DIR:-}" ]] || deny 'CLAUDE_PROJECT_DIR is not set'
PROJECT="${CLAUDE_PROJECT_DIR%/}"
INPUT="$(cat)" || deny 'Cannot read tool input'
TOOL="$(jq -er '.tool_name | select(type == "string" and length > 0)' <<<"$INPUT" 2>/dev/null)" || deny 'Missing tool name / malformed JSON'

relative_path() {
  local path="$1" rel full absproject
  [[ -n "$path" ]] || deny 'Empty path'
  [[ "$path" != *..* ]] || deny "Parent-path traversal: $path"
  [[ "$path" != *$'\n'* ]] || deny 'Newlines in paths forbidden'
  if [[ "$path" == /* ]]; then
    [[ "$path" == "$PROJECT" || "$path" == "$PROJECT"/* ]] || deny "Outside project: $path"
    rel="${path#"$PROJECT"}"; rel="${rel#/}"
  else
    rel="${path#./}"
  fi
  [[ -n "$rel" ]] || deny 'Project root is not an editable file'
  # Portable on macOS and Linux: reject symlink components, even if they
  # resolve inside the project. This also blocks aliases to secrets.
  if [[ -d "$PROJECT" ]]; then
    node - "$PROJECT" "$rel" <<'JS' >/dev/null || deny "Symlink or invalid path: $rel"
const fs = require('node:fs');
const path = require('node:path');
const [root, rel] = process.argv.slice(2);
let current = fs.realpathSync(root);
for (const segment of rel.split('/')) {
  if (!segment || segment === '.' || segment === '..') process.exit(1);
  current = path.join(current, segment);
  try {
    if (fs.lstatSync(current).isSymbolicLink()) process.exit(1);
  } catch (error) {
    if (error.code !== 'ENOENT') process.exit(1);
  }
}
JS
  fi
  printf '%s' "$rel"
}
check_not_secret() {
  local rel="$1" name="${1##*/}"
  case "$name" in
    .env.example|.env.sample) return 0 ;;
    .env|.env.*|*.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*|.npmrc|.yarnrc.yml|.netrc|.pgpass) deny "Secrets file: $rel" ;;
  esac
  case "/$rel/" in
    */.ssh/*|*/.aws/*|*/.gnupg/*|*/.kube/*|*/secrets/*) deny "Secrets folder: $rel" ;;
  esac
}
check_disabled_test() {
  local content="$1"
  # Additional full-file check runs after edits and in CI; this hook is not a parser.
  local re='(^|[^A-Za-z0-9_$])((it|test|describe)\.(skip|only|fixme|todo)|x(it|describe|test))[[:space:]]*\('
  if grep -Eq "$re" <<<"$content"; then deny 'Disabling or isolating tests is forbidden'; fi
}
case "$TOOL" in
  Read)
    rel="$(relative_path "$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")")" || exit 2
    check_not_secret "$rel"
    ;;
  Grep|Glob)
    path="$(jq -r '.tool_input.path // empty' <<<"$INPUT")"
    if [[ "$TOOL" == Grep && -z "$path" ]]; then deny "Grep requires an explicit source path"; fi
    if [[ -n "$path" ]]; then
      rel="$(relative_path "$path")" || exit 2
      check_not_secret "$rel"
    fi
    ;;
  Write|Edit)
    rel="$(relative_path "$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")")" || exit 2
    check_not_secret "$rel"
    case "$rel" in
      e2e/*.spec.ts|*.test.ts|*.test.tsx) ;;
      *) deny "Agent may only write test files ($rel)" ;;
    esac
    content="$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$INPUT")"
    check_disabled_test "$content"
    ;;
  Bash)
    cmd="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"
    [[ -n "$cmd" && "$cmd" != *$'\n'* ]] || deny 'Empty or multi-line command'
    [[ ! "$cmd" =~ [\;\&\|\<\>\`\\] && "$cmd" != *'$('* ]] || deny 'Shell chaining/redirection/escaping forbidden'
    [[ "$cmd" != *'$'* && "$cmd" != *'${'* ]] || deny 'Shell expansion forbidden'
    [[ "$cmd" != *'../'* && "$cmd" != *'/..'* ]] || deny 'Parent paths forbidden' 
    [[ "$cmd" != *' --update'* && "$cmd" != *' -u' ]] || deny 'Snapshot updates forbidden'
    case "$cmd" in
      'npm run test:affected'|'npm run test:summary'|'npm test'|'npx playwright test') ;;
      'npm run test:e2e -- --grep '@*)
        grep -Eq '^npm run test:e2e -- --grep @[a-z0-9-]+$' <<<"$cmd" || deny 'Unsafe E2E grep option'
        ;;
      'npx vitest run '*)
        grep -Eq '^npx vitest run ([a-zA-Z0-9_/-]+\.)?([a-zA-Z0-9_/-]+)\.test\.tsx?$' <<<"$cmd" || deny 'Only one local test file allowed'
        ;;
      'git status'|'git status --short'|'git diff'|'git log') ;;
      'git diff '*)
        grep -Eq '^git diff (--name-only )?[a-zA-Z0-9_/-]+(\.\.\.[a-zA-Z0-9_/-]+)?$' <<<"$cmd" || deny 'Unsupported git diff command'
        ;;
      'git log '*)
        grep -Eq '^git log (-[0-9]+|--oneline)$' <<<"$cmd" || deny 'Unsupported git log command'
        ;;
      *) deny "Command not allowed: $cmd" ;;
    esac
    ;;
  *) deny "Tool not explicitly allowed: $TOOL" ;;
esac
exit 0
