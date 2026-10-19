// Prueba de carga contra la web REAL, sin tocar ningún dato: solo la consulta pública /api/status (lectura).
// Simula N usuarios que consultan el servidor a la vez, como hace la página mientras la selección está abierta.
//   node pruebas/carga-real.cjs                     50 usuarios, 2 minutos, contra espaiselectorals.netlify.app
//   USUARIOS=50 SEGUNDOS=120 CADA=4000 URL=https://… node pruebas/carga-real.cjs
const B = process.env.URL || 'https://espaiselectorals.netlify.app';
const N = +process.env.USUARIOS || 50, SEG = +process.env.SEGUNDOS || 120, CADA = +process.env.CADA || 4000;
const lat = [], codes = {}; let errNet = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; };
async function hit(p) {
  const t0 = Date.now();
  try { const r = await fetch(B + p, { cache: 'no-store' }); await r.arrayBuffer(); codes[r.status] = (codes[r.status] || 0) + 1; if (p.startsWith('/api/')) lat.push(Date.now() - t0); return r.status; }
  catch (e) { errNet++; return 0; }
}
(async () => {
  console.log('Contra ' + B + ' · ' + N + ' usuarios · ' + SEG + ' s · una consulta cada ' + CADA / 1000 + ' s por usuario');
  // 1) todos abren la página a la vez (página + primera consulta)
  let t1 = Date.now();
  const pg = await Promise.all(Array.from({ length: N }, () => hit('/')));
  console.log('Apertura simultánea de la página por ' + N + ' usuarios: ' + pg.filter((s) => s === 200).length + '/' + N + ' correctas en ' + (Date.now() - t1) + ' ms');
  t1 = Date.now();
  const st = await Promise.all(Array.from({ length: N }, () => hit('/api/status')));
  console.log('Ráfaga de ' + N + ' consultas al servidor en el mismo instante: ' + st.filter((s) => s === 200).length + '/' + N + ' correctas en ' + (Date.now() - t1) + ' ms');
  // 2) sondeo continuo, cada usuario con su propio ritmo, como la página
  const end = Date.now() + SEG * 1000; let n = 0;
  await Promise.all(Array.from({ length: N }, async (_, i) => { await wait((i * CADA) / N); while (Date.now() < end) { await hit('/api/status'); n++; await wait(CADA); } }));
  const s5 = Object.keys(codes).filter((c) => +c >= 500).reduce((a, c) => a + codes[c], 0);
  console.log('Sondeo continuo: ' + n + ' consultas en ' + SEG + ' s (' + (n / SEG).toFixed(1) + ' por segundo)');
  console.log('Tiempo de respuesta: mediana ' + pctl(lat, 0.5) + ' ms · p95 ' + pctl(lat, 0.95) + ' ms · p99 ' + pctl(lat, 0.99) + ' ms · máx ' + Math.max(...lat) + ' ms');
  console.log('Códigos: ' + JSON.stringify(codes) + ' · errores de red ' + errNet + ' · errores 5xx ' + s5);
  console.log(s5 || errNet ? 'HAY ERRORES' : 'SIN ERRORES');
  process.exitCode = s5 || errNet ? 1 : 0;
})();
