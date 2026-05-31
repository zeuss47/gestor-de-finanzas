/**
 * test-posicion.mjs
 * ─────────────────────────────────────────────────────────────
 * Valida la "regla de oro" de la guía: leer el resumen por POSICIÓN (coordenada
 * x de cada celda), no por regex sobre el texto. Construimos los `items` como
 * los daría PDF.js (con x0/x1 y montos alineados a la derecha en su columna) y
 * verificamos:
 *   - separación PESOS vs DÓLARES por la columna (x1), incluso cuando el consumo
 *     USD NO dice "USD" en el texto.
 *   - el monto correcto cuando aparece dos veces (embebido en la descripción y
 *     en la columna): se toma el de la columna (x1 mayor).
 *   - la fila de totales (con 2 fechas) no se cuela como consumo.
 *   - reconciliación contable: suma de consumos == total impreso, fechas en orden.
 *
 * Correr:  node tests/test-posicion.mjs   (desde la carpeta frontend)
 */

import { _agruparEnFilas } from '../js/pdf-import.js';
import { _parsearTexto } from '../js/pdf-statement-parser.js';

// Columnas (x) tipo BBVA: pesos termina en x1≈502, dólares en x1≈574
const COL = { fecha: 40, desc: 95, cupon: 360, pesosX1: 502, dolarX1: 574 };
const fmt = (n) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2 }).format(n);

const items = [];
const W = (x0, x1, y, str) => items.push({ x0, x1, y, str });
// token de monto alineado a la derecha: x1 fijo en la columna, x0 = x1 - ancho
const MONTO = (x1, y, str) => W(x1 - str.length * 5, x1, y, str);

// ── Encabezado (tabla: etiquetas arriba, valores abajo; con jitter de Y) ──
let y = 800;
W(COL.fecha, 560, y, 'Banco BBVA Argentina S.A. CUIT 30-50000319-3');
y -= 20;
W(40, 120, y, 'CIERRE ACTUAL'); W(170, 260, y + 0.4, 'VENCIMIENTO ACTUAL');
W(300, 380, y - 0.3, 'SALDO ACTUAL $'); W(420, 490, y + 0.2, 'PAGO MÍNIMO $');
y -= 12;
W(40, 95, y, '28-May-26'); W(170, 225, y + 0.5, '05-Jun-26');
MONTO(COL.pesosX1, y - 0.4, '396.888,36'); MONTO(COL.dolarX1, y + 0.6, '154.320,00');
y -= 20;
W(40, 210, y, 'Otros períodos CIERRE ANTERIOR'); W(220, 360, y + 0.3, 'VENCIMIENTO ANTERIOR');
W(360, 470, y - 0.4, 'PRÓXIMO CIERRE'); W(480, 590, y + 0.5, 'PRÓXIMO VENCIMIENTO');
y -= 12;
W(40, 95, y, '30-Abr-26'); W(220, 275, y + 0.4, '08-May-26'); W(360, 415, y - 0.6, '02-Jul-26'); W(480, 535, y + 0.55, '13-Jul-26');

// ── Consumos. monto = pesos (x1=502) | { usd, marca } = dólares (x1=574) ──
// "marca:false" = consumo en USD que NO dice "USD" en el texto (solo posición).
const CONSUMOS = [
  ['02-May-26', 'MERPAGO*SAFARYNCLAUDIO', '677567', 174393.70],
  ['04-May-26', 'PERSONAL',               '002473', 56299.28],
  ['05-May-26', 'MERPAGO*COMERCIALICSA',  '420515', 78849.08],
  ['11-May-26', 'ANIMAL WORLD',           '006939', 9700.00],
  ['14-May-26', 'LIBERTAD SA',            '009206', 77646.30],
  ['12-May-26', 'SPOTIFY P34ABZ',         '778899', { usd: 5.99, marca: false }],  // USD sin texto "USD"
  ['06-May-26', 'WWW.F1.COM',             '312320', { usd: 11.99, marca: true }],  // USD con "USD 11,99"
];

y -= 24;
for (const [fecha, desc, cupon, monto] of CONSUMOS) {
  W(COL.fecha, COL.fecha + 50, y + 0.3, fecha);
  W(COL.desc, COL.desc + desc.length * 5, y - 0.2, desc);
  if (typeof monto === 'object') {
    if (monto.marca) W(290, 330, y, `USD ${fmt(monto.usd)}`);   // amount embebido con marca USD
    else             MONTO(330, y, fmt(monto.usd));             // amount embebido SIN marca (a la izq.)
    W(COL.cupon, COL.cupon + 40, y + 0.1, cupon);
    MONTO(COL.dolarX1, y + 0.62, fmt(monto.usd));               // columna DÓLARES (x1=574)
  } else {
    W(COL.cupon, COL.cupon + 40, y + 0.1, cupon);
    MONTO(COL.pesosX1, y + 0.62, fmt(monto));                  // columna PESOS (x1=502)
  }
  y -= 12;
}

// ── Ruido (pago + total impreso para reconciliar) ──
y -= 16;
W(COL.fecha, 95, y, '06-May-26'); W(COL.desc, 260, y, 'SU PAGO EN PESOS'); MONTO(COL.pesosX1, y + 0.5, '-973.072,63');
y -= 12;
W(COL.fecha, 320, y, 'TOTAL CONSUMOS DE AXEL M FRANKOWSKI'); MONTO(COL.pesosX1, y + 0.4, '396.888,36'); MONTO(COL.dolarX1, y, '17,98');
y -= 16;
W(40, 160, y, 'BANCO MACRO S.A.'); MONTO(330, y, '472.989,00');
for (let k = 0; k < 6; k++) { y -= 12; W(40, 300, y, 'Banco BBVA Argentina S.A. CUIT 30-50000319-3'); }

// ── Pipeline real ───────────────────────────────────────────
const filas = _agruparEnFilas(items);
const lineas = filas.map(f => f.words.map(w => w.str).join(' ')).filter(l => l.trim());
const r = _parsearTexto({ texto: lineas.join('\n'), lineas, filas });

let ok = 0, fail = 0;
const eq = (a, b, e = 0.01) => Math.abs(a - b) < e;
const check = (n, c, x = '') => { if (c) ok++; else { fail++; console.log(`  ✗ ${n} ${x}`); } };

console.log('── Separación por posición ──');
check('banco BBVA', r.banco === 'BBVA', `(${r.banco})`);
check(`7 consumos`, r.movimientos.length === 7, `(${r.movimientos.length})`);

const spotify = r.movimientos.find(m => m.descripcion.includes('SPOTIFY'));
check('SPOTIFY detectado', !!spotify);
check('SPOTIFY es USD por POSICIÓN (sin texto "USD")', spotify && spotify.moneda === 'USD',
      spotify ? `(moneda=${spotify.moneda} monto=${spotify.monto})` : '');
check('SPOTIFY monto = 5,99 (columna, no embebido)', spotify && eq(spotify.monto, 5.99),
      spotify ? `(${spotify.monto})` : '');

const f1 = r.movimientos.find(m => m.descripcion.includes('F1'));
check('F1 es USD y monto 11,99', f1 && f1.moneda === 'USD' && eq(f1.monto, 11.99),
      f1 ? `(${f1.moneda} ${f1.monto})` : '');

const arsCount = r.movimientos.filter(m => m.moneda === 'ARS').length;
check('5 consumos ARS', arsCount === 5, `(${arsCount})`);
check('sin fila de totales colada', !r.movimientos.some(m => eq(m.monto, 154320) || eq(m.monto, 396888.36)));

console.log('── Reconciliación contable ──');
check('total ARS impreso = 396.888,36', eq(r.totalConsumos, 396888.36), `(${r.totalConsumos})`);
check('total USD impreso = 17,98', eq(r.totalConsumosUSD, 17.98), `(${r.totalConsumosUSD})`);
check('validacion.confiable = true', r.validacion.confiable,
      r.validacion.advertencias.join(' | '));
check('suma ARS reconcilia', eq(r.validacion.suma_ars, 396888.36), `(${r.validacion.suma_ars.toFixed(2)})`);
check('suma USD reconcilia', eq(r.validacion.suma_usd, 17.98), `(${r.validacion.suma_usd.toFixed(2)})`);

if (r.movimientos.length !== 7 || !r.validacion.confiable) {
  console.log('  Movimientos:', r.movimientos.map(m => `${m.descripcion}=${m.moneda} ${m.monto}`));
  console.log('  Advertencias:', r.validacion.advertencias);
}

console.log(`\n${fail === 0 ? '✓ TODOS OK' : '✗ HAY FALLAS'} — ${ok} pasados, ${fail} fallados`);
process.exit(fail === 0 ? 0 : 1);
