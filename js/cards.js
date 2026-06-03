/**
 * cards.js
 * --------
 * Motor de ciclos de tarjeta REPLICADO en cliente para que el dashboard
 * funcione 100% offline. Esta lógica debe mantenerse en sincronía bit-a-bit
 * con main.py (funciones calcular_fechas_ciclo / cuota_cae_en_periodo /
 * resumen_tarjeta).
 *
 * Por qué duplicar:
 *   - Filosofía "offline-first": el frontend no puede depender del backend.
 *   - El backend Python existe sólo como motor de cálculo opcional y relé
 *     de sincronización (útil para CI/cron headless o despliegues remotos).
 */

/* ============ Helpers de fecha ============ */
function ultimoDiaMes(anio, mes) {
  return new Date(anio, mes, 0).getDate(); // mes 1-12 -> day 0 del siguiente
}
function ajustarDia(anio, mes, dia) {
  const dd = Math.min(dia, ultimoDiaMes(anio, mes));
  return new Date(anio, mes - 1, dd);
}
function mesSig(anio, mes) {
  return mes === 12 ? [anio + 1, 1] : [anio, mes + 1];
}
function diasEntre(a, b) {
  const MS = 86400000;
  return Math.round((b.getTime() - a.getTime()) / MS);
}
function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/* ============ Cálculo de cierre/vencimiento ============
 * La tarjeta puede tener:
 *  - dia_cierre / dia_vencimiento (regla por defecto, mismo día cada mes)
 *  - ciclos_custom: [{ periodo: 'YYYY-MM', inicio, fin, vencimiento }]
 *    cuando el banco anuncia fechas distintas (feriados, cambios), agregás
 *    un override y el motor usa esas fechas exactas para ese período.
 */
export function fechasCiclo(tarjeta, hoy = new Date()) {
  // 1. ¿Hay un ciclo custom que contenga hoy?
  const custom = (tarjeta.ciclos_custom || []).find(c => {
    if (!c.inicio || !c.fin) return false;
    const d = hoy.toISOString().slice(0,10);
    return c.inicio <= d && d <= c.fin;
  });
  if (custom) {
    const cierre = new Date(custom.fin + 'T12:00:00');
    const venc   = custom.vencimiento
      ? new Date(custom.vencimiento + 'T12:00:00')
      : ajustarDia(cierre.getFullYear(), cierre.getMonth() + 1, tarjeta.dia_vencimiento || cierre.getDate());
    return {
      cierre,
      vencimiento: venc,
      periodo: custom.periodo || `${cierre.getFullYear()}-${String(cierre.getMonth() + 1).padStart(2, '0')}`,
      diasParaCierre: diasEntre(hoy, cierre),
      diasParaVencimiento: diasEntre(hoy, venc),
      esCustom: true,
    };
  }

  // 2. Regla por día fijo
  const Y = hoy.getFullYear(), M = hoy.getMonth() + 1, D = hoy.getDate();
  let cierre;
  if (D <= tarjeta.dia_cierre) {
    cierre = ajustarDia(Y, M, tarjeta.dia_cierre);
  } else {
    const [ay, am] = mesSig(Y, M);
    cierre = ajustarDia(ay, am, tarjeta.dia_cierre);
  }
  let venc;
  if (tarjeta.dia_vencimiento > tarjeta.dia_cierre) {
    venc = ajustarDia(cierre.getFullYear(), cierre.getMonth() + 1, tarjeta.dia_vencimiento);
  } else {
    const [vy, vm] = mesSig(cierre.getFullYear(), cierre.getMonth() + 1);
    venc = ajustarDia(vy, vm, tarjeta.dia_vencimiento);
  }
  return {
    cierre,
    vencimiento: venc,
    periodo: `${cierre.getFullYear()}-${String(cierre.getMonth() + 1).padStart(2, '0')}`,
    diasParaCierre: diasEntre(hoy, cierre),
    diasParaVencimiento: diasEntre(hoy, venc),
    esCustom: false,
  };
}

/* ============ ¿La compra cae en este período de cierre? ============ */
export function cuotaEnPeriodo(fechaCompra, tarjeta, periodoY, periodoM) {
  // 1. Si hay un ciclo custom que contenga esta fecha de compra → usar ese período
  const custom = (tarjeta.ciclos_custom || []).find(c => {
    if (!c.inicio || !c.fin) return false;
    return c.inicio <= fechaCompra && fechaCompra <= c.fin;
  });
  if (custom && custom.periodo) {
    const [cy, cm] = custom.periodo.split('-').map(Number);
    return cy === periodoY && cm === periodoM;
  }

  // 2. Regla por día fijo
  const fc = new Date(fechaCompra + 'T00:00:00');
  let baseY, baseM;
  if (fc.getDate() <= tarjeta.dia_cierre) {
    baseY = fc.getFullYear();
    baseM = fc.getMonth() + 1;
  } else {
    [baseY, baseM] = mesSig(fc.getFullYear(), fc.getMonth() + 1);
  }
  return baseY === periodoY && baseM === periodoM;
}

/* ============ Resumen del próximo cierre ============ */
export function resumenTarjeta(tarjeta, gastos, hoy = new Date()) {
  const { cierre, vencimiento, periodo, diasParaCierre, diasParaVencimiento } =
    fechasCiclo(tarjeta, hoy);
  const py = cierre.getFullYear();
  const pm = cierre.getMonth() + 1;

  // Totales en ARS (moneda local)
  let unPago = 0, cuotasSum = 0, recurr = 0;
  // Por moneda extranjera: { USD: 250, EUR: 80, ... }
  const monedasExtra = {};   // monto NOMINAL en moneda extranjera
  const monedasARS   = {};   // monto convertido a ARS con cotización del gasto
  const ids = [];

  // Cotización a usar para convertir USD/EUR/BRL a ARS:
  // - Si el gasto tiene `cotizacion_al_pagar` (cierre ya hecho) → usar esa
  // - Sino, usar `cotizacion_referencia` (la del momento de la compra)
  // - Si ninguna existe, marcar como "pendiente"
  const acumular = (g, monto) => {
    const moneda = g.moneda || 'ARS';
    if (moneda === 'ARS') return monto;
    monedasExtra[moneda] = (monedasExtra[moneda] || 0) + monto;
    const cotiz = g.cotizacion_al_pagar || g.cotizacion_referencia || 0;
    if (cotiz > 0) {
      const ars = monto * cotiz;
      monedasARS[moneda] = (monedasARS[moneda] || 0) + ars;
      return ars;
    }
    return 0; // sin cotización: no podemos contarlo en ARS todavía
  };

  for (const g of gastos) {
    if (g.deleted || g.tarjeta_id !== tarjeta.id) continue;

    if (g.tipo === 'recurrente') {
      recurr += acumular(g, g.monto);
      ids.push(g.id);
      continue;
    }
    if (g.tipo === 'unico') {
      if (cuotaEnPeriodo(g.fecha, tarjeta, py, pm)) {
        unPago += acumular(g, g.monto);
        ids.push(g.id);
      }
      continue;
    }
    if (g.tipo === 'cuotas' && g.cuotas_total > 0) {
      const fc = new Date(g.fecha + 'T00:00:00');
      let baseY, baseM;
      if (fc.getDate() <= tarjeta.dia_cierre) {
        baseY = fc.getFullYear();
        baseM = fc.getMonth() + 1;
      } else {
        [baseY, baseM] = mesSig(fc.getFullYear(), fc.getMonth() + 1);
      }
      const dist = (py - baseY) * 12 + (pm - baseM);
      const nCuota = dist + 1;
      if (nCuota >= 1 && nCuota <= g.cuotas_total) {
        cuotasSum += acumular(g, g.monto / g.cuotas_total);
        ids.push(g.id);
      }
    }
  }

  const total = unPago + cuotasSum + recurr;
  const limite = (tarjeta.limite_un_pago || 0) + (tarjeta.limite_cuotas || 0) || 1;

  // ¿Hay gastos USD pendientes de cierre? (sin cotización_al_pagar)
  const pendientesPorCerrar = gastos.filter(g =>
    !g.deleted &&
    g.tarjeta_id === tarjeta.id &&
    g.moneda && g.moneda !== 'ARS' &&
    !g.cotizacion_al_pagar &&
    cuotaEnPeriodo(g.fecha, tarjeta, py, pm)
  );

  return {
    tarjeta_id: tarjeta.id,
    tarjeta_nombre: tarjeta.nombre,
    periodo,
    fecha_cierre: toISO(cierre),
    fecha_vencimiento: toISO(vencimiento),
    dias_para_cierre: diasParaCierre,
    dias_para_vencimiento: diasParaVencimiento,
    total_un_pago: round2(unPago),
    total_cuotas: round2(cuotasSum),
    total_recurrentes: round2(recurr),
    total_resumen: round2(total),
    porcentaje_limite_usado: round2((100 * total) / limite),
    movimientos_ids: ids,
    // Multi-moneda
    monedas_extranjeras: monedasExtra,    // { USD: 250, EUR: 80 }
    monedas_extranjeras_ars: monedasARS,  // { USD: 362500, EUR: 96000 } (con cotización aplicada)
    pendientes_cierre_usd: pendientesPorCerrar.length, // cantidad de gastos USD sin cotización al pagar
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

/* ============ Helpers de ciclo expuestos para la UI ============ */

/**
 * Devuelve el primer día del ciclo actual (día siguiente al cierre anterior).
 * Ejemplo: cierre día 25 → si hoy es 5/may → inicio ciclo = 26/abr → cierre = 25/may
 */
export function inicioCicloActual(tarjeta, hoy = new Date()) {
  const { cierre } = fechasCiclo(tarjeta, hoy);
  // El ciclo actual empieza el día siguiente al cierre del MES ANTERIOR.
  const cierreAnterior = new Date(cierre);
  cierreAnterior.setMonth(cierreAnterior.getMonth() - 1);
  const ajustado = ajustarDia(cierreAnterior.getFullYear(), cierreAnterior.getMonth() + 1, tarjeta.dia_cierre);
  // Día siguiente
  const inicio = new Date(ajustado);
  inicio.setDate(inicio.getDate() + 1);
  return inicio;
}

/**
 * Dado un gasto con fecha + tarjeta, devuelve a qué ciclo de cierre cae
 * y cuándo se paga ese ciclo. Útil para mostrar feedback en el form de gasto.
 *
 * @returns {{
 *   cierre: Date,        // fecha de cierre del resumen donde cae este gasto
 *   vencimiento: Date,   // fecha de vencimiento (pago)
 *   periodo: string,     // 'YYYY-MM' del resumen
 *   esCicloActual: boolean,
 *   mensaje: string,     // descripción legible para el usuario
 * }}
 */
export function cicloDelGasto(fechaCompraISO, tarjeta, hoy = new Date()) {
  const fc = new Date(fechaCompraISO + 'T12:00:00');
  // ¿En qué cierre cae?
  let cierreY, cierreM;
  if (fc.getDate() <= tarjeta.dia_cierre) {
    cierreY = fc.getFullYear();
    cierreM = fc.getMonth() + 1;
  } else {
    [cierreY, cierreM] = mesSig(fc.getFullYear(), fc.getMonth() + 1);
  }
  const cierre = ajustarDia(cierreY, cierreM, tarjeta.dia_cierre);

  // Vencimiento del resumen
  let venc;
  if (tarjeta.dia_vencimiento > tarjeta.dia_cierre) {
    venc = ajustarDia(cierreY, cierreM, tarjeta.dia_vencimiento);
  } else {
    const [vy, vm] = mesSig(cierreY, cierreM);
    venc = ajustarDia(vy, vm, tarjeta.dia_vencimiento);
  }

  const cicloActual = fechasCiclo(tarjeta, hoy);
  const periodo = `${cierreY}-${String(cierreM).padStart(2, '0')}`;
  const esCicloActual = periodo === cicloActual.periodo;

  const mesNombres = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const mensaje = `Cierra el ${cierre.getDate()} de ${mesNombres[cierre.getMonth()]} · Se paga el ${venc.getDate()} de ${mesNombres[venc.getMonth()]}`;

  return { cierre, vencimiento: venc, periodo, esCicloActual, mensaje };
}

/**
 * Rango del ciclo actual: { inicio, fin } como strings ISO.
 * Útil para mostrar "Gastos del 26/abr al 25/may" en el widget de tarjeta.
 */
export function rangoCicloActual(tarjeta, hoy = new Date()) {
  const inicio = inicioCicloActual(tarjeta, hoy);
  const { cierre } = fechasCiclo(tarjeta, hoy);
  return { inicio, fin: cierre };
}

/**
 * Estado de un ciclo según su fecha de cierre, vencimiento y si está pagado.
 * Cumple la clasificación del módulo de ingesta:
 *   - 'abierto'             → todavía no cerró (se siguen sumando consumos)
 *   - 'cerrado_pendiente'   → cerró pero aún no venció y no se pagó
 *   - 'vencido'             → pasó el vencimiento sin pago registrado
 *   - 'pagado'             → marcado como pagado
 *
 * @param {{fechaCierre?:string, fechaVencimiento?:string, cierre?:Date,
 *          vencimiento?:Date, pagado?:boolean, hoy?:Date}} args  fechas ISO o Date
 * @returns {{estado, etiqueta, diasParaCierre, diasParaVencimiento}}
 */
export function estadoCiclo({ fechaCierre, fechaVencimiento, cierre, vencimiento, pagado = false, hoy = new Date() }) {
  const cierreISO = fechaCierre || (cierre ? toISO(cierre) : '');
  const vencISO   = fechaVencimiento || (vencimiento ? toISO(vencimiento) : '');
  const hoyISO    = toISO(hoy);

  let estado, etiqueta;
  if (pagado) {
    estado = 'pagado';            etiqueta = 'Pagado';
  } else if (cierreISO && hoyISO <= cierreISO) {
    estado = 'abierto';           etiqueta = 'Abierto';
  } else if (vencISO && hoyISO <= vencISO) {
    estado = 'cerrado_pendiente'; etiqueta = 'Cerrado - Pendiente de pago';
  } else {
    estado = 'vencido';           etiqueta = 'Vencido';
  }

  const aDate = (iso) => iso ? new Date(iso + 'T12:00:00') : null;
  const hoyD = aDate(hoyISO);
  return {
    estado,
    etiqueta,
    diasParaCierre:      cierreISO ? diasEntre(hoyD, aDate(cierreISO)) : null,
    diasParaVencimiento: vencISO   ? diasEntre(hoyD, aDate(vencISO))   : null,
  };
}
