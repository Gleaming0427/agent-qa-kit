import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BUNDLE_INCLUDE, BUNDLE_MANIFEST, BUNDLE_SPECS, buildBundle, corpusFingerprints, corpusOnRunner, publicTexts, scanForCorpus, verifyBundle } from '../lib/isolation.ts';
import { APP, KIT, TICKETS, listTickets, loadTicket } from '../lib/workspace.ts';

const tickets = listTickets();
const fingerprints = corpusFingerprints(TICKETS, publicTexts(APP, tickets.map((t) => join(TICKETS, t, 'spec.md'))));

function withBundle(fn: (dir: string) => void) {
  const work = mkdtempSync(join(tmpdir(), 'eval-bundle-'));
  try {
    const dir = join(work, 'bundle');
    buildBundle(dir, tickets, { kit: KIT, ticketsDir: TICKETS });
    fn(dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('the agent bundle holds the kit, the shop and the specs, and no trace of the corpus', () => {
  withBundle((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, BUNDLE_MANIFEST), 'utf8')) as { files: Record<string, string>; tickets: string[] };
    const files = Object.keys(manifest.files);
    assert.deepEqual(manifest.tickets, tickets);
    for (const file of files) {
      assert.ok(BUNDLE_INCLUDE.some((p) => file === p || file.startsWith(`${p}/`)) || file.startsWith(`${BUNDLE_SPECS}/`), `unexpected file in the bundle: ${file}`);
    }
    // The specs are the only part of a ticket the agent may read; nothing else of its folder is copied.
    assert.equal(files.filter((f) => f.startsWith(`${BUNDLE_SPECS}/`)).length, tickets.length);
    for (const absent of ['.git', 'eval/tickets', 'eval/results', 'eval/README.md', 'eval/history', 'eval/tests', 'qa/tests', 'examples/shop/node_modules']) {
      assert.equal(existsSync(join(dir, absent)), false, `${absent} must not be in the bundle`);
    }
    assert.deepEqual(scanForCorpus(dir, fingerprints), []);
    assert.deepEqual(verifyBundle(dir), []);
  });
});

test('the fingerprints cover every private file of the corpus, and leave the specs out', () => {
  const ticket = loadTicket('EVAL-1');
  const where = [...fingerprints.contents.values()];
  for (const file of ['EVAL-1/gold.diff', 'EVAL-1/hidden.spec.ts', 'EVAL-1/ticket.json', ...ticket.bugs.map((b) => `EVAL-1/bugs/${b.id}.diff`)]) {
    assert.ok(where.includes(file), file);
  }
  assert.ok(!where.some((w) => w.endsWith('/spec.md')));
  assert.ok(fingerprints.bugIds.includes('discount-includes-shipping'));
});

test('the scan finds a copied file, a pasted line, a bug name, a corpus folder and git metadata', () => {
  withBundle((dir) => {
    const ticket = loadTicket('EVAL-1');
    // A hidden test copied under another name.
    writeFileSync(join(dir, 'examples/shop/e2e/notes.spec.ts'), readFileSync(join(ticket.dir, 'hidden.spec.ts')));
    // One added line of the reference implementation, pasted into the kit.
    const added = readFileSync(join(ticket.dir, 'gold.diff'), 'utf8').split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
      .find((l) => fingerprints.lines.get(l.trim()) === 'EVAL-1/gold.diff');
    assert.ok(added, 'the reference implementation adds a distinctive line');
    appendFileSync(join(dir, 'qa/summary.ts'), `\n// ${added}\n`);
    // A file named after a bug, a mention of a bug, a corpus folder, git metadata.
    writeFileSync(join(dir, 'qa/any-code-accepted.diff'), 'x');
    appendFileSync(join(dir, '.claude/agents/qa-writer.md'), '\nWatch for discount-includes-shipping.\n');
    mkdirSync(join(dir, 'eval/tickets/EVAL-1'), { recursive: true });
    writeFileSync(join(dir, 'eval/tickets/EVAL-1/ticket.json'), '{}');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');

    const reasons = scanForCorpus(dir, fingerprints).map((f) => `${f.path.replace(/:\d+$/, '')} | ${f.reason}`);
    const has = (path: string, reason: string) => assert.ok(reasons.some((r) => r.startsWith(`${path} |`) && r.includes(reason)), `${path}: ${reason}\n${reasons.join('\n')}`);
    has('examples/shop/e2e/notes.spec.ts', 'copy of a corpus file (EVAL-1/hidden.spec.ts)');
    has('qa/summary.ts', 'line from the corpus (EVAL-1/gold.diff)');
    has('qa/any-code-accepted.diff', 'named after injected bug any-code-accepted');
    has('.claude/agents/qa-writer.md', 'mentions injected bug discount-includes-shipping');
    has('eval/tickets/EVAL-1/ticket.json', 'corpus file name');
    has('.git/HEAD', 'git metadata');
    // A finding names the file and the kind of trace, not the private text.
    assert.ok(!reasons.some((r) => r.includes(added!.trim())));

    const problems = verifyBundle(dir);
    assert.ok(problems.includes('changed since the bundle was built: qa/summary.ts'));
    assert.ok(problems.includes('not in the manifest: examples/shop/e2e/notes.spec.ts'));
    assert.ok(problems.includes('corpus or git file: .git/HEAD'));
    assert.deepEqual(corpusOnRunner([join(dir, 'eval/tickets'), join(dir, 'nowhere')]), [join(dir, 'eval/tickets')]);
  });
});

test('a missing bundle file is reported, and installed packages are allowed', () => {
  withBundle((dir) => {
    mkdirSync(join(dir, 'examples/shop/node_modules/react'), { recursive: true });
    writeFileSync(join(dir, 'examples/shop/node_modules/react/index.js'), '');
    assert.deepEqual(verifyBundle(dir), []);
    rmSync(join(dir, 'qa/run-qa.sh'));
    assert.deepEqual(verifyBundle(dir), ['missing: qa/run-qa.sh']);
  });
});

test('the guard hook must stay executable: an artifact upload that drops the bit is caught', () => {
  withBundle((dir) => {
    const manifest = JSON.parse(readFileSync(join(dir, BUNDLE_MANIFEST), 'utf8')) as { executables: string[] };
    assert.ok(manifest.executables.includes('.claude/hooks/qa-guard.sh'));
    chmodSync(join(dir, '.claude/hooks/qa-guard.sh'), 0o644);
    assert.deepEqual(verifyBundle(dir), ['no longer executable: .claude/hooks/qa-guard.sh']);
  });
});
