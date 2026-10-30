#!/usr/bin/env node
/** Extract the ticket's acceptance criteria BEFORE any QA agent runs.
 * CLI: node qa/criteria-manifest.mjs TICKET-42 specs/TICKET-42.md reports/TICKET-42-criteria.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function buildManifest(ticket, specText) {
  if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(ticket)) throw new Error('Invalid ticket identifier.');
  const criteria = [];
  const seen = new Set();
  for (const line of specText.split(/\r?\n/)) {
    // Supports: '- AC-1: ...', '### AC-2 — ...', '**AC-3:** ...'.
    const match = line.match(/^\s*(?:[-*]\s*|#{1,6}\s*)?(?:\*\*)?(AC-[1-9]\d*)(?:\*\*)?\s*[:—–-]\s*(.*)/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) throw new Error(`Duplicate acceptance criterion: ${id}`);
    const description = match[2].trim();
    if (!description) throw new Error(`Criterion ${id} has no description.`);
    seen.add(id);
    criteria.push({ id, description });
  }
  if (!criteria.length) throw new Error('No AC-N criteria found. Clarify the ticket before running agents.');
  return {
    schema_version: 1,
    ticket,
    spec_sha256: createHash('sha256').update(specText).digest('hex'),
    criteria,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const [, , ticket, specFile, outputFile] = process.argv;
    if (!ticket || !specFile || !outputFile) throw new Error('Usage: node qa/criteria-manifest.mjs TICKET specs/file.md reports/TICKET-criteria.json');
    const manifest = buildManifest(ticket, readFileSync(specFile, 'utf8'));
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    console.log(`Manifest: ${manifest.criteria.map(({ id }) => id).join(', ')}`);
  } catch (error) {
    console.error(`Cannot build criteria manifest: ${error.message}`);
    process.exitCode = 1;
  }
}
