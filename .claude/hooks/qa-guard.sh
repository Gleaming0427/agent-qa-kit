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
    # The project root: Glob lists file names there, as it does with no path; Grep would read every file.
    if [[ "$path" == "$PROJECT" || "$path" == "$PROJECT/" || "$path" == . || "$path" == ./ ]]; then
      [[ "$TOOL" == Glob ]] || deny 'Grep needs a folder inside the project, such as src or e2e, not the whole project: it would read secrets files such as .env'
      path=''
    fi
    if [[ "$TOOL" == Grep && -z "$path" ]]; then deny "Grep requires an explicit source path: a folder inside the project, such as src or e2e"; fi
    if [[ -n "$path" ]]; then
      rel="$(relative_path "$path")" || exit 2
      check_not_secret "$rel"
    fi
    if [[ "$TOOL" == Glob ]]; then
      # An absolute pattern, or a parent path in it, lists files outside the path searched.
      pattern="$(jq -r '.tool_input.pattern // empty' <<<"$INPUT")"
      [[ -n "$pattern" && "$pattern" != *$'\n'* ]] || deny 'Empty or multi-line Glob pattern'
      [[ "$pattern" != *..* ]] || deny "Parent-path traversal: $pattern"
      [[ ! "$pattern" =~ [{,][[:space:]]*[/~] && "$pattern" != '~'* ]] || deny "Glob pattern outside project: $pattern"
      if [[ "$pattern" == /* ]]; then
        [[ "$pattern" == "$PROJECT"/* ]] || deny "Glob pattern outside project: $pattern"
      fi
    fi
    ;;
  Write|Edit)
    rel="$(relative_path "$(jq -r '.tool_input.file_path // empty' <<<"$INPUT")")" || exit 2
    check_not_secret "$rel"
    # No agent changes the installed packages or the git metadata: the tests run on them.
    case "/$rel/" in
      */node_modules/*|*/.git/*) deny "Agents may not change installed packages or git files ($rel)" ;;
    esac
    if [[ "${QA_GUARD_MODE:-qa}" == repair ]]; then
      # The repair agent fixes the application; tests, their setup and the kit stay as approved.
      case "$rel" in
        *.spec.*|*.test.*|*-snapshots/*|*__snapshots__/*|e2e/*|*/e2e/*|qa/*|.claude/*|.github/*|reports/*|specs/*)
          deny "Repair agent may not change tests or QA files ($rel)" ;;
      esac
      case "${rel##*/}" in
        package.json|package-lock.json|npm-shrinkwrap.json|yarn.lock|pnpm-lock.yaml|playwright.config.*|vite.config.*|vitest.config.*|vitest.workspace.*)
          deny "Repair agent may not change the test setup or dependencies ($rel)" ;;
      esac
      # What the tests are set up with, by conventional name: setup and teardown files, mocks, fixtures, helpers.
      # The same two patterns as isSupportFile in qa/check-tooling.ts, which also keeps the files a configuration
      # names as setup files unchanged during a repair (qa/tooling-integrity.ts).
      lower="$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')"
      support_dir='(^|/)(__mocks__|__fixtures__|__tests__|tests?|testing|test[-_]?utils|test[-_]?helpers)/'
      support_name='^(setup[-_]?tests?|test[-_]?setup|global[-_]?(setup|teardown)|test[-_]?(utils?|helpers?)|.+\.(setup|teardown))\.[cm]?[jt]sx?$'
      if [[ "$lower" =~ $support_dir || "${lower##*/}" =~ $support_name ]]; then
        deny "Repair agent may not change what the tests are set up with: setup files, mocks, fixtures and test helpers ($rel). If one of them is wrong, say so in your answer instead."
      fi
    else
      case "$rel" in
        e2e/*.spec.ts|*.test.ts|*.test.tsx) ;;
        *) deny "Agent may only write test files ($rel)" ;;
      esac
    fi
    content="$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$INPUT")"
    check_disabled_test "$content"
    ;;
  Bash)
    cmd="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"
    [[ -n "$cmd" && "$cmd" != *$'\n'* ]] || deny 'Empty or multi-line command'
    [[ ! "$cmd" =~ [\;\&\|\<\>\`\\] && "$cmd" != *'$('* ]] \
      || deny 'Shell chaining/redirection/escaping forbidden: run one command per call, with no ;, &&, | or >. Test output needs no cutting: npm run test:summary condenses it, and npm run test:summary -- --run @<mfe> runs the unit and browser tests first'
    [[ "$cmd" != *'$'* && "$cmd" != *'${'* ]] || deny 'Shell expansion forbidden'
    [[ "$cmd" != *'../'* && "$cmd" != *'/..'* ]] || deny 'Parent paths forbidden' 
    [[ "$cmd" != *' --update'* && "$cmd" != *' -u' ]] || deny 'Snapshot updates forbidden'
    case "$cmd" in
      'npm run test:affected'|'npm run test:summary'|'npm test'|'npx playwright test') ;;
      'npm run build') [[ "${QA_GUARD_MODE:-qa}" == repair ]] || deny "Command not allowed: $cmd" ;;
      'npm run test:e2e -- --grep '@*)
        grep -Eq '^npm run test:e2e -- --grep @[a-z0-9-]+$' <<<"$cmd" || deny 'Unsafe E2E grep option'
        ;;
      # Runs test:affected, then test:e2e -- --grep @<mfe>, then prints the summary (qa/summary.ts);
      # with --stop-on-unit-failure, the browser tests only after unit tests with no failure.
      'npm run test:summary -- --run '*)
        grep -Eq '^npm run test:summary -- --run @[a-z0-9-]+( --stop-on-unit-failure)?$' <<<"$cmd" || deny 'Unsafe test:summary option'
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
      # The agents reach for these to read, list or search files: say which tool does it.
      cat\ *|head\ *|tail\ *|less\ *|more\ *|ls|ls\ *|find\ *|grep\ *|rg\ *|wc\ *|sed\ *|awk\ *|tree|tree\ *)
        deny "Command not allowed: $cmd (use the Read tool to read a file, Glob to list files and Grep to search them)" ;;
      *) deny "Command not allowed: $cmd" ;;
    esac
    ;;
  *) deny "Tool not explicitly allowed: $TOOL" ;;
esac
exit 0
