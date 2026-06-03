/**
 * visual-harness.mjs — Harness de verificación visual que replica el RUNTIME real.
 *
 * Diferencias clave con tests anteriores: usa el viewport de un móvil real,
 * cambia el tema usando el MISMO mecanismo que la app (ajustes.ui.tema + aplicarTema),
 * y siembra datos representativos para que cada pestaña tenga contenido real.
 *
 * Uso:  node tests/visual-harness.mjs [puerto]   (servidor python en ese puerto)
 * Produce capturas en tests/_shots/ para revisión manual.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const PORT = process.argv[2] || '8140';
const BASE = `http://localhost:${PORT}`;
const OUT = 'tests/_shots';
mkdirSync(OUT, { recursive: true });

// iPhone 12/13 (lo que usa el usuario): 390x844 @3x
const DEVICE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

async function seed(page) {
  await page.evaluate(async () => {
    const { DB } = await import('/js/db.js');
    const ts = Math.floor(Date.now()/1000);
    const mes = new Date().toISOString().slice(0,7);
    await DB.put('ingresos', { id:'i1', fecha:mes+'-01', periodo_aplicacion:mes, sueldo_neto:750000, bonos:50000, descripcion:'Sueldo', updated_at:ts });
    const mk=(id,n,b,c,dc,dv)=>({id,nombre:n,banco:b,color:c,dia_cierre:dc,dia_vencimiento:dv,activa:true,limite_un_pago:5000000,limite_cuotas:0,ciclos_custom:[],ciclos_pagados:[],updated_at:ts});
    await DB.put('tarjetas', mk('t1','BBVA','BBVA','#ffea00',28,6));
    await DB.put('tarjetas', mk('t2','Macro','Macro','#00f0ff',25,6));
    await DB.put('cuentas', { id:'c1', nombre:'Caja Ahorro', tipo:'caja_ahorro', saldo_inicial:200000, color:'#3b82f6', activa:true, updated_at:ts });
    await DB.put('metas', { id:'m1', nombre:'Vacaciones', monto_objetivo:500000, monto_actual:200000, prioridad:4, updated_at:ts });
    const cats=['comida','combustible','restaurante','ocio','servicios'];
    for (let i=1;i<=8;i++) await DB.put('gastos', { id:'g'+i, fecha:`${mes}-0${(i%9)||1}`, monto:15000*i, descripcion:'Gasto '+i, categoria:cats[i%cats.length], subcategoria:i%2?'Delivery':null, moneda:'ARS', metodo_pago:i%3?'efectivo':'credito', tarjeta_id:i%3?null:'t1', tipo:'unico', updated_at:ts });
  });
}

async function setTheme(page, tema) {
  await page.evaluate(async (t) => {
    const { DB } = await import('/js/db.js');
    const aj = await DB.get('ajustes','ajustes_globales'); aj.ui.tema = t; await DB.put('ajustes', aj);
  }, tema);
}

const b = await chromium.launch();
const errores = [];
for (const tema of ['oscuro','claro']) {
  const ctx = await b.newContext(DEVICE);
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type()==='error') errores.push(`[${tema}] ${m.text()}`); });
  page.on('pageerror', e => errores.push(`[${tema}] PAGEERROR ${e.message}`));
  await page.goto(`${BASE}/?reset`, { waitUntil:'networkidle' }); await page.waitForTimeout(2000);
  await seed(page); await setTheme(page, tema);
  await page.goto(`${BASE}/`, { waitUntil:'networkidle' }); await page.waitForTimeout(1800);

  // Capturar cada pestaña
  const tabs = [['home','dashboard'],['gastos','historial'],['tarjetas','tarjetas'],['metas','metas']];
  for (const [tab,nombre] of tabs) {
    await page.evaluate(t => document.querySelector(`[data-tab="${t}"]`)?.click(), tab);
    await page.waitForTimeout(700);
    await page.screenshot({ path:`${OUT}/${tema}_${nombre}.png`, fullPage:true });
  }
  // Ajustes (panel general con colores)
  await page.evaluate(() => document.querySelector('[data-tab="home"]')?.click()); await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('btn-settings')?.click()); await page.waitForTimeout(500);
  await page.screenshot({ path:`${OUT}/${tema}_ajustes.png` });
  await ctx.close();
}
await b.close();
console.log('Capturas en', OUT);
console.log('Errores de consola:', errores.length ? errores : 'NINGUNO');
process.exit(errores.length ? 1 : 0);
