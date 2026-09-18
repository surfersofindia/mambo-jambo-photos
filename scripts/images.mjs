// Exports the responsive hero variants that index.html lists in the hero <img srcset> and its
// <link rel="preload" imagesrcset>. The outputs are committed next to the master (assets/ is copied
// verbatim by the build), so run this only when the master changes:  npm run images
// Width-only resize keeps the master's aspect ratio; nothing is ever upscaled; metadata is stripped.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { root } from './site-files.mjs';
const EXPORTS = [
  // 768w is what a 375px-wide phone at 2x DPR picks from the srcset, so it carries the mobile
  // above-the-fold image budget (F20: under 120 KB at 375px). 1280w serves laptops; the 1920px
  // master stays for wide desktops.
  { source: 'assets/brand-surf-wide.webp', widths: [768, 1280], quality: 78, budgetBytes: { 768: 120 * 1024 } },
];
let failed = false;
for (const { source, widths, quality, budgetBytes = {} } of EXPORTS) {
  const master = sharp(fileURLToPath(new URL(source, root)));
  const { width: masterWidth, height: masterHeight } = await master.metadata();
  console.log(`${source}: ${masterWidth}×${masterHeight}`);
  for (const width of widths) {
    const target = source.replace(/\.webp$/, `-${width}.webp`);
    const info = await master.clone().resize({ width, withoutEnlargement: true }).webp({ quality, effort: 6, smartSubsample: true }).toFile(fileURLToPath(new URL(target, root)));
    const budget = budgetBytes[width];
    const over = budget && info.size > budget;
    if (over) failed = true;
    console.log(`  → ${target}: ${info.width}×${info.height}, ${info.size} bytes (${(info.size / 1024).toFixed(1)} KB)${budget ? ` — budget ${budget / 1024} KB ${over ? 'EXCEEDED' : 'ok'}` : ''}`);
  }
}
if (failed) { console.error('A hero variant is over its byte budget; lower the quality or width in scripts/images.mjs.'); process.exit(1); }
