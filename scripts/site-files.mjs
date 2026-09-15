import { readdir } from 'node:fs/promises';
export const root = new URL('../', import.meta.url);
export async function siteFiles() {
  const assets = (await readdir(new URL('assets/', root), { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(entry.name))
    .map(entry => `assets/${entry.name}`);
  return ['index.html', 'admin.html', 'app.js', 'admin.js', 'config.js', 'site.css', 'admin-theme.css', ...assets];
}
