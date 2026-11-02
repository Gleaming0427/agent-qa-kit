// Runs with Node 22 built-in type stripping, no npm/React dependency required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const file = resolve(import.meta.dirname, '../../examples/shop/src/cart.ts');
test('core cart behavior: buggy -> fixed -> buggy gives fail/pass/fail', () => {
  const code = `import {subtotal, subtotalBuggy} from ${JSON.stringify('file://' + file)};
    const lines = [{productId: 'notebook', quantity: 2}, {productId: 'pen-set', quantity: 1}];
    const pass = (fn) => fn(lines) === 1500;
    console.log(JSON.stringify([pass(subtotalBuggy), pass(subtotal), pass(subtotalBuggy)]));`;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [false, true, false]);
});
