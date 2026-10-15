// Servidor de pruebas de Espais electorals: sirve public/ y la función /api/* con un almacén en memoria
// que imita Netlify Blobs (datos y copias en almacenes separados). No toca nunca los datos reales.
//   PORT=8899  puerto
//   LAT=60     latencia simulada del almacén en milisegundos (prueba de carga)
//   STORE=…    archivo .json para conservar el almacén entre arranques (opcional)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = process.env.CORE || path.join(ROOT, 'netlify/functions/api/core.mjs');
const PUB = process.env.PUB || path.join(ROOT, 'public');
const TOML = process.env.TOML || path.join(ROOT, 'netlify.toml');
const PORT = +process.env.PORT || 8899, STORE = process.env.STORE || '';
const { makeHandler } = await import(pathToFileURL(CORE).href);
const M = new Map();
if (STORE && fs.existsSync(STORE)) { const o = JSON.parse(fs.readFileSync(STORE, 'utf8')); for (const [k, v] of Object.entries(o)) M.set(k, v); }
let saveT = null;
const save = () => { if (!STORE) return; clearTimeout(saveT); saveT = setTimeout(() => fs.writeFileSync(STORE, JSON.stringify(Object.fromEntries(M))), 50); };
const LAT = +process.env.LAT || 0, lag = () => (LAT ? new Promise((r) => setTimeout(r, LAT * (0.5 + Math.random()))) : null);
let OPS = 0;
function memStore(prefix) {
  return {
    async get(k, o) { OPS++; await lag(); k = prefix + k; if (!M.has(k)) return null; const v = M.get(k); return o && o.type === 'json' ? JSON.parse(v) : v; },
    async setJSON(k, v, o) { OPS++; await lag(); k = prefix + k; if (o && o.onlyIfNew && M.has(k)) return { modified: false }; M.set(k, JSON.stringify(v)); save(); return { modified: true }; },
    async list({ prefix: p }) { OPS++; await lag(); const full = prefix + p; return { blobs: [...M.keys()].filter((k) => k.startsWith(full)).map((k) => ({ key: k.slice(prefix.length) })) }; },
    async delete(k) { M.delete(prefix + k); save(); }
  };
}
const handler = makeHandler({ store: memStore('D/'), backup: memStore('C/'), env: { ESPAIS_CLAVE_INICIAL: 'clave-prueba' } });
const csp = (/Content-Security-Policy = "([^"]+)"/.exec(fs.readFileSync(TOML, 'utf8')) || [])[1] || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/__ops') { res.end(String(OPS)); return; }
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handler(new Request(u, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const f = path.join(PUB, path.normalize(u.pathname === '/' ? 'index.html' : u.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'content-security-policy': csp }); res.end(fs.readFileSync(f));
}).listen(PORT, () => console.log('Servidor de pruebas en http://localhost:' + PORT + (LAT ? ' (latencia ' + LAT + ' ms)' : '')));
