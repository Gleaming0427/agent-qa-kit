#!/usr/bin/env node
// The agent bundle: what a runner where an agent works receives instead of a checkout.
//   node eval/bundle.ts build <dest> [TICKET...]
//     Where the corpus is (the plan job). Copies the allowlist of eval/lib/isolation.ts and the specs
//     of the tickets (all by default), writes the manifest, then scans the bundle for the corpus:
//     a copy of a private file, a private line, a corpus file name, an injected bug's name. Any
//     finding fails the command, and the bundle is deleted.
//   node eval/bundle.ts verify
//     On the agent's runner, run from the bundle. Checks its files against the manifest (nothing
//     added but installed packages, nothing changed), and that no corpus folder is on the runner.
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUNDLE_SPECS, buildBundle, corpusFingerprints, corpusOnRunner, publicTexts, scanForCorpus, verifyBundle } from './lib/isolation.ts';
import { APP, KIT, TICKETS, listTickets } from './lib/workspace.ts';

const [command, ...args] = process.argv.slice(2);

if (command === 'build') {
  const [dest, ...requested] = args;
  if (!dest) { console.error('usage: node eval/bundle.ts build <dest> [TICKET...]'); process.exit(2); }
  const tickets = requested.length ? requested : listTickets();
  const out = resolve(dest);
  const manifest = buildBundle(out, tickets, { kit: KIT, ticketsDir: TICKETS });
  const specs = listTickets().map((t) => join(TICKETS, t, 'spec.md'));
  const fingerprints = corpusFingerprints(TICKETS, publicTexts(APP, specs));
  const findings = scanForCorpus(out, fingerprints);
  if (findings.length) {
    rmSync(out, { recursive: true, force: true });
    console.error(`The agent bundle holds traces of the corpus (${findings.length}); it was deleted:`);
    for (const f of findings) console.error(`- ${f.path}: ${f.reason}`);
    process.exit(1);
  }
  const specCount = Object.keys(manifest.files).filter((f) => f.startsWith(`${BUNDLE_SPECS}/`)).length;
  console.log(`Agent bundle in ${out}: ${Object.keys(manifest.files).length} files, ${specCount} spec(s), no trace of the corpus `
    + `(${fingerprints.contents.size} private files, ${fingerprints.lines.size} private lines and ${fingerprints.bugIds.length} bug names looked for).`);
} else if (command === 'verify') {
  const problems = verifyBundle(KIT);
  if (process.env.EVAL_TICKETS) problems.push('EVAL_TICKETS is set: an agent runner has no corpus to point to');
  const runnerTemp = process.env.RUNNER_TEMP;
  const leaks = corpusOnRunner([join(KIT, 'eval/tickets'), join(tmpdir(), 'eval-tickets'), ...(runnerTemp ? [join(runnerTemp, 'eval-tickets')] : [])]);
  problems.push(...leaks.map((dir) => `a corpus is on this runner: ${dir}`));
  if (problems.length) {
    console.error(`This runner is not fit for an agent (${problems.length} problem(s)):`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(join(KIT, 'eval/bundle-manifest.json'), 'utf8')) as { files: Record<string, string> };
  console.log(`Agent bundle verified: ${Object.keys(manifest.files).length} files as built, no corpus on this runner.`);
} else {
  console.error('usage: node eval/bundle.ts <build <dest> [TICKET...]|verify>');
  process.exit(2);
}
