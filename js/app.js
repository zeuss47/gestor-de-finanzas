/**
 * app.js
 * ------
 * Orquestador del frontend. Responsable de:
 *   - Cargar/persistir ajustes globales.
 *   - Registrar el Service Worker.
 *   - Renderizar los widgets configurados.
 *   - Manejar diálogos (gasto, ingreso, tarjeta, meta, settings).
 *   - Gestionar gastos compartidos (cálculo del saldo cruzado).
 *   - Disparar notificaciones tras cada movimiento.
 *   - Coordinar la sincronización con GitHub.
 *
 * Toda la lógica de cálculo vive en módulos separados (cards.js, ai-local.js,
 * sync.js); este archivo es la "vista" + el "controlador" en MVC clásico.
 */

import { DB, uuid, nowTs } from './db.js';
import { resumenTarjeta, fechasCiclo, rangoCicloActual, cicloDelGasto } from './cards.js';
import { diagnosticar } from './ai-local.js';
import { proyectarBalance, predecirSaturacionTarjetas, sugerirCategoria } from './ai-predict.js';
import { Notif, chequeoDiarioTarjetas } from './notifications.js';
import { syncAll, pullAll, startAutoSync, stopAutoSync, programarPush, triggerSync, ultimaSync } from './sync.js';

/* ============ Estado en memoria (cache de render) ============ */
const state = {
  ajustes: null,
  gastos: [],
  ingresos: [],
  tarjetas: [],
  metas: [],
  resumenes: [],     // resúmenes de tarjetas precomputados
  estado: null,      // estado global
  diagnosticos: [],
};

const FMT = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

/* ============ Estado de navegación por tabs ============ */
let currentTab = 'home';
let _movMesFiltro = '';

const WIDGETS_ANALISIS = new Set([
  'prediccion', 'ia_local', 'comparador', 'flujo_mensual',
  'categorias', 'resumen_anual', 'grafico',
]);

function switchTab(tab) {
  currentTab = tab;
  const root  = document.getElementById('main-widgets');
  const secMov = document.getElementById('section-movimientos');

  // Reset clases de modo
  document.body.classList.remove('view-analisis');

  if (tab === 'gastos') {
    root.classList.add('hidden');
    secMov?.classList.remove('hidden');
    renderMovimientos();
    return;
  }

  // Tabs que muestran el dashboard
  root.classList.remove('hidden');
  secMov?.classList.add('hidden');

  if (tab === 'analisis') {
    // Filtrar visualmente: solo widgets analíticos
    document.body.classList.add('view-analisis');
    // Ocultar widgets no-analíticos via data attribute
    root.querySelectorAll('.widget[data-widget]').forEach(w => {
      const id = w.dataset.widget;
      w.classList.toggle('widget-hidden-analisis', !WIDGETS_ANALISIS.has(id));
    });
    // Scroll al inicio para que se vean los analíticos
    const mainArea = document.getElementById('main-area');
    if (mainArea) mainArea.scrollTop = 0;
  } else {
    // Mostrar todos los widgets (dashboard normal)
    root.querySelectorAll('.widget[data-widget]').forEach(w => {
      w.classList.remove('widget-hidden-analisis');
    });
  }
}

/* ============ Ajustes por defecto ============ */
const AJUSTES_DEFAULT = {
  id: 'ajustes_globales',
  updated_at: 0,
  github: { pat: null, owner: null, repo: null, branch: 'main', ruta_datos: 'data' },
  notificaciones: { habilitadas: true, alertas_tarjeta_dias: [5,2,1], confirmar_movimientos: true, alertas_ia: true },
  ui: {
    tema: 'auto',
    color_primario: '#4f46e5',
    widgets_visibles: ['estado_global','cuentas','tarjetas','simulacion_credito','prediccion','ia_local','metas','grafico','resumen_anual','flujo_mensual','categorias','tipo_cambio','calculadora','comparador'],
    widgets_orden: ['estado_global','cuentas','tarjetas','simulacion_credito','prediccion','ia_local','metas','grafico','resumen_anual','flujo_mensual','categorias','tipo_cambio','calculadora','comparador'],
    widgets_tamanos: {
      estado_global: 'lg',
      cuentas:       'md',
      tarjetas:      'md',
      simulacion_credito: 'md',
      prediccion:    'lg',
      ia_local:      'md',
      metas:         'md',
      grafico:       'lg',
      resumen_anual: 'lg',
      flujo_mensual: 'lg',
      categorias:    'md',
      tipo_cambio:   'md',
      calculadora:   'sm',
      comparador:    'md',
    },
  },
  sensibilidad_ia: 'moderado',
  moneda: 'ARS',
  tipos_cambio: {
    USD: { nombre: 'Dólar oficial', valor: 1100, simbolo: '🇺🇸' },
    USD_BLUE: { nombre: 'Dólar blue', valor: 1450, simbolo: '💵' },
    EUR: { nombre: 'Euro', valor: 1200, simbolo: '🇪🇺' },
    BRL: { nombre: 'Real', valor: 220,  simbolo: '🇧🇷' },
  },
  catalogos: {
    categorias_gasto: [
      { id: 'comida',       nombre: 'Comida',       icono: '🛒', color: '#10b981' },
      { id: 'combustible',  nombre: 'Combustible',  icono: '⛽', color: '#f59e0b' },
      { id: 'hogar',        nombre: 'Hogar',        icono: '🏠', color: '#a78bfa' },
      { id: 'ocio',         nombre: 'Ocio',         icono: '🎬', color: '#ec4899' },
      { id: 'restaurante',  nombre: 'Restaurante',  icono: '🍽', color: '#fb923c' },
      { id: 'salud',        nombre: 'Salud',        icono: '💊', color: '#f43f5e' },
      { id: 'ropa',         nombre: 'Ropa',         icono: '👗', color: '#c084fc' },
      { id: 'transporte',   nombre: 'Transporte',   icono: '🚌', color: '#38bdf8' },
      { id: 'servicios',    nombre: 'Servicios',    icono: '💡', color: '#facc15' },
      { id: 'kiosco',       nombre: 'Kiosco',       icono: '🥤', color: '#f87171' },
      { id: 'educacion',    nombre: 'Educación',    icono: '📚', color: '#22d3ee' },
      { id: 'general',      nombre: 'General',      icono: '📌', color: '#94a3b8' },
    ],
    categorias_ingreso: [
      { id: 'sueldo',       nombre: 'Sueldo',       icono: '💼', color: '#10b981' },
      { id: 'freelance',    nombre: 'Freelance',    icono: '💻', color: '#00f0ff' },
      { id: 'bonos',        nombre: 'Bonos',        icono: '🎁', color: '#facc15' },
      { id: 'inversiones',  nombre: 'Inversiones',  icono: '📈', color: '#a78bfa' },
      { id: 'alquiler',     nombre: 'Alquiler',     icono: '🏘', color: '#fb923c' },
      { id: 'venta',        nombre: 'Venta',        icono: '🏷', color: '#ec4899' },
      { id: 'otros',        nombre: 'Otros',        icono: '✨', color: '#94a3b8' },
    ],
  },
};

async function loadAjustes() {
  let aj = await DB.get('ajustes', 'ajustes_globales');
  if (!aj) {
    aj = structuredClone(AJUSTES_DEFAULT);
    await DB.put('ajustes', aj);
  }
  state.ajustes = aj;
  return aj;
}
async function saveAjustes(patch) {
  const prevPat = state.ajustes?.github?.pat;
  state.ajustes = { ...state.ajustes, ...patch, updated_at: nowTs() };
  await DB.put('ajustes', state.ajustes);
  aplicarTema();
  // Si cambió la config de GitHub, reiniciamos auto-sync
  const newPat = state.ajustes?.github?.pat;
  if (prevPat !== newPat || patch.github) {
    if (typeof reiniciarAutoSync === 'function') reiniciarAutoSync();
  }
}

/* ============ Tema ============ */
function aplicarTema() {
  const tema = state.ajustes?.ui?.tema || 'auto';
  const html = document.documentElement;
  // "oscuro" es el default visual; "claro" aplica la clase light
  const esClaro = tema === 'claro' || (tema === 'auto' && !matchMedia('(prefers-color-scheme: dark)').matches);
  html.classList.toggle('light', esClaro);
  const color = state.ajustes?.ui?.color_primario || '#6366f1';
  document.documentElement.style.setProperty('--brand', color);
  document.getElementById('meta-theme')?.setAttribute('content', esClaro ? '#f0f4ff' : '#07090f');
}

/* ============ Carga inicial ============ */
async function reloadAll() {
  state.gastos   = await DB.live('gastos');
  state.ingresos = await DB.live('ingresos');
  state.tarjetas = await DB.live('tarjetas');
  state.cuentas  = await DB.live('cuentas');
  state.metas    = await DB.live('metas');

  // Resúmenes de tarjeta
  state.resumenes = state.tarjetas
    .filter(t => t.activa !== false)
    .map(t => resumenTarjeta(t, state.gastos));

  // Estado global (cálculo local, sin backend)
  state.estado = computarEstadoGlobal();

  // Diagnósticos IA
  state.diagnosticos = diagnosticar(state.gastos, {
    sensibilidad: state.ajustes?.sensibilidad_ia || 'moderado',
  });

  renderWidgets();
  if (currentTab === 'gastos') renderMovimientos();
  actualizarSidebar();
  actualizarKpiStrip();
  actualizarRightPanel();
}

/* ============ Estado global local (espeja /api/estado) ============ */
function computarEstadoGlobal() {
  const hoy = new Date();
  const mk = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

  const ingresosMes = state.ingresos
    .filter(i => i.periodo_aplicacion === mk)
    .reduce((a,i) => a + (i.sueldo_neto || 0) + (i.bonos || 0), 0);

  let egresosMes = 0;
  let egresosLiquidos = 0;
  for (const g of state.gastos) {
    if (!g.fecha?.startsWith(mk)) continue;
    if (g.tipo === 'amortizacion' || g.es_amortizacion_anual) {
      egresosMes += g.monto / 12;
      continue;
    }
    let monto = g.monto;
    if (g.compartido) monto = monto * (1 - (g.compartido.porcentaje_otro || 0)/100);
    egresosMes += monto;
    if (!g.tarjeta_id) egresosLiquidos += monto;
  }
  const deudaTarjetas = state.resumenes.reduce((a,r)=> a + r.total_resumen, 0);
  const liquido = ingresosMes - egresosLiquidos;
  const proyectado = liquido - deudaTarjetas;

  // Promedio 3 meses anteriores
  const buckets = new Map();
  for (const g of state.gastos) {
    if (!g.fecha) continue;
    const k = g.fecha.slice(0,7);
    if (k === mk) continue;
    let m = g.monto;
    if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0)/100);
    if (g.tipo === 'amortizacion') m = m/12;
    buckets.set(k, (buckets.get(k)||0) + m);
  }
  const last3 = [...buckets.keys()].sort().slice(-3);
  const prom3 = last3.length ? last3.reduce((a,k)=>a+buckets.get(k),0)/last3.length : 0;

  return {
    saldo_liquido: liquido,
    saldo_proyectado: proyectado,
    ingresos_netos_mes: ingresosMes,
    egresos_mes: egresosMes,
    promedio_egresos_3m: prom3,
    margen_libre_mes: ingresosMes - egresosMes,
    periodo: mk,
  };
}

/* ============ RENDER WIDGETS ============ */
const RENDERERS = {
  estado_global:      renderEstado,
  cuentas:            renderCuentas,
  tarjetas:           renderTarjetas,
  simulacion_credito: renderCredito,
  ia_local:           renderIA,
  metas:              renderMetas,
  grafico:            renderGrafico,
  resumen_anual:      renderResumenAnual,
  flujo_mensual:      renderFlujoMensual,
  categorias:         renderCategorias,
  tipo_cambio:        renderTipoCambio,
  calculadora:        renderCalculadora,
  comparador:         renderComparador,
  prediccion:         renderPrediccion,
};

const TPL = {
  estado_global:      'tpl-widget-estado',
  cuentas:            'tpl-widget-cuentas',
  tarjetas:           'tpl-widget-tarjetas',
  simulacion_credito: 'tpl-widget-credito',
  ia_local:           'tpl-widget-ia',
  metas:              'tpl-widget-metas',
  grafico:            'tpl-widget-grafico',
  resumen_anual:      'tpl-widget-resumen_anual',
  flujo_mensual:      'tpl-widget-flujo_mensual',
  categorias:         'tpl-widget-categorias',
  tipo_cambio:        'tpl-widget-tipo_cambio',
  calculadora:        'tpl-widget-calculadora',
  comparador:         'tpl-widget-comparador',
  prediccion:         'tpl-widget-prediccion',
};

function renderWidgets() {
  const root = document.getElementById('main-widgets');
  root.innerHTML = '';
  const orden = state.ajustes?.ui?.widgets_orden?.length
    ? state.ajustes.ui.widgets_orden
    : Object.keys(TPL);
  const visibles = new Set(state.ajustes?.ui?.widgets_visibles || Object.keys(TPL));
  for (const id of orden) {
    if (!visibles.has(id)) continue;
    const tpl = document.getElementById(TPL[id]);
    if (!tpl) continue;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.widget = id;
    const tamano = state.ajustes?.ui?.widgets_tamanos?.[id] || 'md';
    node.dataset.size = tamano;

    // Aplicar span/row guardados (drag resize)
    const span    = state.ajustes?.ui?.widgets_spans?.[id];
    const rowSpan = state.ajustes?.ui?.widgets_rows?.[id];
    if (span)    node.style.gridColumn = `span ${span}`;
    if (rowSpan) node.style.gridRow    = `span ${rowSpan}`;

    root.appendChild(node);
    RENDERERS[id]?.(node);

    // Inyectar botón de resize en el header del widget si tiene <header>
    const header = node.querySelector('header');
    if (header) {
      const resizeBtn = document.createElement('div');
      resizeBtn.className = 'widget-resize-control';
      resizeBtn.innerHTML = `
        <button type="button" class="wsize-btn" data-size="sm" title="Chico">▭</button>
        <button type="button" class="wsize-btn" data-size="md" title="Mediano">▬</button>
        <button type="button" class="wsize-btn" data-size="lg" title="Grande">▮</button>
        <button type="button" class="wsize-btn" data-action="reset-size" title="Resetear tamaño libre">↺</button>
      `;
      resizeBtn.querySelectorAll('.wsize-btn').forEach(b => {
        if (b.dataset.size) {
          b.classList.toggle('active', b.dataset.size === tamano);
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            await cambiarTamanoWidget(id, b.dataset.size);
          });
        } else if (b.dataset.action === 'reset-size') {
          b.addEventListener('click', async (e) => {
            e.stopPropagation();
            // Limpiar spans custom y restablecer tamaño "md"
            if (!state.ajustes.ui.widgets_spans) state.ajustes.ui.widgets_spans = {};
            if (!state.ajustes.ui.widgets_rows)  state.ajustes.ui.widgets_rows  = {};
            delete state.ajustes.ui.widgets_spans[id];
            delete state.ajustes.ui.widgets_rows[id];
            await DB.put('ajustes', state.ajustes);
            renderWidgets();
            toast('Tamaño restaurado');
          });
        }
      });
      header.appendChild(resizeBtn);
    }

    // Resize handle libre (drag desde esquina inferior-derecha)
    const handle = document.createElement('div');
    handle.className = 'widget-resize-handle';
    handle.title = 'Arrastrá para redimensionar';
    node.appendChild(handle);
    iniciarDragResize(handle, node, id);

    // Click en el cuerpo del widget abre el historial (excluyendo botones internos)
    node.addEventListener('click', (e) => {
      if (e.target.closest('button, select, input, [data-action], .hd-quick-btn, [data-tarjeta-id], .widget-resize-handle')) {
        return;
      }
      abrirHistorialWidget(id);
    });
  }
}

/* ============ Drag resize libre desde la esquina ============ */
function iniciarDragResize(handle, widgetNode, widgetId) {
  let startX, startY, startCols, startRows, tooltip, gridColsTotal;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    widgetNode.classList.add('resizing');

    // Detectar cuántas columnas tiene el grid actual
    const grid = document.getElementById('main-widgets');
    const gridStyle = getComputedStyle(grid);
    const tplCols   = gridStyle.gridTemplateColumns.split(' ').length || 6;
    gridColsTotal   = tplCols;

    // Span actual del widget (en columnas del grid)
    const rect = widgetNode.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const gap = parseFloat(gridStyle.gap) || 16;
    const colWidth = (gridRect.width - gap * (tplCols - 1)) / tplCols;

    startX = e.clientX;
    startY = e.clientY;
    startCols = Math.max(1, Math.round((rect.width + gap) / (colWidth + gap)));
    startRows = Math.max(1, Math.round(rect.height / 80));

    // Tooltip flotante
    tooltip = document.createElement('div');
    tooltip.className = 'resize-tooltip';
    document.body.appendChild(tooltip);
    actualizarTooltip(e.clientX, e.clientY, startCols, startRows);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!widgetNode.classList.contains('resizing')) return;
    e.preventDefault();

    const grid = document.getElementById('main-widgets');
    const gridStyle = getComputedStyle(grid);
    const gridRect  = grid.getBoundingClientRect();
    const gap = parseFloat(gridStyle.gap) || 16;
    const colWidth = (gridRect.width - gap * (gridColsTotal - 1)) / gridColsTotal;

    const dxCols = Math.round((e.clientX - startX) / (colWidth + gap));
    const dyRows = Math.round((e.clientY - startY) / 80);

    const newCols = Math.max(1, Math.min(gridColsTotal, startCols + dxCols));
    const newRows = Math.max(1, Math.min(12, startRows + dyRows));

    widgetNode.style.gridColumn = `span ${newCols}`;
    widgetNode.style.gridRow    = `span ${newRows}`;

    actualizarTooltip(e.clientX, e.clientY, newCols, newRows);
  });

  const finalize = async (e) => {
    if (!widgetNode.classList.contains('resizing')) return;
    widgetNode.classList.remove('resizing');
    if (tooltip) { tooltip.remove(); tooltip = null; }
    try { handle.releasePointerCapture(e.pointerId); } catch {}

    // Persistir span/row finales
    const colMatch = widgetNode.style.gridColumn.match(/span (\d+)/);
    const rowMatch = widgetNode.style.gridRow.match(/span (\d+)/);
    const cols = colMatch ? parseInt(colMatch[1]) : null;
    const rows = rowMatch ? parseInt(rowMatch[1]) : null;

    if (!state.ajustes.ui.widgets_spans) state.ajustes.ui.widgets_spans = {};
    if (!state.ajustes.ui.widgets_rows)  state.ajustes.ui.widgets_rows  = {};
    if (cols) state.ajustes.ui.widgets_spans[widgetId] = cols;
    if (rows) state.ajustes.ui.widgets_rows[widgetId]  = rows;
    await DB.put('ajustes', state.ajustes);

    // Forzar re-render de Chart.js para que ajuste el canvas
    setTimeout(() => {
      const tpl = document.getElementById(TPL[widgetId]);
      if (tpl && RENDERERS[widgetId]) {
        // Re-renderizar solo este widget para refrescar charts
        RENDERERS[widgetId](widgetNode);
      }
    }, 100);
  };

  handle.addEventListener('pointerup', finalize);
  handle.addEventListener('pointercancel', finalize);

  function actualizarTooltip(x, y, cols, rows) {
    if (!tooltip) return;
    tooltip.textContent = `${cols} × ${rows}`;
    tooltip.style.left = (x + 14) + 'px';
    tooltip.style.top  = (y + 14) + 'px';
  }
}

async function cambiarTamanoWidget(widgetId, size) {
  if (!state.ajustes.ui) state.ajustes.ui = {};
  if (!state.ajustes.ui.widgets_tamanos) state.ajustes.ui.widgets_tamanos = {};
  state.ajustes.ui.widgets_tamanos[widgetId] = size;
  // Al elegir tamaño preset, limpiamos cualquier span/row custom
  if (state.ajustes.ui.widgets_spans) delete state.ajustes.ui.widgets_spans[widgetId];
  if (state.ajustes.ui.widgets_rows)  delete state.ajustes.ui.widgets_rows[widgetId];
  await DB.put('ajustes', state.ajustes);
  // Re-renderizar solo el widget afectado sin perder otros estados
  const node = document.querySelector(`[data-widget="${widgetId}"]`);
  if (node) {
    node.dataset.size = size;
    // Actualizar botones activos
    node.querySelectorAll('.wsize-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.size === size);
    });
  }
  // Para widgets que tienen gráficos Chart.js, necesitamos re-renderizar
  // porque el canvas resize no es automático. Solo re-render del widget afectado:
  setTimeout(() => {
    const tpl = document.getElementById(TPL[widgetId]);
    if (tpl && RENDERERS[widgetId]) {
      // Mejor: re-renderizar TODO porque algunos widgets tienen chart
      renderWidgets();
    }
  }, 250);
}

function renderEstado(el) {
  const e = state.estado;
  const bind = (sel, val, colorFn) => {
    const node = el.querySelector(sel);
    if (!node) return;
    node.textContent = val;
    if (colorFn) node.style.color = colorFn(val);
  };
  bind('[data-bind="liquido"]',   FMT.format(e.saldo_liquido),
    () => e.saldo_liquido >= 0   ? 'var(--ink)' : 'var(--danger)');
  bind('[data-bind="proyectado"]',FMT.format(e.saldo_proyectado),
    () => e.saldo_proyectado >= 0 ? 'var(--ink)' : 'var(--danger)');
  bind('[data-bind="periodo"]',   e.periodo);
  bind('[data-bind="ingresos"]',  FMT.format(e.ingresos_netos_mes));
  bind('[data-bind="egresos"]',   FMT.format(e.egresos_mes));
  bind('[data-bind="prom3m"]',    FMT.format(e.promedio_egresos_3m));
}

function renderCuentas(el) {
  const box = el.querySelector('[data-bind="accounts-list"]');
  if (!box) return;
  box.innerHTML = '';
  const cuentas = state.cuentas || [];
  if (cuentas.length === 0) {
    box.innerHTML = `<p class="text-xs text-center py-4" style="color:var(--ink-muted)">Sin cuentas. Tocá "+ Nueva".</p>`;
  }
  const TIPOS = {
    caja_ahorro:    { icon: '🏦', label: 'Caja ahorro' },
    cuenta_corriente:{ icon: '💼', label: 'Cta corriente' },
    billetera:      { icon: '📱', label: 'Billetera' },
    efectivo:       { icon: '💵', label: 'Efectivo' },
    inversion:      { icon: '📈', label: 'Inversión' },
    cripto:         { icon: '₿',  label: 'Cripto' },
  };
  for (const c of cuentas) {
    const t = TIPOS[c.tipo] || TIPOS.caja_ahorro;
    const saldo = calcularSaldoCuenta(c);
    const color = c.color || 'var(--brand)';
    box.insertAdjacentHTML('beforeend', `
      <div class="account-card" data-cuenta-id="${c.id}">
        <div class="account-card-icon" style="background:${color}22;color:${color}">${t.icon}</div>
        <div class="account-card-info">
          <p class="account-card-name">${escapeHtml(c.nombre)}</p>
          <p class="account-card-bank">${escapeHtml(c.banco || t.label)}</p>
        </div>
        <span class="account-card-saldo" style="color:${saldo>=0?'var(--success)':'var(--danger)'}">
          ${FMT.format(saldo)}
        </span>
      </div>
    `);
  }
  el.querySelector('[data-action="add-account"]').onclick = () => openDialog('dlg-cuenta');
}

function calcularSaldoCuenta(cuenta) {
  let saldo = cuenta.saldo_inicial || 0;
  for (const i of state.ingresos) {
    if (i.deleted || i.cuenta_id !== cuenta.id) continue;
    saldo += (i.sueldo_neto || 0) + (i.bonos || 0);
  }
  for (const g of state.gastos) {
    if (g.deleted || g.cuenta_id !== cuenta.id) continue;
    // Solo afecta saldo de cuenta si NO está en tarjeta
    if (g.tarjeta_id) continue;
    let m = g.monto;
    if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0) / 100);
    saldo -= m;
  }
  return saldo;
}

function renderTarjetas(el) {
  const box = el.querySelector('[data-bind="cards"]');
  box.innerHTML = '';
  if (state.resumenes.length === 0) {
    box.innerHTML = `
      <div class="flex flex-col items-center py-6 gap-2" style="color:var(--ink-muted)">
        <svg class="w-10 h-10 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3">
          <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
        </svg>
        <p class="text-sm">Sin tarjetas. Tocá "+ Nueva".</p>
      </div>`;
  }
  for (const r of state.resumenes) {
    const t   = state.tarjetas.find(x => x.id === r.tarjeta_id);
    const pct = Math.min(100, r.porcentaje_limite_usado);
    const urgente = r.dias_para_cierre <= 2 || r.dias_para_vencimiento <= 2;
    const claseUrgente = urgente ? 'pulse-warn' : '';
    // Colores derivados del color de la tarjeta
    const colorBase = t.color || '#6366f1';
    const diasC = r.dias_para_cierre;
    const diasV = r.dias_para_vencimiento;
    const badgeCierre = diasC <= 1 ? 'badge-danger' : diasC <= 5 ? 'badge-warning' : 'badge-muted';
    const badgeVenc   = diasV <= 1 ? 'badge-danger' : diasV <= 5 ? 'badge-warning' : 'badge-muted';

    box.insertAdjacentHTML('beforeend', `
      <div class="credit-card ${claseUrgente}"
           style="background:linear-gradient(135deg,${colorBase}dd 0%,${colorBase}88 100%)">
        <!-- fila superior -->
        <div class="flex items-start justify-between mb-3 relative z-10">
          <div>
            <p class="font-semibold text-white text-base leading-tight">${escapeHtml(t.nombre)}</p>
            ${t.banco ? `<p class="text-white/60 text-xs mt-0.5">${escapeHtml(t.banco)}</p>` : ''}
          </div>
          <span class="badge badge-muted text-white/70" style="background:rgba(255,255,255,0.15);border:none">${r.periodo}</span>
        </div>
        <!-- Monto -->
        <p class="ff-display font-bold text-white text-2xl mb-3 relative z-10"
           style="text-shadow:0 2px 8px rgba(0,0,0,0.3)">${FMT.format(r.total_resumen)}</p>
        <!-- Barra de uso -->
        <div class="relative z-10 mb-3">
          <div class="bar" style="background:rgba(255,255,255,.18)">
            <span style="width:${pct}%;background:rgba(255,255,255,.85);box-shadow:none"></span>
          </div>
          <p class="text-white/60 text-[10px] mt-1">${pct.toFixed(0)}% del límite usado</p>
        </div>
        <!-- Rango del ciclo actual -->
        ${(() => {
          const rango = rangoCicloActual(t);
          const fmtFecha = (d) => {
            const mn = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
            return `${d.getDate()} ${mn[d.getMonth()]}`;
          };
          return `<div class="relative z-10 mb-2 px-2.5 py-1.5 rounded-lg" style="background:rgba(255,255,255,0.12);backdrop-filter:blur(8px)">
            <p class="text-white/70 text-[10px] uppercase tracking-widest font-semibold mb-0.5">Período de gastos</p>
            <p class="text-white text-xs font-semibold">${fmtFecha(rango.inicio)} → ${fmtFecha(rango.fin)}</p>
          </div>`;
        })()}
        <!-- Fechas -->
        <div class="flex justify-between items-center relative z-10">
          <span class="badge ${badgeCierre}" style="font-size:.65rem">
            Cierra en ${diasC}d · ${r.fecha_cierre}
          </span>
          <span class="badge ${badgeVenc}" style="font-size:.65rem">
            Vence ${r.fecha_vencimiento} (${diasV}d)
          </span>
        </div>
      </div>`);
  }
  el.querySelector('[data-action="add-card"]').onclick = () => openDialog('dlg-tarjeta');
}

function renderCredito(el) {
  const ingreso     = state.estado.ingresos_netos_mes;
  const compromisos = state.resumenes.reduce((a,r)=>a+r.total_resumen, 0);
  const cuotaSegura = ingreso * 0.30;
  const disponible  = Math.max(0, cuotaSegura - compromisos);
  const ratio       = ingreso > 0 ? compromisos/ingreso : 0;
  const pct         = Math.min(100, Math.round(ratio * 100));

  // Colores del gauge
  const gaugeColor = ratio <= 0.30 ? 'var(--success)' : ratio <= 0.40 ? 'var(--warning)' : 'var(--danger)';
  const semLabel   = ratio <= 0.30 ? 'Verde'           : ratio <= 0.40 ? 'Amarillo'        : 'Rojo';
  const semClass   = ratio <= 0.30 ? 'badge-success'   : ratio <= 0.40 ? 'badge-warning'   : 'badge-danger';

  // Badge semáforo
  const badge = el.querySelector('[data-bind="semaforo-badge"]');
  if (badge) { badge.className = `badge ${semClass}`; badge.textContent = semLabel; }

  // Gauge arc: track = 175.9 (longitud del semi-arco), fill proporcional
  const arcLen  = 175.9;
  const offset  = arcLen - (arcLen * Math.min(ratio, 1));
  const gaugeFill = el.querySelector('[data-bind="gauge-arc"]');
  if (gaugeFill) {
    gaugeFill.style.stroke = gaugeColor;
    // Animamos con requestAnimationFrame para que aplique después del DOM
    requestAnimationFrame(() => { gaugeFill.style.strokeDashoffset = offset.toFixed(1); });
  }

  const ratioPct = el.querySelector('[data-bind="ratio-pct"]');
  if (ratioPct) { ratioPct.textContent = pct + '%'; ratioPct.style.color = gaugeColor; }

  const cuotaEl = el.querySelector('[data-bind="cuota-segura"]');
  if (cuotaEl) cuotaEl.textContent = FMT.format(cuotaSegura);

  const dispEl = el.querySelector('[data-bind="disponible"]');
  if (dispEl) {
    dispEl.textContent = FMT.format(disponible);
    dispEl.style.color = disponible > 0 ? 'var(--success)' : 'var(--danger)';
  }
}

function renderIA(el) {
  const box = el.querySelector('[data-bind="diagnosticos"]');
  box.innerHTML = '';

  if (!state.diagnosticos.length) {
    box.innerHTML = `
      <div class="flex items-center gap-3 py-3" style="color:var(--ink-muted)">
        <span class="text-2xl">✅</span>
        <p class="text-sm">Sin anomalías detectadas. Todo en orden.</p>
      </div>`;
  }

  const SEV_STYLE = {
    critical: { bg: 'var(--danger-bg)',  border: 'var(--danger)',  text: 'var(--danger-2)',  icon: '🚨' },
    warning:  { bg: 'var(--warning-bg)', border: 'var(--warning)', text: 'var(--warning-2)', icon: '⚠️' },
    info:     { bg: 'var(--info-bg)',     border: 'var(--info)',    text: 'var(--info)',       icon: '💡' },
  };

  for (const d of state.diagnosticos) {
    const s = SEV_STYLE[d.severidad] || SEV_STYLE.info;
    box.insertAdjacentHTML('beforeend', `
      <div class="rounded-xl p-3 border-l-[3px]"
           style="background:${s.bg};border-color:${s.border};border-top:1px solid ${s.border}22;border-right:1px solid ${s.border}22;border-bottom:1px solid ${s.border}22">
        <div class="flex items-start gap-2">
          <span class="text-base flex-shrink-0 mt-0.5">${s.icon}</span>
          <div>
            <p class="font-semibold text-sm" style="color:${s.text}">${escapeHtml(d.titulo)}</p>
            <p class="text-xs mt-1" style="color:var(--ink-2)">${escapeHtml(d.detalle)}</p>
            ${d.sugerencia ? `<p class="text-xs mt-1.5 font-medium" style="color:var(--ink-muted)">💬 ${escapeHtml(d.sugerencia)}</p>` : ''}
          </div>
        </div>
      </div>`);
  }

  const sel = el.querySelector('#sens-select');
  if (sel) {
    sel.value = state.ajustes?.sensibilidad_ia || 'moderado';
    sel.onchange = async () => {
      await saveAjustes({ sensibilidad_ia: sel.value });
      state.diagnosticos = diagnosticar(state.gastos, { sensibilidad: sel.value });
      renderIA(el);
    };
  }
}

function renderMetas(el) {
  const box = el.querySelector('[data-bind="metas"]');
  box.innerHTML = '';

  if (!state.metas.length) {
    box.innerHTML = `
      <div class="flex flex-col items-center py-6 gap-2" style="color:var(--ink-muted)">
        <span class="text-3xl">🎯</span>
        <p class="text-sm">Sin metas. Tocá "+ Nueva".</p>
      </div>`;
  }

  const margen    = Math.max(0, state.estado.margen_libre_mes);
  const pesos     = state.metas.map(m => 1/(m.prioridad || 3));
  const sumaPesos = pesos.reduce((a,b)=>a+b,0) || 1;

  state.metas.sort((a,b)=>(a.prioridad||3)-(b.prioridad||3)).forEach((m, i) => {
    const pct      = Math.min(100, Math.round((100*m.monto_actual)/(m.monto_objetivo||1)));
    const sugerido = margen * (pesos[i] / sumaPesos);
    const icon     = m.es_emergencia ? '🛡️' : '🎯';
    const fechaLabel = m.fecha_objetivo
      ? `<span class="badge badge-muted text-[10px]">${m.fecha_objetivo}</span>` : '';

    box.insertAdjacentHTML('beforeend', `
      <div>
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="text-base">${icon}</span>
            <p class="font-semibold text-sm">${escapeHtml(m.nombre)}</p>
            ${fechaLabel}
          </div>
          <span class="ff-display font-bold text-sm" style="color:var(--brand-3)">${pct}%</span>
        </div>
        <div class="bar mb-2">
          <span style="width:${pct}%"></span>
        </div>
        <div class="flex justify-between text-[11px]" style="color:var(--ink-2)">
          <span>${FMT.format(m.monto_actual)} <span style="color:var(--ink-muted)">/ ${FMT.format(m.monto_objetivo)}</span></span>
          <span>Aportar <b style="color:var(--brand-3)">${FMT.format(sugerido)}</b>/mes</span>
        </div>
      </div>`);
  });
  el.querySelector('[data-action="add-meta"]').onclick = () => openDialog('dlg-meta');
}

let chartEvol = null;
function renderGrafico(el) {
  const canvas = el.querySelector('#chart-evolucion');
  const buckets  = new Map();
  const ingresosM = new Map();
  for (const g of state.gastos) {
    if (!g.fecha) continue;
    const k = g.fecha.slice(0,7);
    let m = g.monto;
    if (g.compartido) m = m*(1-(g.compartido.porcentaje_otro||0)/100);
    if (g.tipo === 'amortizacion') m = m/12;
    buckets.set(k, (buckets.get(k)||0)+m);
  }
  for (const i of state.ingresos) {
    const k = i.periodo_aplicacion;
    if (!k) continue;
    ingresosM.set(k, (ingresosM.get(k)||0) + (i.sueldo_neto||0) + (i.bonos||0));
  }
  const labels = [...new Set([...buckets.keys(), ...ingresosM.keys()])].sort().slice(-6);
  const datEg  = labels.map(l => Math.round(buckets.get(l)||0));
  const datIn  = labels.map(l => Math.round(ingresosM.get(l)||0));

  if (chartEvol) chartEvol.destroy();

  // Gradientes
  const ctx   = canvas.getContext('2d');
  const gradR = ctx.createLinearGradient(0,0,0,160);
  gradR.addColorStop(0,'rgba(244,63,94,0.3)'); gradR.addColorStop(1,'rgba(244,63,94,0.02)');
  const gradG = ctx.createLinearGradient(0,0,0,160);
  gradG.addColorStop(0,'rgba(16,185,129,0.3)'); gradG.addColorStop(1,'rgba(16,185,129,0.02)');

  chartEvol = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'Egresos',  data:datEg, tension:.4, borderColor:'#f43f5e', backgroundColor:gradR,
          fill:true, borderWidth:2, pointRadius:4, pointBackgroundColor:'#f43f5e',
          pointBorderColor:'var(--bg)', pointBorderWidth:2 },
        { label:'Ingresos', data:datIn, tension:.4, borderColor:'#10b981', backgroundColor:gradG,
          fill:true, borderWidth:2, pointRadius:4, pointBackgroundColor:'#10b981',
          pointBorderColor:'var(--bg)', pointBorderWidth:2 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(13,16,33,0.95)',
          borderColor: 'rgba(255,255,255,0.12)',
          borderWidth: 1,
          titleColor: '#94a3b8',
          bodyColor: '#e2e8f0',
          padding: 10,
          callbacks: { label: ctx => ' ' + FMT.format(ctx.raw) },
        },
      },
      scales: {
        x: {
          grid: { color:'rgba(255,255,255,0.04)' },
          ticks: { color:'#475569', font:{ size:11 } },
          border: { display:false },
        },
        y: {
          grid: { color:'rgba(255,255,255,0.04)' },
          ticks: { color:'#475569', font:{ size:11 }, callback: v => '$'+v },
          border: { display:false },
        },
      },
    },
  });
}

function renderResumenAnual(el) {
  const anio = new Date().getFullYear();
  el.querySelector('[data-bind="ytd-ingresos"]') && (el.querySelector('[data-bind="ytd-ingresos"]').textContent = '');

  // Calcular YTD (año en curso)
  const pfx = `${anio}-`;
  const ingresosYTD = state.ingresos
    .filter(i => (i.periodo_aplicacion || '').startsWith(pfx))
    .reduce((a,i)=> a + (i.sueldo_neto||0) + (i.bonos||0), 0);

  const gastosPorMes = new Map();
  for (const g of state.gastos) {
    if (!g.fecha?.startsWith(pfx)) continue;
    const mk = g.fecha.slice(0,7);
    let m = g.monto;
    if (g.compartido) m = m * (1-(g.compartido.porcentaje_otro||0)/100);
    if (g.tipo === 'amortizacion') m = m/12;
    gastosPorMes.set(mk, (gastosPorMes.get(mk)||0) + m);
  }
  const egresosYTD = [...gastosPorMes.values()].reduce((a,b)=>a+b,0);
  const mesesConDatos = gastosPorMes.size || 1;
  const promedioMensual = egresosYTD / mesesConDatos;
  const ahorroYTD = ingresosYTD - egresosYTD;

  // Mejor y peor mes
  let mejorMes = '—', peorMes = '—', min = Infinity, max = -Infinity;
  gastosPorMes.forEach((v,k) => {
    if (v < min) { min = v; mejorMes = k; }
    if (v > max) { max = v; peorMes = k; }
  });

  const bindSafe = (sel, val) => { const el2 = el.querySelector(sel); if(el2) el2.textContent = val; };
  bindSafe('[data-bind="ytd-ingresos"]', FMT.format(ingresosYTD));
  bindSafe('[data-bind="ytd-egresos"]',  FMT.format(egresosYTD));
  bindSafe('[data-bind="ytd-promedio"]', FMT.format(promedioMensual));

  const ahorroEl = el.querySelector('[data-bind="ytd-ahorro"]');
  if (ahorroEl) {
    ahorroEl.textContent = FMT.format(ahorroYTD);
    ahorroEl.style.color = ahorroYTD >= 0 ? 'var(--success)' : 'var(--danger)';
  }
  bindSafe('[data-bind="mejor-mes"]', mejorMes);
  bindSafe('[data-bind="peor-mes"]',  peorMes);

  const anioEl = el.querySelector('#anual-anio');
  if (anioEl) anioEl.textContent = anio;
}

let chartFlujo = null;
function renderFlujoMensual(el) {
  const canvas = el.querySelector('#chart-flujo');
  if (!canvas) return;

  const buckets = new Map(), ingrMap = new Map();
  for (const g of state.gastos) {
    if (!g.fecha) continue;
    const k = g.fecha.slice(0,7);
    let m = g.monto;
    if (g.compartido) m = m*(1-(g.compartido.porcentaje_otro||0)/100);
    if (g.tipo === 'amortizacion') m = m/12;
    buckets.set(k, (buckets.get(k)||0)+m);
  }
  for (const i of state.ingresos) {
    const k = i.periodo_aplicacion; if(!k) continue;
    ingrMap.set(k, (ingrMap.get(k)||0)+(i.sueldo_neto||0)+(i.bonos||0));
  }
  const labels = [...new Set([...buckets.keys(),...ingrMap.keys()])].sort().slice(-8);
  const datEg = labels.map(l=>Math.round(buckets.get(l)||0));
  const datIn = labels.map(l=>Math.round(ingrMap.get(l)||0));

  if (chartFlujo) chartFlujo.destroy();
  chartFlujo = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Ingresos', data:datIn, backgroundColor:'rgba(16,185,129,0.7)', borderRadius:6, borderSkipped:false },
        { label:'Egresos',  data:datEg, backgroundColor:'rgba(244,63,94,0.7)',  borderRadius:6, borderSkipped:false },
      ],
    },
    options: {
      responsive:true,
      plugins: {
        legend:{display:false},
        tooltip:{
          backgroundColor:'rgba(13,16,33,0.95)', borderColor:'rgba(255,255,255,0.12)', borderWidth:1,
          titleColor:'#94a3b8', bodyColor:'#e2e8f0', padding:10,
          callbacks:{ label: ctx => ' '+FMT.format(ctx.raw) },
        },
      },
      scales: {
        x:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#475569',font:{size:11}}, border:{display:false} },
        y:{ grid:{color:'rgba(255,255,255,0.04)'}, ticks:{color:'#475569',font:{size:11},callback:v=>'$'+v}, border:{display:false} },
      },
    },
  });
}

let chartCat = null;
function renderCategorias(el) {
  const canvas = el.querySelector('#chart-categorias');
  const leyenda = el.querySelector('#cat-leyenda');
  if (!canvas || !leyenda) return;

  const hoy = new Date();
  const mk = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;

  const catMap = new Map();
  for (const g of state.gastos) {
    if (!g.fecha?.startsWith(mk)) continue;
    const cat = g.categoria || 'general';
    let m = g.monto;
    if (g.compartido) m = m*(1-(g.compartido.porcentaje_otro||0)/100);
    catMap.set(cat, (catMap.get(cat)||0)+m);
  }

  const sorted = [...catMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
  const PALETTE = ['#6366f1','#10b981','#f43f5e','#f59e0b','#38bdf8','#8b5cf6'];
  const labels = sorted.map(([k])=>k);
  const data   = sorted.map(([,v])=>Math.round(v));
  const total  = data.reduce((a,b)=>a+b,0) || 1;

  // Actualizar período badge
  const periodoEl = el.querySelector('[data-bind="cat-periodo"]');
  if (periodoEl) periodoEl.textContent = mk;

  // Leyenda
  leyenda.innerHTML = '';
  sorted.forEach(([cat, val], i) => {
    const pct = Math.round((val/total)*100);
    leyenda.insertAdjacentHTML('beforeend', `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${PALETTE[i]}"></span>
          <span class="text-xs truncate" style="color:var(--ink-2)">${escapeHtml(cat)}</span>
        </div>
        <span class="text-xs font-semibold flex-shrink-0" style="color:var(--ink)">${pct}%</span>
      </div>`);
  });
  if (sorted.length === 0) {
    leyenda.innerHTML = `<p class="text-xs" style="color:var(--ink-muted)">Sin gastos este mes</p>`;
  }

  if (chartCat) chartCat.destroy();
  chartCat = new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets:[{ data, backgroundColor:PALETTE, borderWidth:0, hoverOffset:4 }] },
    options: {
      cutout:'72%', responsive:true, maintainAspectRatio:true,
      plugins: {
        legend:{display:false},
        tooltip:{ backgroundColor:'rgba(13,16,33,0.95)', titleColor:'#94a3b8', bodyColor:'#e2e8f0', padding:8,
          callbacks:{ label: ctx => ' '+FMT.format(ctx.raw)+' ('+Math.round((ctx.raw/total)*100)+'%)' } },
      },
    },
  });
}

function renderTipoCambio(el) {
  const cambios = state.ajustes?.tipos_cambio || {};
  const box = el.querySelector('[data-bind="rates-list"]');
  if (!box) return;
  box.innerHTML = '';
  for (const [key, c] of Object.entries(cambios)) {
    const equiv = state.estado.saldo_liquido / c.valor;
    box.insertAdjacentHTML('beforeend', `
      <div class="flex items-center justify-between p-3 rounded-xl"
           style="background:var(--surface-2);border:1px solid var(--border)">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-lg flex-shrink-0">${c.simbolo}</span>
          <div class="min-w-0">
            <p class="text-xs font-semibold truncate text-glow-cyan">${escapeHtml(c.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">1 ${key} = ${FMT.format(c.valor)}</p>
          </div>
        </div>
        <p class="ff-display text-sm font-bold" style="color:var(--brand)">
          ${equiv.toFixed(2)}
        </p>
      </div>`);
  }
  const upd = el.querySelector('[data-bind="rates-updated"]');
  if (upd) upd.textContent = state.ajustes?.tipos_cambio_updated || 'manual';

  el.querySelector('[data-action="edit-rates"]')?.addEventListener('click', () => abrirEditorTiposCambio());
}

async function abrirEditorTiposCambio() {
  const cambios = state.ajustes?.tipos_cambio || {};
  const valores = {};
  for (const [key, c] of Object.entries(cambios)) {
    const v = prompt(`Valor de ${c.nombre} (${key}) en ARS:`, c.valor);
    if (v === null) return;
    valores[key] = { ...c, valor: parseFloat(v) || c.valor };
  }
  state.ajustes.tipos_cambio = valores;
  state.ajustes.tipos_cambio_updated = new Date().toLocaleString('es-AR');
  await saveAjustes({});
  await reloadAll();
  toast('Cotizaciones actualizadas');
}

function renderCalculadora(el) {
  const btn = el.querySelector('[data-action="calc-go"]');
  if (!btn) return;
  const compute = () => {
    const monto    = parseFloat(el.querySelector('[data-bind="calc-monto"]').value) || 0;
    const personas = Math.max(1, parseInt(el.querySelector('[data-bind="calc-personas"]').value) || 1);
    const propina  = parseFloat(el.querySelector('[data-bind="calc-propina"]').value) || 0;
    const total    = monto * (1 + propina/100);
    const cada     = total / personas;
    el.querySelector('[data-bind="calc-result"]').textContent = FMT.format(cada);
    el.querySelector('[data-bind="calc-detail"]').textContent =
      `Total ${FMT.format(total)} ÷ ${personas} personas (propina ${propina}%)`;
  };
  btn.onclick = compute;
  // Enter en cualquier input también calcula
  el.querySelectorAll('input').forEach(i => i.onkeydown = e => { if(e.key==='Enter') compute(); });
}

function renderComparador(el) {
  const hoy = new Date();
  const mkActual = `${hoy.getFullYear()}-${String(hoy.getMonth()+1).padStart(2,'0')}`;
  const prev = new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
  const mkPrev = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;

  const calcMes = (mk) => {
    let total = 0;
    const porCat = new Map();
    for (const g of state.gastos) {
      if (!g.fecha?.startsWith(mk)) continue;
      let m = g.monto;
      if (g.compartido) m = m*(1-(g.compartido.porcentaje_otro||0)/100);
      if (g.tipo === 'amortizacion') m = m/12;
      total += m;
      porCat.set(g.categoria||'general', (porCat.get(g.categoria||'general')||0) + m);
    }
    return { total, porCat };
  };

  const actual = calcMes(mkActual);
  const anter  = calcMes(mkPrev);

  const bind = (sel, val) => { const n = el.querySelector(sel); if(n) n.textContent = val; };
  bind('[data-bind="comp-periodos"]', `${mkPrev} → ${mkActual}`);
  bind('[data-bind="comp-anterior"]', FMT.format(anter.total));
  bind('[data-bind="comp-actual"]',   FMT.format(actual.total));

  // Variación porcentual
  const variacionEl = el.querySelector('[data-bind="comp-variacion"]');
  if (variacionEl) {
    if (anter.total === 0) {
      variacionEl.textContent = actual.total > 0 ? '↑ Nuevo' : '—';
      variacionEl.style.color = 'var(--ink-muted)';
    } else {
      const variacion = ((actual.total - anter.total) / anter.total) * 100;
      const sign = variacion > 0 ? '↑' : variacion < 0 ? '↓' : '=';
      variacionEl.textContent = `${sign} ${Math.abs(variacion).toFixed(1)}%`;
      variacionEl.style.color = variacion > 5  ? 'var(--danger)'
                              : variacion < -5 ? 'var(--success)'
                              : 'var(--warning)';
    }
  }

  // Top 5 cambios por categoría
  const catBox = el.querySelector('[data-bind="comp-categorias"]');
  if (catBox) {
    catBox.innerHTML = '';
    const cats = new Set([...actual.porCat.keys(), ...anter.porCat.keys()]);
    const diffs = [...cats].map(c => ({
      cat: c,
      actual:  actual.porCat.get(c) || 0,
      anterior: anter.porCat.get(c) || 0,
      diff:    (actual.porCat.get(c) || 0) - (anter.porCat.get(c) || 0),
    })).filter(d => Math.abs(d.diff) > 0)
      .sort((a,b) => Math.abs(b.diff) - Math.abs(a.diff))
      .slice(0, 5);

    if (!diffs.length) {
      catBox.innerHTML = `<p class="text-xs text-center py-2" style="color:var(--ink-muted)">Sin variaciones por categoría</p>`;
    }

    for (const d of diffs) {
      const up    = d.diff > 0;
      const arrow = up ? '↑' : '↓';
      const col   = up ? 'var(--danger)' : 'var(--success)';
      catBox.insertAdjacentHTML('beforeend', `
        <div class="flex items-center justify-between text-xs py-1">
          <span style="color:var(--ink-2)">${escapeHtml(d.cat)}</span>
          <span class="font-bold" style="color:${col}">
            ${arrow} ${FMT.format(Math.abs(d.diff))}
          </span>
        </div>`);
    }
  }
}

/* ============ Widget Predicción IA ============ */
let chartPrediccion = null;
const _predState = { horizonte: 60 };

function renderPrediccion(el) {
  // Botones de horizonte
  el.querySelectorAll('.pred-horizonte').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.h) === _predState.horizonte);
    btn.onclick = () => {
      _predState.horizonte = parseInt(btn.dataset.h);
      el.querySelectorAll('.pred-horizonte').forEach(b =>
        b.classList.toggle('active', b === btn));
      renderPrediccion(el);
    };
  });

  const proy = proyectarBalance({
    gastos:   state.gastos,
    ingresos: state.ingresos,
    cuentas:  state.cuentas,
    tarjetas: state.tarjetas,
    horizonte: _predState.horizonte,
  });

  // KPIs superiores
  const set = (sel, txt, color) => {
    const n = el.querySelector(sel);
    if (!n) return;
    n.textContent = txt;
    if (color) n.style.color = color;
  };
  set('[data-bind="pred-actual"]',     FMT.format(proy.saldo_actual),
      proy.saldo_actual >= 0 ? 'var(--ink)' : 'var(--danger)');
  set('[data-bind="pred-futuro"]',     FMT.format(proy.saldo_proyectado),
      proy.saldo_proyectado >= 0 ? 'var(--brand)' : 'var(--danger)');
  set('[data-bind="pred-tendencia"]',  (proy.tendencia_mensual >= 0 ? '+' : '') + FMT.format(proy.tendencia_mensual),
      proy.tendencia_mensual >= 0 ? 'var(--success)' : 'var(--danger)');

  // Confianza
  const conf = el.querySelector('[data-bind="pred-confianza"]');
  if (conf) {
    const labels = { alta: 'Alta', media: 'Media', baja: 'Baja' };
    const cls    = { alta: 'badge-success', media: 'badge-warning', baja: 'badge-danger' };
    conf.textContent = labels[proy.confianza] || '—';
    conf.className   = `badge ${cls[proy.confianza] || 'badge-muted'}`;
  }

  // Alertas
  const ab = el.querySelector('[data-bind="pred-alertas"]');
  if (ab) {
    ab.innerHTML = '';
    if (!proy.alertas?.length) {
      ab.innerHTML = `<p class="text-xs text-center py-1" style="color:var(--success)">✓ Sin alertas en el horizonte</p>`;
    } else {
      proy.alertas.forEach(a => {
        const sev = a.severidad || 'info';
        const colorMap = { critical: 'var(--danger)', warning: 'var(--warning)', info: 'var(--info)' };
        const bgMap    = { critical: 'var(--danger-bg)', warning: 'var(--warning-bg)', info: 'var(--info-bg)' };
        const ico      = { critical: '🚨', warning: '⚠', info: 'ℹ' }[sev] || 'ℹ';
        ab.insertAdjacentHTML('beforeend', `
          <div class="flex items-start gap-2 p-2 rounded-lg" style="background:${bgMap[sev]};border:1px solid ${colorMap[sev]}">
            <span class="text-sm flex-shrink-0">${ico}</span>
            <p class="text-xs flex-1" style="color:${colorMap[sev]}">${escapeHtml(a.mensaje)}</p>
          </div>`);
      });
    }
  }

  // Predicción de saturación tarjetas
  const tb = el.querySelector('[data-bind="pred-tarjetas"]');
  if (tb) {
    tb.innerHTML = '';
    const sats = predecirSaturacionTarjetas({
      gastos:    state.gastos,
      tarjetas:  state.tarjetas,
      resumenes: state.resumenes,
    });
    if (!sats.length) {
      tb.innerHTML = `<p class="text-xs text-center py-1" style="color:var(--ink-muted)">Sin tarjetas activas</p>`;
    }
    sats.forEach(s => {
      const dias = s.dias_para_80;
      const color = dias === null ? 'var(--ink-muted)'
                  : dias < 15 ? 'var(--danger)'
                  : dias < 30 ? 'var(--warning)'
                  : 'var(--success)';
      const txt = dias === null ? 'Sin ritmo'
                : `~${Math.round(dias)}d para 80%`;
      tb.insertAdjacentHTML('beforeend', `
        <div class="flex items-center justify-between text-xs">
          <span style="color:var(--ink)">${escapeHtml(s.tarjeta_nombre)}</span>
          <span class="font-bold" style="color:${color}">${txt}</span>
        </div>`);
    });
  }

  // Gráfico
  const canvas = el.querySelector('#chart-prediccion');
  if (canvas && proy.puntos?.length) {
    if (chartPrediccion) chartPrediccion.destroy();
    const labels = proy.puntos.map(p => p.fecha);
    const data   = proy.puntos.map(p => p.saldo);
    const upper  = proy.puntos.map(p => p.intervalo_sup);
    const lower  = proy.puntos.map(p => p.intervalo_inf);
    const ctx    = canvas.getContext('2d');
    const grad   = ctx.createLinearGradient(0, 0, 0, 120);
    grad.addColorStop(0, 'rgba(0,240,255,0.4)');
    grad.addColorStop(1, 'rgba(0,240,255,0.02)');
    chartPrediccion = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Sup',  data: upper, borderColor: 'rgba(0,240,255,0.15)', backgroundColor: 'rgba(0,240,255,0.06)', fill: '+1', pointRadius: 0, borderWidth: 0, tension: .3 },
          { label: 'Inf',  data: lower, borderColor: 'rgba(0,240,255,0.15)', backgroundColor: 'transparent', pointRadius: 0, borderWidth: 0, tension: .3 },
          { label: 'Saldo proyectado', data, borderColor: '#00f0ff', backgroundColor: grad, fill: false, pointRadius: 0, borderWidth: 2, tension: .25 },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(5,6,20,0.95)', borderColor: '#00f0ff', borderWidth: 1,
            titleColor: '#7a9bc2', bodyColor: '#e8f5ff',
            callbacks: { label: (ctx) => ' ' + FMT.format(ctx.raw) },
          },
        },
        scales: {
          x: { display: false },
          y: { display: false },
        },
        interaction: { intersect: false, mode: 'index' },
      },
    });
  }
}

function actualizarSidebar() {
  // Saldo en sidebar
  const sbSaldo = document.getElementById('sb-saldo');
  if (sbSaldo && state.estado) {
    sbSaldo.textContent = FMT.format(state.estado.saldo_liquido);
    sbSaldo.style.color = state.estado.saldo_liquido >= 0 ? 'var(--ink)' : 'var(--danger)';
  }

  // Próximo vencimiento
  const sbProx = document.getElementById('sb-proximo');
  if (sbProx) {
    const prox = state.resumenes
      .filter(r => r.dias_para_vencimiento >= 0)
      .sort((a,b)=>a.dias_para_vencimiento - b.dias_para_vencimiento)[0];
    if (prox) {
      const t = state.tarjetas.find(t=>t.id===prox.tarjeta_id);
      const color = prox.dias_para_vencimiento <= 2 ? 'var(--danger)' : prox.dias_para_vencimiento <= 7 ? 'var(--warning)' : 'var(--success)';
      sbProx.textContent = `${t?.nombre||'Tarjeta'} — ${prox.dias_para_vencimiento}d`;
      sbProx.style.color = color;
    } else {
      sbProx.textContent = 'Sin vencimientos';
      sbProx.style.color = 'var(--ink-muted)';
    }
  }
}

function actualizarKpiStrip() {
  if (!state.estado) return;
  const e = state.estado;
  const set = (id, val, positive) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = FMT.format(val);
    if (positive !== undefined) el.style.color = val >= 0 ? 'var(--success)' : 'var(--danger)';
  };
  set('kpi-liquido',  e.saldo_liquido,   true);
  set('kpi-ingresos', e.ingresos_netos_mes);
  set('kpi-egresos',  e.egresos_mes);
  set('kpi-margen',   e.margen_libre_mes, true);

  // Trends textuales
  const trend = (id, val, label) => {
    const el = document.getElementById(id);
    if (el) el.textContent = label || (val >= 0 ? '↑ positivo' : '↓ negativo');
  };
  trend('kpi-liquido-trend',  e.saldo_liquido,    e.periodo);
  trend('kpi-ingresos-trend', e.ingresos_netos_mes, 'este mes');
  trend('kpi-egresos-trend',  e.egresos_mes,      'este mes');
  trend('kpi-margen-trend',   e.margen_libre_mes, e.margen_libre_mes >= 0 ? '✓ superávit' : '⚠ déficit');
}

function actualizarRightPanel() {
  // Últimos 5 movimientos
  const rpMov = document.getElementById('rp-movimientos');
  if (rpMov) {
    const todos = [
      ...state.gastos.map(g=>({...g, _tipo:'gasto'})),
      ...state.ingresos.map(i=>({...i, _tipo:'ingreso', monto:(i.sueldo_neto||0)+(i.bonos||0)})),
    ].sort((a,b)=>(b.fecha||b.periodo_aplicacion||'').localeCompare(a.fecha||a.periodo_aplicacion||'')).slice(0,5);

    rpMov.innerHTML = '';
    if (!todos.length) {
      rpMov.innerHTML = `<p class="text-xs" style="color:var(--ink-muted)">Sin movimientos</p>`;
    }
    const CAT_ICON2 = { kiosco:'🥤',combustible:'⛽',comida:'🛒',super:'🛒',servicios:'💡',transporte:'🚌',ocio:'🎬',auto:'🚗',hogar:'🏠',salud:'💊',general:'📌' };
    todos.forEach(m => {
      const icon = m._tipo === 'ingreso' ? '💰' : (CAT_ICON2[m.categoria]||'📌');
      const monto = m._tipo === 'ingreso' ? m.monto : (m.compartido ? m.monto*(1-(m.compartido.porcentaje_otro||0)/100) : m.monto);
      const color = m._tipo === 'ingreso' ? 'var(--success)' : 'var(--ink)';
      const sign = m._tipo === 'ingreso' ? '+' : '-';
      rpMov.insertAdjacentHTML('beforeend', `
        <div class="flex items-center gap-2 py-1.5" style="border-bottom:1px solid var(--border)">
          <span class="text-base flex-shrink-0">${icon}</span>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-medium truncate" style="color:var(--ink)">${escapeHtml(m.descripcion||'Movimiento')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${m.fecha||m.periodo_aplicacion||''}</p>
          </div>
          <p class="text-xs font-bold flex-shrink-0" style="color:${color}">${sign}${FMT.format(Math.abs(monto))}</p>
        </div>`);
    });
  }

  // Próximos vencimientos
  const rpVenc = document.getElementById('rp-vencimientos');
  if (rpVenc) {
    rpVenc.innerHTML = '';
    const proximos = state.resumenes
      .filter(r => r.dias_para_vencimiento >= 0 && r.dias_para_vencimiento <= 30)
      .sort((a,b)=>a.dias_para_vencimiento - b.dias_para_vencimiento)
      .slice(0, 4);

    if (!proximos.length) {
      rpVenc.innerHTML = `<p class="text-xs" style="color:var(--ink-muted)">Sin vencimientos próximos</p>`;
    }
    proximos.forEach(r => {
      const t = state.tarjetas.find(t=>t.id===r.tarjeta_id);
      const urgColor = r.dias_para_vencimiento <= 2 ? 'var(--danger)' : r.dias_para_vencimiento <= 7 ? 'var(--warning)' : 'var(--success)';
      rpVenc.insertAdjacentHTML('beforeend', `
        <div class="flex items-center justify-between py-1.5" style="border-bottom:1px solid var(--border)">
          <div>
            <p class="text-xs font-medium" style="color:var(--ink)">${escapeHtml(t?.nombre||'Tarjeta')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${FMT.format(r.total_resumen)}</p>
          </div>
          <span class="text-xs font-bold" style="color:${urgColor}">${r.dias_para_vencimiento}d</span>
        </div>`);
    });
  }
}

/* ============ HISTORIAL DE MOVIMIENTOS ============ */
const CAT_ICON = {
  kiosco:'🥤', combustible:'⛽', comida:'🛒', super:'🛒', servicios:'💡',
  transporte:'🚌', ocio:'🎬', auto:'🚗', hogar:'🏠', salud:'💊', ropa:'👗',
  educacion:'📚', restaurante:'🍽️', general:'📌',
};
const TIPO_TAG = {
  cuotas:      '<span class="tag tag-cuotas">Cuotas</span>',
  recurrente:  '<span class="tag tag-recurrente">Recurrente</span>',
  amortizacion:'<span class="tag tag-amortiz">Amortiz.</span>',
};
const METODO_LABEL = {
  efectivo: '💵 Efectivo', debito: '🏧 Débito',
  transferencia: '📲 Transf.', credito: '💳 Crédito',
};

function renderMovimientos() {
  const list   = document.getElementById('mov-list');
  const empty  = document.getElementById('mov-empty');
  const selMes = document.getElementById('mov-mes-filter');
  if (!list) return;

  // Reconstruir opciones de mes
  const meses = new Set();
  state.gastos.forEach(g => { if (g.fecha) meses.add(g.fecha.slice(0,7)); });
  state.ingresos.forEach(i => {
    if (i.fecha) meses.add(i.fecha.slice(0,7));
    if (i.periodo_aplicacion) meses.add(i.periodo_aplicacion);
  });
  const mesActual = new Date().toISOString().slice(0,7);
  const mesList = [...meses].sort().reverse();
  const prevVal = selMes.value || _movMesFiltro || mesActual;
  selMes.innerHTML = (mesList.length ? mesList : [mesActual])
    .map(m => `<option value="${m}"${m === prevVal ? ' selected' : ''}>${m}</option>`)
    .join('');
  selMes.onchange = renderMovimientos;

  const mes = selMes.value || mesActual;
  _movMesFiltro = mes;

  const gastosMes   = state.gastos.filter(g => g.fecha?.startsWith(mes)).sort((a,b)=>b.fecha.localeCompare(a.fecha));
  const ingresosMes = state.ingresos.filter(i => i.periodo_aplicacion===mes || i.fecha?.startsWith(mes)).sort((a,b)=>b.fecha.localeCompare(a.fecha));

  list.innerHTML = '';
  empty.classList.toggle('hidden', gastosMes.length + ingresosMes.length > 0);

  const SVG_TRASH = `<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

  // Ingresos
  for (const i of ingresosMes) {
    const total = (i.sueldo_neto || 0) + (i.bonos || 0);
    list.insertAdjacentHTML('beforeend', `
      <div class="mov-item flex items-center gap-3 bg-surf-alt rounded-2xl px-3 py-3 border border-black/5 dark:border-white/10">
        <span class="w-9 h-9 rounded-xl bg-emerald-500/10 flex items-center justify-center text-lg flex-shrink-0">💰</span>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm truncate">${escapeHtml(i.descripcion || 'Ingreso')}</p>
          <p class="text-[11px] text-ink-muted">${i.fecha} · período ${i.periodo_aplicacion}</p>
        </div>
        <div class="text-right flex-shrink-0">
          <p class="font-bold text-sm text-emerald-600 dark:text-emerald-400">${FMT.format(total)}</p>
          ${i.sueldo_bruto ? `<p class="text-[10px] text-ink-muted">bruto ${FMT.format(i.sueldo_bruto)}</p>` : ''}
        </div>
        <button class="p-1.5 text-ink-muted hover:text-red-500 transition flex-shrink-0" data-del-ing="${i.id}">${SVG_TRASH}</button>
      </div>`);
  }

  // Gastos
  for (const g of gastosMes) {
    const icon     = CAT_ICON[g.categoria] || '📌';
    const monto    = g.compartido ? g.monto * (1 - (g.compartido.porcentaje_otro||0)/100) : g.monto;
    const cuotas   = g.tipo === 'cuotas' ? ` C${g.cuota_numero}/${g.cuotas_total}` : '';
    const tipoTag  = TIPO_TAG[g.tipo] || '';
    const tarjeta  = g.tarjeta_id ? state.tarjetas.find(t=>t.id===g.tarjeta_id) : null;
    const metodo   = tarjeta ? `💳 ${escapeHtml(tarjeta.nombre)}` : (METODO_LABEL[g.metodo_pago] || g.metodo_pago);
    list.insertAdjacentHTML('beforeend', `
      <div class="mov-item flex items-center gap-3 bg-surf-alt rounded-2xl px-3 py-3 border border-black/5 dark:border-white/10">
        <span class="w-9 h-9 rounded-xl bg-surf flex items-center justify-center text-lg flex-shrink-0">${icon}</span>
        <div class="flex-1 min-w-0">
          <p class="font-semibold text-sm truncate">${escapeHtml(g.descripcion)}${tipoTag}${cuotas ? `<span class="text-ink-muted"> · ${cuotas}</span>` : ''}</p>
          <p class="text-[11px] text-ink-muted truncate">${g.fecha} · ${escapeHtml(g.categoria)} · ${metodo}</p>
          ${g.compartido ? `<p class="text-[10px] text-sky-600 dark:text-sky-400">👫 Compartido · ${escapeHtml(g.compartido.persona)}</p>` : ''}
        </div>
        <div class="text-right flex-shrink-0">
          <p class="font-bold text-sm">${FMT.format(monto)}</p>
          ${g.compartido ? `<p class="text-[10px] text-ink-muted">total ${FMT.format(g.monto)}</p>` : ''}
        </div>
        <button class="p-1.5 text-ink-muted hover:text-red-500 transition flex-shrink-0" data-del-gas="${g.id}">${SVG_TRASH}</button>
      </div>`);
  }

  // Handlers de eliminación
  list.querySelectorAll('[data-del-gas]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('¿Eliminar este gasto?')) return;
      await DB.softDelete('gastos', btn.dataset.delGas);
      toast('Gasto eliminado');
      await reloadAll();
    };
  });
  list.querySelectorAll('[data-del-ing]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('¿Eliminar este ingreso?')) return;
      await DB.softDelete('ingresos', btn.dataset.delIng);
      toast('Ingreso eliminado');
      await reloadAll();
    };
  });
}

/* ============ Diálogos ============ */
function openDialog(id, prefill = {}) {
  const dlg = document.getElementById(id);
  if (!dlg) return;
  const form = dlg.querySelector('form');
  form.reset();
  for (const [k,v] of Object.entries(prefill)) {
    const f = form.elements[k];
    if (f) f.value = v;
  }
  // Diálogo de gasto: alternar visibilidad de filas según tipo
  if (id === 'dlg-gasto') prepararDialogoGasto(form);
  // Diálogo de ingreso: auto-fill fecha y período actual
  if (id === 'dlg-ingreso') prepararDialogoIngreso(form);
  dlg.showModal();
}

function prepararDialogoIngreso(form) {
  const hoy = new Date().toISOString().slice(0, 10);
  if (!form.elements.fecha?.value)               form.elements.fecha.value = hoy;
  if (!form.elements.periodo_aplicacion?.value)  form.elements.periodo_aplicacion.value = hoy.slice(0, 7);
  // Poblar select de cuentas
  const cuentasI = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
  for (const sel of form.querySelectorAll('select[name="cuenta_id"]')) {
    sel.innerHTML = `<option value="">Sin cuenta</option>` +
      cuentasI.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  }
}

function prepararDialogoGasto(form) {
  // Poblar selects de tarjetas
  const tarjetas = state.tarjetas.filter(t => !t.deleted && t.activa !== false);
  for (const sel of form.querySelectorAll('select[name="tarjeta_id"], select[name="tarjeta_id_simple"]')) {
    sel.innerHTML = `<option value="">Sin tarjeta</option>` +
      tarjetas.map(t => `<option value="${t.id}">${escapeHtml(t.nombre)}</option>`).join('');
  }
  // Poblar select de cuentas
  const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
  for (const sel of form.querySelectorAll('select[name="cuenta_id"]')) {
    sel.innerHTML = `<option value="">Sin cuenta</option>` +
      cuentas.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  }
  // Default fecha hoy
  const fecha = form.elements.fecha;
  if (!fecha.value) fecha.value = new Date().toISOString().slice(0,10);

  const refrescar = () => {
    // form.elements.tipo es RadioNodeList con .value = valor del radio checked
    const v = form.elements.tipo?.value || 'unico';
    form.querySelector('#row-cuotas').hidden  = v !== 'cuotas';
    form.querySelector('#row-tarjeta').hidden = v === 'cuotas';
    // Mostrar row-cuenta solo si el método NO es crédito
    const metodo = form.elements.metodo_pago?.value || 'efectivo';
    const rowC = form.querySelector('#row-cuenta');
    if (rowC) rowC.hidden = (metodo === 'credito');
  };
  // Escuchar cambio en cualquiera de los 4 radios de tipo
  form.querySelectorAll('input[name="tipo"]').forEach(r => r.onchange = refrescar);
  // Escuchar cambio en método de pago para mostrar/ocultar cuenta
  form.querySelectorAll('input[name="metodo_pago"]').forEach(r => r.addEventListener('change', refrescar));
  refrescar();
}

async function handleSubmitGasto(form) {
  const fd = new FormData(form);
  const tipo = fd.get('tipo');
  const editingId = fd.get('_editing_id');
  const compartido = fd.get('comp_persona')
    ? { persona: fd.get('comp_persona'), porcentaje_otro: parseFloat(fd.get('comp_porc')||0) }
    : null;

  const base = editingId ? (await DB.get('gastos', editingId) || {}) : {};
  const g = {
    ...base,
    id: editingId || uuid(),
    updated_at: nowTs(),
    deleted: false,
    fecha: fd.get('fecha'),
    monto: parseFloat(fd.get('monto')),
    descripcion: fd.get('descripcion'),
    categoria: fd.get('categoria') || 'general',
    metodo_pago: fd.get('metodo_pago'),
    tipo,
    tarjeta_id: tipo === 'cuotas' ? (fd.get('tarjeta_id') || null) : (fd.get('tarjeta_id_simple') || null),
    cuenta_id: fd.get('cuenta_id') || null,
    cuotas_total: tipo === 'cuotas' ? parseInt(fd.get('cuotas_total')||1) : 1,
    cuota_numero: base.cuota_numero || 1,
    compartido,
    es_amortizacion_anual: tipo === 'amortizacion',
    adjunto_ref: base.adjunto_ref || null,
  };
  await DB.put('gastos', g); notificarCambioLocal();
  toast(editingId ? 'Gasto actualizado' : 'Gasto registrado');
  if (!editingId && state.ajustes?.notificaciones?.confirmar_movimientos) {
    Notif.confirmarMovimiento({ tipo: 'gasto', descripcion: g.descripcion, monto: g.monto });
  }
  await reloadAll();
}

async function handleSubmitIngreso(form) {
  const fd = new FormData(form);
  const editingId = fd.get('_editing_id');
  const base = editingId ? (await DB.get('ingresos', editingId) || {}) : {};
  const i = {
    ...base,
    id: editingId || uuid(),
    updated_at: nowTs(),
    deleted: false,
    fecha: fd.get('fecha'),
    periodo_aplicacion: fd.get('periodo_aplicacion'),
    descripcion: fd.get('descripcion') || 'Sueldo',
    sueldo_bruto: parseFloat(fd.get('sueldo_bruto')||0),
    descuentos:   parseFloat(fd.get('descuentos')||0),
    bonos:        parseFloat(fd.get('bonos')||0),
    sueldo_neto:  parseFloat(fd.get('sueldo_neto')),
    cuenta_id:    fd.get('cuenta_id') || null,
    es_recurrente: true,
  };
  await DB.put('ingresos', i); notificarCambioLocal();
  toast(editingId ? 'Ingreso actualizado' : 'Ingreso registrado');
  if (!editingId && state.ajustes?.notificaciones?.confirmar_movimientos) {
    Notif.confirmarMovimiento({ tipo: 'ingreso', descripcion: i.descripcion, monto: i.sueldo_neto });
  }
  await reloadAll();
}

async function handleSubmitTarjeta(form) {
  const fd = new FormData(form);
  const t = {
    id: uuid(),
    updated_at: nowTs(),
    deleted: false,
    nombre: fd.get('nombre'),
    banco: fd.get('banco') || null,
    ultimos_4: fd.get('ultimos_4') || null,
    limite_un_pago: parseFloat(fd.get('limite_un_pago')||0),
    limite_cuotas:  parseFloat(fd.get('limite_cuotas')||0),
    dia_cierre:     parseInt(fd.get('dia_cierre')),
    dia_vencimiento: parseInt(fd.get('dia_vencimiento')),
    color: fd.get('color') || '#4f46e5',
    activa: true,
  };
  await DB.put('tarjetas', t); notificarCambioLocal();
  toast('Tarjeta guardada');
  await reloadAll();
}

async function handleSubmitCuenta(form) {
  const fd = new FormData(form);
  const editingId = fd.get('_editing_id');
  const base = editingId ? (await DB.get('cuentas', editingId) || {}) : {};
  const cuenta = {
    ...base,
    id: editingId || uuid(),
    updated_at: nowTs(),
    deleted: false,
    nombre: fd.get('nombre'),
    banco: fd.get('banco') || null,
    tipo: fd.get('tipo') || 'caja_ahorro',
    moneda: fd.get('moneda') || 'ARS',
    saldo_inicial: parseFloat(fd.get('saldo_inicial')) || 0,
    color: fd.get('color') || '#00ff9f',
    activa: true,
  };
  await DB.put('cuentas', cuenta); notificarCambioLocal();
  await reloadAll();
  toast('✓ Cuenta guardada');
}

async function handleSubmitMeta(form) {
  const fd = new FormData(form);
  const m = {
    id: uuid(),
    updated_at: nowTs(),
    deleted: false,
    nombre: fd.get('nombre'),
    monto_objetivo: parseFloat(fd.get('monto_objetivo')),
    monto_actual:   parseFloat(fd.get('monto_actual')||0),
    fecha_objetivo: fd.get('fecha_objetivo') || null,
    prioridad: parseInt(fd.get('prioridad')||3),
    es_emergencia: !!fd.get('es_emergencia'),
  };
  await DB.put('metas', m); notificarCambioLocal();
  toast('Meta guardada');
  await reloadAll();
}

/* ============ Settings ============ */
function abrirSettings() {
  const dlg  = document.getElementById('dlg-settings');
  const form = dlg.querySelector('form');
  const aj   = state.ajustes;

  // Pre-llenar campos
  if (form.elements.gh_pat)             form.elements.gh_pat.value             = aj.github?.pat || '';
  if (form.elements.gh_owner)           form.elements.gh_owner.value           = aj.github?.owner || '';
  if (form.elements.gh_repo)            form.elements.gh_repo.value            = aj.github?.repo || '';
  if (form.elements.gh_branch)          form.elements.gh_branch.value          = aj.github?.branch || 'main';
  if (form.elements.gh_ruta)            form.elements.gh_ruta.value            = aj.github?.ruta_datos || 'data';
  if (form.elements.sync_intervalo)     form.elements.sync_intervalo.value     = String(aj.sync_intervalo ?? 300000);
  actualizarSyncStatusCard();
  if (form.elements.color_primario)     form.elements.color_primario.value     = aj.ui?.color_primario || '#00f0ff';
  if (form.elements.moneda)             form.elements.moneda.value             = aj.moneda || 'ARS';
  if (form.elements.nombre_usuario)     form.elements.nombre_usuario.value     = aj.nombre_usuario || '';
  if (form.elements.sensibilidad_ia)    form.elements.sensibilidad_ia.value    = aj.sensibilidad_ia || 'moderado';
  if (form.elements.periodo_default)    form.elements.periodo_default.value    = aj.periodo_default || 'mes_actual';
  if (form.elements.notif_habilitadas)  form.elements.notif_habilitadas.checked = !!aj.notificaciones?.habilitadas;
  if (form.elements.notif_confirmar)    form.elements.notif_confirmar.checked   = !!aj.notificaciones?.confirmar_movimientos;
  if (form.elements.notif_ia)           form.elements.notif_ia.checked          = !!aj.notificaciones?.alertas_ia;
  if (form.elements.alertas_dias)       form.elements.alertas_dias.value        = (aj.notificaciones?.alertas_tarjeta_dias || [5,2,1]).join(',');

  // Toggles de widgets (con íconos)
  const cont = form.querySelector('#widgets-toggle');
  if (cont) {
    cont.innerHTML = '';
    const ICONS = {
      estado_global: '💰', cuentas: '🏦', tarjetas: '💳', simulacion_credito: '📊',
      ia_local: '🧠', metas: '🎯', grafico: '📈',
      resumen_anual: '📅', flujo_mensual: '🌊', categorias: '🍩',
      tipo_cambio: '💱', calculadora: '🧮', comparador: '⚖',
    };
    const LABELS = {
      estado_global: 'Estado global', cuentas: 'Cuentas bancarias',
      tarjetas: 'Tarjetas',
      simulacion_credito: 'Capacidad crediticia', ia_local: 'Análisis IA',
      metas: 'Metas de ahorro', grafico: 'Evolución 6 meses',
      resumen_anual: 'Resumen anual', flujo_mensual: 'Flujo mensual',
      categorias: 'Gastos por categoría', tipo_cambio: 'Tipo de cambio',
      calculadora: 'Calculadora', comparador: 'Comparador mensual',
    };
    for (const id of Object.keys(TPL)) {
      const checked = (aj.ui?.widgets_visibles || []).includes(id);
      cont.insertAdjacentHTML('beforeend', `
        <label>
          <input type="checkbox" data-widget="${id}" ${checked?'checked':''}/>
          <span class="widget-icon">${ICONS[id] || '◆'}</span>
          <span class="text-sm flex-1">${LABELS[id] || id}</span>
        </label>`);
    }
  }

  // Inicializar tabs (siempre arrancar en General)
  cambiarSettingsTab('general');

  // Render catálogos y cuentas
  renderCatalogoSettings('gasto');
  renderCatalogoSettings('ingreso');
  renderCuentasSettings();
  renderTarjetasSettings();

  dlg.showModal();
}

function cambiarSettingsTab(stab) {
  document.querySelectorAll('#settings-tabs .settings-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.stab === stab));
  document.querySelectorAll('.settings-panel').forEach(p =>
    p.classList.toggle('hidden', p.dataset.spanel !== stab));
}

async function guardarSettings(form) {
  const aj = state.ajustes;

  aj.github = {
    pat: form.elements.gh_pat?.value || null,
    owner: form.elements.gh_owner?.value || null,
    repo: form.elements.gh_repo?.value || null,
    branch: form.elements.gh_branch?.value || 'main',
    ruta_datos: form.elements.gh_ruta?.value || 'data',
  };
  aj.sync_intervalo = parseInt(form.elements.sync_intervalo?.value) || 300000;
  aj.ui.color_primario = form.elements.color_primario?.value || '#00f0ff';
  aj.moneda            = form.elements.moneda?.value || 'ARS';
  aj.nombre_usuario    = form.elements.nombre_usuario?.value || '';
  aj.sensibilidad_ia   = form.elements.sensibilidad_ia?.value || 'moderado';
  aj.periodo_default   = form.elements.periodo_default?.value || 'mes_actual';

  aj.notificaciones = {
    habilitadas: !!form.elements.notif_habilitadas?.checked,
    confirmar_movimientos: !!form.elements.notif_confirmar?.checked,
    alertas_ia: !!form.elements.notif_ia?.checked,
    alertas_tarjeta_dias: (form.elements.alertas_dias?.value || '5,2,1')
      .split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x) && x > 0),
  };

  aj.ui.widgets_visibles = [...form.querySelectorAll('#widgets-toggle input:checked')]
    .map(i => i.dataset.widget);

  await saveAjustes({ ...aj });
  await reloadAll();
  toast('✓ Ajustes guardados');
}

/* ============ Sincronización ============ */
/* ============ Sincronización con GitHub ============ */

// Callbacks compartidos para sync manual y auto-sync
const syncCallbacks = {
  onStart: (motivo) => {
    setSyncIndicator('progress');
    if (motivo === 'manual') toast('Sincronizando…', 1200);
  },
  onProgress: (m, motivo) => {
    if (motivo === 'manual') toast(m, 1000);
  },
  onSuccess: async (result, motivo) => {
    await reloadAll();
    setSyncIndicator('ok');
    actualizarTimestampSync();
    if (motivo === 'manual' || motivo === 'inicial') {
      const totales = Object.values(result).reduce((a, r) => a + (r.count || 0), 0);
      toast(`✓ Sincronizado · ${totales} items`, 1800);
    }
  },
  onError: (err, motivo) => {
    setSyncIndicator('error');
    if (err.message === 'offline') {
      if (motivo === 'manual') toast('Sin conexión — se sincronizará al volver online', 2500);
      setSyncIndicator('offline');
      return;
    }
    if (motivo === 'manual') toast('Error de sync: ' + err.message, 3500);
    console.warn('Sync falló:', motivo, err.message);
  },
};

function setSyncIndicator(estado) {
  // estado: 'ok' | 'progress' | 'error' | 'offline' | 'idle'
  const dot   = document.getElementById('sync-status');
  const sbDot = document.getElementById('sb-sync-dot');
  const colorMap = {
    ok:       { color: 'var(--success)', cls: 'bg-emerald-500' },
    progress: { color: 'var(--warning)', cls: 'bg-amber-500 animate-pulse' },
    error:    { color: 'var(--danger)',  cls: 'bg-red-500' },
    offline:  { color: 'var(--ink-muted)', cls: 'bg-zinc-500' },
    idle:     { color: 'var(--ink-muted)', cls: 'bg-zinc-500' },
  };
  const m = colorMap[estado] || colorMap.idle;
  if (dot)   dot.className = `inline-block w-2 h-2 rounded-full mr-1 ${m.cls}`;
  if (sbDot) sbDot.style.background = m.color;
}

function actualizarTimestampSync() {
  const el = document.getElementById('sb-sync-time');
  if (!el) return;
  ultimaSync().then(ts => {
    if (!ts) { el.textContent = ''; return; }
    const dt = new Date(ts * 1000);
    const ahora = Date.now();
    const diffMin = Math.round((ahora - ts * 1000) / 60_000);
    if (diffMin < 1)       el.textContent = 'recién';
    else if (diffMin < 60) el.textContent = `hace ${diffMin}m`;
    else if (diffMin < 1440) el.textContent = `hace ${Math.round(diffMin/60)}h`;
    else el.textContent = dt.toLocaleDateString('es-AR');
  });
}

// Sync manual (botón)
async function doSync() {
  const cfg = state.ajustes?.github;
  if (!cfg?.pat) {
    toast('Configurá GitHub en Ajustes → Sync');
    abrirSettings();
    setTimeout(() => cambiarSettingsTab('sync'), 200);
    return;
  }
  try { await triggerSync('manual'); } catch {}
}

// Llamado desde init/saveAjustes: reinicia auto-sync con nueva config
function reiniciarAutoSync() {
  const cfg = state.ajustes?.github;
  if (cfg?.pat && cfg?.owner && cfg?.repo) {
    startAutoSync(cfg, syncCallbacks, {
      intervalMs: 5 * 60_000,
      debounceMs: 30_000,
      syncAlInicio: true,
    });
    setSyncIndicator('idle');
  } else {
    stopAutoSync();
    setSyncIndicator('idle');
  }
}

// Llamar después de cualquier escritura en DB para programar push diferido
function notificarCambioLocal() {
  if (state.ajustes?.github?.pat) programarPush();
}

// Actualizar timestamp cada 30s
setInterval(actualizarTimestampSync, 30_000);

// Actualizar el card de estado de sync dentro de Settings
function actualizarSyncStatusCard() {
  const card    = document.getElementById('sync-status-card');
  const label   = document.getElementById('sync-status-label');
  const detail  = document.getElementById('sync-status-detail');
  const timeEl  = document.getElementById('sync-status-time');
  if (!card) return;
  const cfg = state.ajustes?.github;
  if (!cfg?.pat || !cfg?.owner || !cfg?.repo) {
    card.dataset.state = 'idle';
    label.textContent  = 'Sin configurar';
    detail.textContent = 'Configurá GitHub para sincronizar entre dispositivos.';
    timeEl.textContent = '';
    return;
  }
  if (!navigator.onLine) {
    card.dataset.state = 'offline';
    label.textContent  = 'Sin conexión';
    detail.textContent = 'Tus cambios están guardados localmente. Se sincronizarán cuando vuelvas a tener red.';
    return;
  }
  card.dataset.state = 'ok';
  label.textContent  = `Conectado · ${cfg.owner}/${cfg.repo}`;
  detail.textContent = `Sincronización automática cada ${Math.round((state.ajustes.sync_intervalo || 300000)/60000)} min. Branch: ${cfg.branch}`;
  ultimaSync().then(ts => {
    if (!ts) { timeEl.textContent = 'Aún no sincronizado'; return; }
    const diffMin = Math.round((Date.now() - ts * 1000) / 60_000);
    if (diffMin < 1) timeEl.textContent = 'recién';
    else if (diffMin < 60) timeEl.textContent = `hace ${diffMin}m`;
    else timeEl.textContent = `hace ${Math.round(diffMin/60)}h`;
  });
}

/* ============ Quick actions ============ */
async function quickAction(slug) {
  const presets = {
    kiosco:      { descripcion: 'Kiosco',      categoria: 'kiosco' },
    combustible: { descripcion: 'Combustible', categoria: 'auto' },
    super:       { descripcion: 'Supermercado',categoria: 'comida' },
    servicios:   { descripcion: 'Servicios',   categoria: 'servicios' },
    transporte:  { descripcion: 'Transporte',  categoria: 'transporte' },
    ocio:        { descripcion: 'Ocio',        categoria: 'ocio' },
  };
  openDialog('dlg-gasto', presets[slug] || {});
}

/* ============ Helpers ============ */
function toast(msg, ms=1800) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ============ HISTORIAL POR WIDGET (drawer) ============ */

const WIDGET_META = {
  estado_global:      { icon: '💰', titulo: 'Estado global',          filtra: 'todos' },
  cuentas:            { icon: '🏦', titulo: 'Cuentas bancarias',      filtra: 'todos' },
  tarjetas:           { icon: '💳', titulo: 'Tarjetas de crédito',    filtra: 'tarjeta' },
  simulacion_credito: { icon: '📊', titulo: 'Capacidad crediticia',   filtra: 'tarjeta' },
  ia_local:           { icon: '🧠', titulo: 'Análisis IA',             filtra: 'todos' },
  metas:              { icon: '🎯', titulo: 'Metas de ahorro',         filtra: 'metas' },
  grafico:            { icon: '📈', titulo: 'Evolución 6 meses',       filtra: 'todos' },
  resumen_anual:      { icon: '📅', titulo: 'Resumen anual',           filtra: 'todos' },
  flujo_mensual:      { icon: '🌊', titulo: 'Flujo mensual',           filtra: 'todos' },
  categorias:         { icon: '🍩', titulo: 'Gastos por categoría',    filtra: 'categoria' },
  tipo_cambio:        { icon: '💱', titulo: 'Tipo de cambio',           filtra: 'todos' },
  calculadora:        { icon: '🧮', titulo: 'Calculadora',              filtra: 'todos' },
  comparador:         { icon: '⚖', titulo: 'Comparador mensual',       filtra: 'todos' },
};

const _hdState = {
  widget: null,
  range:  'mes_actual',
  custom: { from: null, to: null },
  sort:   'fecha-desc',
  chart:  null,
  chartMode: 'lineas',
  tipo: 'todos',           // 'todos' | 'ingresos' | 'gastos'
  categorias: new Set(),   // Set vacío = todas; si tiene items = solo esas
  calYear:  new Date().getFullYear(),
  calMonth: new Date().getMonth(),  // 0-11
};

const CAT_ICON_HD = {
  kiosco:'🥤', combustible:'⛽', comida:'🛒', super:'🛒', servicios:'💡',
  transporte:'🚌', ocio:'🎬', auto:'🚗', hogar:'🏠', salud:'💊', ropa:'👗',
  educacion:'📚', restaurante:'🍽', general:'📌',
};

function _hdRangeToDates(range, customFrom, customTo) {
  const hoy = new Date();
  let from, to;
  if (range === 'mes_actual') {
    from = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    to   = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0);
  } else if (range === 'mes_anterior') {
    from = new Date(hoy.getFullYear(), hoy.getMonth()-1, 1);
    to   = new Date(hoy.getFullYear(), hoy.getMonth(),    0);
  } else if (range === 'ultimos_30') {
    to   = hoy;
    from = new Date(hoy.getTime() - 30*86400000);
  } else if (range === 'ultimos_90') {
    to   = hoy;
    from = new Date(hoy.getTime() - 90*86400000);
  } else if (range === 'anio') {
    from = new Date(hoy.getFullYear(), 0, 1);
    to   = new Date(hoy.getFullYear(), 11, 31);
  } else if (range === 'custom' && customFrom && customTo) {
    from = new Date(customFrom);
    to   = new Date(customTo);
  } else {
    from = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
    to   = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0);
  }
  return { from, to };
}

function _hdInRange(isoDate, from, to) {
  if (!isoDate) return false;
  const d = new Date(isoDate + 'T12:00:00');
  return d >= from && d <= to;
}

function _hdFiltrarMovimientos(widget, from, to) {
  const tipo = _hdState.tipo;
  const cats = _hdState.categorias;

  // Decidir si el widget fuerza un tipo
  let soloGastos = false, soloIngresos = false;
  if (widget === 'tarjetas' || widget === 'simulacion_credito' || widget === 'categorias') {
    soloGastos = true;
  }

  let gastos = [];
  let ingresos = [];

  // Gastos
  if (!soloIngresos && tipo !== 'ingresos') {
    gastos = state.gastos.filter(g => {
      if (g.deleted) return false;
      if (!_hdInRange(g.fecha, from, to)) return false;
      if (soloGastos && widget === 'tarjetas' && !g.tarjeta_id) return false;
      if (cats.size > 0 && !cats.has(g.categoria || 'general')) return false;
      return true;
    });
  }

  // Ingresos
  if (!soloGastos && tipo !== 'gastos') {
    ingresos = state.ingresos.filter(i => {
      if (i.deleted) return false;
      return _hdInRange(i.fecha, from, to);
    });
  }

  return { gastos, ingresos };
}

function _hdMontoEfectivo(g) {
  let m = g.monto;
  if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0) / 100);
  if (g.tipo === 'amortizacion') m = m / 12;
  return m;
}

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function _hdRenderCalendar() {
  const grid   = document.getElementById('hd-cal-grid');
  const label  = document.getElementById('hd-cal-month-label');
  if (!grid || !label) return;

  const year  = _hdState.calYear;
  const month = _hdState.calMonth;
  label.textContent = `${MESES_ES[month]} ${year}`;

  // Calcular días con datos en este mes para marcar el calendario
  const diasConDatos = new Set();
  for (const g of state.gastos) {
    if (g.fecha && g.fecha.startsWith(`${year}-${String(month+1).padStart(2,'0')}`)) {
      diasConDatos.add(parseInt(g.fecha.slice(8,10)));
    }
  }
  for (const i of state.ingresos) {
    if (i.fecha && i.fecha.startsWith(`${year}-${String(month+1).padStart(2,'0')}`)) {
      diasConDatos.add(parseInt(i.fecha.slice(8,10)));
    }
  }

  // Parsear selección actual
  const selFrom = _hdState.custom.from ? new Date(_hdState.custom.from + 'T12:00:00') : null;
  const selTo   = _hdState.custom.to   ? new Date(_hdState.custom.to   + 'T12:00:00') : null;
  const hoy     = new Date(); hoy.setHours(12,0,0,0);

  // Primer día del mes y cantidad de días
  const firstDay  = new Date(year, month, 1).getDay(); // 0=Dom
  const daysInMonth = new Date(year, month+1, 0).getDate();

  // Limpiar grid (mantener los 7 headers DOW que ya están en el HTML)
  const headers = [...grid.querySelectorAll('.hd-cal-dow')];
  grid.innerHTML = '';
  headers.forEach(h => grid.appendChild(h));

  // Celdas vacías antes del día 1
  for (let i = 0; i < firstDay; i++) {
    const empty = document.createElement('button');
    empty.type = 'button';
    empty.className = 'hd-cal-day hd-cal-empty';
    grid.appendChild(empty);
  }

  // Días del mes
  for (let d = 1; d <= daysInMonth; d++) {
    const btn  = document.createElement('button');
    btn.type   = 'button';
    btn.className = 'hd-cal-day';
    btn.textContent = String(d);

    const thisDate = new Date(year, month, d); thisDate.setHours(12,0,0,0);
    const isoDate  = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    if (thisDate.toDateString() === hoy.toDateString()) btn.classList.add('hd-cal-today');
    if (diasConDatos.has(d)) btn.classList.add('hd-cal-has-data');

    if (selFrom && selTo) {
      if (thisDate.getTime() === selFrom.getTime()) btn.classList.add('hd-cal-from');
      else if (thisDate.getTime() === selTo.getTime()) btn.classList.add('hd-cal-to');
      else if (thisDate > selFrom && thisDate < selTo) btn.classList.add('hd-cal-in-range');
    } else if (selFrom && thisDate.getTime() === selFrom.getTime()) {
      btn.classList.add('hd-cal-from', 'hd-cal-to');
    }

    btn.addEventListener('click', () => {
      if (!_hdState.custom.from || (_hdState.custom.from && _hdState.custom.to)) {
        // Primer click: setear "desde"
        _hdState.custom.from = isoDate;
        _hdState.custom.to   = null;
      } else {
        // Segundo click: setear "hasta" (y asegurarse que from <= to)
        if (isoDate < _hdState.custom.from) {
          _hdState.custom.to   = _hdState.custom.from;
          _hdState.custom.from = isoDate;
        } else {
          _hdState.custom.to = isoDate;
        }
      }
      // Actualizar labels
      const fromLbl = document.getElementById('hd-cal-from-label');
      const toLbl   = document.getElementById('hd-cal-to-label');
      if (fromLbl) fromLbl.textContent = _hdState.custom.from || '—';
      if (toLbl)   toLbl.textContent   = _hdState.custom.to   || '—';
      // Re-render calendario para mostrar selección
      _hdRenderCalendar();
      // Si ya hay rango completo, filtrar
      if (_hdState.custom.from && _hdState.custom.to) {
        _hdRenderItems();
        _hdRenderChart();
      }
    });

    grid.appendChild(btn);
  }
}

function _hdRenderCatChips() {
  const box = document.getElementById('hd-cat-filter');
  if (!box) return;

  // Solo mostrar chips si estamos viendo gastos
  const tipo = _hdState.tipo;
  if (tipo === 'ingresos') { box.innerHTML = ''; return; }

  // Extraer categorías únicas de los gastos dentro del rango
  const { from, to } = _hdRangeToDates(_hdState.range, _hdState.custom.from, _hdState.custom.to);
  const cats = new Set();
  for (const g of state.gastos) {
    if (!g.deleted && _hdInRange(g.fecha, from, to)) {
      cats.add(g.categoria || 'general');
    }
  }

  if (cats.size === 0) { box.innerHTML = ''; return; }

  const CAT_ICON_CHIP = {
    kiosco:'🥤', combustible:'⛽', comida:'🛒', super:'🛒', servicios:'💡',
    transporte:'🚌', ocio:'🎬', auto:'🚗', hogar:'🏠', salud:'💊', ropa:'👗',
    educacion:'📚', restaurante:'🍽', general:'📌',
  };

  box.innerHTML = '';
  // Chip "Todas"
  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'hd-cat-chip' + (_hdState.categorias.size === 0 ? ' active' : '');
  allChip.textContent = '✦ Todas';
  allChip.addEventListener('click', () => {
    _hdState.categorias.clear();
    _hdRenderCatChips();
    _hdRenderItems();
    _hdRenderChart();
  });
  box.appendChild(allChip);

  // Chip por categoría
  for (const cat of [...cats].sort()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'hd-cat-chip' + (_hdState.categorias.has(cat) ? ' active' : '');
    chip.textContent = `${CAT_ICON_CHIP[cat] || '◆'} ${cat}`;
    chip.addEventListener('click', () => {
      if (_hdState.categorias.has(cat)) {
        _hdState.categorias.delete(cat);
      } else {
        _hdState.categorias.add(cat);
      }
      _hdRenderCatChips();
      _hdRenderItems();
      _hdRenderChart();
    });
    box.appendChild(chip);
  }
}

function _hdRenderItems() {
  const list  = document.getElementById('hd-list');
  const empty = document.getElementById('hd-empty');
  if (!list) return;

  _hdRenderCatChips();

  const { from, to } = _hdRangeToDates(_hdState.range, _hdState.custom.from, _hdState.custom.to);
  const { gastos, ingresos } = _hdFiltrarMovimientos(_hdState.widget, from, to);

  // Normalizar y ordenar
  let items = [
    ...gastos.map(g => ({
      _tipo: 'gasto', id: g.id, fecha: g.fecha,
      descripcion: g.descripcion, categoria: g.categoria, tarjeta_id: g.tarjeta_id,
      monto: _hdMontoEfectivo(g), monto_total: g.monto,
      compartido: g.compartido, metodo_pago: g.metodo_pago, tipo: g.tipo,
    })),
    ...ingresos.map(i => ({
      _tipo: 'ingreso', id: i.id, fecha: i.fecha,
      descripcion: i.descripcion || 'Ingreso',
      monto: (i.sueldo_neto || 0) + (i.bonos || 0),
      periodo_aplicacion: i.periodo_aplicacion,
    })),
  ];

  // Ordenar
  const [k, dir] = _hdState.sort.split('-');
  items.sort((a,b) => {
    const va = k === 'fecha' ? (a.fecha||'') : a.monto;
    const vb = k === 'fecha' ? (b.fecha||'') : b.monto;
    return dir === 'desc'
      ? (vb > va ? 1 : vb < va ? -1 : 0)
      : (va > vb ? 1 : va < vb ? -1 : 0);
  });

  // Render
  list.innerHTML = '';
  if (!items.length) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    for (const it of items) {
      const tarj = it.tarjeta_id ? state.tarjetas.find(t => t.id === it.tarjeta_id) : null;
      const icon = it._tipo === 'ingreso' ? '💰' : (CAT_ICON_HD[it.categoria] || '📌');
      const color = it._tipo === 'ingreso' ? 'var(--success)' : 'var(--ink)';
      const sign  = it._tipo === 'ingreso' ? '+' : '-';
      const meta  = it._tipo === 'ingreso'
        ? `Período ${it.periodo_aplicacion || '—'}`
        : `${it.fecha} · ${escapeHtml(it.categoria || 'general')}${tarj ? ' · 💳 ' + escapeHtml(tarj.nombre) : ''}`;
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">${icon}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(it.descripcion || 'Movimiento')}</p>
            <p class="text-[10px] truncate" style="color:var(--ink-muted)">${meta}</p>
          </div>
          <span class="hd-item-monto" style="color:${color}">${sign}${FMT.format(Math.abs(it.monto))}</span>
          <button class="hd-close-btn" data-hd-del="${it._tipo}:${it.id}" title="Eliminar"
                  style="width:24px;height:24px;font-size:.65rem">✕</button>
        </div>`);
    }
  }

  // KPIs
  const totalGastos   = items.filter(i => i._tipo === 'gasto').reduce((a,i) => a + i.monto, 0);
  const totalIngresos = items.filter(i => i._tipo === 'ingreso').reduce((a,i) => a + i.monto, 0);
  const totalNeto     = totalIngresos - totalGastos;

  const countEl = document.getElementById('hd-kpi-count');
  const avgEl   = document.getElementById('hd-kpi-avg');
  const totEl   = document.getElementById('hd-kpi-total');

  if (countEl) countEl.textContent = String(items.length);
  if (avgEl)   avgEl.textContent   = items.length ? FMT.format(Math.abs(totalNeto) / items.length) : FMT.format(0);
  if (totEl) {
    if (_hdState.widget === 'estado_global' || _hdState.widget === 'flujo_mensual' || _hdState.widget === 'resumen_anual') {
      totEl.textContent = (totalNeto >= 0 ? '+' : '') + FMT.format(totalNeto);
      totEl.style.color = totalNeto >= 0 ? 'var(--success)' : 'var(--danger)';
    } else {
      totEl.textContent = FMT.format(totalGastos);
      totEl.style.color = 'var(--brand)';
    }
  }

  // Handlers eliminar
  list.querySelectorAll('[data-hd-del]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('¿Eliminar este movimiento?')) return;
      const [tipo, id] = btn.dataset.hdDel.split(':');
      await DB.softDelete(tipo === 'ingreso' ? 'ingresos' : 'gastos', id);
      toast('✓ Eliminado');
      await reloadAll();
      _hdRenderItems();
      _hdRenderChart();
    });
  });
}

function _hdRenderChart() {
  const canvas = document.getElementById('hd-chart');
  if (!canvas) return;
  const { from, to } = _hdRangeToDates(_hdState.range, _hdState.custom.from, _hdState.custom.to);

  // Agrupar gastos e ingresos por día
  const dias = new Map();
  const cursor = new Date(from);
  while (cursor <= to) {
    const k = cursor.toISOString().slice(0,10);
    dias.set(k, { gastos: 0, ingresos: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const { gastos, ingresos } = _hdFiltrarMovimientos(_hdState.widget, from, to);
  for (const g of gastos) {
    const k = g.fecha;
    if (dias.has(k)) {
      let m = g.monto;
      if (g.compartido) m = m * (1 - (g.compartido.porcentaje_otro || 0)/100);
      if (g.tipo === 'amortizacion') m = m / 12;
      dias.get(k).gastos += m;
    }
  }
  for (const i of ingresos) {
    const k = i.fecha;
    if (dias.has(k)) {
      dias.get(k).ingresos += (i.sueldo_neto || 0) + (i.bonos || 0);
    }
  }

  const labels  = [...dias.keys()];
  const datG    = labels.map(l => Math.round(dias.get(l).gastos));
  const datI    = labels.map(l => Math.round(dias.get(l).ingresos));

  // Acumulado para gráfico de saldo
  let saldo = 0;
  const datAcum = labels.map(l => {
    saldo += dias.get(l).ingresos - dias.get(l).gastos;
    return Math.round(saldo);
  });

  // Promedio móvil 7 días sobre gastos
  const datMA = labels.map((_, i) => {
    const start = Math.max(0, i - 6);
    const window = datG.slice(start, i + 1);
    return Math.round(window.reduce((a, b) => a + b, 0) / window.length);
  });

  // Stats
  const totalG = datG.reduce((a,b)=>a+b,0);
  const totalI = datI.reduce((a,b)=>a+b,0);
  const diasConGasto = datG.filter(v => v > 0).length;
  const avgDiario = diasConGasto ? totalG / diasConGasto : 0;
  const maxDia = Math.max(...datG);
  const maxDiaIdx = datG.indexOf(maxDia);
  const maxDiaFecha = labels[maxDiaIdx];

  // Actualizar el panel de stats si existe
  const statsEl = document.getElementById('hd-chart-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="hd-stat">
        <span class="hd-stat-label">Total gastos</span>
        <span class="hd-stat-val" style="color:var(--danger)">${FMT.format(totalG)}</span>
      </div>
      <div class="hd-stat">
        <span class="hd-stat-label">Total ingresos</span>
        <span class="hd-stat-val" style="color:var(--success)">${FMT.format(totalI)}</span>
      </div>
      <div class="hd-stat">
        <span class="hd-stat-label">Promedio/día</span>
        <span class="hd-stat-val">${FMT.format(avgDiario)}</span>
      </div>
      <div class="hd-stat">
        <span class="hd-stat-label">Mayor gasto</span>
        <span class="hd-stat-val" title="${maxDiaFecha || ''}">${FMT.format(maxDia)}</span>
      </div>
    `;
  }

  if (_hdState.chart) _hdState.chart.destroy();
  const ctx = canvas.getContext('2d');

  const gradG = ctx.createLinearGradient(0, 0, 0, 160);
  gradG.addColorStop(0, 'rgba(255, 45, 110, 0.35)');
  gradG.addColorStop(1, 'rgba(255, 45, 110, 0.02)');

  const gradI = ctx.createLinearGradient(0, 0, 0, 160);
  gradI.addColorStop(0, 'rgba(0, 255, 159, 0.35)');
  gradI.addColorStop(1, 'rgba(0, 255, 159, 0.02)');

  // Decidir tipo de chart según selector
  const modo = _hdState.chartMode || 'lineas';

  let datasets;
  if (modo === 'lineas') {
    datasets = [
      { label: 'Gastos',      data: datG, borderColor: '#ff2d6e', backgroundColor: gradG, fill: true,  tension: .3, pointRadius: 0, borderWidth: 1.5, order: 2 },
      { label: 'Ingresos',    data: datI, borderColor: '#00ff9f', backgroundColor: gradI, fill: true,  tension: .3, pointRadius: 0, borderWidth: 1.5, order: 1 },
      { label: 'Media móvil', data: datMA, borderColor: 'rgba(0, 240, 255, 0.6)', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: .3, order: 0 },
    ];
  } else if (modo === 'acumulado') {
    const gradA = ctx.createLinearGradient(0, 0, 0, 160);
    gradA.addColorStop(0, 'rgba(0, 240, 255, 0.4)');
    gradA.addColorStop(1, 'rgba(0, 240, 255, 0.02)');
    datasets = [
      { label: 'Saldo acumulado', data: datAcum, borderColor: '#00f0ff', backgroundColor: gradA, fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
    ];
  } else { // barras
    datasets = [
      { label: 'Gastos',   data: datG, backgroundColor: 'rgba(255, 45, 110, 0.6)', borderRadius: 4, borderSkipped: false },
      { label: 'Ingresos', data: datI, backgroundColor: 'rgba(0, 255, 159, 0.6)',  borderRadius: 4, borderSkipped: false },
    ];
  }

  _hdState.chart = new Chart(canvas, {
    type: modo === 'barras' ? 'bar' : 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          display: modo === 'lineas',
          position: 'top',
          align: 'end',
          labels: {
            color: '#94a3b8', boxWidth: 10, boxHeight: 10, padding: 8,
            font: { size: 10, family: "'Inter', sans-serif" },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(5, 6, 20, 0.95)',
          borderColor: 'rgba(0, 240, 255, 0.5)',
          borderWidth: 1,
          titleColor: '#7a9bc2', bodyColor: '#e8f5ff',
          padding: 10,
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const d = new Date(items[0].label + 'T12:00:00');
              return d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
            },
            label: (ctx) => ` ${ctx.dataset.label}: ${FMT.format(ctx.raw)}`,
          },
        },
        annotation: undefined, // se podría agregar con plugin
      },
      scales: {
        x: {
          display: true,
          grid: { display: false },
          ticks: {
            color: '#475569',
            font: { size: 9 },
            maxTicksLimit: 6,
            callback: function(val, idx) {
              const lbl = labels[idx];
              if (!lbl) return '';
              const d = new Date(lbl + 'T12:00:00');
              return `${d.getDate()}/${d.getMonth()+1}`;
            },
          },
          border: { display: false },
        },
        y: {
          display: true,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#475569', font: { size: 9 },
            callback: (v) => {
              if (Math.abs(v) >= 1_000_000) return (v/1_000_000).toFixed(1) + 'M';
              if (Math.abs(v) >= 1000)      return (v/1000).toFixed(0) + 'k';
              return v;
            },
          },
          border: { display: false },
        },
      },
    },
  });
}

function abrirHistorialWidget(widgetId) {
  const dlg = document.getElementById('dlg-widget-history');
  if (!dlg) return;

  _hdState.widget = widgetId;
  _hdState.range  = 'mes_actual';
  _hdState.chartMode = 'lineas';
  _hdState.sort   = 'fecha-desc';
  _hdState.tipo = 'todos';
  _hdState.categorias = new Set();
  _hdState.calYear  = new Date().getFullYear();
  _hdState.calMonth = new Date().getMonth();
  _hdState.custom = { from: null, to: null };

  // Header
  const meta = WIDGET_META[widgetId] || { icon: '📊', titulo: widgetId };
  document.getElementById('hd-icon').textContent  = meta.icon;
  document.getElementById('hd-title').textContent = meta.titulo;
  const sub = document.getElementById('hd-subtitle');
  if (sub) sub.textContent = 'Historial detallado por período';

  // Quick filters
  document.querySelectorAll('.hd-quick-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.range === 'mes_actual'));
  const calWrap = document.getElementById('hd-calendar-wrap');
  if (calWrap) calWrap.hidden = true;

  // Tipo filter
  document.querySelectorAll('.hd-type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.htype === 'todos'));

  // Chips de categoría
  const catBox = document.getElementById('hd-cat-filter');
  if (catBox) catBox.innerHTML = '';

  // Sort
  const sortEl = document.getElementById('hd-sort');
  if (sortEl) sortEl.value = 'fecha-desc';

  // Render
  _hdRenderItems();
  _hdRenderChart();

  dlg.showModal();
}

/* ============ Helpers de navegación ============ */
function _restaurarActivoHome() {
  // Cuando se cierra un diálogo secundario (tarjeta, meta), deja el ítem "home" activo
  // en el sidebar y el bottom nav, ya que el contenido visible sigue siendo el dashboard.
  document.querySelectorAll('[data-sidebar-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.sidebarTab === 'home'));
  document.querySelectorAll('[data-tab]').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'home'));
}

/* ============ INIT ============ */
async function init() {
  await loadAjustes();
  aplicarTema();

  // Service Worker
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      // Solicitar background sync (si el navegador lo soporta)
      if ('sync' in reg) {
        try { await reg.sync.register('sync-data'); } catch {}
      }
    } catch (e) {
      console.warn('SW register failed', e);
    }
  }

  // Pull inicial + arrancar auto-sync si hay config GitHub
  const cfg = state.ajustes?.github;
  if (cfg?.pat) {
    try { await pullAll(cfg); } catch (e) { console.warn('Pull inicial falló', e); }
  }

  await reloadAll();

  // Iniciar auto-sync (cada 5min + al volver online + al ocultar pestaña)
  reiniciarAutoSync();
  actualizarTimestampSync();

  // Chequeo de tarjetas + IA tras render
  setTimeout(async () => {
    await chequeoDiarioTarjetas();
    if (state.ajustes?.notificaciones?.alertas_ia) {
      state.diagnosticos.forEach(d => Notif.alertaIA(d));
    }
  }, 1500);

  // Event listeners
  // Botón + → diálogo de selección
  document.getElementById('btn-add').onclick = () => document.getElementById('dlg-choice').showModal();
  document.getElementById('choice-gasto').onclick = () => {
    document.getElementById('dlg-choice').close();
    openDialog('dlg-gasto');
  };
  document.getElementById('choice-ingreso').onclick = () => {
    document.getElementById('dlg-choice').close();
    openDialog('dlg-ingreso');
  };
  document.getElementById('choice-cancel').onclick = () => document.getElementById('dlg-choice').close();

  document.getElementById('btn-sync').onclick = doSync;
  document.getElementById('btn-settings').onclick = abrirSettings;
  document.getElementById('btn-notif-ask').onclick = () => Notif.pedirPermiso();

  document.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => quickAction(b.dataset.quick));

  // Navegación por tabs (corregida)
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    document.querySelectorAll('.nav-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const tab = b.dataset.tab;
    if (tab === 'gastos') {
      switchTab('gastos');
    } else {
      switchTab('home');
      if (tab === 'tarjetas') openDialog('dlg-tarjeta');
      if (tab === 'metas')    openDialog('dlg-meta');
    }
  });

  // Listener de mensajes del Service Worker (Background Sync)
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'TRIGGER_SYNC') doSync();
    if (e.data?.type === 'NOTIFICATION_OPEN') {
      const { kind } = e.data.data || {};
      if (kind === 'tarjeta' || kind === 'ia') switchTab('home');
    }
  });

  // Atajos desde URL (shortcuts del manifest / notificaciones)
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('action') === 'new-gasto')  setTimeout(() => openDialog('dlg-gasto'), 500);
  if (urlParams.get('action') === 'sync')        setTimeout(doSync, 500);

  // Submit de diálogos
  document.getElementById('dlg-gasto').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') handleSubmitGasto(e.target.querySelector('form'));
  });
  document.getElementById('dlg-ingreso').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') handleSubmitIngreso(e.target.querySelector('form'));
  });
  document.getElementById('dlg-tarjeta').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') handleSubmitTarjeta(e.target.querySelector('form'));
    _restaurarActivoHome();
  });
  document.getElementById('dlg-cuenta')?.addEventListener('close', async (e) => {
    if (e.target.returnValue === 'save') await handleSubmitCuenta(e.target.querySelector('form'));
    _restaurarActivoHome();
  });
  document.getElementById('dlg-meta').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') handleSubmitMeta(e.target.querySelector('form'));
    _restaurarActivoHome();
  });
  document.getElementById('dlg-settings').addEventListener('close', (e) => {
    if (e.target.returnValue === 'save') guardarSettings(e.target.querySelector('form'));
  });

  // Botones de tema dentro del diálogo de settings
  document.querySelectorAll('#dlg-settings [data-theme]').forEach(b => {
    b.onclick = async () => {
      state.ajustes.ui.tema = b.dataset.theme;
      await saveAjustes({});
    };
  });

  // Saludo
  const h = new Date().getHours();
  document.getElementById('hd-greeting').textContent =
    h < 12 ? 'Buen día ☀️' : h < 19 ? 'Buenas tardes' : 'Buenas noches 🌙';

  // Sidebar desktop nav
  document.querySelectorAll('[data-sidebar-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.sidebarTab;
      // Sincronizar con bottom nav
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('[data-sidebar-tab]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
      if (tab === 'gastos') switchTab('gastos');
      else if (tab === 'analisis') switchTab('analisis');
      else { switchTab('home'); if(tab==='tarjetas') openDialog('dlg-tarjeta'); if(tab==='cuentas') openDialog('dlg-cuenta'); if(tab==='metas') openDialog('dlg-meta'); }
    });
  });

  // Sidebar sync y settings
  document.getElementById('sb-sync')?.addEventListener('click', doSync);
  document.getElementById('sb-settings')?.addEventListener('click', abrirSettings);

  // Right panel acciones rápidas
  document.getElementById('rp-btn-gasto')?.addEventListener('click', () => openDialog('dlg-gasto'));
  document.getElementById('rp-btn-ingreso')?.addEventListener('click', () => openDialog('dlg-ingreso'));
  document.getElementById('rp-ver-todos')?.addEventListener('click', () => {
    switchTab('gastos');
    document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active', b.dataset.tab==='gastos'));
    document.querySelectorAll('[data-sidebar-tab]').forEach(b=>b.classList.toggle('active', b.dataset.sidebarTab==='gastos'));
  });

  // Settings tabs
  document.querySelectorAll('#settings-tabs .settings-tab').forEach(b =>
    b.addEventListener('click', () => cambiarSettingsTab(b.dataset.stab)));

  // Color presets
  document.querySelectorAll('.color-preset').forEach(b =>
    b.addEventListener('click', () => {
      const input = document.querySelector('#dlg-settings [name="color_primario"]');
      if (input) input.value = b.dataset.color;
    }));

  // Export JSON
  document.getElementById('btn-export-json')?.addEventListener('click', async () => {
    const data = {
      exportado_en: new Date().toISOString(),
      version: 1,
      gastos: state.gastos,
      ingresos: state.ingresos,
      tarjetas: state.tarjetas,
      metas: state.metas,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `finanzas_export_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('✓ Exportado');
  });

  // Import JSON
  document.getElementById('btn-import-json')?.addEventListener('click', () =>
    document.getElementById('file-import')?.click());
  document.getElementById('file-import')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Esto reemplazará tus datos locales con los del archivo. ¿Continuar?')) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.gastos)   { await DB.clear('gastos');   await DB.bulkPut('gastos', data.gastos); }
      if (data.ingresos) { await DB.clear('ingresos'); await DB.bulkPut('ingresos', data.ingresos); }
      if (data.tarjetas) { await DB.clear('tarjetas'); await DB.bulkPut('tarjetas', data.tarjetas); }
      if (data.metas)    { await DB.clear('metas');    await DB.bulkPut('metas', data.metas); }
      await reloadAll();
      toast('✓ Importado correctamente');
    } catch (err) {
      toast('Error al importar: ' + err.message, 3000);
    }
  });

  // Borrar todos los datos
  document.getElementById('btn-clear-data')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar TODOS los gastos, ingresos, tarjetas y metas? Esta acción no se puede deshacer.')) return;
    if (!confirm('Confirmá una vez más: vas a perder TODOS tus datos. ¿Continuar?')) return;
    await DB.clear('gastos');
    await DB.clear('ingresos');
    await DB.clear('tarjetas');
    await DB.clear('metas');
    await reloadAll();
    toast('Datos eliminados');
  });

  // ── WIDGET HISTORY DRAWER handlers ────────────────────────────
  const hdDlg = document.getElementById('dlg-widget-history');

  // Botones cerrar
  document.getElementById('hd-close')?.addEventListener('click',  () => hdDlg?.close());
  document.getElementById('hd-close-2')?.addEventListener('click', () => hdDlg?.close());

  // Filtros rápidos de fecha
  document.querySelectorAll('.hd-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hd-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hdState.range = btn.dataset.range;
      const calWrap = document.getElementById('hd-calendar-wrap');
      if (calWrap) {
        calWrap.hidden = (_hdState.range !== 'custom');
        if (_hdState.range === 'custom') {
          _hdState.custom = { from: null, to: null };
          _hdState.calYear  = new Date().getFullYear();
          _hdState.calMonth = new Date().getMonth();
          _hdRenderCalendar();
          // Limpiar labels
          const f = document.getElementById('hd-cal-from-label');
          const t = document.getElementById('hd-cal-to-label');
          if (f) f.textContent = '—';
          if (t) t.textContent = '—';
          return; // No filtramos hasta que el usuario elija rango
        }
      }
      _hdRenderItems();
      _hdRenderChart();
    });
  });

  // Navegación del calendario (prev/next mes)
  document.getElementById('hd-cal-prev')?.addEventListener('click', () => {
    _hdState.calMonth--;
    if (_hdState.calMonth < 0) { _hdState.calMonth = 11; _hdState.calYear--; }
    _hdRenderCalendar();
  });
  document.getElementById('hd-cal-next')?.addEventListener('click', () => {
    _hdState.calMonth++;
    if (_hdState.calMonth > 11) { _hdState.calMonth = 0; _hdState.calYear++; }
    _hdRenderCalendar();
  });

  // Limpiar selección calendario
  document.getElementById('hd-cal-clear')?.addEventListener('click', () => {
    _hdState.custom = { from: null, to: null };
    const f = document.getElementById('hd-cal-from-label');
    const t = document.getElementById('hd-cal-to-label');
    if (f) f.textContent = '—';
    if (t) t.textContent = '—';
    _hdRenderCalendar();
    _hdRenderItems();
    _hdRenderChart();
  });

  // Filtro de tipo
  document.querySelectorAll('.hd-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hd-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _hdState.tipo = btn.dataset.htype;
      _hdState.categorias.clear(); // resetear categorías al cambiar tipo
      _hdRenderCatChips();
      _hdRenderItems();
      _hdRenderChart();
    });
  });

  // Ordenamiento
  document.getElementById('hd-sort')?.addEventListener('change', (e) => {
    _hdState.sort = e.target.value;
    _hdRenderItems();
  });

  // Agregar movimiento desde el drawer
  document.getElementById('hd-add')?.addEventListener('click', () => {
    hdDlg?.close();
    const w = _hdState.widget;
    // Decidir qué diálogo abrir según el widget
    if (w === 'tarjetas' || w === 'simulacion_credito' || w === 'categorias' || w === 'flujo_mensual' || w === 'comparador') {
      openDialog('dlg-gasto');
    } else if (w === 'metas') {
      openDialog('dlg-meta');
    } else {
      openDialog('dlg-gasto');
    }
  });

  // Handlers de "+ Agregar" en tabs Catálogos/Cuentas
  document.getElementById('add-cat-gasto')?.addEventListener('click', () => {
    state.ajustes.catalogos = state.ajustes.catalogos || { categorias_gasto: [], categorias_ingreso: [] };
    state.ajustes.catalogos.categorias_gasto.push({ id: '', nombre: 'Nueva', icono: '✨', color: '#00f0ff' });
    renderCatalogoSettings('gasto');
  });
  document.getElementById('add-cat-ingreso')?.addEventListener('click', () => {
    state.ajustes.catalogos = state.ajustes.catalogos || { categorias_gasto: [], categorias_ingreso: [] };
    state.ajustes.catalogos.categorias_ingreso.push({ id: '', nombre: 'Nuevo', icono: '✨', color: '#00ff9f' });
    renderCatalogoSettings('ingreso');
  });
  document.getElementById('add-cuenta-btn')?.addEventListener('click', () => {
    openDialog('dlg-cuenta');
  });
  document.getElementById('add-tarjeta-btn')?.addEventListener('click', () => {
    openDialog('dlg-tarjeta');
  });
}

/* ============ Editor de catálogos en Settings ============ */

const EMOJI_POOL = ['🛒','⛽','🏠','🎬','🍽','💊','👗','🚌','💡','🥤','📚','📌','💼','💻','🎁','📈','🏘','🏷','✨','⚽','🎵','🎮','✈️','🏖','🚗','🛍','🎓','💪','🐾','🎨'];
const COLOR_POOL = ['#10b981','#f59e0b','#a78bfa','#ec4899','#fb923c','#f43f5e','#c084fc','#38bdf8','#facc15','#f87171','#22d3ee','#94a3b8','#00f0ff','#39ff14'];

function renderCatalogoSettings(tipo) {
  const lista = state.ajustes?.catalogos?.[`categorias_${tipo}`] || [];
  const contId = tipo === 'gasto' ? 'cat-gasto-list' : 'cat-ingreso-list';
  const cont = document.getElementById(contId);
  if (!cont) return;
  cont.innerHTML = '';

  lista.forEach((cat, idx) => {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.innerHTML = `
      <span class="catalog-item-emoji" data-action="emoji" data-idx="${idx}" data-tipo="${tipo}">${cat.icono}</span>
      <input class="catalog-item-name" type="text" value="${escapeHtml(cat.nombre)}" data-idx="${idx}" data-tipo="${tipo}" maxlength="32"/>
      <span class="catalog-item-color" data-action="color" data-idx="${idx}" data-tipo="${tipo}" style="background:${cat.color}"></span>
      <button type="button" class="catalog-item-del" data-action="del" data-idx="${idx}" data-tipo="${tipo}" title="Eliminar">✕</button>
    `;
    cont.appendChild(item);
  });

  // Bindings de eventos
  cont.querySelectorAll('.catalog-item-name').forEach(inp => {
    inp.oninput = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const tp = e.target.dataset.tipo;
      const arr = state.ajustes.catalogos[`categorias_${tp}`];
      arr[idx].nombre = e.target.value;
      // Auto-generar id desde nombre si está vacío
      if (!arr[idx].id) arr[idx].id = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '_');
    };
  });
  cont.querySelectorAll('[data-action="emoji"]').forEach(el => {
    el.onclick = (e) => mostrarPickerEmoji(e.target);
  });
  cont.querySelectorAll('[data-action="color"]').forEach(el => {
    el.onclick = (e) => mostrarPickerColor(e.target);
  });
  cont.querySelectorAll('[data-action="del"]').forEach(btn => {
    btn.onclick = (e) => {
      const idx = parseInt(btn.dataset.idx);
      const tp = btn.dataset.tipo;
      if (!confirm('¿Eliminar esta categoría?')) return;
      state.ajustes.catalogos[`categorias_${tp}`].splice(idx, 1);
      renderCatalogoSettings(tp);
    };
  });
}

function mostrarPickerEmoji(target) {
  // Cerrar pickers previos
  document.querySelectorAll('.catalog-item-edit-popover').forEach(p => p.remove());

  const idx = parseInt(target.dataset.idx);
  const tipo = target.dataset.tipo;
  const popover = document.createElement('div');
  popover.className = 'catalog-item-edit-popover';
  EMOJI_POOL.forEach(e => {
    const b = document.createElement('button');
    b.className = 'catalog-emoji-btn';
    b.type = 'button';
    b.textContent = e;
    b.onclick = () => {
      state.ajustes.catalogos[`categorias_${tipo}`][idx].icono = e;
      renderCatalogoSettings(tipo);
      popover.remove();
    };
    popover.appendChild(b);
  });
  // Posicionar
  const rect = target.getBoundingClientRect();
  popover.style.top  = `${rect.bottom + 4}px`;
  popover.style.left = `${rect.left}px`;
  document.body.appendChild(popover);
  // Cerrar al clickear fuera
  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) { popover.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 10);
}

function mostrarPickerColor(target) {
  document.querySelectorAll('.catalog-item-edit-popover').forEach(p => p.remove());
  const idx = parseInt(target.dataset.idx);
  const tipo = target.dataset.tipo;
  const popover = document.createElement('div');
  popover.className = 'catalog-item-edit-popover';
  popover.style.gridTemplateColumns = 'repeat(7, 28px)';
  COLOR_POOL.forEach(c => {
    const b = document.createElement('button');
    b.className = 'catalog-emoji-btn';
    b.type = 'button';
    b.style.background = c;
    b.onclick = () => {
      state.ajustes.catalogos[`categorias_${tipo}`][idx].color = c;
      renderCatalogoSettings(tipo);
      popover.remove();
    };
    popover.appendChild(b);
  });
  const rect = target.getBoundingClientRect();
  popover.style.top  = `${rect.bottom + 4}px`;
  popover.style.left = `${rect.left}px`;
  document.body.appendChild(popover);
  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) { popover.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 10);
}

function renderCuentasSettings() {
  const cont = document.getElementById('cuentas-list');
  if (!cont) return;
  cont.innerHTML = '';
  const cuentas = state.cuentas || [];
  if (!cuentas.length) {
    cont.innerHTML = `<p class="text-xs text-center py-4" style="color:var(--ink-muted)">Sin cuentas. Tocá "+ Agregar cuenta".</p>`;
    return;
  }
  const TIPOS = {
    caja_ahorro:'🏦', cuenta_corriente:'💼', billetera:'📱',
    efectivo:'💵', inversion:'📈', cripto:'₿',
  };
  const NOMBRES = {
    caja_ahorro:'Caja ahorro', cuenta_corriente:'Cta corriente', billetera:'Billetera',
    efectivo:'Efectivo', inversion:'Inversión', cripto:'Cripto',
  };
  cuentas.forEach(c => {
    const ic = TIPOS[c.tipo] || '🏦';
    const color = c.color || 'var(--brand)';
    const div = document.createElement('div');
    div.className = 'account-mini';
    div.innerHTML = `
      <div class="account-mini-icon" style="background:${color}22;color:${color}">${ic}</div>
      <div class="account-mini-info">
        <p class="account-mini-name">${escapeHtml(c.nombre)}</p>
        <p class="account-mini-tipo">${NOMBRES[c.tipo] || ''}${c.banco ? ' · ' + escapeHtml(c.banco) : ''}</p>
      </div>
      <div class="account-mini-actions">
        <button type="button" data-action="edit" data-id="${c.id}" title="Editar">✎</button>
        <button type="button" data-action="del"  data-id="${c.id}" title="Eliminar">✕</button>
      </div>
    `;
    cont.appendChild(div);
  });
  cont.querySelectorAll('[data-action="edit"]').forEach(b => b.onclick = () => editarCuenta(b.dataset.id));
  cont.querySelectorAll('[data-action="del"]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Eliminar esta cuenta? Los movimientos asociados no se borran.')) return;
    await DB.softDelete('cuentas', b.dataset.id);
    await reloadAll();
    renderCuentasSettings();
    toast('Cuenta eliminada');
  });
}

async function editarCuenta(id) {
  const c = (state.cuentas || []).find(x => x.id === id);
  if (!c) return;
  const dlg = document.getElementById('dlg-cuenta');
  const form = dlg.querySelector('form');
  form.reset();
  form.elements._editing_id.value = id;
  if (form.elements.nombre)        form.elements.nombre.value = c.nombre || '';
  if (form.elements.banco)         form.elements.banco.value = c.banco || '';
  if (form.elements.saldo_inicial) form.elements.saldo_inicial.value = c.saldo_inicial || 0;
  if (form.elements.color)         form.elements.color.value = c.color || '#00ff9f';
  if (form.elements.moneda)        form.elements.moneda.value = c.moneda || 'ARS';
  const radioTipo = form.querySelector(`input[name="tipo"][value="${c.tipo}"]`);
  if (radioTipo) radioTipo.checked = true;
  dlg.showModal();
}

function renderTarjetasSettings() {
  const cont = document.getElementById('tarjetas-list');
  if (!cont) return;
  cont.innerHTML = '';
  const tarjetas = state.tarjetas || [];
  if (!tarjetas.length) {
    cont.innerHTML = `<p class="text-xs text-center py-4" style="color:var(--ink-muted)">Sin tarjetas.</p>`;
    return;
  }
  tarjetas.forEach(t => {
    const color = t.color || 'var(--brand)';
    const div = document.createElement('div');
    div.className = 'account-mini';
    div.innerHTML = `
      <div class="account-mini-icon" style="background:${color}22;color:${color}">💳</div>
      <div class="account-mini-info">
        <p class="account-mini-name">${escapeHtml(t.nombre)}</p>
        <p class="account-mini-tipo">${escapeHtml(t.banco || '—')} · cierre ${t.dia_cierre} · vence ${t.dia_vencimiento}</p>
      </div>
      <div class="account-mini-actions">
        <button type="button" data-action="edit" data-id="${t.id}" title="Editar">✎</button>
        <button type="button" data-action="del"  data-id="${t.id}" title="Eliminar">✕</button>
      </div>
    `;
    cont.appendChild(div);
  });
  cont.querySelectorAll('[data-action="edit"]').forEach(b => b.onclick = () => editarTarjeta(b.dataset.id));
  cont.querySelectorAll('[data-action="del"]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Eliminar esta tarjeta? Los gastos asociados no se borran pero quedarán huérfanos.')) return;
    await DB.softDelete('tarjetas', b.dataset.id);
    await reloadAll();
    renderTarjetasSettings();
    toast('Tarjeta eliminada');
  });
}

async function editarTarjeta(id) {
  const t = (state.tarjetas || []).find(x => x.id === id);
  if (!t) return;
  const dlg = document.getElementById('dlg-tarjeta');
  const form = dlg.querySelector('form');
  form.reset();
  if (form.elements.nombre)          form.elements.nombre.value = t.nombre || '';
  if (form.elements.banco)           form.elements.banco.value = t.banco || '';
  if (form.elements.ultimos_4)       form.elements.ultimos_4.value = t.ultimos_4 || '';
  if (form.elements.limite_un_pago)  form.elements.limite_un_pago.value = t.limite_un_pago || 0;
  if (form.elements.limite_cuotas)   form.elements.limite_cuotas.value = t.limite_cuotas || 0;
  if (form.elements.dia_cierre)      form.elements.dia_cierre.value = t.dia_cierre || 15;
  if (form.elements.dia_vencimiento) form.elements.dia_vencimiento.value = t.dia_vencimiento || 5;
  if (form.elements.color)           form.elements.color.value = t.color || '#00f0ff';
  dlg.showModal();
}

// Handler "Probar conexión y sincronizar" en Settings → Sync
document.addEventListener('click', async (e) => {
  if (e.target.id !== 'btn-test-sync') return;
  const form = document.querySelector('#dlg-settings form');
  if (!form) return;
  // Guardar primero la config sin cerrar
  const tempCfg = {
    pat: form.elements.gh_pat?.value || null,
    owner: form.elements.gh_owner?.value || null,
    repo: form.elements.gh_repo?.value || null,
    branch: form.elements.gh_branch?.value || 'main',
    ruta_datos: form.elements.gh_ruta?.value || 'data',
  };
  if (!tempCfg.pat || !tempCfg.owner || !tempCfg.repo) {
    toast('Completá PAT, owner y repo', 2500);
    return;
  }
  e.target.disabled = true;
  e.target.textContent = '⏳ Probando…';
  try {
    state.ajustes.github = tempCfg;
    await DB.put('ajustes', state.ajustes);
    await syncAll(tempCfg);
    await reloadAll();
    actualizarSyncStatusCard();
    actualizarTimestampSync();
    setSyncIndicator('ok');
    toast('✓ Conexión exitosa y datos sincronizados', 2500);
    reiniciarAutoSync();
  } catch (err) {
    setSyncIndicator('error');
    actualizarSyncStatusCard();
    toast('✗ Falló: ' + err.message, 4000);
  } finally {
    e.target.disabled = false;
    e.target.textContent = '🔌 Probar conexión y sincronizar';
  }
});

// Cuando el usuario vuelve online: actualizar indicador
window.addEventListener('online',  () => { setSyncIndicator('ok'); actualizarSyncStatusCard(); });
window.addEventListener('offline', () => { setSyncIndicator('offline'); actualizarSyncStatusCard(); });

document.addEventListener('DOMContentLoaded', init);

// Re-sincronizar al volver online
window.addEventListener('online', () => {
  const cfg = state.ajustes?.github;
  if (cfg?.pat) doSync();
});

// Sincronizar chips de categoría con el input de texto en dlg-gasto
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-gasto input[name="cat_quick"]')) {
    const txtInput = document.querySelector('#dlg-gasto input[name="categoria"]');
    if (txtInput) txtInput.value = e.target.value;
  }
});

// ── Info banner del ciclo de pago (dlg-gasto) ──────────────────
// Cuando el usuario elige "Crédito" + tarjeta + fecha, mostrar en qué
// resumen cae el gasto y cuándo se pagará.
function actualizarCicloInfo() {
  const dlg = document.getElementById('dlg-gasto');
  if (!dlg || !dlg.open) return;
  const form   = dlg.querySelector('form');
  const banner = document.getElementById('ciclo-info');
  if (!banner) return;

  const metodo = form.elements.metodo_pago?.value;
  const fecha  = form.elements.fecha?.value;
  const tipo   = form.elements.tipo?.value;
  let tarjetaId = null;
  if (tipo === 'cuotas') tarjetaId = form.elements.tarjeta_id?.value;
  else                    tarjetaId = form.elements.tarjeta_id_simple?.value;

  // Solo mostrar banner si es crédito + tarjeta seleccionada + fecha
  if (metodo !== 'credito' || !tarjetaId || !fecha) {
    banner.hidden = true;
    return;
  }

  const tarjeta = state.tarjetas.find(t => t.id === tarjetaId);
  if (!tarjeta) { banner.hidden = true; return; }

  const info = cicloDelGasto(fecha, tarjeta);

  const titleEl = document.getElementById('ciclo-info-title');
  const subEl   = document.getElementById('ciclo-info-sub');
  const cuotas  = parseInt(form.elements.cuotas_total?.value) || 1;
  const monto   = parseFloat(form.elements.monto?.value) || 0;
  const montoCuota = cuotas > 1 ? monto / cuotas : monto;

  if (titleEl) {
    titleEl.textContent = info.esCicloActual
      ? `💳 Caerá en el resumen de este ciclo (${info.periodo})`
      : `💳 Caerá en el resumen de ${info.periodo}`;
  }
  if (subEl) {
    let txt = info.mensaje;
    if (tipo === 'cuotas' && cuotas > 1 && monto > 0) {
      txt += ` · ${cuotas} cuotas de ${FMT.format(montoCuota)}`;
    }
    subEl.textContent = txt;
  }
  banner.hidden = false;
}

document.addEventListener('input', (e) => {
  if (e.target.closest('#dlg-gasto')) actualizarCicloInfo();
});
document.addEventListener('change', (e) => {
  if (e.target.closest('#dlg-gasto')) actualizarCicloInfo();
});

// ── Preview en vivo de la tarjeta ────────────────────────────
function updateCardPreview() {
  const dlg = document.getElementById('dlg-tarjeta');
  if (!dlg || !dlg.open) return;
  const f = dlg.querySelector('form');
  const card = document.getElementById('card-preview');
  if (!card) return;

  const nombre = f.elements.nombre?.value || 'Tarjeta';
  const banco  = f.elements.banco?.value || 'Banco';
  const num    = f.elements.ultimos_4?.value || '';
  const cierre = f.elements.dia_cierre?.value || '—';
  const venc   = f.elements.dia_vencimiento?.value || '—';
  const color  = f.elements.color?.value || '#00f0ff';

  const cpName = document.getElementById('cp-nombre');
  const cpBank = document.getElementById('cp-bank');
  const cpNum  = document.getElementById('cp-num');
  const cpC    = document.getElementById('cp-cierre');
  const cpV    = document.getElementById('cp-venc');
  if (cpName) cpName.textContent = nombre;
  if (cpBank) cpBank.textContent = banco;
  if (cpNum)  cpNum.textContent  = num ? `•••• •••• •••• ${num}` : '•••• •••• •••• ••••';
  if (cpC)    cpC.textContent    = cierre;
  if (cpV)    cpV.textContent    = venc;

  card.style.background = `linear-gradient(135deg, ${color}dd 0%, ${color}77 100%)`;
}

document.addEventListener('input', (e) => {
  if (e.target.closest('#dlg-tarjeta')) updateCardPreview();
});

// Slider días: actualizar badge
document.addEventListener('input', (e) => {
  if (e.target.id === 'ip-cierre') {
    document.getElementById('badge-cierre').textContent = e.target.value;
  }
  if (e.target.id === 'ip-venc') {
    document.getElementById('badge-venc').textContent = e.target.value;
  }
});

// Sincronizar bank_quick → banco
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-tarjeta input[name="bank_quick"]')) {
    const txt = document.querySelector('#dlg-tarjeta input[name="banco"]');
    if (txt) { txt.value = e.target.value; updateCardPreview(); }
  }
});

// Sincronizar color_quick → color
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-tarjeta input[name="color_quick"]')) {
    const c = document.querySelector('#dlg-tarjeta input[name="color"]');
    if (c) { c.value = e.target.value; updateCardPreview(); }
  }
});

// Sincronizar color_quick → color en dlg-cuenta
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-cuenta input[name="color_quick"]')) {
    const c = document.querySelector('#dlg-cuenta input[name="color"]');
    if (c) c.value = e.target.value;
  }
});

// Cuando abre el diálogo, refrescar preview
const _origOpenDialog = window.openDialog;
if (typeof _origOpenDialog === 'function') {
  // Si openDialog está expuesto, lo respetamos. Si no, igual el preview funciona via input event.
}

// ── Dlg meta: preset → nombre + emergencia ──────────────────
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-meta input[name="goal_preset"]')) {
    const card = e.target.closest('.goal-card');
    if (!card) return;
    const nombre = document.getElementById('meta-nombre');
    const emerg  = document.getElementById('meta-emergencia');
    if (nombre && card.dataset.goalName !== undefined && !nombre.value) {
      nombre.value = card.dataset.goalName;
    }
    if (emerg) {
      emerg.checked = (card.dataset.goalEmergency === 'true');
    }
  }
});

// ── Dlg meta: barra de progreso en vivo ─────────────────────
function updateMetaProgress() {
  const dlg = document.getElementById('dlg-meta');
  if (!dlg || !dlg.open) return;
  const obj = parseFloat(document.getElementById('meta-obj')?.value) || 0;
  const act = parseFloat(document.getElementById('meta-act')?.value) || 0;
  const pct = obj > 0 ? Math.min(100, (act / obj) * 100) : 0;
  const falta = Math.max(0, obj - act);
  const pctFalta = 100 - pct;

  const bar = document.getElementById('meta-bar');
  const pctEl = document.getElementById('meta-pct');
  const faltaEl = document.getElementById('meta-falta');
  const pctFaltaEl = document.getElementById('meta-pct-falta');
  if (bar) bar.style.width = pct.toFixed(1) + '%';
  if (pctEl) pctEl.textContent = pct.toFixed(0) + '%';
  if (faltaEl) faltaEl.textContent = '$' + falta.toLocaleString('es-AR');
  if (pctFaltaEl) pctFaltaEl.textContent = pctFalta.toFixed(0) + '%';
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'meta-obj' || e.target.id === 'meta-act') updateMetaProgress();
});

// ── Dlg meta: fecha quick presets ───────────────────────────
document.addEventListener('click', (e) => {
  if (!e.target.matches('.goal-date-btn')) return;
  e.preventDefault();
  document.querySelectorAll('.goal-date-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  const months = parseInt(e.target.dataset.months);
  const future = new Date();
  future.setMonth(future.getMonth() + months);
  const iso = future.toISOString().slice(0, 10);
  const fechaInput = document.getElementById('meta-fecha');
  if (fechaInput) fechaInput.value = iso;
});

// ── Dlg meta: estrellas de prioridad ────────────────────────
document.addEventListener('change', (e) => {
  if (!e.target.matches('#dlg-meta input[name="prioridad"]')) return;
  const value = parseInt(e.target.value);
  document.querySelectorAll('#meta-priority .prio-star').forEach(s => {
    const p = parseInt(s.dataset.prio);
    s.classList.toggle('active', p <= value);
  });
  const labels = { 1: 'Crítica', 2: 'Alta', 3: 'Media', 4: 'Baja', 5: 'Mínima' };
  const lbl = document.getElementById('prio-label');
  if (lbl) lbl.textContent = labels[value] || 'Media';
});

// Inicializar estrellas en valor 3 al cargar
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const checked = document.querySelector('#dlg-meta input[name="prioridad"]:checked');
    if (checked) checked.dispatchEvent(new Event('change', { bubbles: true }));
  }, 100);
});

// Selector de modo del chart en historial
document.addEventListener('click', (e) => {
  if (!e.target.matches('.hd-chart-mode')) return;
  document.querySelectorAll('.hd-chart-mode').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  _hdState.chartMode = e.target.dataset.mode;
  _hdRenderChart();
});
