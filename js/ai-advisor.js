/**
 * ai-advisor.js
 * --------------
 * Asesor financiero integral 100% local. Toma todo lo que ya calculan los
 * otros motores (capacidad, estado, proyección, saturación, diagnósticos) y
 * produce una visión holística + accionable:
 *
 *   - Score de salud financiera 0-100 con 4 sub-puntajes
 *   - Estrategias priorizadas con montos concretos (medidas accionables)
 *   - Pronóstico a 3 meses integrando ingresos, gastos habituales y cuotas
 *   - Simulador "what-if" (qué pasa si recortás X o tomás una cuota de Y)
 *
 * No usa red ni librerías. Determinista: mismos datos → mismo resultado.
 */

/* ─── Helpers ──────────────────────────────────────────────── */

const clamp = (v, min, max) => Math.max(min, Math.max(min, Math.min(max, v)));
const r0 = (n) => Math.round(n);
const safeDiv = (a, b) => (b > 0 ? a / b : 0);

const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function montoEfectivo(g) {
  let m = g.monto || 0;
  if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0) / 100);
  if (g.tipo === 'amortizacion' || g.es_amortizacion_anual) m = m / 12;
  return m;
}

/* ─── Gasto por categoría (promedio mensual últimos N meses) ── */

function gastoPorCategoria(gastos, hoy, meses = 3) {
  const claves = [];
  for (let k = 0; k < meses; k++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - k, 1);
    claves.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const porCat = new Map();
  for (const g of gastos) {
    if (g.deleted || g.es_pago_tarjeta || !g.fecha) continue;
    if (!claves.some(c => g.fecha.startsWith(c))) continue;
    const cat = g.categoria || 'general';
    porCat.set(cat, (porCat.get(cat) || 0) + montoEfectivo(g));
  }
  // Promediar por la cantidad de meses
  const arr = [...porCat.entries()].map(([categoria, total]) => ({
    categoria, promedioMensual: total / meses, total,
  }));
  arr.sort((a, b) => b.promedioMensual - a.promedioMensual);
  return arr;
}

/* ─── Cuotas comprometidas por mes futuro ──────────────────── */

// Devuelve cuánto suman las cuotas pendientes que caen en el mes futuro `offset`
// (0 = mes actual, 1 = mes que viene, …). Usa capacidad.cuotas_pendientes.
function cuotasEnMesFuturo(cuotasPendientes, offset) {
  let total = 0;
  for (const c of (cuotasPendientes || [])) {
    if (offset < (c.cuotas_pendientes || 0)) total += (c.monto_cuota || 0);
  }
  return total;
}

/* ─── Sub-puntajes (cada uno 0-100) ────────────────────────── */

function calcularSubscores({ ingresoMes, gastosHabituales, compromisoMensual, saldoLiquido, tendenciaMensual }) {
  // 1. AHORRO: tasa de ahorro = (ingreso - gastos - compromisos) / ingreso
  const disponible = ingresoMes - gastosHabituales - compromisoMensual;
  const tasaAhorro = safeDiv(disponible, ingresoMes);
  // 30%+ ahorro = 100; 0% = 55; -30% = 0
  const ahorro = clamp(55 + tasaAhorro * 150, 0, 100);

  // 2. ENDEUDAMIENTO: ratio de compromiso de deuda / ingreso (menor es mejor)
  const ratioDeuda = safeDiv(compromisoMensual, ingresoMes);
  // <15% = 100; 30% = 60; >55% = 0
  const endeudamiento = clamp(100 - (ratioDeuda - 0.15) * 285, 0, 100);

  // 3. RITMO DE GASTO: según tendencia mensual del flujo (de proyección)
  //    Tendencia positiva (ahorrás más cada mes) = bueno.
  const ritmoRatio = safeDiv(tendenciaMensual, ingresoMes); // puede ser + o -
  // +5%/mes = 100; 0 = 65; -10%/mes = 0
  const ritmo = clamp(65 + ritmoRatio * 700, 0, 100);

  // 4. RESERVAS: meses de gastos cubiertos por el saldo líquido
  const gastoMensualTotal = gastosHabituales + compromisoMensual;
  const mesesReserva = gastoMensualTotal > 0 ? saldoLiquido / gastoMensualTotal : (saldoLiquido > 0 ? 6 : 0);
  // 3+ meses = 100; 1 mes = 55; 0 = 15; negativo = 0
  const reservas = clamp(15 + mesesReserva * 28, 0, 100);

  return {
    ahorro: r0(ahorro),
    endeudamiento: r0(endeudamiento),
    ritmo: r0(ritmo),
    reservas: r0(reservas),
    _aux: { tasaAhorro, ratioDeuda, mesesReserva, disponible },
  };
}

function nivelDeScore(score) {
  if (score >= 80) return { nivel: 'Excelente', color: 'var(--success)' };
  if (score >= 60) return { nivel: 'Buena',     color: '#7ed957' };
  if (score >= 40) return { nivel: 'Regular',   color: 'var(--warning)' };
  return { nivel: 'En riesgo', color: 'var(--danger)' };
}

/* ─── Generación de estrategias ────────────────────────────── */

function generarEstrategias(ctx) {
  const {
    ingresoMes, gastosHabituales, compromisoMensual, capacidadLibre,
    subscores, categorias, saturacion, proyeccion, cuotasPendientes,
    diagnosticos, saldoLiquido,
  } = ctx;
  const fmt = (n) => '$' + r0(n).toLocaleString('es-AR');
  const E = [];
  const push = (e) => E.push(e);

  const disponible = ingresoMes - gastosHabituales - compromisoMensual;

  // 1. Déficit estructural: gastás más de lo que ingresás
  if (ingresoMes > 0 && disponible < 0) {
    push({
      id: 'deficit', tipo: 'critico', prioridad: 100,
      titulo: '🚨 Estás gastando más de lo que ingresás',
      detalle: `Cada mes te faltan ${fmt(Math.abs(disponible))}. A este ritmo, vas a consumir tus reservas o endeudarte. Es la prioridad #1 a corregir.`,
      impacto: Math.abs(disponible),
      accion: `Recortá al menos ${fmt(Math.abs(disponible))} en gastos no esenciales o aumentá ingresos.`,
    });
  }

  // 2. Endeudamiento alto: pausar cuotas
  const ratioDeuda = safeDiv(compromisoMensual, ingresoMes);
  if (ratioDeuda > 0.30) {
    push({
      id: 'deuda_alta', tipo: ratioDeuda > 0.45 ? 'critico' : 'alerta',
      prioridad: ratioDeuda > 0.45 ? 95 : 80,
      titulo: `${ratioDeuda > 0.45 ? '🚨' : '⚠'} Tu deuda mensual es ${Math.round(ratioDeuda * 100)}% del ingreso`,
      detalle: `Entre cuotas y resúmenes comprometés ${fmt(compromisoMensual)} por mes. Lo recomendado es no superar el 30% (${fmt(ingresoMes * 0.30)}).`,
      impacto: compromisoMensual - ingresoMes * 0.30,
      accion: 'No tomes nuevas cuotas hasta bajar este ratio. Priorizá cancelar las cuotas más cortas.',
    });
  }

  // 3. Categoría dominante con margen de recorte
  if (categorias.length && ingresoMes > 0) {
    const top = categorias[0];
    const pesoTop = safeDiv(top.promedioMensual, ingresoMes);
    if (pesoTop > 0.15 && top.categoria !== 'general') {
      const recorte = top.promedioMensual * 0.20;
      push({
        id: 'cat_dominante', tipo: 'consejo', prioridad: 60,
        titulo: `🍽 "${top.categoria}" se lleva ${Math.round(pesoTop * 100)}% de tu ingreso`,
        detalle: `Gastás en promedio ${fmt(top.promedioMensual)}/mes en ${top.categoria}. Es tu categoría más pesada.`,
        impacto: recorte,
        accion: `Recortá un 20% (${fmt(recorte)}/mes) y en 12 meses ahorrás ${fmt(recorte * 12)}.`,
      });
    }
  }

  // 4. Tarjeta cerca de saturación (de predecirSaturacionTarjetas)
  for (const sat of (saturacion || [])) {
    if (sat.dias_para_100 != null && sat.dias_para_100 < 45 && sat.dias_para_100 >= 0) {
      push({
        id: 'sat_' + sat.tarjeta_id, tipo: sat.dias_para_100 < 20 ? 'critico' : 'alerta',
        prioridad: sat.dias_para_100 < 20 ? 90 : 70,
        titulo: `💳 ${sat.tarjeta_nombre} se satura en ${sat.dias_para_100} días`,
        detalle: `Al ritmo actual de ${fmt(sat.ritmo_diario)}/día vas a llegar al 100% del límite pronto. Quedarte sin margen complica imprevistos.`,
        impacto: 0,
        accion: 'Bajá el ritmo de consumo en esta tarjeta o pasá compras a otra con más margen.',
      });
    }
  }

  // 5. Proyección: riesgo de saldo negativo
  for (const al of (proyeccion?.alertas || [])) {
    if (al.tipo === 'saldo_negativo') {
      push({
        id: 'proy_negativo', tipo: 'critico', prioridad: 92,
        titulo: '📉 Riesgo de saldo negativo a la vista',
        detalle: al.mensaje + '. La proyección integra tu ritmo de ingresos y gastos.',
        impacto: 0,
        accion: 'Reforzá ingresos o recortá gastos las próximas semanas para evitar quedar en rojo.',
      });
    }
  }

  // 6. Reservas bajas: fondo de emergencia
  if (subscores.reservas < 50 && ingresoMes > 0) {
    const objetivo = (gastosHabituales + compromisoMensual) * 3;
    const falta = Math.max(0, objetivo - saldoLiquido);
    push({
      id: 'reserva', tipo: 'consejo', prioridad: 50,
      titulo: '🛟 Tu fondo de emergencia es bajo',
      detalle: `Lo ideal es tener 3 meses de gastos cubiertos (${fmt(objetivo)}). Hoy te faltan ${fmt(falta)}.`,
      impacto: 0,
      accion: disponible > 0
        ? `Apartá ${fmt(Math.min(disponible, falta / 6))} por mes y en ~6 meses armás el colchón.`
        : 'Primero equilibrá tu flujo mensual, después construí el fondo.',
    });
  }

  // 7. Oportunidad: hay capacidad libre para una cuota segura
  if (capacidadLibre > ingresoMes * 0.05 && ratioDeuda < 0.30) {
    push({
      id: 'oportunidad', tipo: 'positivo', prioridad: 30,
      titulo: '✅ Tenés margen para una cuota sin riesgo',
      detalle: `Tu capacidad crediticia libre es ${fmt(capacidadLibre)}/mes. Podés financiar una compra manteniendo tu salud financiera.`,
      impacto: 0,
      accion: `Una compra de hasta ${fmt(capacidadLibre * 12)} en 12 cuotas (${fmt(capacidadLibre)}/mes) entra sin comprometerte.`,
    });
  }

  // 8. Felicitación si todo va bien
  if (subscores.ahorro >= 70 && ratioDeuda < 0.20 && subscores.reservas >= 60) {
    push({
      id: 'felicitacion', tipo: 'positivo', prioridad: 10,
      titulo: '🌟 Tus finanzas están sanas',
      detalle: `Ahorrás bien, tu deuda es baja (${Math.round(ratioDeuda * 100)}%) y tenés reservas. Buen trabajo.`,
      impacto: 0,
      accion: 'Mantené el rumbo. Considerá invertir el excedente para que no pierda contra la inflación.',
    });
  }

  // Sumar diagnósticos críticos de gasto (hormiga, desvíos) como consejos suaves
  for (const d of (diagnosticos || [])) {
    if (d.severidad === 'critical' && d.tipo === 'gasto_hormiga') {
      push({
        id: 'hormiga', tipo: 'consejo', prioridad: 40,
        titulo: '🐜 ' + (d.titulo || 'Gastos hormiga detectados'),
        detalle: d.detalle || '',
        impacto: d.monto_implicado || 0,
        accion: d.sugerencia || 'Agrupá y revisá esos micro-gastos: suman más de lo que parece.',
      });
      break; // solo uno
    }
  }

  E.sort((a, b) => b.prioridad - a.prioridad);
  return E;
}

/* ─── Pronóstico a 3 meses ─────────────────────────────────── */

function pronostico3Meses(ctx) {
  const { ingresoMes, gastosHabituales, cuotasPendientes, saldoLiquido, hoy } = ctx;
  const out = [];
  let saldoAcum = saldoLiquido;
  for (let k = 1; k <= 3; k++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + k, 1);
    const cuotas = cuotasEnMesFuturo(cuotasPendientes, k);
    const gastos = gastosHabituales + cuotas;
    const neto = ingresoMes - gastos;
    saldoAcum += neto;
    out.push({
      periodo: `${MESES[d.getMonth()]} ${d.getFullYear()}`,
      mes: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      ingresos: r0(ingresoMes),
      gastos_habituales: r0(gastosHabituales),
      cuotas: r0(cuotas),
      gastos_total: r0(gastos),
      neto: r0(neto),
      saldo_acumulado: r0(saldoAcum),
    });
  }
  return out;
}

/* ─── API principal ────────────────────────────────────────── */

export function analizarSaludFinanciera(data = {}) {
  const {
    gastos = [], ingresos = [], tarjetas = [],
    capacidad = {}, estado = {}, resumenes = [],
    diagnosticos = [], proyeccion = {}, saturacion = [],
    hoy = new Date(),
  } = data;

  const ingresoMes        = capacidad.ingreso_mes || 0;
  const gastosHabituales  = capacidad.gastos_habituales || estado.promedio_egresos_3m || 0;
  const compromisoMensual = (capacidad.compromiso_tarjetas || 0) + (capacidad.cuotas_mensuales_proyectadas || 0);
  const capacidadLibre    = capacidad.capacidad_libre || 0;
  const saldoLiquido      = estado.saldo_liquido || 0;
  const tendenciaMensual  = proyeccion.tendencia_mensual || 0;
  const cuotasPendientes  = capacidad.cuotas_pendientes || [];

  const categorias = gastoPorCategoria(gastos, hoy, 3);

  const subscores = calcularSubscores({
    ingresoMes, gastosHabituales, compromisoMensual, saldoLiquido, tendenciaMensual,
  });

  // Score ponderado
  const score = r0(
    subscores.ahorro * 0.30 +
    subscores.endeudamiento * 0.30 +
    subscores.ritmo * 0.20 +
    subscores.reservas * 0.20
  );
  const { nivel, color } = nivelDeScore(score);

  const ctx = {
    ingresoMes, gastosHabituales, compromisoMensual, capacidadLibre,
    saldoLiquido, tendenciaMensual, cuotasPendientes,
    subscores, categorias, saturacion, proyeccion, diagnosticos, hoy,
  };

  const estrategias = generarEstrategias(ctx);
  const pronostico = pronostico3Meses(ctx);

  const tasaAhorroPct = Math.round(subscores._aux.tasaAhorro * 100);
  const resumen = ingresoMes <= 0
    ? 'Cargá tus ingresos para ver tu análisis financiero completo.'
    : `Salud ${nivel.toLowerCase()} (${score}/100). Ahorrás el ${tasaAhorroPct}% del ingreso y comprometés el ${Math.round(subscores._aux.ratioDeuda * 100)}% en deuda.`;

  return {
    score, nivel, color,
    subscores: {
      ahorro:        { valor: subscores.ahorro,        label: 'Ahorro' },
      endeudamiento: { valor: subscores.endeudamiento, label: 'Endeudamiento' },
      ritmo:         { valor: subscores.ritmo,         label: 'Ritmo de gasto' },
      reservas:      { valor: subscores.reservas,      label: 'Reservas' },
    },
    metricas: {
      ingreso_mes: r0(ingresoMes),
      gastos_habituales: r0(gastosHabituales),
      compromiso_mensual: r0(compromisoMensual),
      capacidad_libre: r0(capacidadLibre),
      disponible_mensual: r0(subscores._aux.disponible),
      tasa_ahorro_pct: tasaAhorroPct,
      ratio_deuda_pct: Math.round(subscores._aux.ratioDeuda * 100),
      meses_reserva: Math.round(subscores._aux.mesesReserva * 10) / 10,
      tendencia_mensual: r0(tendenciaMensual),
    },
    estrategias,
    pronostico,
    resumen,
  };
}

/* ─── Simulador what-if ────────────────────────────────────── */

/**
 * Recalcula el panorama aplicando cambios hipotéticos.
 * @param {Object} base  El mismo `data` que recibe analizarSaludFinanciera.
 * @param {Object} cambios
 *   @param {Array}  [cambios.recortes]  [{ categoria, monto }] recortes mensuales
 *   @param {Object} [cambios.nuevaCuota] { monto, cuotas } compra nueva en cuotas
 * Devuelve { antes, despues, delta } con score, disponible y capacidad.
 */
export function simularEscenario(base, cambios = {}) {
  const antes = analizarSaludFinanciera(base);

  const recorteTotal = (cambios.recortes || []).reduce((a, r) => a + (Number(r.monto) || 0), 0);
  const nuevaCuotaMensual = cambios.nuevaCuota && cambios.nuevaCuota.cuotas > 0
    ? (Number(cambios.nuevaCuota.monto) || 0) / cambios.nuevaCuota.cuotas
    : 0;

  // Construir un `data` modificado: bajamos gastos habituales por el recorte y
  // subimos el compromiso por la cuota nueva (clonando capacidad).
  const capMod = { ...(base.capacidad || {}) };
  capMod.gastos_habituales = Math.max(0, (capMod.gastos_habituales || 0) - recorteTotal);
  capMod.cuotas_mensuales_proyectadas = (capMod.cuotas_mensuales_proyectadas || 0) + nuevaCuotaMensual;
  // La cuota nueva aparece en el pronóstico futuro
  const cuotasMod = [...(capMod.cuotas_pendientes || [])];
  if (nuevaCuotaMensual > 0) {
    cuotasMod.push({
      descripcion: 'Compra simulada',
      monto_cuota: nuevaCuotaMensual,
      cuotas_pendientes: cambios.nuevaCuota.cuotas,
      cuotas_total: cambios.nuevaCuota.cuotas,
    });
  }
  capMod.cuotas_pendientes = cuotasMod;
  // Recalcular capacidad_libre aproximada
  const limiteFin = capMod.limite_financiero || 0;
  capMod.capacidad_libre = Math.max(0,
    limiteFin - (capMod.cuotas_mensuales_proyectadas || 0) - (capMod.compromiso_tarjetas || 0));

  const despues = analizarSaludFinanciera({ ...base, capacidad: capMod });

  return {
    antes,
    despues,
    delta: {
      score: despues.score - antes.score,
      disponible_mensual: despues.metricas.disponible_mensual - antes.metricas.disponible_mensual,
      capacidad_libre: despues.metricas.capacidad_libre - antes.metricas.capacidad_libre,
      recorte_aplicado: recorteTotal,
      cuota_nueva_mensual: r0(nuevaCuotaMensual),
    },
  };
}
