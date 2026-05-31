/**
 * test-resumen-bbva.mjs
 * ─────────────────────────────────────────────────────────────
 * Test de regresión del parser de resúmenes contra el resumen REAL de la
 * tarjeta BBVA Visa Gold del usuario (titular FRANKOWSKI AXEL MARTIN).
 *
 * Verifica que cada ítem se identifique sin errores:
 *   - banco BBVA (no Macro, pese a la tabla comparativa de la pág. 7)
 *   - fechas de cierre/vencimiento (layout tabla) + próximo ciclo
 *   - 15 consumos exactos (13 ARS + 2 USD), nada de filas de totales coladas
 *   - CLAUDE.AI y WWW.F1.COM detectados como USD
 *   - total ARS = 857.352,71 y total USD = 31,99 (= "TOTAL CONSUMOS" del PDF)
 *
 * Correr:  node tests/test-resumen-bbva.mjs   (desde la carpeta frontend)
 */

import { _parsearTexto } from '../js/pdf-statement-parser.js';

// ── Texto representativo del PDF (como lo extrae PDF.js: tablas en filas) ──
const LINEAS = [
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Visa Gold cuenta 0950565079 CONSOLIDADO',
  // Tabla de fechas/saldos: etiquetas en una fila, valores en la siguiente.
  'CIERRE ACTUAL VENCIMIENTO ACTUAL SALDO ACTUAL $ SALDO ACTUAL U$S PAGO MÍNIMO $',
  '28-May-26 05-Jun-26 888.286,87 31,99 154.320,00',
  'Otros períodos CIERRE ANTERIOR VENCIMIENTO ANTERIOR PRÓXIMO CIERRE PRÓXIMO VENCIMIENTO',
  '30-Abr-26 08-May-26 02-Jul-26 13-Jul-26',
  // Pagos/ajustes (deben EXCLUIRSE)
  '04-May-26 SU PAGO EN USD -16,94',
  '06-May-26 SU PAGO EN PESOS -973.072,63',
  '08-May-26 CR.RG 5617 30% M -7.071,60',
  // Consumos ARS
  '23-Ene-26 CETROGAR SA C.05/09 008593 55.999,88',
  '02-Abr-26 MERPAGO*MERCADOLIBRE C.02/06 876846 155.579,51',
  '02-May-26 MERPAGO*SAFARYNCLAUDIO 677567 174.393,70',
  '04-May-26 PERSONAL 002473 56.299,28',
  '05-May-26 MERPAGO*COMERCIALICSA 420515 78.849,08',
  '06-May-26 MERPAGO*MAXIMOANDRESFR 254602 152.995,70',
  '11-May-26 MERPAGO*SAFARYNCLAUDIOALE 513447 3.744,65',
  '11-May-26 ANIMAL WORLD 006939 9.700,00',
  '12-May-26 MERPAGO*TRENDYDEALS C.01/09 627731 48.699,96',
  '14-May-26 LIBERTAD SA 009206 77.646,30',
  '18-May-26 EST DE SERVICIO YPF DE 042886 30.000,00',
  '18-May-26 ANIMAL WORLD 009068 9.700,00',
  '23-May-26 MERPAGO*NUEZGLADISESTHER 310554 3.744,65',
  // Consumos USD (pesos vacío, dólares en columna derecha)
  '05-May-26 CLAUDE.AI SUBSCR in1TTXjpBUSD 20,00 434263 20,00',
  '06-May-26 WWW.F1.COM USD 11,99 312320 11,99',
  // Totales e impuestos (deben EXCLUIRSE)
  'TOTAL CONSUMOS DE AXEL M FRANKOWSKI 857.352,71 31,99',
  '30-Abr-26 COMISION CTA PGOLD 20.206,61',
  '28-May-26 DB IVA $ 21% 20.206,61 4.243,39',
  '28-May-26 DB.RG 5617 30% ( 45185,87 ) 13.555,76',
  'SALDO ACTUAL 888.286,87 31,99',
  // Ruido: tabla comparativa "Primeras 10 entidades" (pág 7) nombra otros bancos
  'BANCO DE GALICIA Y BUENOS AIRES S.A. $ 0,00 $ 361.800,00',
  'BANCO MACRO S.A. $ 0,00 $ 472.989,00',
  'BANCO SANTANDER ARGENTINA S.A. $ 0,00 $ 301.169,00',
  // Pie de página BBVA (en el PDF real va en las 7 páginas)
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
  'Banco BBVA Argentina S.A. - IVA Responsable Inscripto CUIT Nro. 30-50000319-3',
];

// ── Esperado (de los totales del propio PDF) ─────────────────
const CONSUMOS_ESPERADOS = [
  { desc: 'CETROGAR SA',            monto: 55999.88,  moneda: 'ARS', cuota: '5/9' },
  { desc: 'MERPAGO*MERCADOLIBRE',   monto: 155579.51, moneda: 'ARS', cuota: '2/6' },
  { desc: 'MERPAGO*SAFARYNCLAUDIO', monto: 174393.70, moneda: 'ARS' },
  { desc: 'PERSONAL',               monto: 56299.28,  moneda: 'ARS' },
  { desc: 'MERPAGO*COMERCIALICSA',  monto: 78849.08,  moneda: 'ARS' },
  { desc: 'MERPAGO*MAXIMOANDRESFR', monto: 152995.70, moneda: 'ARS' },
  { desc: 'MERPAGO*SAFARYNCLAUDIOALE', monto: 3744.65, moneda: 'ARS' },
  { desc: 'ANIMAL WORLD',           monto: 9700.00,   moneda: 'ARS' },
  { desc: 'MERPAGO*TRENDYDEALS',    monto: 48699.96,  moneda: 'ARS', cuota: '1/9' },
  { desc: 'LIBERTAD SA',            monto: 77646.30,  moneda: 'ARS' },
  { desc: 'EST DE SERVICIO YPF',    monto: 30000.00,  moneda: 'ARS' },
  { desc: 'ANIMAL WORLD',           monto: 9700.00,   moneda: 'ARS' },
  { desc: 'MERPAGO*NUEZGLADISESTHER', monto: 3744.65, moneda: 'ARS' },
  { desc: 'CLAUDE.AI',              monto: 20.00,     moneda: 'USD' },
  { desc: 'WWW.F1.COM',             monto: 11.99,     moneda: 'USD' },
];

// ── Runner mínimo ────────────────────────────────────────────
let ok = 0, fail = 0;
const eq = (a, b, eps = 0.001) => Math.abs(a - b) < eps;
function check(nombre, cond, extra = '') {
  if (cond) { ok++; }
  else { fail++; console.log(`  ✗ ${nombre} ${extra}`); }
}

const r = _parsearTexto({ texto: LINEAS.join('\n'), lineas: LINEAS });

console.log('── Encabezado ──');
check('banco = BBVA', r.banco === 'BBVA', `(fue ${r.banco})`);
check('período = 2026-05', r.periodo === '2026-05', `(fue ${r.periodo})`);
check('cierre = 2026-05-28', r.fechaCierre === '2026-05-28', `(fue ${r.fechaCierre})`);
check('vencimiento = 2026-06-05', r.fechaVencimiento === '2026-06-05', `(fue ${r.fechaVencimiento})`);
check('cierre anterior = 2026-04-30', r.cierreAnterior === '2026-04-30', `(fue ${r.cierreAnterior})`);
check('próximo cierre = 2026-07-02', r.proximoCierre === '2026-07-02', `(fue ${r.proximoCierre})`);
check('próximo venc = 2026-07-13', r.proximoVencimiento === '2026-07-13', `(fue ${r.proximoVencimiento})`);
check('saldo = 888.286,87', eq(r.saldoTotal, 888286.87, 0.01), `(fue ${r.saldoTotal})`);
check('pago mínimo = 154.320', eq(r.pagoMinimo, 154320, 0.01), `(fue ${r.pagoMinimo})`);

console.log('── Consumos ──');
check(`cantidad = ${CONSUMOS_ESPERADOS.length}`, r.movimientos.length === CONSUMOS_ESPERADOS.length,
      `(fueron ${r.movimientos.length})`);

// Ningún ítem debe ser una fila de totales (saldo / pago mínimo)
const colados = r.movimientos.filter(m => eq(m.monto, 154320, 0.01) || eq(m.monto, 888286.87, 0.01));
check('sin filas de totales coladas', colados.length === 0,
      `(coladas: ${colados.map(c => c.descripcion).join(', ')})`);

// Cada consumo esperado debe existir con su moneda y monto
for (const exp of CONSUMOS_ESPERADOS) {
  const m = r.movimientos.find(x =>
    x.descripcion.toUpperCase().includes(exp.desc.toUpperCase()) &&
    eq(x.monto, exp.monto, 0.01) && x.moneda === exp.moneda);
  check(`${exp.desc} → ${exp.moneda} ${exp.monto}`, !!m,
        m ? '' : `(no encontrado; candidatos: ${r.movimientos.filter(x=>x.descripcion.toUpperCase().includes(exp.desc.toUpperCase().slice(0,6))).map(x=>`${x.descripcion}=${x.moneda} ${x.monto}`).join(' | ')})`);
  if (m && exp.cuota) {
    check(`${exp.desc} cuota ${exp.cuota}`, `${m.cuotaActual}/${m.cuotasTotal}` === exp.cuota,
          `(fue ${m.cuotaActual}/${m.cuotasTotal})`);
  }
}

console.log('── Totales ──');
const totalArs = r.movimientos.filter(m => m.moneda === 'ARS').reduce((a, m) => a + m.monto, 0);
const totalUsd = r.movimientos.filter(m => m.moneda === 'USD').reduce((a, m) => a + m.monto, 0);
check('total ARS = 857.352,71', eq(totalArs, 857352.71, 0.01), `(fue ${totalArs.toFixed(2)})`);
check('total USD = 31,99', eq(totalUsd, 31.99, 0.01), `(fue ${totalUsd.toFixed(2)})`);

console.log(`\n${fail === 0 ? '✓ TODOS OK' : '✗ HAY FALLAS'} — ${ok} pasados, ${fail} fallados`);
process.exit(fail === 0 ? 0 : 1);
