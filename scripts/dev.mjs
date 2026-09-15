import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { root, siteFiles } from './site-files.mjs';
const allowed = new Set(await siteFiles());
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path === '/' ? 'index.html' : path === '/admin' ? 'admin.html' : path.slice(1);
    if (!allowed.has(file)) { response.writeHead(404); response.end('Not found'); return; }
    const content = await readFile(new URL(file, root));
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(400); response.end('Invalid request'); }
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${server.address().port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
