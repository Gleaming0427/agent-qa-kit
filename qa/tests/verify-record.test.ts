import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readOutcomes, recordMarkdown, runId, trackRecord } from '../verify-record.ts';
import type { Outcome } from '../verify-record.ts';

const kit = resolve(import.meta.dirname, '../..');
const outcome = (pr: number, step: Outcome['step'], result: Outcome['result'], over: Partial<Outcome> = {}): Outcome => ({
  at: '2026-11-05T10:00:00Z', mode: 'advisory', pr: String(pr), sha: `sha${pr}000000`, ticket: 'TICKET-1', step, result,
  detail: result === 'pass' ? 'ok' : 'code 1', agent: 'a1b2c3d', ...over,
});
// Ten pull requests: every check passed, but on #3 the suite would have blocked.
const outcomes = Array.from({ length: 10 }, (_, i) => i + 1).flatMap((pr) => [
  outcome(pr, 'prepare', 'pass'), outcome(pr, 'agent', 'pass'), outcome(pr, 'suite', pr === 3 ? 'fail' : 'pass'),
]);

test('the track record counts runs and failures, and is ready only with no false block and nothing unlabeled', () => {
  const id = runId(outcomes[6]);
  assert.equal(id, '3:sha3000:TICKET-1');
  let t = trackRecord(outcomes);
  assert.deepEqual([t.runs, t.pull_requests, t.failed_runs.map((r) => r.id)], [10, 10, [id]]);
  assert.deepEqual(t.by_step.suite, { pass: 9, fail: 1 });
  assert.deepEqual(t.by_agent, { a1b2c3d: { runs: 10, failed: 1 } });
  assert.equal(t.ready_to_block, false);
  assert.deepEqual(t.reasons, ['1 failure(s) not labeled yet']);
  assert.equal(trackRecord(outcomes, { [id]: 'caught' }).ready_to_block, true);
  t = trackRecord(outcomes, { [id]: 'false_block' });
  assert.equal(t.ready_to_block, false);
  assert.match(t.reasons[0], /1 false block/);
  assert.match(trackRecord(outcomes, { [id]: 'caught' }, 20).reasons[0], /10 pull request\(s\) checked, 20 needed/);
  assert.throws(() => trackRecord(outcomes, { [id]: 'maybe' as never }), /must be "false_block" or "caught"/);
  const markdown = recordMarkdown(trackRecord(outcomes), {});
  assert.match(markdown, /\*\*Ready to block: not yet\.\*\*/);
  assert.match(markdown, /\| `3:sha3000:TICKET-1` \| advisory \| suite: code 1 \| to label \|/);
});

test('the command line reads the downloaded records and exits 0 only when the check is ready to block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-verify-record-'));
  try {
    writeFileSync(join(dir, 'qa-verify-record.jsonl'), `${outcomes.map((o) => JSON.stringify(o)).join('\n')}\n`);
    assert.equal(readOutcomes([dir]).length, 30);
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(kit, 'qa/verify-record.ts'), ...args], { encoding: 'utf8' });
    let r = cli(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /10 run\(s\) on 10 pull request\(s\)/);
    writeFileSync(join(dir, 'labels.json'), JSON.stringify({ '3:sha3000:TICKET-1': 'caught' }));
    r = cli('--labels', join(dir, 'labels.json'), dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Ready to block: yes\.\*\* Every failure was a real problem/);
    writeFileSync(join(dir, 'bad.jsonl'), '{"ticket":"T-1","step":"deploy","result":"pass"}\n');
    assert.equal(cli(dir).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
