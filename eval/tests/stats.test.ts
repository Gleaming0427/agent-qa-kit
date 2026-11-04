import assert from 'node:assert/strict';
import test from 'node:test';
import { binom, clusteredStandardError, passAtK, passHatK, percentile, wilson } from '../lib/stats.ts';

const close = (actual: number | null, expected: number, digits = 4) => assert.equal(actual === null ? null : Number(actual.toFixed(digits)), expected);

test('binomial coefficients', () => {
  assert.equal(binom(5, 2), 10);
  assert.equal(binom(3, 3), 1);
  assert.equal(binom(3, 4), 0);
  assert.equal(binom(30, 15), 155117520);
});

test('Wilson interval matches reference values and stays inside [0, 1]', () => {
  const w = wilson(8, 10);
  close(w.rate, 0.8);
  close(w.low, 0.4902);
  close(w.high, 0.9433);
  close(wilson(0, 10).low, 0);
  close(wilson(0, 10).high, 0.2775);
  close(wilson(10, 10).low, 0.7225);
  close(wilson(10, 10).high, 1);
  assert.equal(wilson(0, 0).rate, null);
});

test('pass@k and pass^k use the combinatorial estimators', () => {
  close(passAtK(5, 3, 2), 0.9);
  close(passHatK(5, 3, 2), 0.3);
  assert.equal(passHatK(3, 3, 3), 1);
  assert.equal(passHatK(3, 2, 3), 0);
  assert.equal(passAtK(3, 1, 3), 1);
  assert.equal(passHatK(2, 2, 3), null);
});

test('clustered standard error grows when trials of a ticket agree with each other', () => {
  // Ticket A always succeeds, ticket B always fails: only 2 independent clusters.
  const clustered = clusteredStandardError([
    { cluster: 'A', value: 1 }, { cluster: 'A', value: 1 },
    { cluster: 'B', value: 0 }, { cluster: 'B', value: 0 },
  ]);
  close(clustered, 0.3536);
  // The naive i.i.d. standard error would be sqrt(0.25 / 4) = 0.25.
  assert.ok(clustered! > 0.25);
  assert.equal(clusteredStandardError([{ cluster: 'A', value: 1 }, { cluster: 'A', value: 0 }]), null);
});

test('percentiles interpolate between ranks', () => {
  close(percentile([4, 1, 3, 2], 50), 2.5);
  close(percentile([1, 2, 3, 4], 95), 3.85);
  assert.equal(percentile([], 50), null);
});

test('the exact sign test matches the binomial distribution', async () => {
  const { signTest, mcnemarExact } = await import('../lib/stats.ts');
  assert.deepEqual(signTest(0, 0), { n: 0, plus: 0, minus: 0, p: 1, min_p: 1 });
  // All in one direction: 2 x 0.5^n.
  assert.equal(signTest(5, 0).p, 0.0625);
  assert.equal(signTest(0, 6).p, 0.03125);
  assert.equal(signTest(5, 0).min_p, 0.0625);
  // 3 against 1: 2 x (C(4,0) + C(4,1)) / 16.
  assert.equal(signTest(3, 1).p, 0.625);
  // 10 against 2: 2 x (1 + 12 + 66) / 4096.
  assert.ok(Math.abs(signTest(10, 2).p - 158 / 4096) < 1e-12);
  // Balanced: capped at 1.
  assert.equal(signTest(2, 2).p, 1);
  // McNemar: the same test on the discordant pairs, whichever way they are given.
  assert.equal(mcnemarExact(0, 6).p, 0.03125);
  assert.equal(mcnemarExact(1, 3).p, mcnemarExact(3, 1).p);
});
