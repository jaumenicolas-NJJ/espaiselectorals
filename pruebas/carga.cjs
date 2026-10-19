// Prueba de carga: 50 usuarios a la vez (administradora + 25 candidaturas + 24 de consulta) contra el servidor de pruebas con latencia simulada
//   PARTIDOS=25 CONSULTA=24  cuántas candidaturas eligen y cuántos usuarios solo miran (secretarios, responsables…)
const B = 'http://localhost:' + (process.env.PORT || 8899); const R = []; const ok = (n, c, x) => { R.push((c ? 'OK   ' : 'FALLO') + ' ' + n + (x != null && x !== '' ? ' · ' + x : '')); };
const NP = +process.env.PARTIDOS || 25, NC = +process.env.CONSULTA || 24, NU = 1 + NP + NC;
const lat = {}, codes = {}; let FASE = ''; /* las reservas por turnos se miden aparte de las ráfagas */
const api = async (p, body, tok) => {
  const t0 = Date.now(), route = p.split('?')[0];
  const r = await fetch(B + '/api/' + p, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  const key = route === 'reserve' && FASE ? 'reserve-turnos' : route; (lat[key] = lat[key] || []).push(Date.now() - t0); codes[r.status] = (codes[r.status] || 0) + 1;
  return { status: r.status, j };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
(async () => {
  const T0 = Date.now();
  let r = await api('setup', { code: 'clave-prueba', name: 'Rosana', password: 'rosana123' }); const A = r.j.token;
  const ch = { 's:conf': { k: 's', org: 'Ajuntament de Santa Coloma de Gramenet', tit: 'Prueba de carga', d0: '2027-07-07', d1: '2027-07-21' } };
  const P = []; for (let i = 0; i < NP; i++) { P.push('p' + i); ch['g:p' + i] = { k: 'g', sig: 'PART' + i, nom: 'Partido ' + i, ord: i + 1, vot: 40000 - i * 1400 }; }
  for (let i = 0; i < 30; i++) ch['i:e' + i] = { k: 'i', t: 'esp', ord: i + 1, nom: 'Espacio ' + i, blk: {} };
  for (let i = 0; i < 47; i++) ch['i:r' + i] = { k: 'i', t: 'pri', ord: i + 1, lloc: 'Prisma ' + i, num: String(i) };
  for (let i = 0; i < 338; i++) ch['i:b' + i] = { k: 'i', t: 'ban', ord: i + 1, nom: 'Calle ' + i, tram: 'Tramo ' + i, bf: 4, pf: 2 };
  r = await api('sync', { changes: ch, since: 0 }, A); ok('Carga inicial (' + NP + ' candidaturas, 415 elementos)', r.status === 200 && !r.j.rejected.length);
  const tok = {}; for (const g of P) { await api('users', { op: 'add', name: 'U' + g, role: 'partido', party: g, password: 'provis123' }, A); tok[g] = (await api('login', { name: 'U' + g, password: 'provis123' })).j.token; }
  const cons = []; for (let i = 0; i < NC; i++) { await api('users', { op: 'add', name: 'C' + i, role: 'consulta', password: 'provis123' }, A); cons.push((await api('login', { name: 'C' + i, password: 'provis123' })).j.token); }
  const all = [A].concat(P.map((g) => tok[g]), cons); ok(NU + ' usuarios dentro a la vez', all.filter(Boolean).length === NU);
  // todos cargan los datos a la vez (como al abrir la página)
  let t1 = Date.now(); const loads = await Promise.all(all.map((t) => api('data', null, t))); ok(NU + ' cargas completas simultáneas', loads.every((x) => x.status === 200), (Date.now() - t1) + ' ms en total');

  // sondeo continuo de todos los usuarios (cada 4 s, uno de cada 10 completo), como hace la página
  let stop = false; const seqOf = {}; all.forEach((t) => { seqOf[t] = 0; });
  const pollers = all.map(async (t, i) => { let n = 0; await wait(i * 190); while (!stop) { const x = await api('changes?since=' + seqOf[t] + '&urev=0' + (++n % 10 === 0 ? '&force=1' : ''), null, t); if (x.j && x.j.seq) seqOf[t] = x.j.seq; await wait(4000); } });

  // FASE 1 · ráfaga: todas las candidaturas pulsan la MISMA casilla en el mismo instante
  await api('sync', { changes: { 'c:esp': { k: 'c', mode: 'libre', order: P, quota: 1, max: 0 } }, since: 0 }, A);
  let res = await Promise.all(P.map((g) => api('reserve', { i: 'e0', slot: '2027-07-07M' }, tok[g])));
  ok('Ráfaga sobre la misma casilla: exactamente 1 la consigue y ' + (NP - 1) + ' reciben «ya reservado»', res.filter((x) => x.status === 200).length === 1 && res.filter((x) => x.status === 409).length === NP - 1, res.map((x) => x.status).join(','));
  // FASE 2 · ráfaga: todas reservan casillas DISTINTAS en el mismo instante (todas deben entrar)
  t1 = Date.now(); res = await Promise.all(P.map((g, i) => api('reserve', { i: 'e' + (i + 1), slot: '2027-07-08T' }, tok[g])));
  ok('Ráfaga de ' + NP + ' reservas distintas simultáneas: todas guardadas', res.every((x) => x.status === 200), res.map((x) => x.status).join(',') + ' · ' + (Date.now() - t1) + ' ms');
  // FASE 3 · 40 segundos eligiendo a la vez en modo libre (prueba de esfuerzo: mucho más rápido que una persona) (cada candidatura cada 0,5–1,5 s)
  const free = []; for (let e = 0; e < 30; e++) for (let d = 7; d <= 21; d++) for (const m of ['M', 'T']) free.push(['e' + e, '2027-07-' + String(d).padStart(2, '0') + m]);
  let okN = 0, busy = 0, other = 0, errs5 = 0; const end = Date.now() + 40000;
  await Promise.all(P.map(async (g) => { while (Date.now() < end) { const [i, s] = free[Math.floor(Math.random() * free.length)]; const x = await api('reserve', { i, slot: s }, tok[g]); if (x.status === 200) okN++; else if (x.status === 409) busy++; else if (x.status >= 500) errs5++; else other++; if (Math.random() < 0.15 && x.status === 200) await api('release', { i, slot: s }, tok[g]); await wait(500 + Math.random() * 1000); } }));
  ok('40 s con ' + NP + ' candidaturas eligiendo a la vez: sin errores del servidor', errs5 === 0 && other === 0, okN + ' reservas · ' + busy + ' ya ocupadas · ' + errs5 + ' errores 5xx · ' + other + ' otros');
  let d = (await api('data', null, A)).j; const act = Object.entries(d.E).filter(([k, e]) => e.k === 'r' && !e.x && e.t === 'esp');
  const dup = new Set(); let dupN = 0; act.forEach(([k]) => { if (dup.has(k)) dupN++; dup.add(k); });
  ok('Coherencia: ninguna casilla con dos dueños y todas las reservas con su registro', dupN === 0 && Object.values(d.E).filter((e) => e.k === 'h' && /reservó/.test(e.a)).length >= okN, act.length + ' casillas ocupadas');

  FASE = 'turnos';
  // FASE 4 · por turnos con cupos proporcionales: 47 prismas, 1 por turno; cada candidatura vigila su turno (sondeo cada 1 s)
  const V = P.map((g, i) => 40000 - i * 1400), Vt = V.reduce((a, b) => a + b, 0), cup = {}; let used = 0; const ex = P.map((g, i) => { const q = 47 * V[i] / Vt; return { g, q, f: Math.floor(q) }; }); ex.forEach((x) => { used += x.f; }); ex.slice().sort((a, b) => (b.q - b.f) - (a.q - a.f)).slice(0, 47 - used).forEach((x) => { x.f++; }); ex.forEach((x) => { cup[x.g] = x.f; });
  r = await api('sync', { changes: { 'c:pri': { k: 'c', mode: 'turnos', order: P, quota: 1, max: 0, cup } }, since: 0 }, A); const r2 = await api('turn', { t: 'pri', op: 'reset' }, A);
  ok('Prismas abiertos por turnos con cupos', r.status === 200 && !r.j.rejected.length && r2.status === 200, r.status + ' ' + JSON.stringify(r.j.rejected || r.j.error) + ' · ' + r2.status + ' ' + (r2.j.error || ''));
  t1 = Date.now(); let wrong = 0, picks = 0;
  await Promise.all(P.map(async (g) => {
    for (;;) {
      const x = (await api('changes?since=0&urev=0&force=1', null, tok[g])).j; const c = x.E && x.E['c:pri'];
      if (!c) { if (Date.now() - t1 > 480000) return; await wait(1000); continue; }
      if (c.done || Date.now() - t1 > 480000) return;
      const ord = c.order, cur = ord[c.turn];
      if (cur === g) { const freeR = []; for (let i = 0; i < 47; i++) { const rr = x.E['r:r' + i]; if (!rr || rr.x) freeR.push('r' + i); } const y = await api('reserve', { i: freeR[Math.floor(Math.random() * freeR.length)] }, tok[g]); if (y.status === 200) picks++; else if (y.status !== 409) wrong++; }
      await wait(1000);
    }
  }));
  d = (await api('data', null, A)).j; const got = {}; Object.values(d.E).forEach((e) => { if (e.k === 'r' && !e.x && e.t === 'pri') got[e.g] = (got[e.g] || 0) + 1; });
  ok('Turnos con cupos proporcionales: 47 prismas repartidos exactamente según el cupo', d.E['c:pri'].done && P.every((g) => (got[g] || 0) === cup[g]) && picks === 47, Math.round((Date.now() - t1) / 1000) + ' s · cupos ' + P.map((g) => cup[g]).join('/') + ' · rechazos indebidos ' + wrong);
  FASE = ''; stop = true; await Promise.all(pollers);

  // resumen de tiempos de respuesta
  const fmt = (k) => lat[k] ? k + ': ' + lat[k].length + ' peticiones · mediana ' + pctl(lat[k], 0.5) + ' ms · p95 ' + pctl(lat[k], 0.95) + ' ms · máx ' + Math.max(...lat[k]) + ' ms' : '';
  ok('Consultas periódicas rápidas (p95 < 1 s)', pctl(lat.changes, 0.95) < 1000, fmt('changes'));
  ok('Por turnos (como el día de la sesión), cada reserva es ágil (p95 < 3 s)', pctl(lat['reserve-turnos'], 0.95) < 3000, fmt('reserve-turnos'));
  ok('Prueba de esfuerzo: ' + NP + ' candidaturas pulsando sin parar en modo libre, todas se guardan (p95 < 10 s)', pctl(lat.reserve, 0.95) < 10000, fmt('reserve'));
  ok('Ningún error 5xx en toda la prueba', !Object.keys(codes).some((c) => +c >= 500), JSON.stringify(codes));
  const ops = await (await fetch(B + '/__ops')).text();
  console.log(R.join('\n')); console.log(R.filter((x) => x.startsWith('OK')).length + '/' + R.length); process.exitCode = R.some((x) => x.startsWith('FALLO')) ? 1 : 0;
  console.log('Duración ' + Math.round((Date.now() - T0) / 1000) + ' s · operaciones de almacén ' + ops); ['data', 'release', 'sync'].forEach((k) => console.log('  ' + fmt(k)));
})().catch((e) => { console.log(R.join('\n')); console.error('ERROR', e); process.exit(1); });
