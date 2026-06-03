/**
 * test-chart-colors.mjs — Verifica que los gráficos Chart.js sigan el color de
 * acento custom y se adapten al tema claro/oscuro (sin colores hardcodeados).
 *
 * Uso: node tests/test-chart-colors.mjs [puerto]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const PORT = process.argv[2] || '8080';
const BASE = `http://localhost:${PORT}`;
const OUT = 'tests/_shots';
mkdirSync(OUT, { recursive: true });
const DEVICE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

// Acento custom bien distinto del default (naranja) para notar si los charts lo siguen
const ACENTO = '#ff7a18';

async function seed(page) {
  await page.evaluate(async () => {
    const { DB } = await import('/js/db.js');
    const ts = Math.floor(Date.now()/1000);
    const mes = new Date().toISOString().slice(0,7);
    await DB.put('ingresos', { id:'i1', fecha:mes+'-01', periodo_aplicacion:mes, sueldo_neto:750000, bonos:50000, descripcion:'Sueldo', updated_at:ts });
    await DB.put('cuentas', { id:'c1', nombre:'Caja Ahorro', tipo:'caja_ahorro', saldo_inicial:200000, color:'#3b82f6', activa:true, updated_at:ts });
    await DB.put('metas', { id:'m1', nombre:'Vacaciones', monto_objetivo:500000, monto_actual:200000, prioridad:4, updated_at:ts });
    const cats=['comida','combustible','restaurante','ocio','servicios'];
    for (let i=1;i<=10;i++) await DB.put('gastos', { id:'g'+i, fecha:`${mes}-${String((i%27)+1).padStart(2,'0')}`, monto:15000*i, descripcion:'Gasto '+i, categoria:cats[i%cats.length], moneda:'ARS', metodo_pago:'efectivo', tipo:'unico', updated_at:ts });
  });
}

async function configurar(page, tema, acento) {
  await page.evaluate(async ({ t, a }) => {
    const { DB } = await import('/js/db.js');
    const aj = await DB.get('ajustes','ajustes_globales');
    aj.ui = aj.ui || {};
    aj.ui.tema = t;
    aj.ui.colores = { brand: a };   // color de acento custom
    await DB.put('ajustes', aj);
  }, { t: tema, a: acento });
}

const b = await chromium.launch();
const errores = [];
const resultados = [];

for (const tema of ['oscuro','claro']) {
  const ctx = await b.newContext(DEVICE);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type()==='error') errores.push(`[${tema}] ${m.text()}`); });
  page.on('pageerror', e => errores.push(`[${tema}] PAGEERROR ${e.message}`));

  await page.goto(`${BASE}/?reset`, { waitUntil:'networkidle' }); await page.waitForTimeout(1800);
  await seed(page); await configurar(page, tema, ACENTO);
  await page.goto(`${BASE}/`, { waitUntil:'networkidle' }); await page.waitForTimeout(1800);

  // Capturar dashboard (incluye chart de balance + categorías)
  await page.screenshot({ path:`${OUT}/chart_${tema}_dashboard.png`, fullPage:true });

  // Comprobar que la var --brand resuelta == acento custom
  const brandVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand').trim());

  // Leer el color real del dataset "Balance" del chart (debe seguir --brand)
  const balanceColor = await page.evaluate(() => {
    const cv = document.querySelector('[data-bind="balance-canvas"]');
    if (!cv || !window.Chart) return null;
    const ch = Chart.getChart(cv);
    if (!ch) return null;
    const ds = ch.data.datasets.find(d => /Balance/i.test(d.label));
    return ds ? ds.borderColor : null;
  });

  resultados.push({ tema, brandVar, balanceColor });
  await ctx.close();
}
await b.close();

console.log('Acento custom aplicado:', ACENTO);
for (const r of resultados) {
  console.log(`  [${r.tema}] --brand=${r.brandVar}  balanceChart.borderColor=${r.balanceColor}`);
}
const ok = resultados.every(r => (r.brandVar||'').toLowerCase().includes('ff7a18') &&
                                  (r.balanceColor||'').toLowerCase().includes('ff7a18'));
console.log('Charts siguen el acento custom:', ok ? 'SÍ ✓' : 'NO ✗');
console.log('Errores de consola:', errores.length ? errores : 'NINGUNO');
process.exit((ok && !errores.length) ? 0 : 1);
