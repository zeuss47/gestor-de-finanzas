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

/** Mediana: robusta a meses atípicos (bonos, compras grandes one-shot). */
function mediana(xs) {
  if (!xs || xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
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

/**
 * Monto de un ingreso. Los registros de ingreso NO tienen campo `monto`:
 * guardan `sueldo_neto` (+ `bonos`). En toda la app el ingreso vale
 * `sueldo_neto + bonos`; acá debe ser igual (antes leía `i.monto` → 0 → la
 * proyección ignoraba TODOS los ingresos y daba saldos/alertas erróneos).
 */
function montoIngreso(i) {
  if (!i) return 0;
  if (typeof i.monto === 'number') return i.monto;   // compat por si algún día existe
  return (Number(i.sueldo_neto) || 0) + (Number(i.bonos) || 0);
}

/** Cotización ARS de un gasto en moneda extranjera (1 si es ARS). */
function cotizGasto(g) {
  if (!g || !g.moneda || g.moneda === 'ARS') return 1;
  const c = Number(g.cotizacion_al_pagar) || Number(g.cotizacion_referencia) || 0;
  return c > 0 ? c : 1;
}

/** Monto efectivo del gasto en ARS: convierte moneda, respeta compartido y amortizaciones. */
function montoEfectivo(g) {
  let m = (Number(g.monto) || 0) * cotizGasto(g);   // ← convierte USD/EUR/BRL a ARS
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
export function proyectarBalance({ gastos = [], ingresos = [], cuentas = [], tarjetas = [], cuotasPendientes = [], horizonte = 90 } = {}) {
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
    ingresosAcum += montoIngreso(i);
  }

  // Cuántas cuotas YA se facturaron por gasto (para no contar el total de golpe).
  // Las cuotas FUTURAS se inyectan aparte en `egresoExtraPorMes` (más abajo);
  // contar acá el monto FULL las duplicaba → proyección demasiado pesimista.
  const cuotasPagadasPorGasto = new Map();
  for (const c of (cuotasPendientes || [])) {
    if (c && c.gasto_id) cuotasPagadasPorGasto.set(c.gasto_id, c);
  }

  let gastosAcum = 0;            // gastos liquidos (sin tarjeta) ya impactados
  let resumenesPendientes = 0;   // gastos con tarjeta pendientes de pago
  for (const g of gastos) {
    if (g.deleted) continue;
    if (!g.fecha || g.fecha > hoy) continue;
    let m;
    if (g.tipo === 'cuotas' && g.cuotas_total > 0) {
      // Solo las cuotas YA facturadas (no el total). El resto va a egresoExtraPorMes.
      const info = cuotasPagadasPorGasto.get(g.id);
      const facturadas = info ? Math.max(0, info.cuotas_pagadas) : g.cuotas_total; // sin pendientes ⇒ todas pagadas
      m = (montoEfectivo(g) / g.cuotas_total) * facturadas;
    } else {
      m = montoEfectivo(g);
    }
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
    ingresosMes.set(mk, (ingresosMes.get(mk) || 0) + montoIngreso(i));
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
  // Usar SOLO los meses con actividad real: los meses vacíos (sin ingresos ni
  // gastos) inflaban falsamente la pendiente y disparaban la proyección.
  const flujosConDatos = mesesSerie
    .filter(m => (ingresosMes.get(m) || 0) > 0 || (gastosMes.get(m) || 0) > 0)
    .map(m => (ingresosMes.get(m) || 0) - (gastosMes.get(m) || 0));
  const serieFlujo = flujosConDatos.length >= 2 ? flujosConDatos : flujosMensuales;
  // pendiente: cuanto cambia el flujo mensual mes-a-mes
  const { pendiente: tendenciaMensual, intercepto } = regresion(serieFlujo);
  // baseline: MEDIANA del flujo mensual → robusta a meses atípicos (un bono o
  // una compra grande no distorsionan la proyección, a diferencia del promedio).
  const flujoBase = mediana(serieFlujo);
  const sigmaMes = stdev(serieFlujo);
  const muMes = mean(serieFlujo);

  /* ---------- Cuotas futuras comprometidas (no están en el histórico mensual
     porque la compra en cuotas se registró de una vez). Se inyectan mes a mes
     para que la proyección "escalone" cuando entra/sale una cuota. ---------- */
  const egresoExtraPorMes = new Map();  // YYYY-MM -> monto de cuotas ese mes
  for (const c of (cuotasPendientes || [])) {
    if (!c || (c.cuotas_pendientes || 0) <= 0 || !(c.monto_cuota > 0)) continue;
    const inicio = (typeof c.proxima_cuota_periodo === 'string' && c.proxima_cuota_periodo.length >= 7)
      ? c.proxima_cuota_periodo.slice(0, 7) : mesActual;
    for (let k = 0; k < c.cuotas_pendientes; k++) {
      const mk = shiftMonth(inicio, k);
      egresoExtraPorMes.set(mk, (egresoExtraPorMes.get(mk) || 0) + c.monto_cuota);
    }
  }

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
    // Cuotas comprometidas que caen en el mes de este día, prorrateadas.
    const mesDia = addDays(hoy, d).slice(0, 7);
    const cuotaDia = (egresoExtraPorMes.get(mesDia) || 0) / 30;
    // Tendencia ACOTADA: extrapolamos el cambio de ritmo a lo sumo ~30 días y
    // luego lo mantenemos constante (no extrapolar un trend mensual de forma
    // cuadrática a 90 días → era la mayor fuente de imprecisión).
    const flujoDia = flujoDiarioBase + tendenciaDiaria * Math.min(d, 30);
    saldosBuf[d] = saldosBuf[d - 1] + flujoDia - cuotaDia;
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
export function predecirSaturacionTarjetas({ gastos = [], tarjetas = [], resumenes = [], cuotasPendientes = [] } = {}) {
  const hoy = hoyISO();
  const hace30 = addDays(hoy, -30);
  const hace90 = addDays(hoy, -90);

  // Ritmo de consumo por tarjeta en ventanas de 30 y 90 días.
  const sum30 = new Map(), sum90 = new Map();
  for (const g of gastos) {
    if (g.deleted || !g.tarjeta_id || !g.fecha) continue;
    if (g.fecha > hoy) continue;
    // Las compras EN CUOTAS NO entran al ritmo: se contarían al monto FULL
    // (inflando la tasa) y además ya se suman aparte como cuotaMensual/30.
    if (g.tipo === 'cuotas') continue;
    const m = montoEfectivo(g);
    if (g.fecha >= hace90) sum90.set(g.tarjeta_id, (sum90.get(g.tarjeta_id) || 0) + m);
    if (g.fecha >= hace30) sum30.set(g.tarjeta_id, (sum30.get(g.tarjeta_id) || 0) + m);
  }

  // Resumen actual real (campo total_resumen) por tarjeta.
  const resumenPorTarjeta = new Map();
  for (const r of resumenes) {
    if (!r || !r.tarjeta_id) continue;
    const total = Number(r.total_resumen ?? r.total ?? r.total_periodo ?? r.monto ?? 0) || 0;
    resumenPorTarjeta.set(r.tarjeta_id, (resumenPorTarjeta.get(r.tarjeta_id) || 0) + total);
  }

  // Cuota mensual comprometida por tarjeta (consumo que cae igual cada mes).
  const cuotaMensual = new Map();
  for (const c of (cuotasPendientes || [])) {
    if (!c || !c.tarjeta_id || (c.cuotas_pendientes || 0) <= 0) continue;
    cuotaMensual.set(c.tarjeta_id, (cuotaMensual.get(c.tarjeta_id) || 0) + (c.monto_cuota || 0));
  }

  const out = [];
  for (const t of tarjetas) {
    if (t.deleted) continue;
    const limiteTotal = (Number(t.limite_un_pago) || 0) + (Number(t.limite_cuotas) || 0);
    const base = resumenPorTarjeta.get(t.id) || 0;             // ya consumido
    // Ritmo diario ponderado a lo reciente (más peso a 30d).
    const r30 = (sum30.get(t.id) || 0) / 30;
    const r90 = (sum90.get(t.id) || 0) / 90;
    const ritmoDiario = 0.6 * r30 + 0.4 * r90;
    const cuotasMes = cuotaMensual.get(t.id) || 0;
    // Consumo efectivo por día = ritmo de compras nuevas + prorrateo de cuotas.
    const ritmoEfectivo = ritmoDiario + cuotasMes / 30;

    if (limiteTotal <= 0) {
      out.push({ tarjeta_id: t.id, tarjeta_nombre: t.nombre, dias_para_50: null, dias_para_80: null,
        dias_para_100: null, ritmo_diario: r2(ritmoDiario), alerta: null,
        porcentaje_actual: null, margen_disponible: null, consumo_proyectado_30d: null,
        saturacion_fin_ciclo_pct: null, cuotas_mensuales: r2(cuotasMes), ritmo_efectivo: r2(ritmoEfectivo) });
      continue;
    }

    // días hasta % del límite considerando consumo nuevo + cuotas comprometidas.
    const diasParaPct = (pct) => {
      if (ritmoEfectivo <= 0) return null;
      const restante = limiteTotal * pct - base;
      if (restante <= 0) return 0;
      return Math.round(restante / ritmoEfectivo);
    };
    const d50 = diasParaPct(0.50), d80 = diasParaPct(0.80), d100 = diasParaPct(1.00);

    const pctActual = (base / limiteTotal) * 100;
    const consumo30 = base + ritmoEfectivo * 30;
    const satFinCiclo = (consumo30 / limiteTotal) * 100;

    let alerta = null;
    if (d100 != null && d100 < 30) alerta = 'Saturación inminente';
    else if (d80 != null && d80 < 15) alerta = 'Acercándose al límite';
    else if (satFinCiclo >= 90) alerta = 'Cierre del ciclo casi al tope';

    out.push({
      tarjeta_id: t.id, tarjeta_nombre: t.nombre,
      dias_para_50: d50, dias_para_80: d80, dias_para_100: d100,
      ritmo_diario: r2(ritmoDiario),
      ritmo_efectivo: r2(ritmoEfectivo),
      cuotas_mensuales: r2(cuotasMes),
      porcentaje_actual: r2(pctActual),
      margen_disponible: r2(limiteTotal - base),
      consumo_proyectado_30d: r2(consumo30),
      saturacion_fin_ciclo_pct: r2(satFinCiclo),
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
/**
 * Estima, para cada meta activa, en cuántos MESES se completa según el flujo
 * real (margen libre repartido por prioridad). Determinista.
 * @param {Array}  metas       state.metas
 * @param {number} margenLibre margen mensual ya neto de cuotas (ver app.js)
 * @returns {Map} meta.id -> { aporteMensual, mesesRestantes, fechaEstimada, alcanzable }
 *
 * Fórmula: aporte = margenLibre · (prioridad / Σprioridades);
 *          meses  = ⌈(objetivo − actual) / aporte⌉.
 * Recalcular es automático: al agregar una meta o generarse una cuota nueva
 * (que baja el margen), reloadAll() vuelve a llamar a esta función.
 */
export function estimarMesesMeta(metas = [], margenLibre = 0) {
  const activas = (metas || []).filter(m => !m.deleted && (m.monto_objetivo || 0) > (m.monto_actual || 0));
  const pesos = activas.map(m => m.prioridad || 3);
  const suma = pesos.reduce((a, b) => a + b, 0) || 1;
  const margen = Math.max(0, margenLibre || 0);
  const mesActual = hoyISO().slice(0, 7);
  const out = new Map();
  activas.forEach((m, i) => {
    const aporte = margen * (pesos[i] / suma);
    const falta = (m.monto_objetivo || 0) - (m.monto_actual || 0);
    const meses = aporte > 0 ? Math.ceil(falta / aporte) : Infinity;
    out.set(m.id, {
      aporteMensual: aporte,
      mesesRestantes: meses,
      fechaEstimada: aporte > 0 ? shiftMonth(mesActual, meses) : null,
      alcanzable: aporte > 0 && isFinite(meses),
    });
  });
  return out;
}

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
