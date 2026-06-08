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
    if (g.deleted || g.es_pago_tarjeta || g.es_aporte_meta || g.es_ajuste || (g.es_habitual && !g.cuenta_id) || !g.fecha) continue;
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
  // Aportable real = excedente del mes topado por el efectivo disponible.
  const saldoReal  = Math.max(0, saldoLiquido || 0);
  const aportable  = Math.min(Math.max(0, disponible), saldoReal);

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
    // Aporte mensual realista al fondo: ideal armarlo en ~6 meses, pero topado al
    // efectivo que tenés. Si el aporte real es menor, el plazo se estira en serio.
    const aporteFondo = Math.min(aportable, falta / 6);
    const mesesFondo  = aporteFondo > 0 ? Math.ceil(falta / aporteFondo) : null;
    push({
      id: 'reserva', tipo: 'consejo', prioridad: 50,
      titulo: '🛟 Tu fondo de emergencia es bajo',
      detalle: `Lo ideal es tener 3 meses de gastos cubiertos (${fmt(objetivo)}). Hoy te faltan ${fmt(falta)}.`,
      impacto: 0,
      accion: aportable > 0
        ? `Apartá ${fmt(aporteFondo)} por mes${mesesFondo ? ` y en ~${mesesFondo} ${mesesFondo === 1 ? 'mes' : 'meses'} armás el colchón` : ''}.`
        : (disponible > 0
            ? `Tenés excedente mensual (${fmt(disponible)}) pero tu saldo líquido está comprometido. Liberá efectivo para empezar a armar el fondo.`
            : 'Primero equilibrá tu flujo mensual, después construí el fondo.'),
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

/* ─── Estrategia inversora (Bogle / Graham / Buffett / Dalio) ──
 *
 * Convierte el excedente mensual en un PLAN DE ACCIÓN ordenado por prioridad
 * absoluta. Es una cascada: cada peldaño consume el excedente disponible antes
 * de pasar al siguiente. Determinista y 100% local.
 *
 *   1. Buffett — Ratio de ahorro mínimo: chequea que el excedente alcance el
 *      % mínimo del ingreso. Si no, indica cuánto recortar de gastos variables.
 *   2. Graham — Fondo de emergencia: hasta cubrir N meses de gastos fijos, TODO
 *      el excedente va al colchón. Prohibido invertir.
 *   3. Buffett — Deuda mala: si hay deuda con interés alto (tarjetas/cuotas que
 *      superan el umbral), se amortiza antes de invertir.
 *   4. Dalio — All Weather: el remanente se reparte según la distribución.
 */

const ALLWEATHER_LABELS = {
  renta_variable: { label: 'Renta variable indexada', icon: '📈' },
  bonos_largo:    { label: 'Bonos de largo plazo',     icon: '🏛️' },
  bonos_medio:    { label: 'Bonos de mediano plazo',   icon: '📊' },
  oro:            { label: 'Oro',                       icon: '🥇' },
  commodities:    { label: 'Commodities',              icon: '🛢️' },
};

const CONFIG_INVERSORA_DEFAULT = {
  activa: true,
  ahorro_minimo_pct: 20,
  meses_fondo_emergencia: 6,
  umbral_deuda_mala_pct: 8,
  distribucion: { renta_variable: 30, bonos_largo: 40, bonos_medio: 15, oro: 7.5, commodities: 7.5 },
};

function planGestionMensual(ctx, configRaw) {
  const cfg = { ...CONFIG_INVERSORA_DEFAULT, ...(configRaw || {}) };
  cfg.distribucion = { ...CONFIG_INVERSORA_DEFAULT.distribucion, ...(configRaw?.distribucion || {}) };
  const fmt = (n) => '$' + r0(n).toLocaleString('es-AR');

  const { ingresoMes, gastosHabituales, compromisoMensual, saldoLiquido, metas = [] } = ctx;
  const gastosFijos = gastosHabituales + compromisoMensual;
  const disponible  = ingresoMes - gastosFijos;       // excedente mensual (FLUJO, diagnóstico)
  // Lo que REALMENTE podés destinar este mes está topado por tu efectivo real:
  // no podés aportar plata que no tenés (el flujo puede estar en tarjeta o ya usado).
  const saldoReal   = Math.max(0, saldoLiquido || 0);
  const aportable   = Math.min(Math.max(0, disponible), saldoReal);

  // ── Fondo de emergencia: de las metas marcadas, o derivado de gastos fijos ──
  const metasEmergencia = (metas || []).filter(m => !m.deleted && m.es_emergencia);
  const fondoActual = metasEmergencia.reduce((a, m) => a + (m.monto_actual || 0), 0);
  const objetivoMetas = metasEmergencia.reduce((a, m) => a + (m.monto_objetivo || 0), 0);
  const objetivoDerivado = gastosFijos * cfg.meses_fondo_emergencia;
  const fondoObjetivo = objetivoMetas > 0 ? objetivoMetas : objetivoDerivado;
  const faltaFondo = Math.max(0, fondoObjetivo - fondoActual);
  const mesesCubiertos = gastosFijos > 0 ? fondoActual / gastosFijos : (fondoActual > 0 ? 99 : 0);

  // ── Deuda mala (proxy): compromiso mensual de tarjetas/cuotas ──
  // El sistema no guarda tasa por deuda; el crédito rotativo y las cuotas suelen
  // superar el umbral, así que el compromiso mensual se trata como deuda a cancelar.
  const deudaMalaMensual = compromisoMensual;

  const pasos = [];
  const ahorroMinimo = ingresoMes * (cfg.ahorro_minimo_pct / 100);

  // Estado de déficit: no hay excedente para gestionar
  if (ingresoMes <= 0) {
    return { disponible: 0, aportable: 0, estado: 'sin_datos', mensaje: 'Cargá tus ingresos para activar el plan de gestión.', pasos: [], inversion: null, config: cfg };
  }
  if (disponible <= 0) {
    return {
      disponible: r0(disponible), aportable: 0, estado: 'deficit',
      mensaje: `Tu flujo mensual es negativo o nulo (${fmt(disponible)}). Antes de ahorrar o invertir, equilibrá ingresos y gastos.`,
      pasos: [{
        n: 1, clave: 'deficit', icon: '🚨', titulo: 'Equilibrá tu flujo primero',
        detalle: `Gastás ${fmt(gastosFijos)} sobre un ingreso de ${fmt(ingresoMes)}. No queda excedente para gestionar.`,
        monto: 0, accion: `Recortá al menos ${fmt(Math.abs(disponible) + 1)} de gastos o subí ingresos.`,
      }],
      inversion: null, config: cfg,
    };
  }
  // Flujo positivo pero sin efectivo libre: el excedente del mes no está disponible
  // como saldo (consumos en tarjeta o ya usado). No se puede aportar nada todavía.
  if (aportable <= 0) {
    return {
      disponible: r0(disponible), aportable: 0, estado: 'sin_liquidez',
      mensaje: `Tu flujo del mes es positivo (${fmt(disponible)}), pero tu saldo disponible es ${fmt(saldoReal)}. No tenés efectivo libre para destinar al fondo o invertir ahora.`,
      pasos: [{
        n: 1, clave: 'sin_liquidez', icon: '💧', titulo: 'Sin efectivo libre este mes',
        detalle: `El excedente del mes (${fmt(disponible)}) todavía no está disponible como efectivo: puede estar en consumos de tarjeta o ya usado. Tu saldo líquido real es ${fmt(saldoReal)}.`,
        monto: 0, accion: 'Liberá efectivo (pagá/bajá consumos) o esperá a que se acredite para empezar a aportar.',
      }],
      inversion: null, config: cfg,
    };
  }

  let restante = aportable;   // se reparte el efectivo real, no el flujo teórico

  // ── PASO 1 — Buffett: ratio de ahorro mínimo ──
  const cumpleAhorro = disponible >= ahorroMinimo;
  pasos.push({
    n: 1, clave: 'ahorro_minimo', icon: cumpleAhorro ? '✅' : '⚠',
    titulo: `Ahorro mínimo (regla Buffett ${cfg.ahorro_minimo_pct}%)`,
    detalle: cumpleAhorro
      ? `Tu excedente (${fmt(disponible)}) supera el mínimo del ${cfg.ahorro_minimo_pct}% del ingreso (${fmt(ahorroMinimo)}). Vas bien.`
      : `Tu excedente (${fmt(disponible)}) está por debajo del ${cfg.ahorro_minimo_pct}% objetivo (${fmt(ahorroMinimo)}). Te faltan ${fmt(ahorroMinimo - disponible)}.`,
    monto: r0(ahorroMinimo),
    accion: cumpleAhorro ? null : `Recortá ${fmt(ahorroMinimo - disponible)} de gastos variables para llegar al mínimo.`,
    estado: cumpleAhorro ? 'ok' : 'alerta',
  });

  // ── PASO 2 — Graham: fondo de emergencia (puerta) ──
  if (faltaFondo > 0) {
    const aporte = Math.min(restante, faltaFondo);
    restante -= aporte;
    const mesesParaCubrir = aporte > 0 ? Math.ceil(faltaFondo / aporte) : null;
    pasos.push({
      n: 2, clave: 'fondo_emergencia', icon: '🛟',
      titulo: 'Fondo de emergencia (prioridad absoluta)',
      detalle: `Cubrís ${mesesCubiertos.toFixed(1)} de ${cfg.meses_fondo_emergencia} meses de gastos fijos. Objetivo ${fmt(fondoObjetivo)}, tenés ${fmt(fondoActual)}, faltan ${fmt(faltaFondo)}.`,
      monto: r0(aporte),
      accion: `Destiná ${fmt(aporte)} este mes al fondo${mesesParaCubrir ? ` (completo en ~${mesesParaCubrir} ${mesesParaCubrir === 1 ? 'mes' : 'meses'})` : ''}. Hasta cubrirlo, no inviertas.`,
      estado: 'gate',
    });
  } else {
    pasos.push({
      n: 2, clave: 'fondo_emergencia', icon: '✅',
      titulo: 'Fondo de emergencia cubierto',
      detalle: `Ya tenés ${cfg.meses_fondo_emergencia}+ meses de gastos fijos cubiertos (${fmt(fondoActual)}). Podés avanzar a deuda e inversión.`,
      monto: 0, accion: null, estado: 'ok',
    });
  }

  // ── PASO 3 — Buffett: deuda mala antes de invertir ──
  if (restante > 0 && deudaMalaMensual > 0) {
    const aporte = restante; // todo el remanente a amortizar mientras haya deuda
    restante = 0;
    pasos.push({
      n: 3, clave: 'deuda_mala', icon: '🔻',
      titulo: 'Amortizar deuda antes de invertir',
      detalle: `Tenés ${fmt(deudaMalaMensual)}/mes comprometidos en tarjetas/cuotas. Toda deuda con interés sobre el ${cfg.umbral_deuda_mala_pct}% anual rinde más cancelarla que cualquier inversión.`,
      monto: r0(aporte),
      accion: `Usá el excedente libre (${fmt(aporte)}) para adelantar pagos y bajar el compromiso mensual.`,
      estado: 'gate',
    });
  } else if (deudaMalaMensual > 0) {
    pasos.push({
      n: 3, clave: 'deuda_mala', icon: 'ℹ️',
      titulo: 'Deuda pendiente',
      detalle: `Tenés ${fmt(deudaMalaMensual)}/mes en tarjetas/cuotas, pero el excedente ya se consumió en el fondo de emergencia. Priorizá la deuda cuando liberes margen.`,
      monto: 0, accion: null, estado: 'info',
    });
  }

  // ── PASO 4 — Dalio: distribución All Weather del remanente ──
  let inversion = null;
  if (restante > 0) {
    const dist = cfg.distribucion;
    const sumaPct = Object.values(dist).reduce((a, b) => a + (Number(b) || 0), 0) || 100;
    const items = Object.keys(ALLWEATHER_LABELS)
      .filter(k => (dist[k] || 0) > 0)
      .map(k => {
        const pct = (dist[k] || 0);
        return { clave: k, ...ALLWEATHER_LABELS[k], pct, monto: r0(restante * pct / sumaPct) };
      });
    inversion = { total: r0(restante), estrategia: 'All Weather (Ray Dalio)', items };
    pasos.push({
      n: 4, clave: 'inversion', icon: '🌦️',
      titulo: 'Invertir el excedente — All Weather (Dalio)',
      detalle: `Te queda ${fmt(restante)} libre para invertir. Repartilo según la cartera All Weather, balanceada para cualquier clima económico.`,
      monto: r0(restante), accion: null, estado: 'invertir',
    });
  }

  // Mensaje resumen según el peldaño donde se detuvo el dinero
  let estado, mensaje;
  if (faltaFondo > 0) {
    estado = 'fondo';
    mensaje = `Prioridad: armar el fondo de emergencia. Destiná ${fmt(Math.min(aportable, faltaFondo))}/mes (según tu saldo disponible) hasta cubrir ${cfg.meses_fondo_emergencia} meses.`;
  } else if (deudaMalaMensual > 0 && inversion === null) {
    estado = 'deuda';
    mensaje = `Fondo cubierto. Ahora enfocá el excedente en cancelar deuda antes de invertir.`;
  } else if (inversion) {
    estado = 'inversion';
    mensaje = `Fondo cubierto y sin deuda bloqueante. Invertí ${fmt(inversion.total)}/mes con la cartera All Weather.`;
  } else {
    estado = 'ok';
    mensaje = `Plan al día. Seguí aportando al fondo y revisá tus metas.`;
  }

  return { disponible: r0(disponible), aportable: r0(aportable), estado, mensaje, pasos, inversion, config: cfg };
}

export { planGestionMensual };

/* ─── API principal ────────────────────────────────────────── */

export function analizarSaludFinanciera(data = {}) {
  const {
    gastos = [], ingresos = [], tarjetas = [], metas = [],
    capacidad = {}, estado = {}, resumenes = [],
    diagnosticos = [], proyeccion = {}, saturacion = [],
    configInversora = null,
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
    saldoLiquido, tendenciaMensual, cuotasPendientes, metas,
    subscores, categorias, saturacion, proyeccion, diagnosticos, hoy,
  };

  const estrategias = generarEstrategias(ctx);
  const pronostico = pronostico3Meses(ctx);
  // Plan de gestión mensual (estrategia inversora Bogle/Graham/Buffett/Dalio)
  const plan = (configInversora?.activa !== false)
    ? planGestionMensual(ctx, configInversora)
    : null;

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
    plan,
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
