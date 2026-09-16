import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { root, siteFiles } from '../scripts/site-files.mjs';
test('deployment includes only public assets, with all local page references present', async () => {
  const files = new Set(await siteFiles());
  for (const privateFile of ['.env.local', '.dev.vars', 'worker.js', 'schema.sql', 'package.json', 'README.md', 'face-api/main.py']) assert.equal(files.has(privateFile), false);
  for (const page of ['index.html', 'admin.html']) {
    const html = await readFile(new URL(page, root), 'utf8');
    for (const [, path] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
      if (/^(https?:|data:|mailto:|tel:)/.test(path)) continue;
      assert.equal(files.has(path === '/' ? 'index.html' : path.split('#')[0].replace(/^\//, '')), true, `${page} references missing asset ${path}`);
    }
  }
});
test('guest script selectors resolve to unique elements', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const script = await readFile(new URL('app.js', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of script.matchAll(/\$\('#([\w-]+)'\)/g)) assert.ok(ids.includes(id), `Missing #${id}`);
});

test('crew controls and accessible tab panels have valid targets', async () => {
  const html = await readFile(new URL('admin.html', root), 'utf8');
  const script = await readFile(new URL('admin.js', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const [, id] of script.matchAll(/getElementById\('([\w-]+)'\)/g)) assert.ok(ids.includes(id), `Missing crew control #${id}`);
  for (const [, id] of html.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g)) assert.ok(ids.includes(id));
  assert.equal((html.match(/<dialog\b/g) || []).length, 3);
  assert.equal((html.match(/<\/dialog>/g) || []).length, 3);
});
