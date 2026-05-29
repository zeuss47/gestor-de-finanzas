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
