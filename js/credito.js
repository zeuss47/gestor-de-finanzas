/**
 * credito.js
 * ----------
 * Motor avanzado de capacidad crediticia: calcula el margen real disponible
 * para nuevos gastos con tarjeta considerando ingresos, gastos fijos,
 * cuotas pendientes ya comprometidas y resúmenes en curso.
 *
 * Permite además simular nuevas compras y validar si se pasan del límite.
 */

import { fechasCiclo, cuotaEnPeriodo } from './cards.js';

/**
 * Devuelve TODOS los gastos en cuotas que tienen al menos 1 cuota pendiente.
 * Para cada uno calcula:
 * - cuotas restantes (totales - ya pagadas según fecha de compra)
 * - monto por cuota
 * - tarjeta asociada
 * - próxima fecha en que aparece en resumen
 */
export function cuotasPendientes(gastos, tarjetas, hoy = new Date()) {
  const out = [];
  for (const g of gastos) {
    if (g.deleted || g.tipo !== 'cuotas' || !g.tarjeta_id || !g.cuotas_total) continue;
    const tarjeta = tarjetas.find(t => t.id === g.tarjeta_id);
    if (!tarjeta) continue;

    // ¿Cuántas cuotas ya fueron pagadas hasta hoy?
    const fc = new Date(g.fecha + 'T12:00:00');
    let baseY, baseM;
    if (fc.getDate() <= tarjeta.dia_cierre) {
      baseY = fc.getFullYear();
      baseM = fc.getMonth() + 1;
    } else {
      baseM = fc.getMonth() + 2;
      baseY = fc.getFullYear();
      if (baseM > 12) { baseM = 1; baseY++; }
    }

    // Mes actual (en términos del ciclo)
    const cicloActual = fechasCiclo(tarjeta, hoy);
    const cierreY = cicloActual.cierre.getFullYear();
    const cierreM = cicloActual.cierre.getMonth() + 1;

    const dist = (cierreY - baseY) * 12 + (cierreM - baseM);
    const cuotaActual = Math.max(0, Math.min(g.cuotas_total, dist + 1));
    const pendientes = Math.max(0, g.cuotas_total - cuotaActual + 1);

    if (pendientes <= 0) continue;

    const montoTotal = g.monto;
    const montoPorCuota = montoTotal / g.cuotas_total;

    out.push({
      gasto_id:     g.id,
      tarjeta_id:   g.tarjeta_id,
      tarjeta:      tarjeta.nombre,
      descripcion:  g.descripcion,
      cuotas_total: g.cuotas_total,
      cuotas_pagadas: g.cuotas_total - pendientes,
      cuotas_pendientes: pendientes,
      monto_total:  montoTotal,
      monto_cuota:  montoPorCuota,
      saldo_pendiente: montoPorCuota * pendientes,
      proxima_cuota_periodo: `${cierreY}-${String(cierreM).padStart(2,'0')}`,
      categoria:    g.categoria || 'general',
      fecha_compra: g.fecha,
    });
  }
  return out;
}

/**
 * Calcula la capacidad crediticia REAL disponible.
 *
 * Regla 30%: el compromiso mensual total con tarjetas no debería exceder
 * el 30% del ingreso neto. Esta función calcula el margen REAL considerando:
 *  - Ingresos del mes
 *  - Gastos fijos sin tarjeta (alquiler, expensas, etc.)
 *  - Cuotas ya comprometidas que vienen de meses anteriores
 *  - Recurrentes en tarjeta (suscripciones)
 *  - Resumen actual de cada tarjeta
 *
 * Devuelve además sugerencias de gasto seguro por tarjeta.
 */
export function calcularCapacidad({ gastos, ingresos, tarjetas, resumenes, hoy = new Date() }) {
  const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

  // 1. Ingreso neto del mes
  const ingresoMes = ingresos
    .filter(i => !i.deleted && (i.periodo_aplicacion === mesActual || i.fecha?.startsWith(mesActual)))
    .reduce((a, i) => a + (i.sueldo_neto || 0) + (i.bonos || 0), 0);

  // 2. Gastos fijos del mes en curso (sin tarjeta) — para el saldo líquido real
  const gastosFijosMes = gastos
    .filter(g => !g.deleted && !g.tarjeta_id && g.fecha?.startsWith(mesActual))
    .reduce((a, g) => {
      let m = g.monto;
      if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0)/100);
      if (g.tipo === 'amortizacion') m = m / 12;
      return a + m;
    }, 0);

  // 2b. Gastos HABITUALES: promedio mensual de gastos no-tarjeta de los últimos
  //     3 meses. Es la base realista del "costo de vida" para tasar la capacidad
  //     de crédito (no depende de un mes puntual con gastos atípicos).
  const mesesRef = [];
  for (let k = 0; k < 3; k++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - k, 1);
    mesesRef.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const sumaHabituales = gastos
    .filter(g => !g.deleted && !g.tarjeta_id && mesesRef.some(mm => g.fecha?.startsWith(mm)))
    .reduce((a, g) => {
      let m = g.monto;
      if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0)/100);
      if (g.tipo === 'amortizacion') m = m / 12;
      return a + m;
    }, 0);
  const gastosHabituales = sumaHabituales / 3;

  // 3. Compromisos de tarjetas: suma de resumenes activos
  const compromisoTarjetas = (resumenes || []).reduce((a, r) => a + (r.total_resumen || 0), 0);

  // 4. Cuotas mensuales pendientes (ya comprometidas para meses futuros)
  const pendientes = cuotasPendientes(gastos, tarjetas, hoy);
  const cuotasMensualesProyectadas = pendientes.reduce((a, p) => a + p.monto_cuota, 0);

  // 5. LÍMITE FINANCIERO tasado con el ingreso:
  //    - Regla clásica 30% del ingreso para servicio de deuda (cuotas)…
  //    - …pero acotado a lo que realmente queda libre tras los gastos habituales.
  //    De ese modo, si tus gastos de vida consumen casi todo el ingreso, el
  //    límite baja aunque el 30% diera más.
  const cuotaSegura30 = ingresoMes * 0.30;
  const disponibleTrasHabituales = Math.max(0, ingresoMes - gastosHabituales);
  const limiteFinanciero = Math.max(0, Math.min(cuotaSegura30, disponibleTrasHabituales));

  // 6. Capacidad libre real = límite financiero - compromisos ya existentes
  const capacidadLibre = Math.max(0, limiteFinanciero - cuotasMensualesProyectadas - compromisoTarjetas);

  // 7. Saldo líquido proyectado (lo que te queda en mano este mes)
  const saldoLiquidoProyectado = ingresoMes - gastosFijosMes - compromisoTarjetas;

  // 8. Ratio de uso del ingreso (basado en gastos habituales para ser estable)
  const ratioUsoIngreso = ingresoMes > 0
    ? (gastosHabituales + compromisoTarjetas + cuotasMensualesProyectadas) / ingresoMes
    : 0;

  // 9. Estado del semáforo
  let semaforo, sugerencia;
  if (ratioUsoIngreso <= 0.5) {
    semaforo = 'verde';
    sugerencia = 'Tu capacidad crediticia está sana. Podés tomar cuotas sin riesgo.';
  } else if (ratioUsoIngreso <= 0.7) {
    semaforo = 'amarillo';
    sugerencia = 'Tu compromiso mensual supera el 50%. Evitá tomar nuevas cuotas largas.';
  } else if (ratioUsoIngreso <= 0.9) {
    semaforo = 'naranja';
    sugerencia = '⚠ Estás cerca del límite. Sólo tomá cuotas si es estrictamente necesario.';
  } else {
    semaforo = 'rojo';
    sugerencia = '🚨 Riesgo alto. Tus compromisos superan el 90% del ingreso. NO tomes cuotas nuevas.';
  }

  // 10. Capacidad disponible por tarjeta
  const porTarjeta = (tarjetas || [])
    .filter(t => !t.deleted && t.activa !== false)
    .map(t => {
      const r = (resumenes || []).find(x => x.tarjeta_id === t.id);
      const limTotal = (t.limite_un_pago || 0) + (t.limite_cuotas || 0);
      const usado    = r ? r.total_resumen : 0;
      const usadoPct = limTotal > 0 ? (usado * 100) / limTotal : 0;
      const disponibleTarjeta = Math.max(0, limTotal - usado);

      // Capacidad práctica = min(disponible_tarjeta, capacidad_libre_global)
      const recomendado = Math.min(disponibleTarjeta, capacidadLibre);

      return {
        tarjeta_id: t.id,
        nombre: t.nombre,
        color: t.color,
        limite_total: limTotal,
        usado,
        usado_pct: usadoPct,
        disponible_tarjeta: disponibleTarjeta,
        recomendado_seguro: recomendado,
        cuotas_pendientes: pendientes.filter(p => p.tarjeta_id === t.id),
      };
    });

  return {
    ingreso_mes: ingresoMes,
    gastos_fijos_mes: gastosFijosMes,
    gastos_habituales: gastosHabituales,
    limite_financiero: limiteFinanciero,
    compromiso_tarjetas: compromisoTarjetas,
    cuotas_mensuales_proyectadas: cuotasMensualesProyectadas,
    cuota_segura_30: cuotaSegura30,
    capacidad_libre: capacidadLibre,
    saldo_liquido_proyectado: saldoLiquidoProyectado,
    ratio_uso_ingreso: ratioUsoIngreso,
    porcentaje_uso: Math.round(ratioUsoIngreso * 100),
    semaforo,
    sugerencia,
    por_tarjeta: porTarjeta,
    cuotas_pendientes: pendientes,
  };
}

/**
 * Simula tomar una nueva compra en cuotas y dice si pasa los límites.
 * @returns {{
 *   permitido: boolean,
 *   nueva_cuota_mensual: number,
 *   nuevo_ratio: number,
 *   nueva_capacidad_libre: number,
 *   advertencias: Array<string>,
 *   mensaje: string,
 * }}
 */
export function simularCompra({ monto, cuotas, tarjeta_id, capacidad }) {
  const cuotaMensual = monto / cuotas;
  const nuevaCuotaMensual = capacidad.cuotas_mensuales_proyectadas + cuotaMensual;
  const nuevoCompromisoTotal = capacidad.gastos_fijos_mes + capacidad.compromiso_tarjetas + nuevaCuotaMensual;
  const nuevoRatio = capacidad.ingreso_mes > 0 ? nuevoCompromisoTotal / capacidad.ingreso_mes : 1;
  const nuevaCapacidadLibre = Math.max(0, capacidad.cuota_segura_30 - nuevaCuotaMensual - capacidad.compromiso_tarjetas);

  const advertencias = [];
  let permitido = true;
  let mensaje;

  const tarjetaInfo = capacidad.por_tarjeta.find(t => t.tarjeta_id === tarjeta_id);
  if (tarjetaInfo) {
    if (monto > tarjetaInfo.disponible_tarjeta) {
      permitido = false;
      advertencias.push(`Excede el límite disponible de la tarjeta (${formatARS(tarjetaInfo.disponible_tarjeta)} libres)`);
    }
    if (monto > tarjetaInfo.recomendado_seguro && monto <= tarjetaInfo.disponible_tarjeta) {
      advertencias.push(`Supera el monto seguro recomendado (${formatARS(tarjetaInfo.recomendado_seguro)})`);
    }
  }

  if (nuevoRatio > 0.5 && capacidad.ratio_uso_ingreso <= 0.5) {
    advertencias.push(`Vas a superar el 50% de tu ingreso mensual comprometido`);
  }
  if (nuevoRatio > 0.7) {
    advertencias.push(`Vas a comprometer el ${Math.round(nuevoRatio*100)}% de tu ingreso. Alto riesgo.`);
  }
  if (nuevoRatio > 0.9) {
    permitido = false;
    advertencias.push(`Compromiso > 90% del ingreso. Bloqueado por seguridad.`);
  }

  if (advertencias.length === 0) {
    mensaje = `✓ Compra segura. Te queda ${formatARS(nuevaCapacidadLibre)} de capacidad libre.`;
  } else if (permitido) {
    mensaje = `⚠ Permitido pero con riesgo. ${advertencias.length} advertencia(s).`;
  } else {
    mensaje = `✗ No recomendado. Excede los límites seguros.`;
  }

  return {
    permitido,
    nueva_cuota_mensual: cuotaMensual,
    nuevo_ratio: nuevoRatio,
    nueva_capacidad_libre: nuevaCapacidadLibre,
    advertencias,
    mensaje,
  };
}

function formatARS(n) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n);
}
