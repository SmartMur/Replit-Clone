#!/usr/bin/env node
// Tiny static server for testing an export locally: applies _headers, gzip/brotli, correct MIME types.
// Usage: node scripts/serve-dist.mjs <dir> [port]   (binds 127.0.0.1 only)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const dir = path.resolve(process.argv[2] ?? 'dist');
const port = Number(process.argv[3] ?? 4500);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
const rules = []; // [{ pattern, headers }]
try {
  let cur = null;
  for (const line of (await readFile(path.join(dir, '_headers'), 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    if (!line.startsWith(' ')) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); }
    else { const i = line.indexOf(':'); cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
} catch {}
const match = (pattern, url) => pattern === '/*' || (pattern.endsWith('/*') && url.startsWith(pattern.slice(0, -1)));

http.createServer(async (req, res) => {
  let url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';
  const file = path.resolve(dir, '.' + url);
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error('nf');
    let body = await readFile(file);
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
    for (const r of rules) if (match(r.pattern, url)) Object.assign(headers, r.headers);
    delete headers['Strict-Transport-Security']; // localhost is http
    const ae = req.headers['accept-encoding'] ?? '';
    if (/^(text|application)\/(html|css|javascript|json|xml)|svg/.test(headers['Content-Type'])) {
      if (ae.includes('br')) { body = zlib.brotliCompressSync(body); headers['Content-Encoding'] = 'br'; }
      else if (ae.includes('gzip')) { body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; }
      headers['Vary'] = 'Accept-Encoding';
    }
    res.writeHead(200, headers).end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
