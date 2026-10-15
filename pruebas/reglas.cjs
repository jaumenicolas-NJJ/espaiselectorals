// Pruebas de las reglas del servidor (turnos, cupos, exclusividad, permisos, copias). Necesita pruebas/servidor.mjs en marcha.
const B = 'http://localhost:' + (process.env.PORT || 8899); const R = []; const ok = (n, c, x) => { R.push((c ? 'OK   ' : 'FALLO') + ' ' + n + (x ? ' · ' + x : '')); };
const api = async (p, body, tok) => { const r = await fetch(B + '/api/' + p, { method: body ? 'POST' : 'GET', headers: Object.assign({ 'content-type': 'application/json' }, tok ? { authorization: 'Bearer ' + tok } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => null) }; };
(async () => {
  let r = await api('setup', { code: 'clave-prueba', name: 'Rosana', password: 'rosana123' }); ok('Instalación y administradora', r.status === 200); const A = r.j.token;
  r = await api('setup', { code: 'clave-prueba', name: 'Otro', password: 'otro12345' }); ok('No se puede reinstalar', r.status === 409);
  const ch = { 's:conf': { k: 's', org: 'Ajuntament de Santa Coloma de Gramenet', tit: 'Generales 2027', d0: '2027-07-07', d1: '2027-07-21' } };
  ['PSC', 'PP', 'VOX', 'ERC'].forEach((s, i) => { ch['g:p' + i] = { k: 'g', sig: s, nom: s + ' nombre', ord: i + 1, col: '#11223' + i, rep: 'Rep ' + s, tel: '93000000' + i, mail: s.toLowerCase() + '@x.es' }; });
  for (let i = 0; i < 6; i++) ch['i:b' + i] = { k: 'i', t: 'ban', ord: i + 1, nom: 'Calle ' + i, tram: 'A/B', bf: 3, pf: 2 };
  ch['i:e0'] = { k: 'i', t: 'esp', ord: 1, nom: 'Plaça Catalunya', blk: { '2027-07-08M': 'nd', '2027-07-08T': 'rs' } };
  ch['i:p0'] = { k: 'i', t: 'pan', ord: 1, lloc: 'Av X', lim: 'de A a B' };
  for (let i = 0; i < 5; i++) ch['i:r' + i] = { k: 'i', t: 'pri', ord: i + 1, lloc: 'Prisma ' + i, num: String(i) };
  ch['c:ban'] = { k: 'c', mode: 'turnos', order: ['p0', 'p1', 'p2', 'p3'], quota: 2, max: 3, auto: true, snake: false, msg: 'Hola' };
  r = await api('sync', { changes: ch, since: 0 }, A); ok('Configuración, partidos, elementos y reglas', r.status === 200 && r.j.rejected.length === 0, JSON.stringify(r.j.rejected));
  const mk = async (name, role, party) => { await api('users', { op: 'add', name, role, party, password: 'provis123' }, A); return (await api('login', { name, password: 'provis123' })).j.token; };
  const T = { PSC: await mk('PSC', 'partido', 'p0'), PP: await mk('PP', 'partido', 'p1'), VOX: await mk('VOX', 'partido', 'p2'), ERC: await mk('ERC', 'partido', 'p3'), JEZ: await mk('JEZ', 'consulta') };
  r = await api('users', { op: 'add', name: 'Sin', role: 'partido', password: 'provis123' }, A); ok('Usuario de partido exige partido', r.status === 400);
  // contactos ocultos
  let d = (await api('data', null, T.PP)).j; ok('Partido no ve contactos de otros partidos', d.E['g:p0'].tel === '' && d.E['g:p1'].tel === '930000001');
  ok('Partido no ve la lista de usuarios ajenos', d.users.length === 1);
  d = (await api('data', null, T.JEZ)).j; ok('Consulta no ve contactos', d.E['g:p0'].mail === '');
  // turnos
  r = await api('reserve', { i: 'b0' }, T.PP); ok('Fuera de turno: rechazo', r.status === 403 && /No es vuestro turno/.test(r.j.error), r.j.error);
  r = await api('reserve', { i: 'b0' }, T.JEZ); ok('Consulta no puede reservar', r.status === 403);
  r = await api('reserve', { i: 'b0' }, T.PSC); ok('PSC reserva en su turno', r.status === 200);
  // concurrencia: PSC intenta lo mismo que nadie más puede; y dos reservas simultáneas del mismo elemento
  const [x1, x2] = await Promise.all([api('reserve', { i: 'b1' }, T.PSC), api('reserve', { i: 'b1', g: 'p3' }, A)]);
  ok('Dos reservas simultáneas del mismo elemento: solo una gana', [x1.status, x2.status].sort().join() === '200,409', x1.status + ',' + x2.status);
  d = (await api('data', null, A)).j; const winner = d.E['r:b1'].g;
  ok('Turno pasa solo al completar el cupo', winner === 'p0' ? d.E['c:ban'].turn === 1 && d.E['c:ban'].used === 0 : d.E['c:ban'].used === 1, JSON.stringify({ turn: d.E['c:ban'].turn, used: d.E['c:ban'].used, winner }));
  if (winner !== 'p0') { await api('reserve', { i: 'b2' }, T.PSC); d = (await api('data', null, A)).j; }
  r = await api('reserve', { i: 'b0' }, T.PP); ok('Elemento ocupado: rechazo con aviso', r.status === 409 && /PSC/.test(r.j.error), r.j.error);
  r = await api('reserve', { i: 'b3' }, T.PP); ok('PP reserva en su turno', r.status === 200);
  r = await api('release', { i: 'b3' }, T.PP); d = (await api('data', null, A)).j; ok('Liberar en su turno devuelve la elección', d.E['c:ban'].used === 0 && d.E['r:b3'].x === true);
  r = await api('release', { i: 'b0' }, T.PP); ok('No puede liberar lo de otro', r.status === 403);
  r = await api('turn', { t: 'ban', op: 'pass' }, T.VOX); ok('Pasar turno ajeno: rechazo', r.status === 403);
  r = await api('turn', { t: 'ban', op: 'pass' }, T.PP); d = (await api('data', null, A)).j; ok('PP termina su turno', d.E['c:ban'].turn === 2);
  r = await api('turn', { t: 'ban', op: 'next' }, T.VOX); ok('Partido no controla turnos', r.status === 403);
  await api('turn', { t: 'ban', op: 'goto', g: 'p0' }, A); d = (await api('data', null, A)).j; ok('Administradora da el turno a PSC', d.E['c:ban'].turn === 0);
  r = await api('reserve', { i: 'b4' }, T.PSC); d = (await api('data', null, A)).j; ok('Al llegar al máximo (3) el turno pasa solo al siguiente', r.status === 200 && d.E['c:ban'].turn === 1 && d.E['c:ban'].used === 0, JSON.stringify(d.E['c:ban']));
  await api('turn', { t: 'ban', op: 'goto', g: 'p0' }, A);
  r = await api('reserve', { i: 'b5' }, T.PSC); ok('Máximo por partido (3): rechazo', r.status === 403 && /máximo/.test(r.j.error), r.j.error);
  r = await api('reserve', { i: 'b5', g: 'p0' }, A); ok('La administradora puede asignar por encima de las reglas', r.status === 200);
  await api('turn', { t: 'ban', op: 'reset' }, A); d = (await api('data', null, A)).j; ok('Reiniciar: ronda 1, y si el primero ya tiene el máximo empieza el siguiente', d.E['c:ban'].round === 1 && d.E['c:ban'].turn === 1, JSON.stringify({ r: d.E['c:ban'].round, t: d.E['c:ban'].turn }));
  // espacios
  r = await api('reserve', { i: 'e0', slot: '2027-07-09M' }, T.PSC); ok('Espacios cerrados: rechazo', r.status === 403 && /no está abierta/.test(r.j.error));
  await api('sync', { changes: { 'c:esp': { k: 'c', mode: 'libre', order: [], quota: 1, max: 2 } }, since: 0 }, A);
  r = await api('reserve', { i: 'e0', slot: '2027-07-08M' }, T.PSC); ok('Franja no disponible: rechazo', r.status === 409);
  r = await api('reserve', { i: 'e0', slot: '2027-07-30M' }, T.PSC); ok('Día fuera de campaña: rechazo', r.status === 400);
  r = await api('reserve', { i: 'e0' }, T.PSC); ok('Espacio sin día: rechazo', r.status === 400);
  r = await api('reserve', { i: 'e0', slot: '2027-07-08T' }, T.PSC); ok('Franja con restricciones: se puede', r.status === 200);
  r = await api('reserve', { i: 'e0', slot: '2027-07-08T' }, T.PP); ok('Misma franja otro partido: rechazo', r.status === 409);
  r = await api('reserve', { i: 'e0', slot: '2027-07-09T' }, T.PP); ok('Otra franja, otro partido', r.status === 200);
  r = await api('sync', { changes: { 'i:e0': { k: 'i', t: 'esp', ord: 1, nom: 'Plaça Catalunya', blk: { '2027-07-09T': 'nd' } } }, since: 0 }, A); ok('No se puede marcar N/D una franja reservada', r.j.rejected.length === 1);
  r = await api('sync', { changes: { 'i:b0': { x: true } }, since: 0 }, A); ok('No se elimina un elemento con reservas', r.j.rejected.length === 1);
  r = await api('sync', { changes: { 'g:p0': { x: true } }, since: 0 }, A); ok('No se elimina un partido con reservas', r.j.rejected.length === 1);
  r = await api('sync', { changes: { 'i:b0': { k: 'i', t: 'ban', nom: 'X' } }, since: 0 }, T.PSC); ok('Partido no puede editar elementos', r.status === 403);
  // cerrar y liberar
  await api('sync', { changes: { 'c:esp': { k: 'c', mode: 'cerrado', order: [], quota: 1, max: 2 } }, since: 0 }, A);
  r = await api('release', { i: 'e0', slot: '2027-07-08T' }, T.PSC); ok('Selección cerrada: el partido no puede liberar', r.status === 403);
  r = await api('release', { i: 'e0', slot: '2027-07-08T' }, A); ok('La administradora libera', r.status === 200);
  // serpiente
  await api('sync', { changes: { 'c:pan': { k: 'c', mode: 'turnos', order: ['p0', 'p1'], quota: 1, max: 0, snake: true } }, since: 0 }, A);
  await api('turn', { t: 'pan', op: 'pass' }, A); await api('turn', { t: 'pan', op: 'pass' }, A); d = (await api('data', null, A)).j;
  const c = d.E['c:pan']; ok('Orden en serpiente: en la ronda 2 empieza el último', c.round === 2 && (c.snake ? ['p1', 'p0'][c.turn] : '') === 'p1', JSON.stringify(c));
  // reparto: votos, método y cupos por partido
  r = await api('sync', { changes: { 'g:p0': { k: 'g', sig: 'PSC', nom: 'PSC nombre', ord: 1, col: '#112230', vot: 25432 } }, since: 0 }, A); d = (await api('data', null, A)).j;
  ok('Votos de las anteriores elecciones guardados', r.j.rejected.length === 0 && d.E['g:p0'].vot === 25432 && d.E['g:p0'].rep === '', JSON.stringify(r.j.rejected));
  r = await api('sync', { changes: { 'g:p1': { k: 'g', sig: 'PP', vot: -5 } }, since: 0 }, A); ok('Votos no válidos: rechazo', r.j.rejected.length === 1);
  r = await api('sync', { changes: { 's:conf': { k: 's', org: 'Ajuntament', tit: 'Generales 2027', d0: '2027-07-07', d1: '2027-07-21', rv: 'Generales 2023', rmin: '1', rmeth: { ban: 'prop', esp: 'igual' } } }, since: 0 }, A); d = (await api('data', null, A)).j;
  ok('Datos del reparto en la configuración', r.j.rejected.length === 0 && d.E['s:conf'].rv === 'Generales 2023' && d.E['s:conf'].rmin === 1 && d.E['s:conf'].rmeth.esp === 'igual');
  r = await api('sync', { changes: { 's:conf': { k: 's', d0: '2027-07-07', d1: '2027-07-21', rmeth: { ban: 'sorteo' } } }, since: 0 }, A); ok('Método de reparto no válido: rechazo', r.j.rejected.length === 1);
  r = await api('sync', { changes: { 'c:pri': { k: 'c', mode: 'turnos', order: ['p0', 'p1', 'p2'], quota: 1, max: 0, cup: { p0: 2, p1: 1, p2: 0, nadie: 3 } } }, since: 0 }, A); d = (await api('data', null, A)).j;
  ok('Cupos por partido guardados (se ignoran partidos inexistentes)', r.j.rejected.length === 0 && JSON.stringify(d.E['c:pri'].cup) === JSON.stringify({ p0: 2, p1: 1, p2: 0 }), JSON.stringify(d.E['c:pri'].cup));
  r = await api('sync', { changes: { 'c:pri': { k: 'c', mode: 'turnos', order: ['p0'], quota: 1, max: 0, cup: { p0: -1 } } }, since: 0 }, A); ok('Cupo no válido: rechazo', r.j.rejected.length === 1);
  await api('turn', { t: 'pri', op: 'reset' }, A);
  r = await api('reserve', { i: 'r0' }, T.PSC); d = (await api('data', null, A)).j; ok('Reparto por turnos: PSC elige 1 y pasa a PP', r.status === 200 && d.E['c:pri'].turn === 1);
  r = await api('reserve', { i: 'r1' }, T.PP); d = (await api('data', null, A)).j;
  ok('PP completa su cupo (1); VOX (cupo 0) se salta y vuelve PSC en la ronda 2', r.status === 200 && d.E['c:pri'].turn === 0 && d.E['c:pri'].round === 2, JSON.stringify({ t: d.E['c:pri'].turn, r: d.E['c:pri'].round }));
  r = await api('reserve', { i: 'r2' }, T.PP); ok('Quien completó su cupo ya no puede elegir', r.status === 403);
  r = await api('reserve', { i: 'r2' }, T.PSC); d = (await api('data', null, A)).j;
  ok('Todos completan su cupo: la selección termina aunque queden prismas', r.status === 200 && d.E['c:pri'].done === true, JSON.stringify(d.E['c:pri']));
  await api('sync', { changes: { 'c:pri': { k: 'c', mode: 'libre', order: ['p0', 'p1', 'p2'], quota: 1, max: 0, cup: { p0: 2, p1: 1, p2: 0 } } }, since: 0 }, A);
  r = await api('reserve', { i: 'r3' }, T.VOX); ok('En modo libre, sin cupo no se puede elegir', r.status === 403 && /No tenéis cupo/.test(r.j.error), r.j.error);
  r = await api('reserve', { i: 'r3' }, T.PSC); ok('En modo libre, cupo completo: rechazo', r.status === 403 && /cupo/.test(r.j.error), r.j.error);
  r = await api('reserve', { i: 'r3', g: 'p2' }, A); ok('La administradora asigna aunque no haya cupo', r.status === 200);
  await api('sync', { changes: { 'c:pri': { k: 'c', mode: 'turnos', order: ['p2', 'p0', 'p1'], quota: 1, max: 0, cup: { p0: 3, p1: 1, p2: 0 } } }, since: 0 }, A); await api('turn', { t: 'pri', op: 'reset' }, A); d = (await api('data', null, A)).j;
  ok('Si el turno cae en quien no tiene cupo, pasa solo al siguiente', d.E['c:pri'].turn === 1 && !d.E['c:pri'].done, JSON.stringify({ t: d.E['c:pri'].turn, done: d.E['c:pri'].done }));
  // no disponible con motivo
  r = await api('sync', { changes: { 'i:b0': { k: 'i', t: 'ban', ord: 1, nom: 'Calle 0', tram: 'A/B', bf: 3, pf: 2, nd: true, ndm: 'Obras' } }, since: 0 }, A);
  ok('No se puede inhabilitar algo reservado', r.j.rejected.length === 1 && /reservas/.test(r.j.rejected[0].reason), JSON.stringify(r.j.rejected));
  r = await api('sync', { changes: { 'i:b3': { k: 'i', t: 'ban', ord: 4, nom: 'Calle 3', tram: 'A/B', bf: 3, pf: 2, nd: true, ndm: 'Obras en la calle' } }, since: 0 }, A); d = (await api('data', null, A)).j;
  ok('Inhabilitar un elemento libre con su motivo', r.j.rejected.length === 0 && d.E['i:b3'].nd === true && d.E['i:b3'].ndm === 'Obras en la calle');
  r = await api('reserve', { i: 'b3', g: 'p1' }, A); ok('Lo inhabilitado no se puede elegir (ni asignar)', r.status === 409 && /Obras en la calle/.test(r.j.error), r.j.error);
  ok('Queda en el registro con el motivo', Object.values(d.E).some((e) => e.k === 'h' && /no disponible «Calle 3 · A\/B»: Obras en la calle/.test(e.a)));
  r = await api('sync', { changes: { 'i:b3': { k: 'i', t: 'ban', ord: 4, nom: 'Calle 3', tram: 'A/B', bf: 3, pf: 2, nd: false } }, since: 0 }, A); d = (await api('data', null, A)).j;
  ok('Volver a habilitarlo', d.E['i:b3'].nd === false && d.E['i:b3'].ndm === '');
  // copia permanente con nombre
  r = await api('keep', { label: 'Resultado final Generales' }, A); ok('Copia permanente con nombre', r.status === 200 && /^keep\//.test(r.j.key));
  r = await api('keep', { label: 'x' }, T.PSC); ok('Un partido no puede guardar copias', r.status === 403);
  // registro y copias
  d = (await api('data', null, A)).j; const logs = Object.values(d.E).filter((e) => e.k === 'h');
  ok('Todas las anotaciones del registro tienen fecha y hora válidas', logs.every((l) => Number.isFinite(l.ts) && l.ts > 1.6e12), logs.filter((l) => !Number.isFinite(l.ts)).map((l) => l.a).join(' | '));
  ok('Registro de movimientos', logs.length >= 10 && logs.some((l) => /reservó/.test(l.a)) && logs.some((l) => /liberó/.test(l.a)) && logs.some((l) => /turno/.test(l.a)), logs.length + ' entradas');
  const h = (await api('history', null, A)).j.items; ok('Copias automáticas en el servidor', h.length >= 1, h.length + '');
  const nlogs = logs.length; r = await api('restore', { key: h[h.length - 1] }, A); d = (await api('data', null, A)).j;
  ok('Restaurar no borra el registro', r.status === 200 && Object.values(d.E).filter((e) => e.k === 'h').length >= nlogs);
  const hi = (await api('history', null, A)).j;
  ok('Copia de cada modificación en el almacén de copias', hi.changes >= 30, hi.changes + ' modificaciones copiadas');
  ok('Copia diaria permanente', hi.days.length === 1 && /^day\/\d{4}-\d{2}-\d{2}$/.test(hi.days[0]), hi.days.join());
  r = await api('restore', { key: hi.days[0] }, A); ok('Se puede restaurar desde la copia diaria', r.status === 200);
  ok('La copia permanente aparece con su nombre', hi.keep.length === 1 && hi.keep[0].label === 'Resultado final Generales' && hi.keep[0].by === 'Rosana');
  r = await api('restore', { key: hi.keep[0].key }, A); ok('Se puede restaurar desde la copia permanente', r.status === 200);
  r = await api('restore', { key: 'db' }, A); ok('Restaurar solo acepta copias (no otras claves)', r.status === 400);
  const exp = (await api('export', null, A)).j; ok('Copia descargable completa', exp.app === 'espais' && Object.keys(exp.E).length > 20);
  r = await api('export', null, T.PSC); ok('Partido no descarga copias', r.status === 403);
  // seguridad
  const [p64, sig] = T.PSC.split('.'), pay = JSON.parse(Buffer.from(p64, 'base64url').toString()); pay.id = Object.keys((await api('data', null, A)).j.users.reduce((o, u) => (u.role === 'admin' ? Object.assign(o, { [u.id]: 1 }) : o), {}))[0];
  r = await api('data', null, Buffer.from(JSON.stringify(pay)).toString('base64url') + '.' + sig); ok('Sesión manipulada (hacerse pasar por la administradora): rechazo', r.status === 401);
  r = await api('data', null, 'abc.def'); ok('Sesión inventada: rechazo', r.status === 401);
  r = await api('data'); ok('Sin sesión no se ve ningún dato', r.status === 401);
  for (const [p, b] of [['users', { op: 'add', name: 'Intruso', role: 'admin', password: 'intruso123' }], ['history', null], ['restore', { key: 'hist/x' }], ['import', { E: {} }], ['sync', { changes: {} }]]) { r = await api(p, b, T.PSC); ok('Un partido no puede usar «' + p + '»', r.status === 403, r.status); }
  r = await fetch(B + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A }, body: '{mal' }); ok('Petición mal formada: rechazo limpio', r.status === 400);
  r = await fetch(B + '/api/sync', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + A }, body: JSON.stringify({ x: 'a'.repeat(6 * 1024 * 1024) }) }); ok('Petición gigante: rechazo', r.status === 413);
  r = await api('sync', { changes: { 'g:p0': { k: 'g', sig: '<b>x</b>'.repeat(10) } }, since: 0 }, A); ok('Textos demasiado largos: rechazo', r.j.rejected.length === 1);
  let st = []; for (let i = 0; i < 5; i++) st.push((await api('login', { name: 'JEZ', password: 'mala' + i })).status);
  r = await api('login', { name: 'JEZ', password: 'provis123' }); ok('5 contraseñas fallidas bloquean el usuario aunque luego acierte', st.every((s) => s === 401) && r.status === 429, st.join(',') + ' → ' + r.status);
  r = await api('login', { name: 'nadie', password: 'x' }); ok('Usuario inexistente: mismo mensaje que contraseña mala', r.status === 401 && /Usuario o contraseña incorrectos/.test(r.j.error));
  console.log(R.join('\n')); console.log(R.filter((x) => x.startsWith('OK')).length + '/' + R.length); process.exitCode = R.some((x) => x.startsWith('FALLO')) ? 1 : 0;
})().catch((e) => { console.log(R.join('\n')); console.error('ERROR', e); process.exit(1); });
