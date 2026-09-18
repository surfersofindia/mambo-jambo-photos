import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname } from 'node:path';
import { root, siteFiles, versionInfo } from './site-files.mjs';
const allowed = new Set(await siteFiles());
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/api/')) {
      const headers = { ...request.headers, host: 'mambo-jambo-photo-api.surfersofindia.workers.dev' };
      delete headers.origin;
      const upstream = httpsRequest(new URL(request.url, 'https://mambo-jambo-photo-api.surfersofindia.workers.dev'), { method: request.method, headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Photo service unavailable. Please try again.' })); });
      request.pipe(upstream);
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : path.slice(1);
    if (file === 'version.json') {
      const body = Buffer.from(JSON.stringify(await versionInfo()));
      response.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    if (!allowed.has(file)) { response.writeHead(404); response.end('Not found'); return; }
    const content = await readFile(new URL(file, root));
    // gzip text assets when the client accepts it, so Lighthouse's transfer-size budgets (W1-E) measure what production serves.
    const gzip = /\.(html|js|css|svg)$/.test(file) && /\bgzip\b/.test(request.headers['accept-encoding'] || '');
    const body = gzip ? gzipSync(content) : content;
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': body.length, ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(400); response.end('Invalid request'); }
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
