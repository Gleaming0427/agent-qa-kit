// Runs with Node 22 built-in type stripping, no npm/React dependency required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../examples/server-console/src/search.ts');
test('core search behavior: buggy -> fixed -> buggy gives fail/pass/fail', () => {
  const code = `import {SERVICES, filterServices, filterServicesBuggy} from ${JSON.stringify('file://' + file)};
    const expected = 'Alpha';
    const pass = (fn) => fn(SERVICES, 'ALPHA').map(x=>x.name).join(',') === expected;
    console.log(JSON.stringify([pass(filterServicesBuggy),pass(filterServices),pass(filterServicesBuggy)]));`;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [false, true, false]);
});
