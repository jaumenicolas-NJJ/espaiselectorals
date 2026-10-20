// Espais electorals · lógica del servidor (independiente de Netlify para poder probarla en local).
// Almacén principal: db (datos), auth (usuarios), meta (contadores para sondeo barato), cfg (secreto).
// Almacén de copias (aparte): hist/* copias completas, day/* copia diaria permanente, jr/* copia de cada modificación.
import { pbkdf2 as _pbkdf2, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const pbkdf2 = promisify(_pbkdf2);

const ROLES = ['admin', 'partido', 'consulta'];
const CATS = ['esp', 'ban', 'pan', 'pri'];
const CATN = { esp: 'Espacios electorales', ban: 'Banderolas', pan: 'Pancartas', pri: 'Prismas' };
const MODES = ['cerrado', 'turnos', 'libre'];
/* campos de cada tipo de elemento */
const IF = {
  esp: { s: { nom: 150, ot: 40, dir: 250, hor: 300, nota: 1000 }, n: [] },
  ban: { s: { nom: 150, tram: 200, nota: 1000 }, n: ['bf', 'pf'] },
  pan: { s: { lloc: 150, lim: 250, nota: 1000 }, n: [] },
  pri: { s: { lloc: 150, num: 80, nota: 1000 }, n: [] }
};
const GF = { sig: 40, nom: 200, col: 7, rep: 150, tel: 60, mail: 150, nota: 1000 };
const ITER = 210000;
const TOKEN_HOURS = 12;
const SNAP_EVERY = 10 * 60000;
const MAX_HIST = 300;
/* memoria de la función entre peticiones: Netlify reutiliza la misma instancia mientras hay actividad,
   así que el secreto, los usuarios y la última versión de los datos no se vuelven a pedir al almacén
   (que está en Frankfurt) si no han cambiado. Solo se usa para leer: las escrituras siempre van al almacén. */
const MEM = { secret: null, auth: null, authAt: 0, db: null };
const AUTH_TTL = 60000, DB_TTL = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const fail = (status, error, extra) => json(Object.assign({ error }, extra || {}), status);
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const str = (s, min, max) => typeof s === 'string' && s.trim().length >= min && s.length <= max;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => { const x = sha(a), y = sha(b); return timingSafeEqual(x, y); };
const newId = () => Date.now().toString(36) + randomBytes(4).toString('hex');
const intOr = (v, min, max) => (v == null || v === '' ? null : (Number.isInteger(+v) && +v >= min && +v <= max ? +v : NaN));
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function hashPw(pw, salt) { return (await pbkdf2(String(pw), salt, ITER, 32, 'sha256')).toString('base64'); }
const userOut = (id, u) => ({ id, name: u.name, role: u.role, mc: !!u.mc, party: u.party || '' });
const publicUsers = (auth, who) => Object.entries(auth.users).filter(([id, u]) => !u.x && (!who || who.u.role !== 'partido' || id === who.id)).map(([id, u]) => userOut(id, u));
const activeAdmins = (auth) => Object.values(auth.users).filter((u) => !u.x && u.role === 'admin').length;

/* ---------- reglas de turnos ---------- */
const slotOK = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}[MT]$/.test(s);
function effOrder(c) { const o = (c.order || []).slice(); return c.snake && (c.round || 1) % 2 === 0 ? o.reverse() : o; }
const curParty = (c) => (c && c.mode === 'turnos' && !c.done ? effOrder(c)[c.turn || 0] || null : null);
/* cuántos elementos puede tener cada partido: su cupo del reparto (si lo hay) o el máximo general (0 = sin límite) */
const lim = (c, g) => (c && c.cup && c.cup[g] != null ? c.cup[g] : c && c.max > 0 ? c.max : Infinity);
const METH = ['', 'prop', 'dhondt', 'igual'];
/* modo ensayo: lo que se elige mientras está activo es de prueba y se borra al terminar */
const ensOn = (db) => !!(db.E['s:ens'] && db.E['s:ens'].on);
function resetTurns(db, who, t, stamp) { for (const cat of CATS) { const c = db.E['c:' + cat]; if (!c || c.mode !== 'turnos') continue; const nc = Object.assign({}, c, { turn: 0, round: 1, used: 0, done: !(c.order || []).length }); settle(db, nc); stamp(db, 'c:' + cat, nc, who, t); } }
const TIPOS = ['generales', 'municipales', 'autonomicas', 'europeas'];
const XCATS = ['esp', 'ban', 'pan', 'pri', 'par'];
/* campos propios que añade el Ayuntamiento: definición en la configuración y valores en cada registro (xv) */
function xfOK(xf) {
  if (xf == null) return {};
  if (typeof xf !== 'object' || Array.isArray(xf)) return null;
  const o = {};
  for (const t in xf) {
    if (!XCATS.includes(t) || !Array.isArray(xf[t]) || xf[t].length > 15) return null;
    const ids = new Set();
    o[t] = [];
    for (const d of xf[t]) { if (!d || typeof d.id !== 'string' || !/^[a-z0-9]{1,12}$/.test(d.id) || ids.has(d.id) || typeof d.n !== 'string' || !d.n.trim() || d.n.length > 40) return null; ids.add(d.id); o[t].push(d.h ? { id: d.id, n: d.n.trim(), h: true } : { id: d.id, n: d.n.trim() }); }
  }
  return o;
}
function xvOK(xv) {
  if (xv == null) return {};
  if (typeof xv !== 'object' || Array.isArray(xv) || Object.keys(xv).length > 40) return null;
  const o = {};
  for (const k in xv) { const v = xv[k]; if (!/^[a-z0-9]{1,12}$/.test(k) || !(v == null || (typeof v === 'string' && v.length <= 500))) return null; if (v != null && v.trim() !== '') o[k] = v.trim(); }
  return o;
}
/* columnas de siempre que el Ayuntamiento puede quitar de la vista (la principal, nombre o lugar, siempre se ve; los datos se conservan) */
const HCOLS = { esp: ['ord', 'ot', 'dir', 'hor', 'nota'], ban: ['ord', 'tram', 'bf', 'pf', 'nota'], pan: ['ord', 'lim', 'nota'], pri: ['ord', 'num', 'nota'] };
function hcOK(hc) {
  if (hc == null) return {};
  if (typeof hc !== 'object' || Array.isArray(hc)) return null;
  const o = {};
  for (const t in hc) { if (!HCOLS[t] || !Array.isArray(hc[t]) || !hc[t].every((k) => HCOLS[t].includes(k))) return null; if (hc[t].length) o[t] = [...new Set(hc[t])]; }
  return o;
}
/* enlace con Eleccions: una clave de solo lectura con la que Eleccions trae el reparto (GET /api/reparto) */
const APP_VER = '1.8 · 20/10/2026';
const LINK_RE = /^Bearer (ee1_[\w-]{20,80})$/;
const PALETTE = ['#D32F2F', '#1E88E5', '#2E7D32', '#F9A825', '#6A1B9A', '#00838F', '#EF6C00', '#AD1457', '#5D4037', '#3949AB', '#7CB342', '#546E7A', '#C2185B', '#00897B', '#8E24AA', '#FB8C00'];
/* el reparto tal como ha quedado, con todos los datos de cada punto y de las candidaturas (también su contacto, porque Eleccions es
   del Ayuntamiento), las reglas de cada categoría y quién adjudicó cada cosa y cuándo. Lo elegido en un ensayo no se envía */
const DEF_METH = { esp: '', ban: 'prop', pan: 'prop', pri: 'prop' };
function repartoOut(db, t) {
  const E = db.E, c = E['s:conf'] && !E['s:conf'].x ? E['s:conf'] : {}, xf = c.xf || {};
  const ncmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'es', { numeric: true, sensitivity: 'base' });
  const P = [], I = { esp: [], ban: [], pan: [], pri: [] }, R = {};
  for (const k in E) {
    const e = E[k]; if (!e || e.x) continue;
    if (e.k === 'g') P.push(Object.assign({ id: k.slice(2) }, e));
    else if (e.k === 'i' && I[e.t]) I[e.t].push(Object.assign({ id: k.slice(2) }, e));
    else if (e.k === 'r' && !e.ens) (R[e.i] = R[e.i] || []).push(e);
  }
  P.sort((a, b) => ((a.ord == null ? 999 : a.ord) - (b.ord == null ? 999 : b.ord)) || ncmp(a.sig || a.nom, b.sig || b.nom));
  const live = new Set(P.map((p) => p.id));
  CATS.forEach((x) => I[x].sort((a, b) => ((a.ord == null ? 9999 : a.ord) - (b.ord == null ? 9999 : b.ord)) || ncmp(a.nom || a.lloc, b.nom || b.lloc)));
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const campos = (x, e) => { const o = {}; for (const d of xf[x] || []) if (!d.h && e.xv && e.xv[d.id]) o[d.n] = e.xv[d.id]; return o; };
  const comun = (x, e) => ({ nota: e.nota || '', no_disponible: !!e.nd, no_disponible_motivo: e.nd ? e.ndm || '' : '', campos: campos(x, e) });
  const quien = (r) => ({ partido: r.g, adjudicado_el: iso(r.ts), adjudicado_por: r.by || '' });
  const owner = (e) => { const r = (R[e.id] || []).find((x) => !x.slot && live.has(x.g)); return r ? quien(r) : { partido: null, adjudicado_el: null, adjudicado_por: '' }; };
  const franjas = (e, v) => Object.keys(e.blk || {}).filter((s) => e.blk[s] === v).sort().map((s) => ({ fecha: s.slice(0, 10), franja: s[10] }));
  const reglas = {};
  CATS.forEach((x) => { const r = E['c:' + x] && !E['c:' + x].x ? E['c:' + x] : {}, rm = c.rmeth || {}; reglas[x] = { modo: r.mode || 'cerrado', metodo: rm[x] != null ? rm[x] : DEF_METH[x], orden: (r.order || []).filter((g) => live.has(g)), por_turno: r.quota || 1, maximo: r.max || 0, cupos: Object.fromEntries(Object.entries(r.cup || {}).filter(([g]) => live.has(g))), terminada: !!r.done }; });
  return {
    formato: 'espaiselectorals-reparto', version: 1, generado: new Date(t).toISOString(),
    origen: { url: 'https://espaiselectorals.netlify.app', programa: 'Espais electorals', version: APP_VER },
    proceso: { titulo: c.tit || '', organismo: c.org || '', tipo: c.tipo || 'generales', votacion: c.dv || null, campanya_desde: c.d0 || null, campanya_hasta: c.d1 || null, instrucciones: c.nota || '', elecciones_referencia: c.rv || '', minimo_por_candidatura: c.rmin || 0 },
    partidos: P.map((p, i) => ({ id: p.id, siglas: p.sig || '', nombre: p.nom || '', color: p.col || PALETTE[i % PALETTE.length], orden: p.ord == null ? null : p.ord, representante: p.rep || '', telefono: p.tel || '', correo: p.mail || '', votos: p.vot == null ? null : p.vot, nota: p.nota || '', campos: campos('par', p) })),
    reglas,
    esp: I.esp.map((e) => Object.assign({ id: e.id, orden: e.ord == null ? null : e.ord, nombre: e.nom || '', tipo: e.ot || '', direccion: e.dir || '', horario: e.hor || '' }, comun('esp', e), {
      franjas_no_disponibles: franjas(e, 'nd'), franjas_con_restricciones: franjas(e, 'rs'),
      reservas: (R[e.id] || []).filter((r) => r.slot && live.has(r.g)).sort((a, b) => (a.slot < b.slot ? -1 : 1)).map((r) => Object.assign({ fecha: r.slot.slice(0, 10), franja: r.slot[10] }, quien(r)))
    })),
    ban: I.ban.map((e) => Object.assign({ id: e.id, orden: e.ord == null ? null : e.ord, calle: e.nom || '', tramo: e.tram || '', banderolas: e.bf == null ? null : e.bf, plafones: e.pf == null ? null : e.pf }, comun('ban', e), owner(e))),
    pan: I.pan.map((e) => Object.assign({ id: e.id, orden: e.ord == null ? null : e.ord, lugar: e.lloc || '', limites: e.lim || '' }, comun('pan', e), owner(e))),
    pri: I.pri.map((e) => Object.assign({ id: e.id, orden: e.ord == null ? null : e.ord, lugar: e.lloc || '', numero: e.num || '' }, comun('pri', e), owner(e)))
  };
}
function totals(db, t) { const n = {}; for (const k in db.E) { const e = db.E[k]; if (e.k === 'r' && !e.x && e.t === t) n[e.g] = (n[e.g] || 0) + 1; } return n; }
function freeLeft(db, t) {
  /* ¿queda algo libre en esta categoría? (para dar por terminada la selección) */
  const conf = db.E['s:conf'] || {}, days = [];
  if (t === 'esp' && isISO(conf.d0) && isISO(conf.d1)) for (let d = Date.parse(conf.d0 + 'T00:00:00Z'); d <= Date.parse(conf.d1 + 'T00:00:00Z') && days.length < 120; d += 86400000) days.push(new Date(d).toISOString().slice(0, 10));
  for (const k in db.E) {
    const e = db.E[k]; if (e.k !== 'i' || e.x || e.t !== t || e.nd) continue;
    if (t !== 'esp') { const r = db.E['r:' + k.slice(2)]; if (!r || r.x) return true; continue; }
    for (const d of days) for (const f of ['M', 'T']) { const s = d + f; if ((e.blk || {})[s] === 'nd') continue; const r = db.E['r:' + k.slice(2) + ':' + s]; if (!r || r.x) return true; }
  }
  return false;
}
function advance(db, c) {
  const n = (c.order || []).length; c.used = 0;
  if (!n) { c.done = true; return; }
  const tot = totals(db, c.t);
  for (let i = 0; i < n * 2 + 2; i++) {
    c.turn = (c.turn || 0) + 1;
    if (c.turn >= n) { c.turn = 0; c.round = (c.round || 1) + 1; }
    const g = effOrder(c)[c.turn];
    if (db.E['g:' + g] && !db.E['g:' + g].x && (tot[g] || 0) < lim(c, g)) { c.done = !freeLeft(db, c.t); return; }
  }
  c.done = true;
}

/* si el turno lo tiene un partido que ya no puede elegir (sin cupo, cupo completo o eliminado), pasa al siguiente que pueda */
function settle(db, c) {
  if (c.mode !== 'turnos' || c.done) return false;
  const g = curParty(c), tot = totals(db, c.t);
  if (g && db.E['g:' + g] && !db.E['g:' + g].x && (tot[g] || 0) < lim(c, g)) return false;
  advance(db, c);
  return true;
}

export function makeHandler({ store, backup, env = {}, now = () => Date.now(), mem = MEM }) {
  const bk = backup || store; /* las copias van a un almacén distinto del de los datos */
  /* escrituras que no hace falta esperar para seguir, pero sí antes de responder */
  const PEND = new Set();
  const later = (p) => { const q = Promise.resolve(p).catch((e) => console.error('escritura en segundo plano', e)); PEND.add(q); q.finally(() => PEND.delete(q)); return q; };
  /* ---------- almacén con escritura condicional y reintentos ---------- */
  const pad = (n) => String(n).padStart(9, '0');
  async function getJ(key) { const v = await store.get(key, { type: 'json' }); return v == null ? null : v; }
  async function vread(name) {
    let head = await getJ(name);
    if (!head || typeof head.v !== 'number') head = { v: 0, data: null };
    for (let i = 0; i < 500; i++) { const nx = await getJ(name + '@' + pad(head.v + 1)); if (!nx) break; head = nx; }
    return head;
  }
  /* guarda en memoria lo último leído o escrito (nunca lo que se está modificando y aún no se ha guardado) */
  function remember(name, v, data) {
    if (!data) return;
    if (name === 'auth') { mem.auth = data; mem.authAt = now(); } else if (name === 'db') mem.db = { v, data, at: now() };
  }
  async function read(name) { const h = await vread(name); remember(name, h.v, h.data); return { data: h.data }; }
  /* datos para mostrar: si la versión en memoria sigue siendo la última (existe y no hay otra después), no se descargan */
  async function readDB() {
    const C = mem.db;
    if (C && now() - C.at < DB_TTL) {
      try {
        const [cur, nx] = await Promise.all([store.getMetadata('db@' + pad(C.v)), store.getMetadata('db@' + pad(C.v + 1))]);
        if (cur && !nx) return C.data;
      } catch (e) { /* se lee entera */ }
    }
    return (await read('db')).data;
  }
  async function update(name, init, fn) {
    for (let i = 0; i < 40; i++) {
      const head = await vread(name);
      const cur = head.data || init();
      const out = await fn(cur);
      if (out && out.noWrite) return { cur, out };
      const rec = { v: head.v + 1, at: now(), data: cur };
      const r = await store.setJSON(name + '@' + pad(rec.v), rec, { onlyIfNew: true });
      if (r && r.modified) {
        remember(name, rec.v, cur);
        /* el puntero a la última versión se actualiza mientras se hace lo demás (las lecturas buscan siempre la siguiente) */
        later(store.setJSON(name, rec));
        if (rec.v % 50 === 0) prune(name, rec.v);
        return { cur, out };
      }
      await sleep(10 + Math.random() * Math.min(400, 30 * (i + 1)));
    }
    throw new HttpErr(503, 'El servidor está muy ocupado. Inténtalo de nuevo.');
  }
  async function prune(name, v) {
    try { const { blobs } = await store.list({ prefix: name + '@' }); for (const b of blobs) { const n = +b.key.slice(name.length + 1); if (n && n < v - 150) await store.delete(b.key); } } catch (e) { /* puede esperar */ }
  }
  const initDB = () => ({ seq: 0, E: {}, lastSnap: 0 });
  const initAuth = () => ({ users: {}, urev: 1 });
  /* contadores para el sondeo barato: solo crecen. Escritura condicional para que dos guardados a la vez no lo hagan retroceder
     (si retrocediera, los demás no verían el último cambio hasta la siguiente consulta completa) */
  async function bumpMeta(seq, urev) {
    for (let i = 0; i < 12; i++) {
      const got = await store.getWithMetadata('meta', { type: 'json' });
      const m = (got && got.data) || { seq: 0, urev: 0 };
      if (!((seq != null && seq > (m.seq || 0)) || (urev != null && urev > (m.urev || 0)))) return;
      const nx = { seq: Math.max(m.seq || 0, seq || 0), urev: Math.max(m.urev || 0, urev || 0) };
      const w = got && got.etag ? await store.setJSON('meta', nx, { onlyIfMatch: got.etag }) : await store.setJSON('meta', nx, got ? {} : { onlyIfNew: true });
      if (w && w.modified) return;
      await sleep(5 + Math.random() * 40 * (i + 1));
    }
  }
  async function secret() {
    if (env.ESPAIS_SECRET && env.ESPAIS_SECRET.length >= 16) return env.ESPAIS_SECRET;
    if (mem.secret) return mem.secret;
    let data = await getJ('cfg');
    if (!data || !data.secret) { await store.setJSON('cfg', { secret: randomBytes(32).toString('base64') }, { onlyIfNew: true }); data = await getJ('cfg'); }
    mem.secret = data.secret;
    return data.secret;
  }
  /* usuarios: los de memoria valen si nadie los ha cambiado desde entonces (contador urev) y son recientes */
  async function authData(metaP) {
    if (mem.auth && now() - mem.authAt < AUTH_TTL) {
      const m = await (metaP || getJ('meta')).catch(() => null);
      if (m && (m.urev || 0) <= (mem.auth.urev || 0)) return mem.auth;
    }
    return (await read('auth')).data;
  }
  /* copia completa (datos y usuarios) en el almacén de copias; además, la primera de cada día queda como copia diaria permanente */
  async function snapshot(db, why) {
    const iso = new Date(now()).toISOString(), key = 'hist/' + iso.replace(/[:.]/g, '-') + (why ? '_' + why : '');
    let auth = null; try { auth = (await read('auth')).data; } catch (e) { /* la copia de datos va igualmente */ }
    const rec = { at: now(), why: why || 'auto', db, auth };
    await bk.setJSON(key, rec);
    try { await bk.setJSON('day/' + iso.slice(0, 10), rec, { onlyIfNew: true }); } catch (e) { console.error('copia diaria', e); }
    try { const { blobs } = await bk.list({ prefix: 'hist/' }); const ks = blobs.map((b) => b.key).sort(); while (ks.length > MAX_HIST) await bk.delete(ks.shift()); } catch (e) { /* la poda puede esperar */ }
  }
  /* copia de cada modificación: lo que ha cambiado, quién y cuándo (permite reconstruirlo todo desde la última copia completa) */
  async function journal(E, who, what) {
    const keys = Object.keys(E || {}); if (!keys.length) return;
    try { await bk.setJSON('jr/' + new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex'), { at: now(), by: who ? who.u.name : '', what, E }); }
    catch (e) { console.error('copia de la modificación', e); }
  }
  let snapSeen = 0;
  async function maybeSnap(why) {
    if (!why && now() - snapSeen < SNAP_EVERY) return;
    const { data: pre } = await read('db');
    if (pre) snapSeen = pre.lastSnap || 0;
    if (pre && Object.keys(pre.E).length && (why || now() - (pre.lastSnap || 0) > SNAP_EVERY)) { await snapshot(pre, why || ''); await update('db', initDB, (d) => { d.lastSnap = now(); return null; }); snapSeen = now(); }
  }

  /* copia automática cada 10 minutos de actividad, con la base ya en memoria (sin volver a leerla) */
  async function autoSnap(db) {
    if (!db || !Object.keys(db.E).length || now() - (db.lastSnap || 0) <= SNAP_EVERY) return;
    try { await snapshot(db, ''); await update('db', initDB, (d) => { d.lastSnap = now(); return null; }); } catch (e) { console.error('copia automática', e); }
  }

  /* ---------- sesiones firmadas ---------- */
  async function makeToken(id, u) {
    const p = b64u(JSON.stringify({ id, tv: u.tv || 1, exp: now() + TOKEN_HOURS * 3600000 }));
    return p + '.' + createHmac('sha256', await secret()).update(p).digest('base64url');
  }
  async function authed(req, metaP) {
    const h = req.headers.get('authorization') || '';
    const m = /^Bearer ([\w-]+)\.([\w-]+)$/.exec(h);
    if (!m) throw new HttpErr(401, 'Sesión no iniciada.');
    const sig = createHmac('sha256', await secret()).update(m[1]).digest('base64url');
    if (!safeEq(sig, m[2])) throw new HttpErr(401, 'Sesión no válida.');
    let p; try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString()); } catch (e) { throw new HttpErr(401, 'Sesión no válida.'); }
    if (!p.exp || p.exp < now()) throw new HttpErr(401, 'La sesión ha caducado. Vuelve a entrar.');
    let auth = await authData(metaP);
    const fits = (a) => { const x = a && a.users[p.id]; return !!(x && !x.x && (x.tv || 1) === p.tv); };
    if (!fits(auth) && auth === mem.auth) auth = (await read('auth')).data; /* antes de rechazar, se comprueba con la versión del almacén */
    const u = auth && auth.users[p.id];
    if (!u || u.x) throw new HttpErr(403, 'Tu usuario ya no tiene acceso.');
    if ((u.tv || 1) !== p.tv) throw new HttpErr(401, 'La sesión ya no es válida. Vuelve a entrar.');
    return { id: p.id, u, auth };
  }
  const need = (who, roles) => { if (roles.indexOf(who.u.role) < 0) throw new HttpErr(403, who.u.role === 'consulta' ? 'Tu usuario es de consulta: solo lectura.' : who.u.role === 'partido' ? 'Esta acción la hace el Ayuntamiento.' : 'Solo un administrador puede hacer esto.'); };
  /* los datos de contacto de los partidos solo los ve el Ayuntamiento (y cada partido los suyos) */
  const redact = (E, who) => {
    if (who.u.role === 'admin') return E;
    const o = {}; for (const k in E) { const e = E[k]; o[k] = e && e.k === 'g' && !(who.u.role === 'partido' && k === 'g:' + who.u.party) ? Object.assign({}, e, { rep: '', tel: '', mail: '', nota: '', xv: {} }) : e; } return o;
  };
  const since = (db, n) => { const o = {}; for (const k in db.E) if ((db.E[k].s || 0) > n) o[k] = db.E[k]; return o; };
  const stamp = (db, key, e, who, t) => { e.u = Math.max(t, ((db.E[key] && db.E[key].u) || 0) + 1); e.b = who.u.name; e.s = ++db.seq; db.E[key] = e; };
  const log = (db, who, t, a, cat, g) => stamp(db, 'h:' + newId(), Object.assign({ k: 'h', ts: t, by: who.u.name, a, t: cat || '', g: g || '' }, ensOn(db) ? { ens: true } : {}), who, t);
  const pname = (db, g) => { const p = db.E['g:' + g]; return p ? p.sig || p.nom : '?'; };
  const iname = (e) => (e.nom || e.lloc || '(sin nombre)') + (e.tram ? ' · ' + e.tram : e.lim ? ' · ' + e.lim : e.num ? ' · ' + e.num : '');
  const slotTxt = (s) => (s ? ' · ' + s.slice(8, 10) + '/' + s.slice(5, 7) + ' ' + (s[10] === 'M' ? 'mañana' : 'tarde') : '');

  /* ---------- cambios del Ayuntamiento (partidos, elementos, configuración) ---------- */
  function applyChange(db, key, ch, who, t) {
    if (typeof key !== 'string' || !/^[gics]:[\w-]{1,60}$/.test(key) || !ch || typeof ch !== 'object') return 'Cambio mal formado.';
    const kind = key[0], cur = db.E[key];
    let e;
    if (kind === 's') {
      if (key !== 's:conf') return 'Configuración no válida.';
      if (!(ch.d0 == null || ch.d0 === '' || isISO(ch.d0)) || !(ch.d1 == null || ch.d1 === '' || isISO(ch.d1))) return 'Fechas de campaña no válidas.';
      if (ch.d0 && ch.d1 && ch.d1 < ch.d0) return 'La fecha final de la campaña es anterior a la inicial.';
      if (ch.d0 && ch.d1 && (Date.parse(ch.d1) - Date.parse(ch.d0)) / 86400000 > 60) return 'La campaña no puede durar más de 60 días.';
      for (const f of ['org', 'tit', 'nota', 'rv']) if (!(ch[f] == null || (typeof ch[f] === 'string' && ch[f].length <= (f === 'nota' ? 3000 : 200)))) return 'Configuración no válida.';
      const rmin = intOr(ch.rmin, 0, 99); if (Number.isNaN(rmin)) return 'Mínimo por candidatura no válido.';
      const rm = ch.rmeth == null ? {} : ch.rmeth; if (typeof rm !== 'object' || Array.isArray(rm)) return 'Método de reparto no válido.';
      const rmeth = {}; for (const t in rm) { if (!CATS.includes(t) || !METH.includes(rm[t])) return 'Método de reparto no válido.'; rmeth[t] = rm[t]; }
      if (!(ch.dv == null || ch.dv === '' || isISO(ch.dv))) return 'Día de la votación no válido.';
      if (!(ch.tipo == null || ch.tipo === '' || TIPOS.includes(ch.tipo))) return 'Tipo de elecciones no válido.';
      const xf = xfOK(ch.xf); if (!xf) return 'Campos propios no válidos.';
      const hc = hcOK(ch.hc); if (!hc) return 'Columnas no válidas.';
      e = { k: 's', org: (ch.org || '').trim(), tit: (ch.tit || '').trim(), d0: ch.d0 || '', d1: ch.d1 || '', nota: (ch.nota || '').trim(), rv: (ch.rv || '').trim(), rmin: rmin || 0, rmeth, tipo: ch.tipo || 'generales', dv: ch.dv || '', xf, hc };
    } else if (kind === 'g') {
      if (ch.x) {
        if (!cur) return null;
        for (const k in db.E) if (db.E[k].k === 'r' && !db.E[k].x && db.E[k].g === key.slice(2)) return 'Ese partido tiene reservas: libéralas antes de eliminarlo.';
        e = Object.assign({}, cur, { x: true });
      } else {
        const o = { k: 'g' };
        for (const f in GF) { const v = ch[f]; if (v == null || v === '') o[f] = ''; else if (typeof v === 'string' && v.length <= GF[f]) o[f] = v.trim(); else return 'Dato del partido no válido: ' + f + '.'; }
        if (o.col && !/^#[0-9a-fA-F]{6}$/.test(o.col)) return 'Color no válido.';
        o.ord = intOr(ch.ord, 0, 999); if (Number.isNaN(o.ord)) return 'Orden no válido.';
        o.vot = intOr(ch.vot, 0, 99999999); if (Number.isNaN(o.vot)) return 'Número de votos no válido.';
        o.xv = xvOK(ch.xv); if (!o.xv) return 'Campos propios no válidos.';
        e = o;
      }
    } else if (kind === 'i') {
      const tt = cur ? cur.t : ch.t;
      if (!IF[tt]) return 'Elemento no válido.';
      if (ch.x) {
        if (!cur) return null;
        const id = key.slice(2);
        for (const k in db.E) { const r = db.E[k]; if (r.k === 'r' && !r.x && r.i === id) return 'Ese elemento tiene reservas: libéralas antes de eliminarlo.'; }
        e = Object.assign({}, cur, { x: true });
      } else {
        const D = IF[tt], o = { k: 'i', t: tt };
        for (const f in D.s) { const v = ch[f]; if (v == null || v === '') o[f] = ''; else if (typeof v === 'string' && v.length <= D.s[f]) o[f] = v.trim(); else return 'Dato no válido: ' + f + '.'; }
        o.ord = intOr(ch.ord, 0, 9999); if (Number.isNaN(o.ord)) return 'Número de orden no válido.';
        for (const f of D.n) { o[f] = intOr(ch[f], 0, 9999); if (Number.isNaN(o[f])) return 'Número no válido: ' + f + '.'; }
        o.xv = xvOK(ch.xv); if (!o.xv) return 'Campos propios no válidos.';
        if (!(ch.ndm == null || (typeof ch.ndm === 'string' && ch.ndm.length <= 200))) return 'Motivo no válido.';
        o.nd = !!ch.nd; o.ndm = o.nd ? (ch.ndm || '').trim() : '';
        if (o.nd && cur && !cur.nd) { const id = key.slice(2); for (const k in db.E) { const r = db.E[k]; if (r.k === 'r' && !r.x && r.i === id) return 'Tiene reservas: libéralas antes de marcarlo como no disponible.'; } }
        if (cur && !!cur.nd !== o.nd) log(db, who, t, (o.nd ? 'marcó como no disponible «' + iname(cur) + '»' + (o.ndm ? ': ' + o.ndm : '') : 'volvió a dejar disponible «' + iname(cur) + '»'), tt);
        if (tt === 'esp') {
          const b = ch.blk == null ? {} : ch.blk;
          if (typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length > 200) return 'Disponibilidad no válida.';
          o.blk = {}; for (const s in b) { if (!slotOK(s) || !['nd', 'rs'].includes(b[s])) return 'Disponibilidad no válida.'; o.blk[s] = b[s]; }
          if (o.blk && cur) for (const s in o.blk) if (o.blk[s] === 'nd') { const r = db.E['r:' + key.slice(2) + ':' + s]; if (r && !r.x) return 'Esa franja está reservada por ' + pname(db, r.g) + ': libérala antes de marcarla como no disponible.'; }
        }
        e = o;
      }
    } else if (kind === 'c') {
      const cat = key.slice(2); if (!CATS.includes(cat)) return 'Categoría no válida.';
      if (!MODES.includes(ch.mode)) return 'Modo no válido.';
      const order = Array.isArray(ch.order) ? ch.order : [];
      if (order.length > 100 || new Set(order).size !== order.length || !order.every((g) => typeof g === 'string' && db.E['g:' + g] && !db.E['g:' + g].x)) return 'Orden de partidos no válido.';
      const quota = intOr(ch.quota, 1, 99), max = intOr(ch.max, 0, 9999);
      if (quota == null || Number.isNaN(quota) || max == null || Number.isNaN(max)) return 'Cupos no válidos.';
      if (!(ch.msg == null || (typeof ch.msg === 'string' && ch.msg.length <= 1500))) return 'Mensaje no válido.';
      const cu = ch.cup == null ? {} : ch.cup, cup = {};
      if (typeof cu !== 'object' || Array.isArray(cu) || Object.keys(cu).length > 100) return 'Cupos no válidos.';
      for (const g in cu) { const n = intOr(cu[g], 0, 9999); if (n == null) continue; if (Number.isNaN(n) || !/^[\w-]{1,60}$/.test(g)) return 'Cupos no válidos.'; if (db.E['g:' + g] && !db.E['g:' + g].x) cup[g] = n; }
      const c0 = cur || { turn: 0, round: 1, used: 0 };
      e = { k: 'c', t: cat, mode: ch.mode, order, quota, max, cup, auto: ch.auto !== false, snake: !!ch.snake, msg: (ch.msg || '').trim(), turn: Math.min(c0.turn || 0, Math.max(order.length - 1, 0)), round: c0.round || 1, used: c0.used || 0, done: !!c0.done };
      if (!cur || cur.mode !== e.mode) log(db, who, t, 'cambió la selección de ' + CATN[cat].toLowerCase() + ' a «' + { cerrado: 'cerrada', turnos: 'por turnos', libre: 'libre' }[e.mode] + '»', cat);
      if (settle(db, e)) log(db, who, t, 'el turno pasa a ' + (curParty(e) ? pname(db, curParty(e)) : 'nadie (selección terminada)') + ' porque el partido anterior no tiene cupo disponible', cat);
    }
    stamp(db, key, e, who, t);
    return null;
  }

  /* ---------- reservas ---------- */
  function reserve(db, body, who, t) {
    const admin = who.u.role === 'admin';
    const g = admin ? body.g : who.u.party;
    if (!g || !db.E['g:' + g] || db.E['g:' + g].x) throw new HttpErr(400, admin ? 'Elige el partido.' : 'Tu usuario no está vinculado a ningún partido. Avisa al Ayuntamiento.');
    const it = db.E['i:' + body.i]; if (!it || it.x) throw new HttpErr(404, 'Ese elemento ya no existe.');
    if (it.nd) throw new HttpErr(409, 'No está disponible' + (it.ndm ? ': ' + it.ndm : '') + '.');
    const cat = it.t, slot = body.slot || '';
    if (cat === 'esp') {
      if (!slotOK(slot)) throw new HttpErr(400, 'Elige día y franja.');
      const conf = db.E['s:conf'] || {}, day = slot.slice(0, 10);
      if (!conf.d0 || !conf.d1 || day < conf.d0 || day > conf.d1) throw new HttpErr(400, 'Ese día no está dentro de la campaña.');
      if ((it.blk || {})[slot] === 'nd') throw new HttpErr(409, 'Ese espacio no está disponible en esa franja.');
    } else if (slot) throw new HttpErr(400, 'Reserva no válida.');
    const key = 'r:' + body.i + (slot ? ':' + slot : ''), cur = db.E[key];
    if (cur && !cur.x) throw new HttpErr(409, (cur.g === g ? 'Ya lo tenéis reservado.' : 'Lo acaba de reservar ' + pname(db, cur.g) + '.'));
    const c = db.E['c:' + cat] || { mode: 'cerrado' };
    const tot = totals(db, cat), cp = curParty(c), inTurn = c.mode === 'turnos' && cp === g;
    if (!admin) {
      if (c.mode === 'cerrado') throw new HttpErr(403, 'La selección de ' + CATN[cat].toLowerCase() + ' no está abierta.');
      if (c.mode === 'turnos') {
        if (c.done) throw new HttpErr(403, 'La selección por turnos de ' + CATN[cat].toLowerCase() + ' ha terminado.');
        if (!inTurn) throw new HttpErr(403, 'No es vuestro turno. Ahora elige ' + (cp ? pname(db, cp) : 'nadie') + '.');
        if ((c.used || 0) >= c.quota) throw new HttpErr(403, 'Ya habéis hecho las ' + c.quota + ' elecciones de este turno.');
      }
      const L = lim(c, g);
      if ((tot[g] || 0) >= L) throw new HttpErr(403, L === 0 ? 'No tenéis cupo en ' + CATN[cat].toLowerCase() + '.' : c.cup && c.cup[g] != null ? 'Habéis completado vuestro cupo de ' + L + ' en ' + CATN[cat].toLowerCase() + '.' : 'Habéis llegado al máximo de ' + L + ' en ' + CATN[cat].toLowerCase() + '.');
    }
    const r = { k: 'r', t: cat, i: body.i, slot, g, by: who.u.name, ts: t, rk: inTurn ? (c.round || 1) + '.' + (c.turn || 0) : '' };
    if (ensOn(db)) r.ens = true;
    stamp(db, key, r, who, t);
    log(db, who, t, (admin && who.u.party !== g ? 'asignó a ' + pname(db, g) + ' ' : 'reservó ') + '«' + iname(it) + slotTxt(slot) + '»', cat, g);
    if (inTurn) {
      const nc = Object.assign({}, c); nc.used = (c.used || 0) + 1;
      /* el turno pasa solo al completar las elecciones del turno, o si el partido ya ha llegado a su máximo (no puede elegir más) */
      const full = nc.auto && nc.used >= nc.quota, atMax = (tot[g] || 0) + 1 >= lim(c, g);
      if (full || atMax) { advance(db, nc); log(db, who, t, (full ? 'turno completado' : pname(db, g) + ' ha completado su cupo') + '; ahora elige ' + (curParty(nc) ? pname(db, curParty(nc)) : 'nadie (selección terminada)'), cat); }
      else if (!freeLeft(db, cat)) nc.done = true;
      stamp(db, 'c:' + cat, nc, who, t);
    }
  }
  function release(db, body, who, t) {
    const admin = who.u.role === 'admin', key = 'r:' + body.i + (body.slot ? ':' + body.slot : ''), r = db.E[key];
    if (!r || r.x) throw new HttpErr(404, 'Esa reserva ya no existe.');
    if (!admin) {
      if (r.g !== who.u.party) throw new HttpErr(403, 'Solo podéis liberar vuestras propias reservas.');
      if (ensOn(db) && !r.ens) throw new HttpErr(403, 'Durante el ensayo solo se puede liberar lo elegido en el ensayo.');
      const c = db.E['c:' + r.t] || { mode: 'cerrado' };
      if (c.mode === 'cerrado') throw new HttpErr(403, 'La selección de ' + CATN[r.t].toLowerCase() + ' está cerrada: pide al Ayuntamiento que la libere.');
    }
    const it = db.E['i:' + r.i] || {};
    stamp(db, key, Object.assign({}, r, { x: true }), who, t);
    log(db, who, t, 'liberó «' + iname(it) + slotTxt(r.slot) + '»' + (admin && who.u.party !== r.g ? ' de ' + pname(db, r.g) : ''), r.t, r.g);
    const c = db.E['c:' + r.t];
    if (c && c.mode === 'turnos' && r.rk && r.rk === (c.round || 1) + '.' + (c.turn || 0) && curParty(c) === r.g && (c.used || 0) > 0) stamp(db, 'c:' + r.t, Object.assign({}, c, { used: c.used - 1, done: false }), who, t);
  }
  /* abre o cierra varias categorías de una vez (sesión en directo y ensayo). modes: { esp: 'turnos' | 'libre' | 'cerrado', … }
     Sin orden de turnos, se usa el de la pestaña Partidos. reset: los turnos vuelven a la ronda 1. Devuelve las categorías abiertas. */
  function liveCats(db, modes, who, t, reset) {
    const E = db.E, alive = (g) => E['g:' + g] && !E['g:' + g].x;
    /* mismo orden que la pestaña Partidos: número de orden y, si empatan, las siglas */
    const parties = Object.keys(E).filter((k) => k[0] === 'g' && E[k].k === 'g' && !E[k].x).sort((a, b) => ((E[a].ord == null ? 999 : E[a].ord) - (E[b].ord == null ? 999 : E[b].ord)) || String(E[a].sig || E[a].nom || '').localeCompare(String(E[b].sig || E[b].nom || ''), 'es', { numeric: true, sensitivity: 'base' })).map((k) => k.slice(2));
    const opened = [];
    for (const cat of CATS) {
      const has = Object.keys(E).some((k) => E[k].k === 'i' && !E[k].x && E[k].t === cat);
      const mode = (modes[cat] === 'turnos' || modes[cat] === 'libre') && has ? modes[cat] : 'cerrado';
      const c0 = E['c:' + cat];
      if (!c0 && mode === 'cerrado') continue;
      const c = Object.assign({ k: 'c', t: cat, order: [], quota: 1, max: 0, cup: {}, auto: true, snake: false, msg: '', turn: 0, round: 1, used: 0, done: false }, c0 || {}, { mode });
      c.order = (c.order || []).filter(alive);
      if (mode === 'turnos' && !c.order.length) c.order = parties;
      if (reset) Object.assign(c, { turn: 0, round: 1, used: 0, done: !c.order.length });
      if (mode !== 'cerrado') opened.push(cat);
      if (c0 && c0.mode === mode && !reset) continue;
      settle(db, c);
      stamp(db, 'c:' + cat, c, who, t);
    }
    return opened;
  }
  const modesTxt = (modes, cats) => cats.map((c) => CATN[c].toLowerCase() + (modes[c] === 'libre' ? ' (libre)' : ' (por turnos)')).join(', ');
  function turnOp(db, body, who, t) {
    const cat = body.t; if (!CATS.includes(cat)) throw new HttpErr(400, 'Categoría no válida.');
    const c0 = db.E['c:' + cat]; if (!c0 || c0.mode !== 'turnos') throw new HttpErr(400, 'Esta categoría no está en modo por turnos.');
    const c = Object.assign({}, c0), admin = who.u.role === 'admin', before = curParty(c);
    if (body.op === 'pass') {
      if (!admin && before !== who.u.party) throw new HttpErr(403, 'No es vuestro turno.');
      advance(db, c); log(db, who, t, (admin ? 'pasó el turno de ' + pname(db, before) : 'terminó su turno') + '; ahora elige ' + (curParty(c) ? pname(db, curParty(c)) : 'nadie (selección terminada)'), cat, before);
    } else {
      if (!admin) throw new HttpErr(403, 'Solo el Ayuntamiento controla los turnos.');
      if (body.op === 'next') { advance(db, c); log(db, who, t, 'avanzó el turno; ahora elige ' + (curParty(c) ? pname(db, curParty(c)) : 'nadie (selección terminada)'), cat); }
      else if (body.op === 'prev') { const n = (c.order || []).length; if (!n) throw new HttpErr(400, 'No hay partidos en el orden.'); c.turn = (c.turn || 0) - 1; if (c.turn < 0) { if ((c.round || 1) > 1) { c.round--; c.turn = n - 1; } else c.turn = 0; } c.used = 0; c.done = false; log(db, who, t, 'volvió al turno de ' + pname(db, curParty(c)), cat); }
      else if (body.op === 'goto') { const i = effOrder(c).indexOf(body.g); if (i < 0) throw new HttpErr(400, 'Ese partido no está en el orden.'); c.turn = i; c.used = 0; c.done = false; log(db, who, t, 'dio el turno a ' + pname(db, body.g), cat); }
      else if (body.op === 'reset') { c.turn = 0; c.round = 1; c.used = 0; c.done = !(c.order || []).length; settle(db, c); log(db, who, t, 'reinició los turnos (ronda ' + (c.round || 1) + ', empieza ' + (curParty(c) ? pname(db, curParty(c)) : '—') + ')', cat); }
      else throw new HttpErr(400, 'Operación desconocida.');
    }
    stamp(db, 'c:' + cat, c, who, t);
  }

  /* ---------- rutas ---------- */
  const routes = {
    'GET status': async () => { const { data } = await read('auth'); return json({ ok: true, initialized: !!(data && Object.values(data.users).some((u) => !u.x)), setupEnabled: !!env.ESPAIS_CLAVE_INICIAL }); },

    'POST setup': async (req, body) => {
      if (!env.ESPAIS_CLAVE_INICIAL) throw new HttpErr(403, 'Falta configurar la variable ESPAIS_CLAVE_INICIAL en Netlify.');
      if (!str(body.code, 1, 300) || !safeEq(body.code, env.ESPAIS_CLAVE_INICIAL)) { await sleep(800); throw new HttpErr(403, 'La clave de instalación no es correcta.'); }
      if (!str(body.name, 2, 60) || !str(body.password, 8, 200)) throw new HttpErr(400, 'Escribe un nombre y una contraseña de al menos 8 caracteres.');
      const salt = randomBytes(16).toString('base64'), hash = await hashPw(body.password, salt), id = newId();
      const { out } = await update('auth', initAuth, (a) => {
        if (Object.values(a.users).some((u) => !u.x)) throw new HttpErr(409, 'El programa ya está instalado.');
        a.users[id] = { name: body.name.trim(), role: 'admin', salt, hash, iter: ITER, mc: false, tv: 1, created: now() }; a.urev++;
        return { urev: a.urev };
      });
      await bumpMeta(null, out.urev);
      const u = (await read('auth')).data.users[id];
      return json({ token: await makeToken(id, u), me: userOut(id, u) });
    },

    'POST login': async (req, body) => {
      if (!str(body.name, 1, 60) || !str(body.password, 1, 200)) throw new HttpErr(400, 'Escribe tu usuario y tu contraseña.');
      const { data: auth } = await read('auth');
      const n = norm(body.name), entry = auth && Object.entries(auth.users).find(([, u]) => !u.x && norm(u.name) === n);
      if (!entry) { await hashPw(body.password, 'x'); throw new HttpErr(401, 'Usuario o contraseña incorrectos.'); }
      const [id, u] = entry;
      if (u.lockUntil && u.lockUntil > now()) throw new HttpErr(429, 'Demasiados intentos fallidos. Espera unos minutos y vuelve a probar.');
      const ok = safeEq(await hashPw(body.password, u.salt), u.hash);
      if (!ok || u.fails) {
        await update('auth', initAuth, (a) => {
          const x = a.users[id]; if (!x) return { noWrite: true };
          if (ok) { x.fails = 0; x.lockUntil = 0; } else { x.fails = (x.fails || 0) + 1; if (x.fails >= 5) { x.lockUntil = now() + 10 * 60000; x.fails = 0; } }
          return null;
        });
      }
      if (!ok) throw new HttpErr(401, 'Usuario o contraseña incorrectos.');
      return json({ token: await makeToken(id, u), me: userOut(id, u) });
    },

    'GET data': async (req) => {
      const who = await authed(req);
      const d = (await readDB()) || initDB();
      return json({ seq: d.seq, urev: who.auth.urev, E: redact(d.E, who), users: publicUsers(who.auth, who), me: userOut(who.id, who.u) });
    },

    /* sondeo de cada pantalla abierta (cada pocos segundos): lo más barato posible */
    'GET changes': async (req, body, url) => {
      const s = +url.searchParams.get('since') || 0, ur = +url.searchParams.get('urev') || 0, force = url.searchParams.get('force') === '1';
      const mP = getJ('meta').catch(() => null);
      const who = await authed(req, mP);
      const out = { me: userOut(who.id, who.u), urev: who.auth.urev };
      if (ur !== who.auth.urev) out.users = publicUsers(who.auth, who);
      if (!force) { const m = await mP; if (m && m.seq <= s) return json(Object.assign(out, { seq: Math.max(m.seq, s), E: {} })); }
      const d = (await readDB()) || initDB();
      return json(Object.assign(out, { seq: d.seq, E: redact(since(d, s), who) }));
    },

    'POST sync': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const changes = body.changes || {}, keys = Object.keys(changes);
      if (keys.length > 800) throw new HttpErr(413, 'Demasiados cambios a la vez.');
      if (keys.some((k) => changes[k] && changes[k].x)) await maybeSnap('antes-de-eliminar');
      let s0 = 0;
      const { cur: db, out } = await update('db', initDB, (d) => {
        s0 = d.seq; const rejected = [], t = now();
        keys.forEach((k) => { const r = applyChange(d, k, changes[k], who, t); if (r) rejected.push({ key: k, reason: r }); });
        return rejected.length === keys.length ? { noWrite: true, rejected } : { rejected };
      });
      await Promise.all([bumpMeta(db.seq, null), out.rejected.length < keys.length ? journal(since(db, s0), who, 'cambios') : null, autoSnap(db)]);
      const E = since(db, +body.since || 0); out.rejected.forEach((r) => { if (db.E[r.key]) E[r.key] = db.E[r.key]; });
      return json({ seq: db.seq, E, rejected: out.rejected });
    },

    'POST reserve': async (req, body) => {
      const who = await authed(req); need(who, ['admin', 'partido']);
      if (!/^[\w-]{1,60}$/.test(String(body.i || ''))) throw new HttpErr(400, 'Reserva no válida.');
      let s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => { s0 = d.seq; reserve(d, body, who, now()); return null; });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'reserva'), autoSnap(db)]);
      return json({ seq: db.seq, E: redact(since(db, +body.since || 0), who) });
    },
    'POST release': async (req, body) => {
      const who = await authed(req); need(who, ['admin', 'partido']);
      if (!/^[\w-]{1,60}$/.test(String(body.i || '')) || !(body.slot == null || body.slot === '' || slotOK(body.slot))) throw new HttpErr(400, 'Reserva no válida.');
      let s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => { s0 = d.seq; release(d, body, who, now()); return null; });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'liberación'), autoSnap(db)]);
      return json({ seq: db.seq, E: redact(since(db, +body.since || 0), who) });
    },
    'POST turn': async (req, body) => {
      const who = await authed(req); need(who, ['admin', 'partido']);
      let s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => { s0 = d.seq; turnOp(d, body, who, now()); return null; });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'turno'), autoSnap(db)]);
      return json({ seq: db.seq, E: redact(since(db, +body.since || 0), who) });
    },

    'POST password': async (req, body) => {
      const who = await authed(req);
      if (!str(body.next, 8, 200)) throw new HttpErr(400, 'La nueva contraseña debe tener al menos 8 caracteres.');
      if (!who.u.mc) { if (!str(body.current, 1, 200) || !safeEq(await hashPw(body.current, who.u.salt), who.u.hash)) throw new HttpErr(403, 'La contraseña actual no es correcta.'); }
      if (safeEq(await hashPw(body.next, who.u.salt), who.u.hash)) throw new HttpErr(400, 'La nueva contraseña debe ser distinta de la anterior.');
      const salt = randomBytes(16).toString('base64'), hash = await hashPw(body.next, salt);
      const { cur: a } = await update('auth', initAuth, (x) => { const u = x.users[who.id]; Object.assign(u, { salt, hash, iter: ITER, mc: false, tv: (u.tv || 1) + 1 }); x.urev++; return null; });
      await bumpMeta(null, a.urev);
      const u = a.users[who.id];
      return json({ token: await makeToken(who.id, u), me: userOut(who.id, u) });
    },

    'POST users': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const op = body.op; let pre = null;
      if (op === 'add' || op === 'reset') {
        if (!str(body.password, 8, 200)) throw new HttpErr(400, 'La contraseña provisional debe tener al menos 8 caracteres.');
        pre = { salt: randomBytes(16).toString('base64') }; pre.hash = await hashPw(body.password, pre.salt);
      }
      /* alta de varios usuarios de partido de una vez, cada uno vinculado a su candidatura (todo o nada) */
      let many = null;
      if (op === 'bulk') {
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 60) throw new HttpErr(400, 'Lista de usuarios no válida.');
        for (const it of body.items) if (!it || !str(it.name, 2, 60) || !str(it.password, 8, 200) || typeof it.party !== 'string') throw new HttpErr(400, 'Revisa los usuarios: el nombre necesita 2 letras y la contraseña provisional, 8 caracteres.');
        many = await Promise.all(body.items.map(async (it) => { const salt = randomBytes(16).toString('base64'); return { name: it.name.trim(), party: it.party, salt, hash: await hashPw(it.password, salt) }; }));
      }
      const { data: db } = await read('db'); const E = (db || initDB()).E;
      const partyOK = (g) => typeof g === 'string' && E['g:' + g] && !E['g:' + g].x;
      const { cur: a } = await update('auth', initAuth, (x) => {
        const U = x.users;
        if (op === 'add') {
          if (!str(body.name, 2, 60) || !ROLES.includes(body.role)) throw new HttpErr(400, 'Nombre o rol no válidos.');
          if (body.role === 'partido' && !partyOK(body.party)) throw new HttpErr(400, 'Elige el partido de este usuario.');
          if (Object.values(U).some((u) => !u.x && norm(u.name) === norm(body.name))) throw new HttpErr(409, 'Ya existe un usuario con ese nombre.');
          U[newId()] = { name: body.name.trim(), role: body.role, party: body.role === 'partido' ? body.party : '', salt: pre.salt, hash: pre.hash, iter: ITER, mc: true, tv: 1, created: now() };
        } else if (op === 'bulk') {
          const seen = new Set(Object.values(U).filter((u) => !u.x).map((u) => norm(u.name)));
          for (const m of many) {
            if (!partyOK(m.party)) throw new HttpErr(400, 'Una de las candidaturas ya no existe. Cierra la ventana y vuelve a abrirla.');
            if (seen.has(norm(m.name))) throw new HttpErr(409, 'Ya existe un usuario llamado «' + m.name + '». Cambia el nombre.');
            seen.add(norm(m.name));
          }
          for (const m of many) U[newId()] = { name: m.name, role: 'partido', party: m.party, salt: m.salt, hash: m.hash, iter: ITER, mc: true, tv: 1, created: now() };
        } else {
          const u = U[body.id]; if (!u || u.x) throw new HttpErr(404, 'Ese usuario no existe.');
          if (op === 'role') {
            if (!ROLES.includes(body.role)) throw new HttpErr(400, 'Rol no válido.');
            if (body.role === 'partido' && !partyOK(body.party || u.party)) throw new HttpErr(400, 'Elige el partido de este usuario.');
            if (u.role === 'admin' && body.role !== 'admin' && activeAdmins(x) < 2) throw new HttpErr(400, 'Tiene que quedar al menos un administrador.');
            u.role = body.role; u.party = body.role === 'partido' ? (body.party || u.party) : ''; u.tv = (u.tv || 1) + 1;
          } else if (op === 'reset') { Object.assign(u, { salt: pre.salt, hash: pre.hash, iter: ITER, mc: true, tv: (u.tv || 1) + 1, fails: 0, lockUntil: 0 }); }
          else if (op === 'delete') {
            if (body.id === who.id) throw new HttpErr(400, 'No puedes darte de baja a ti mismo.');
            if (u.role === 'admin' && activeAdmins(x) < 2) throw new HttpErr(400, 'Tiene que quedar al menos un administrador.');
            Object.assign(u, { x: true, tv: (u.tv || 1) + 1, deleted: now() });
          } else throw new HttpErr(400, 'Operación desconocida.');
        }
        x.urev++; return null;
      });
      await bumpMeta(null, a.urev);
      try { await bk.setJSON('jr/' + new Date(now()).toISOString().replace(/[:.]/g, '-') + '-u' + randomBytes(3).toString('hex'), { at: now(), by: who.u.name, what: 'usuarios: ' + op, auth: a }); } catch (e) { console.error('copia de usuarios', e); }
      return json({ users: publicUsers(a), urev: a.urev });
    },

    'GET export': async (req) => {
      const who = await authed(req); need(who, ['admin']);
      const { data: db } = await read('db');
      return json({ app: 'espais', kind: 'copia', exported: new Date(now()).toISOString(), by: who.u.name, E: (db || initDB()).E, users: publicUsers(who.auth) });
    },
    'POST import': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      if (!body || !body.E || typeof body.E !== 'object') throw new HttpErr(400, 'Ese archivo no es una copia de Espais electorals.');
      await maybeSnap('antes-de-importar');
      let added = 0, s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => {
        added = 0; s0 = d.seq;
        for (const k in body.E) {
          const x = body.E[k];
          if (!/^[gicsrh]:[\w:-]{1,160}$/.test(k) || !x || typeof x !== 'object' || x.k !== k[0] || typeof x.u !== 'number') continue;
          if (JSON.stringify(x).length > 12000) continue;
          const c = d.E[k];
          if (!c || (k[0] !== 'h' && x.u > c.u)) { d.E[k] = Object.assign({}, x, { s: ++d.seq }); added++; } /* el registro solo crece: nunca se sobrescribe */
        }
        return added ? null : { noWrite: true };
      });
      await bumpMeta(db.seq, null); if (added) await journal(since(db, s0), who, 'importación');
      return json({ added, seq: db.seq });
    },
    /* reasignar una reserva a otra candidatura en un solo paso (administración) */
    'POST reassign': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      if (!/^[\w-]{1,60}$/.test(String(body.i || '')) || !(body.slot == null || body.slot === '' || slotOK(body.slot))) throw new HttpErr(400, 'Reserva no válida.');
      let s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => {
        s0 = d.seq; const t = now(), key = 'r:' + body.i + (body.slot ? ':' + body.slot : ''), r = d.E[key];
        if (!r || r.x) throw new HttpErr(404, 'Esa reserva ya no existe.');
        const g = body.g; if (!g || !d.E['g:' + g] || d.E['g:' + g].x) throw new HttpErr(400, 'Elige la candidatura.');
        if (g === r.g) throw new HttpErr(400, 'Ya es de esa candidatura.');
        const it = d.E['i:' + r.i] || {}, nr = { k: 'r', t: r.t, i: r.i, slot: r.slot || '', g, by: who.u.name, ts: t, rk: '' };
        /* conserva su naturaleza: lo elegido de verdad sigue siendo de verdad aunque haya un ensayo en marcha */
        if (r.ens) nr.ens = true;
        stamp(d, key, nr, who, t);
        stamp(d, 'h:' + newId(), Object.assign({ k: 'h', ts: t, by: who.u.name, a: 'reasignó «' + iname(it) + slotTxt(r.slot) + '» de ' + pname(d, r.g) + ' a ' + pname(d, g), t: r.t, g }, r.ens ? { ens: true } : {}), who, t);
        return null;
      });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'reasignación'), autoSnap(db)]);
      return json({ seq: db.seq, E: since(db, +body.since || 0) });
    },
    /* borrar datos de prueba: selecciones y, si se pide, candidaturas con sus usuarios. Nunca los espacios, las reglas ni el registro */
    'POST purge': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const parties = !!body.parties, sel = !!body.sel || parties;
      if (!sel) throw new HttpErr(400, 'Elige qué quieres borrar.');
      if (body.confirm !== 'BORRAR') throw new HttpErr(400, 'Escribe BORRAR para confirmar.');
      await maybeSnap('antes-de-borrar-datos');
      let s0 = 0, nr = 0, np = 0;
      const { cur: db } = await update('db', initDB, (d) => {
        s0 = d.seq; nr = 0; np = 0; const t = now(), gone = new Set();
        for (const k in d.E) { const r = d.E[k]; if (r.k === 'r' && !r.x) { stamp(d, k, Object.assign({}, r, { x: true }), who, t); nr++; } }
        if (parties) {
          for (const k in d.E) { const g = d.E[k]; if (g.k === 'g' && !g.x) { stamp(d, k, Object.assign({}, g, { x: true }), who, t); gone.add(k.slice(2)); np++; } }
          for (const cat of CATS) { const c = d.E['c:' + cat]; if (!c) continue; const cup = {}; for (const g in (c.cup || {})) if (!gone.has(g)) cup[g] = c.cup[g]; stamp(d, 'c:' + cat, Object.assign({}, c, { order: (c.order || []).filter((g) => !gone.has(g)), cup }), who, t); }
        }
        if (ensOn(d)) stamp(d, 's:ens', { k: 's', on: false, last: t, by: who.u.name }, who, t);
        resetTurns(d, who, t, stamp);
        log(d, who, t, 'BORRÓ DATOS: ' + nr + (nr === 1 ? ' selección' : ' selecciones') + (parties ? ' y ' + np + (np === 1 ? ' candidatura' : ' candidaturas') + ' con sus usuarios' : '') + '; antes se guardó una copia de seguridad');
        return null;
      });
      let urev = null;
      if (parties) { const { cur: a } = await update('auth', initAuth, (x) => { for (const id in x.users) { const u = x.users[id]; if (!u.x && u.role === 'partido') Object.assign(u, { x: true, tv: (u.tv || 1) + 1, deleted: now() }); } x.urev++; return null; }); urev = a.urev; }
      await Promise.all([bumpMeta(db.seq, urev), journal(since(db, s0), who, 'borrado de datos')]);
      return json({ ok: true, sel: nr, parties: np, seq: db.seq, E: since(db, +body.since || 0) });
    },
    'POST ensayo': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const op = body.op; if (op !== 'start' && op !== 'end') throw new HttpErr(400, 'Operación desconocida.');
      const modes = body.modes && typeof body.modes === 'object' && !Array.isArray(body.modes) ? body.modes : null;
      await maybeSnap(op === 'start' ? 'antes-del-ensayo' : 'fin-del-ensayo');
      let s0 = 0, n = 0, opened = [];
      const { cur: db } = await update('db', initDB, (d) => {
        s0 = d.seq; n = 0; opened = []; const t = now(), on = ensOn(d);
        if (op === 'start') {
          if (on) throw new HttpErr(409, 'Ya hay un ensayo en marcha.');
          log(d, who, t, 'empezó un ENSAYO: lo que se elija a partir de ahora es de prueba y se borrará al terminar');
          stamp(d, 's:ens', { k: 's', on: true, since: t, by: who.u.name }, who, t);
          if (modes) {
            /* el ensayo abre las categorías marcadas, igual que la sesión de verdad */
            opened = liveCats(d, modes, who, t, true);
            if (opened.length) { stamp(d, 's:live', { k: 's', on: true, ens: true, since: t, by: who.u.name, modes: Object.fromEntries(opened.map((c) => [c, modes[c]])) }, who, t); log(d, who, t, 'abrió para el ensayo: ' + modesTxt(modes, opened)); }
          } else resetTurns(d, who, t, stamp);
        } else {
          if (!on) throw new HttpErr(409, 'No hay ningún ensayo en marcha.');
          for (const k in d.E) { const r = d.E[k]; if (r.k === 'r' && !r.x && r.ens) { stamp(d, k, Object.assign({}, r, { x: true }), who, t); n++; } }
          stamp(d, 's:ens', { k: 's', on: false, last: t, by: who.u.name }, who, t);
          resetTurns(d, who, t, stamp);
          /* al terminar el ensayo todo queda cerrado: nadie puede elegir de verdad hasta que el Ayuntamiento empiece la sesión */
          const L = d.E['s:live'] || {}, was = {}; for (const c of CATS) { const x = d.E['c:' + c]; if (x && x.mode !== 'cerrado') was[c] = x.mode; }
          liveCats(d, {}, who, t, false);
          stamp(d, 's:live', { k: 's', on: false, modes: L.modes || was }, who, t);
          log(d, who, t, 'terminó el ENSAYO: se han borrado ' + n + (n === 1 ? ' elección' : ' elecciones') + ' de prueba, los turnos vuelven a empezar y la selección queda cerrada hasta que se pulse «Empezar la selección»');
        }
        return null;
      });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'ensayo')]);
      return json({ ok: true, n, opened, seq: db.seq, E: since(db, +body.since || 0) });
    },
    /* la sesión de verdad: empezar (abre las categorías marcadas desde la ronda 1), pausar, reanudar y terminar */
    'POST sesion': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const op = body.op; if (!['start', 'pause', 'resume', 'end'].includes(op)) throw new HttpErr(400, 'Operación desconocida.');
      const modes = {};
      if (op === 'start') {
        if (!body.modes || typeof body.modes !== 'object' || Array.isArray(body.modes)) throw new HttpErr(400, 'Indica qué categorías se abren.');
        for (const c of CATS) modes[c] = body.modes[c] === 'turnos' || body.modes[c] === 'libre' ? body.modes[c] : 'cerrado';
        if (!CATS.some((c) => modes[c] !== 'cerrado')) throw new HttpErr(400, 'Marca al menos una categoría para abrir.');
      }
      if (op === 'start' || op === 'end') await maybeSnap(op === 'start' ? 'antes-de-empezar' : 'fin-de-la-seleccion');
      let s0 = 0, opened = [];
      const { cur: db } = await update('db', initDB, (d) => {
        s0 = d.seq; opened = []; const t = now(), L = d.E['s:live'] || {};
        const open = {}; for (const c of CATS) { const x = d.E['c:' + c]; if (x && x.mode !== 'cerrado') open[c] = x.mode; }
        if (op === 'start') {
          if (ensOn(d)) throw new HttpErr(409, 'Hay un ensayo en marcha: termínalo antes de empezar la selección.');
          opened = liveCats(d, modes, who, t, true);
          if (!opened.length) throw new HttpErr(400, 'Las categorías marcadas todavía no tienen nada cargado.');
          stamp(d, 's:live', { k: 's', on: true, since: t, by: who.u.name, modes: Object.fromEntries(opened.map((c) => [c, modes[c]])) }, who, t);
          log(d, who, t, 'EMPEZÓ LA SELECCIÓN: ' + modesTxt(modes, opened) + '; los turnos empiezan en la ronda 1');
        } else if (op === 'pause') {
          if (!Object.keys(open).length) throw new HttpErr(409, 'No hay ninguna selección abierta.');
          liveCats(d, {}, who, t, false);
          stamp(d, 's:live', Object.assign({}, L, { k: 's', on: false, paused: t, ens: ensOn(d), modes: open }), who, t);
          log(d, who, t, 'PAUSÓ LA SELECCIÓN: nadie puede elegir hasta que se reanude (los turnos se conservan)');
        } else if (op === 'resume') {
          if (!(L.paused || L.ended) || !L.modes) throw new HttpErr(409, 'No hay ninguna selección en pausa.');
          opened = liveCats(d, L.modes, who, t, false);
          if (!opened.length) throw new HttpErr(409, 'No queda ninguna categoría que reabrir.');
          stamp(d, 's:live', { k: 's', on: true, ens: ensOn(d), since: L.since || t, by: L.by || who.u.name, modes: L.modes }, who, t);
          log(d, who, t, (L.ended ? 'VOLVIÓ A ABRIR LA SELECCIÓN: ' : 'REANUDÓ LA SELECCIÓN: ') + modesTxt(L.modes, opened) + ', donde se había quedado');
        } else {
          liveCats(d, {}, who, t, false);
          stamp(d, 's:live', { k: 's', on: false, ended: t, since: L.since || 0, by: who.u.name, modes: L.modes || open }, who, t);
          log(d, who, t, 'TERMINÓ LA SELECCIÓN: todas las categorías quedan cerradas');
        }
        return null;
      });
      await Promise.all([bumpMeta(db.seq, null), journal(since(db, s0), who, 'sesión')]);
      return json({ ok: true, opened, seq: db.seq, E: since(db, +body.since || 0) });
    },
    'POST keep': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      const label = (typeof body.label === 'string' ? body.label : '').trim().slice(0, 100) || 'Copia guardada';
      const { data: db } = await read('db'); if (!db || !Object.keys(db.E).length) throw new HttpErr(400, 'Todavía no hay datos que guardar.');
      let auth = null; try { auth = (await read('auth')).data; } catch (e) { /* la copia de datos va igualmente */ }
      const iso = new Date(now()).toISOString(), key = 'keep/' + iso.replace(/[:.]/g, '-') + '_' + (norm(label).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'copia');
      await bk.setJSON(key, { at: now(), why: 'permanente', label, by: who.u.name, db, auth });
      for (let i = 0; i < 5; i++) { const idx = (await bk.get('keep-index', { type: 'json' })) || { items: [] }; idx.items.push({ key, label, at: now(), by: who.u.name }); await bk.setJSON('keep-index', idx); const chk = await bk.get('keep-index', { type: 'json' }); if (chk && chk.items.some((x) => x.key === key)) break; }
      const { cur: d2 } = await update('db', initDB, (d) => { log(d, who, now(), 'guardó una copia permanente: «' + label + '»'); return null; });
      await bumpMeta(d2.seq, null);
      return json({ ok: true, key, label });
    },
    /* enlace con Eleccions: la clave solo se muestra al crearla; aquí se guarda su huella, fuera de los datos (que ven todos los usuarios) */
    'GET enlace': async (req) => {
      const who = await authed(req); need(who, ['admin']);
      const l = await getJ('enlace');
      return json(l && l.h ? { activa: true, creada: l.at, por: l.by, uso: l.used || 0 } : { activa: false });
    },
    'POST enlace': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      if (body.op !== 'crear' && body.op !== 'revocar') throw new HttpErr(400, 'Operación no válida.');
      let clave = null;
      if (body.op === 'crear') { clave = 'ee1_' + randomBytes(24).toString('base64url'); await store.setJSON('enlace', { h: sha(clave).toString('hex'), at: now(), by: who.u.name, used: 0 }); }
      else await store.delete('enlace');
      const { cur: db } = await update('db', initDB, (d) => { log(d, who, now(), body.op === 'crear' ? 'creó una clave de enlace con Eleccions (si había otra, deja de valer)' : 'revocó la clave de enlace con Eleccions'); return null; });
      await bumpMeta(db.seq, null);
      return json(Object.assign({ ok: true, seq: db.seq }, clave ? { clave } : {}));
    },
    /* el reparto para Eleccions: con la clave de enlace (desde el servidor de Eleccions) o con la sesión de un administrador (descarga) */
    'GET reparto': async (req) => {
      const m = LINK_RE.exec(req.headers.get('authorization') || '');
      if (m) {
        const got = await store.getWithMetadata('enlace', { type: 'json' }), l = got && got.data;
        if (!l || !l.h || !safeEq(sha(m[1]).toString('hex'), l.h)) { await sleep(500); throw new HttpErr(401, 'La clave de enlace no es válida o se ha revocado.'); }
        /* último uso, como mucho una vez por hora; solo si nadie ha cambiado ni revocado la clave mientras tanto */
        if (now() - (l.used || 0) > 3600000 && got.etag) later(store.setJSON('enlace', Object.assign({}, l, { used: now() }), { onlyIfMatch: got.etag }));
      } else { const who = await authed(req); need(who, ['admin']); }
      const d = (await readDB()) || initDB();
      return json(repartoOut(d, now()));
    },
    'GET history': async (req) => {
      const who = await authed(req); need(who, ['admin']);
      const [h, dd, jr, ki] = await Promise.all([bk.list({ prefix: 'hist/' }), bk.list({ prefix: 'day/' }), bk.list({ prefix: 'jr/' }), bk.get('keep-index', { type: 'json' })]);
      return json({ items: h.blobs.map((b) => b.key).sort().reverse().slice(0, 150), days: dd.blobs.map((b) => b.key).sort().reverse(), keep: ((ki && ki.items) || []).slice().reverse(), changes: jr.blobs.length });
    },
    'POST restore': async (req, body) => {
      const who = await authed(req); need(who, ['admin']);
      if (!str(body.key, 6, 200) || !/^(hist|day|keep)\//.test(body.key)) throw new HttpErr(400, 'Copia no válida.');
      const h = await bk.get(body.key, { type: 'json' }); if (!h || !h.db) throw new HttpErr(404, 'Esa copia ya no existe.');
      const { data: pre } = await read('db'); if (pre) await snapshot(pre, 'antes-de-restaurar');
      /* los usuarios dados de baja después de la copia vuelven con ella (con su contraseña y su candidatura); nunca se toca a los demás */
      let nu = 0, urev = null;
      if (h.auth && h.auth.users) {
        const { cur: a, out } = await update('auth', initAuth, (x) => {
          nu = 0; const names = new Set(Object.values(x.users).filter((u) => !u.x).map((u) => norm(u.name)));
          for (const id in h.auth.users) { const o = h.auth.users[id], u = x.users[id]; if (o && !o.x && u && u.x && (u.deleted || 0) >= (h.at || 0) && !names.has(norm(u.name))) { names.add(norm(u.name)); delete u.x; delete u.deleted; u.party = o.party || u.party || ''; u.tv = (u.tv || 1) + 1; nu++; } }
          if (!nu) return { noWrite: true };
          x.urev++; return null;
        });
        if (!(out && out.noWrite)) urev = a.urev;
      }
      let s0 = 0;
      const { cur: db } = await update('db', initDB, (d) => {
        s0 = d.seq; const t = now(), S = h.db.E, keys = new Set(Object.keys(d.E).concat(Object.keys(S)));
        keys.forEach((k) => {
          const c = d.E[k];
          if (k[0] === 'h') { if (!c && S[k]) d.E[k] = Object.assign({}, S[k], { s: ++d.seq }); return; } /* el registro nunca se borra */
          if (S[k]) d.E[k] = Object.assign({}, S[k], { u: Math.max(t, ((c && c.u) || 0) + 1), b: who.u.name, s: ++d.seq });
          else if (c && !c.x) d.E[k] = Object.assign({}, c, { x: true, u: Math.max(t, c.u + 1), b: who.u.name, s: ++d.seq });
        });
        log(d, who, t, 'restauró una copia de seguridad del servidor (' + body.key.slice(5, 21).replace('T', ' ') + ')' + (nu ? ' y recuperó ' + nu + (nu === 1 ? ' usuario' : ' usuarios') : ''));
        return null;
      });
      await bumpMeta(db.seq, urev); await journal(since(db, s0), who, 'restauración');
      return json({ ok: true, seq: db.seq });
    }
  };

  return async function handler(req) {
    try {
      const url = new URL(req.url);
      const route = url.pathname.replace(/^\/(?:\.netlify\/functions\/)?api\/?/, '').replace(/\/$/, '');
      const fn = routes[req.method + ' ' + route];
      if (!fn) return fail(404, 'Ruta desconocida.');
      let body = {};
      if (req.method === 'POST') {
        const txt = await req.text();
        if (txt.length > 5.5 * 1024 * 1024) return fail(413, 'Petición demasiado grande.');
        try { body = txt ? JSON.parse(txt) : {}; } catch (e) { return fail(400, 'Petición mal formada.'); }
        if (!body || typeof body !== 'object') return fail(400, 'Petición mal formada.');
      }
      return await fn(req, body, url);
    } catch (e) {
      if (e instanceof HttpErr) return fail(e.status, e.message);
      console.error(e);
      return fail(500, 'Error interno del servidor.');
    } finally {
      if (PEND.size) await Promise.all([...PEND]);
    }
  };
}
