import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// scripts/accuracy.mjs replicates the /api/match ranking (similarity, threshold, cap, confirmed-link
// discount) so a crew-labelled session can be scored offline. Its --selftest runs the real handler on
// the bundled fixture and requires identical output, so running it under `npm test` turns a silent
// drift between the replica and worker.js into a failing check. Takes well under a second.
test('scripts/accuracy.mjs self-test passes and agrees with worker.js', () => {
  // fileURLToPath, not URL.pathname: the repo path has spaces, which pathname percent-encodes.
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/accuracy.mjs', import.meta.url)), '--selftest'], { encoding: 'utf8' });
  assert.match(out, /selftest ok: 8 queries, 16 thresholds, worker\.js \/api\/match agrees/);
});
// The Worker now exports similarity() itself (W3-D's request): the replica must be the same function
// in behaviour, including its -1 for mismatched or non-array input.
test('the accuracy script\'s similarity replica agrees with the similarity worker.js exports', async () => {
  const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  const { similarity: shipped } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const { similarity: replica } = await import('../scripts/accuracy.mjs');
  assert.equal(typeof shipped, 'function');
  for (const [a, b] of [[[1, 0], [1, 0]], [[1, 0], [0, 1]], [[0.3, 0.4, 0.5], [0.5, 0.4, 0.3]], [[1, 2, 3], [-1, -2, -3]], [[1, 0], [1, 0, 0]], [[1, 0], 'no'], [null, [1]]]) {
    assert.equal(shipped(a, b), replica(a, b), JSON.stringify([a, b]));
  }
  assert.equal(shipped([1, 0], [1, 0, 0]), -1); assert.ok(Math.abs(shipped([0.3, 0.4, 0.5], [0.5, 0.4, 0.3]) - 0.92) < 1e-9, 'cosine: 0.46 / 0.5');
});
