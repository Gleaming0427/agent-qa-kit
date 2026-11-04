// Keeps the evaluation corpus away from the runners where an agent works, and checks that it stayed away.
//
// An agent's runner gets a bundle, never a checkout. The bundle is an allowlist of the kit, the
// application and the trial steps, plus the spec of each ticket, and nothing else: no git history,
// no reference implementation, injected bug, hidden test or ticket metadata, and none of the
// documents that describe them (eval/README.md, eval/results). The job that builds it has the
// corpus, scans the bundle for any trace of it, and writes a manifest; the agent's job checks its
// files against that manifest before an agent starts.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

/** What an agent's runner gets, relative to the kit. Everything else stays on the runners without an agent. */
export const BUNDLE_INCLUDE = [
  '.claude',
  'qa',
  'examples/shop',
  'eval/trial.ts',
  'eval/bundle.ts',
  'eval/lib',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
];
/** Never copied, wherever they are: installed packages, build output, git metadata. */
const SKIP_NAMES = new Set(['node_modules', '.git', 'reports', 'test-results', 'playwright-report', 'dist']);
/** Installed packages, build output or git metadata: never part of a bundle or of a variant. */
export const isGenerated = (path: string) => path.split('/').some((segment) => SKIP_NAMES.has(segment));
/** Not needed to run a trial: the kit's own tests. */
const SKIP_PATHS = /^qa\/tests$|^qa\/test-[^/]*\.sh$/;
/** The specs, the only part of the corpus an agent may read, sit here in the bundle. */
export const BUNDLE_SPECS = 'eval/specs';
export const BUNDLE_MANIFEST = 'eval/bundle-manifest.json';

export interface BundleManifest {
  schema_version: 1;
  tickets: string[];
  /** sha256 of each file. */
  files: Record<string, string>;
  /**
   * Files that must stay executable. The guard hook is run directly: without its executable bit,
   * Claude Code would report a hook error and go on without the guard.
   */
  executables: string[];
}
export interface Finding { path: string; reason: string }

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const isExecutable = (path: string) => (statSync(path).mode & 0o111) !== 0;
const posix = (path: string) => path.split(sep).join('/');

/** Files under dir, relative and in posix form, sorted; skips installed packages and git metadata unless asked. */
export function listFiles(dir: string, { all = false } = {}): string[] {
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name;
      if (!all && (name === 'node_modules' || name === '.git')) continue;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk('');
  return found.sort();
}

/**
 * Copies the allowlist and the given tickets' specs into dest, and returns the manifest of what it holds.
 * The specs are copied from <tickets>/<TICKET>/spec.md: no other file of a ticket's folder is read.
 */
export function buildBundle(dest: string, tickets: string[], { kit, ticketsDir }: { kit: string; ticketsDir: string }): BundleManifest {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of BUNDLE_INCLUDE) {
    const from = join(kit, entry);
    if (!existsSync(from)) throw new Error(`bundle: ${entry} is missing from the kit`);
    cpSync(from, join(dest, entry), {
      recursive: true,
      filter: (src) => {
        const rel = posix(relative(kit, src));
        return !SKIP_NAMES.has(basename(src)) && !SKIP_PATHS.test(rel);
      },
    });
  }
  mkdirSync(join(dest, BUNDLE_SPECS), { recursive: true });
  for (const ticket of tickets) {
    if (!/^[A-Z][A-Z0-9]*-\d+$/.test(ticket)) throw new Error(`bundle: invalid ticket ${ticket}`);
    cpSync(join(ticketsDir, ticket, 'spec.md'), join(dest, BUNDLE_SPECS, `${ticket}.md`));
  }
  const files = listFiles(dest, { all: true });
  const manifest: BundleManifest = {
    schema_version: 1,
    tickets: [...tickets].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    files: Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(dest, f)))])),
    executables: files.filter((f) => isExecutable(join(dest, f))),
  };
  writeFileSync(join(dest, BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Traces of the corpus to look for. Built where the corpus is, never on an agent's runner. */
export interface Fingerprints {
  /** sha256 of each private file: everything in a ticket's folder but its spec. */
  contents: Map<string, string>;
  /**
   * Each private line long enough to be distinctive and not found in a public file, with its file.
   * Kept as text, to be found inside a longer line too: fingerprints never leave the runner that has the corpus.
   */
  lines: Map<string, string>;
  /** Injected bug ids: their names describe the bugs. */
  bugIds: string[];
}

const MIN_LINE = 24;
const normalize = (line: string) => line.trim();

/** Lines that only the corpus has: the added lines of the diffs, the hidden tests, the ticket metadata. */
function privateLines(file: string, text: string): string[] {
  const lines = text.split('\n');
  if (file.endsWith('.diff')) return lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  return lines;
}

/**
 * Fingerprints the corpus. publicTexts are files an agent may legitimately see (the application,
 * the specs): a private line found anywhere in them, even inside a longer line, is not distinctive,
 * and is left out.
 */
export function corpusFingerprints(ticketsDir: string, publicTexts: string[]): Fingerprints {
  const seen = publicTexts.join('\n');
  const fp: Fingerprints = { contents: new Map(), lines: new Map(), bugIds: [] };
  for (const ticket of readdirSync(ticketsDir).filter((n) => /^[A-Z][A-Z0-9]*-\d+$/.test(n)).sort()) {
    const dir = join(ticketsDir, ticket);
    for (const file of listFiles(dir).filter((f) => f !== 'spec.md')) {
      const data = readFileSync(join(dir, file));
      const where = `${ticket}/${file}`;
      fp.contents.set(sha256(data), where);
      for (const line of privateLines(file, data.toString('utf8')).map(normalize)) {
        if (line.length >= MIN_LINE && !fp.lines.has(line) && !seen.includes(line)) fp.lines.set(line, where);
      }
      if (file === 'ticket.json') {
        const meta = JSON.parse(data.toString('utf8')) as { bugs?: { id: string }[] };
        fp.bugIds.push(...(meta.bugs ?? []).map((b) => b.id));
      }
    }
  }
  fp.bugIds = [...new Set(fp.bugIds)].sort();
  return fp;
}

/** Corpus paths, whatever folder they were moved to. */
const CORPUS_PATH = /(^|\/)eval\/tickets(\/|$)|(^|\/)eval-tickets(\/|$)|(^|\/)gold\.diff$|(^|\/)hidden\.spec\.ts$|(^|\/)ticket\.json$/;

/**
 * Looks for the corpus in a folder. Findings name the file and the kind of trace, never the
 * private text itself. With lines: false, only whole copies and names are looked for: an
 * agent's own tests can share a line with a hidden test without having seen it.
 */
export function scanForCorpus(dir: string, fp: Fingerprints, { lines = true, mentions = true } = {}): Finding[] {
  const findings: Finding[] = [];
  const ids = fp.bugIds.map((id) => ({ id, path: new RegExp(`(^|/)${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.diff$`) }));
  for (const file of listFiles(dir, { all: true })) {
    if (file.split('/').includes('node_modules')) continue;
    if (file.split('/').includes('.git')) { findings.push({ path: file, reason: 'git metadata' }); continue; }
    if (CORPUS_PATH.test(file)) findings.push({ path: file, reason: 'corpus file name' });
    for (const { id, path } of ids) if (path.test(file)) findings.push({ path: file, reason: `named after injected bug ${id}` });
    const data = readFileSync(join(dir, file));
    const copied = fp.contents.get(sha256(data));
    if (copied) findings.push({ path: file, reason: `copy of a corpus file (${copied})` });
    if (data.length > 2_000_000 || data.includes(0)) continue;
    const text = data.toString('utf8');
    if (lines) {
      for (const [line, from] of fp.lines) {
        const at = text.indexOf(line);
        if (at >= 0) findings.push({ path: `${file}:${text.slice(0, at).split('\n').length}`, reason: `line from the corpus (${from})` });
      }
    }
    if (mentions) for (const { id } of ids) if (text.includes(id)) findings.push({ path: file, reason: `mentions injected bug ${id}` });
  }
  return findings;
}

/** Checks a bundle on disk against its manifest: same files, same content, nothing added but installed packages. */
export function verifyBundle(dir: string): string[] {
  const path = join(dir, BUNDLE_MANIFEST);
  if (!existsSync(path)) return [`${BUNDLE_MANIFEST} is missing: this is not an agent bundle`];
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as BundleManifest;
  const problems: string[] = [];
  const onDisk = listFiles(dir, { all: true }).filter((f) => f !== BUNDLE_MANIFEST && !f.split('/').includes('node_modules'));
  for (const file of onDisk) {
    if (!(file in manifest.files)) problems.push(`not in the manifest: ${file}`);
    else if (manifest.files[file] !== sha256(readFileSync(join(dir, file)))) problems.push(`changed since the bundle was built: ${file}`);
  }
  for (const file of Object.keys(manifest.files)) if (!onDisk.includes(file)) problems.push(`missing: ${file}`);
  for (const file of manifest.executables ?? []) if (onDisk.includes(file) && !isExecutable(join(dir, file))) problems.push(`no longer executable: ${file}`);
  for (const file of onDisk) if (CORPUS_PATH.test(file) || file.split('/').includes('.git')) problems.push(`corpus or git file: ${file}`);
  return problems;
}

/** The candidate folders that hold a corpus (a ticket folder with its ticket.json). On an agent's runner, any is a leak. */
export function corpusOnRunner(candidates: string[]): string[] {
  return candidates.filter((dir) => existsSync(dir) && lstatSync(dir).isDirectory()
    && readdirSync(dir).some((n) => /^[A-Z][A-Z0-9]*-\d+$/.test(n) && existsSync(join(dir, n, 'ticket.json'))));
}

/** Public texts for the fingerprints: the application's files and the specs. */
export function publicTexts(app: string, specs: string[]): string[] {
  return [
    ...listFiles(app).filter((f) => !isGenerated(f) && !/\.(png|jpe?g|gif|ico|woff2?|zip)$/.test(f)).map((f) => readFileSync(join(app, f), 'utf8')),
    ...specs.map((s) => readFileSync(s, 'utf8')),
  ];
}

export const bundleSpec = (bundle: string, ticket: string) => join(bundle, BUNDLE_SPECS, `${ticket}.md`);
