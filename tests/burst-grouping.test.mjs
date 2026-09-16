import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const { burstGroups } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('consecutive photos within the gap merge into one burst', () => {
  const photos = [
    { id: 'a', capturedAt: '2026-09-15T08:30:00.000Z' },
    { id: 'b', capturedAt: '2026-09-15T08:30:01.000Z' },
    { id: 'c', capturedAt: '2026-09-15T08:30:02.500Z' },
  ];
  assert.deepEqual(burstGroups(photos, 2).map(g => g.ids), [['a', 'b', 'c']]);
});

test('a gap beyond the threshold starts a new burst', () => {
  const photos = [
    { id: 'a', capturedAt: '2026-09-15T08:30:00.000Z' },
    { id: 'b', capturedAt: '2026-09-15T08:30:01.000Z' },
    { id: 'c', capturedAt: '2026-09-15T08:30:10.000Z' },
    { id: 'd', capturedAt: '2026-09-15T08:30:11.000Z' },
  ];
  assert.deepEqual(burstGroups(photos, 2).map(g => g.ids), [['a', 'b'], ['c', 'd']]);
});

test('single photos with no neighbor within the gap are not a burst', () => {
  const photos = [
    { id: 'a', capturedAt: '2026-09-15T08:30:00.000Z' },
    { id: 'b', capturedAt: '2026-09-15T08:31:00.000Z' },
    { id: 'c', capturedAt: '2026-09-15T08:32:00.000Z' },
  ];
  assert.deepEqual(burstGroups(photos, 2), []);
});

test('null and unparsable timestamps are skipped without breaking the surrounding burst', () => {
  const photos = [
    { id: 'a', capturedAt: '2026-09-15T08:30:00.000Z' },
    { id: 'ghost', capturedAt: null },
    { id: 'bad', capturedAt: 'not-a-date' },
    { id: 'b', capturedAt: '2026-09-15T08:30:01.000Z' },
  ];
  assert.deepEqual(burstGroups(photos, 2).map(g => g.ids), [['a', 'b']]);
});

test('gap threshold is configurable', () => {
  const photos = [
    { id: 'a', capturedAt: '2026-09-15T08:30:00.000Z' },
    { id: 'b', capturedAt: '2026-09-15T08:30:04.000Z' },
  ];
  assert.deepEqual(burstGroups(photos, 2), []);
  assert.deepEqual(burstGroups(photos, 5).map(g => g.ids), [['a', 'b']]);
});
