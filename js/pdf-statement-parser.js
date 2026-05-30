/**
 * pdf-statement-parser.js
 * ─────────────────────────
 * Parser de resúmenes de tarjeta de crédito argentinos en PDF.
 *
 * Soporta los dos formatos de fecha más comunes:
 *   - Banco Macro:  "04.05.26"   (DD.MM.YY con puntos)
 *   - Banco BBVA:   "23-Ene-26"  (DD-MMM-YY con mes abreviado en español)
 *   - Genérico:     "14/03/26" o "14/03" (DD/MM con barras)
 *
 * Extrae: período, banco, fecha de cierre, fecha de vencimiento, saldo total,
 * pago mínimo, total de consumos (para validación) y la lista de movimientos
 * (consumos), filtrando pagos, impuestos, comisiones e intereses.
 *
 * Reutiliza extraerTextoPdf() y num() de pdf-import.js.
 */

import { extraerTextoPdf, num } from './pdf-import.js';

/* ─── Constantes ───────────────────────────────────────────── */

const MESES_ABR = {
  ENE: '01', FEB: '02', MAR: '03', ABR: '04', MAY: '05', JUN: '06',
  JUL: '07', AGO: '08', SEP: '09', SET: '09', OCT: '10', NOV: '11', DIC: '12',
};

// Bancos conocidos para etiquetar (se detecta por keyword en el texto).
const BANCOS = [
  { re: /\bMACRO\b/i,        nombre: 'Banco Macro' },
  { re: /\bBBVA\b/i,         nombre: 'BBVA' },
  { re: /\bGALICIA\b/i,      nombre: 'Banco Galicia' },
  { re: /\bSANTANDER\b/i,    nombre: 'Santander' },
  { re: /\bICBC\b/i,         nombre: 'ICBC' },
  { re: /\bHSBC\b/i,         nombre: 'HSBC' },
  { re: /\bNACION\b/i,       nombre: 'Banco Nación' },
  { re: /\bCREDICOOP\b/i,    nombre: 'Credicoop' },
  { re: /\bBRUBANK\b/i,      nombre: 'Brubank' },
  { re: /\bUALA\b/i,         nombre: 'Ualá' },
  { re: /\bNARANJA\b/i,      nombre: 'Naranja X' },
];

// Líneas que NO son consumos: pagos, impuestos, comisiones, saldos, resúmenes.
const EXCLUIR = [
  /SALDO\s+ANTERIOR/i,
  /SALDO\s+ACTUAL/i,
  /SU\s+PAGO/i,
  /DEV\.?\s*IMP/i,
  /\bCR\.?\s*RG/i,
  /\bDB\.?\s*RG/i,
  /\bDB\s+IVA/i,
  /\bIVA\s+RG/i,
  /\bIVA\s+\d/i,
  /COMISION/i,
  /COMISIÓN/i,
  /TOTAL\s+CONSUMOS/i,
  /PAGO\s+M[IÍ]NIMO/i,
  /TOTAL\s+DE\s+CUOTAS/i,
  /CUOTAS?\s+A\s+VENCER/i,
  /\bIMP\.?\s*LEY/i,
  /PERCEP/i,
  /SEGURO\s+DE\s+VIDA/i,
  /CARGO\s+FINANC/i,
  /INTERESES?\s+(?:POR|DE|FINANC|PUNIT|COMPENS)/i,
];

/* ─── Helpers de fecha y números ───────────────────────────── */

function quitarTildes(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function pad2(s) { return String(s).padStart(2, '0'); }
function anio4(s) { const n = parseInt(s, 10); return n < 100 ? 2000 + n : n; }
function normMes(s) { return quitarTildes(s).toUpperCase().slice(0, 3); }

/**
 * Parsea un token de fecha suelto en cualquiera de los formatos soportados.
 * Devuelve 'YYYY-MM-DD' o null.
 */
function parsearFechaToken(str) {
  if (!str) return null;
  let m;
  // DD-Mon-YY / DD Mon YY  (BBVA, headers Macro): 23-Ene-26, 21 May 26
  m = str.match(/(\d{1,2})[-\s.]([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4})[-\s.](\d{2,4})/);
  if (m) {
    const mm = MESES_ABR[normMes(m[2])];
    if (mm) return `${anio4(m[3])}-${mm}-${pad2(m[1])}`;
  }
  // DD.MM.YY  (Macro): 04.05.26
  m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (m) return `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`;
  // DD/MM/YY  (genérico con año)
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}

/**
 * Extrae la fecha al inicio de una línea de movimiento + el resto del texto.
 * Devuelve { fecha:'YYYY-MM-DD', resto } o, para DD/MM sin año,
 * { fecha:null, dia, mes, resto } para resolver el año por el ciclo.
 */
function extraerFechaInicio(linea) {
  let m;
  // DD-Mon-YY (BBVA)
  m = linea.match(/^\s*(\d{1,2})-([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4})-(\d{2,4})\s+(.*)$/);
  if (m) {
    const mm = MESES_ABR[normMes(m[2])];
    if (mm) return { fecha: `${anio4(m[3])}-${mm}-${pad2(m[1])}`, resto: m[4] };
  }
  // DD.MM.YY (Macro)
  m = linea.match(/^\s*(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(.*)$/);
  if (m) return { fecha: `${anio4(m[3])}-${pad2(m[2])}-${pad2(m[1])}`, resto: m[4] };
  // DD/MM/YY o DD/MM (genérico)
  m = linea.match(/^\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.*)$/);
  if (m) {
    const anioParcial = m[3] ? anio4(m[3]) : null;
    return { fecha: null, dia: m[1], mes: m[2], anioParcial, resto: m[4] };
  }
  return null;
}

/* ─── Extracción de monto + moneda + descripción ───────────── */

const RE_FX = /\b(USD|EUR|BRL|U\$S|U\$D)\s*([\d]{1,3}(?:\.[\d]{3})*,\d{2})(-?)/i;
const RE_AMT = /(\d{1,3}(?:\.\d{3})*,\d{2})(-?)/g;

function normalizarMoneda(s) {
  const u = s.toUpperCase();
  if (u === 'U$S' || u === 'U$D') return 'USD';
  return u;
}

/**
 * De "resto" (texto tras la fecha) saca el monto, la moneda y la descripción
 * cruda (sin limpiar comprobantes ni cuotas todavía).
 * Devuelve null si no hay monto, o { credito:true } si es un crédito/pago.
 */
function extraerMontoDesc(resto) {
  // 1. ¿Hay moneda extranjera? (consumos en USD/EUR/BRL)
  const fx = resto.match(RE_FX);
  if (fx) {
    if (fx[3] === '-') return { credito: true };        // pago/devolución en USD
    return {
      monto: num(fx[2]),
      moneda: normalizarMoneda(fx[1]),
      descRaw: resto.slice(0, fx.index).trim(),
    };
  }
  // 2. Montos en pesos: tomamos el ÚLTIMO (columna PESOS está a la derecha)
  const amts = [...resto.matchAll(RE_AMT)];
  if (!amts.length) return null;
  const last = amts[amts.length - 1];
  if (last[2] === '-') return { credito: true };         // crédito/pago/devolución
  return {
    monto: num(last[1]),
    moneda: 'ARS',
    descRaw: resto.slice(0, last.index).trim(),
  };
}

/**
 * Limpia la descripción cruda: quita comprobante (líder o final), cuotas,
 * y extrae info de cuotas si existe (Cuota 04/12 ó C.04/09).
 */
function limpiarDesc(descRaw) {
  let d = descRaw;
  let cuotaActual = null, cuotasTotal = null;

  // Cuotas: "Cuota 04/12", "C.04/09", "C 04/06"
  const cm = d.match(/\b(?:CUOTA|C)\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/i);
  if (cm) {
    cuotaActual = parseInt(cm[1], 10);
    cuotasTotal = parseInt(cm[2], 10);
    d = d.replace(cm[0], ' ');
  }
  // Comprobante líder (Macro): 4-8 dígitos + opcional * o letra. Ej "689452K", "008592*"
  d = d.replace(/^\s*\d{4,8}[*A-Za-z]?\s+/, '');
  // Comprobante/cupón al final (BBVA): 4-8 dígitos. Ej "...RODR 173212"
  d = d.replace(/\s+\d{4,8}\s*$/, '');
  // Limpieza final
  d = d.replace(/\s{2,}/g, ' ').trim();
  return { desc: d, cuotaActual, cuotasTotal };
}

function esExcluido(s) {
  return EXCLUIR.some(re => re.test(s));
}

/**
 * Parsea una línea individual. Devuelve un movimiento o null.
 */
function parsearLinea(linea, ctx) {
  const f = extraerFechaInicio(linea);
  if (!f) return null;

  const md = extraerMontoDesc(f.resto);
  if (!md || md.credito || !(md.monto > 0)) return null;

  // Filtro de pagos/impuestos sobre el texto completo y la descripción
  if (esExcluido(f.resto)) return null;

  const { desc, cuotaActual, cuotasTotal } = limpiarDesc(md.descRaw);
  if (!desc || desc.length < 2 || esExcluido(desc)) return null;

  // Resolver año para DD/MM sin año explícito
  let fecha = f.fecha;
  if (!fecha && f.dia) {
    const mesMov = parseInt(f.mes, 10);
    let anio = f.anioParcial;
    if (!anio) {
      anio = (ctx.mesCierre && mesMov > ctx.mesCierre) ? ctx.anioCierre - 1 : ctx.anioCierre;
    }
    fecha = `${anio}-${pad2(f.mes)}-${pad2(f.dia)}`;
  }

  const mov = { fecha, descripcion: desc, monto: md.monto, moneda: md.moneda };
  if (cuotasTotal) { mov.cuotaActual = cuotaActual; mov.cuotasTotal = cuotasTotal; }
  return mov;
}

/* ─── Búsqueda de campos del header ────────────────────────── */

function buscarFechaLabel(texto, labels) {
  for (const label of labels) {
    const re = new RegExp(
      label + '[\\s\\S]{0,80}?(\\d{1,2})[-\\s.]([A-Za-zÁÉÍÓÚáéíóúüÜ]{3,4}|\\d{1,2})[-\\s.](\\d{2,4})',
      'i'
    );
    const m = texto.match(re);
    if (m) {
      // El grupo 2 puede ser mes-nombre o mes-número
      let mm;
      if (/^\d+$/.test(m[2])) mm = pad2(m[2]);
      else mm = MESES_ABR[normMes(m[2])];
      if (mm) return `${anio4(m[3])}-${mm}-${pad2(m[1])}`;
    }
  }
  return '';
}

function buscarMontoLabel(texto, labels) {
  for (const label of labels) {
    const re = new RegExp(label + '[^0-9\\-]{0,30}(\\d{1,3}(?:\\.\\d{3})*,\\d{2})', 'i');
    const m = texto.match(re);
    if (m) return num(m[1]);
  }
  return 0;
}

function buscarTotalConsumos(texto) {
  const m = texto.match(/TOTAL\s+CONSUMOS[^0-9]*?(\d{1,3}(?:\.\d{3})*,\d{2})/i);
  return m ? num(m[1]) : 0;
}

function detectarBanco(texto) {
  for (const b of BANCOS) {
    if (b.re.test(texto)) return b.nombre;
  }
  return 'Banco';
}

/* ─── Parser principal (testeable sin PDF) ─────────────────── */

/**
 * Parsea el resultado de extraerTextoPdf ({ texto, lineas }).
 * Separado de parsearResumenTarjeta() para poder testear sin un PDF real.
 */
export function _parsearTexto({ texto, lineas }) {
  const banco = detectarBanco(texto);

  const fechaCierre = buscarFechaLabel(texto, ['CIERRE\\s+ACTUAL', 'CIERRE']);
  const fechaVencimiento = buscarFechaLabel(texto, ['VENCIMIENTO\\s+ACTUAL', 'VENCIMIENTO']);

  // El período se deriva del cierre (YYYY-MM). Es lo más confiable.
  const periodo = fechaCierre ? fechaCierre.slice(0, 7) : '';
  const [anioCierreStr, mesCierreStr] = periodo ? periodo.split('-') : ['', ''];
  const ctx = {
    anioCierre: anioCierreStr ? parseInt(anioCierreStr, 10) : new Date().getFullYear(),
    mesCierre:  mesCierreStr ? parseInt(mesCierreStr, 10) : (new Date().getMonth() + 1),
  };

  const saldoTotal   = buscarMontoLabel(texto, ['SALDO\\s+ACTUAL\\s*\\$', 'SALDO\\s+ACTUAL']);
  const pagoMinimo   = buscarMontoLabel(texto, ['PAGO\\s+M[IÍ]NIMO\\s*\\$', 'PAGO\\s+M[IÍ]NIMO', 'PAGO\\s+MIN\\.?\\s*\\$']);
  const totalConsumos = buscarTotalConsumos(texto);

  const movimientos = [];
  for (const linea of lineas) {
    const mov = parsearLinea(linea, ctx);
    if (mov) movimientos.push(mov);
  }

  return {
    banco,
    periodo,
    fechaCierre,
    fechaVencimiento,
    saldoTotal,
    pagoMinimo,
    totalConsumos,
    movimientos,
  };
}

/**
 * Parsea un PDF de resumen de tarjeta de crédito.
 * @param {File} file  Archivo PDF subido por el usuario.
 */
export async function parsearResumenTarjeta(file) {
  const { texto, lineas } = await extraerTextoPdf(file);
  return _parsearTexto({ texto, lineas });
}

/* ─── Matching con gastos existentes ───────────────────────── */

function normalizar(s = '') {
  return String(s)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similitud(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const tokensA = na.split(' ').filter(t => t.length > 1);
  const tokensB = nb.split(' ').filter(t => t.length > 1);
  if (!tokensA.length || !tokensB.length) return 0;
  let coincidencias = 0;
  for (const t of tokensA) if (nb.includes(t)) coincidencias++;
  return coincidencias / Math.max(tokensA.length, tokensB.length);
}

/**
 * Cruza los movimientos del resumen con los gastos ya registrados de la tarjeta.
 * Scoring: fecha exacta 0.5 + monto exacto 0.4 + descripción similar 0.1.
 * Umbrales: ≥0.7 exacto · ≥0.3 probable · <0.3 no_encontrado.
 */
export function matchearConGastos(movimientos, gastos, tarjetaId) {
  const candidatos = gastos.filter(g => g.tarjeta_id === tarjetaId && !g.deleted);
  const usados = new Set();

  return movimientos.map(mov => {
    let mejorScore = 0, mejorGasto = null;
    for (const g of candidatos) {
      if (usados.has(g.id)) continue;
      let score = 0;
      // El MONTO es la señal primaria en una conciliación bancaria.
      const montoCoincide = Math.abs((g.monto || 0) - mov.monto) <= 1;
      if (montoCoincide) score += 0.6;
      // La fecha confirma; sola no alcanza para "probable".
      if (g.fecha === mov.fecha) score += 0.3;
      else if (g.fecha && mov.fecha && Math.abs(new Date(g.fecha) - new Date(mov.fecha)) <= 2 * 86400000) score += 0.15;
      score += similitud(g.descripcion, mov.descripcion) * 0.1;
      if (score > mejorScore) { mejorScore = score; mejorGasto = g; }
    }
    let confianza;
    if (mejorScore >= 0.7) { confianza = 'exacto'; if (mejorGasto) usados.add(mejorGasto.id); }
    else if (mejorScore >= 0.4) { confianza = 'probable'; }   // requiere al menos monto
    else { confianza = 'no_encontrado'; mejorGasto = null; }
    return { ...mov, match: mejorGasto, confianza, _score: mejorScore };
  });
}
