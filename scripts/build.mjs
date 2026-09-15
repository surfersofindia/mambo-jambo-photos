import { mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, siteFiles } from './site-files.mjs';
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });
for (const file of await siteFiles()) {
  const destination = new URL(file, output);
  await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
  await copyFile(new URL(file, root), destination);
}
console.log('Production website built in dist/ (public assets only).');
