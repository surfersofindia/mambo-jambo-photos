// Builds the production website into dist/ from the public files listed in site-files.mjs.
// Every JS and CSS file is fingerprinted with an 8-hex content hash (app.js → app.3f2a1b7c.js) and
// the references in the copied HTML, CSS (url()/@import) and JS (string literals such as
// new Worker('preview-worker.js')) are rewritten to the hashed names, dependencies first so a
// renamed dependency changes the hash of everything that names it. The hosts send
// `Cache-Control: public, max-age=31536000, immutable` for the hashed pattern (.htaccess for
// Hostinger, vercel.json for Vercel) while HTML stays `no-cache, must-revalidate`, so a deploy is
// picked up on the next page load and everything else is cached forever. Hostinger must therefore
// be deployed from dist/, never from the source tree.
// Source files keep their plain names so `npm run dev` and the tests keep working on the tree.
// Images and soi-stamps.svg are copied unhashed: <use href="soi-stamps.svg#…"> and the hero srcset
// candidates must keep resolving by their plain names. .htaccess is copied verbatim.
// The build self-verifies: after writing it re-reads every HTML and CSS file in dist/ and exits 1
// if any local reference (src, href, srcset, imagesrcset, url(), @import) points at a file that is
// not in dist/ — the dist/ counterpart of the source-tree check in tests/site.test.mjs.
import { mkdir, copyFile, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, posix, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, siteFiles, versionInfo } from './site-files.mjs';

const output = new URL('dist/', root);
const HASHABLE = /\.(js|css)$/i; // .htaccess, images and soi-stamps.svg never match
// A service worker must keep one stable URL across deploys (the browser re-fetches it by name and
// compares bytes), so sw.js is copied unfingerprinted; the build injects the hashed shell list into it
// instead — see injectPrecache(). Anything listed here also stays untouched in JS string literals,
// which is what keeps pwa.js's `register('sw.js')` pointing at the copied file.
const STABLE = new Set(['sw.js']);
const PRECACHE_EXT = /\.(?:html|m?js|css|woff2|svg)$/i; // the app shell: no photos, no lazy-loaded bundles
const PRECACHE_BUDGET = 400 * 1024;                     // raw bytes downloaded on a first visit (reported)
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|%23|\/?api\/)/i; // https:, data:, mailto:, tel:, blob:, protocol-relative, fragments (also %23-encoded ones inside data: SVGs), the proxied API
const SCRIPT_BUDGET_GZIP = 40 * 1024; // program target: JS under 40 KB compressed per page (reported, gated by Lighthouse CI)
const HTML_ATTR = /(?<=\s)(src|href|imagesrcset|srcset)=(?:"([^"]*)"|'([^']*)')/g;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]+))\s*\)/g; // a quoted value is consumed whole, so a url() nested inside a data: SVG is never seen on its own
const CSS_IMPORT = /@import\s+(["'])([^"']+)\1/g;
const JS_PATH_STRING = /(["'`])((?:\.\/)?[\w-]+(?:\/[\w-]+)*\.(?:m?js|css))\1/g; // whole string literals that name a site file

const kindOf = file => /\.html$/i.test(file) ? 'html' : /\.css$/i.test(file) ? 'css' : /\.m?js$/i.test(file) ? 'js' : null;
const localPath = file => fileURLToPath(new URL(file, root));
const distPath = file => fileURLToPath(new URL(file, output));
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;

// The site path a reference from `from` (e.g. index.html) points at, or null when it is external.
// Mirrors the dev server and both hosts: "/" is index.html and "/admin" is admin.html.
function localTarget(ref, from) {
  if (!ref || EXTERNAL.test(ref)) return null;
  const path = ref.split(/[?#]/, 1)[0];
  if (!path) return null;
  if (path === '/') return 'index.html';
  if (path === '/admin') return 'admin.html';
  return path.startsWith('/') ? path.slice(1) : posix.normalize(posix.join(posix.dirname(from), path));
}

// The same reference with its path swapped for the hashed name, keeping the "/" or "./" prefix and any ?query/#fragment.
function rewriteRef(ref, from, renames) {
  const target = localTarget(ref, from);
  const renamed = target && renames.get(target);
  if (!renamed) return ref;
  const path = ref.split(/[?#]/, 1)[0];
  const prefix = path.startsWith('/') ? '/' : path.startsWith('./') ? './' : '';
  return prefix + (prefix === '/' ? renamed : posix.relative(posix.dirname(from), renamed)) + ref.slice(path.length);
}

// Walk every reference of one kind of file, letting `visit` replace each one (identity when only collecting).
const walkSrcset = (value, visit) => value.split(',').map(candidate => candidate.replace(/^(\s*)(\S+)/, (m, space, url) => space + visit(url))).join(',');
const walkers = {
  css: (text, visit) => text.replace(CSS_URL, (m, doubleQuoted, singleQuoted, bare) => { const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : ''; return `url(${quote}${visit((doubleQuoted ?? singleQuoted ?? bare).trim())}${quote})`; }).replace(CSS_IMPORT, (m, quote, ref) => `@import ${quote}${visit(ref)}${quote}`),
  html: (text, visit) => walkers.css(text.replace(HTML_ATTR, (m, attr, doubleQuoted, singleQuoted) => {
    const quote = doubleQuoted === undefined ? "'" : '"';
    const value = doubleQuoted ?? singleQuoted;
    return `${attr}=${quote}${/srcset$/.test(attr) ? walkSrcset(value, visit) : visit(value)}${quote}`;
  }), visit),
  js: (text, visit) => text.replace(JS_PATH_STRING, (m, quote, ref) => quote + visit(ref) + quote),
};
const collect = (text, kind, from) => { const refs = []; walkers[kind](text, ref => { const target = localTarget(ref, from); if (target) refs.push(target); return ref; }); return refs; };
const rewrite = (text, kind, from, renames) => walkers[kind](text, ref => rewriteRef(ref, from, renames));

// The app-shell files sw.js precaches at install: every guest-facing page, what its markup names
// (scripts, stylesheets, the stamp sprite, the manifest) and what those stylesheets name (the web
// fonts). Photos, the lazy vendored face-api bundle (it is named from a string inside app.js, never
// from markup) and admin.html's 190 KB of studio JS stay out — those are runtime-cached if and when a
// visitor actually asks for them, so a guest's first visit does not pay for the crew's tools.
function shellFiles(files, fileSet, sources) {
  const shell = new Set();
  // admin.html is never precached, not even as the crew link the text pages carry: the studio is a
  // runtime-cached page for the few devices that open it, not part of a guest's shell.
  const add = file => { if (fileSet.has(file) && PRECACHE_EXT.test(file) && !STABLE.has(file) && file !== 'admin.html') shell.add(file); };
  for (const entry of files) {
    if (kindOf(entry) !== 'html' || entry === 'admin.html') continue;
    add(entry);
    for (const ref of collect(sources.get(entry), 'html', entry)) {
      add(ref);
      if (kindOf(ref) === 'css' && sources.has(ref)) for (const nested of collect(sources.get(ref), 'css', ref)) add(nested);
    }
  }
  if (fileSet.has('manifest.webmanifest')) shell.add('manifest.webmanifest');   // 0.7 KB, and an install needs it
  return shell;
}

async function build() {
  const files = await siteFiles();
  const fileSet = new Set(files);
  const sources = new Map();
  for (const file of files) if (kindOf(file)) sources.set(file, await readFile(localPath(file), 'utf8'));

  // Fingerprint dependencies first so a renamed dependency is written into its dependents before they are hashed.
  const renames = new Map(), built = new Map(), visiting = new Set();
  function finalize(file) {
    if (renames.has(file)) return;
    if (visiting.has(file)) throw new Error(`Circular reference between fingerprinted files involving ${file}`);
    visiting.add(file);
    const kind = kindOf(file);
    for (const dep of collect(sources.get(file), kind, file)) if (dep !== file && HASHABLE.test(dep) && !STABLE.has(dep) && fileSet.has(dep)) finalize(dep);
    const text = rewrite(sources.get(file), kind, file, renames);
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 8);
    const renamed = file.replace(/\.(js|css)$/i, `.${hash}.$1`);
    renames.set(file, renamed);
    built.set(renamed, text);
    visiting.delete(file);
  }
  for (const file of files) if (HASHABLE.test(file) && !STABLE.has(file)) finalize(file);

  await rm(output, { recursive: true, force: true });
  for (const file of files) {
    const target = renames.get(file) || file;
    await mkdir(dirname(distPath(target)), { recursive: true });
    if (renames.has(file)) await writeFile(distPath(target), built.get(target));
    else if (kindOf(file) === 'html') await writeFile(distPath(target), rewrite(sources.get(file), 'html', file, renames));
    else await copyFile(localPath(file), distPath(target));
  }

  // version.json is generated, not copied: it names the exact commit this dist/ was built from, so a
  // deploy can be verified against the release tag it shipped (docs/runbook.md §11 / PART B step 6).
  await writeFile(distPath('version.json'), JSON.stringify(await versionInfo(), null, 2));

  // The service worker keeps a stable URL, so it cannot be fingerprinted: the build writes the hashed
  // shell list into the copy in dist/ instead. `buildId` is a hash of that list, which is what names
  // the cache — a deploy that changes any shell file therefore drops the previous build's cache.
  const shell = shellFiles(files, fileSet, sources);
  const precache = [...shell].map(file => `/${renames.get(file) || file}`).sort();
  let precacheBytes = 0;
  for (const file of shell) precacheBytes += renames.has(file) ? Buffer.byteLength(built.get(renames.get(file))) : (await readFile(localPath(file))).length;
  if (fileSet.has('sw.js')) {
    const source = await readFile(distPath('sw.js'), 'utf8');
    const buildId = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 8);
    const injected = source.replace(/^self\.__PRECACHE__ = .*$/m, `self.__PRECACHE__ = ${JSON.stringify({ build: buildId, files: precache })};`);
    if (injected === source) throw new Error('sw.js has no `self.__PRECACHE__ = …` placeholder line for the shell list');
    await writeFile(distPath('sw.js'), injected);
  }

  // Self-verification: every local reference in every HTML and CSS file of dist/ must exist in dist/.
  const distRoot = fileURLToPath(output);
  const distFiles = new Set((await readdir(distRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => relative(distRoot, join(entry.parentPath, entry.name)).split('\\').join('/')));
  const problems = [];
  for (const renamed of renames.values()) if (!distFiles.has(renamed)) problems.push(`${renamed} was not written`);
  for (const file of distFiles) {
    const kind = kindOf(file);
    if (kind !== 'html' && kind !== 'css') continue;
    for (const target of collect(await readFile(distPath(file), 'utf8'), kind, file)) if (!distFiles.has(target)) problems.push(`${file} references ${target}, which is not in dist/`);
  }
  // …and so must every file the service worker precaches and every icon the manifest names: both are
  // fetched by URL from JSON, which the reference walkers above never see.
  for (const path of precache) if (!distFiles.has(path.slice(1))) problems.push(`sw.js precaches ${path}, which is not in dist/`);
  if (distFiles.has('manifest.webmanifest')) {
    const manifest = JSON.parse(await readFile(distPath('manifest.webmanifest'), 'utf8'));
    for (const icon of manifest.icons || []) if (!distFiles.has(icon.src.replace(/^\//, ''))) problems.push(`manifest.webmanifest names icon ${icon.src}, which is not in dist/`);
  }
  if (problems.length) throw new Error(`dist/ verification failed:\n  ${problems.join('\n  ')}`);

  // Report: hashed names, raw and gzip sizes, and each page's compressed script weight against the program budget.
  for (const [file, renamed] of renames) {
    const text = built.get(renamed);
    console.log(`${file} → ${renamed}  (${kb(Buffer.byteLength(text))} raw, ${kb(gzipSync(text, { level: 9 }).length)} gzip)`);
  }
  for (const file of files) {
    if (kindOf(file) !== 'html') continue;
    const scripts = [...new Set(collect(sources.get(file), 'html', file))].filter(target => /\.m?js$/i.test(target) && renames.has(target));
    const gzip = scripts.reduce((total, target) => total + gzipSync(built.get(renames.get(target)), { level: 9 }).length, 0);
    console.log(`${file}: ${scripts.length} scripts, ${kb(gzip)} gzip${gzip > SCRIPT_BUDGET_GZIP ? ` — WARNING: over the ${kb(SCRIPT_BUDGET_GZIP)} compressed JS budget` : ''}`);
  }
  console.log(`sw.js precaches ${precache.length} shell files (${kb(precacheBytes)} raw)${precacheBytes > PRECACHE_BUDGET ? ` — WARNING: over the ${kb(PRECACHE_BUDGET)} first-visit precache budget` : ''}`);
  console.log(`Production website built in dist/ (public assets only): ${distFiles.size} files, ${renames.size} fingerprinted, every local reference verified.`);
}

try { await build(); } catch (error) { console.error(error.message); process.exit(1); }
