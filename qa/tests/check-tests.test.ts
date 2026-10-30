import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { scanFiles } from '../check-tests.ts';

test('disabled Playwright cases in nested projects are scanned', () => {
  const root = mkdtempSync(join(tmpdir(), 'qa-test-scan-'));
  try {
    const file = join(root, 'examples/server-console/e2e/TICKET-42.spec.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "test." + "skip('disabled', () => {});\n");
    assert.deepEqual(scanFiles([file]), [`${file}:1: disabled or focused test`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
