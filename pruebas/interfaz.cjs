// Prueba completa de la interfaz de Espais electorals: administradora + 3 partidos + consulta, en navegadores separados
// Necesita pruebas/servidor.mjs en marcha (almacén vacío), Playwright con Chromium y poppler-utils (pdfinfo, pdftotext).
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const S = process.env.SALIDA || path.join(os.tmpdir(), 'espais-pruebas'), B = 'http://localhost:' + (process.env.PORT || 8899), XL = path.join(__dirname, 'datos', 'espais-ejemplo.xlsx');
fs.mkdirSync(S, { recursive: true });
const R = []; const ok = (n, c, x) => { R.push((c ? 'OK   ' : 'FALLO') + ' ' + n + (x != null && x !== '' ? ' · ' + x : '')); };
const errs = [], cons = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const br = await chromium.launch();
  async function open(name) {
    const ctx = await br.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true }); const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(name + ': ' + e.message));
    pg.on('console', (m) => { if (m.type() === 'error' && !/status of (4\d\d)/.test(m.text())) cons.push(name + ': ' + m.text()); });
    await pg.goto(B); pg.__n = name; return pg;
  }
  const tab = async (pg, v) => { await pg.click('#tabs [data-v=' + v + ']'); await pg.waitForSelector('#tabs [data-v=' + v + '].on'); };
  const settled = (pg) => pg.waitForFunction(() => /Al día/.test((document.querySelector('#sync') || {}).textContent || ''), null, { timeout: 15000 });
  const yes = async (pg) => { await pg.waitForSelector('#cfYes'); await pg.click('#cfYes'); };
  const toastIs = async (pg, re, ms) => { try { await pg.waitForFunction((s) => new RegExp(s).test(document.querySelector('#toast').textContent) && document.querySelector('#toast').classList.contains('on'), re.source, { timeout: ms || 6000 }); return true; } catch (e) { return false; } };
  const txt = (pg, sel) => pg.evaluate((s) => (document.querySelector(s) || {}).innerText || '', sel);
  const apiAs = (pg, path) => pg.evaluate(async (p) => { const r = await fetch('/api/' + p, { headers: { authorization: 'Bearer ' + sessionStorage.getItem('espais.tok') } }); return r.json(); }, path);
  const setVal = async (pg, sel, v) => { await pg.evaluate(([s, v]) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [sel, v]); };

  /* ================= INSTALACIÓN ================= */
  const A = await open('Rosana');
  await A.waitForSelector('#lkCode');
  ok('Primera vez: pantalla de instalación, con la versión del programa', /Instalación/.test(await txt(A, '#lock')) && /Versión 1\.2/.test(await txt(A, '#lock')));
  await A.fill('#lkCode', 'mala'); await A.fill('#lkName', 'Rosana'); await A.fill('#lkPass', 'Rosana-2027'); await A.fill('#lkPass2', 'Rosana-2027'); await A.click('[data-a=lk-setup]');
  await A.waitForSelector('#lock .err'); ok('Clave de instalación incorrecta: se rechaza', /no es correcta/.test(await txt(A, '#lock .err')));
  await A.fill('#lkCode', 'clave-prueba'); await A.click('[data-a=lk-setup]'); await A.waitForSelector('#tabs [data-v=panel]');
  ok('Administradora creada y dentro', /Rosana · Administración/.test(await txt(A, '#who')));
  ok('Panel con la puesta en marcha guiada', /Puesta en marcha/.test(await txt(A, '#view')));
  ok('Pestañas de administración', (await A.locator('#tabs button').allInnerTexts()).join('|') === 'Panel|En directo|Espacios|Banderolas|Pancartas|Prismas|Partidos|Reparto|Turnos y reglas|Registro|Ajustes|Ayuda');

  /* ================= AJUSTES ================= */
  await tab(A, 'ajustes');
  await A.fill('[data-conf=tit]', 'Eleccions Generals 2023 · Espais electorals'); await A.press('[data-conf=tit]', 'Tab');
  ok('Por defecto: Elecciones Generales (Congreso) y Ajuntament de Santa Coloma de Gramenet', (await A.inputValue('[data-conf=tipo]')) === 'generales' && /Ajuntament de Santa Coloma de Gramenet/.test(await txt(A, '#org')));
  await setVal(A, '[data-conf=dv]', '2023-07-23'); await settled(A);
  ok('Día de la votación → campaña calculada sola (7 al 21 de julio, art. 51 LOREG)', (await A.inputValue('[data-conf=d0]')) === '2023-07-07' && (await A.inputValue('[data-conf=d1]')) === '2023-07-21', (await A.inputValue('[data-conf=d0]')) + ' → ' + (await A.inputValue('[data-conf=d1]')));
  await A.fill('[data-conf=nota]', 'Cada partido elige en su turno. Dudas: 93 462 40 00.'); await A.press('[data-conf=nota]', 'Tab');
  await settled(A);
  ok('Título visible en la cabecera', /Eleccions Generals 2023/.test(await txt(A, '#tit')));
  await setVal(A, '[data-conf=d1]', '2023-07-01'); ok('Fecha final anterior a la inicial: aviso y no se guarda', await toastIs(A, /anterior a la inicial/));
  await tab(A, 'ajustes'); ok('Las fechas siguen bien', (await A.inputValue('[data-conf=d1]')) === '2023-07-21');

  /* ================= IMPORTAR EXCEL ================= */
  let [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('#view [data-a=imp-xls]')]);
  await fc.setFiles(XL); await A.waitForSelector('.impChk');
  const impTxt = await txt(A, '#modal');
  const num = (lab) => { const m = new RegExp(lab + ': (\\d+) nuevos').exec(impTxt); return m ? +m[1] : -1; };
  ok('Excel: hojas reconocidas', /ESPAIS/.test(impTxt) && /BANDEROLES/.test(impTxt) && /PANCARTES/.test(impTxt) && /PRISMES/.test(impTxt) && /GRAELLA/.test(impTxt));
  ok('Excel: 30 espacios', num('Espacios electorales') === 30, num('Espacios electorales'));
  ok('Excel: banderolas', num('Banderolas') > 300, num('Banderolas'));
  ok('Excel: pancartas', num('Pancartas') > 40, num('Pancartas'));
  ok('Excel: prismas', num('Prismas') > 40, num('Prismas'));
  ok('Excel: 13 partidos de la GRAELLA (sin confundirlos con espacios)', num('Partidos') === 13, num('Partidos'));
  await A.click('[data-a=imp-ok]'); await settled(A);
  let d = await apiAs(A, 'data'); const P = {}; const items = { esp: [], ban: [], pan: [], pri: [] };
  for (const k in d.E) { const e = d.E[k]; if (e.k === 'g' && !e.x) P[e.sig] = k.slice(2); if (e.k === 'i' && !e.x) items[e.t].push(Object.assign({ id: k.slice(2) }, e)); }
  ok('Importado y guardado en el servidor', items.esp.length === 30 && items.ban.length === num('Banderolas') && Object.keys(P).length === 13, items.esp.length + '/' + items.ban.length + '/' + items.pan.length + '/' + items.pri.length + ' · ' + Object.keys(P).join(','));
  ok('Partido VALENTS con orden 1 y ARA PL con 13', d.E['g:' + P.VALENTS].ord === 1 && d.E['g:' + P['ARA PL']].ord === 13);
  [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('#view [data-a=imp-xls]')]);
  await fc.setFiles(XL); await A.waitForSelector('.impChk');
  const imp2 = await txt(A, '#modal'); ok('Reimportar el mismo Excel no duplica nada', !/[1-9]\d* nuevos/.test(imp2), imp2.replace(/\s+/g, ' ').slice(0, 200));
  await A.click('[data-a=imp-ok]'); ok('Aviso: nada nuevo', await toastIs(A, /No había nada nuevo/));

  /* ================= PARTIDOS Y USUARIOS ================= */
  await tab(A, 'partidos');
  ok('Lista de partidos (13)', (await A.locator('#view tbody tr').count()) === 13);
  const V = P.VALENTS, PS = P['PSC-CP'], CU = P['CUP-GG-AMUNT'];
  await A.fill('#rg-' + V + '-nom', 'Valents'); await A.press('#rg-' + V + '-nom', 'Tab');
  await A.fill('#rg-' + V + '-rep', 'Joan Representant'); await A.press('#rg-' + V + '-rep', 'Tab');
  await A.fill('#rg-' + V + '-tel', '600111222'); await A.press('#rg-' + V + '-tel', 'Tab');
  // texto malicioso a propósito: nunca debe ejecutarse (se comprueba al final en todas las pantallas)
  await A.fill('#rg-' + P.PACMA + '-nom', 'Pacma <img src=x onerror="window.__xss=1"><script>window.__xss=2</script>'); await A.press('#rg-' + P.PACMA + '-nom', 'Tab');
  await settled(A);
  for (const [g, name] of [[V, 'VALENTS'], [PS, 'PSC-CP'], [CU, 'CUP-GG-AMUNT']]) {
    await A.click('[data-a=u-add][data-g="' + g + '"]'); await A.waitForSelector('#uaName');
    ok('Alta de usuario de ' + name + ': datos prerrellenados', (await A.inputValue('#uaName')) === name && (await A.inputValue('#uaRole')) === 'partido' && (await A.inputValue('#uaParty')) === g);
    await A.fill('#pwNew', 'Provisional1'); await A.fill('#pwNew2', 'Provisional1'); await A.click('[data-a=ua-save]');
    await toastIs(A, /Usuario creado/); await A.waitForSelector('#modal', { state: 'hidden' });
  }
  ok('Usuarios visibles junto a cada partido', /VALENTS/.test(await A.locator('#view tbody tr').first().innerText()));
  await tab(A, 'ajustes'); await A.click('.card [data-a=u-add]'); await A.waitForSelector('#uaName');
  await A.fill('#uaName', 'JEZ'); await A.selectOption('#uaRole', 'consulta'); await A.fill('#pwNew', 'Provisional1'); await A.fill('#pwNew2', 'Provisional1'); await A.click('[data-a=ua-save]'); await toastIs(A, /Usuario creado/);
  await A.click('.card [data-a=u-add]'); await A.waitForSelector('#uaName'); await A.fill('#uaName', 'vALENTS'); await A.fill('#pwNew', 'Provisional1'); await A.fill('#pwNew2', 'Provisional1'); await A.selectOption('#uaParty', V); await A.click('[data-a=ua-save]');
  ok('Nombre de usuario repetido: rechazo', await toastIs(A, /Ya existe un usuario/)); await A.click('[data-a=m-no]');
  ok('Ajustes: 5 usuarios con su rol', (await A.locator('#view .tbl tbody tr').count()) === 5);

  /* ================= TURNOS Y REGLAS ================= */
  await tab(A, 'turnos');
  await A.click('[data-a=cfg-mode][data-t=ban][data-v=turnos]'); await toastIs(A, /orden de la pestaña Partidos/);
  for (let i = 0; i < 10; i++) await A.click('[data-a=o-del][data-t=ban][data-i="3"]');
  ok('Banderolas: orden de 3 partidos', (await A.locator('[data-a=o-del][data-t=ban]').count()) === 3);
  await A.fill('[data-cfg=ban][data-f=quota]', '2'); await A.press('[data-cfg=ban][data-f=quota]', 'Tab');
  await A.fill('[data-cfg=ban][data-f=max]', '3'); await A.press('[data-cfg=ban][data-f=max]', 'Tab');
  await A.fill('[data-cfg=ban][data-f=msg]', 'Recordad: máximo 3 tramos por partido.'); await A.press('[data-cfg=ban][data-f=msg]', 'Tab');
  await A.click('[data-a=cfg-mode][data-t=esp][data-v=libre]');
  await A.fill('[data-cfg=esp][data-f=max]', '4'); await A.press('[data-cfg=esp][data-f=max]', 'Tab');
  await A.click('[data-a=cfg-mode][data-t=pri][data-v=turnos]');
  for (let i = 0; i < 10; i++) await A.click('[data-a=o-del][data-t=pri][data-i="3"]');
  await A.check('[data-cfg=pri][data-f=snake]');
  await settled(A);
  d = await apiAs(A, 'data');
  ok('Reglas guardadas en el servidor', d.E['c:ban'].mode === 'turnos' && d.E['c:ban'].quota === 2 && d.E['c:ban'].max === 3 && d.E['c:ban'].order.join() === [V, PS, CU].join() && d.E['c:esp'].mode === 'libre' && d.E['c:esp'].max === 4 && d.E['c:pri'].snake === true && !d.E['c:pan'], JSON.stringify(d.E['c:ban']));
  ok('Subir en el orden', true);
  await A.click('[data-a=o-down][data-t=pri][data-i="0"]'); await settled(A); d = await apiAs(A, 'data');
  ok('Reordenar turnos (bajar)', d.E['c:pri'].order.join() === [PS, V, CU].join());
  await A.click('[data-a=o-up][data-t=pri][data-i="1"]'); await settled(A); d = await apiAs(A, 'data');
  ok('Reordenar turnos (subir)', d.E['c:pri'].order.join() === [V, PS, CU].join());

  /* ================= ENTRAN LOS PARTIDOS ================= */
  async function partyLogin(name) {
    const pg = await open(name); await pg.waitForSelector('#lkName');
    await pg.fill('#lkName', name.toLowerCase()); await pg.fill('#lkPass', 'Provisional1'); await pg.click('[data-a=lk-login]');
    await pg.waitForSelector('#pwNew'); await pg.fill('#pwNew', 'Partido-123'); await pg.fill('#pwNew2', 'Partido-123'); await pg.click('[data-a=pw-force]');
    await toastIs(pg, /Contraseña guardada/); return pg;
  }
  const PV = await partyLogin('VALENTS'), PP = await partyLogin('PSC-CP'), PC = await partyLogin('CUP-GG-AMUNT');
  ok('Partido: obligado a cambiar la contraseña provisional y dentro', /VALENTS · Partido/.test(await txt(PV, '#who')));
  ok('Partido: sin pestaña de turnos ni gestión', !(await PV.locator('#tabs [data-v=turnos]').count()));
  ok('VALENTS ve «Es vuestro turno» en Banderolas y Prismas', /Es vuestro turno en Banderolas/.test(await txt(PV, '#banner')) && /Es vuestro turno en Prismas/.test(await txt(PV, '#banner')));
  ok('PSC-CP no tiene turno', !/Es vuestro turno/.test(await txt(PP, '#banner')));
  ok('El título de la pestaña avisa del turno (útil si está en segundo plano)', /^🟢 Es vuestro turno/.test(await PV.title()) && !/turno/.test(await PP.title()), await PV.title());
  ok('Instrucciones generales visibles para los partidos', /Dudas: 93 462 40 00/.test(await txt(PP, '#view')));
  const dP = await apiAs(PP, 'data');
  ok('Un partido no ve los contactos de otro', dP.E['g:' + V].rep === '' && dP.E['g:' + V].tel === '' && dP.E['g:' + V].nom === 'Valents');
  ok('Un partido solo ve su propio usuario', dP.users.length === 1 && dP.users[0].name === 'PSC-CP');
  await tab(PP, 'partidos'); ok('Pestaña Partidos sin datos de contacto', !/Joan Representant|600111222/.test(await txt(PP, '#view')));

  /* ================= BANDEROLAS POR TURNOS ================= */
  await tab(PP, 'ban');
  ok('Fuera de turno: sin botones de reservar y con el motivo', (await PP.locator('[data-a=res]').count()) === 0 && /No es vuestro turno: ahora elige VALENTS/.test(await txt(PP, '#view')));
  ok('Aviso del Ayuntamiento visible', /máximo 3 tramos/.test(await txt(PP, '#view')));
  await tab(PV, 'ban');
  ok('En su turno: botones «Reservar»', (await PV.locator('[data-a=res]').count()) === items.ban.length);
  const b0 = await PV.locator('[data-a=res]').nth(0).getAttribute('data-i'), b1 = await PV.locator('[data-a=res]').nth(1).getAttribute('data-i');
  await PV.click('[data-a=res][data-i="' + b0 + '"]'); await yes(PV); ok('VALENTS reserva una banderola', await toastIs(PV, /Reservado para VALENTS/));
  ok('Contador del turno: 1 de 2', /1 de 2 elecciones/.test(await txt(PV, '#view .turnbox')));
  await PV.click('[data-a=res][data-i="' + b1 + '"]'); await yes(PV); await toastIs(PV, /Reservado para VALENTS/);
  await PV.waitForFunction(() => !/Es vuestro turno en Banderolas/.test(document.querySelector('#banner').innerText));
  ok('Al completar 2 elecciones el turno pasa solo', /Turno de\s*PSC-CP/.test(await txt(PV, '#view .turnbox')));
  ok('VALENTS ya no puede reservar', (await PV.locator('[data-a=res]').count()) === 0);
  const t0 = Date.now(); await PP.waitForSelector('.banner.turn', { timeout: 9000 }).catch(() => {});
  ok('PSC-CP recibe el turno casi al momento (sin recargar)', /Es vuestro turno en Banderolas/.test(await txt(PP, '#banner')), ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  await PP.waitForSelector('[data-a=res]');
  ok('Lo de VALENTS aparece ocupado y sin botón para PSC-CP', (await PP.locator('tr.taken').count()) === 2 && !(await PP.locator('[data-a=res][data-i="' + b0 + '"]').count()) && /VALENTS/.test(await PP.locator('tr.taken').first().innerText()));
  ok('Filtro «Solo los nuestros» de VALENTS', await (async () => { await PV.selectOption('#flt-ban', 'mine'); const n = await PV.locator('#view tbody tr').count(); await PV.selectOption('#flt-ban', 'all'); return n === 2; })());
  await PP.fill('#q-ban', 'zzzz-no-existe'); ok('Buscador sin resultados', /Nada coincide/.test(await txt(PP, '#view'))); await PP.fill('#q-ban', '');
  // carrera: dos partidos sobre el mismo elemento (solo lo intenta quien tiene el turno; el otro ni ve el botón)
  const b2 = await PP.locator('[data-a=res]').nth(0).getAttribute('data-i');
  await PP.click('[data-a=res][data-i="' + b2 + '"]'); await yes(PP); await toastIs(PP, /Reservado para PSC-CP/);
  await PP.click('.banner.turn [data-a=pass]'); await yes(PP); ok('PSC-CP termina su turno con 1 elección', await toastIs(PP, /Turno pasado. Ahora elige CUP-GG-AMUNT/));
  await PC.waitForSelector('.banner.turn', { timeout: 9000 }).catch(() => {});
  ok('CUP-GG-AMUNT recibe el turno', /Es vuestro turno en Banderolas/.test(await txt(PC, '#banner')));
  await PC.click('.banner.turn [data-a=tab][data-v=ban]'); await PC.waitForSelector('[data-a=res]');
  const b3 = await PC.locator('[data-a=res]').nth(0).getAttribute('data-i');
  await PC.click('[data-a=res][data-i="' + b3 + '"]'); await yes(PC); await toastIs(PC, /Reservado/);
  // liberar en su turno: recupera la elección
  await PC.click('[data-a=rel][data-i="' + b3 + '"]'); await yes(PC); ok('CUP libera en su turno', await toastIs(PC, /Liberado/));
  ok('…y recupera la elección (0 de 2)', /0 de 2 elecciones/.test(await txt(PC, '#view .turnbox')));
  const b4 = await PC.locator('[data-a=res]').nth(0).getAttribute('data-i'), b5 = await PC.locator('[data-a=res]').nth(1).getAttribute('data-i');
  await PC.click('[data-a=res][data-i="' + b4 + '"]'); await yes(PC); await toastIs(PC, /Reservado/);
  await PC.click('[data-a=res][data-i="' + b5 + '"]'); await yes(PC); await toastIs(PC, /Reservado/);
  await PV.waitForFunction(() => /Es vuestro turno en Banderolas/.test(document.querySelector('#banner').innerText), null, { timeout: 9000 }).catch(() => {});
  ok('Ronda 2: vuelve a VALENTS', /Es vuestro turno en Banderolas/.test(await txt(PV, '#banner')) && /Ronda 2/.test(await txt(PV, '#view .turnbox')));
  const b6 = await PV.locator('[data-a=res]').nth(0).getAttribute('data-i');
  await PV.click('[data-a=res][data-i="' + b6 + '"]'); await yes(PV); await toastIs(PV, /Reservado/);
  await PV.waitForFunction(() => !/Es vuestro turno en Banderolas/.test(document.querySelector('#banner').innerText));
  ok('VALENTS llega al máximo (3) y el turno pasa solo', /Turno de\s*PSC-CP/.test(await txt(PV, '#view .turnbox')) && /3 \/ 3/.test(await txt(PV, '#view .kpis')));
  // liberar fuera de turno
  await PV.click('[data-a=rel][data-i="' + b6 + '"]'); await yes(PV); await toastIs(PV, /Liberado/);
  await PP.waitForFunction((i) => !!document.querySelector('[data-a=res][data-i="' + i + '"]'), b6, { timeout: 9000 }).catch(() => {});
  ok('Lo liberado vuelve a estar libre para los demás', (await PP.locator('[data-a=res][data-i="' + b6 + '"]').count()) === 1);

  /* ================= ESPACIOS: CUADRANTE EN MODO LIBRE ================= */
  await tab(A, 'esp'); await A.waitForSelector('.cgrid');
  ok('Cuadrante: 30 espacios × 15 días × 2 franjas', (await A.locator('.cgrid td.cc').count()) === 30 * 30, await A.locator('.cgrid td.cc').count());
  const e0 = items.esp.sort((a, b) => a.ord - b.ord)[0].id, e1 = items.esp[1].id, e5 = items.esp[5].id;
  // la administradora marca disponibilidad: una franja con restricciones y un bloque de no disponible
  await A.click('.cc button[data-i="' + e0 + '"][data-s="2023-07-08M"]'); await A.waitForSelector('#modal [data-a=blk]');
  await A.click('#modal [data-a=blk][data-v=rs]'); await toastIs(A, /Disponibilidad actualizada/);
  await A.click('[data-a=blk-row][data-i="' + e1 + '"]'); await A.waitForSelector('#bkD0');
  await A.uncheck('#bkT'); for (const w of ['1', '2', '3', '4', '5']) await A.uncheck('.bkW[value="' + w + '"]');
  await A.click('[data-a=bk-v][data-v=nd]'); await A.click('[data-a=blkr-ok]');
  ok('Disponibilidad en bloque: mañanas de fin de semana no disponibles', await toastIs(A, /4 franjas actualizadas/), await txt(A, '#toast'));
  await settled(A); d = await apiAs(A, 'data');
  ok('…guardado en el servidor', JSON.stringify(d.E['i:' + e1].blk) === JSON.stringify({ '2023-07-08M': 'nd', '2023-07-09M': 'nd', '2023-07-15M': 'nd', '2023-07-16M': 'nd' }) && d.E['i:' + e0].blk['2023-07-08M'] === 'rs', JSON.stringify(d.E['i:' + e1].blk));
  await tab(PV, 'esp'); await tab(PP, 'esp');
  await PV.waitForFunction((i) => document.querySelector('.cc button[data-i="' + i + '"][data-s="2023-07-08M"]').parentNode.classList.contains('nd'), e1, { timeout: 9000 }).catch(() => {});
  ok('Los partidos ven N/D y ⚠ en el cuadrante', (await PV.locator('.cc.nd').count()) === 4 && (await PV.locator('.cc.rs').count()) === 1);
  await PV.click('.cc button[data-i="' + e1 + '"][data-s="2023-07-08M"]'); await PV.waitForSelector('#modal h2');
  ok('Franja N/D: sin botón de reservar', /No disponible/.test(await txt(PV, '#modal')) && !(await PV.locator('#modal [data-a=res]').count())); await PV.click('#modal [data-a=m-no]');
  // dos partidos pulsan la misma casilla a la vez
  const cell = '.cc button[data-i="' + e5 + '"][data-s="2023-07-10T"]';
  await PV.click(cell); await PP.click(cell); await PV.click('#modal [data-a=res]'); await PP.click('#modal [data-a=res]');
  await PV.waitForSelector('#cfYes'); await PP.waitForSelector('#cfYes');
  await Promise.all([PV.click('#cfYes'), PP.click('#cfYes')]);
  const [wV, wP] = await Promise.all([toastIs(PV, /Reservado para VALENTS/), toastIs(PP, /Reservado para PSC-CP/)]);
  const tV = await txt(PV, '#toast'), tP = await txt(PP, '#toast');
  d = await apiAs(A, 'data'); const rr = d.E['r:' + e5 + ':2023-07-10T'];
  ok('Misma casilla a la vez: solo uno se la queda', (wV !== wP) && rr && !rr.x && (rr.g === (wV ? V : PS)), tV + ' / ' + tP);
  ok('…y el otro recibe el aviso de quién la tiene', /Lo acaba de reservar/.test(wV ? tP : tV));
  const loser = wV ? PP : PV;
  await loser.waitForFunction((c) => document.querySelector(c).parentNode.classList.contains('taken'), cell, { timeout: 9000 }).catch(() => {});
  ok('La casilla aparece ocupada para el otro partido', await loser.evaluate((c) => document.querySelector(c).parentNode.classList.contains('taken'), cell));
  const winner = wV ? PV : PP; ok('…y marcada como propia para quien la tiene', await winner.evaluate((c) => document.querySelector(c).parentNode.classList.contains('mine'), cell));
  // franja con restricciones: se puede pero avisa
  await PP.click('.cc button[data-i="' + e0 + '"][data-s="2023-07-08M"]'); await PP.waitForSelector('#modal [data-a=res]'); await PP.click('#modal [data-a=res]');
  ok('Reservar una franja con restricciones avisa antes', /restricciones de uso/.test(await txt(PP, '#modal'))); await yes(PP); await toastIs(PP, /Reservado/);
  // N/D sobre una franja reservada: no se ofrece
  await A.waitForFunction((i) => document.querySelector('.cc button[data-i="' + i + '"][data-s="2023-07-08M"]').parentNode.classList.contains('taken'), e0, { timeout: 15000 }).catch(() => {});
  await A.click('.cc button[data-i="' + e0 + '"][data-s="2023-07-08M"]'); await A.waitForSelector('#modal h2');
  ok('Administradora: en una franja reservada solo puede liberar', (await A.locator('#modal [data-a=rel]').count()) === 1 && !(await A.locator('#modal [data-a=blk]').count())); await A.click('#modal [data-a=m-no]');
  // asignación por la administradora desde la casilla
  await A.click('.cc button[data-i="' + e0 + '"][data-s="2023-07-12M"]'); await A.waitForSelector('#cellParty'); await A.selectOption('#cellParty', CU); await A.click('#modal [data-a=cell-asg]'); await yes(A);
  ok('La administradora asigna una franja a CUP', await toastIs(A, /Asignado a CUP-GG-AMUNT/));

  /* ================= PANCARTAS: CERRADA, SOLO ASIGNA EL AYUNTAMIENTO ================= */
  await tab(PV, 'pan'); ok('Pancartas cerrada: el partido no puede reservar', (await PV.locator('[data-a=res]').count()) === 0 && /no está abierta/.test(await txt(PV, '#view')));
  await tab(A, 'pan'); const p0 = await A.locator('select.asg').first().getAttribute('data-i');
  await A.selectOption('select.asg[data-i="' + p0 + '"]', V); await yes(A); ok('Asignar pancarta a VALENTS', await toastIs(A, /Asignado a VALENTS/));
  await tab(PV, 'panel'); await PV.waitForFunction(() => /Pancartas/.test(document.querySelector('#view').innerText) && document.querySelectorAll('#view .card').length > 4);
  await PV.waitForFunction(() => /Vuestras reservas\s*\d/.test(document.querySelector('#view').innerText));
  await wait(4500);
  const pvPanel = await txt(PV, '#view');
  ok('VALENTS ve la pancarta en «Vuestras reservas»', /Pancartas/.test(pvPanel) && new RegExp('Vuestras reservas\\s*' + (3 + (wV ? 1 : 0))).test(pvPanel), (/Vuestras reservas\s*\d+/.exec(pvPanel) || [''])[0]);
  ok('…y no la puede liberar mientras esté cerrada', !(await PV.locator('#view [data-a=rel][data-i="' + p0 + '"]').count()));

  /* ================= PRISMAS: TURNOS EN SERPIENTE ================= */
  await tab(PV, 'pri'); await PV.waitForSelector('[data-a=res]');
  await PV.locator('[data-a=res]').first().click(); await yes(PV); await toastIs(PV, /Reservado/);
  await PP.waitForSelector('.banner.turn >> text=Prismas', { timeout: 9000 }).catch(() => {});
  await tab(PP, 'pri'); await PP.locator('[data-a=res]').first().click(); await yes(PP); await toastIs(PP, /Reservado/);
  await PC.waitForSelector('.banner.turn >> text=Prismas', { timeout: 9000 }).catch(() => {});
  await tab(PC, 'pri'); await PC.locator('[data-a=res]').first().click(); await yes(PC); await toastIs(PC, /Reservado/);
  await wait(300); d = await apiAs(A, 'data');
  ok('Serpiente: en la ronda 2 repite CUP (el último)', d.E['c:pri'].round === 2 && d.E['c:pri'].turn === 0 && /Es vuestro turno en Prismas/.test(await txt(PC, '#banner')), JSON.stringify({ r: d.E['c:pri'].round, t: d.E['c:pri'].turn }));
  // la administradora controla los turnos
  await tab(A, 'turnos'); await A.selectOption('select[data-goto=pri]', V); ok('Dar el turno a un partido', await toastIs(A, /Turno para VALENTS/));
  await A.click('[data-a=turn][data-t=pri][data-op=next]'); await toastIs(A, /Turno:/);
  await A.click('[data-a=turn][data-t=pri][data-op=prev]'); await toastIs(A, /Turno:/);
  d = await apiAs(A, 'data'); ok('Avanzar y retroceder', d.E['c:pri'].turn === 2 && d.E['c:pri'].round === 2, JSON.stringify({ r: d.E['c:pri'].round, t: d.E['c:pri'].turn }));
  await A.click('[data-a=turn][data-t=pri][data-op=reset]'); await yes(A); await toastIs(A, /Turno: VALENTS/);
  d = await apiAs(A, 'data'); ok('Reiniciar turnos (ronda 1, sin perder reservas)', d.E['c:pri'].round === 1 && d.E['c:pri'].turn === 0 && Object.values(d.E).filter((e) => e.k === 'r' && e.t === 'pri' && !e.x).length === 3);

  /* ================= EDICIÓN Y PROTECCIONES ================= */
  await tab(A, 'ban'); await A.click('[data-a=edit][data-t=ban]');
  await A.fill('#ri-' + b0 + '-nota', 'Revisar farolas'); await A.press('#ri-' + b0 + '-nota', 'Tab'); await settled(A);
  await A.click('[data-a=i-del][data-id="' + b0 + '"]'); await yes(A);
  ok('No se puede eliminar un elemento reservado', await toastIs(A, /tiene reservas/));
  await A.click('[data-a=i-add][data-t=ban]'); await A.waitForTimeout(200);
  const newId = await A.evaluate(() => { const f = document.activeElement; return f && f.dataset ? f.dataset.id : ''; });
  await A.keyboard.type('Carrer de Prova'); await A.keyboard.press('Tab'); await settled(A);
  d = await apiAs(A, 'data'); ok('Añadir un elemento a mano', d.E['i:' + newId] && d.E['i:' + newId].nom === 'Carrer de Prova');
  await A.click('[data-a=i-del][data-id="' + newId + '"]'); await yes(A); await settled(A);
  d = await apiAs(A, 'data'); ok('Eliminar un elemento libre', d.E['i:' + newId].x === true && d.E['i:' + b0].nota === 'Revisar farolas' && !d.E['i:' + b0].x);
  await A.click('[data-a=edit][data-t=ban]');
  await tab(PP, 'ban'); await PP.waitForFunction(() => /Revisar farolas/.test(document.querySelector('#view').innerText), null, { timeout: 9000 }).catch(() => {});
  ok('Los partidos ven el cambio de la administradora', /Revisar farolas/.test(await txt(PP, '#view')));
  await tab(A, 'partidos'); await A.click('[data-a=g-del][data-id="' + V + '"]'); await yes(A);
  ok('No se puede eliminar un partido con reservas', await toastIs(A, /tiene reservas/));
  // liberar como administradora
  await tab(A, 'pan'); await A.click('[data-a=rel][data-i="' + p0 + '"]'); await yes(A); ok('La administradora libera cualquier reserva', await toastIs(A, /Liberado/));

  /* ================= CONSULTA ================= */
  const JZ = await open('JEZ'); await JZ.waitForSelector('#lkName'); await JZ.fill('#lkName', 'JEZ'); await JZ.fill('#lkPass', 'Provisional1'); await JZ.click('[data-a=lk-login]');
  await JZ.waitForSelector('#pwNew'); await JZ.fill('#pwNew', 'Consulta-1'); await JZ.fill('#pwNew2', 'Consulta-2'); await JZ.click('[data-a=pw-force]');
  ok('Contraseñas distintas: aviso', /no coinciden/.test(await txt(JZ, '#pwErr')));
  await JZ.fill('#pwNew2', 'Consulta-1'); await JZ.click('[data-a=pw-force]'); await toastIs(JZ, /Contraseña guardada/);
  ok('Consulta: aviso de solo lectura', /Usuario de consulta/.test(await txt(JZ, '#banner')));
  await tab(JZ, 'ban'); ok('Consulta: ni reservar ni liberar ni asignar', !(await JZ.locator('[data-a=res],[data-a=rel],select.asg,[data-a=edit]').count()));
  await tab(JZ, 'esp'); await JZ.click(cell); await JZ.waitForSelector('#modal h2'); ok('Consulta: la casilla solo muestra el detalle', !(await JZ.locator('#modal [data-a=res],#modal [data-a=rel],#modal [data-a=blk]').count())); await JZ.click('#modal [data-a=m-no]');

  /* ================= REGISTRO ================= */
  await tab(A, 'registro'); const reg = await txt(A, '#view');
  ok('Registro con reservas, liberaciones, asignaciones y turnos', /reservó/.test(reg) && /liberó/.test(reg) && /asignó a VALENTS/.test(reg) && /turno completado/.test(reg) && /ha completado su cupo/.test(reg) && /terminó su turno/.test(reg) && /dio el turno a VALENTS/.test(reg));
  ok('Ninguna fecha inválida en el registro ni en el panel', !/NaN/.test(reg) && !/NaN/.test(await (async () => { await tab(A, 'panel'); const x = await txt(A, '#view'); await tab(A, 'registro'); return x; })()));
  await A.selectOption('#lflt', 'p:' + CU); const regC = await A.locator('#view tbody tr').allInnerTexts();
  ok('Registro filtrado por partido', regC.length > 0 && regC.every((r) => /CUP/.test(r)), regC.length);
  await A.selectOption('#lflt', '');

  /* ================= TIPO DE ELECCIONES ================= */
  await tab(A, 'panel'); ok('El panel indica el tipo de elecciones y la votación', /Elecciones Generales · Congreso de los Diputados/.test(await txt(A, '#view .hero')) && /Votación: domingo, 23 de julio de 2023/.test(await txt(A, '#view .hero')), (await txt(A, '#view .hero')).replace(/\s+/g, ' ').slice(0, 160));
  await tab(A, 'ajustes'); await A.selectOption('[data-conf=tipo]', 'autonomicas'); await settled(A); await tab(A, 'panel');
  ok('Se puede cambiar el tipo de elecciones', /Parlament de Catalunya/.test(await txt(A, '#view .hero')));
  await tab(A, 'ajustes'); await A.selectOption('[data-conf=tipo]', 'generales'); await settled(A);
  await A.fill('[data-conf=org]', 'Ajuntament de Santa Coloma de Gramenet · Secretaria'); await A.press('[data-conf=org]', 'Tab'); await settled(A);
  ok('Se puede cambiar el nombre del Ajuntament', /Secretaria/.test(await txt(A, '#org')));
  await A.fill('[data-conf=org]', ''); await A.press('[data-conf=org]', 'Tab'); await settled(A);
  ok('Vacío vuelve al nombre por defecto', (await txt(A, '#org')) === 'Ajuntament de Santa Coloma de Gramenet');

  /* ================= CAMPOS PROPIOS ================= */
  await A.click('[data-a=xf-open][data-t=ban]'); await A.waitForSelector('#xfNew');
  await A.fill('#xfNew', 'Metros'); await A.click('[data-a=xf-add][data-t=ban]'); ok('Añadir un campo propio a Banderolas', await toastIs(A, /Campo añadido/));
  await A.click('#modal [data-a=m-no]'); await settled(A);
  let xid = (await apiAs(A, 'data')).E['s:conf'].xf.ban[0].id;
  await tab(A, 'ban'); await A.click('[data-a=edit][data-t=ban]');
  await A.fill('#ri-' + b0 + '-x_' + xid, '25 m'); await A.press('#ri-' + b0 + '-x_' + xid, 'Tab');
  await A.fill('#ri-' + b0 + '-tram', 'Tramo modificado'); await A.press('#ri-' + b0 + '-tram', 'Tab'); await settled(A);
  d = await apiAs(A, 'data'); ok('Se modifica un campo de siempre y se rellena el campo propio', d.E['i:' + b0].xv[xid] === '25 m' && d.E['i:' + b0].tram === 'Tramo modificado');
  await A.click('[data-a=edit][data-t=ban]');
  await tab(PP, 'ban'); await PP.waitForFunction(() => /Metros/i.test(document.querySelector('#view thead').innerText) && /25 m/.test(document.querySelector('#view').innerText), null, { timeout: 9000 }).catch(() => {});
  ok('Las candidaturas ven la columna nueva con su dato', /Metros/i.test(await txt(PP, '#view thead')) && /25 m/.test(await txt(PP, '#view')));
  await A.click('[data-a=edit][data-t=ban]'); await A.click('[data-a=xf-open][data-t=ban]'); await A.waitForSelector('[data-xfren=ban]');
  await A.fill('[data-xfren=ban]', 'Longitud'); await A.press('[data-xfren=ban]', 'Tab'); ok('Renombrar un campo propio', await toastIs(A, /Nombre del campo cambiado/));
  await A.click('#modal [data-a=m-no]'); await settled(A);
  await A.click('[data-a=xf-open][data-t=ban]'); await A.click('[data-a=xf-hide][data-t=ban]'); await toastIs(A, /Sus datos se conservan/);
  await settled(A); d = await apiAs(A, 'data');
  ok('Quitar un campo solo lo oculta: el dato sigue guardado', d.E['s:conf'].xf.ban[0].h === true && d.E['i:' + b0].xv[xid] === '25 m' && !/Longitud/i.test(await txt(A, '#view thead')));
  await A.click('#modal [data-a=xf-show]'); await toastIs(A, /visible de nuevo/); await A.click('#modal [data-a=m-no]'); await settled(A);
  ok('…y se recupera con sus datos', /Longitud/i.test(await txt(A, '#view thead')) && (await A.inputValue('#ri-' + b0 + '-x_' + xid)) === '25 m');
  await A.click('[data-a=edit][data-t=ban]');
  await tab(A, 'partidos'); await A.click('[data-a=xf-open][data-t=par]'); await A.fill('#xfNew', 'Correo de notificaciones'); await A.click('[data-a=xf-add][data-t=par]'); await toastIs(A, /Campo añadido/); await A.click('#modal [data-a=m-no]'); await settled(A);
  const xp = (await apiAs(A, 'data')).E['s:conf'].xf.par[0].id;
  await A.fill('#rg-' + V + '-x_' + xp, 'notif@valents.cat'); await A.press('#rg-' + V + '-x_' + xp, 'Tab'); await settled(A);
  d = await apiAs(A, 'data'); const dPV = await apiAs(PP, 'data');
  ok('Campo propio en las candidaturas (privado como los contactos)', d.E['g:' + V].xv[xp] === 'notif@valents.cat' && !dPV.E['g:' + V].xv[xp]);
  await tab(A, 'ban'); if (await A.locator('[data-a=edit][data-t=ban].primary').count()) await A.click('[data-a=edit][data-t=ban]');

  /* ================= REPARTO SEGÚN LA LEY ================= */
  await tab(A, 'reparto');
  ok('Reparto: explicación de la ley visible', /art\. 56 LOREG/.test(await txt(A, '#view')) && /art\. 57 LOREG/.test(await txt(A, '#view')));
  const votes = { 'PSC-CP': 25000, VALENTS: 900, 'CUP-GG-AMUNT': 2500, 'ERC-AM': 6000, PP: 9000, VOX: 7000, 'SCG-ECP-C': 8000, CS: 1200, PACMA: 700, 'USSP-SCG': 0, CM: 0, PCPC: 300, 'ARA PL': 0 };
  for (const [s, v] of Object.entries(votes)) { await A.fill('#rg-' + P[s] + '-vot', String(v)); await A.press('#rg-' + P[s] + '-vot', 'Tab'); }
  await A.fill('[data-conf=rv]', 'Generales 2023 · Congreso · Santa Coloma de Gramenet'); await A.press('[data-conf=rv]', 'Tab');
  await A.fill('[data-conf=rmin]', '1'); await A.press('[data-conf=rmin]', 'Tab'); await settled(A);
  ok('Porcentajes de voto calculados', /41,25/.test(await txt(A, '#view .rp')), 'PSC-CP 25.000 de 60.600');
  await A.click('[data-a=rp-order]'); await A.waitForSelector('#cfYes');
  ok('Ordenar por votos: muestra el orden antes de aplicarlo', /1\. PSC-CP · 25\.000 votos/.test(await txt(A, '#modal')));
  await yes(A); await settled(A); d = await apiAs(A, 'data');
  const ordOf = (s) => d.E['g:' + P[s]].ord;
  ok('Orden de preferencia por votos (sin votos, al final)', ordOf('PSC-CP') === 1 && ordOf('PP') === 2 && ordOf('SCG-ECP-C') === 3 && ordOf('PCPC') === 10 && ordOf('USSP-SCG') === 11 && ordOf('ARA PL') === 13);
  ok('El orden se aplica a los turnos de las cuatro categorías', ['esp', 'ban', 'pan', 'pri'].every((t) => d.E['c:' + t] && d.E['c:' + t].order[0] === P['PSC-CP'] && d.E['c:' + t].order.length === 13));
  await A.click('[data-a=rp-calc]'); await A.waitForSelector('#cfYes'); const calcTxt = await txt(A, '#modal'); ok('Calcular: enseña los cupos antes de fijarlos', /Pancartas/i.test(calcTxt) && /PSC-CP\s+135/.test(calcTxt), calcTxt.replace(/\s+/g, ' ').slice(0, 220));
  await yes(A); await settled(A); d = await apiAs(A, 'data');
  const sum = (t) => Object.values(d.E['c:' + t].cup || {}).reduce((a, b) => a + b, 0), cupS = (t, s) => d.E['c:' + t].cup[P[s]];
  ok('Cupos fijados: suman exactamente lo disponible', sum('ban') === items.ban.length && sum('pan') === items.pan.length && sum('pri') === items.pri.length && !Object.keys(d.E['c:esp'].cup || {}).length, sum('ban') + '/' + sum('pan') + '/' + sum('pri'));
  ok('Más votos, más cupo; mínimo 1 para todas', cupS('ban', 'PSC-CP') > cupS('ban', 'PP') && cupS('ban', 'PP') > cupS('ban', 'VOX') && Object.values(d.E['c:ban'].cup).every((n) => n >= 1) && cupS('ban', 'ARA PL') === 1, 'PSC ' + cupS('ban', 'PSC-CP') + ' · PP ' + cupS('ban', 'PP') + ' · ARA PL ' + cupS('ban', 'ARA PL'));
  await A.fill('#cup-pan-' + CU, '0'); await A.press('#cup-pan-' + CU, 'Tab'); await settled(A); d = await apiAs(A, 'data');
  ok('Retocar un cupo a mano', d.E['c:pan'].cup[CU] === 0);
  ok('Aviso si la suma ya no cuadra con lo disponible', /propuesta: \d+/.test(await txt(A, '#view')));
  await tab(PC, 'reparto'); await PC.waitForFunction(() => /Generales 2023/.test(document.querySelector('#view').innerText), null, { timeout: 9000 }).catch(() => {});
  ok('Las candidaturas ven el reparto (solo lectura) con su fila marcada', !(await PC.locator('#view input').count()) && (await PC.locator('.rp tr.mine').count()) === 1 && /Generales 2023/.test(await txt(PC, '#view')));
  await tab(A, 'turnos'); await A.click('[data-a=cfg-mode][data-t=pan][data-v=libre]'); await settled(A);
  await tab(PC, 'pan'); await PC.waitForFunction(() => /No tenéis cupo en pancartas/.test(document.querySelector('#view').innerText), null, { timeout: 9000 }).catch(() => {});
  ok('Sin cupo: la candidatura no puede elegir y sabe por qué', /No tenéis cupo en pancartas/.test(await txt(PC, '#view')) && !(await PC.locator('[data-a=res]').count()));
  await tab(PP, 'pan'); await PP.waitForSelector('[data-a=res]', { timeout: 9000 }).catch(() => {});
  ok('Con cupo: puede elegir y ve su cupo', (await PP.locator('[data-a=res]').count()) > 0 && new RegExp('0 / ' + cupS('pan', 'PSC-CP')).test(await txt(PP, '#view .kpis')), await txt(PP, '#view .kpis'));
  await tab(A, 'turnos'); await A.click('[data-a=cfg-mode][data-t=pan][data-v=cerrado]'); await settled(A);

  /* ================= EN DIRECTO ================= */
  ok('La pestaña «En directo» se distingue: punto rojo que late con la selección abierta', (await PP.locator('#tabs .tlive.onair .ldot').count()) === 1);
  await tab(PP, 'asig'); let ta = await txt(PP, '#view');
  ok('En directo: franja propia, turno de cada categoría y lo de cada candidatura en una sola pantalla', /EN DIRECTO/.test(ta) && /Selección abierta/.test(ta) && /Turno en cada categoría/.test(ta) && /Últimas elecciones/.test(ta) && /Lo que tiene cada candidatura/.test(ta) && /VALENTS/.test(ta) && /CUP-GG-AMUNT/.test(ta) && /Banderolas: \d+ \/ \d+/.test(ta));
  await PP.selectOption('#ap', 'mine'); ok('Filtro «Solo la nuestra»', (await PP.locator('.asg-p').count()) === 1 && /PSC-CP/.test(await txt(PP, '.asg-p')));
  await PP.selectOption('#ap', ''); await PP.selectOption('#ac', 'esp'); ok('Filtro por categoría', !/Banderolas: /.test(await txt(PP, '.asg-p')) && /Espacios electorales: /.test(await txt(PP, '.asg-p'))); await PP.selectOption('#ac', '');
  await tab(A, 'pri'); const pfree = await A.locator('select.asg').first().getAttribute('data-i');
  await A.selectOption('select.asg[data-i="' + pfree + '"]', V); await yes(A); await toastIs(A, /Asignado a VALENTS/);
  await PP.waitForFunction(() => /VALENTS/.test((document.querySelector('.lastres tr') || {}).innerText || ''), null, { timeout: 12000 }).catch(() => {});
  ok('Una elección nueva aparece arriba, en directo, para las demás candidaturas', /VALENTS/.test(await txt(PP, '.lastres tr')) && /Prismas/.test(await txt(PP, '.lastres tr')));

  /* ================= INHABILITAR CON MOTIVO ================= */
  await tab(A, 'ban'); const fb = await A.locator('select.asg').first().getAttribute('data-i'); const totBan = await txt(A, '#view .kpis');
  await A.click('[data-a=nd-on][data-i="' + fb + '"]'); await A.waitForSelector('#ndMotivo'); await A.fill('#ndMotivo', 'Obras en la calle'); await A.click('[data-a=nd-ok]');
  ok('Inhabilitar una banderola con su motivo', await toastIs(A, /Marcado como no disponible/)); await settled(A);
  d = await apiAs(A, 'data'); ok('…guardado en el servidor', d.E['i:' + fb].nd === true && d.E['i:' + fb].ndm === 'Obras en la calle');
  ok('…y deja de contar como disponible', (await txt(A, '#view .kpis')) !== totBan && new RegExp('/ ' + (items.ban.length - 1)).test(await txt(A, '#view .kpis')), (await txt(A, '#view .kpis')).replace(/\s+/g, ' '));
  await tab(PP, 'ban'); await PP.selectOption('#flt-ban', 'nd'); await PP.waitForFunction(() => /Obras en la calle/.test(document.querySelector('#view').innerText), null, { timeout: 12000 }).catch(() => {});
  ok('Las candidaturas lo ven en gris con el motivo y sin poder elegirlo', (await PP.locator('tr.ndr').count()) === 1 && /No disponible/.test(await txt(PP, 'tr.ndr')) && /Obras en la calle/.test(await txt(PP, 'tr.ndr')) && !(await PP.locator('tr.ndr [data-a=res]').count()));
  await PP.selectOption('#flt-ban', 'all');
  await A.click('[data-a=nd-off][data-i="' + fb + '"]'); await yes(A); await toastIs(A, /Vuelve a estar disponible/); await settled(A);
  d = await apiAs(A, 'data'); ok('Volver a habilitarla', d.E['i:' + fb].nd === false);
  const e2 = items.esp[2].id; await tab(A, 'esp'); await A.click('[data-a=blk-row][data-i="' + e2 + '"]'); await A.click('#modal [data-a=nd-on]');
  await A.waitForSelector('#ndMotivo'); await A.fill('#ndMotivo', 'Mercado municipal'); await A.click('[data-a=nd-ok]'); await settled(A);
  d = await apiAs(A, 'data'); const e2srv = d.E['i:' + e2] || {};
  await tab(PV, 'esp'); await PV.waitForFunction((i) => document.querySelectorAll('.cc.nd button[data-i="' + i + '"]').length === 30, e2, { timeout: 15000 }).catch(() => {});
  const e2row = await PV.evaluate((i) => { const b = document.querySelector('.cgrid button[data-i="' + i + '"]'); return b ? b.closest('tr').innerText.replace(/\s+/g, ' ').slice(0, 120) : 'sin fila'; }, e2);
  ok('Inhabilitar un espacio entero: sus 30 franjas en gris con el motivo', e2srv.nd === true && (await PV.locator('.cc.nd button[data-i="' + e2 + '"]').count()) === 30 && /Mercado municipal/i.test(e2row), 'servidor nd=' + e2srv.nd + ' · celdas N/D ' + (await PV.locator('.cc.nd button[data-i="' + e2 + '"]').count()) + ' · fila: ' + e2row);

  /* ================= COPIAS A LA VISTA ================= */
  await tab(A, 'panel');
  ok('Botón «💾 Copia» en la cabecera solo para la administración', (await A.isVisible('#bakTop')) && !(await PP.isVisible('#bakTop')));
  const [dlTop] = await Promise.all([A.waitForEvent('download'), A.click('#bakTop')]);
  ok('Descargar la copia desde la cabecera', JSON.parse(fs.readFileSync(await dlTop.path(), 'utf8')).app === 'espais');
  ok('Recuadro de copias en el Panel', /Copias de seguridad/.test(await txt(A, '#view')) && (await A.locator('#view [data-a=bak-keep]').count()) === 1);
  await A.click('#view [data-a=bak-keep]'); await A.waitForSelector('#keepName'); await A.fill('#keepName', 'Prueba · resultado final');
  const [dlKeep] = await Promise.all([A.waitForEvent('download'), A.click('[data-a=keep-ok]')]);
  const hk = await apiAs(A, 'history');
  ok('Copia permanente con nombre: en el servidor y descargada', hk.keep.length === 1 && hk.keep[0].label === 'Prueba · resultado final' && JSON.parse(fs.readFileSync(await dlKeep.path(), 'utf8')).app === 'espais');

  /* ================= IMPRESIÓN A4 ================= */
  fs.mkdirSync(S + '/pdf_esp', { recursive: true });
  await A.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
  async function check(pg, name, file, must, land) {
    await pg.waitForFunction(() => window.__p > 0, null, { timeout: 5000 }).catch(() => {});
    const st = await pg.evaluate(() => ({ p: window.__p, cls: document.body.classList.contains('printdoc'), txt: (document.getElementById('printdoc') || {}).innerText || '', size: (document.getElementById('pgsize') || {}).textContent || '' }));
    const miss = must.filter((m) => !(m instanceof RegExp ? m.test(st.txt) : st.txt.includes(m)));
    ok('Imprimir ' + name + ': documento preparado', st.p === 1 && st.cls && !miss.length, miss.length ? 'falta: ' + miss.join(', ') : '');
    await pg.emulateMedia({ media: 'print' }); await pg.pdf({ path: S + '/pdf_esp/' + file + '.pdf', preferCSSPageSize: true, printBackground: true }); await pg.emulateMedia({ media: 'screen' });
    const info = execFileSync('pdfinfo', [S + '/pdf_esp/' + file + '.pdf']).toString(), pages = +(/Pages:\s+(\d+)/.exec(info) || [])[1], sz = (/Page size:\s+([\d.]+) x ([\d.]+)/.exec(info) || []).slice(1).map(Number);
    const a4 = land ? Math.abs(sz[0] - 841.9) < 2 && Math.abs(sz[1] - 595.3) < 2 : Math.abs(sz[0] - 595.3) < 2 && Math.abs(sz[1] - 841.9) < 2;
    const pt = execFileSync('pdftotext', ['-l', '1', S + '/pdf_esp/' + file + '.pdf', '-']).toString();
    ok('Imprimir ' + name + ': PDF A4 ' + (land ? 'horizontal' : 'vertical') + ' (' + pages + ' pág.) sin menús', a4 && pages >= 1 && /Ajuntament de Santa Coloma/.test(pt) && !/Turnos y reglas|Registro\s+Ajustes/.test(pt), sz.join('x'));
    try { execFileSync('pdftoppm', ['-png', '-r', '50', '-f', '1', '-l', '1', S + '/pdf_esp/' + file + '.pdf', S + '/pdf_esp/' + file]); } catch (e) { /* vista previa opcional */ }
    await pg.evaluate(() => { window.__p = 0; document.body.classList.remove('printdoc'); });
  }
  await tab(A, 'panel');
  await A.click('[data-a=pr-menu]'); ok('Menú de impresión con 11 documentos', (await A.locator('.prlist .prop').count()) === 11, await A.locator('.prlist .prop').count());
  await A.click('.prop[data-a=pr-cat][data-t=esp]'); await check(A, 'espacios + cuadrante', 'espacios', ['Espacios electorales', 'Cuadrante', "Jardí de l'Amistat", 'N/D', 'Restr.', 'CUP-GG-AMUNT'], true);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-cat][data-t=ban]'); await check(A, 'banderolas', 'banderolas', ['Banderolas', 'Por partido:', 'VALENTS'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-cat][data-t=pri]'); await check(A, 'prismas', 'prismas', ['Prismas'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-parties]'); await check(A, 'hojas por partido', 'partidos', ['Asignaciones de VALENTS', 'Conformidad', 'Firma'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-log]'); await check(A, 'registro', 'registro', ['Registro de movimientos', 'reservó'], true);
  await A.click('[data-a=pr-menu]'); await A.selectOption('#prParty', CU); await A.click('[data-a=pr-party-sel]'); await check(A, 'la hoja de una candidatura elegida (CUP)', 'una-candidatura', ['Asignaciones de CUP-GG-AMUNT', 'Banderolas (2)', 'Prismas (1)', 'Firma'], false);
  await tab(A, 'partidos'); await A.click('[data-a=pr-party][data-g="' + V + '"]'); await check(A, 'desde la fila de Partidos (VALENTS)', 'fila-partido', ['Asignaciones de VALENTS', 'Longitud'], false);
  await tab(A, 'panel'); await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-allres]'); await check(A, 'relación completa de asignaciones', 'relacion', ['Relación completa de asignaciones', 'VALENTS', 'PSC-CP', 'CUP-GG-AMUNT', 'Prismas', 'Espacios electorales'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-reparto]'); await check(A, 'reparto con base legal y conformidad', 'reparto', ['Reparto de emplazamientos y orden de elección', 'Generales 2023', '25.000', '41,25', 'Base legal', 'Conformidad de las candidaturas'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-guia]'); await check(A, 'ayuda para las candidaturas', 'guia', ['Ayuda para las candidaturas', 'Cómo se reparte según la ley', 'Es vuestro turno', 'Terminar mi turno', '10 a 14', 'Preguntas frecuentes'], false);
  await A.click('[data-a=pr-menu]'); await A.click('.prop[data-a=pr-acta]'); await check(A, 'acta de la selección', 'acta', ['Acta de la selección de espacios electorales', 'Resultado por candidatura', 'Desarrollo de la selección', 'reservó', 'Firmas', 'Ajuntament de Santa Coloma de Gramenet'], true);
  await tab(PP, 'partidos'); ok('Cada partido solo puede imprimir su propia hoja desde Partidos', (await PP.locator('[data-a=pr-party]').count()) === 1);
  await PV.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
  await tab(PV, 'panel'); await PV.click('[data-a=pr-menu]'); ok('El partido puede imprimir «Nuestras asignaciones»', (await PV.locator('.prop[data-a=pr-party]').count()) === 1);
  await PV.click('.prop[data-a=pr-party]'); await check(PV, 'nuestras asignaciones (partido)', 'valents', ['Asignaciones de VALENTS', 'Banderolas (2)'], false);

  /* ================= CSV ================= */
  await tab(A, 'ban'); let [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-a=csv][data-t=ban]')]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  ok('Exportar banderolas a CSV (Excel)', csv.charCodeAt(0) === 0xfeff && /"Calle";"Tramo"/.test(csv) && /"VALENTS"/.test(csv) && csv.split('\r\n').length === items.ban.length + 1, csv.split('\r\n').length);
  await tab(A, 'esp'); [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-a=csv][data-t=esp]')]);
  const csvE = fs.readFileSync(await dl.path(), 'utf8'); ok('Exportar el cuadrante a CSV', /07\/07\/2023 mañana/.test(csvE) && /No disponible/.test(csvE) && /Con restricciones|PSC-CP/.test(csvE));

  /* ================= COPIAS ================= */
  await tab(A, 'ajustes'); await A.click('[data-a=h-load]'); await A.waitForSelector('[data-a=h-restore]');
  const nh = await A.locator('[data-a=h-restore]').count(), hinfo = await txt(A, '#view .plist');
  ok('Copias del servidor listadas (completas y diaria permanente)', nh >= 2 && /copia diaria permanente/.test(hinfo), nh);
  const cinfo = /(\d+) modificaciones copiadas una a una/.exec(await txt(A, '#view')); ok('Cada modificación tiene su copia aparte', cinfo && +cinfo[1] > 40, cinfo && cinfo[0]);
  const loc = await A.evaluate(() => { try { return JSON.parse(localStorage.getItem('espais.copia.local')); } catch (e) { return null; } });
  ok('Copia local en el navegador de la administración', loc && loc.app === 'espais' && Object.keys(loc.E).length > 450, loc ? Object.keys(loc.E).length + ' registros' : 'sin copia');
  [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-a=bak-local]')]);
  const bl = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); ok('Descargar la copia del navegador (importable)', bl.app === 'espais' && bl.E && Object.keys(bl.E).length > 450);
  [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-a=bak-dl]')]);
  const bak = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); ok('Descargar copia completa (.json)', bak.app === 'espais' && Object.keys(bak.E).length > 450, Object.keys(bak.E).length);
  await A.click('[data-a=h-restore] >> nth=0'); await A.waitForSelector('#cfWord');
  ok('Restaurar exige escribir RESTAURAR', await A.isDisabled('#cfYes')); await A.click('#modal [data-a=m-no]');

  /* ================= SESIÓN Y RECARGA ================= */
  await PV.reload(); await PV.waitForSelector('#tabs [data-v=panel]');
  ok('Recargar la página mantiene la sesión y los datos', /VALENTS · Partido/.test(await txt(PV, '#who')) && /Vuestras reservas\s*\d/.test(await txt(PV, '#view')));
  await PV.click('[data-a=logout]'); await PV.waitForSelector('#lkPass');
  ok('Salir vuelve a la pantalla de acceso con el usuario recordado', (await PV.inputValue('#lkName')) === 'valents');
  await PV.fill('#lkPass', 'mala'); await PV.click('[data-a=lk-login]'); await PV.waitForSelector('#lock .err');
  ok('Contraseña incorrecta: rechazo', /incorrectos/.test(await txt(PV, '#lock .err')));
  await PV.fill('#lkPass', 'Partido-123'); await PV.click('[data-a=lk-login]'); await PV.waitForSelector('#tabs [data-v=panel]'); ok('Entrar con la contraseña propia', true);
  // la administradora da de baja a un usuario: se queda fuera
  await tab(A, 'ajustes'); const jid = await A.evaluate(() => { const r = [...document.querySelectorAll('#view .tbl tbody tr')].find((t) => /JEZ/.test(t.innerText)); return r.querySelector('[data-a=u-del]').dataset.id; });
  await A.click('[data-a=u-del][data-id="' + jid + '"]'); await yes(A); await toastIs(A, /dado de baja/);
  await JZ.waitForSelector('#lkName', { timeout: 15000 }).catch(() => {});
  ok('Usuario dado de baja: sale del programa', /ya no tiene acceso/.test(await txt(JZ, '#lock')));

  /* ================= AYUDA ================= */
  await tab(PP, 'ayuda');
  ok('Ayuda de las candidaturas: es la que ven los partidos, con 7 apartados', /Ayuda para las candidaturas/.test(await txt(PP, '#view h2')) && (await PP.locator('#view .help h3').count()) === 7);
  const hc = await txt(PP, '#view');
  ok('…explica la ley, los turnos y rondas con el ejemplo, cómo elegir y dónde verlo todo', /arts\. 55 y 56/.test(hc) && /Turnos, rondas y cupos/.test(hc) && /10 a 14/.test(hc) && /Terminar mi turno/.test(hc) && /En directo/.test(hc) && /Preguntas frecuentes/.test(hc) && !/Importar desde Excel/.test(hc));
  await PP.click('[data-a=help-part][data-v=man]'); const hm = await txt(PP, '#view');
  ok('Manual del programa separado (12 apartados): reparto, ensayo, inhabilitar, Excel, copias', (await PP.locator('#view .help h3').count()) === 12 && /Ensayo antes de la sesión/.test(hm) && /Manual de Espais electorals/.test(hm) && /en bloque/.test(hm) && /no disponible con un motivo/.test(hm) && /plantilla/.test(hm) && /💾 Copia/.test(hm));
  await tab(A, 'ayuda'); ok('La administración abre por defecto el manual', /Manual de Espais electorals/.test(await txt(A, '#view h2')));
  await A.evaluate(() => { window.__p = 0; window.print = () => { window.__p++; }; });
  await A.click('#view [data-a=pr-help]'); await A.waitForTimeout(300);
  const ptxt = await A.evaluate(() => document.getElementById('printdoc').innerText);
  ok('Imprimir el manual (solo su parte)', /Manual de Espais electorals/.test(ptxt) && !/Preguntas frecuentes/.test(ptxt));
  await A.evaluate(() => document.body.classList.remove('printdoc'));

  /* ================= PLANTILLA EXCEL ================= */
  await tab(A, 'ajustes');
  [dl] = await Promise.all([A.waitForEvent('download'), A.click('a[href="plantilla-espais.xlsx"]')]);
  ok('Plantilla Excel descargable desde Ajustes', fs.statSync(await dl.path()).size > 4000);
  [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('#view [data-a=imp-xls]')]);
  await fc.setFiles(path.join(__dirname, 'datos', 'plantilla-rellena.xlsx')); await A.waitForSelector('.impChk');
  const ti = await txt(A, '#modal');
  ok('Un Excel con todo a la vez: cada hoja a su sitio, con ejemplos de lo que entra', /PARTITS/.test(ti) && /Espacios electorales: 1 nuevos/.test(ti) && /Banderolas: 1 nuevos/.test(ti) && /Pancartas: 1 nuevos/.test(ti) && /Prismas: 1 nuevos/.test(ti) && /Partidos: 1 nuevos/.test(ti) && /Por ejemplo: NOVA/.test(ti), ti.replace(/\s+/g, ' ').slice(0, 300));
  await A.click('[data-a=imp-ok]'); await settled(A); d = await apiAs(A, 'data');
  const nova = Object.values(d.E).find((e) => e.k === 'g' && e.sig === 'NOVA');
  ok('La hoja PARTITS trae los votos', nova && nova.vot === 150 && nova.rep === 'Anna Prova');

  /* ================= ENSAYO ================= */
  const realCount = Object.values((await apiAs(A, 'data')).E).filter((e) => e.k === 'r' && !e.x).length;
  await tab(A, 'panel'); ok('Botón «Empezar un ensayo» arriba del Panel, antes de las categorías', (await A.locator('#view [data-a=ens-start]').count()) === 1 && await A.evaluate(() => { const b = document.querySelector('#view [data-a=ens-start]'), g = document.querySelector('#view .grid2'); return !!(b && g && (b.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING)); }));
  await A.click('#view [data-a=ens-start]'); await yes(A); ok('Empezar un ensayo', await toastIs(A, /Ensayo en marcha/));
  await PP.waitForFunction(() => /MODO ENSAYO/.test(document.querySelector('#banner').innerText), null, { timeout: 12000 }).catch(() => {});
  await PV.waitForFunction(() => /MODO ENSAYO/.test(document.querySelector('#banner').innerText), null, { timeout: 12000 }).catch(() => {});
  ok('Todas las candidaturas ven el aviso MODO ENSAYO', /MODO ENSAYO/.test(await txt(PP, '#banner')) && /MODO ENSAYO/.test(await txt(PV, '#banner')));
  await PP.waitForFunction(() => /Es vuestro turno en Banderolas/.test(document.querySelector('#banner').innerText), null, { timeout: 12000 }).catch(() => {});
  ok('El ensayo empieza por la primera candidatura del orden (PSC-CP)', /Es vuestro turno en Banderolas/.test(await txt(PP, '#banner')));
  await tab(PP, 'ban'); await PP.waitForSelector('[data-a=res]'); const eb = await PP.locator('[data-a=res]').first().getAttribute('data-i');
  await PP.click('[data-a=res][data-i="' + eb + '"]'); await yes(PP); ok('Durante el ensayo se elige como el día de verdad', await toastIs(PP, /Reservado para PSC-CP/));
  await tab(PV, 'asig'); ok('«En directo» indica que es un ensayo', /ENSAYO/.test(await txt(PV, '.livehead')));
  await tab(A, 'panel'); await A.waitForFunction(() => /1 elección de prueba/.test(document.querySelector('#view').innerText), null, { timeout: 12000 }).catch(() => {});
  ok('El Panel cuenta las elecciones de prueba', /1 elección de prueba/.test(await txt(A, '#view')));
  await A.click('#view [data-a=ens-end]'); await yes(A); ok('Terminar el ensayo y borrar lo elegido', await toastIs(A, /Ensayo terminado: se han borrado 1/));
  await settled(A); d = await apiAs(A, 'data');
  ok('Lo elegido en el ensayo se borra y lo de verdad se queda', d.E['r:' + eb].x === true && d.E['s:ens'].on === false && Object.values(d.E).filter((e) => e.k === 'r' && !e.x).length === realCount, realCount + ' reservas de verdad');
  await PP.waitForFunction(() => !/MODO ENSAYO/.test(document.querySelector('#banner').innerText), null, { timeout: 12000 }).catch(() => {});
  ok('El aviso de ensayo desaparece para todos', !/MODO ENSAYO/.test(await txt(PP, '#banner')));
  await tab(A, 'registro'); const regN = await A.locator('#view tbody tr.ensr').count();
  ok('Registro: los movimientos del ensayo están ocultos por defecto', regN === 0 && /terminó el ENSAYO/.test(await txt(A, '#view')) && (await A.locator('#lens').count()) === 1);
  await A.check('#lens'); ok('…y se pueden mostrar, marcados como «ensayo»', (await A.locator('#view tbody tr.ensr').count()) >= 1);
  await A.uncheck('#lens');

  /* ================= CAPTURAS ================= */
  fs.mkdirSync(S + '/shots_esp', { recursive: true });
  await tab(A, 'panel'); await A.screenshot({ path: S + '/shots_esp/admin-panel.png', fullPage: true });
  await tab(A, 'turnos'); await A.screenshot({ path: S + '/shots_esp/admin-turnos.png' });
  await tab(A, 'reparto'); await A.screenshot({ path: S + '/shots_esp/admin-reparto.png', fullPage: true });
  await tab(PP, 'asig'); await PP.screenshot({ path: S + '/shots_esp/partido-en-directo.png', fullPage: true });
  await tab(PP, 'reparto'); await PP.screenshot({ path: S + '/shots_esp/partido-reparto.png', fullPage: true });
  await tab(A, 'ajustes'); await A.screenshot({ path: S + '/shots_esp/admin-ajustes.png', fullPage: true });
  await tab(PP, 'ban'); await PP.screenshot({ path: S + '/shots_esp/partido-banderolas.png' });
  await tab(PP, 'esp'); await PP.screenshot({ path: S + '/shots_esp/partido-espacios.png' });
  await tab(PC, 'panel'); await PC.screenshot({ path: S + '/shots_esp/partido-panel.png', fullPage: true });
  const M = await open('movil'); await M.setViewportSize({ width: 390, height: 800 }); await M.waitForSelector('#lkName'); await M.screenshot({ path: S + '/shots_esp/movil-login.png' });
  await M.fill('#lkName', 'PSC-CP'); await M.fill('#lkPass', 'Partido-123'); await M.click('[data-a=lk-login]'); await M.waitForSelector('#tabs'); await M.screenshot({ path: S + '/shots_esp/movil-panel.png' });
  ok('Móvil: sin desplazamiento horizontal de la página', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await M.evaluate(() => document.documentElement.scrollWidth));
  const anchos = []; for (const v of ['asig', 'esp', 'ban', 'pri', 'partidos', 'reparto', 'registro', 'ayuda']) { await M.click('#tabs [data-v=' + v + ']'); await M.waitForTimeout(150); anchos.push(v + ':' + (await M.evaluate(() => document.documentElement.scrollWidth))); if (v === 'asig') await M.screenshot({ path: S + '/shots_esp/movil-en-directo.png', fullPage: true }); }
  ok('Móvil: ninguna pestaña se sale de la pantalla (las tablas anchas se desplazan dentro de su recuadro)', anchos.every((x) => +x.split(':')[1] <= 391), anchos.join(' '));
  ok('Ningún texto introducido se ejecuta como código (prueba de seguridad XSS en todas las pantallas e impresos)', !(await A.evaluate(() => window.__xss)) && !(await PP.evaluate(() => window.__xss)) && !(await PV.evaluate(() => window.__xss)) && !(await PC.evaluate(() => window.__xss)) && !(await M.evaluate(() => window.__xss)));
  ok('…y se muestra como texto normal', /Pacma <img src=x/.test(await (async () => { await A.click('#tabs [data-v=reparto]'); return txt(A, '#view .rp'); })()));

  ok('Sin errores de JavaScript en ningún navegador', !errs.length, errs.join(' | '));
  ok('Sin errores en la consola', !cons.length, cons.slice(0, 5).join(' | '));
  await br.close();
  console.log(R.join('\n')); console.log(R.filter((x) => x.startsWith('OK')).length + '/' + R.length); process.exitCode = R.some((x) => x.startsWith('FALLO')) ? 1 : 0;
})().catch((e) => { console.log(R.join('\n')); console.error('ERROR', e); process.exit(1); });
