/**
 * ai-predict.js
 * -------------
 * Motor de PREDICCION local en cliente. Complementa a ai-local.js (que
 * diagnostica el pasado) prediciendo el futuro: balance proyectado,
 * saturacion de tarjetas y sugerencia de categoria para descripciones nuevas.
 *
 * 100% offline. Sin dependencias externas. Sin fetch. Sin imports.
 *
 * Tecnicas:
 *   - Regresion lineal por minimos cuadrados sobre flujo neto mensual.
 *   - Promedio movil ponderado (mas peso a meses recientes) como baseline.
 *   - Desviacion estandar -> intervalo de confianza (mu +/- 1.5 sigma).
 *   - Similitud por tokens normalizados (sin acentos) para categorizacion.
 *
 * Complejidad: O(n + m) donde n=gastos+ingresos, m=puntos_proyectados.
 */

/* ============================================================
 *                       HELPERS INTERNOS
 * ============================================================ */

/** Promedio aritmetico. Devuelve 0 si la serie esta vacia. */
function mean(xs) {
  if (!xs || xs.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

/** Desviacion estandar poblacional. Devuelve 0 si <2 elementos. */
function stdev(xs) {
  if (!xs || xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / xs.length);
}

/**
 * Regresion lineal por minimos cuadrados.
 * Modelo: y = pendiente * x + intercepto, x = indice de la serie.
 * Formula: pendiente = (n*Sxy - Sx*Sy) / (n*Sxx - Sx^2)
 */
function regresion(xs) {
  const n = xs.length;
  if (n < 2) return { pendiente: 0, intercepto: n ? xs[0] : 0 };
  let Sx = 0, Sy = 0, Sxy = 0, Sxx = 0;
  for (let i = 0; i < n; i++) {
    Sx += i;
    Sy += xs[i];
    Sxy += i * xs[i];
    Sxx += i * i;
  }
  const denom = n * Sxx - Sx * Sx;
  if (denom === 0) return { pendiente: 0, intercepto: Sy / n };
  const pendiente = (n * Sxy - Sx * Sy) / denom;
  const intercepto = (Sy - pendiente * Sx) / n;
  return { pendiente, intercepto };
}

/**
 * Promedio movil ponderado: peso(i) = i+1 (mas peso a los recientes).
 * Suma de pesos = n*(n+1)/2.
 */
function promedioPonderado(xs) {
  if (!xs || xs.length === 0) return 0;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = i + 1;
    num += xs[i] * w;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

/** Quita acentos, baja a minusculas, deja [a-z0-9 ]. */
function normalizar(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokeniza eliminando stopwords cortas. */
function tokenizar(s) {
  const norm = normalizar(s);
  if (!norm) return [];
  return norm.split(' ').filter(t => t.length >= 2);
}

/** Clave YYYY-MM desde fecha ISO. */
function monthKey(iso) {
  return iso ? iso.slice(0, 7) : '';
}

/** Suma de meses a una fecha YYYY-MM. */
function shiftMonth(ymd, deltaMeses) {
  const [y, m] = ymd.split('-').map(Number);
  const total = y * 12 + (m - 1) + deltaMeses;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/** Hoy en YYYY-MM-DD (hora local). */
function hoyISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Suma N dias a una fecha YYYY-MM-DD. */
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Monto efectivo del gasto: respeta compartido y amortizaciones. */
function montoEfectivo(g) {
  let m = Number(g.monto) || 0;
  if (g.compartido && typeof g.compartido.porcentaje_otro === 'number') {
    m = m * (1 - g.compartido.porcentaje_otro / 100);
  }
  if (g.tipo === 'amortizacion' || g.es_amortizacion_anual) m = m / 12;
  return m;
}

/** Redondea a 2 decimales. */
function r2(x) { return Math.round(x * 100) / 100; }

/* ============================================================
 *                  1. PROYECCION DE BALANCE
 * ============================================================ */

/**
 * Proyecta saldo total a futuro usando regresion + tendencia.
 */
export function proyectarBalance({ gastos = [], ingresos = [], cuentas = [], tarjetas = [], horizonte = 90 } = {}) {
  const hoy = hoyISO();
  const horizDias = Math.max(1, Math.min(365, Number(horizonte) || 90));

  /* ---------- Saldo actual: cuentas + ingresos - gastos - resumenes ---------- */
  let saldoCuentas = 0;
  for (const c of cuentas) {
    if (c.deleted) continue;
    saldoCuentas += Number(c.saldo_inicial) || 0;
  }

  let ingresosAcum = 0;
  for (const i of ingresos) {
    if (i.deleted) continue;
    if (!i.fecha || i.fecha > hoy) continue;
    ingresosAcum += Number(i.monto) || 0;
  }

  let gastosAcum = 0;            // gastos liquidos (sin tarjeta) ya impactados
  let resumenesPendientes = 0;   // gastos con tarjeta pendientes de pago
  for (const g of gastos) {
    if (g.deleted) continue;
    if (!g.fecha || g.fecha > hoy) continue;
    const m = montoEfectivo(g);
    if (g.tarjeta_id) resumenesPendientes += m;
    else gastosAcum += m;
  }

  const saldoActual = saldoCuentas + ingresosAcum - gastosAcum - resumenesPendientes;

  /* ---------- Serie mensual de flujo neto (ult 6 meses) ---------- */
  const ingresosMes = new Map(); // YYYY-MM -> monto
  const gastosMes = new Map();
  for (const i of ingresos) {
    if (i.deleted || !i.fecha) continue;
    const mk = monthKey(i.fecha);
    ingresosMes.set(mk, (ingresosMes.get(mk) || 0) + (Number(i.monto) || 0));
  }
  for (const g of gastos) {
    if (g.deleted || !g.fecha) continue;
    const mk = monthKey(g.fecha);
    gastosMes.set(mk, (gastosMes.get(mk) || 0) + montoEfectivo(g));
  }

  // Determinar 6 ultimos meses incluyendo el actual
  const mesActual = hoy.slice(0, 7);
  const mesesSerie = [];
  for (let k = 5; k >= 0; k--) mesesSerie.push(shiftMonth(mesActual, -k));

  const flujosMensuales = mesesSerie.map(m =>
    (ingresosMes.get(m) || 0) - (gastosMes.get(m) || 0)
  );

  // Cantidad de meses con actividad real (algun dato distinto de 0)
  const mesesConDatos = mesesSerie.filter(m =>
    (ingresosMes.get(m) || 0) > 0 || (gastosMes.get(m) || 0) > 0
  ).length;

  /* ---------- Regresion + baseline + dispersion ---------- */
  // pendiente: cuanto cambia el flujo mensual mes-a-mes
  const { pendiente: tendenciaMensual, intercepto } = regresion(flujosMensuales);
  // baseline: promedio ponderado (mas peso a los meses recientes)
  const flujoBase = promedioPonderado(flujosMensuales);
  const sigmaMes = stdev(flujosMensuales);
  const muMes = mean(flujosMensuales);

  // Para confianza: desvio relativo respecto al promedio absoluto del egreso
  const promGastoMes = mean(mesesSerie.map(m => gastosMes.get(m) || 0));
  const promIngresoMes = mean(mesesSerie.map(m => ingresosMes.get(m) || 0));
  const denomDispersion = Math.max(Math.abs(promGastoMes), Math.abs(promIngresoMes), 1);
  const dispersionRel = sigmaMes / denomDispersion;

  let confianza;
  if (mesesConDatos >= 6 && dispersionRel < 0.30)      confianza = 'alta';
  else if (mesesConDatos >= 3 && dispersionRel < 0.60) confianza = 'media';
  else                                                  confianza = 'baja';

  /* ---------- Generar puntos dia a dia ---------- */
  // Flujo diario base = baseline mensual / 30 (gruesa pero suficiente)
  const flujoDiarioBase = flujoBase / 30;
  // Tendencia diaria: pendiente mensual proyecta el mes siguiente, dividido por 30
  const tendenciaDiaria = tendenciaMensual / 30;
  // Banda de incertidumbre: crece con sqrt(t) como en random walk financiero
  const sigmaDiario = sigmaMes / Math.sqrt(30);

  const puntos = new Array(horizDias + 1);
  // TypedArray para acumular saldo (mas rapido que array normal en loops grandes)
  const saldosBuf = new Float64Array(horizDias + 1);
  saldosBuf[0] = saldoActual;

  for (let d = 1; d <= horizDias; d++) {
    // saldo(t) = saldo(t-1) + flujoBase + tendencia*t  (tendencia integrada)
    saldosBuf[d] = saldosBuf[d - 1] + flujoDiarioBase + tendenciaDiaria * d;
  }

  let primerDiaNegativo = -1;
  for (let d = 0; d <= horizDias; d++) {
    const fecha = d === 0 ? hoy : addDays(hoy, d);
    // Banda crece con sqrt(t): la incertidumbre se acumula como random walk
    const banda = 1.5 * sigmaDiario * Math.sqrt(d);
    const saldo = r2(saldosBuf[d]);
    puntos[d] = {
      fecha,
      saldo,
      intervalo_inf: r2(saldosBuf[d] - banda),
      intervalo_sup: r2(saldosBuf[d] + banda),
    };
    if (primerDiaNegativo === -1 && saldosBuf[d] < 0) primerDiaNegativo = d;
  }

  const saldoProyectado = puntos[horizDias].saldo;
  const tendenciaMensualRedondeada = r2(tendenciaMensual);

  /* ---------- Alertas ---------- */
  const alertas = [];

  if (primerDiaNegativo > 0) {
    alertas.push({
      tipo: 'saldo_negativo',
      mensaje: `Riesgo de saldo negativo en ${primerDiaNegativo} dias`,
      severidad: primerDiaNegativo < 30 ? 'critical' : 'warning',
    });
  }

  // Tendencia decreciente significativa: pendiente < 0 y |pendiente| > 5% ingreso mensual
  if (tendenciaMensual < 0 && promIngresoMes > 0 &&
      Math.abs(tendenciaMensual) > 0.05 * promIngresoMes) {
    alertas.push({
      tipo: 'tendencia_decreciente',
      mensaje: `Tendencia decreciente: perdes ~${Math.abs(r2(tendenciaMensual))} por mes`,
      severidad: 'warning',
    });
  }

  // Reserva critica: saldo proyectado < 20% del ingreso mensual promedio
  if (promIngresoMes > 0 && saldoProyectado < 0.20 * promIngresoMes && saldoProyectado >= 0) {
    alertas.push({
      tipo: 'reserva_critica',
      mensaje: 'Reserva critica: saldo proyectado bajo umbral de seguridad',
      severidad: 'warning',
    });
  }

  return {
    puntos,
    saldo_actual: r2(saldoActual),
    saldo_proyectado: saldoProyectado,
    tendencia_mensual: tendenciaMensualRedondeada,
    confianza,
    alertas,
  };
}

/* ============================================================
 *               2. SATURACION DE TARJETAS
 * ============================================================ */

/**
 * Predice cuando cada tarjeta llegara a 50/80/100% del limite segun ritmo
 * de gasto de los ultimos 90 dias.
 */
export function predecirSaturacionTarjetas({ gastos = [], tarjetas = [], resumenes = [] } = {}) {
  const hoy = hoyISO();
  const hace90 = addDays(hoy, -90);

  // Indexar gastos por tarjeta_id en los ultimos 90 dias
  const sumPorTarjeta = new Map();
  for (const g of gastos) {
    if (g.deleted || !g.tarjeta_id || !g.fecha) continue;
    if (g.fecha < hace90 || g.fecha > hoy) continue;
    sumPorTarjeta.set(g.tarjeta_id,
      (sumPorTarjeta.get(g.tarjeta_id) || 0) + montoEfectivo(g));
  }

  // Indexar resumen actual por tarjeta
  const resumenPorTarjeta = new Map();
  for (const r of resumenes) {
    if (!r || !r.tarjeta_id) continue;
    const total = Number(r.total ?? r.total_periodo ?? r.monto ?? 0) || 0;
    resumenPorTarjeta.set(r.tarjeta_id, (resumenPorTarjeta.get(r.tarjeta_id) || 0) + total);
  }

  const out = [];
  for (const t of tarjetas) {
    if (t.deleted) continue;
    const sum90 = sumPorTarjeta.get(t.id) || 0;
    const ritmoDiario = sum90 / 90;
    const limiteTotal = (Number(t.limite_un_pago) || 0) + (Number(t.limite_cuotas) || 0);
    const resumenActual = resumenPorTarjeta.get(t.id) || 0;

    // Si no hay ritmo o no hay limite, no se puede proyectar
    if (ritmoDiario <= 0 || limiteTotal <= 0) {
      out.push({
        tarjeta_id: t.id,
        tarjeta_nombre: t.nombre,
        dias_para_50: null,
        dias_para_80: null,
        dias_para_100: null,
        ritmo_diario: r2(ritmoDiario),
        alerta: null,
      });
      continue;
    }

    // dias = (limite * pct - resumen_actual) / ritmo
    const calcDias = (pct) => {
      const objetivo = limiteTotal * pct;
      const restante = objetivo - resumenActual;
      if (restante <= 0) return 0;
      const d = restante / ritmoDiario;
      return d > 0 ? Math.round(d) : 0;
    };

    const d50 = calcDias(0.50);
    const d80 = calcDias(0.80);
    const d100 = calcDias(1.00);

    let alerta = null;
    if (d100 !== null && d100 < 30) alerta = 'Saturacion inminente';
    else if (d80 !== null && d80 < 15) alerta = 'Acercandose al limite';

    out.push({
      tarjeta_id: t.id,
      tarjeta_nombre: t.nombre,
      dias_para_50: d50,
      dias_para_80: d80,
      dias_para_100: d100,
      ritmo_diario: r2(ritmoDiario),
      alerta,
    });
  }

  return out;
}

/* ============================================================
 *              3. SUGERENCIA DE CATEGORIA
 * ============================================================ */

/**
 * Dado un texto de descripcion, sugiere la categoria mas probable segun
 * similitud con descripciones historicas.
 *
 * Estrategia:
 *   - Tokenizar descripcion entrante (sin acentos, lowercase).
 *   - Para cada gasto historico: contar tokens en comun ponderados por
 *     IDF aproximado (1/log(1+freq_global)).
 *   - Sumar score por categoria. Devolver la mejor.
 */
export function sugerirCategoria(descripcion, gastos = []) {
  const tokensIn = tokenizar(descripcion);
  if (tokensIn.length === 0) return null;
  if (!gastos || gastos.length === 0) return null;

  const setIn = new Set(tokensIn);

  // Frecuencia global de cada token (cuantos gastos lo contienen)
  // Util para penalizar palabras muy comunes ("compra", "pago").
  const freqGlobal = new Map();
  // Cache de tokens por gasto para no tokenizar dos veces
  const tokensPorGasto = new Array(gastos.length);

  for (let i = 0; i < gastos.length; i++) {
    const g = gastos[i];
    if (g.deleted || !g.descripcion || !g.categoria) { tokensPorGasto[i] = null; continue; }
    const toks = tokenizar(g.descripcion);
    tokensPorGasto[i] = toks;
    const uniq = new Set(toks);
    for (const t of uniq) freqGlobal.set(t, (freqGlobal.get(t) || 0) + 1);
  }

  // Score por categoria
  const scoreCat = new Map();
  for (let i = 0; i < gastos.length; i++) {
    const g = gastos[i];
    const toks = tokensPorGasto[i];
    if (!toks) continue;
    let score = 0;
    for (const t of toks) {
      if (setIn.has(t)) {
        // IDF aproximado: tokens raros pesan mas
        const fg = freqGlobal.get(t) || 1;
        score += 1 / Math.log(1 + fg + 1);
      }
    }
    if (score > 0) {
      scoreCat.set(g.categoria, (scoreCat.get(g.categoria) || 0) + score);
    }
  }

  if (scoreCat.size === 0) return null;

  let best = null, bestScore = -Infinity;
  for (const [cat, sc] of scoreCat) {
    if (sc > bestScore) { bestScore = sc; best = cat; }
  }
  return best;
}
