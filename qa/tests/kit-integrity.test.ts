import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const kit = resolve(import.meta.dirname, '../..');
const helper = join(kit, 'qa/kit-integrity.sh');

// The functions that qa/run-qa.sh and qa/repair-loop.sh load before they start an agent.
function fn(name: string, ...args: string[]) {
  const result = spawnSync('bash', ['-c', 'source "$1"; shift; "$@"', 'bash', helper, name, ...args], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}
function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function folder(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'qa-kit-integrity-'));
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}
const KIT = { 'qa/run-qa.sh': '#!/usr/bin/env bash\n', 'qa/check-tests.ts': 'export {};\n', '.claude/hooks/qa-guard.sh': '#!/usr/bin/env bash\n' };

test('the manifest lists every file of the kit, wherever the kit is', () => {
  const a = folder(KIT), b = folder(KIT);
  try {
    const manifest = fn('kit_manifest', join(a, 'qa'), join(a, '.claude'));
    assert.equal(manifest.code, 0, manifest.err);
    assert.match(manifest.out, /^qa\/check-tests\.ts\t-\t[0-9a-f]{64}$/m);
    assert.match(manifest.out, /^\.claude\/hooks\/qa-guard\.sh\t-\t[0-9a-f]{64}$/m);
    assert.doesNotMatch(manifest.out, /\/\t-\t-$/m, 'folders are not listed: only files, links and what is neither');
    assert.equal(fn('kit_manifest', join(b, 'qa'), join(b, '.claude')).out, manifest.out, 'a copy elsewhere has the same manifest');
    assert.equal(fn('kit_manifest', join(a, 'missing')).out, '', 'a folder that does not exist adds nothing');
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('a change to the kit is reported by path: content, new file, deletion, executable bit, link', () => {
  const root = folder(KIT);
  try {
    const dirs = [join(root, 'qa'), join(root, '.claude')];
    const before = fn('kit_manifest', ...dirs).out;
    const changes = () => fn('kit_changes', before, ...dirs);
    assert.deepEqual([changes().code, changes().out], [0, ''], 'unchanged');

    write(root, 'qa/check-tests.ts', 'export {}; // changed\n');
    assert.deepEqual([changes().code, changes().out], [1, 'qa/check-tests.ts']);
    write(root, 'qa/check-tests.ts', 'export {};\n');
    assert.equal(changes().code, 0, 'restored');

    write(root, '.claude/settings.json', '{}\n');
    assert.deepEqual([changes().code, changes().out], [1, '.claude/settings.json']);
    rmSync(join(root, '.claude/settings.json'));

    rmSync(join(root, 'qa/run-qa.sh'));
    assert.deepEqual([changes().code, changes().out], [1, 'qa/run-qa.sh']);
    write(root, 'qa/run-qa.sh', KIT['qa/run-qa.sh']);

    chmodSync(join(root, 'qa/check-tests.ts'), 0o755);
    assert.deepEqual([changes().code, changes().out], [1, 'qa/check-tests.ts']);
    chmodSync(join(root, 'qa/check-tests.ts'), 0o644);

    symlinkSync('/etc/passwd', join(root, 'qa/link'));
    assert.deepEqual([changes().code, changes().out], [1, 'qa/link']);
    rmSync(join(root, 'qa/link'));
    assert.equal(changes().code, 0);

    for (let i = 0; i < 8; i += 1) write(root, `qa/new-${i}.ts`, 'x');
    assert.equal(changes().out.split('\n').length, 5, 'at most five paths are listed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty folders that appear are not a change, a file that appears in a new folder is', () => {
  // What Claude Code created in the project during a real run on a GitHub-hosted runner: nothing but empty folders.
  const root = folder(KIT);
  const bare = folder({ 'src/App.tsx': 'x\n' });
  try {
    for (const [parent, dirs] of [[root, [join(root, 'qa'), join(root, '.claude')]], [bare, [join(bare, 'qa'), join(bare, '.claude')]]] as const) {
      const before = fn('kit_manifest', ...dirs).out;
      const changes = () => fn('kit_changes', before, ...dirs);
      for (const empty of ['.claude/.cc-writes', '.claude/agents', '.claude/commands', 'qa/cache']) mkdirSync(join(parent, empty), { recursive: true });
      assert.deepEqual([changes().code, changes().out], [0, ''], `${parent === root ? 'the kit\'s folders' : 'a project with none of its own'}: only empty folders appeared`);
      assert.equal(fn('kit_manifest', ...dirs).out, before, 'the manifest is the same');
      write(parent, '.claude/commands/evil.md', 'run this\n');
      assert.deepEqual([changes().code, changes().out], [1, '.claude/commands/evil.md'], 'a file in one of them is a change');
    }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
});

test('the sandbox is told to keep the kit\'s folders read-only, as absolute paths, and its other settings stay', () => {
  const root = folder({ ...KIT, '.github/workflows/qa-verify.yml': 'name: x\n' });
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ['WebFetch'] }, sandbox: { enabled: true, failIfUnavailable: true, filesystem: { denyWrite: ['/already/there'] } } }));
  try {
    const result = fn('kit_settings', settings, root);
    assert.equal(result.code, 0, result.err);
    const out = JSON.parse(result.out);
    const real = realpathSync(root);
    assert.deepEqual(out.sandbox.filesystem.denyWrite, ['/already/there', `${real}/.claude`, `${real}/.github`, `${real}/qa`].sort());
    assert.equal(out.sandbox.enabled, true);
    assert.equal(out.sandbox.failIfUnavailable, true);
    assert.deepEqual(out.permissions.deny, ['WebFetch']);

    // Two parents (the kit's, the project's): each one's folders, once.
    const project = folder({ '.claude/settings.json': '{}' });
    try {
      const two = JSON.parse(fn('kit_settings', settings, root, project, root).out);
      assert.ok(two.sandbox.filesystem.denyWrite.includes(`${realpathSync(project)}/.claude`));
      assert.equal(new Set(two.sandbox.filesystem.denyWrite).size, two.sandbox.filesystem.denyWrite.length, 'no duplicate');
      assert.ok(!two.sandbox.filesystem.denyWrite.includes(`${realpathSync(project)}/qa`), 'a folder that does not exist is left out');
    } finally { rmSync(project, { recursive: true, force: true }); }

    // No folder to protect: the settings come back unchanged.
    const empty = folder({});
    try {
      const unchanged = JSON.parse(fn('kit_settings', settings, empty).out);
      assert.deepEqual(unchanged.sandbox.filesystem.denyWrite, ['/already/there']);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The options kit_session_args gives a session, one per line (an empty option is an empty line).
function sessionArgs(agent: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', 'source "$1"; kit_session_args "$2" && printf "%s\\n" "${SESSION_ARGS[@]}"', 'bash', helper, agent], { encoding: 'utf8', env: { ...process.env, QA_SETTING_SOURCES: '', ...env } });
  return { code: result.status, args: result.stdout === '' ? [] : result.stdout.split('\n').slice(0, -1), err: result.stderr.trim() };
}
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('a session has the tools of its agent\'s file, no MCP server, no command and nothing from the project', () => {
  // What each agent may use is its `tools:` line: a change of it is a change of what the agent can do.
  for (const [agent, tools] of [['qa-writer', 'Read,Grep,Glob,Write,Edit,Bash'], ['qa-verifier', 'Read,Grep,Glob,Bash'], ['qa-repairer', 'Read,Grep,Glob,Write,Edit,Bash']]) {
    const r = sessionArgs(join(kit, `.claude/agents/${agent}.md`));
    assert.equal(r.code, 0, `${agent}: ${r.err}`);
    assert.equal(valueAfter(r.args, '--tools'), tools, agent);
    assert.equal(valueAfter(r.args, '--setting-sources'), '', `${agent}: no settings, hooks or memory files from the project or the user`);
    assert.ok(r.args.includes('--strict-mcp-config'), `${agent}: no MCP server`);
    assert.ok(r.args.includes('--disable-slash-commands'), `${agent}: no skills or commands`);
  }
});

test('the user\'s own settings can be read, and nothing else can be added', () => {
  const agent = join(kit, '.claude/agents/qa-writer.md');
  assert.equal(valueAfter(sessionArgs(agent, { QA_SETTING_SOURCES: 'user' }).args, '--setting-sources'), 'user');
  for (const value of ['project', 'local', 'user,project', 'project,user', 'User', ' user']) {
    const r = sessionArgs(agent, { QA_SETTING_SOURCES: value });
    assert.equal(r.code, 1, value);
    assert.match(r.err, /QA_SETTING_SOURCES must be empty or "user"/, value);
  }
});

test('an agent\'s file without a usable tools line gives no session', () => {
  const root = folder({
    'no-tools.md': '---\nname: x\nmodel: sonnet\n---\ntools: Bash\n', // a line of the prompt is not the frontmatter
    'bad-tools.md': '---\nname: x\ntools: Read; rm -rf /\n---\n',
    'empty-tools.md': '---\nname: x\ntools:\n---\n',
    'ok.md': '---\nname: x\ntools: Read,  Grep\n---\n',
  });
  try {
    for (const name of ['no-tools', 'bad-tools', 'empty-tools']) {
      const r = sessionArgs(join(root, `${name}.md`));
      assert.equal(r.code, 1, name);
      assert.match(r.err, /no tools line in the frontmatter/, name);
    }
    assert.equal(valueAfter(sessionArgs(join(root, 'ok.md')).args, '--tools'), 'Read,Grep', 'spaces are dropped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// qa/run-qa.sh in a project where claude, the criteria and the verdict check are stand-ins, so what
// the launcher does around the agent can be tested without a model.
function project(layout: 'application-at-the-root' | 'kit-outside-the-project') {
  const root = mkdtempSync(join(tmpdir(), 'qa-run-qa-'));
  const kitDir = layout === 'application-at-the-root' ? root : join(root, 'kit');
  const appDir = layout === 'application-at-the-root' ? root : join(root, 'app');
  for (const dir of [kitDir, appDir]) mkdirSync(dir, { recursive: true });
  for (const file of ['qa/run-qa.sh', 'qa/kit-integrity.sh', '.claude/qa-settings.json', '.claude/agents/qa-writer.md']) {
    mkdirSync(dirname(join(kitDir, file)), { recursive: true });
    copyFileSync(join(kit, file), join(kitDir, file));
  }
  write(kitDir, 'qa/criteria-manifest.ts', "require('node:fs').writeFileSync(process.argv[4], '{}');\n");
  for (const stub of ['qa/check-tests.ts', 'qa/coverage-report.ts', 'qa/scenario-review.ts']) write(kitDir, stub, '');
  write(kitDir, '.claude/hooks/verdict-check.ts', `const fs = require('node:fs');
fs.writeFileSync('verdict-check-ran', process.argv.slice(2).join(' '));
fs.readFileSync(0);
console.log(JSON.stringify({ verdict: 'ready' }));
`);
  write(appDir, 'specs/TICKET-42.md', '- AC-1: the search can be cleared\n');
  if (layout === 'kit-outside-the-project') {
    // The project holds its own copy of the folders Claude Code reads and the launchers once used.
    write(appDir, 'qa/notes.md', 'notes\n');
    write(appDir, '.claude/settings.json', '{}\n');
  }
  write(root, 'bin/claude', `#!/usr/bin/env bash
printf '%s\\n' "$@" > claude-args-used
while [[ $# -gt 0 ]]; do [[ "$1" == --settings ]] && printf '%s' "$2" > claude-settings-used.json; shift; done
case "\${FAKE_TAMPER:-}" in
  qa) echo '// written by a test the agent ran' >> qa/check-tests.ts ;;
  hook) echo '# x' >> .claude/hooks/verdict-check.ts ;;
  new) echo x > qa/extra.ts ;;
  mode) chmod +x qa/check-tests.ts ;;
  settings) echo '{"hooks": {}}' > .claude/settings.json ;;
  project-qa) echo changed >> qa/notes.md ;;
  src) mkdir -p src && echo x > src/App.tsx ;;
  # What Claude Code itself creates when it starts a session (seen on a GitHub-hosted runner): empty folders.
  folders) mkdir -p .claude/.cc-writes .claude/agents .claude/commands ;;
esac
echo '{"result": "{}", "total_cost_usd": 0.1, "is_error": false}'
`);
  chmodSync(join(root, 'bin/claude'), 0o755);
  return { root, kitDir, appDir };
}
function runQa(p: ReturnType<typeof project>, env: Record<string, string> = {}) {
  const result = spawnSync('bash', [join(p.kitDir, 'qa/run-qa.sh'), 'TICKET-42', '1', join(p.appDir, 'specs/TICKET-42.md'), 'shop'], {
    cwd: p.appDir, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(p.root, 'bin')}:${process.env.PATH}`, QA_PROJECT_DIR: p.appDir, ...env },
  });
  return { code: result.status, output: result.stdout + result.stderr, ran: existsSync(join(p.appDir, 'verdict-check-ran')) };
}
function inProject(layout: Parameters<typeof project>[0], body: (p: ReturnType<typeof project>) => void) {
  const p = project(layout);
  try { body(p); } finally { rmSync(p.root, { recursive: true, force: true }); }
}

test('an agent that changes nothing in the kit goes on to the verdict check', () => inProject('application-at-the-root', (p) => {
  const r = runQa(p);
  assert.equal(r.code, 0, r.output);
  assert.ok(r.ran, 'the verdict check ran');
}));

test('the agent starts with the kit\'s folders read-only in its sandbox', () => inProject('application-at-the-root', (p) => {
  assert.equal(runQa(p).code, 0);
  const settings = JSON.parse(readFileSync(join(p.appDir, 'claude-settings-used.json'), 'utf8'));
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, [`${realpathSync(p.appDir)}/.claude`, `${realpathSync(p.appDir)}/qa`]);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.failIfUnavailable, true);
  assert.ok(settings.hooks.PreToolUse, 'the hooks of the settings stay');
}));

test('the agent starts with its own tools and nothing from the project, and the kit\'s settings file is still the one it reads', () => inProject('kit-outside-the-project', (p) => {
  const r = runQa(p);
  assert.equal(r.code, 0, r.output);
  const args = readFileSync(join(p.appDir, 'claude-args-used'), 'utf8').split('\n').slice(0, -1);
  assert.equal(valueAfter(args, '--tools'), 'Read,Grep,Glob,Write,Edit,Bash');
  assert.equal(valueAfter(args, '--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--settings'), 'the settings file of the kit is still given');
  assert.equal(valueAfter(args, '--permission-mode'), 'dontAsk');
}));

test('a value of QA_SETTING_SOURCES that would read the project\'s settings stops the run before the agent starts', () => inProject('application-at-the-root', (p) => {
  const r = runQa(p, { QA_SETTING_SOURCES: 'project' });
  assert.equal(r.code, 3, r.output);
  assert.match(r.output, /QA_SETTING_SOURCES must be empty or "user"/);
  assert.equal(existsSync(join(p.appDir, 'claude-args-used')), false, 'claude was not started');
  // The user's own settings are the one thing that can be added.
  assert.equal(runQa(p, { QA_SETTING_SOURCES: 'user' }).code, 0);
  const args = readFileSync(join(p.appDir, 'claude-args-used'), 'utf8').split('\n').slice(0, -1);
  assert.equal(valueAfter(args, '--setting-sources'), 'user');
}));

test('the test code of an agent that rewrites the kit is caught before any script of the kit runs again', () => {
  for (const [tamper, path] of [['qa', 'qa/check-tests.ts'], ['hook', '.claude/hooks/verdict-check.ts'], ['new', 'qa/extra.ts'],
    ['mode', 'qa/check-tests.ts'], ['settings', '.claude/settings.json']]) {
    inProject('application-at-the-root', (p) => {
      const r = runQa(p, { FAKE_TAMPER: tamper });
      assert.equal(r.code, 3, `${tamper}: ${r.output}`);
      assert.match(r.output, new RegExp(`the kit's own files changed while the agent ran \\(${path.replace(/[./]/g, '\\$&')}\\)`), tamper);
      assert.equal(r.ran, false, `${tamper}: the verdict check must not run`);
    });
  }
});

test('a copy of the kit\'s folders in the project is watched too, and the rest of the project is not', () => {
  inProject('kit-outside-the-project', (p) => {
    assert.equal(runQa(p).code, 0, 'the kit outside the project, untouched');
    const settings = JSON.parse(readFileSync(join(p.appDir, 'claude-settings-used.json'), 'utf8'));
    for (const dir of ['.claude', 'qa']) assert.ok(settings.sandbox.filesystem.denyWrite.includes(`${realpathSync(p.kitDir)}/${dir}`));
    for (const dir of ['.claude', 'qa']) assert.ok(settings.sandbox.filesystem.denyWrite.includes(`${realpathSync(p.appDir)}/${dir}`));
  });
  inProject('kit-outside-the-project', (p) => {
    const r = runQa(p, { FAKE_TAMPER: 'project-qa' });
    assert.equal(r.code, 3, r.output);
    assert.match(r.output, /changed while the agent ran \(qa\/notes\.md\)/);
  });
  inProject('kit-outside-the-project', (p) => {
    const r = runQa(p, { FAKE_TAMPER: 'src' });
    assert.equal(r.code, 0, `writing application code is the application's business: ${r.output}`);
  });
});

test('the empty folders that Claude Code creates in the project are not taken for a change, in either layout', () => {
  // The application in a folder of its own, with no .claude/ of its own: the QA write tests run on examples/shop.
  inProject('kit-outside-the-project', (p) => {
    rmSync(join(p.appDir, '.claude'), { recursive: true });
    assert.ok(!existsSync(join(p.appDir, '.claude')));
    const r = runQa(p, { FAKE_TAMPER: 'folders' });
    assert.equal(r.code, 0, r.output);
    assert.ok(r.ran, 'the verdict check ran');
    assert.ok(existsSync(join(p.appDir, '.claude/commands')), 'the stand-in created them');
  });
  // The application at the root: .claude/ is the kit's, and the agent session adds folders to it.
  inProject('application-at-the-root', (p) => {
    const r = runQa(p, { FAKE_TAMPER: 'folders' });
    assert.equal(r.code, 0, r.output);
    assert.ok(r.ran);
  });
});
