/**
 * ai-local.js
 * -----------
 * Motor de diagnóstico estadístico local en cliente. Espeja la lógica de
 * /api/ai-local-diagnostic del backend para funcionar sin conexión.
 *
 * Detecciones:
 *   - desvio_estandar    -> categoría que excede media + k*sigma
 *   - gasto_hormiga      -> N gastos pequeños este mes
 *   - categoria_anomala  -> categoría sin historial con peso >10% del mes
 *   - racha              -> 3+ meses consecutivos por encima de media
 *
 * Sensibilidad: estricto | moderado | flexible (controla k y umbrales).
 */

const PARAMS = {
  estricto: { k_sigma: 1.0, umbral_hormiga_max: 5000,  freq_hormiga: 8  },
  moderado: { k_sigma: 1.5, umbral_hormiga_max: 3000,  freq_hormiga: 12 },
  flexible: { k_sigma: 2.2, umbral_hormiga_max: 1500,  freq_hormiga: 20 },
};

function mean(xs) { return xs.reduce((a,b)=>a+b,0) / xs.length; }
function pstdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a,b)=> a + (b-m)*(b-m), 0) / xs.length);
}
function monthKey(iso) { return iso.slice(0,7); }

function montoEfectivo(g) {
  let m = g.monto;
  if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0)/100);
  if (g.tipo === 'amortizacion' || g.es_amortizacion_anual) m = m / 12;
  return m;
}

/* ============ Análisis específico de tarjetas de crédito ============ */
/**
 * Detecta patrones de riesgo en el uso de tarjetas:
 *  - Tarjeta cerca de saturación (>80% del límite)
 *  - Resumen creciendo mes a mes 3+ meses seguidos
 *  - Cuotas dominando el resumen (>50%)
 *  - Compromiso mensual con cuotas > 30% del ingreso
 *  - Compra grande (>15% del límite) en un solo movimiento
 */
export function diagnosticarTarjetas({ gastos, ingresos, tarjetas, resumenes, capacidad }) {
  const out = [];
  const fmt = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits: 0 });
  const hoy = new Date();
  const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

  // ── 1. Tarjetas cerca de saturación ────────────────────────────
  for (const r of (resumenes || [])) {
    const t = (tarjetas || []).find(x => x.id === r.tarjeta_id);
    if (!t) continue;
    const pct = r.porcentaje_limite_usado || 0;
    if (pct >= 90) {
      out.push({
        tipo: 'tarjeta_saturada',
        titulo: `🚨 ${t.nombre} casi al límite`,
        detalle: `Estás usando el ${pct.toFixed(0)}% del límite (${fmt.format(r.total_resumen)}). Te quedan menos de ${fmt.format(((t.limite_un_pago||0)+(t.limite_cuotas||0))*0.1)} disponibles.`,
        severidad: 'critical',
        tarjeta_id: t.id,
        monto_implicado: r.total_resumen,
        sugerencia: `Pagá una parte del resumen antes de seguir usándola. Riesgo de rechazo de transacciones.`,
      });
    } else if (pct >= 75) {
      out.push({
        tipo: 'tarjeta_alta_uso',
        titulo: `⚠ ${t.nombre} con uso alto`,
        detalle: `Llevás ${pct.toFixed(0)}% del límite consumido. Quedan ${fmt.format(Math.max(0,((t.limite_un_pago||0)+(t.limite_cuotas||0))-(r.total_resumen||0)))} disponibles.`,
        severidad: 'warning',
        tarjeta_id: t.id,
        monto_implicado: r.total_resumen,
        sugerencia: 'Evitá compras grandes hasta el próximo cierre.',
      });
    }
  }

  // ── 2. Cuotas dominando el resumen ─────────────────────────────
  for (const r of (resumenes || [])) {
    if (!r.total_resumen || r.total_resumen <= 0) continue;
    const pctCuotas = (r.total_cuotas / r.total_resumen) * 100;
    if (pctCuotas > 60) {
      const t = (tarjetas || []).find(x => x.id === r.tarjeta_id);
      out.push({
        tipo: 'cuotas_dominan_resumen',
        titulo: `📦 ${t?.nombre||'Tarjeta'}: cuotas pasivas dominan`,
        detalle: `El ${pctCuotas.toFixed(0)}% del resumen de ${t?.nombre||'esta tarjeta'} (${fmt.format(r.total_cuotas)}) viene de cuotas de meses anteriores. Tenés poco margen para gastos nuevos.`,
        severidad: pctCuotas > 80 ? 'critical' : 'warning',
        tarjeta_id: r.tarjeta_id,
        monto_implicado: r.total_cuotas,
        sugerencia: 'Evitá tomar nuevas cuotas hasta liberar margen.',
      });
    }
  }

  // ── 3. Compromiso > 30% del ingreso por cuotas ────────────────
  if (capacidad && capacidad.cuotas_mensuales_proyectadas > 0 && capacidad.ingreso_mes > 0) {
    const pctIngreso = (capacidad.cuotas_mensuales_proyectadas / capacidad.ingreso_mes) * 100;
    if (pctIngreso > 30) {
      out.push({
        tipo: 'cuotas_superan_30',
        titulo: `📊 Cuotas comprometen ${pctIngreso.toFixed(0)}% de tu ingreso`,
        detalle: `Tus cuotas pendientes suman ${fmt.format(capacidad.cuotas_mensuales_proyectadas)}/mes, más del 30% de tu ingreso. La regla 30% se rompió.`,
        severidad: pctIngreso > 50 ? 'critical' : 'warning',
        monto_implicado: capacidad.cuotas_mensuales_proyectadas,
        sugerencia: 'No tomes nuevas cuotas hasta que se libere margen.',
      });
    }
  }

  // ── 4. Tendencia creciente del resumen mes a mes ──────────────
  // Para cada tarjeta, comparar resumen actual vs últimos 2 meses
  for (const t of (tarjetas || [])) {
    if (t.deleted || t.activa === false) continue;
    const serieMensual = [];
    // Indexar gastos por mes para esta tarjeta
    const porMes = new Map();
    for (const g of (gastos || [])) {
      if (g.deleted || g.tarjeta_id !== t.id) continue;
      const mk = (g.fecha || '').slice(0,7);
      let m = g.monto;
      if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro||0)/100);
      if (g.tipo === 'amortizacion') m = m / 12;
      porMes.set(mk, (porMes.get(mk) || 0) + m);
    }
    // Tomar últimos 3 meses
    const mesesOrdenados = [...porMes.keys()].sort();
    const ultimos3 = mesesOrdenados.slice(-3);
    if (ultimos3.length >= 3) {
      const vals = ultimos3.map(mk => porMes.get(mk));
      if (vals[2] > vals[1] && vals[1] > vals[0] && vals[2] > vals[0] * 1.5) {
        const aumento = ((vals[2] - vals[0]) / vals[0]) * 100;
        out.push({
          tipo: 'tarjeta_tendencia_crece',
          titulo: `📈 ${t.nombre}: gasto creciendo`,
          detalle: `Tu gasto en ${t.nombre} subió ${aumento.toFixed(0)}% en 3 meses (de ${fmt.format(vals[0])} a ${fmt.format(vals[2])}).`,
          severidad: aumento > 100 ? 'critical' : 'warning',
          tarjeta_id: t.id,
          monto_implicado: vals[2] - vals[0],
          sugerencia: 'Revisá las categorías que más subieron y poné un tope.',
        });
      }
    }
  }

  // ── 5. Compras grandes individuales ────────────────────────────
  for (const g of (gastos || [])) {
    if (g.deleted || !g.tarjeta_id) continue;
    if (!g.fecha?.startsWith(mesActual)) continue;
    const t = (tarjetas || []).find(x => x.id === g.tarjeta_id);
    if (!t) continue;
    const limTotal = (t.limite_un_pago||0) + (t.limite_cuotas||0);
    if (limTotal === 0) continue;
    const pct = (g.monto / limTotal) * 100;
    if (pct > 25) {
      out.push({
        tipo: 'compra_grande',
        titulo: `💸 Compra grande en ${t.nombre}`,
        detalle: `"${g.descripcion}" por ${fmt.format(g.monto)} representa ${pct.toFixed(0)}% del límite de la tarjeta.`,
        severidad: pct > 40 ? 'critical' : 'warning',
        tarjeta_id: t.id,
        monto_implicado: g.monto,
        sugerencia: pct > 40 ? 'Considerá refinanciar o pagar parte antes del cierre.' : 'Tenelo en cuenta para próximas compras.',
      });
    }
  }

  // Ordenar por severidad
  const orden = { critical: 0, warning: 1, info: 2 };
  out.sort((a,b)=> (orden[a.severidad]??9) - (orden[b.severidad]??9));
  return out;
}

export function diagnosticar(gastos, { sensibilidad = 'moderado', mesesAnalisis = 6 } = {}) {
  const params = PARAMS[sensibilidad] || PARAMS.moderado;
  const hoy = new Date();
  const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

  // Indexación
  const porMesCat = new Map();   // "YYYY-MM|categoria" -> monto
  const porMesTotal = new Map(); // "YYYY-MM" -> monto
  const categorias = new Set();
  const pequenos = [];

  for (const g of gastos) {
    if (g.deleted) continue;
    if (!g.fecha) continue;
    const mk = monthKey(g.fecha);
    const m = montoEfectivo(g);
    const cat = g.categoria || 'general';
    porMesCat.set(`${mk}|${cat}`, (porMesCat.get(`${mk}|${cat}`) || 0) + m);
    porMesTotal.set(mk, (porMesTotal.get(mk) || 0) + m);
    categorias.add(cat);
    if (g.monto <= params.umbral_hormiga_max) pequenos.push(g);
  }

  const meses = [...porMesTotal.keys()].sort();
  const recientes = meses.slice(-mesesAnalisis);
  if (recientes.length === 0) return [];

  const fmt = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits: 0 });
  const out = [];

  // ---- 1. Desvíos por categoría ----
  for (const cat of categorias) {
    const serie = recientes
      .filter(m => m !== mesActual)
      .map(m => porMesCat.get(`${m}|${cat}`) || 0)
      .filter(v => v > 0);
    if (serie.length < 2) continue;
    const mu = mean(serie);
    const sigma = pstdev(serie);
    const actual = porMesCat.get(`${mesActual}|${cat}`) || 0;
    const umbral = mu + params.k_sigma * sigma;
    if (actual > umbral && actual > 0) {
      const exceso = actual - mu;
      out.push({
        tipo: 'desvio_estandar',
        titulo: `Desvío en ${cat}`,
        detalle: `Este mes gastaste ${fmt.format(actual)} en ${cat}, contra una media de ${fmt.format(mu)} (σ=${fmt.format(sigma)}). Exceso de ${fmt.format(exceso)}.`,
        severidad: actual < mu + 2*sigma ? 'warning' : 'critical',
        categoria: cat,
        monto_implicado: round2(actual),
        sugerencia: `Recortar ~${Math.max(5, Math.round(100*(actual-umbral)/actual))}% en ${cat} te devuelve al rango normal.`,
      });
    }
  }

  // ---- 2. Gasto hormiga ----
  const pequenosMes = pequenos.filter(g => g.fecha.startsWith(mesActual));
  if (pequenosMes.length >= params.freq_hormiga) {
    const total = pequenosMes.reduce((a,g)=>a+g.monto,0);
    const prom = total / pequenosMes.length;
    out.push({
      tipo: 'gasto_hormiga',
      titulo: `${pequenosMes.length} micro-consumos detectados`,
      detalle: `Llevás ${pequenosMes.length} gastos chicos (prom ${fmt.format(prom)}) sumando ${fmt.format(total)} este mes. Proyección anual: ${fmt.format(total*12)}.`,
      severidad: total < 30000 ? 'info' : 'warning',
      monto_implicado: round2(total),
      sugerencia: 'Asignales un sobre mensual fijo y cortá el sangrado.',
    });
  }

  // ---- 3. Categoría nueva con peso ----
  const totalMes = porMesTotal.get(mesActual) || 0;
  if (totalMes > 0) {
    for (const cat of categorias) {
      const actual = porMesCat.get(`${mesActual}|${cat}`) || 0;
      const previos = recientes
        .filter(m => m !== mesActual)
        .reduce((a,m)=> a + (porMesCat.get(`${m}|${cat}`) || 0), 0);
      if (actual > 0 && previos === 0) {
        const porc = (100*actual)/totalMes;
        if (porc > 10) {
          out.push({
            tipo: 'categoria_anomala',
            titulo: `Nueva categoría: ${cat}`,
            detalle: `Apareció '${cat}' este mes con ${fmt.format(actual)} (${porc.toFixed(1)}% del egreso mensual). Sin historial previo.`,
            severidad: 'info',
            categoria: cat,
            monto_implicado: round2(actual),
            sugerencia: 'Verificá que sea un gasto deseado y categorizalo bien.',
          });
        }
      }
    }
  }

  // ---- 4. Racha negativa ----
  if (recientes.length >= 4) {
    const previos = recientes.slice(0, -1);
    const serie = previos.map(m => porMesTotal.get(m) || 0);
    const mu = serie.length ? mean(serie) : 0;
    let consec = 0;
    for (let i = previos.length - 1; i >= 0; i--) {
      if ((porMesTotal.get(previos[i]) || 0) > mu) consec++;
      else break;
    }
    if (consec >= 3) {
      out.push({
        tipo: 'racha',
        titulo: `${consec} meses por encima de media`,
        detalle: `Tu egreso lleva ${consec} meses por encima del promedio (${fmt.format(mu)}). Patrón de escalada confirmado.`,
        severidad: 'critical',
        sugerencia: 'Revisá el top 5 de categorías y recortá la #1.',
      });
    }
  }

  const orden = { critical: 0, warning: 1, info: 2 };
  out.sort((a,b)=> (orden[a.severidad]??9) - (orden[b.severidad]??9));
  return out;
}

function round2(n) { return Math.round(n*100)/100; }
