/**
 * test-pdf-lineas.mjs
 * ─────────────────────────────────────────────────────────────
 * Reproduce el bug "faltan consumos al subir el resumen": PDF.js entrega cada
 * celda como un fragmento con su (x,y). La columna de montos suele caer en un Y
 * sub-píxel distinto al de la descripción; con el redondeo viejo (Math.round)
 * el monto se iba a OTRA línea y el consumo entero se perdía.
 *
 * Aquí construimos los `items` como los daría PDF.js —con jitter de Y en la
 * columna de montos, incluso cruzando bordes de redondeo— y verificamos que
 * `_agruparEnLineas` + `_parsearTexto` recuperen los 15 consumos sin perder
 * ninguno y con los totales exactos del PDF.
 *
 * Correr:  node tests/test-pdf-lineas.mjs   (desde la carpeta frontend)
 */

import { _agruparEnLineas } from '../js/pdf-import.js';
import { _parsearTexto } from '../js/pdf-statement-parser.js';

// Columnas (x) aproximadas del resumen BBVA
const X = { fecha: 50, desc: 95, cupon: 360, pesos: 460, dolar: 540 };

// Consumos reales (desc, cupón, monto pesos | { usd } para dólares)
const CONSUMOS = [
  ['23-Ene-26', 'CETROGAR SA C.05/09',        '008593', 55999.88],
  ['02-Abr-26', 'MERPAGO*MERCADOLIBRE C.02/06','876846', 155579.51],
  ['02-May-26', 'MERPAGO*SAFARYNCLAUDIO',     '677567', 174393.70],
  ['04-May-26', 'PERSONAL',                   '002473', 56299.28],
  ['05-May-26', 'MERPAGO*COMERCIALICSA',      '420515', 78849.08],
  ['05-May-26', 'CLAUDE.AI SUBSCR in1TTXjpBUSD 20,00', '434263', { usd: 20.00 }],
  ['06-May-26', 'MERPAGO*MAXIMOANDRESFR',     '254602', 152995.70],
  ['06-May-26', 'WWW.F1.COM USD 11,99',       '312320', { usd: 11.99 }],
  ['11-May-26', 'MERPAGO*SAFARYNCLAUDIOALE',  '513447', 3744.65],
  ['11-May-26', 'ANIMAL WORLD',               '006939', 9700.00],
  ['12-May-26', 'MERPAGO*TRENDYDEALS C.01/09','627731', 48699.96],
  ['14-May-26', 'LIBERTAD SA',                '009206', 77646.30],
  ['18-May-26', 'EST DE SERVICIO YPF DE',     '042886', 30000.00],
  ['18-May-26', 'ANIMAL WORLD',               '009068', 9700.00],
  ['23-May-26', 'MERPAGO*NUEZGLADISESTHER',   '310554', 3744.65],
];

const fmtMonto = (n) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(n);

const items = [];
const push = (x, y, str) => items.push({ x, y, str });

// ── Encabezado (tablas: etiquetas en una fila, valores en la de abajo) ──
let y = 800;
push(X.fecha, y, 'Banco BBVA Argentina S.A. - IVA Responsable CUIT 30-50000319-3');
y -= 20;
push(50, y, 'CIERRE ACTUAL'); push(170, y + 0.4, 'VENCIMIENTO ACTUAL');
push(300, y - 0.3, 'SALDO ACTUAL $'); push(420, y + 0.2, 'SALDO ACTUAL U$S'); push(520, y, 'PAGO MÍNIMO $');
y -= 12;
push(50, y, '28-May-26'); push(170, y + 0.6, '05-Jun-26');
push(300, y - 0.5, '888.286,87'); push(420, y + 0.45, '31,99'); push(520, y + 0.7, '154.320,00');
y -= 20;
push(50, y, 'Otros períodos CIERRE ANTERIOR'); push(220, y + 0.3, 'VENCIMIENTO ANTERIOR');
push(360, y - 0.4, 'PRÓXIMO CIERRE'); push(480, y + 0.5, 'PRÓXIMO VENCIMIENTO');
y -= 12;
push(50, y, '30-Abr-26'); push(220, y + 0.4, '08-May-26'); push(360, y - 0.6, '02-Jul-26'); push(480, y + 0.55, '13-Jul-26');

// ── Consumos: cada celda como item separado, con JITTER de Y en cada columna ──
// (la columna de montos, a propósito, con offset que cruza el borde de redondeo)
y -= 24;
for (const [fecha, desc, cupon, monto] of CONSUMOS) {
  push(X.fecha, y + 0.30, fecha);
  push(X.desc,  y - 0.20, desc);
  push(X.cupon, y + 0.10, cupon);
  if (typeof monto === 'object') {
    // consumo USD: pesos vacío, dólares a la derecha (y el monto USD ya en desc)
    push(X.dolar, y + 0.62, fmtMonto(monto.usd));   // +0.62 → Math.round lo subía de línea
  } else {
    push(X.pesos, y + 0.62, fmtMonto(monto));        // jitter que rompía el agrupado viejo
  }
  y -= 12;
}

// ── Ruido (pagos/impuestos a excluir + tabla comparativa pág 7) ──
y -= 16;
push(X.fecha, y, '04-May-26'); push(X.desc, y, 'SU PAGO EN PESOS'); push(X.pesos, y + 0.5, '-973.072,63');
y -= 12;
push(X.fecha, y, '30-Abr-26'); push(X.desc, y, 'COMISION CTA PGOLD'); push(X.pesos, y + 0.5, '20.206,61');
y -= 12;
push(X.fecha, y, 'TOTAL CONSUMOS DE AXEL M FRANKOWSKI'); push(X.pesos, y + 0.5, '857.352,71'); push(X.dolar, y, '31,99');
y -= 16;
push(50, y, 'BANCO MACRO S.A.'); push(300, y, '$ 472.989,00');
for (let k = 0; k < 6; k++) { y -= 12; push(50, y, 'Banco BBVA Argentina S.A. CUIT 30-50000319-3'); }

// ── Ejecutar pipeline real ───────────────────────────────────
const lineas = _agruparEnLineas(items);
const r = _parsearTexto({ texto: lineas.join('\n'), lineas });

let ok = 0, fail = 0;
const eq = (a, b, e = 0.01) => Math.abs(a - b) < e;
const check = (n, c, x = '') => { if (c) ok++; else { fail++; console.log(`  ✗ ${n} ${x}`); } };

console.log('── Agrupado de líneas ──');
// Cada consumo debe quedar en UNA línea con su monto (no partido)
for (const [fecha, desc, , monto] of CONSUMOS) {
  const clave = desc.split(' ')[0].slice(0, 10);
  const linea = lineas.find(l => l.includes(clave));
  const tieneMonto = linea && /\d{1,3}(?:\.\d{3})*,\d{2}/.test(linea);
  check(`fila "${clave}" con monto en misma línea`, !!tieneMonto,
        linea ? `→ "${linea}"` : '(línea no encontrada)');
}

console.log('── Parse end-to-end ──');
check('banco BBVA', r.banco === 'BBVA', `(${r.banco})`);
check('cierre 2026-05-28', r.fechaCierre === '2026-05-28', `(${r.fechaCierre})`);
check('venc 2026-06-05', r.fechaVencimiento === '2026-06-05', `(${r.fechaVencimiento})`);
check(`15 consumos (no se pierde ninguno)`, r.movimientos.length === 15, `(fueron ${r.movimientos.length})`);

const ars = r.movimientos.filter(m => m.moneda === 'ARS').reduce((a, m) => a + m.monto, 0);
const usd = r.movimientos.filter(m => m.moneda === 'USD').reduce((a, m) => a + m.monto, 0);
check('total ARS = 857.352,71', eq(ars, 857352.71), `(${ars.toFixed(2)})`);
check('total USD = 31,99', eq(usd, 31.99), `(${usd.toFixed(2)})`);

// Listar lo que se perdió, si algo
if (r.movimientos.length !== 15) {
  console.log('  Detectados:', r.movimientos.map(m => `${m.descripcion}=${m.moneda} ${m.monto}`));
}

console.log(`\n${fail === 0 ? '✓ TODOS OK' : '✗ HAY FALLAS'} — ${ok} pasados, ${fail} fallados`);
process.exit(fail === 0 ? 0 : 1);
