import { readdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const root = new URL('../', import.meta.url);
// { version, commit, builtAt }: version.json is generated, not a source file, so it is served and
// written specially by the dev server and the build instead of living in the siteFiles() allowlist.
// Falls back to "unknown" for version/commit rather than throwing: tests/pwa.test.mjs builds in an
// isolated temp copy with no package.json or .git, to exercise the service-worker build in isolation.
export async function versionInfo() {
  let version = 'unknown';
  try { version = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).version; } catch {}
  let commit = 'unknown';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: fileURLToPath(root), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  return { version, commit, builtAt: new Date().toISOString() };
}
export async function siteFiles() {
  const assets = (await readdir(new URL('assets/', root), { withFileTypes: true }))
    .filter(entry => entry.isFile() && /\.(png|jpg|jpeg|webp|svg|ico)$/i.test(entry.name))
    .map(entry => `assets/${entry.name}`);
  // Self-hosted web fonts (wave 2, F19) live one level down; licences ship with them.
  const fonts = (await readdir(new URL('assets/fonts/', root), { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile() && /\.(woff2|txt)$/i.test(entry.name))
    .map(entry => `assets/fonts/${entry.name}`);
  assets.push(...fonts);
  // Guided-selfie face detection (vendored face-api.js tiny_face_detector) lazy-loads these; the
  // shard file has no extension by upstream convention, so this folder is a plain allowlist rather
  // than an extension filter like the ones above.
  const faceModels = (await readdir(new URL('assets/face-models/', root), { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isFile())
    .map(entry => `assets/face-models/${entry.name}`);
  assets.push(...faceModels);
  // sw.js and manifest.webmanifest are PWA files (wave 4, W4-B): both must keep their plain names in
  // dist/ — a service worker needs a stable URL and the manifest is named by a <link> — so the build
  // copies them unfingerprinted and injects the precache list into sw.js.
  return ['index.html', 'admin.html', 'about.html', 'contact.html', 'terms.html', 'refund-policy.html', 'app.js', 'admin.js', 'preview-worker.js', 'pwa.js', 'sw.js', 'config.js', 'site.css', 'premium.css', 'effects.js', 'nav.js', 'soi-fx.js', 'admin-theme.css', 'soi-brand.css', 'soi-tokens.css', 'soi-stamps.svg', 'manifest.webmanifest', '.htaccess', 'assets/face-api.js', ...assets];
}
