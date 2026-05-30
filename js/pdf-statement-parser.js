/**
 * pdf-statement-parser.js
 * ─────────────────────────
 * Parser de resúmenes de tarjeta de crédito argentinos en PDF.
 * Detecta movimientos (fecha, descripción, monto), el período del resumen
 * y el banco emisor, luego cruza con los gastos ya cargados en la app.
 *
 * Reutiliza helpers de pdf-import.js para no duplicar lógica.
 */

import { extraerTextoPdf, num, buscarPeriodoPago, buscarEmpleador } from './pdf-import.js';

/* ─── Regex de parsing ──────────────────────────────────────── */

// Línea de movimiento estándar argentina:
// "14/03  FARMACITY SA                   12.350,00"
const RE_MOV = /^(\d{2})\/(\d{2})\s+(.*?)\s+([\d]{1,3}(?:\.[\d]{3})*,\d{2})\s*$/;

// Moneda extranjera en la descripción:
// "USD 45,00" / "EUR 23.50" / "BRL 120,00"
const RE_FX  = /\b(USD|EUR|BRL)\b.*?([\d]{1,3}(?:\.[\d]{3})*[,.][\d]{2})/i;

// Total del resumen (última línea importante):
// "TOTAL A PAGAR   $  1.234.567,89" / "IMPORTE TOTAL 1.234.567,89"
const RE_TOTAL = /(?:TOTAL\s+A\s+PAGAR|IMPORTE\s+TOTAL|SALDO\s+A\s+PAGAR)\s*\$?\s*([\d]{1,3}(?:\.[\d]{3})*,\d{2})/i;

/* ─── Helpers internos ─────────────────────────────────────── */

/**
 * Calcula el año correcto para un movimiento dado el mes del período.
 * Ejemplo: período 2026-05, movimiento "12" → diciembre 2025 (año anterior).
 * Cualquier mes ≤ mes del período → mismo año. Mes > mes del período → año − 1.
 */
function resolverAnio(mesMovStr, anioperiodo, mesperiodo) {
  const mesMov = parseInt(mesMovStr, 10);
  const mesP   = parseInt(mesperiodo, 10);
  const anioP  = parseInt(anioperiodo, 10);
  // Si el movimiento es de un mes "posterior" al del período (e.g. ciclo mayo,
  // compra diciembre) significa que pertenece al año anterior del ciclo.
  if (mesMov > mesP) return anioP - 1;
  return anioP;
}

/**
 * Busca el total del resumen en el texto del PDF.
 */
function buscarTotalResumen(texto) {
  const m = texto.match(RE_TOTAL);
  return m ? num(m[1]) : 0;
}

/**
 * Parsea las líneas del PDF en busca de movimientos con fecha dd/mm.
 */
function parsearMovimientos(lineas, anioperiodo, mesperiodo) {
  const movimientos = [];
  for (const linea of lineas) {
    const m = linea.match(RE_MOV);
    if (!m) continue;

    const [, dia, mes, desc, montoStr] = m;
    const anio = resolverAnio(mes, anioperiodo, mesperiodo);
    const fecha = `${anio}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`;
    const monto = num(montoStr);

    if (monto <= 0) continue; // ignorar créditos / ajustes sin monto

    // Detectar moneda extranjera en la descripción
    let moneda = 'ARS';
    const fx = desc.match(RE_FX);
    if (fx) moneda = fx[1].toUpperCase();

    movimientos.push({
      fecha,
      descripcion: desc.trim(),
      monto,
      moneda,
    });
  }
  return movimientos;
}

/* ─── API pública ─────────────────────────────────────────── */

/**
 * Parsea un PDF de resumen de tarjeta de crédito.
 * @param {File} file  Archivo PDF subido por el usuario.
 * @returns {Promise<{periodo:string, banco:string, movimientos:Array, totalResumen:number}>}
 */
export async function parsearResumenTarjeta(file) {
  const { texto, lineas } = await extraerTextoPdf(file);

  // 1. Período: 'YYYY-MM'
  const periodo = buscarPeriodoPago(texto) || '';

  // 2. Banco: primera línea con aspecto de razón social
  const banco = buscarEmpleador(lineas) || 'Banco';

  // 3. Movimientos
  let anioperiodo = '', mesperiodo = '';
  if (periodo) {
    [anioperiodo, mesperiodo] = periodo.split('-');
  } else {
    // fallback: año y mes actuales
    const hoy = new Date();
    anioperiodo = String(hoy.getFullYear());
    mesperiodo  = String(hoy.getMonth() + 1).padStart(2, '0');
  }

  const movimientos = parsearMovimientos(lineas, anioperiodo, mesperiodo);

  // 4. Total del resumen
  const totalResumen = buscarTotalResumen(texto);

  return { periodo, banco, movimientos, totalResumen };
}

/* ─── Matching con gastos existentes ─────────────────────── */

/**
 * Normaliza un string para comparación: sin tildes, sin espacios extra, uppercase.
 */
function normalizar(s = '') {
  return String(s)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quitar tildes
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Similitud entre dos strings (0–1) basada en tokens compartidos.
 * Sin dependencias externas: usa includes() sobre tokens normalizados.
 */
function similitud(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const tokensA = na.split(' ').filter(t => t.length > 1);
  const tokensB = nb.split(' ').filter(t => t.length > 1);
  if (!tokensA.length || !tokensB.length) return 0;

  let coincidencias = 0;
  for (const t of tokensA) {
    if (nb.includes(t)) coincidencias++;
  }
  // Normalizar por el número de tokens del más largo para evitar sesgo
  const maxLen = Math.max(tokensA.length, tokensB.length);
  return coincidencias / maxLen;
}

/**
 * Cruza los movimientos del resumen bancario con los gastos ya registrados.
 *
 * Scoring por movimiento vs. gasto candidato:
 *   - Fecha exacta   → 0.5 pts
 *   - Monto exacto   → 0.4 pts
 *   - Desc. similar  → 0.1 pts (máx, proporcional a similitud())
 *
 * Umbrales:
 *   ≥ 0.7 → exacto      (fecha + monto)
 *   ≥ 0.3 → probable    (monto o fecha, parcial)
 *   < 0.3 → no_encontrado
 *
 * @param {Array}  movimientos  Movimientos del resumen (de parsearResumenTarjeta).
 * @param {Array}  gastos       Array completo de gastos de state.gastos.
 * @param {string} tarjetaId    ID de la tarjeta seleccionada.
 * @returns {Array} Movimientos con campo { match, confianza }.
 */
export function matchearConGastos(movimientos, gastos, tarjetaId) {
  // Solo gastos de esa tarjeta y no borrados
  const candidatos = gastos.filter(g => g.tarjeta_id === tarjetaId && !g.deleted);

  return movimientos.map(mov => {
    let mejorScore = 0;
    let mejorGasto = null;

    for (const g of candidatos) {
      let score = 0;

      // Fecha exacta
      if (g.fecha === mov.fecha) score += 0.5;

      // Monto exacto (tolerancia de ±1 peso para redondeos)
      if (Math.abs(g.monto - mov.monto) <= 1) score += 0.4;

      // Descripción similar
      const sim = similitud(g.descripcion, mov.descripcion);
      score += sim * 0.1;

      if (score > mejorScore) {
        mejorScore = score;
        mejorGasto = g;
      }
    }

    let confianza;
    if (mejorScore >= 0.7) {
      confianza = 'exacto';
    } else if (mejorScore >= 0.3) {
      confianza = 'probable';
    } else {
      confianza = 'no_encontrado';
      mejorGasto = null;
    }

    return { ...mov, match: mejorGasto, confianza, _score: mejorScore };
  });
}
