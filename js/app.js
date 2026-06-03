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
import { resumenTarjeta, fechasCiclo, rangoCicloActual, cicloDelGasto, cuotaEnPeriodo, estadoCiclo } from './cards.js';
import { calcularCapacidad, simularCompra, cuotasPendientes } from './credito.js';
import { diagnosticar, diagnosticarTarjetas } from './ai-local.js';
import { proyectarBalance, predecirSaturacionTarjetas, sugerirCategoria } from './ai-predict.js';
import { analizarSaludFinanciera, simularEscenario } from './ai-advisor.js';
import { fetchCotizaciones, timestampUltimoFetch } from './cotizaciones.js';
import { Notif, chequeoDiarioTarjetas, chequeoMargenDisponible } from './notifications.js';
import { syncAll, pullAll, startAutoSync, stopAutoSync, programarPush, triggerSync, ultimaSync, wipeRemoto } from './sync.js';

/* ============ Estado en memoria (cache de render) ============ */
const state = {
  ajustes: null,
  gastos: [],
  ingresos: [],
  tarjetas: [],
  metas: [],
  cuentas: [],
  resumenes: [],     // resúmenes de tarjetas precomputados
  capacidad: null,   // cálculo de capacidad crediticia
  estado: null,      // estado global
  diagnosticos: [],
  proyeccion: null,  // proyectarBalance()
  saturacion: [],    // predecirSaturacionTarjetas()
  salud: null,       // analizarSaludFinanciera() — asesor integral
  version: null,     // info del archivo version.json
};

/* ============ Versión / Build / Auto-update ============ */
let _swReg = null;
let _hayActualizacionSW = false;
let _chequeoActIniciado = false;

/**
 * Chequea version.json y, si hay un build más nuevo que el cargado, dispara la
 * actualización del Service Worker. Según el ajuste `auto_update`:
 *  - ON  → aplica en silencio (recarga cuando el SW nuevo toma control).
 *  - OFF → muestra un toast/badge para que el usuario actualice cuando quiera.
 */
async function chequearActualizacion(manual = false) {
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const v = await r.json();
    const buildActual = state.version?.build || parseInt(localStorage.getItem('app_last_build') || '0');
    if (v.build && buildActual && v.build > buildActual) {
      // Hay versión nueva: pedir al SW que se actualice (descarga el shell nuevo)
      try { await _swReg?.update(); } catch {}
      const auto = state.ajustes?.auto_update !== false; // default ON
      if (auto) {
        // Silencioso: el SW nuevo se activará y controllerchange recargará.
        aplicarActualizacionSiCorresponde();
        // Si no hay SW (o ya estaba en control), forzamos una recarga suave.
        if (!_hayActualizacionSW) setTimeout(() => location.reload(), 800);
      } else {
        mostrarBannerActualizacion(v);
      }
    } else if (manual) {
      toast('✓ Ya tenés la última versión', 2000);
    }
  } catch (e) {
    if (manual) toast('No se pudo verificar actualizaciones', 2500);
  }
}

/** Aplica la actualización del SW (skip waiting) si el usuario tiene auto-update. */
function aplicarActualizacionSiCorresponde() {
  const auto = state.ajustes?.auto_update !== false;
  if (!auto || !_hayActualizacionSW) return;
  // Evitar recargar si el usuario está en medio de un formulario abierto.
  const dlgAbierto = [...document.querySelectorAll('dialog')].some(d => d.open);
  if (dlgAbierto) return; // se aplicará al cerrar / próximo chequeo
  const waiting = _swReg?.waiting;
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Banner no intrusivo cuando hay update y auto-update está apagado. */
function mostrarBannerActualizacion(v) {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span>✨ Nueva versión v${escapeHtml(String(v.version))} disponible</span>
    <button id="update-banner-btn">Actualizar</button>
    <button id="update-banner-x" aria-label="Cerrar">✕</button>`;
  document.body.appendChild(banner);
  banner.querySelector('#update-banner-btn').onclick = () => {
    _hayActualizacionSW = true;
    const waiting = _swReg?.waiting;
    if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
    else location.reload();
  };
  banner.querySelector('#update-banner-x').onclick = () => banner.remove();
}

/**
 * Bloquea la orientación a vertical. La Screen Orientation API solo permite
 * lock cuando la app corre instalada (standalone) o en pantalla completa; en el
 * navegador normal el manifest "orientation":"portrait" es lo que aplica al
 * instalarla. Hacemos el intento de forma segura (ignora si no está permitido).
 */
function bloquearOrientacionVertical() {
  const intentar = () => {
    try {
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        screen.orientation.lock('portrait').catch(() => {});
      }
    } catch {}
  };
  intentar();
  // Re-intentar al entrar en pantalla completa (ahí sí está permitido)
  document.addEventListener('fullscreenchange', intentar);
}

function iniciarChequeoActualizaciones() {
  if (_chequeoActIniciado) return;
  _chequeoActIniciado = true;
  // Cada 10 minutos si la pestaña está visible
  setInterval(() => {
    if (document.visibilityState === 'visible') chequearActualizacion(false);
  }, 10 * 60_000);
  // Al volver a la app (focus / visible) también chequeamos
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') chequearActualizacion(false);
  });
}

async function cargarVersion() {
  try {
    // Cache-bust con timestamp del momento de carga para que siempre traiga la última
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const v = await r.json();
    state.version = v;
    actualizarVersionUI();
    return v;
  } catch (e) {
    console.warn('Sin version.json', e);
    return null;
  }
}

function actualizarVersionUI() {
  const v = state.version;
  if (!v) return;

  // Versión corta: tomamos como mucho 2 segmentos (mayor.menor).
  // Soporta formatos: "1" → "1", "1.2" → "1.2", "1.2.3" → "1.2".
  const corto = String(v.version || '').split('.').slice(0, 2).join('.') || '0';

  // Sidebar
  const sbVer = document.getElementById('sb-version');
  if (sbVer) {
    const dt = new Date(v.modified);
    sbVer.innerHTML = `<span class="version-tag">v${corto}</span>`;
    sbVer.title = `Versión ${v.version} · Build #${v.build}\nÚltima actualización: ${dt.toLocaleString('es-AR')}\nCommit: ${v.commit}`;
  }

  // Mini badge mobile en header
  const hdVer = document.getElementById('hd-version');
  if (hdVer) {
    hdVer.textContent = `v${corto}`;
  }

  // Toast al detectar versión nueva (comparado con la guardada en localStorage)
  try {
    const last = localStorage.getItem('app_last_build');
    if (last && parseInt(last) !== v.build) {
      setTimeout(() => toast(`✨ Versión actualizada: v${v.version} · build #${v.build}`, 3500), 1500);
    }
    localStorage.setItem('app_last_build', String(v.build));
    localStorage.setItem('app_last_version', v.version);
  } catch {}
}

const FMT = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

/* ============ Estado de navegación por tabs ============ */
let currentTab = 'home';
let _movMesFiltro = '';
let _movCatFiltro = '';      // categoría activa en filtro historial
let _movSubcatFiltro = '';   // subcategoría activa en filtro historial
let _movTxtFiltro = '';      // búsqueda de texto libre

const WIDGETS_ANALISIS = new Set([
  'prediccion', 'ia_local', 'comparador', 'flujo_mensual',
  'categorias', 'resumen_anual', 'grafico', 'balance',
]);

function switchTab(tab) {
  currentTab = tab;
  const root  = document.getElementById('main-widgets');
  const secMov = document.getElementById('section-movimientos');
  const secTarjetasMobile = document.getElementById('sec-tarjetas-mobile');
  const secMetasMobile = document.getElementById('sec-metas-mobile');

  // Reset clases de modo
  document.body.classList.remove('view-analisis');

  if (tab === 'gastos') {
    root.classList.add('hidden');
    secMov?.classList.remove('hidden');
    secTarjetasMobile?.classList.add('hidden');
    secMetasMobile?.classList.add('hidden');
    renderMovimientos();
    return;
  }

  if (tab === 'tarjetas') {
    root.classList.add('hidden');
    secMov?.classList.add('hidden');
    secTarjetasMobile?.classList.remove('hidden');
    secMetasMobile?.classList.add('hidden');
    renderTarjetasMobile();
    return;
  }

  if (tab === 'metas') {
    root.classList.add('hidden');
    secMov?.classList.add('hidden');
    secTarjetasMobile?.classList.add('hidden');
    secMetasMobile?.classList.remove('hidden');
    renderMetasMobile();
    return;
  }

  // Tabs que muestran el dashboard
  root.classList.remove('hidden');
  secMov?.classList.add('hidden');
  secTarjetasMobile?.classList.add('hidden');
  secMetasMobile?.classList.add('hidden');

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
    widgets_visibles: ['estado_global','sueldo','cuentas','tarjetas','habituales','simulacion_credito','prediccion','ia_local','metas','balance','grafico','resumen_anual','flujo_mensual','categorias','tipo_cambio','calculadora','comparador'],
    widgets_orden: ['estado_global','sueldo','cuentas','tarjetas','habituales','simulacion_credito','prediccion','ia_local','metas','balance','grafico','resumen_anual','flujo_mensual','categorias','tipo_cambio','calculadora','comparador'],
    widgets_tamanos: {
      estado_global: 'lg',
      sueldo:        'lg',
      cuentas:       'md',
      tarjetas:      'md',
      habituales:    'md',
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
    // Gastos habituales = contadores con valor fijo (ej: "Vianda" $5000).
    // Cada toque en acción rápida registra un gasto de ese valor.
    habituales: [
      { id: 'vianda',  nombre: 'Vianda',  icono: '🍱', color: '#fb923c', valor: 5000, categoria: 'comida' },
      { id: 'cafe',    nombre: 'Café',    icono: '☕', color: '#a16207', valor: 2500, categoria: 'kiosco' },
    ],
  },
  // Si se elige una cuenta, los gastos habituales se descuentan de ella.
  habituales_cuenta_id: null,
  // Auto-actualización de la app (chequea version.json y aplica en silencio).
  auto_update: true,
};

async function loadAjustes() {
  let aj = await DB.get('ajustes', 'ajustes_globales');
  if (!aj) {
    aj = structuredClone(AJUSTES_DEFAULT);
    await DB.put('ajustes', aj);
  }
  state.ajustes = aj;
  await _migrarWidgetsNuevos(aj);
  return aj;
}

// Migración: cuando se agregan widgets nuevos al código (ej. prediccion,
// balance), los appendea a widgets_orden y widgets_visibles del usuario para
// que aparezcan por defecto. Un widget "nuevo" es el que NO estaba en el
// orden guardado (así respetamos los que el usuario haya deseleccionado).
async function _migrarWidgetsNuevos(aj) {
  if (!aj.ui || !Array.isArray(aj.ui.widgets_orden)) return;
  const nuevos = Object.keys(TPL).filter(k => !aj.ui.widgets_orden.includes(k));
  if (!nuevos.length) return;
  aj.ui.widgets_orden.push(...nuevos);
  if (Array.isArray(aj.ui.widgets_visibles)) {
    aj.ui.widgets_visibles.push(...nuevos.filter(k => !aj.ui.widgets_visibles.includes(k)));
  }
  try { await DB.put('ajustes', aj); } catch {}
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
  aplicarColoresPersonalizados(esClaro);
  document.getElementById('meta-theme')?.setAttribute('content', esClaro ? '#f0f4ff' : '#07090f');
}

/* ============ Sistema de colores personalizable ============
   El usuario puede personalizar todos los colores del sistema. Definimos cada
   color con su valor por defecto (oscuro/claro) y las variables CSS que afecta.
   `bg`/`soft`/`-2` se DERIVAN del color base para mantener coherencia.        */
const PALETA_SISTEMA = [
  { id: 'brand',   nombre: 'Acento principal',  desc: 'Botones, links, resaltados', def: '#00f0ff', defLight: '#4f46e5',
    vars: c => ({ '--brand': c, '--brand-glow': c + '88', '--brand-soft': c + '26', '--info': c, '--info-bg': c + '1a' }) },
  { id: 'brand2',  nombre: 'Acento secundario', desc: 'Gradientes, segundo neón',   def: '#ff00ea', defLight: '#ec4899',
    vars: c => ({ '--brand-2': c, '--neon-pink': c }) },
  { id: 'brand3',  nombre: 'Acento terciario',  desc: 'Detalles, badges',           def: '#ffea00', defLight: '#f59e0b',
    vars: c => ({ '--brand-3': c }) },
  { id: 'success', nombre: 'Éxito / Ingresos',  desc: 'Saldos positivos, ingresos', def: '#00ff9f', defLight: '#059669',
    vars: c => ({ '--success': c, '--success-2': _ajustarLuminancia(c, 1.3), '--success-bg': c + '1a', '--neon-green': c }) },
  { id: 'danger',  nombre: 'Peligro / Gastos',  desc: 'Gastos, alertas, eliminar',  def: '#ff2d6e', defLight: '#dc2626',
    vars: c => ({ '--danger': c, '--danger-2': _ajustarLuminancia(c, 1.3), '--danger-bg': c + '1a' }) },
  { id: 'warning', nombre: 'Advertencia',       desc: 'Avisos, vencimientos',       def: '#ffb800', defLight: '#d97706',
    vars: c => ({ '--warning': c, '--warning-2': _ajustarLuminancia(c, 1.3), '--warning-bg': c + '1a' }) },
];

/** Aplica los colores (custom o por defecto del tema) a las variables CSS. */
function aplicarColoresPersonalizados(esClaro) {
  const custom = state.ajustes?.ui?.colores || {};
  const root = document.documentElement.style;
  let brandVal = '#00f0ff', brand2Val = '#ff00ea';
  for (const c of PALETA_SISTEMA) {
    // legacy: color_primario sigue siendo el acento principal si no hay custom.brand
    const fallback = (c.id === 'brand' && state.ajustes?.ui?.color_primario) || (esClaro ? c.defLight : c.def);
    const valor = custom[c.id] || fallback;
    if (c.id === 'brand')  brandVal  = valor;
    if (c.id === 'brand2') brand2Val = valor;
    const vars = c.vars(valor);
    for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  }
  // Glows decorativos del fondo, derivados del acento (adaptan al color y al
  // tema: más sutiles en claro para que no ensucien el fondo blanco).
  const aG = esClaro ? '14' : '26';   // alpha radial 1 (hex)
  const bG = esClaro ? '0d' : '18';   // alpha radial 2
  root.setProperty('--bg-glow-a', brandVal  + aG);
  root.setProperty('--bg-glow-b', brand2Val + bG);
  root.setProperty('--bg-grid',   brandVal  + (esClaro ? '08' : '06'));
}

/** Lee una variable CSS del :root (ya resuelta por tema + colores custom). */
function _cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
/** hex (#rrggbb) + alpha (0..1) → #rrggbbaa, para gradientes de canvas. */
function _hexAlpha(hex, alpha) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return hex; // si ya es rgba u otro formato, lo dejamos
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0');
  return '#' + h + a;
}
/** Color efectivo actual de un id de la paleta (custom o default del tema). */
function _colorActual(id, esClaro) {
  const c = PALETA_SISTEMA.find(x => x.id === id);
  if (!c) return '#000000';
  const custom = state.ajustes?.ui?.colores || {};
  return custom[id] || (c.id === 'brand' && state.ajustes?.ui?.color_primario) || (esClaro ? c.defLight : c.def);
}

/** Renderiza el panel de colores personalizables en Ajustes → General. */
function renderColoresSistema() {
  const cont = document.getElementById('colores-sistema');
  if (!cont) return;
  const esClaro = document.documentElement.classList.contains('light');
  cont.innerHTML = PALETA_SISTEMA.map(c => {
    const val = _colorActual(c.id, esClaro);
    return `
      <div class="color-row" data-color-id="${c.id}">
        <label class="color-swatch-wrap" title="Elegir color">
          <span class="color-swatch-preview" style="background:${escapeHtml(val)}"></span>
          <input type="color" class="color-swatch-input" value="${escapeHtml(val)}" data-color-input="${c.id}">
        </label>
        <div class="color-row-info">
          <span class="color-row-name">${escapeHtml(c.nombre)}</span>
          <span class="color-row-desc">${escapeHtml(c.desc)}</span>
        </div>
        <span class="color-row-hex">${escapeHtml(val.toUpperCase())}</span>
      </div>`;
  }).join('');

  cont.querySelectorAll('[data-color-input]').forEach(inp => {
    // 'input' = preview en vivo mientras arrastra el picker (sin escribir a DB)
    inp.oninput = () => {
      const id = inp.dataset.colorInput;
      if (!state.ajustes.ui.colores) state.ajustes.ui.colores = {};
      state.ajustes.ui.colores[id] = inp.value;
      if (id === 'brand') state.ajustes.ui.color_primario = inp.value; // legacy sync
      const row = inp.closest('.color-row');
      row.querySelector('.color-swatch-preview').style.background = inp.value;
      row.querySelector('.color-row-hex').textContent = inp.value.toUpperCase();
      aplicarTema();
    };
    // 'change' = al soltar el picker, persistimos a IndexedDB (y se sincroniza)
    inp.onchange = async () => {
      try { await DB.put('ajustes', state.ajustes); notificarCambioLocal(); } catch {}
    };
  });
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

  // Capacidad crediticia avanzada (considera cuotas pendientes)
  state.capacidad = calcularCapacidad({
    gastos:    state.gastos,
    ingresos:  state.ingresos,
    tarjetas:  state.tarjetas,
    resumenes: state.resumenes,
  });

  // Estado global (cálculo local, sin backend)
  state.estado = computarEstadoGlobal();

  // Diagnósticos IA
  state.diagnosticos = diagnosticar(state.gastos, {
    sensibilidad: state.ajustes?.sensibilidad_ia || 'moderado',
  });

  // Diagnóstico específico de tarjetas (uso, cuotas, saturación, tendencias)
  const diagTarjetas = diagnosticarTarjetas({
    gastos:    state.gastos,
    ingresos:  state.ingresos,
    tarjetas:  state.tarjetas,
    resumenes: state.resumenes,
    capacidad: state.capacidad,
  });
  // Mergeamos: tarjetas primero (más críticas), después gastos generales
  state.diagnosticos = [...diagTarjetas, ...state.diagnosticos];

  // Proyección de saldo + saturación de tarjetas (para el asesor)
  state.proyeccion = proyectarBalance({
    gastos: state.gastos, ingresos: state.ingresos,
    cuentas: state.cuentas, tarjetas: state.tarjetas, horizonte: 90,
  });
  state.saturacion = predecirSaturacionTarjetas({
    gastos: state.gastos, tarjetas: state.tarjetas, resumenes: state.resumenes,
  });

  // Asesor financiero integral (score + estrategias + pronóstico)
  state.salud = analizarSaludFinanciera({
    gastos: state.gastos, ingresos: state.ingresos, tarjetas: state.tarjetas,
    cuentas: state.cuentas, metas: state.metas,
    capacidad: state.capacidad, estado: state.estado, resumenes: state.resumenes,
    diagnosticos: state.diagnosticos, proyeccion: state.proyeccion, saturacion: state.saturacion,
  });

  renderWidgets();
  renderQuickHabituales();
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
    // Habitual SIN cuenta = contador puro: no descuenta de ningún balance
    if (g.es_habitual && !g.cuenta_id) continue;
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
    if (g.es_habitual && !g.cuenta_id) continue; // contador puro
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
  sueldo:             renderSueldo,
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
  balance:            renderBalance,
  habituales:         renderWidgetHabituales,
};

const TPL = {
  estado_global:      'tpl-widget-estado',
  sueldo:             'tpl-widget-sueldo',
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
  balance:            'tpl-widget-balance',
  habituales:         'tpl-widget-habituales',
};

function renderWidgets() {
  const root = document.getElementById('main-widgets');
  root.innerHTML = '';
  const ordenGuardado = state.ajustes?.ui?.widgets_orden?.length
    ? state.ajustes.ui.widgets_orden
    : Object.keys(TPL);
  // Agregar al final cualquier widget registrado que falte en el orden guardado.
  // Esto cubre widgets NUEVOS (ej. prediccion, balance) que no estaban cuando el
  // usuario guardó su orden: antes no se renderizaban aunque estuvieran visibles.
  const orden = [...ordenGuardado, ...Object.keys(TPL).filter(k => !ordenGuardado.includes(k))];
  const visibles = new Set(state.ajustes?.ui?.widgets_visibles || Object.keys(TPL));
  for (const id of orden) {
    if (!visibles.has(id)) continue;
    const tpl = document.getElementById(TPL[id]);
    if (!tpl) continue;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.widget = id;
    const tamano = state.ajustes?.ui?.widgets_tamanos?.[id] || 'md';
    node.dataset.size = tamano;

    // Aplicar ancho (columnas) y alto (px explícito) guardados por el drag resize.
    // Usamos altura en px en vez de grid-row span porque con grid-auto-rows
    // minmax(80px,auto) el span no achicaba (la altura la mandaba el contenido).
    const span    = state.ajustes?.ui?.widgets_spans?.[id];
    const altura  = state.ajustes?.ui?.widgets_alturas?.[id];
    if (span)   node.style.gridColumn = `span ${span}`;
    if (altura) { node.style.height = altura + 'px'; node.style.alignSelf = 'start'; }

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
            // Limpiar spans/altura custom y restablecer tamaño "md"
            if (!state.ajustes.ui.widgets_spans)   state.ajustes.ui.widgets_spans = {};
            if (!state.ajustes.ui.widgets_alturas) state.ajustes.ui.widgets_alturas = {};
            delete state.ajustes.ui.widgets_spans[id];
            delete state.ajustes.ui.widgets_alturas[id];
            if (state.ajustes.ui.widgets_rows) delete state.ajustes.ui.widgets_rows[id];
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
  let startX, startY, startCols, startHeight, tooltip, gridColsTotal;

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

    const rect = widgetNode.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const gap = parseFloat(gridStyle.gap) || 16;
    const colWidth = (gridRect.width - gap * (tplCols - 1)) / tplCols;

    startX = e.clientX;
    startY = e.clientY;
    // Columnas: arrancamos del valor LÓGICO guardado (no del pixel medido,
    // que con el contenido inflaba el cálculo). Fallback: estimar del ancho.
    startCols = state.ajustes?.ui?.widgets_spans?.[widgetId]
      || Math.max(1, Math.round((rect.width + gap) / (colWidth + gap)));
    // Alto: la altura real en px del widget en este momento.
    startHeight = rect.height;

    tooltip = document.createElement('div');
    tooltip.className = 'resize-tooltip';
    document.body.appendChild(tooltip);
    actualizarTooltip(e.clientX, e.clientY, startCols, Math.round(startHeight));
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
    const dyPx   = e.clientY - startY;

    const newCols   = Math.max(1, Math.min(gridColsTotal, startCols + dxCols));
    // Altura explícita en px: arrastrar para arriba achica, para abajo agranda.
    const newHeight = Math.max(120, Math.min(1400, startHeight + dyPx));

    widgetNode.style.gridColumn = `span ${newCols}`;
    widgetNode.style.gridRow    = '';            // ya no usamos row span
    widgetNode.style.height     = newHeight + 'px';
    widgetNode.style.alignSelf  = 'start';

    actualizarTooltip(e.clientX, e.clientY, newCols, Math.round(newHeight));
  });

  const finalize = async (e) => {
    if (!widgetNode.classList.contains('resizing')) return;
    widgetNode.classList.remove('resizing');
    if (tooltip) { tooltip.remove(); tooltip = null; }
    try { handle.releasePointerCapture(e.pointerId); } catch {}

    const colMatch = widgetNode.style.gridColumn.match(/span (\d+)/);
    const cols   = colMatch ? parseInt(colMatch[1]) : null;
    const altura = parseInt(widgetNode.style.height) || null;

    if (!state.ajustes.ui.widgets_spans)   state.ajustes.ui.widgets_spans = {};
    if (!state.ajustes.ui.widgets_alturas) state.ajustes.ui.widgets_alturas = {};
    if (cols)   state.ajustes.ui.widgets_spans[widgetId]   = cols;
    if (altura) state.ajustes.ui.widgets_alturas[widgetId] = altura;
    // Limpiar el formato viejo de filas si existía
    if (state.ajustes.ui.widgets_rows) delete state.ajustes.ui.widgets_rows[widgetId];
    await DB.put('ajustes', state.ajustes);

    // Re-render del chart para que el canvas se ajuste a la nueva altura
    setTimeout(() => {
      if (RENDERERS[widgetId]) RENDERERS[widgetId](widgetNode);
    }, 100);
  };

  handle.addEventListener('pointerup', finalize);
  handle.addEventListener('pointercancel', finalize);

  function actualizarTooltip(x, y, cols, px) {
    if (!tooltip) return;
    tooltip.textContent = `${cols} col · ${px}px`;
    tooltip.style.left = (x + 14) + 'px';
    tooltip.style.top  = (y + 14) + 'px';
  }
}

async function cambiarTamanoWidget(widgetId, size) {
  if (!state.ajustes.ui) state.ajustes.ui = {};
  if (!state.ajustes.ui.widgets_tamanos) state.ajustes.ui.widgets_tamanos = {};
  state.ajustes.ui.widgets_tamanos[widgetId] = size;
  // Al elegir tamaño preset, limpiamos cualquier ancho/alto custom
  if (state.ajustes.ui.widgets_spans)   delete state.ajustes.ui.widgets_spans[widgetId];
  if (state.ajustes.ui.widgets_alturas) delete state.ajustes.ui.widgets_alturas[widgetId];
  if (state.ajustes.ui.widgets_rows)    delete state.ajustes.ui.widgets_rows[widgetId];
  await DB.put('ajustes', state.ajustes);
  // Re-renderizar solo el widget afectado sin perder otros estados
  const node = document.querySelector(`[data-widget="${widgetId}"]`);
  if (node) {
    node.dataset.size = size;
    node.style.height = '';      // limpiar altura custom del drag
    node.style.alignSelf = '';
    node.style.gridColumn = '';
    node.style.gridRow = '';
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
  // El botón "+ Nueva" se quitó del widget — la creación ahora va por Ajustes → Cuentas
  el.querySelectorAll('[data-cuenta-id]').forEach(c => {
    c.addEventListener('click', () => abrirVistaCuentas());
  });
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

/** Ajusta la luminancia de un color hex. factor<1 oscurece, >1 aclara. */
function _ajustarLuminancia(hex, factor) {
  let h = String(hex || '#6366f1').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16);
  let r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  r = Math.min(255, Math.max(0, Math.round(r * factor)));
  g = Math.min(255, Math.max(0, Math.round(g * factor)));
  b = Math.min(255, Math.max(0, Math.round(b * factor)));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Gradiente premium estilo "tarjeta Macro" generado desde el color elegido:
 * oscuro (sombra) → color base → brillante (luz). Da volumen y combina con el
 * brillo holográfico animado del .credit-card.
 */
function _gradienteTarjeta(color) {
  const c = color || '#6366f1';
  // Look premium/profundo: del más oscuro al color pleno (el color es el punto
  // MÁS brillante, no lo pasamos de rosca → evita el efecto neón saturado).
  const oscuro = _ajustarLuminancia(c, 0.30);
  const medio  = _ajustarLuminancia(c, 0.62);
  return `linear-gradient(135deg, ${oscuro} 0%, ${medio} 58%, ${c} 100%)`;
}

/** Mapea el nombre del banco a su clase de identidad visual (gradiente). */
function _bancoCardClass(banco) {
  const b = (banco || '').toLowerCase();
  if (b.includes('bbva'))                       return 'card-bank-bbva';
  if (b.includes('santander'))                  return 'card-bank-santander';
  if (b.includes('galicia'))                    return 'card-bank-galicia';
  if (b.includes('macro'))                      return 'card-bank-macro';
  if (b.includes('icbc'))                       return 'card-bank-icbc';
  if (b.includes('hsbc'))                       return 'card-bank-hsbc';
  if (b.includes('nacion') || b.includes('nación')) return 'card-bank-nacion';
  if (b.includes('brubank'))                    return 'card-bank-brubank';
  if (b.includes('uala') || b.includes('ualá')) return 'card-bank-uala';
  if (b.includes('naranja'))                    return 'card-bank-naranja';
  if (b.includes('mercado'))                    return 'card-bank-mercado';
  return '';
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
  // Determinar qué tarjeta tiene el ciclo MÁS próximo a cerrar → highlight
  const cicloMasProximo = state.resumenes.reduce((prev, r) =>
    (!prev || r.dias_para_cierre < prev.dias_para_cierre) ? r : prev, null);

  for (const r of state.resumenes) {
    const t   = state.tarjetas.find(x => x.id === r.tarjeta_id);
    const pct = Math.min(100, r.porcentaje_limite_usado);
    const urgente = r.dias_para_cierre <= 2 || r.dias_para_vencimiento <= 2;
    const esCicloActivo = cicloMasProximo && r.tarjeta_id === cicloMasProximo.tarjeta_id;
    // Sin pulso: la urgencia ya se indica con el color de los badges de fecha
    const claseUrgente = urgente ? 'card-urgente' : '';
    // Gradiente generado desde el color elegido por el usuario (todas las tarjetas)
    const colorBase = t.color || '#6366f1';
    const bgStyle = `background:${_gradienteTarjeta(colorBase)};`;
    const diasC = r.dias_para_cierre;
    const diasV = r.dias_para_vencimiento;
    const badgeCierre = diasC <= 1 ? 'badge-danger' : diasC <= 5 ? 'badge-warning' : 'badge-muted';
    const badgeVenc   = diasV <= 1 ? 'badge-danger' : diasV <= 5 ? 'badge-warning' : 'badge-muted';

    box.insertAdjacentHTML('beforeend', `
      <div class="credit-card ${claseUrgente}${esCicloActivo ? ' ciclo-activo-highlight' : ''}"
           data-tarjeta-id="${t.id}"
           style="${bgStyle}cursor:pointer">
        <!-- fila superior -->
        <div class="flex items-start justify-between mb-3 relative z-10">
          <div>
            <p class="font-semibold text-white text-base leading-tight">${escapeHtml(t.nombre)}</p>
            ${t.banco ? `<p class="text-white/60 text-xs mt-0.5">${escapeHtml(t.banco)}</p>` : ''}
          </div>
          <span class="badge badge-muted text-white/80" style="background:rgba(255,255,255,0.18);border:none;font-size:.6rem">${(() => {
            const [y, m] = r.periodo.split('-');
            const mn = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
            return `${mn[parseInt(m)-1]} '${y.slice(-2)}`;
          })()}</span>
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
        <!-- Fechas (formato compacto: "Cierra 20/jun · 21d") -->
        <div class="flex justify-between items-center gap-1.5 relative z-10">
          ${(() => {
            const fmtCorto = (iso) => {
              if (!iso) return '—';
              const d = new Date(iso + 'T12:00:00');
              const mn = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
              return `${d.getDate()}/${mn[d.getMonth()]}`;
            };
            return `
              <span class="badge ${badgeCierre} flex items-center gap-1" style="font-size:.6rem;padding:.2rem .5rem;background:rgba(255,255,255,0.18);color:white;border:none;white-space:nowrap">
                <span style="opacity:.7">🔒</span> ${fmtCorto(r.fecha_cierre)}
                <span style="opacity:.6;font-weight:400;margin-left:2px">· ${diasC}d</span>
              </span>
              <span class="badge ${badgeVenc} flex items-center gap-1" style="font-size:.6rem;padding:.2rem .5rem;background:rgba(255,255,255,0.18);color:white;border:none;white-space:nowrap">
                <span style="opacity:.7">💸</span> ${fmtCorto(r.fecha_vencimiento)}
                <span style="opacity:.6;font-weight:400;margin-left:2px">· ${diasV}d</span>
              </span>
            `;
          })()}
        </div>
      </div>`);
  }
  // Botón "+ Nueva" se quitó — crear desde Ajustes → Cuentas

  // Click en cada tarjeta → drawer de uso detallado
  el.querySelectorAll('.credit-card[data-tarjeta-id]').forEach(card => {
    card.addEventListener('click', (e) => {
      // Evitar que el click en el widget bubble dispare el historial general
      e.stopPropagation();
      abrirDrawerTarjeta(card.dataset.tarjetaId);
    });
  });
}

function renderCredito(el) {
  const cap = state.capacidad;
  if (!cap) return;

  const ratio = cap.ratio_uso_ingreso;
  const pct   = cap.porcentaje_uso;

  // Mapeo de semáforo → color/label/badge class
  const semMap = {
    verde:    { color: 'var(--success)', label: 'Verde',    cls: 'badge-success' },
    amarillo: { color: 'var(--warning)', label: 'Amarillo', cls: 'badge-warning' },
    naranja:  { color: '#fb923c',        label: 'Naranja',  cls: 'badge-warning' },
    rojo:     { color: 'var(--danger)',  label: 'Rojo',     cls: 'badge-danger'  },
  };
  const sem = semMap[cap.semaforo] || semMap.verde;

  // Badge semáforo
  const badge = el.querySelector('[data-bind="semaforo-badge"]');
  if (badge) { badge.className = `badge ${sem.cls}`; badge.textContent = sem.label; }

  // Gauge arc
  const arcLen = 175.9;
  const offset = arcLen - (arcLen * Math.min(ratio, 1));
  const gaugeFill = el.querySelector('[data-bind="gauge-arc"]');
  if (gaugeFill) {
    gaugeFill.style.stroke = sem.color;
    requestAnimationFrame(() => { gaugeFill.style.strokeDashoffset = offset.toFixed(1); });
  }

  const ratioPct = el.querySelector('[data-bind="ratio-pct"]');
  if (ratioPct) { ratioPct.textContent = pct + '%'; ratioPct.style.color = sem.color; }

  // Cuota segura y disponible
  const cuotaEl = el.querySelector('[data-bind="cuota-segura"]');
  if (cuotaEl) cuotaEl.textContent = FMT.format(cap.cuota_segura_30);

  const dispEl = el.querySelector('[data-bind="disponible"]');
  if (dispEl) {
    dispEl.textContent = FMT.format(cap.capacidad_libre);
    dispEl.style.color = cap.capacidad_libre > 0 ? 'var(--success)' : 'var(--danger)';
  }

  // Si hay cuotas pendientes o sugerencia avanzada, mostrarla
  let infoExtra = el.querySelector('[data-bind="credito-info-extra"]');
  if (!infoExtra) {
    infoExtra = document.createElement('div');
    infoExtra.setAttribute('data-bind', 'credito-info-extra');
    infoExtra.style.cssText = 'margin-top:.85rem;padding-top:.85rem;border-top:1px solid var(--border)';
    el.querySelector('article')?.appendChild(infoExtra) || el.appendChild(infoExtra);
  }
  const cuotasNum = cap.cuotas_pendientes.length;
  const cuotasTotal = cap.cuotas_mensuales_proyectadas;
  infoExtra.innerHTML = `
    <p class="text-[10px] uppercase tracking-widest mb-1" style="color:var(--ink-muted)">Compromiso mensual real</p>
    <div class="flex items-center justify-between text-xs mb-1.5">
      <span style="color:var(--ink-2)">Gastos fijos</span>
      <span class="ff-display font-semibold" style="color:var(--ink)">${FMT.format(cap.gastos_fijos_mes)}</span>
    </div>
    <div class="flex items-center justify-between text-xs mb-1.5">
      <span style="color:var(--ink-2)">Resúmenes tarjetas</span>
      <span class="ff-display font-semibold" style="color:var(--ink)">${FMT.format(cap.compromiso_tarjetas)}</span>
    </div>
    <div class="flex items-center justify-between text-xs mb-2">
      <span style="color:var(--ink-2)">Cuotas pendientes (${cuotasNum})</span>
      <span class="ff-display font-semibold" style="color:${cuotasTotal > 0 ? 'var(--warning)' : 'var(--ink-muted)'}">${FMT.format(cuotasTotal)}</span>
    </div>
    <p class="text-[11px] mt-2 px-2.5 py-1.5 rounded-lg" style="background:${sem.color}1a;color:${sem.color};border:1px solid ${sem.color}55">
      ${escapeHtml(cap.sugerencia)}
    </p>
  `;
}

// Genera el HTML del medidor de score (gauge circular) reutilizable.
function _scoreGaugeHTML(salud, size = 72) {
  if (!salud) return '';
  const score = salud.score || 0;
  const color = salud.color || 'var(--brand)';
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * (score / 100);
  const cx = size / 2;
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--border)" stroke-width="6"/>
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="6"
              stroke-linecap="round" stroke-dasharray="${dash} ${circ}"
              transform="rotate(-90 ${cx} ${cx})"/>
      <text x="50%" y="48%" text-anchor="middle" dominant-baseline="middle"
            style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:${size*0.28}px;fill:var(--ink)">${score}</text>
      <text x="50%" y="68%" text-anchor="middle" dominant-baseline="middle"
            style="font-size:${size*0.12}px;fill:var(--ink-muted)">/100</text>
    </svg>`;
}

function renderIA(el) {
  const salud = state.salud;

  // ── Score de salud financiera ──
  const scoreBox = el.querySelector('[data-bind="salud-score"]');
  if (scoreBox && salud) {
    scoreBox.innerHTML = `
      ${_scoreGaugeHTML(salud, 72)}
      <div class="salud-score-info">
        <span class="salud-score-nivel" style="color:${salud.color}">${salud.nivel}</span>
        <span class="salud-score-resumen">${escapeHtml(salud.resumen)}</span>
      </div>`;
  } else if (scoreBox) {
    scoreBox.innerHTML = '';
  }

  // ── Estrategias top (del asesor) + diagnósticos ──
  const box = el.querySelector('[data-bind="diagnosticos"]');
  box.innerHTML = '';

  const estrategias = (salud?.estrategias || []).slice(0, 3);
  const TIPO_STYLE = {
    critico:  { border: 'var(--danger)',  text: 'var(--danger-2)' },
    alerta:   { border: 'var(--warning)', text: 'var(--warning-2)' },
    consejo:  { border: 'var(--brand)',   text: 'var(--brand)' },
    positivo: { border: 'var(--success)', text: 'var(--success)' },
  };

  if (estrategias.length) {
    for (const e of estrategias) {
      const s = TIPO_STYLE[e.tipo] || TIPO_STYLE.consejo;
      box.insertAdjacentHTML('beforeend', `
        <div class="rounded-xl p-3 border-l-[3px]"
             style="background:var(--surface-2);border-color:${s.border};border-top:1px solid ${s.border}22;border-right:1px solid ${s.border}22;border-bottom:1px solid ${s.border}22">
          <p class="font-semibold text-sm" style="color:${s.text}">${escapeHtml(e.titulo)}</p>
          <p class="text-xs mt-1" style="color:var(--ink-2)">${escapeHtml(e.detalle)}</p>
          ${e.accion ? `<p class="text-xs mt-1.5 font-medium" style="color:var(--ink-muted)">💬 ${escapeHtml(e.accion)}</p>` : ''}
        </div>`);
    }
  } else {
    box.innerHTML = `
      <div class="flex items-center gap-3 py-3" style="color:var(--ink-muted)">
        <span class="text-2xl">✅</span>
        <p class="text-sm">Sin alertas. Cargá ingresos y gastos para un análisis más rico.</p>
      </div>`;
  }

  // Botón "Ver análisis completo"
  el.querySelector('[data-action="ver-salud"]')?.addEventListener('click', abrirSaludFinanciera);

  // Selector de sensibilidad (recomputa diagnósticos + asesor)
  const sel = el.querySelector('#sens-select');
  if (sel) {
    sel.value = state.ajustes?.sensibilidad_ia || 'moderado';
    sel.onchange = async () => {
      await saveAjustes({ sensibilidad_ia: sel.value });
      await reloadAll();
    };
  }
}

// Datos base que consume el asesor (para re-simular what-if)
function _saludBaseData() {
  return {
    gastos: state.gastos, ingresos: state.ingresos, tarjetas: state.tarjetas,
    cuentas: state.cuentas, metas: state.metas,
    capacidad: state.capacidad, estado: state.estado, resumenes: state.resumenes,
    diagnosticos: state.diagnosticos, proyeccion: state.proyeccion, saturacion: state.saturacion,
  };
}

const _FMT0 = (n) => '$' + Math.round(n || 0).toLocaleString('es-AR');

function abrirSaludFinanciera() {
  const dlg = document.getElementById('dlg-salud');
  const body = document.getElementById('salud-body');
  if (!dlg || !body) return;
  const salud = state.salud;
  if (!salud) { toast('Sin datos suficientes para el análisis', 2000); return; }

  // Sub-puntajes
  const subHtml = Object.values(salud.subscores).map(s => {
    const col = s.valor >= 70 ? 'var(--success)' : s.valor >= 45 ? 'var(--warning)' : 'var(--danger)';
    return `
      <div class="salud-sub">
        <div class="salud-sub-head">
          <span class="salud-sub-label">${s.label}</span>
          <span class="salud-sub-val" style="color:${col}">${s.valor}</span>
        </div>
        <div class="salud-sub-bar"><div class="salud-sub-fill" style="width:${s.valor}%;background:${col}"></div></div>
      </div>`;
  }).join('');

  // Estrategias (todas)
  const TIPO = {
    critico:  'var(--danger)', alerta: 'var(--warning)',
    consejo:  'var(--brand)',   positivo: 'var(--success)',
  };
  const estrHtml = salud.estrategias.length ? salud.estrategias.map(e => `
    <div class="salud-estrategia" style="border-left-color:${TIPO[e.tipo] || 'var(--brand)'}">
      <p class="salud-estrategia-tit" style="color:${TIPO[e.tipo] || 'var(--ink)'}">${escapeHtml(e.titulo)}</p>
      <p class="salud-estrategia-det">${escapeHtml(e.detalle)}</p>
      ${e.accion ? `<p class="salud-estrategia-acc">💬 ${escapeHtml(e.accion)}</p>` : ''}
      ${e.impacto > 0 ? `<span class="salud-estrategia-impacto">Impacto: ${_FMT0(e.impacto)}/mes</span>` : ''}
    </div>`).join('') : `<p class="text-sm" style="color:var(--ink-muted)">Sin estrategias: tus finanzas están equilibradas.</p>`;

  // Pronóstico 3 meses
  const pronoHtml = salud.pronostico.map(p => {
    const col = p.neto >= 0 ? 'var(--success)' : 'var(--danger)';
    return `
      <div class="salud-prono-row">
        <span class="salud-prono-mes">${p.periodo}</span>
        <span class="salud-prono-neto" style="color:${col}">${p.neto >= 0 ? '+' : ''}${_FMT0(p.neto)}</span>
        <span class="salud-prono-saldo">saldo ${_FMT0(p.saldo_acumulado)}</span>
        <span style="grid-column:1/-1;font-size:.64rem;color:var(--ink-muted)">
          ingresos ${_FMT0(p.ingresos)} − habituales ${_FMT0(p.gastos_habituales)} − cuotas ${_FMT0(p.cuotas)}
        </span>
      </div>`;
  }).join('');

  // Categorías para el selector del simulador
  const cats = [...new Set(state.gastos.filter(g => !g.deleted).map(g => g.categoria || 'general'))];
  const catOpts = cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

  body.innerHTML = `
    <div class="salud-score-row" style="margin-bottom:1rem">
      ${_scoreGaugeHTML(salud, 90)}
      <div class="salud-score-info">
        <span class="salud-score-nivel" style="color:${salud.color};font-size:1.3rem">${salud.nivel}</span>
        <span class="salud-score-resumen">${escapeHtml(salud.resumen)}</span>
      </div>
    </div>

    <p class="salud-section-title">Desglose del puntaje</p>
    <div class="salud-sub-grid">${subHtml}</div>

    <p class="salud-section-title">Estrategias y medidas (${salud.estrategias.length})</p>
    <div class="space-y-2">${estrHtml}</div>

    <p class="salud-section-title">Pronóstico 3 meses</p>
    <div class="salud-pronostico">${pronoHtml}</div>

    <p class="salud-section-title">🧪 Simulador "¿qué pasa si…?"</p>
    <div class="salud-sim-box">
      <div class="grid grid-cols-2 gap-2">
        <div class="form-section">
          <label class="form-label">Recortar categoría</label>
          <select id="sim-cat" class="input"><option value="">— ninguna —</option>${catOpts}</select>
        </div>
        <div class="form-section">
          <label class="form-label">Monto a recortar / mes</label>
          <div class="input-with-prefix"><span class="input-prefix">$</span>
            <input id="sim-recorte" type="number" class="input" placeholder="0" step="1000"></div>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-2">
        <div class="form-section">
          <label class="form-label">Nueva compra en cuotas (total)</label>
          <div class="input-with-prefix"><span class="input-prefix">$</span>
            <input id="sim-compra" type="number" class="input" placeholder="0" step="1000"></div>
        </div>
        <div class="form-section">
          <label class="form-label">Cantidad de cuotas</label>
          <input id="sim-cuotas" type="number" class="input" placeholder="12" min="1" max="60" value="12">
        </div>
      </div>
      <button type="button" id="sim-go" class="btn-primary w-full text-sm mt-3">⚡ Simular escenario</button>
      <div id="sim-result" hidden></div>
    </div>
  `;

  // Wire simulador
  document.getElementById('sim-go')?.addEventListener('click', async () => {
    const { simularEscenario } = await import('./ai-advisor.js');
    const cat = document.getElementById('sim-cat')?.value || '';
    const recorte = parseFloat(document.getElementById('sim-recorte')?.value) || 0;
    const compra = parseFloat(document.getElementById('sim-compra')?.value) || 0;
    const cuotas = parseInt(document.getElementById('sim-cuotas')?.value) || 12;

    const cambios = {};
    if (recorte > 0) cambios.recortes = [{ categoria: cat || 'general', monto: recorte }];
    if (compra > 0)  cambios.nuevaCuota = { monto: compra, cuotas };

    if (!cambios.recortes && !cambios.nuevaCuota) { toast('Ingresá un recorte o una compra para simular', 2500); return; }

    const sim = simularEscenario(_saludBaseData(), cambios);
    const d = sim.delta;
    const scoreCol = d.score >= 0 ? 'var(--success)' : 'var(--danger)';
    const dispCol  = d.disponible_mensual >= 0 ? 'var(--success)' : 'var(--danger)';
    const res = document.getElementById('sim-result');
    res.hidden = false;
    res.className = 'salud-sim-result';
    res.innerHTML = `
      <div class="salud-sim-delta">
        <span>Score: <b style="color:${sim.antes.color}">${sim.antes.score}</b> → <b style="color:${sim.despues.color}">${sim.despues.score}</b>
          <b style="color:${scoreCol}">(${d.score >= 0 ? '+' : ''}${d.score})</b></span>
        <span>Disponible/mes: <b style="color:${dispCol}">${d.disponible_mensual >= 0 ? '+' : ''}${_FMT0(d.disponible_mensual)}</b></span>
      </div>
      ${d.cuota_nueva_mensual > 0 ? `<p class="text-[11px] mt-2" style="color:var(--ink-muted)">La compra suma una cuota de <b>${_FMT0(d.cuota_nueva_mensual)}/mes</b>.</p>` : ''}
      ${d.recorte_aplicado > 0 ? `<p class="text-[11px] mt-1" style="color:var(--ink-muted)">Recorte aplicado: <b>${_FMT0(d.recorte_aplicado)}/mes</b>.</p>` : ''}
      <p class="text-[11px] mt-2" style="color:${sim.despues.score >= sim.antes.score ? 'var(--success)' : 'var(--danger)'}">
        ${sim.despues.score >= sim.antes.score ? '✓ Este escenario mejora (o mantiene) tu salud financiera.' : '⚠ Este escenario empeora tu salud financiera.'}
      </p>`;
  });

  dlg.showModal();
}

/* ── WIDGET: Balance general (rango personalizable + series toggleables) ── */
const _balanceState = {
  range: 90,                 // días o 'custom'
  from: null, to: null,      // ISO para custom
  series: { ingresos: true, gastos: true, balance: true },
  chart: null,
};
const _BAL_SERIES = {
  ingresos: { label: 'Ingresos', color: '#00ff9f', ckey: 'success' },
  gastos:   { label: 'Gastos',   color: '#ff2d6e', ckey: 'danger' },
  balance:  { label: 'Balance acumulado', color: '#00f0ff', ckey: 'brand' },
};

function _balanceRango() {
  const hoy = new Date();
  if (_balanceState.range === 'custom' && _balanceState.from && _balanceState.to) {
    return { desde: new Date(_balanceState.from + 'T00:00:00'), hasta: new Date(_balanceState.to + 'T23:59:59') };
  }
  const dias = Number(_balanceState.range) || 90;
  const desde = new Date(hoy.getTime() - dias * 86400000);
  return { desde, hasta: hoy };
}

function renderBalance(el) {
  const { desde, hasta } = _balanceRango();
  const diasRango = Math.max(1, Math.round((hasta - desde) / 86400000));
  // Bucket: diario / semanal / mensual según el rango
  const modo = diasRango <= 35 ? 'dia' : diasRango <= 120 ? 'semana' : 'mes';

  const enRango = (iso) => { if (!iso) return false; const d = new Date(iso + 'T12:00:00'); return d >= desde && d <= hasta; };
  const gastoEf = (g) => { let m = g.monto || 0; if (g.compartido) m *= (1 - (g.compartido.porcentaje_otro || 0)/100); return m; };

  // Clave de bucket para una fecha
  const bucketKey = (d) => {
    if (modo === 'dia')    return d.toISOString().slice(0, 10);
    if (modo === 'semana') { const t = new Date(d); t.setDate(t.getDate() - t.getDay()); return t.toISOString().slice(0, 10); }
    return d.toISOString().slice(0, 7);
  };
  const bucketLabel = (k) => {
    if (modo === 'mes') { const [y, m] = k.split('-'); return `${['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][parseInt(m)-1]} ${y.slice(2)}`; }
    const [y, m, dd] = k.split('-'); return `${dd}/${m}`;
  };

  // Generar buckets ordenados del rango
  const buckets = [];
  const seen = new Set();
  const cursor = new Date(desde);
  while (cursor <= hasta) {
    const k = bucketKey(cursor);
    if (!seen.has(k)) { seen.add(k); buckets.push(k); }
    cursor.setDate(cursor.getDate() + (modo === 'mes' ? 28 : modo === 'semana' ? 7 : 1));
  }
  // Asegurar el bucket del último día
  const kLast = bucketKey(hasta); if (!seen.has(kLast)) buckets.push(kLast);

  const ingMap = new Map(), gasMap = new Map();
  for (const i of state.ingresos || []) {
    if (i.deleted || !enRango(i.fecha)) continue;
    const k = bucketKey(new Date(i.fecha + 'T12:00:00'));
    ingMap.set(k, (ingMap.get(k) || 0) + ((i.sueldo_neto || 0) + (i.bonos || 0)));
  }
  for (const g of state.gastos || []) {
    if (g.deleted || g.es_pago_tarjeta || (g.es_habitual && !g.cuenta_id) || !enRango(g.fecha)) continue; // pago de tarjeta / habitual-contador no es consumo
    const k = bucketKey(new Date(g.fecha + 'T12:00:00'));
    gasMap.set(k, (gasMap.get(k) || 0) + gastoEf(g));
  }

  const datIng = buckets.map(k => Math.round(ingMap.get(k) || 0));
  const datGas = buckets.map(k => Math.round(gasMap.get(k) || 0));
  let acum = 0;
  const datBal = buckets.map((k, i) => { acum += (datIng[i] - datGas[i]); return Math.round(acum); });

  const totalIng = datIng.reduce((a, b) => a + b, 0);
  const totalGas = datGas.reduce((a, b) => a + b, 0);
  const neto = totalIng - totalGas;

  // ── Rango: botones + custom ──
  el.querySelectorAll('.balance-range-btn').forEach(b => {
    b.classList.toggle('active', String(_balanceState.range) === b.dataset.range);
    b.onclick = () => {
      _balanceState.range = b.dataset.range === 'custom' ? 'custom' : Number(b.dataset.range);
      const cw = el.querySelector('[data-bind="balance-custom"]');
      if (cw) cw.hidden = _balanceState.range !== 'custom';
      if (_balanceState.range === 'custom') {
        const f = el.querySelector('[data-bind="balance-from"]'); const t = el.querySelector('[data-bind="balance-to"]');
        if (f && !f.value) f.value = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
        if (t && !t.value) t.value = new Date().toISOString().slice(0,10);
        _balanceState.from = f?.value; _balanceState.to = t?.value;
      }
      renderBalance(el);
    };
  });
  const cw = el.querySelector('[data-bind="balance-custom"]');
  if (cw) cw.hidden = _balanceState.range !== 'custom';
  ['from','to'].forEach(k => {
    const inp = el.querySelector(`[data-bind="balance-${k}"]`);
    if (inp) { if (_balanceState[k]) inp.value = _balanceState[k]; inp.onchange = () => { _balanceState[k] = inp.value; renderBalance(el); }; }
  });

  // ── Chips de series (toggle) ──
  const chipsBox = el.querySelector('[data-bind="balance-series"]');
  if (chipsBox) {
    const cChip = _resolverColoresChart();
    chipsBox.innerHTML = Object.entries(_BAL_SERIES).map(([id, s]) => `
      <button type="button" class="balance-chip ${_balanceState.series[id] ? 'on' : ''}" data-serie="${id}">
        <span class="balance-chip-dot" style="background:${cChip[s.ckey] || s.color}"></span>${s.label}
      </button>`).join('');
    chipsBox.querySelectorAll('.balance-chip').forEach(b => {
      b.onclick = () => { _balanceState.series[b.dataset.serie] = !_balanceState.series[b.dataset.serie]; renderBalance(el); };
    });
  }

  // ── KPIs ──
  const kpisBox = el.querySelector('[data-bind="balance-kpis"]');
  if (kpisBox) {
    kpisBox.innerHTML = `
      <div class="balance-kpi"><span class="lbl">Ingresos</span><span class="val" style="color:var(--success)">${FMT.format(totalIng)}</span></div>
      <div class="balance-kpi"><span class="lbl">Gastos</span><span class="val" style="color:var(--danger)">${FMT.format(totalGas)}</span></div>
      <div class="balance-kpi"><span class="lbl">Balance</span><span class="val" style="color:${neto>=0?'var(--success)':'var(--danger)'}">${neto>=0?'+':''}${FMT.format(neto)}</span></div>`;
  }

  // ── Chart ──
  const canvas = el.querySelector('[data-bind="balance-canvas"]');
  if (!canvas) return;
  if (_balanceState.chart) { try { _balanceState.chart.destroy(); } catch {} }
  const c = _resolverColoresChart();
  const labels = buckets.map(bucketLabel);
  const ctx = canvas.getContext('2d');

  const datasets = [];
  // Colores resueltos del tema/acento actual (no los defaults estáticos de _BAL_SERIES)
  const colIng = c.success, colGas = c.danger, colBal = c.brand;
  const mkGrad = (hex) => { const g = ctx.createLinearGradient(0,0,0,180); g.addColorStop(0, _hexAlpha(hex,0.25)); g.addColorStop(1, _hexAlpha(hex,0.02)); return g; };
  if (_balanceState.series.ingresos) datasets.push({ label:'Ingresos', data:datIng, borderColor:colIng, backgroundColor:mkGrad(colIng), tension:.3, fill:true, pointRadius:0, borderWidth:1.8 });
  if (_balanceState.series.gastos)   datasets.push({ label:'Gastos',   data:datGas, borderColor:colGas,   backgroundColor:mkGrad(colGas),   tension:.3, fill:true, pointRadius:0, borderWidth:1.8 });
  if (_balanceState.series.balance)  datasets.push({ label:'Balance acumulado', data:datBal, borderColor:colBal, backgroundColor:mkGrad(colBal), tension:.25, fill:false, pointRadius:0, borderWidth:2.2 });

  _balanceState.chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: c.inkMuted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } },
        y: { ticks: { color: c.inkMuted, font: { size: 10 }, callback: (v) => Math.abs(v)>=1000 ? (v/1000).toFixed(0)+'k' : v }, grid: { color: c.grid } },
      },
    },
  });
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
  // Nueva convención: prioridad alta = más estrellas. Peso ∝ prioridad.
  const pesos     = state.metas.map(m => (m.prioridad || 3));
  const sumaPesos = pesos.reduce((a,b)=>a+b,0) || 1;

  state.metas.sort((a,b)=>(b.prioridad||3)-(a.prioridad||3)).forEach((m, i) => {
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
  // Botón "+ Nueva" se quitó — crear desde Ajustes → Cuentas
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
  const c     = _resolverColoresChart();
  const gradR = ctx.createLinearGradient(0,0,0,160);
  gradR.addColorStop(0,_hexAlpha(c.danger,0.3)); gradR.addColorStop(1,_hexAlpha(c.danger,0.02));
  const gradG = ctx.createLinearGradient(0,0,0,160);
  gradG.addColorStop(0,_hexAlpha(c.success,0.3)); gradG.addColorStop(1,_hexAlpha(c.success,0.02));

  chartEvol = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label:'Egresos',  data:datEg, tension:.4, borderColor:c.danger, backgroundColor:gradR,
          fill:true, borderWidth:2, pointRadius:4, pointBackgroundColor:c.danger,
          pointBorderColor:'var(--bg)', pointBorderWidth:2 },
        { label:'Ingresos', data:datIn, tension:.4, borderColor:c.success, backgroundColor:gradG,
          fill:true, borderWidth:2, pointRadius:4, pointBackgroundColor:c.success,
          pointBorderColor:'var(--bg)', pointBorderWidth:2 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode:'index', intersect:false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: c.tooltipBg,
          borderColor: c.grid,
          borderWidth: 1,
          titleColor: c.inkMuted,
          bodyColor: c.ink,
          padding: 10,
          callbacks: { label: ctx => ' ' + FMT.format(ctx.raw) },
        },
      },
      scales: {
        x: {
          grid: { color:c.grid },
          ticks: { color:c.inkMuted, font:{ size:11 } },
          border: { display:false },
        },
        y: {
          grid: { color:c.grid },
          ticks: { color:c.inkMuted, font:{ size:11 }, callback: v => '$'+v },
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
  const c = _resolverColoresChart();
  chartFlujo = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label:'Ingresos', data:datIn, backgroundColor:_hexAlpha(c.success,0.7), borderRadius:6, borderSkipped:false },
        { label:'Egresos',  data:datEg, backgroundColor:_hexAlpha(c.danger,0.7),  borderRadius:6, borderSkipped:false },
      ],
    },
    options: {
      responsive:true,
      plugins: {
        legend:{display:false},
        tooltip:{
          backgroundColor:c.tooltipBg, borderColor:c.grid, borderWidth:1,
          titleColor:c.inkMuted, bodyColor:c.ink, padding:10,
          callbacks:{ label: ctx => ' '+FMT.format(ctx.raw) },
        },
      },
      scales: {
        x:{ grid:{color:c.grid}, ticks:{color:c.inkMuted,font:{size:11}}, border:{display:false} },
        y:{ grid:{color:c.grid}, ticks:{color:c.inkMuted,font:{size:11},callback:v=>'$'+v}, border:{display:false} },
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
    if (g.es_pago_tarjeta || (g.es_habitual && !g.cuenta_id)) continue; // pago tarjeta / habitual-contador no es consumo
    if (!g.fecha?.startsWith(mk)) continue;
    const cat = g.categoria || 'general';
    let m = g.monto;
    if (g.compartido) m = m*(1-(g.compartido.porcentaje_otro||0)/100);
    catMap.set(cat, (catMap.get(cat)||0)+m);
  }

  const sorted = [...catMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6);
  const cc = _resolverColoresChart();
  // Paleta categórica derivada del acento/tema (con un par de tonos extra fijos para distinguir)
  const PALETTE = [cc.brand, cc.success, cc.danger, cc.warning, cc.brand2, '#8b5cf6'];
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
        tooltip:{ backgroundColor:cc.tooltipBg, titleColor:cc.inkMuted, bodyColor:cc.ink, padding:8,
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

  // Ordenar: oficial primero, después blue/tarjeta/etc, otros al final.
  // Filtrar: solo monedas marcadas como visibles (visible !== false).
  const orden = ['USD', 'USD_BLUE', 'USD_TARJETA', 'USD_MEP', 'USD_CCL', 'USD_CRIPTO', 'USD_MAYOR', 'EUR', 'BRL'];
  const sorted = Object.entries(cambios)
    .filter(([, c]) => c.visible !== false)
    .sort(([a],[b]) => {
      const ia = orden.indexOf(a); const ib = orden.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

  if (!sorted.length) {
    box.innerHTML = `<p class="text-xs text-center py-3" style="color:var(--ink-muted)">Todas las monedas están ocultas. Tocá ⚙ para mostrar alguna.</p>`;
  }

  for (const [key, c] of sorted) {
    const equiv = (state.estado?.saldo_liquido || 0) / (c.valor || 1);
    const esAuto = c.auto === true; // se actualizó automáticamente vía API
    box.insertAdjacentHTML('beforeend', `
      <div class="flex items-center justify-between p-3 rounded-xl"
           style="background:var(--surface-2);border:1px solid var(--border)">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-lg flex-shrink-0">${c.simbolo}</span>
          <div class="min-w-0">
            <p class="text-xs font-semibold truncate text-glow-cyan">
              ${escapeHtml(c.nombre)}
              ${esAuto ? '<span class="text-[8px] ml-1 px-1.5 py-0.5 rounded-full" style="background:var(--success-bg);color:var(--success);border:1px solid var(--success)">LIVE</span>' : ''}
            </p>
            <p class="text-[10px]" style="color:var(--ink-muted)">1 ${key.replace('USD_','')} = ${FMT.format(c.valor)}</p>
          </div>
        </div>
        <p class="ff-display text-sm font-bold" style="color:var(--brand)">
          ${equiv.toFixed(2)}
        </p>
      </div>`);
  }

  // Estado del último fetch
  const upd = el.querySelector('[data-bind="rates-updated"]');
  if (upd) {
    const ts = timestampUltimoFetch();
    if (ts) {
      const diffMin = Math.round((Date.now() - ts) / 60000);
      upd.textContent = diffMin < 1 ? 'hace segundos'
        : diffMin < 60 ? `hace ${diffMin}m`
        : `hace ${Math.round(diffMin/60)}h`;
    } else {
      upd.textContent = state.ajustes?.tipos_cambio_updated || 'manual';
    }
  }

  // Botón "Editar" → editor manual
  el.querySelector('[data-action="edit-rates"]')?.addEventListener('click', () => abrirEditorTiposCambio());

  // Botón "Actualizar" → fetch live
  el.querySelector('[data-action="refresh-rates"]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const labelOrig = btn.textContent;
    btn.textContent = '⏳';
    try {
      await actualizarCotizacionesAuto(true);
      toast('✓ Cotizaciones actualizadas', 2000);
      renderTipoCambio(el);
    } catch (err) {
      toast('No se pudo actualizar: ' + err.message, 2500);
    } finally {
      btn.disabled = false;
      btn.textContent = labelOrig;
    }
  });
}

/**
 * Fetch automático de cotizaciones desde dolarapi.com y mergeo en ajustes.
 * Las cotizaciones marcadas con `auto:true` se sobrescriben; las manuales
 * que tenga el usuario se preservan.
 */
async function actualizarCotizacionesAuto(force = false) {
  try {
    const fresh = await fetchCotizaciones(force);
    if (!fresh || Object.keys(fresh).length === 0) return null;

    if (!state.ajustes.tipos_cambio) state.ajustes.tipos_cambio = {};
    const cambios = state.ajustes.tipos_cambio;

    // Sobrescribir/agregar las claves que vienen de la API
    for (const [key, val] of Object.entries(fresh)) {
      const previo = cambios[key] || {};
      // Si el previo era manual y el usuario lo tocó, no lo pisamos
      if (previo.manual === true) continue;
      cambios[key] = {
        nombre: val.nombre,
        simbolo: val.simbolo,
        valor: val.valor,
        compra: val.compra,
        venta: val.venta,
        fecha_api: val.fecha,
        auto: true,
        visible: previo.visible !== false, // preservar la elección de visibilidad
      };
    }
    state.ajustes.tipos_cambio_updated = new Date().toLocaleString('es-AR');

    // Persistir sin disparar sync
    await DB.put('ajustes', state.ajustes);
    return fresh;
  } catch (e) {
    console.warn('actualizarCotizacionesAuto:', e.message);
    throw e;
  }
}

// Editor modal de cotizaciones: mostrar/ocultar monedas + editar valores.
function abrirEditorTiposCambio() {
  const dlg = document.getElementById('dlg-editor-cotiz');
  const cont = document.getElementById('ec-lista');
  if (!dlg || !cont) return;
  const cambios = state.ajustes?.tipos_cambio || {};

  const orden = ['USD', 'USD_BLUE', 'USD_TARJETA', 'USD_MEP', 'USD_CCL', 'USD_CRIPTO', 'USD_MAYOR', 'EUR', 'BRL'];
  const entries = Object.entries(cambios).sort(([a],[b]) => {
    const ia = orden.indexOf(a); const ib = orden.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  cont.innerHTML = entries.map(([key, c]) => `
    <div class="ec-row" data-key="${key}">
      <label class="ec-toggle" title="Mostrar en el dashboard">
        <input type="checkbox" class="ec-visible" ${c.visible !== false ? 'checked' : ''}>
        <span class="ec-simbolo">${c.simbolo || '💱'}</span>
      </label>
      <div class="ec-info">
        <span class="ec-nombre">${escapeHtml(c.nombre || key)}</span>
        <span class="ec-key">${key}${c.auto ? ' · LIVE' : c.manual ? ' · manual' : ''}</span>
      </div>
      <div class="ec-valor-wrap">
        <span class="ec-prefix">$</span>
        <input type="number" step="0.01" class="ec-valor input" value="${c.valor ?? ''}" placeholder="0">
      </div>
    </div>`).join('') || `<p class="text-xs" style="color:var(--ink-muted)">No hay cotizaciones cargadas. Tocá 🔄 en el widget para traerlas.</p>`;

  dlg.showModal();
}

async function guardarEditorTiposCambio() {
  const cont = document.getElementById('ec-lista');
  if (!cont) return;
  const cambios = { ...(state.ajustes?.tipos_cambio || {}) };
  cont.querySelectorAll('.ec-row').forEach(row => {
    const key = row.dataset.key;
    if (!cambios[key]) return;
    const visible = row.querySelector('.ec-visible')?.checked !== false;
    const valorRaw = row.querySelector('.ec-valor')?.value;
    const valor = parseFloat(valorRaw);
    cambios[key] = {
      ...cambios[key],
      visible,
      valor: isNaN(valor) ? cambios[key].valor : valor,
      // Si el usuario editó el valor a mano, lo marcamos manual para que el
      // fetch automático no lo pise.
      manual: (!isNaN(valor) && valor !== cambios[key].valor) ? true : cambios[key].manual,
    };
  });
  state.ajustes.tipos_cambio = cambios;
  state.ajustes.tipos_cambio_updated = new Date().toLocaleString('es-AR');
  await saveAjustes({});
  await reloadAll();
  document.getElementById('dlg-editor-cotiz')?.close();
  toast('✓ Cotizaciones actualizadas');
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
    const c      = _resolverColoresChart();
    const grad   = ctx.createLinearGradient(0, 0, 0, 120);
    grad.addColorStop(0, _hexAlpha(c.brand, 0.4));
    grad.addColorStop(1, _hexAlpha(c.brand, 0.02));
    chartPrediccion = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Sup',  data: upper, borderColor: _hexAlpha(c.brand,0.15), backgroundColor: _hexAlpha(c.brand,0.06), fill: '+1', pointRadius: 0, borderWidth: 0, tension: .3 },
          { label: 'Inf',  data: lower, borderColor: _hexAlpha(c.brand,0.15), backgroundColor: 'transparent', pointRadius: 0, borderWidth: 0, tension: .3 },
          { label: 'Saldo proyectado', data, borderColor: c.brand, backgroundColor: grad, fill: false, pointRadius: 0, borderWidth: 2, tension: .25 },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.tooltipBg, borderColor: c.brand, borderWidth: 1,
            titleColor: c.inkMuted, bodyColor: c.ink,
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

/* ============ Sueldo (recibos) ============ */
function renderSueldo(el) {
  // Filtrar solo recibos de sueldo
  const recibos = (state.ingresos || [])
    .filter(i => !i.deleted && i.es_recibo_sueldo)
    .sort((a,b) => (b.periodo_aplicacion || '').localeCompare(a.periodo_aplicacion || ''));

  const ultimo   = recibos[0];
  const anterior = recibos[1];

  // KPI principal
  const actEl  = el.querySelector('[data-bind="sueldo-actual"]');
  const varEl  = el.querySelector('[data-bind="sueldo-variacion"]');
  const perEl  = el.querySelector('[data-bind="sueldo-periodo"]');
  if (actEl) actEl.textContent = ultimo ? FMT.format(ultimo.sueldo_neto || 0) : '$0';
  if (perEl) perEl.textContent = ultimo
    ? `${ultimo.empleador ? ultimo.empleador + ' · ' : ''}${ultimo.periodo_aplicacion || '—'}`
    : 'Sin recibos cargados';
  if (varEl) {
    if (ultimo && anterior && anterior.sueldo_neto > 0) {
      const variacion = ((ultimo.sueldo_neto - anterior.sueldo_neto) / anterior.sueldo_neto) * 100;
      const arrow = variacion > 0 ? '↑' : variacion < 0 ? '↓' : '=';
      const color = variacion > 0 ? 'var(--success)' : variacion < 0 ? 'var(--danger)' : 'var(--ink-muted)';
      varEl.textContent = `${arrow} ${Math.abs(variacion).toFixed(1)}% vs ${anterior.periodo_aplicacion}`;
      varEl.style.color = color;
    } else {
      varEl.textContent = '';
    }
  }

  // KPIs secundarios
  const mensuales = recibos.filter(r => (r.tipo_periodo || 'mensual') === 'mensual');
  const ultimos3 = mensuales.slice(0, 3);
  const promedio = ultimos3.length ? ultimos3.reduce((a,r)=>a+(r.sueldo_neto||0), 0) / ultimos3.length : 0;
  const aguinaldos = recibos.filter(r => r.tipo_periodo === 'aguinaldo');
  const ultimoAguinaldo = aguinaldos[0]?.sueldo_neto || 0;

  el.querySelector('[data-bind="sueldo-prom"]').textContent      = FMT.format(promedio);
  el.querySelector('[data-bind="sueldo-prox"]').textContent      = FMT.format(promedio);
  el.querySelector('[data-bind="sueldo-aguinaldo"]').textContent = FMT.format(ultimoAguinaldo);

  // Tabla histórica
  const tbody = el.querySelector('[data-bind="recibos-rows"]');
  const empty = el.querySelector('[data-bind="recibos-empty"]');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (recibos.length === 0) {
    if (empty) empty.style.display = 'block';
  } else {
    if (empty) empty.style.display = 'none';
    for (const r of recibos.slice(0, 6)) {
      const tipo = r.tipo_periodo || 'mensual';
      const desc = r.descuentos_detalle
        ? Object.values(r.descuentos_detalle).reduce((a,v) => a + (v || 0), 0)
        : ((r.sueldo_bruto || 0) - (r.sueldo_neto || 0));
      const badgeCls = tipo === 'mensual' ? '' : tipo;
      const badge = tipo !== 'mensual' ? `<span class="rec-tipo-badge ${badgeCls}">${tipo}</span>` : '';
      tbody.insertAdjacentHTML('beforeend', `
        <tr>
          <td>${escapeHtml(r.periodo_aplicacion || '—')}${badge}</td>
          <td>${FMT.format(r.sueldo_bruto || 0)}</td>
          <td style="color:var(--danger)">-${FMT.format(desc)}</td>
          <td style="color:var(--success)">${FMT.format(r.sueldo_neto || 0)}</td>
          <td><button class="rec-delete" data-rec-del="${r.id}" title="Eliminar">✕</button></td>
        </tr>`);
    }
    tbody.querySelectorAll('[data-rec-del]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este recibo?')) return;
        await DB.softDelete('ingresos', b.dataset.recDel);
        notificarCambioLocal();
        await reloadAll();
        toast('Recibo eliminado');
      });
    });
  }

  // Botón "+ Cargar recibo"
  el.querySelector('[data-action="add-recibo"]')?.addEventListener('click', () => abrirDialogoRecibo());
}

function abrirDialogoRecibo(reciboExistente = null) {
  const dlg = document.getElementById('dlg-recibo');
  if (!dlg) return;
  const form = dlg.querySelector('form');
  form.reset();
  if (form.elements._editing_id) form.elements._editing_id.value = reciboExistente?.id || '';

  // Poblar select de cuentas
  const cuentas = (state.cuentas || []).filter(c => !c.deleted);
  const sel = form.elements.cuenta_id;
  if (sel) {
    sel.innerHTML = `<option value="">Sin cuenta</option>` +
      cuentas.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');
  }

  // Defaults
  const hoy = new Date();
  if (!form.elements.fecha.value)               form.elements.fecha.value = hoy.toISOString().slice(0,10);
  if (!form.elements.periodo_aplicacion.value)  form.elements.periodo_aplicacion.value = hoy.toISOString().slice(0,7);

  if (reciboExistente) {
    form.elements.empleador.value         = reciboExistente.empleador || '';
    form.elements.fecha.value             = reciboExistente.fecha || hoy.toISOString().slice(0,10);
    form.elements.periodo_aplicacion.value= reciboExistente.periodo_aplicacion || hoy.toISOString().slice(0,7);
    form.elements.sueldo_bruto.value      = reciboExistente.sueldo_bruto || '';
    form.elements.sueldo_neto.value       = reciboExistente.sueldo_neto || '';
    form.elements.bonos.value             = reciboExistente.bonos || '';
    form.elements.cuenta_id.value         = reciboExistente.cuenta_id || '';
    if (reciboExistente.tipo_periodo) {
      const r = form.querySelector(`input[name="tipo_periodo"][value="${reciboExistente.tipo_periodo}"]`);
      if (r) r.checked = true;
    }
    const dd = reciboExistente.descuentos_detalle || {};
    for (const k of ['jubilacion','obra_social','ley_19032','impuesto_ganancias','sindicato','otros']) {
      if (form.elements['desc_' + k]) form.elements['desc_' + k].value = dd[k] || '';
    }
  }

  actualizarResumenRecibo();
  dlg.showModal();
}

/**
 * Rellena los campos del formulario de recibo con los datos extraídos del PDF.
 * Solo escribe campos que vinieron con datos no vacíos. Si el bruto NO se detectó
 * pero sí el neto + descuentos, deja al usuario que ajuste.
 */
function rellenarFormularioRecibo(datos) {
  const form = document.querySelector('#dlg-recibo form');
  if (!form || !datos) return;

  const set = (name, val) => {
    const el = form.elements[name];
    if (!el) return;
    if (val === undefined || val === null || val === '' || val === 0) return;
    el.value = typeof val === 'number' ? val.toFixed(2) : val;
  };

  set('empleador',          datos.empleador);
  set('periodo_aplicacion', datos.periodo_aplicacion);
  set('fecha',              datos.fecha);
  set('sueldo_bruto',       datos.sueldo_bruto);
  set('sueldo_neto',        datos.sueldo_neto);
  set('bonos',              datos.bonos);

  if (datos.descuentos) {
    set('desc_jubilacion',  datos.descuentos.jubilacion);
    set('desc_ley_19032',   datos.descuentos.ley_19032);
    set('desc_obra_social', datos.descuentos.obra_social);
    set('desc_sindicato',   datos.descuentos.sindicato);
  }

  // El neto vino directo del PDF, no queremos que actualizarResumenRecibo lo pise
  const netoEl = form.elements.sueldo_neto;
  if (netoEl && datos.sueldo_neto) netoEl.dataset.autoCalc = '';

  // Abrir el <details> de descuentos si encontramos algún descuento
  const dEl = form.querySelector('details.form-collapse');
  const hayDescuentos = datos.descuentos && Object.values(datos.descuentos).some(v => v > 0);
  if (dEl && hayDescuentos) dEl.open = true;

  // Refrescar resumen total
  actualizarResumenRecibo();
}

function actualizarResumenRecibo() {
  const form = document.querySelector('#dlg-recibo form');
  if (!form) return;
  const neto = parseFloat(form.elements.sueldo_neto?.value) || 0;
  const bonos= parseFloat(form.elements.bonos?.value) || 0;
  const total = neto + bonos;
  const totEl = document.getElementById('rec-total');
  if (totEl) totEl.textContent = FMT.format(total);

  // Suma de descuentos
  let descTotal = 0;
  for (const k of ['jubilacion','obra_social','ley_19032','impuesto_ganancias','sindicato','otros']) {
    descTotal += parseFloat(form.elements['desc_' + k]?.value) || 0;
  }
  const descEl = document.getElementById('rec-desc-total');
  if (descEl) descEl.textContent = '-' + FMT.format(descTotal);

  // Auto-calcular neto si bruto - descuentos > 0 y neto está vacío
  const bruto = parseFloat(form.elements.sueldo_bruto?.value) || 0;
  const netoEl = form.elements.sueldo_neto;
  if (bruto > 0 && descTotal > 0 && (!netoEl.value || netoEl.dataset.autoCalc === '1')) {
    netoEl.value = (bruto - descTotal).toFixed(2);
    netoEl.dataset.autoCalc = '1';
  }
}

async function handleSubmitRecibo(form) {
  const fd = new FormData(form);
  const editingId = fd.get('_editing_id');
  const base = editingId ? (await DB.get('ingresos', editingId) || {}) : {};

  const descuentos_detalle = {
    jubilacion:          parseFloat(fd.get('desc_jubilacion')||0),
    obra_social:         parseFloat(fd.get('desc_obra_social')||0),
    ley_19032:           parseFloat(fd.get('desc_ley_19032')||0),
    impuesto_ganancias:  parseFloat(fd.get('desc_impuesto_ganancias')||0),
    sindicato:           parseFloat(fd.get('desc_sindicato')||0),
    otros:               parseFloat(fd.get('desc_otros')||0),
  };
  const descTotal = Object.values(descuentos_detalle).reduce((a,v)=>a+v, 0);

  const r = {
    ...base,
    id: editingId || uuid(),
    updated_at: nowTs(),
    deleted: false,
    es_recibo_sueldo: true,
    tipo_periodo: fd.get('tipo_periodo') || 'mensual',
    empleador: fd.get('empleador') || null,
    fecha: fd.get('fecha'),
    periodo_aplicacion: fd.get('periodo_aplicacion'),
    sueldo_bruto: parseFloat(fd.get('sueldo_bruto')||0),
    sueldo_neto: parseFloat(fd.get('sueldo_neto')||0),
    bonos: parseFloat(fd.get('bonos')||0),
    cuenta_id: fd.get('cuenta_id') || null,
    descuentos_detalle,
    descuentos: descTotal,
    descripcion: fd.get('tipo_periodo') === 'aguinaldo' ? 'Aguinaldo' : (fd.get('tipo_periodo') === 'bono' ? 'Bono' : 'Sueldo'),
  };
  await DB.put('ingresos', r); notificarCambioLocal();
  toast(editingId ? 'Recibo actualizado' : 'Recibo guardado');
  await reloadAll();
}

function actualizarSidebar() {
  // ── Saldo líquido y proyectado ────────────────────────────
  const sbSaldo = document.getElementById('sb-saldo');
  if (sbSaldo && state.estado) {
    sbSaldo.textContent = FMT.format(state.estado.saldo_liquido);
    sbSaldo.style.color = state.estado.saldo_liquido >= 0 ? 'var(--ink)' : 'var(--danger)';
  }
  const sbProy = document.getElementById('sb-saldo-proy');
  if (sbProy && state.estado) {
    sbProy.textContent = `Proyectado: ${FMT.format(state.estado.saldo_proyectado)}`;
  }

  // ── Lista mini de cuentas bancarias ──────────────────────
  const cuentasBox = document.getElementById('sb-cuentas-list');
  if (cuentasBox) {
    cuentasBox.innerHTML = '';
    const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
    if (cuentas.length === 0) {
      cuentasBox.innerHTML = `<div class="sidebar-mini-empty">Sin cuentas</div>`;
    } else {
      const ICONS = { caja_ahorro:'🏦', cuenta_corriente:'💼', billetera:'📱', efectivo:'💵', inversion:'📈', cripto:'₿' };
      for (const c of cuentas) {
        const saldo = calcularSaldoCuenta(c);
        const color = c.color || 'var(--brand)';
        const icon  = ICONS[c.tipo] || '🏦';
        const html  = `
          <div class="sidebar-mini-item" data-cuenta-id="${c.id}" style="--accent:${color}">
            <div class="mi-head">
              <span class="mi-icon">${icon}</span>
              <span class="mi-nombre">${escapeHtml(c.nombre)}</span>
            </div>
            <span class="mi-saldo" style="color:${saldo >= 0 ? 'var(--success)' : 'var(--danger)'}">${FMT.format(saldo)}</span>
            ${c.banco ? `<p class="mi-info">${escapeHtml(c.banco)}</p>` : ''}
          </div>`;
        cuentasBox.insertAdjacentHTML('beforeend', html);
      }
      cuentasBox.querySelectorAll('[data-cuenta-id]').forEach(el =>
        el.addEventListener('click', () => abrirVistaCuentas())
      );
    }
  }

  // ── Lista mini de tarjetas con info completa ─────────────
  const tarjBox = document.getElementById('sb-tarjetas-list');
  if (tarjBox) {
    tarjBox.innerHTML = '';
    const tarjetas = (state.tarjetas || []).filter(t => !t.deleted && t.activa !== false);
    if (tarjetas.length === 0) {
      tarjBox.innerHTML = `<div class="sidebar-mini-empty">Sin tarjetas</div>`;
    } else {
      // Capacidad por tarjeta (de state.capacidad)
      const cap = state.capacidad;
      const mesesCortos = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      const fmtCorto = (iso) => {
        if (!iso) return '—';
        const d = new Date(iso + 'T12:00:00');
        return `${d.getDate()} ${mesesCortos[d.getMonth()]}`;
      };
      for (const t of tarjetas) {
        const r = state.resumenes.find(x => x.tarjeta_id === t.id);
        const capT = cap?.por_tarjeta?.find(x => x.tarjeta_id === t.id);
        const lim = (t.limite_un_pago||0) + (t.limite_cuotas||0);
        const usado = r?.total_resumen || 0;
        const disp  = Math.max(0, lim - usado);
        const pct   = lim ? Math.min(100, Math.round(usado*100/lim)) : 0;
        const diasC = r?.dias_para_cierre ?? 0;
        const cuotasN = capT?.cuotas_pendientes?.length || 0;
        const color  = t.color || 'var(--brand)';

        let badgeCls, badgeTxt;
        if (diasC <= 2)      { badgeCls = 'urgente'; badgeTxt = `${diasC}d`; }
        else if (diasC <= 7) { badgeCls = 'warning'; badgeTxt = `${diasC}d`; }
        else                 { badgeCls = 'ok';      badgeTxt = `${diasC}d`; }

        tarjBox.insertAdjacentHTML('beforeend', `
          <div class="sidebar-mini-item" data-tarjeta-id="${t.id}" style="--accent:${color}">
            <div class="mi-head">
              <span class="mi-icon">💳</span>
              <span class="mi-nombre">${escapeHtml(t.nombre)}</span>
              <span class="mi-badge ${badgeCls}">${badgeTxt}</span>
            </div>
            <span class="mi-saldo" style="color:${color}">${FMT.format(usado)}</span>
            <div class="mi-progress"><div style="width:${pct}%"></div></div>
            <div class="mi-row">
              <span>Disp: <b style="color:var(--success)">${FMT.format(disp)}</b></span>
              <span>${pct}%</span>
            </div>
            <div class="mi-row">
              <span>🔒 ${fmtCorto(r?.fecha_cierre)}</span>
              <span>💸 ${fmtCorto(r?.fecha_vencimiento)}</span>
            </div>
            ${cuotasN > 0 ? `<div class="mi-row"><span>📦 ${cuotasN} cuota${cuotasN!==1?'s':''} pendiente${cuotasN!==1?'s':''}</span></div>` : ''}
          </div>`);
      }
      tarjBox.querySelectorAll('[data-tarjeta-id]').forEach(el =>
        el.addEventListener('click', () => abrirDrawerTarjeta(el.dataset.tarjetaId))
      );
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
            <p class="text-xs font-medium truncate" style="color:var(--ink)">${m._tipo === 'gasto' && m.categoria ? `(${escapeHtml(m.categoria)}) - ` : ''}${escapeHtml(m.descripcion||'Movimiento')}</p>
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

  // ── Mes por defecto ─────────────────────────────────────────
  const mesActual = new Date().toISOString().slice(0,7);
  if (!selMes.value) {
    const meses = new Set();
    state.gastos.forEach(g => { if (g.fecha) meses.add(g.fecha.slice(0,7)); });
    state.ingresos.forEach(i => {
      if (i.fecha) meses.add(i.fecha.slice(0,7));
      if (i.periodo_aplicacion) meses.add(i.periodo_aplicacion);
    });
    const mesList = [...meses].sort().reverse();
    selMes.value = _movMesFiltro || (mesList.length ? mesList[0] : mesActual);
  }
  selMes.onchange = () => { _movMesFiltro = selMes.value; renderMovimientos(); };
  const mes = selMes.value || mesActual;
  _movMesFiltro = mes;

  // ── Búsqueda de texto ───────────────────────────────────────
  const txtInput = document.getElementById('mov-txt-search');
  if (txtInput && !txtInput._wired) {
    txtInput._wired = true;
    txtInput.oninput = () => { _movTxtFiltro = txtInput.value.toLowerCase(); renderMovimientos(); };
  }

  // ── Chips de categoría ──────────────────────────────────────
  _renderFiltrosCategoria(mes);

  // ── Datos filtrados ─────────────────────────────────────────
  let gastosMes = state.gastos
    .filter(g => !g.deleted && g.fecha?.startsWith(mes))
    .sort((a,b) => b.fecha.localeCompare(a.fecha));
  let ingresosMes = state.ingresos
    .filter(i => !i.deleted && (i.periodo_aplicacion===mes || i.fecha?.startsWith(mes)))
    .sort((a,b) => b.fecha.localeCompare(a.fecha));

  // Aplicar filtro de categoría
  if (_movCatFiltro) {
    gastosMes = gastosMes.filter(g => (g.categoria||'general') === _movCatFiltro);
    ingresosMes = []; // ingresos no tienen cat de gasto
  }
  // Aplicar filtro de subcategoría
  if (_movSubcatFiltro) {
    gastosMes = gastosMes.filter(g => g.subcategoria === _movSubcatFiltro);
  }
  // Aplicar texto libre
  if (_movTxtFiltro) {
    const txt = _movTxtFiltro;
    gastosMes   = gastosMes.filter(g =>
      (g.descripcion||'').toLowerCase().includes(txt) ||
      (g.categoria||'').toLowerCase().includes(txt) ||
      (g.subcategoria||'').toLowerCase().includes(txt));
    ingresosMes = ingresosMes.filter(i =>
      (i.descripcion||'').toLowerCase().includes(txt));
  }

  list.innerHTML = '';
  empty.classList.toggle('hidden', gastosMes.length + ingresosMes.length > 0);

  const SVG_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  const SVG_EDIT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

  const allCats = state.ajustes?.catalogos?.categorias_gasto?.length
    ? state.ajustes.catalogos.categorias_gasto
    : (state.ajustes?.categorias_gasto || AJUSTES_DEFAULT.categorias_gasto);

  // ── Helpers de fila ─────────────────────────────────────────
  const ingresoHTML = (i) => {
    const total = (i.sueldo_neto || 0) + (i.bonos || 0);
    return `
      <div class="mov-row-gasto" data-id="${i.id}" data-tipo="ingreso">
        <div class="mov-row-icon" style="background:rgba(0,255,159,.1)">💰</div>
        <div class="mov-row-body">
          <div class="mov-row-desc">${escapeHtml(i.descripcion || 'Ingreso')}</div>
          <div class="mov-row-meta">
            <span>período ${i.periodo_aplicacion || '—'}</span>
            ${i.sueldo_bruto ? `<span>bruto ${FMT.format(i.sueldo_bruto)}</span>` : ''}
          </div>
          <div class="mov-row-meta" style="margin-top:.2rem">
            <span class="mov-cat-badge" style="background:rgba(0,255,159,.1);color:var(--success);border-color:rgba(0,255,159,.25)">💰 Ingreso</span>
          </div>
        </div>
        <div class="mov-row-right">
          <span class="mov-row-monto income">${FMT.format(total)}</span>
          <div class="mov-row-actions">
            <button class="mov-row-btn edit" data-edit-ing="${i.id}" title="Editar">${SVG_EDIT}</button>
            <button class="mov-row-btn del"  data-del-ing="${i.id}" title="Eliminar">${SVG_TRASH}</button>
          </div>
        </div>
      </div>`;
  };
  const gastoHTML = (g) => {
    const catObj  = allCats.find(c => c.id === g.categoria || c.nombre?.toLowerCase() === (g.categoria||'').toLowerCase());
    const icon    = catObj?.icono || CAT_ICON[g.categoria] || '📌';
    const catColor= catObj?.color || '#94a3b8';
    const monto   = g.compartido ? g.monto * (1 - (g.compartido.porcentaje_otro||0)/100) : g.monto;
    const cuotas  = g.tipo === 'cuotas' ? `cuota ${g.cuota_numero}/${g.cuotas_total}` : '';
    const tarjeta = g.tarjeta_id ? state.tarjetas.find(t=>t.id===g.tarjeta_id) : null;
    const metodo  = tarjeta ? `💳 ${escapeHtml(tarjeta.nombre)}` : (METODO_LABEL[g.metodo_pago] || g.metodo_pago || 'efectivo');
    const monedaFmt = (g.moneda && g.moneda !== 'ARS')
      ? `${g.moneda} ${(g.monto||0).toLocaleString('es-AR',{minimumFractionDigits:2})}`
      : FMT.format(monto);
    return `
      <div class="mov-row-gasto" data-id="${g.id}" data-tipo="gasto">
        <div class="mov-row-icon" style="background:${catColor}18;border:1px solid ${catColor}33">${icon}</div>
        <div class="mov-row-body">
          <div class="mov-row-desc">${escapeHtml(g.descripcion || '—')}</div>
          <div class="mov-row-meta">
            <span>${escapeHtml(metodo)}</span>
            ${cuotas ? `<span>${cuotas}</span>` : ''}
            ${g.compartido ? `<span>👫 ${escapeHtml(g.compartido.persona)}</span>` : ''}
          </div>
          <div class="mov-row-meta" style="margin-top:.2rem">
            <span class="mov-cat-badge" style="background:${catColor}14;color:${catColor};border-color:${catColor}33">
              ${icon} ${escapeHtml(catObj?.nombre || g.categoria || 'general')}
            </span>
            ${g.subcategoria ? `<span class="mov-subcat-badge">${escapeHtml(g.subcategoria)}</span>` : ''}
          </div>
        </div>
        <div class="mov-row-right">
          <span class="mov-row-monto">${monedaFmt}</span>
          ${g.compartido ? `<span style="font-size:.68rem;color:var(--ink-muted)">total ${FMT.format(g.monto)}</span>` : ''}
          <div class="mov-row-actions">
            <button class="mov-row-btn edit" data-edit-gas="${g.id}" title="Editar">${SVG_EDIT}</button>
            <button class="mov-row-btn del"  data-del-gas="${g.id}"  title="Eliminar">${SVG_TRASH}</button>
          </div>
        </div>
      </div>`;
  };

  // ── Unificar items y agrupar por FECHA (período diario) ──────
  const items = [];
  for (const i of ingresosMes) items.push({ fecha: i.fecha || '', tipo: 'ingreso', signo: +1, monto: (i.sueldo_neto||0)+(i.bonos||0), html: ingresoHTML(i) });
  for (const g of gastosMes) {
    if (g.es_pago_tarjeta) continue;
    const m = g.compartido ? g.monto * (1 - (g.compartido.porcentaje_otro||0)/100) : g.monto;
    items.push({ fecha: g.fecha || '', tipo: 'gasto', signo: -1, monto: m, moneda: g.moneda, html: gastoHTML(g) });
  }
  items.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  // Agrupar por día
  const grupos = new Map();
  for (const it of items) {
    if (!grupos.has(it.fecha)) grupos.set(it.fecha, []);
    grupos.get(it.fecha).push(it);
  }

  const hoyISO = new Date().toISOString().slice(0,10);
  const ayer = new Date(); ayer.setDate(ayer.getDate()-1);
  const ayerISO = ayer.toISOString().slice(0,10);
  const fmtCabecera = (iso) => {
    if (!iso) return 'Sin fecha';
    if (iso === hoyISO)  return 'Hoy';
    if (iso === ayerISO) return 'Ayer';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
  };

  for (const [fecha, grupo] of grupos) {
    // Total neto del día (gastos solo en ARS para el resumen rápido)
    const totalDiaArs = grupo.filter(x => x.tipo === 'gasto' && (!x.moneda || x.moneda === 'ARS'))
      .reduce((a, x) => a + x.monto, 0);
    list.insertAdjacentHTML('beforeend', `
      <div class="mov-period-header">
        <span class="mov-period-fecha">${escapeHtml(fmtCabecera(fecha))}</span>
        <span class="mov-period-total">${grupo.length} ítem${grupo.length===1?'':'s'}${totalDiaArs ? ` · ${FMT.format(totalDiaArs)}` : ''}</span>
      </div>`);
    for (const it of grupo) list.insertAdjacentHTML('beforeend', it.html);
  }

  // ── Handlers ────────────────────────────────────────────────
  list.querySelectorAll('[data-del-gas]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('¿Eliminar este gasto?')) return;
      await DB.softDelete('gastos', btn.dataset.delGas);
      notificarCambioLocal(); toast('Gasto eliminado'); await reloadAll();
    };
  });
  list.querySelectorAll('[data-del-ing]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('¿Eliminar este ingreso?')) return;
      await DB.softDelete('ingresos', btn.dataset.delIng);
      notificarCambioLocal(); toast('Ingreso eliminado'); await reloadAll();
    };
  });
  list.querySelectorAll('[data-edit-gas]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const g = await DB.get('gastos', btn.dataset.editGas);
      if (!g) return;
      openDialog('dlg-gasto', {
        _editing_id: g.id, descripcion: g.descripcion,
        monto: g.monto, fecha: g.fecha,
        categoria: g.categoria || '',
        subcategoria: g.subcategoria || '',
        cuenta_id: g.cuenta_id || '',
      });
    };
  });
  list.querySelectorAll('[data-edit-ing]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const i = await DB.get('ingresos', btn.dataset.editIng);
      if (!i) return;
      openDialog('dlg-ingreso', {
        _editing_id: i.id, descripcion: i.descripcion || '',
        sueldo_neto: i.sueldo_neto, fecha: i.fecha,
        periodo_aplicacion: i.periodo_aplicacion || '',
        cuenta_id: i.cuenta_id || '',
        sueldo_bruto: i.sueldo_bruto || '', descuentos: i.descuentos || '', bonos: i.bonos || '',
      });
    };
  });
}

/** Renderiza los chips de categoría para filtrar el historial. */
function _renderFiltrosCategoria(mes) {
  const wrap    = document.getElementById('mov-cat-chips');
  const subWrap = document.getElementById('mov-subcat-chips');
  if (!wrap) return;

  // Categorías presentes en el mes
  const allCats = state.ajustes?.catalogos?.categorias_gasto?.length
    ? state.ajustes.catalogos.categorias_gasto
    : (state.ajustes?.categorias_gasto || AJUSTES_DEFAULT.categorias_gasto);
  const catsEnMes = new Set(
    state.gastos.filter(g => !g.deleted && !g.es_pago_tarjeta && g.fecha?.startsWith(mes))
      .map(g => g.categoria || 'general')
  );

  wrap.innerHTML = `<button class="mov-filtro-todos${!_movCatFiltro?' active':''}" id="mov-cat-todos">Todos</button>` +
    allCats.filter(c => catsEnMes.has(c.id) || catsEnMes.has(c.nombre?.toLowerCase())).map(c => {
      const id = c.id || c.nombre;
      return `<button class="mov-filtro-chip${_movCatFiltro===id?' active':''}" data-cat="${escapeHtml(id)}"
               style="${_movCatFiltro===id?`--chip-color:${c.color};border-color:${c.color};color:${c.color}`:''}"
              >${escapeHtml(c.icono||'📌')} ${escapeHtml(c.nombre)}</button>`;
    }).join('');

  wrap.querySelector('#mov-cat-todos')?.addEventListener('click', () => {
    _movCatFiltro = ''; _movSubcatFiltro = '';
    renderMovimientos();
  });
  wrap.querySelectorAll('[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      _movCatFiltro = _movCatFiltro === btn.dataset.cat ? '' : btn.dataset.cat;
      _movSubcatFiltro = '';
      renderMovimientos();
    });
  });

  // Subcategorías de la categoría activa
  if (_movCatFiltro && subWrap) {
    const catObj = allCats.find(c => (c.id||c.nombre) === _movCatFiltro);
    const subcats = catObj?.subcategorias || [];
    if (subcats.length) {
      subWrap.hidden = false;
      subWrap.innerHTML = `<button class="mov-filtro-todos${!_movSubcatFiltro?' active':''}">Todas</button>` +
        subcats.map(s => `<button class="mov-filtro-chip subcat${_movSubcatFiltro===s?' active':''}" data-subcat="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
      subWrap.querySelector('.mov-filtro-todos')?.addEventListener('click', () => { _movSubcatFiltro = ''; renderMovimientos(); });
      subWrap.querySelectorAll('[data-subcat]').forEach(btn => {
        btn.addEventListener('click', () => {
          _movSubcatFiltro = _movSubcatFiltro === btn.dataset.subcat ? '' : btn.dataset.subcat;
          renderMovimientos();
        });
      });
    } else { subWrap.hidden = true; }
  } else if (subWrap) { subWrap.hidden = true; }
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

/**
 * Inicializa el wizard multi-paso del formulario de gastos.
 * Paso 1: Categoría + Subcategoría
 * Paso 2: Descripción + Monto + Fecha
 * Paso 3: ¿Con qué pagás? + Cuotas + Ciclo de tarjeta
 */
function prepararDialogoGasto(form) {
  // ── Resetear el wizard al paso 1 ─────────────────────────────
  const slides = form.querySelector('#gasto-slides');
  if (slides) { slides.dataset.current = '1'; slides.style.transition = 'none'; }
  setTimeout(() => { if (slides) slides.style.transition = ''; }, 50);

  // ── Poblar categorías dinámicamente ─────────────────────────
  // Pueden estar en catalogos.categorias_gasto (usuario) o en categorias_gasto (default)
  const cats = state.ajustes?.catalogos?.categorias_gasto?.length
    ? state.ajustes.catalogos.categorias_gasto
    : (state.ajustes?.categorias_gasto || AJUSTES_DEFAULT.categorias_gasto);
  const chipsWrap = form.querySelector('#chips-categoria-gasto');
  if (chipsWrap) {
    chipsWrap.innerHTML = cats.map(c => `
      <label class="cat-chip">
        <input type="radio" name="cat_quick" value="${escapeHtml(c.id||c.nombre)}">
        <span>${escapeHtml(c.icono||'📌')}<br>${escapeHtml(c.nombre)}</span>
      </label>`).join('');
  }

  // ── Poblar selects de tarjetas y cuentas ─────────────────────
  const tarjetas = state.tarjetas.filter(t => !t.deleted && t.activa !== false);
  const cuentas  = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
  const selTarj  = form.querySelector('#sel-tarjeta-simple');
  const selCuenta= form.querySelector('#sel-cuenta-gasto');
  if (selTarj)  selTarj.innerHTML  = `<option value="">Elegir tarjeta…</option>` + tarjetas.map(t => `<option value="${t.id}">${escapeHtml(t.nombre)}</option>`).join('');
  if (selCuenta) selCuenta.innerHTML = `<option value="">Sin cuenta específica</option>` + cuentas.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)}</option>`).join('');

  // ── Default fecha hoy ────────────────────────────────────────
  const fechaInp = form.querySelector('#inp-fecha-gasto');
  if (fechaInp && !fechaInp.value) fechaInp.value = new Date().toISOString().slice(0, 10);

  // ── Funciones del wizard ─────────────────────────────────────
  let pasoActual = 1;
  const backBtn = form.querySelector('#gasto-btn-back');

  const irAPaso = (paso, dir = 1) => {
    pasoActual = paso;
    if (slides) slides.dataset.current = String(paso);
    // Stepper dots
    form.querySelectorAll('.gasto-step-dot').forEach(d => {
      const n = parseInt(d.dataset.step);
      d.classList.toggle('active', n === paso);
      d.classList.toggle('done', n < paso);
    });
    form.querySelectorAll('.gasto-step-line').forEach((l, i) => {
      l.classList.toggle('done', i < paso - 1);
    });
    if (backBtn) backBtn.hidden = paso === 1;
    // Foco en el primer campo del nuevo paso
    setTimeout(() => {
      const slide = form.querySelector(`.gasto-slide[data-slide="${paso}"]`);
      slide?.querySelector('input:not([type=hidden])')?.focus?.();
    }, 380);
  };

  if (backBtn) backBtn.onclick = () => irAPaso(Math.max(1, pasoActual - 1), -1);
  irAPaso(1);

  // ── PASO 1: elegir categoría y avanzar ────────────────────────
  const actualizarCategoria = (catId, nombreMostrar, icono) => {
    form.querySelector('#inp-categoria-gasto').value = catId;
    form.querySelector('#hid-tipo-gasto').value = 'unico';
    // Mostrar badge en paso 2
    const badge = form.querySelector('#gasto-badge-cat');
    if (badge) badge.textContent = `${icono || ''} ${nombreMostrar}`.trim();
    // Subcategorías
    _actualizarSubcategoriasGasto(form, catId);
  };

  form.querySelectorAll('input[name="cat_quick"]').forEach(r => {
    r.addEventListener('change', () => {
      const cat = cats.find(c => (c.id||c.nombre) === r.value);
      actualizarCategoria(r.value, cat?.nombre || r.value, cat?.icono || '');
      const subcats = cat?.subcategorias || [];
      // Si tiene subcategorías, no autoavanzo: espero que elija subcategoría
      if (!subcats.length) setTimeout(() => irAPaso(2), 280);
    });
  });

  form.querySelector('#inp-categoria-gasto')?.addEventListener('input', e => {
    actualizarCategoria(e.target.value, e.target.value, '');
  });

  form.querySelector('#gasto-next-1')?.addEventListener('click', () => {
    const cat = form.querySelector('#inp-categoria-gasto').value || '';
    if (!cat) { toast('Elegí o escribí una categoría', 2000); return; }
    irAPaso(2);
  });

  // ── PASO 2: monto + validar → paso 3 ─────────────────────────
  form.querySelector('#gasto-next-2')?.addEventListener('click', () => {
    const monto = parseFloat(form.querySelector('[name="monto"]')?.value || '0');
    const desc  = form.querySelector('[name="descripcion"]')?.value?.trim() || '';
    if (!desc)  { toast('Escribí una descripción', 2000); return; }
    if (!monto) { toast('Ingresá un monto', 2000); return; }
    // Actualizar badge monto en paso 3
    const badge = form.querySelector('#gasto-badge-monto');
    if (badge) {
      const moneda = form.querySelector('#gasto-moneda-sel')?.value || 'ARS';
      const fmt = moneda === 'ARS'
        ? new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(monto)
        : `${moneda} ${monto.toLocaleString('es-AR', { minimumFractionDigits:2 })}`;
      badge.textContent = fmt;
    }
    irAPaso(3);
  });

  // ── PASO 3: Tabs cuenta/tarjeta + cuotas + ciclo ─────────────
  const tabCuenta  = form.querySelector('.gasto-pago-tab[data-pago="cuenta"]');
  const tabCredito = form.querySelector('.gasto-pago-tab[data-pago="credito"]');
  const wrapCuenta = form.querySelector('#pago-cuenta-wrap');
  const wrapCredito= form.querySelector('#pago-credito-wrap');
  const hidMetodo  = form.querySelector('#hid-metodo-pago');

  const activarTab = (tab) => {
    tabCuenta?.classList.toggle('active',  tab === 'cuenta');
    tabCredito?.classList.toggle('active', tab === 'credito');
    if (wrapCuenta)  wrapCuenta.hidden  = tab !== 'cuenta';
    if (wrapCredito) wrapCredito.hidden = tab !== 'credito';
    if (hidMetodo) hidMetodo.value = tab === 'credito' ? 'credito' : 'efectivo';
    if (tab === 'credito') {
      form.querySelector('#hid-tipo-gasto').value = 'unico';
      _gsActualizarCicloTarjeta(form);
    } else {
      form.querySelector('#hid-tipo-gasto').value = 'unico';
      const ci = form.querySelector('#ciclo-info'); if (ci) ci.hidden = true;
    }
  };
  if (tabCuenta)  tabCuenta.onclick  = () => activarTab('cuenta');
  if (tabCredito) tabCredito.onclick = () => activarTab('credito');
  activarTab('cuenta');

  // Cuotas: radios + input manual
  form.querySelectorAll('input[name="cuotas_radio"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = parseInt(r.value);
      form.querySelector('#hid-cuotas-total').value = v;
      form.querySelector('#hid-tarjeta-cuot').value = form.querySelector('#sel-tarjeta-simple')?.value || '';
      form.querySelector('#hid-tipo-gasto').value = v > 1 ? 'cuotas' : 'unico';
      form.querySelector('#inp-cuotas-manual').value = '';
    });
  });

  // Ciclo al cambiar tarjeta
  if (selTarj) {
    selTarj.addEventListener('change', () => {
      form.querySelector('#hid-tarjeta-cuot').value = selTarj.value;
      _gsActualizarCicloTarjeta(form);
    });
  }

  // ── Cotización para moneda no-ARS ────────────────────────────
  window._gsActualizarCotiz = () => {
    const moneda = form.querySelector('#gasto-moneda-sel')?.value || 'ARS';
    const rowCot = form.querySelector('#row-cotizacion');
    const lbl    = form.querySelector('#cot-currency-label');
    if (rowCot) rowCot.hidden = moneda === 'ARS';
    if (lbl)    lbl.textContent = moneda;
    window._gsActualizarEquiv?.();
  };
  window._gsActualizarEquiv = () => {
    const cotiz = parseFloat(form.querySelector('#gasto-cotizacion')?.value || '0');
    const monto = parseFloat(form.querySelector('[name="monto"]')?.value || '0');
    const equiv = form.querySelector('#cot-equiv');
    const val   = form.querySelector('#cot-equiv-valor');
    if (!equiv || !val) return;
    if (cotiz > 0 && monto > 0) {
      equiv.hidden = false;
      val.textContent = new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS', maximumFractionDigits:0 }).format(monto * cotiz);
    } else { equiv.hidden = true; }
  };

  // Restore categoría si venimos de edición
  const catEdit = form.querySelector('#inp-categoria-gasto')?.value || '';
  if (catEdit) {
    const cat = cats.find(c => (c.id||c.nombre) === catEdit);
    actualizarCategoria(catEdit, cat?.nombre || catEdit, cat?.icono || '');
    form.querySelectorAll('input[name="cat_quick"]').forEach(r => { r.checked = r.value === catEdit; });
  }
}

/** Muestra el ciclo de facturación de la tarjeta seleccionada en el paso 3. */
function _gsActualizarCicloTarjeta(form) {
  const tarjetaId = form.querySelector('#sel-tarjeta-simple')?.value || '';
  const ci = form.querySelector('#ciclo-info');
  const ct = form.querySelector('#ciclo-info-title');
  const cs = form.querySelector('#ciclo-info-sub');
  if (!ci) return;
  if (!tarjetaId) { ci.hidden = true; return; }
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t) { ci.hidden = true; return; }
  const { cierre, vencimiento, periodo } = fechasCiclo(t, new Date());
  const dd = (d) => d ? `${d.getDate()}/${String(d.getMonth()+1).padStart(2,'0')}` : '—';
  if (ct) ct.textContent = `Tarjeta: ${t.nombre} — ciclo ${periodo}`;
  if (cs) cs.textContent = `Cierra ${dd(cierre)} · Se paga el ${dd(vencimiento)}`;
  ci.hidden = false;
}

/** Carga los chips de subcategoría cuando se selecciona una categoría en el form de gasto. */
function _actualizarSubcategoriasGasto(form, catId) {
  const row = form.querySelector('#row-subcategoria-gasto');
  const chipsWrap = form.querySelector('#chips-subcategoria-gasto');
  const inp = form.querySelector('#inp-subcategoria-gasto');
  if (!row || !chipsWrap) return;
  const _allCats = state.ajustes?.catalogos?.categorias_gasto?.length ? state.ajustes.catalogos.categorias_gasto : (state.ajustes?.categorias_gasto || AJUSTES_DEFAULT.categorias_gasto);
  const cat = _allCats.find(c => c.id === catId || c.nombre?.toLowerCase() === catId?.toLowerCase());
  const subcats = cat?.subcategorias || [];
  if (!subcats.length) { row.hidden = true; if (inp) inp.value = ''; return; }
  row.hidden = false;
  chipsWrap.innerHTML = subcats.map(s => `
    <label class="cat-chip chip-row-sub"><input type="radio" name="subcat_quick" value="${escapeHtml(s)}"><span>${escapeHtml(s)}</span></label>
  `).join('');
  chipsWrap.querySelectorAll('input[name="subcat_quick"]').forEach(r => {
    r.addEventListener('change', () => {
      if (inp) inp.value = r.value;
      // Tras elegir subcategoría, avanzar al paso 2
      setTimeout(() => {
        const slides = form.querySelector('#gasto-slides');
        if (slides) slides.dataset.current = '2';
        form.querySelectorAll('.gasto-step-dot').forEach(d => {
          const n = parseInt(d.dataset.step);
          d.classList.toggle('active', n === 2);
          d.classList.toggle('done', n < 2);
        });
        form.querySelectorAll('.gasto-step-line').forEach((l, i) => l.classList.toggle('done', i < 1));
        const btn = form.querySelector('#gasto-btn-back'); if (btn) btn.hidden = false;
      }, 280);
    });
  });
}

async function handleSubmitGasto(form) {
  const fd = new FormData(form);
  const editingId = fd.get('_editing_id');

  // El wizard usa campos hidden para tipo/cuotas/tarjeta/moneda/cotizacion
  const tipo     = form.querySelector('#hid-tipo-gasto')?.value || fd.get('tipo') || 'unico';
  const metodo   = fd.get('metodo_pago') || 'efectivo';
  const moneda   = form.querySelector('#hid-moneda-gasto')?.value || fd.get('moneda') || 'ARS';
  const cotizStr = form.querySelector('#hid-cotiz-gasto')?.value || fd.get('cotizacion') || '';
  const cotizacionRef = moneda !== 'ARS' && cotizStr ? (parseFloat(cotizStr) || null) : null;

  // Tarjeta: en crédito (cuotas o unico) viene del selector del paso 3
  const tarjetaId = form.querySelector('#hid-tarjeta-cuot')?.value
                 || form.querySelector('#sel-tarjeta-simple')?.value
                 || fd.get('tarjeta_id') || null;

  // Cuotas: del hidden que sincronizamos al elegir chip o manual
  const cuotasTotal = tipo === 'cuotas' ? (parseInt(form.querySelector('#hid-cuotas-total')?.value || fd.get('cuotas_total') || '1')) : 1;

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
    moneda,
    cotizacion_referencia: cotizacionRef,
    cotizacion_al_pagar: base.cotizacion_al_pagar || null,
    descripcion: fd.get('descripcion'),
    categoria: fd.get('categoria') || form.querySelector('#inp-categoria-gasto')?.value || 'general',
    subcategoria: fd.get('subcategoria') || form.querySelector('#inp-subcategoria-gasto')?.value || null,
    metodo_pago: metodo,
    tipo,
    tarjeta_id: metodo === 'credito' ? tarjetaId : (tarjetaId || null),
    cuenta_id: fd.get('cuenta_id') || null,
    cuotas_total: cuotasTotal,
    cuota_numero: base.cuota_numero || 1,
    compartido,
    es_amortizacion_anual: tipo === 'amortizacion',
    adjunto_ref: base.adjunto_ref || null,
  };
  await DB.put('gastos', g); notificarCambioLocal();
  toast(editingId ? 'Gasto actualizado' : '✓ Gasto registrado');
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
  const editingId = fd.get('_editing_id');
  // Si estamos editando, traer la tarjeta existente para preservar
  // cosas como cotizaciones_historico, ciclos_custom, etc.
  const base = editingId ? (await DB.get('tarjetas', editingId) || {}) : {};
  const t = {
    ...base,
    id: editingId || uuid(),
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
    activa: base.activa !== false,
    ciclos_custom: Array.isArray(_ciclosCustomEditando) ? [..._ciclosCustomEditando] : (base.ciclos_custom || []),
  };
  await DB.put('tarjetas', t); notificarCambioLocal();
  toast(editingId ? 'Tarjeta actualizada' : 'Tarjeta creada');
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
  const editingId = fd.get('_editing_id');
  const base = editingId ? (await DB.get('metas', editingId) || {}) : {};
  const m = {
    ...base,
    id: editingId || uuid(),
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
  toast(editingId ? 'Meta actualizada' : 'Meta creada');
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
  renderColoresSistema();
  if (form.elements.moneda)             form.elements.moneda.value             = aj.moneda || 'ARS';
  if (form.elements.nombre_usuario)     form.elements.nombre_usuario.value     = aj.nombre_usuario || '';
  if (form.elements.sensibilidad_ia)    form.elements.sensibilidad_ia.value    = aj.sensibilidad_ia || 'moderado';
  if (form.elements.periodo_default)    form.elements.periodo_default.value    = aj.periodo_default || 'mes_actual';
  if (form.elements.notif_habilitadas)  form.elements.notif_habilitadas.checked = !!aj.notificaciones?.habilitadas;
  if (form.elements.notif_confirmar)    form.elements.notif_confirmar.checked   = !!aj.notificaciones?.confirmar_movimientos;
  if (form.elements.notif_ia)           form.elements.notif_ia.checked          = !!aj.notificaciones?.alertas_ia;
  if (form.elements.alertas_dias)       form.elements.alertas_dias.value        = (aj.notificaciones?.alertas_tarjeta_dias || [5,2,1]).join(',');
  if (form.elements.alertas_margen)     form.elements.alertas_margen.checked    = !!aj.notificaciones?.alertas_margen;
  if (form.elements.margen_minimo)      form.elements.margen_minimo.value       = aj.notificaciones?.margen_minimo ?? '';

  // Toggles + reordenamiento de widgets (reacomodar el dashboard desde el cel)
  renderWidgetsToggle();

  // Inicializar tabs (siempre arrancar en General)
  cambiarSettingsTab('general');

  // Auto-update (default ON)
  if (form.elements.auto_update) form.elements.auto_update.checked = aj.auto_update !== false;

  // Render catálogos y cuentas
  renderCatalogoSettings('gasto');
  renderCatalogoSettings('ingreso');
  renderHabitualesSettings();
  renderCuentasSettings();
  renderTarjetasSettings();

  dlg.showModal();
}

const WIDGET_ICONS = {
  estado_global: '💰', sueldo: '💼', cuentas: '🏦', tarjetas: '💳', habituales: '🔁',
  simulacion_credito: '📊', ia_local: '🧠', metas: '🎯', grafico: '📈',
  resumen_anual: '📅', flujo_mensual: '🌊', categorias: '🍩',
  tipo_cambio: '💱', calculadora: '🧮', comparador: '⚖', prediccion: '🔮', balance: '📉',
};
const WIDGET_LABELS = {
  estado_global: 'Estado global', sueldo: 'Sueldo y recibos', cuentas: 'Cuentas bancarias',
  tarjetas: 'Tarjetas', habituales: 'Gastos habituales',
  simulacion_credito: 'Capacidad crediticia', ia_local: 'Análisis IA',
  metas: 'Metas de ahorro', grafico: 'Evolución 6 meses', resumen_anual: 'Resumen anual',
  flujo_mensual: 'Flujo mensual', categorias: 'Gastos por categoría', tipo_cambio: 'Tipo de cambio',
  calculadora: 'Calculadora', comparador: 'Comparador mensual', prediccion: 'Predicción de gasto',
  balance: 'Balance general',
};

/**
 * Lista de widgets en Settings: respeta el orden del dashboard y permite
 * mostrar/ocultar (checkbox) y reordenar (botones ↑/↓). Reordenar reacomoda
 * el dashboard al instante.
 */
function renderWidgetsToggle() {
  const cont = document.getElementById('widgets-toggle');
  if (!cont) return;
  const aj = state.ajustes;
  // Orden actual = widgets_orden + cualquier key de TPL que falte
  const orden = [...(aj.ui?.widgets_orden || [])];
  for (const k of Object.keys(TPL)) if (!orden.includes(k)) orden.push(k);

  cont.innerHTML = orden.map((id, i) => {
    const checked = (aj.ui?.widgets_visibles || []).includes(id);
    return `
      <div class="widget-toggle-row${checked ? '' : ' off'}" data-widget-row="${id}">
        <div class="widget-toggle-order">
          <button type="button" class="wt-move" data-wt-up="${id}" ${i === 0 ? 'disabled' : ''} title="Subir">▴</button>
          <button type="button" class="wt-move" data-wt-down="${id}" ${i === orden.length - 1 ? 'disabled' : ''} title="Bajar">▾</button>
        </div>
        <span class="widget-icon">${WIDGET_ICONS[id] || '◆'}</span>
        <span class="text-sm flex-1">${escapeHtml(WIDGET_LABELS[id] || id)}</span>
        <label class="wt-switch">
          <input type="checkbox" data-widget="${id}" ${checked ? 'checked' : ''}/>
          <span class="wt-slider"></span>
        </label>
      </div>`;
  }).join('');

  // Persistir el nuevo orden y refrescar dashboard
  const mover = async (id, delta) => {
    const arr = aj.ui.widgets_orden = [...(aj.ui.widgets_orden || orden)];
    // asegurar que estén todas las keys
    for (const k of orden) if (!arr.includes(k)) arr.push(k);
    const idx = arr.indexOf(id);
    const j = idx + delta;
    if (idx < 0 || j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    await DB.put('ajustes', aj);
    renderWidgetsToggle();
    renderWidgets();
  };
  cont.querySelectorAll('[data-wt-up]').forEach(b => b.onclick = () => mover(b.dataset.wtUp, -1));
  cont.querySelectorAll('[data-wt-down]').forEach(b => b.onclick = () => mover(b.dataset.wtDown, +1));
  // Reflejar visibilidad en vivo (estilo de la fila)
  cont.querySelectorAll('input[data-widget]').forEach(chk => chk.onchange = () => {
    chk.closest('.widget-toggle-row')?.classList.toggle('off', !chk.checked);
  });
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
  // Los colores (aj.ui.colores y color_primario) ya se guardaron en vivo desde
  // renderColoresSistema() al elegirlos; no los pisamos acá.
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
    alertas_margen: !!form.elements.alertas_margen?.checked,
    margen_minimo: Number(form.elements.margen_minimo?.value) || 0,
  };

  aj.ui.widgets_visibles = [...form.querySelectorAll('#widgets-toggle input:checked')]
    .map(i => i.dataset.widget);

  // Auto-update + cuenta para gastos habituales
  aj.auto_update = !!form.elements.auto_update?.checked;
  aj.habituales_cuenta_id = form.elements.habituales_cuenta_id?.value || null;
  // catalogos.habituales ya se editó en vivo en renderHabitualesSettings()

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
    document.getElementById('btn-sync')?.classList.add('syncing');
    if (motivo === 'manual') mostrarAnimacionSync(false);
  },
  onProgress: () => {},
  onSuccess: async (result, motivo) => {
    await reloadAll();
    setSyncIndicator('ok');
    actualizarTimestampSync();
    document.getElementById('btn-sync')?.classList.remove('syncing');
    if (motivo === 'manual') mostrarAnimacionSync(true);
    try { await chequeoMargenDisponible(); } catch {}
  },
  onError: (err, motivo) => {
    setSyncIndicator('error');
    document.getElementById('btn-sync')?.classList.remove('syncing');
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
  ultimaSync().then(ts => {
    // Sidebar
    const sbEl = document.getElementById('sb-sync-time');
    // Header inline
    const hdEl = document.getElementById('btn-sync-time-label');
    if (!ts) {
      if (sbEl) sbEl.textContent = '';
      if (hdEl) hdEl.textContent = '';
      return;
    }
    const dt = new Date(ts * 1000);
    const ahora = Date.now();
    const diffMin = Math.round((ahora - ts * 1000) / 60_000);
    let label;
    if (diffMin < 1)       label = 'recién';
    else if (diffMin < 60) label = `${diffMin}m`;
    else if (diffMin < 1440) label = `${Math.round(diffMin/60)}h`;
    else label = dt.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' });
    if (sbEl) sbEl.textContent = label;
    if (hdEl) hdEl.textContent = label;
  });
}

/** Animación de "billete volando" pantalla completa durante el sync. */
function mostrarAnimacionSync(ok = true) {
  const overlay = document.getElementById('flying-money-overlay');
  if (!overlay) return;
  const title = document.getElementById('fmo-title');
  const sub   = document.getElementById('fmo-sub');
  if (title) title.textContent = ok ? '¡Sincronizado!' : 'Sincronizando…';
  if (sub) sub.textContent = ok ? 'Datos actualizados' : 'Contactando GitHub…';

  // Crear billetes animados
  const BILLS = ['💵','💸','🪙','💶','💴'];
  const W = window.innerWidth, H = window.innerHeight;
  overlay.querySelectorAll('.flying-bill').forEach(b => b.remove());
  const count = 7;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'flying-bill';
    el.textContent = BILLS[i % BILLS.length];
    // Punto de origen: área del botón de sync (arriba derecha) o centro
    const ox = W * (.5 + (Math.random()-.5)*.4);
    const oy = H * (.4 + (Math.random()-.5)*.5);
    // Trayectoria parabólica
    const midX = (Math.random() - .5) * 200;
    const midY = -80 - Math.random() * 120;
    const endX = (Math.random() - .5) * 400;
    const endY = (Math.random() > .5 ? -1 : 1) * (200 + Math.random() * 200);
    const rot0 = (Math.random()-.5)*40;
    const rot1 = rot0 + (Math.random()-.5)*120;
    const rot2 = rot1 + (Math.random()-.5)*180;
    el.style.cssText = `
      left:${ox}px; top:${oy}px;
      --bx0:0px; --by0:0px; --br0:${rot0}deg;
      --bx1:${midX}px; --by1:${midY}px; --br1:${rot1}deg;
      --bx2:${endX}px; --by2:${endY}px; --br2:${rot2}deg;
      animation-delay: ${i * 0.12}s;
      font-size: ${1.4 + Math.random()*.8}rem;
    `;
    overlay.appendChild(el);
  }

  overlay.classList.add('show');
  setTimeout(() => {
    overlay.style.animation = 'fmo-out .4s ease forwards';
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.style.animation = '';
    }, 400);
  }, ok ? 2600 : 1800);
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
      debounceMs: 3_000,
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

/* ============ Gastos habituales (contadores con valor fijo) ====== */
/** Devuelve la lista de gastos habituales configurados. */
function getHabituales() {
  return state.ajustes?.catalogos?.habituales || [];
}

/** Cantidad de veces que se registró un habitual en el mes actual. */
function _conteoHabitualMes(habitualId, mes = new Date().toISOString().slice(0,7)) {
  return state.gastos.filter(g => !g.deleted && g.habitual_id === habitualId && (g.fecha||'').startsWith(mes)).length;
}

/** Registra un gasto a partir de un habitual (un "tic" del contador). */
async function registrarGastoHabitual(habitualId) {
  const h = getHabituales().find(x => x.id === habitualId);
  if (!h) return;
  const cuentaId = state.ajustes?.habituales_cuenta_id || null;
  const g = {
    id: uuid(), updated_at: nowTs(), deleted: false,
    fecha: new Date().toISOString().slice(0,10),
    monto: Number(h.valor) || 0,
    moneda: 'ARS',
    descripcion: h.nombre,
    categoria: h.categoria || 'general',
    subcategoria: null,
    metodo_pago: cuentaId ? 'debito' : 'efectivo',
    tipo: 'unico',
    tarjeta_id: null,
    cuenta_id: cuentaId,            // si hay cuenta configurada, se descuenta
    cuotas_total: 1, cuota_numero: 1,
    compartido: null,
    es_amortizacion_anual: false,
    es_habitual: true,
    habitual_id: h.id,
    adjunto_ref: null,
  };
  await DB.put('gastos', g);
  notificarCambioLocal();
  const cuenta = cuentaId ? (state.cuentas || []).find(c => c.id === cuentaId) : null;
  const sufijo = cuenta ? ` · de ${cuenta.nombre}` : '';
  toast(`${h.icono || '✓'} ${h.nombre} +1 · ${FMT.format(g.monto)}${sufijo}`, 1800);
  await reloadAll();
}

/** Deshace el último registro de un habitual en el mes (resta uno). */
async function quitarGastoHabitual(habitualId) {
  const mes = new Date().toISOString().slice(0,7);
  const ultimo = state.gastos
    .filter(g => !g.deleted && g.habitual_id === habitualId && (g.fecha||'').startsWith(mes))
    .sort((a,b) => (b.updated_at||0) - (a.updated_at||0))[0];
  if (!ultimo) { toast('No hay registros este mes', 1500); return; }
  await DB.softDelete('gastos', ultimo.id);
  notificarCambioLocal();
  toast('−1 registro', 1200);
  await reloadAll();
}

/** Renderiza los chips-contador de habituales en la barra de acción rápida. */
function renderQuickHabituales() {
  const cont = document.getElementById('qa-habituales');
  if (!cont) return;
  const habituales = getHabituales();
  cont.innerHTML = habituales.map(h => {
    const n = _conteoHabitualMes(h.id);
    return `<button class="quick-btn quick-habitual" data-habitual="${escapeHtml(h.id)}"
      style="${n>0?`border-color:${h.color};`:''}" title="${escapeHtml(h.nombre)} · ${FMT.format(h.valor||0)} c/u">
      ${escapeHtml(h.icono||'🔁')} ${escapeHtml(h.nombre)}${n>0?`<span class="qa-count" style="background:${h.color}">${n}</span>`:''}
    </button>`;
  }).join('');
  cont.querySelectorAll('[data-habitual]').forEach(btn => {
    btn.onclick = () => registrarGastoHabitual(btn.dataset.habitual);
    // Mantener apretado / click derecho resta uno
    btn.oncontextmenu = (e) => { e.preventDefault(); quitarGastoHabitual(btn.dataset.habitual); };
  });
}

/** Widget de gestión de gastos habituales: conteo del mes + total + +/-. */
function renderWidgetHabituales(el) {
  const box = el.querySelector('[data-bind="habituales-list"]');
  if (!box) return;
  const habituales = getHabituales();
  if (!habituales.length) {
    box.innerHTML = `<div class="flex flex-col items-center py-5 gap-1.5" style="color:var(--ink-muted)">
      <span class="text-2xl opacity-40">🔁</span>
      <p class="text-xs text-center">Sin gastos habituales.<br>Creálos en Ajustes → Catálogos.</p>
    </div>`;
    return;
  }
  const mes = new Date().toISOString().slice(0,7);
  let totalMes = 0;
  box.innerHTML = habituales.map(h => {
    const n = _conteoHabitualMes(h.id, mes);
    const subtotal = n * (Number(h.valor)||0);
    totalMes += subtotal;
    return `
      <div class="habitual-row">
        <span class="habitual-icon" style="background:${h.color}1a;border:1px solid ${h.color}44">${escapeHtml(h.icono||'🔁')}</span>
        <div class="habitual-info">
          <span class="habitual-nombre">${escapeHtml(h.nombre)}</span>
          <span class="habitual-sub">${FMT.format(h.valor||0)} c/u · ${n} este mes</span>
        </div>
        <span class="habitual-subtotal">${FMT.format(subtotal)}</span>
        <div class="habitual-counter">
          <button class="habitual-btn" data-hab-menos="${escapeHtml(h.id)}" title="Quitar uno">−</button>
          <span class="habitual-count">${n}</span>
          <button class="habitual-btn plus" data-hab-mas="${escapeHtml(h.id)}" title="Agregar uno">+</button>
        </div>
      </div>`;
  }).join('') + `
    <div class="habitual-total">
      <span>Total del mes</span><b>${FMT.format(totalMes)}</b>
    </div>`;

  box.querySelectorAll('[data-hab-mas]').forEach(b => b.onclick = (e) => { e.stopPropagation(); registrarGastoHabitual(b.dataset.habMas); });
  box.querySelectorAll('[data-hab-menos]').forEach(b => b.onclick = (e) => { e.stopPropagation(); quitarGastoHabitual(b.dataset.habMenos); });
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

/* ============ VISTAS DEL SIDEBAR (Tarjetas / Cuentas / Metas) ============
   Cuando el usuario clickea en el sidebar, abrimos drawers que muestran
   TODAS las entidades con sus datos. Para crear nuevas, va a Ajustes.    */

function abrirVistaTarjetas() {
  const tarjetas = state.tarjetas.filter(t => !t.deleted && t.activa !== false);
  if (tarjetas.length === 0) {
    toast('No hay tarjetas. Creá una desde Ajustes → Cuentas', 3000);
    abrirSettings();
    setTimeout(() => cambiarSettingsTab('cuentas'), 200);
    return;
  }
  if (tarjetas.length === 1) {
    abrirDrawerTarjeta(tarjetas[0].id);
    return;
  }
  // Si hay varias, mostrar lista y al tocar una se abre el drawer detallado
  abrirSelectorEntidad('tarjetas', tarjetas);
}

function abrirVistaCuentas() {
  const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
  if (cuentas.length === 0) {
    toast('No hay cuentas. Creá una desde Ajustes → Cuentas', 3000);
    abrirSettings();
    setTimeout(() => cambiarSettingsTab('cuentas'), 200);
    return;
  }
  abrirSelectorEntidad('cuentas', cuentas);
}

function abrirVistaMetas() {
  const metas = (state.metas || []).filter(m => !m.deleted);
  if (metas.length === 0) {
    // No hay metas: abrir directamente el diálogo para crear una (antes abría
    // por error la pestaña de Cuentas en Ajustes).
    openDialog('dlg-meta');
    return;
  }
  abrirSelectorEntidad('metas', metas);
}

function abrirSelectorEntidad(tipo, items) {
  // Reusamos el drawer history como contenedor genérico
  const dlg = document.getElementById('dlg-widget-history');
  if (!dlg) return;

  // Customizar header según tipo
  const titulos = { tarjetas: 'Mis tarjetas', cuentas: 'Mis cuentas', metas: 'Mis metas' };
  const iconos  = { tarjetas: '💳', cuentas: '🏦', metas: '🎯' };
  document.getElementById('hd-title').textContent    = titulos[tipo];
  document.getElementById('hd-icon').textContent     = iconos[tipo];
  document.getElementById('hd-subtitle').textContent = `${items.length} ${tipo}`;

  // Ocultar filtros que no aplican
  document.querySelector('.widget-drawer-filters').style.display = 'none';
  const chartWrap = document.getElementById('hd-chart-wrap');
  if (chartWrap) chartWrap.style.display = 'none';

  // KPIs según tipo
  const totEl = document.getElementById('hd-kpi-total');
  const cntEl = document.getElementById('hd-kpi-count');
  const avgEl = document.getElementById('hd-kpi-avg');
  if (tipo === 'tarjetas') {
    const totalLim = items.reduce((a,t) => a + (t.limite_un_pago||0) + (t.limite_cuotas||0), 0);
    const totalRes = items.reduce((a,t) => {
      const r = state.resumenes.find(x => x.tarjeta_id === t.id);
      return a + (r?.total_resumen || 0);
    }, 0);
    totEl.textContent = FMT.format(totalLim);
    cntEl.textContent = String(items.length);
    avgEl.textContent = FMT.format(totalRes);
    cntEl.previousElementSibling.textContent = 'Tarjetas';
    avgEl.previousElementSibling.textContent = 'Resumen total';
    totEl.previousElementSibling.textContent = 'Límite total';
  } else if (tipo === 'cuentas') {
    const totalSaldo = items.reduce((a,c) => a + calcularSaldoCuenta(c), 0);
    totEl.textContent = FMT.format(totalSaldo);
    cntEl.textContent = String(items.length);
    avgEl.textContent = FMT.format(totalSaldo / items.length);
    totEl.previousElementSibling.textContent = 'Saldo total';
    cntEl.previousElementSibling.textContent = 'Cuentas';
    avgEl.previousElementSibling.textContent = 'Promedio';
  } else { // metas
    const totalObj = items.reduce((a,m) => a + (m.monto_objetivo||0), 0);
    const totalAct = items.reduce((a,m) => a + (m.monto_actual||0),   0);
    totEl.textContent = FMT.format(totalObj);
    cntEl.textContent = String(items.length);
    avgEl.textContent = FMT.format(totalAct);
    totEl.previousElementSibling.textContent = 'Objetivo total';
    cntEl.previousElementSibling.textContent = 'Metas';
    avgEl.previousElementSibling.textContent = 'Ahorrado';
  }

  // Lista de items
  const list = document.getElementById('hd-list');
  list.innerHTML = '';
  if (tipo === 'tarjetas') {
    items.forEach(t => {
      const r = state.resumenes.find(x => x.tarjeta_id === t.id);
      const lim = (t.limite_un_pago||0) + (t.limite_cuotas||0);
      const usado = r?.total_resumen || 0;
      const disp = Math.max(0, lim - usado);
      const pct = lim ? Math.round(usado*100/lim) : 0;
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item" data-tarjeta-id="${t.id}" style="cursor:pointer">
          <span class="hd-item-icon" style="background:${t.color}33;color:${t.color}">💳</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold" style="color:var(--ink)">${escapeHtml(t.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">
              ${t.banco || '—'} · Cierre día ${t.dia_cierre} · Pago día ${t.dia_vencimiento}
            </p>
            <div class="mt-1.5 flex items-center gap-2">
              <div style="flex:1;height:4px;background:var(--surface-3);border-radius:999px;overflow:hidden">
                <div style="width:${Math.min(100,pct)}%;height:100%;background:${t.color};box-shadow:0 0 6px ${t.color}"></div>
              </div>
              <span class="text-[10px] font-bold" style="color:${t.color}">${pct}%</span>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[9px] uppercase tracking-widest" style="color:var(--ink-muted)">Disponible</p>
            <p class="ff-display font-bold text-sm" style="color:var(--success)">${FMT.format(disp)}</p>
          </div>
        </div>`);
    });
    list.querySelectorAll('[data-tarjeta-id]').forEach(el =>
      el.addEventListener('click', () => { dlg.close(); abrirDrawerTarjeta(el.dataset.tarjetaId); })
    );
  } else if (tipo === 'cuentas') {
    const TIPOS = { caja_ahorro:'🏦', cuenta_corriente:'💼', billetera:'📱', efectivo:'💵', inversion:'📈', cripto:'₿' };
    items.forEach(c => {
      const saldo = calcularSaldoCuenta(c);
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon" style="background:${c.color}33;color:${c.color}">${TIPOS[c.tipo]||'🏦'}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold" style="color:var(--ink)">${escapeHtml(c.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${escapeHtml(c.banco||c.tipo)} · ${c.moneda||'ARS'}</p>
          </div>
          <span class="hd-item-monto" style="color:${saldo>=0?'var(--success)':'var(--danger)'}">${FMT.format(saldo)}</span>
        </div>`);
    });
  } else { // metas
    items.sort((a,b)=> (b.prioridad||3) - (a.prioridad||3));
    items.forEach(m => {
      const pct = m.monto_objetivo ? (m.monto_actual||0)*100/m.monto_objetivo : 0;
      const p = m.prioridad || 3;
      const estrellas = '★'.repeat(p) + '☆'.repeat(5 - p);
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon" style="background:var(--brand-soft);color:var(--brand)">🎯</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold" style="color:var(--ink)">${escapeHtml(m.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">
              ${estrellas} ${m.es_emergencia ? '· 🚨 Emergencia' : ''}
            </p>
            <div class="mt-1.5 flex items-center gap-2">
              <div style="flex:1;height:4px;background:var(--surface-3);border-radius:999px;overflow:hidden">
                <div style="width:${Math.min(100,pct)}%;height:100%;background:linear-gradient(90deg,var(--success),var(--brand))"></div>
              </div>
              <span class="text-[10px] font-bold text-glow-cyan">${pct.toFixed(0)}%</span>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-[9px] uppercase tracking-widest" style="color:var(--ink-muted)">Faltan</p>
            <p class="ff-display font-bold text-sm" style="color:var(--brand)">${FMT.format(Math.max(0, (m.monto_objetivo||0) - (m.monto_actual||0)))}</p>
          </div>
        </div>`);
    });
  }
  document.getElementById('hd-empty').classList.add('hidden');

  // Footer: cambiar texto del botón principal
  const addBtn = document.getElementById('hd-add');
  if (addBtn) {
    const labelMap = { tarjetas: '+ Agregar tarjeta', cuentas: '+ Agregar cuenta', metas: '+ Agregar meta' };
    addBtn.textContent = labelMap[tipo];
    addBtn.onclick = () => {
      dlg.close();
      abrirSettings();
      setTimeout(() => cambiarSettingsTab('cuentas'), 200);
    };
  }

  dlg.showModal();
}

/* ============ DRAWER DETALLE DE TARJETA ============ */
let _drawerTarjetaIdActual = null;

function abrirDrawerTarjeta(tarjetaId) {
  const dlg = document.getElementById('dlg-tarjeta-detalle');
  if (!dlg) return;

  const tarjeta = state.tarjetas.find(t => t.id === tarjetaId);
  if (!tarjeta) return;

  _drawerTarjetaIdActual = tarjetaId;
  const resumen = state.resumenes.find(r => r.tarjeta_id === tarjetaId);
  const cap     = state.capacidad;
  const capTarjeta = cap?.por_tarjeta?.find(p => p.tarjeta_id === tarjetaId);

  // Header con colores de la tarjeta (mismo gradiente premium)
  const colorBase = tarjeta.color || '#00f0ff';
  const header = document.getElementById('td-header');
  if (header) header.style.background = _gradienteTarjeta(colorBase);

  document.getElementById('td-nombre').textContent = tarjeta.nombre;
  document.getElementById('td-banco').textContent  = tarjeta.banco || tarjeta.tipo || '—';

  // KPIs superiores
  const limTotal = (tarjeta.limite_un_pago || 0) + (tarjeta.limite_cuotas || 0);
  const usado    = resumen?.total_resumen || 0;
  const disponibleTarjeta = Math.max(0, limTotal - usado);
  const pctUso   = limTotal > 0 ? Math.round((usado/limTotal)*100) : 0;

  // El KPI "Disponible" representa lo que REALMENTE podés gastar por mes según
  // tus ingresos (capacidad libre acotada al cupo de la tarjeta), no el cupo
  // bruto del banco. Si todavía no hay capacidad calculada, cae al cupo libre.
  const disponibleSegunIngresos = capTarjeta
    ? Math.max(0, capTarjeta.recomendado_seguro)
    : disponibleTarjeta;

  document.getElementById('td-resumen').textContent    = FMT.format(usado);
  document.getElementById('td-disponible').textContent = FMT.format(disponibleSegunIngresos);
  document.getElementById('td-pct').textContent        = pctUso + '%';

  // Composición del resumen
  document.getElementById('td-comp-unpago').textContent = FMT.format(resumen?.total_un_pago || 0);
  document.getElementById('td-comp-cuotas').textContent = FMT.format(resumen?.total_cuotas || 0);
  document.getElementById('td-comp-recurr').textContent = FMT.format(resumen?.total_recurrentes || 0);

  // ── Sección de gastos en moneda extranjera ────────────────
  renderSeccionUSD(tarjeta, resumen);

  // ── Histórico de cotizaciones de esta tarjeta ─────────────
  renderHistoricoCotizaciones(tarjeta);

  // Capacidad
  if (capTarjeta) {
    const semMap = {
      verde:    { color: 'var(--success)', label: 'Verde',    cls: 'badge-success' },
      amarillo: { color: 'var(--warning)', label: 'Amarillo', cls: 'badge-warning' },
      naranja:  { color: '#fb923c',        label: 'Naranja',  cls: 'badge-warning' },
      rojo:     { color: 'var(--danger)',  label: 'Rojo',     cls: 'badge-danger'  },
    };
    const sem = semMap[cap.semaforo] || semMap.verde;
    const semBadge = document.getElementById('td-semaforo');
    semBadge.className = `badge ${sem.cls}`;
    semBadge.textContent = sem.label;
    document.getElementById('td-capacidad-box').style.borderColor = sem.color;
    document.getElementById('td-recomendado').textContent   = FMT.format(capTarjeta.recomendado_seguro);
    document.getElementById('td-recomendado').style.color   = sem.color;
    document.getElementById('td-disp-tarjeta').textContent  = FMT.format(capTarjeta.disponible_tarjeta);

    // Desglose: cómo se tasó la capacidad (ingreso − gastos habituales → límite financiero)
    const sug = document.getElementById('td-sugerencia');
    sug.innerHTML = `
      <span style="display:flex;flex-wrap:wrap;gap:.15rem .8rem;margin-bottom:.4rem;font-size:.66rem;color:var(--ink-muted)">
        <span>Ingreso <b style="color:var(--success)">${FMT.format(cap.ingreso_mes)}</b></span>
        <span>Gastos habituales <b style="color:var(--ink)">${FMT.format(cap.gastos_habituales)}</b></span>
        <span>Límite financiero <b style="color:var(--brand)">${FMT.format(cap.limite_financiero)}</b></span>
        <span>Cuotas+tarjetas <b style="color:var(--warning)">${FMT.format(cap.compromiso_tarjetas + cap.cuotas_mensuales_proyectadas)}</b></span>
      </span>
      <span style="color:var(--ink-2)">${escapeHtml(cap.sugerencia)}</span>`;
  }

  // Cuotas pendientes
  const cuotasBox = document.getElementById('td-cuotas-pendientes');
  cuotasBox.innerHTML = '';
  const cuotas = capTarjeta?.cuotas_pendientes || [];
  if (cuotas.length === 0) {
    cuotasBox.innerHTML = `<p class="text-xs text-center py-2" style="color:var(--ink-muted)">✓ Sin cuotas pendientes en esta tarjeta</p>`;
  } else {
    cuotas.forEach(c => {
      cuotasBox.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">📦</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(c.descripcion)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">
              Cuota ${c.cuotas_pagadas+1}/${c.cuotas_total} · Pendiente: ${c.cuotas_pendientes} cuotas · Saldo total ${FMT.format(c.saldo_pendiente)}
            </p>
          </div>
          <span class="hd-item-monto" style="color:var(--warning)">${FMT.format(c.monto_cuota)}/mes</span>
        </div>`);
    });
  }

  // Próximos ciclos
  const proxBox = document.getElementById('td-proximos-ciclos');
  proxBox.innerHTML = '';
  const hoy = new Date();
  for (let i = 0; i < 3; i++) {
    const futuro = new Date(hoy.getFullYear(), hoy.getMonth() + i, hoy.getDate());
    const ciclo = fechasCiclo(tarjeta, futuro);
    const fmt = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
    const cuotaMensualTotal = cuotas.reduce((a, c) => {
      const cuotasAFuturo = Math.min(c.cuotas_pendientes, i + 1);
      return cuotasAFuturo > i ? a + c.monto_cuota : a;
    }, 0);
    proxBox.insertAdjacentHTML('beforeend', `
      <div class="hd-item">
        <span class="hd-item-icon">${i === 0 ? '🟢' : i === 1 ? '🟡' : '🔵'}</span>
        <div class="hd-item-info">
          <p class="text-sm font-semibold" style="color:var(--ink)">${ciclo.periodo}</p>
          <p class="text-[10px]" style="color:var(--ink-muted)">
            Cierra ${fmt(ciclo.cierre)} · Vence ${fmt(ciclo.vencimiento)}
          </p>
        </div>
        <span class="hd-item-monto" style="color:var(--brand)">
          ${cuotaMensualTotal > 0 ? '~' + FMT.format(cuotaMensualTotal) : '—'}
        </span>
      </div>`);
  }

  // Reset simulador
  document.getElementById('td-sim-monto').value = '';
  document.getElementById('td-sim-cuotas').value = '1';
  const simRes = document.getElementById('td-sim-result');
  simRes.hidden = true;
  simRes.innerHTML = '';

  // Feature A: ciclos de facturación
  const resumenActual = resumen || {};
  renderCiclosTarjeta(tarjeta, resumenActual);

  // Feature C: plan de pago próximo
  renderPlanPago(tarjeta, resumenActual);

  dlg.showModal();
}

/* Handlers del drawer de tarjeta */
function renderSeccionUSD(tarjeta, resumen) {
  const sec = document.getElementById('td-usd-section');
  if (!sec) return;

  const monedasExtra = resumen?.monedas_extranjeras || {};
  const totalUSD = monedasExtra.USD || 0;

  if (totalUSD <= 0) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;

  // Cotización sugerida (la más reciente de ajustes)
  const cambios = state.ajustes?.tipos_cambio || {};
  const cotizSugerida = cambios.USD_BLUE?.valor || cambios.USD?.valor || 0;

  document.getElementById('td-usd-total').textContent       = 'US$' + totalUSD.toFixed(2);
  document.getElementById('td-usd-cotiz-actual').textContent= FMT.format(cotizSugerida);
  document.getElementById('td-usd-equiv').textContent       = FMT.format(totalUSD * cotizSugerida);

  // Contar pendientes vs cerrados (en este resumen)
  const pendCount = resumen?.pendientes_cierre_usd || 0;
  document.getElementById('td-usd-count').textContent = `${pendCount} pendiente${pendCount !== 1 ? 's' : ''}`;
}

function renderHistoricoCotizaciones(tarjeta) {
  const wrap  = document.getElementById('td-cotiz-history-wrap');
  const cont  = document.getElementById('td-cotiz-history');
  if (!wrap || !cont) return;

  const historico = tarjeta.cotizaciones_historico || [];
  if (historico.length === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  cont.innerHTML = '';

  // Más recientes primero
  [...historico].reverse().slice(0, 6).forEach(h => {
    cont.insertAdjacentHTML('beforeend', `
      <div class="usd-history-card">
        <div>
          <p class="usd-history-period">${h.periodo} · ${h.moneda || 'USD'}</p>
          <p class="text-[10px]" style="color:var(--ink-muted)">${new Date(h.fecha_aplicada).toLocaleDateString('es-AR')}</p>
        </div>
        <span class="usd-history-cotiz">${FMT.format(h.cotizacion)}</span>
      </div>`);
  });
}

/* ── FEATURE A: Ciclos de facturación ─────────────────────────── */
const _CICLO_MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const _ddmm = (iso) => iso ? iso.split('-').reverse().join('/') : '—';

// Inicio del ciclo: día siguiente al cierre del mes anterior.
function _inicioCiclo(cierreISO) {
  if (!cierreISO) return '—';
  const c = new Date(cierreISO + 'T12:00:00');
  const prev = new Date(c);
  prev.setMonth(prev.getMonth() - 1);
  prev.setDate(prev.getDate() + 1);
  return `${String(prev.getDate()).padStart(2,'0')}/${String(prev.getMonth()+1).padStart(2,'0')}`;
}

// Detalle expandible de un ciclo: rango (acotado al cierre), pago (vencimiento)
// y la lista de gastos que caen en ese ciclo de facturación.
function _renderCicloDetalle(resumenMes) {
  const r = resumenMes;
  const ids = new Set(r.movimientos_ids || []);
  const gastos = (state.gastos || [])
    .filter(g => ids.has(g.id) && !g.deleted)
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  const usdNominal = resumenMes.monedas_extranjeras?.USD || 0;
  const usdPendiente = (resumenMes.pendientes_cierre_usd || 0) > 0;

  const filas = gastos.length ? gastos.map(g => {
    const icon = CAT_ICON[g.categoria] || '📌';
    const cuota = g.tipo === 'cuotas' ? ` · cuota ${g.cuota_numero || 1}/${g.cuotas_total}` : '';
    const montoFmt = (g.moneda && g.moneda !== 'ARS')
      ? `${g.moneda} ${(g.monto).toLocaleString('es-AR', { minimumFractionDigits: 2 })}${g.cotizacion_al_pagar ? ` ×$${g.cotizacion_al_pagar}` : ''}`
      : FMT.format(g.monto);
    return `
      <div class="td-ciclo-gasto">
        <span class="td-ciclo-gasto-fecha">${_ddmm(g.fecha)}</span>
        <span class="td-ciclo-gasto-desc">${icon} (${escapeHtml(g.categoria || 'general')}) ${escapeHtml(g.descripcion || '')}${cuota}</span>
        <span class="td-ciclo-gasto-monto">${montoFmt}</span>
      </div>`;
  }).join('') : `<p class="td-ciclo-empty">Sin gastos en este ciclo.</p>`;

  return `
    <div class="td-ciclo-detalle-inner">
      <div class="td-ciclo-rango">
        📆 Consumos del <b>${_inicioCiclo(r.fecha_cierre)}</b> al <b>${_ddmm(r.fecha_cierre)}</b> (cierre)
        · 💸 se paga el <b>${_ddmm(r.fecha_vencimiento)}</b> (vencimiento)
      </div>
      <div class="td-ciclo-gastos">${filas}</div>
      ${usdNominal > 0 ? `
      <div class="td-ciclo-usd">
        💵 Saldo en USD: <b>US$ ${usdNominal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}</b>
        ${usdPendiente ? '<span style="color:var(--warning)"> · cotización pendiente (se fija al pagar)</span>' : '<span style="color:var(--success)"> · cotización aplicada ✓</span>'}
      </div>` : ''}
      <div class="td-ciclo-totales">
        <span>Un pago <b>${FMT.format(r.total_un_pago || 0)}</b></span>
        <span>Cuotas <b>${FMT.format(r.total_cuotas || 0)}</b></span>
        <span>Recurrentes <b>${FMT.format(r.total_recurrentes || 0)}</b></span>
        <span class="td-ciclo-total-final">Total <b>${FMT.format(r.total_resumen || 0)}</b></span>
      </div>
    </div>`;
}

function renderCiclosTarjeta(tarjeta, resumenActual) {
  const cont = document.getElementById('td-ciclos-lista');
  if (!cont) return;

  const pagados = new Set(tarjeta.ciclos_pagados || []);
  const hoy = new Date();
  const ciclos = [];

  for (let i = -5; i <= 1; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const resumenMes = resumenTarjeta(tarjeta, state.gastos, d);
    const periodo = resumenMes.periodo;
    ciclos.push({
      periodo, resumenMes,
      esPagado: pagados.has(periodo),
      esFuturo: d > new Date(hoy.getFullYear(), hoy.getMonth(), 1),
      esActual: periodo === resumenActual.periodo,
    });
  }
  ciclos.reverse(); // más reciente primero

  cont.innerHTML = ciclos.map((c, idx) => {
    const [y, m] = c.periodo.split('-');
    const label = `${_CICLO_MESES[parseInt(m, 10) - 1]} ${y}`;
    // Estado del ciclo via lógica centralizada (abierto / cerrado_pendiente / vencido / pagado)
    const ec = estadoCiclo({
      fechaCierre: c.resumenMes.fecha_cierre,
      fechaVencimiento: c.resumenMes.fecha_vencimiento,
      pagado: c.esPagado,
      hoy,
    });
    // Para meses futuros (el ciclo todavía no empezó) mostramos "PRÓXIMO"
    const estado = (c.esFuturo && ec.estado === 'abierto') ? 'proximo' : ec.estado;
    const colorMap = { pagado: 'var(--success)', cerrado_pendiente: 'var(--warning)', vencido: 'var(--danger)', abierto: 'var(--brand)', proximo: 'var(--ink-muted)' };
    const badgeMap = { pagado: '✓ PAGADO', cerrado_pendiente: '⏳ CERRADO', vencido: '⚠ VENCIDO', abierto: '🟢 ABIERTO', proximo: '📅 PRÓXIMO' };
    // Días restantes para el evento relevante
    const restante = estado === 'abierto'
      ? (ec.diasParaCierre >= 0 ? `cierra en ${ec.diasParaCierre} día${ec.diasParaCierre === 1 ? '' : 's'}` : '')
      : (estado === 'cerrado_pendiente' && ec.diasParaVencimiento >= 0 ? `vence en ${ec.diasParaVencimiento} día${ec.diasParaVencimiento === 1 ? '' : 's'}` : '');
    const total = c.resumenMes.total_resumen;
    const actualBadge = c.esActual ? '<span style="color:var(--brand);font-size:.6rem;margin-left:.25rem">● actual</span>' : '';
    const nGastos = (c.resumenMes.movimientos_ids || []).length;

    return `
      <div class="td-ciclo-wrap" data-idx="${idx}">
        <div class="td-ciclo-row td-ciclo-clickable" data-idx="${idx}" role="button" tabindex="0">
          <span class="td-ciclo-caret">▸</span>
          <div class="td-ciclo-info">
            <span class="td-ciclo-mes">${label}${actualBadge}</span>
            <span class="td-ciclo-venc">Cierra ${_ddmm(c.resumenMes.fecha_cierre)} · Vence ${_ddmm(c.resumenMes.fecha_vencimiento)}${restante ? ` · ${restante}` : ''} · ${nGastos} gasto${nGastos === 1 ? '' : 's'}</span>
          </div>
          <div class="td-ciclo-monto">${FMT.format(total)}</div>
          <div class="td-ciclo-badge" style="color:${colorMap[estado]}">${badgeMap[estado]}</div>
          ${c.esFuturo ? '' : c.esPagado
            ? `<button class="td-ciclo-pendiente btn-secondary text-xs" data-periodo="${c.periodo}" data-tarjeta="${tarjeta.id}" style="border-color:var(--warning);color:var(--warning)">↺ Pendiente</button>`
            : `<button class="td-ciclo-pagar btn-secondary text-xs" data-periodo="${c.periodo}" data-tarjeta="${tarjeta.id}" data-total="${total}" style="border-color:var(--success);color:var(--success)">✓ Pagar</button>`}
        </div>
        <div class="td-ciclo-detalle" data-idx="${idx}" hidden></div>
      </div>`;
  }).join('');

  // Expandir/colapsar detalle al hacer click en la fila
  const toggle = (idx) => {
    const det = cont.querySelector(`.td-ciclo-detalle[data-idx="${idx}"]`);
    const row = cont.querySelector(`.td-ciclo-row[data-idx="${idx}"]`);
    const caret = row?.querySelector('.td-ciclo-caret');
    if (!det) return;
    if (det.hidden) {
      det.innerHTML = _renderCicloDetalle(ciclos[idx].resumenMes);
      det.hidden = false;
      if (caret) caret.textContent = '▾';
      row?.classList.add('expanded');
    } else {
      det.hidden = true;
      if (caret) caret.textContent = '▸';
      row?.classList.remove('expanded');
    }
  };

  cont.querySelectorAll('.td-ciclo-clickable').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.td-ciclo-pagar, .td-ciclo-pendiente')) return; // los botones no expanden
      toggle(parseInt(row.dataset.idx, 10));
    });
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(parseInt(row.dataset.idx, 10)); }
    });
  });

  // Botón "Pagar" → abre el diálogo de pago (con opción de descontar de cuenta)
  cont.querySelectorAll('.td-ciclo-pagar').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      abrirPagoCiclo(btn.dataset.tarjeta, btn.dataset.periodo, parseFloat(btn.dataset.total) || 0);
    });
  });

  // Botón "Pendiente" → revierte el estado pagado
  cont.querySelectorAll('.td-ciclo-pendiente').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      marcarCicloPendiente(btn.dataset.tarjeta, btn.dataset.periodo);
    });
  });
}

/* ── Editor masivo de cierres y vencimientos ──────────────────── */
let _editorCiclosTarjetaId = null;

/** 'YYYY-MM-DD' del día `dia` (acotado al último día del mes) en Y-M. */
function _ajustarDiaISO(Y, M, dia) {
  const ultimo = new Date(Y, M, 0).getDate();
  const dd = Math.min(Math.max(1, dia), ultimo);
  return `${Y}-${String(M).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Cierre/vencimiento que daría el "día fijo" para un período YYYY-MM. */
function _defaultCierreVenc(diaCierre, diaVenc, periodo) {
  const [Y, M] = periodo.split('-').map(Number);
  const cierre = _ajustarDiaISO(Y, M, diaCierre);
  let venc;
  if (diaVenc > diaCierre) {
    venc = _ajustarDiaISO(Y, M, diaVenc);
  } else {
    const y2 = M === 12 ? Y + 1 : Y, m2 = M === 12 ? 1 : M + 1;
    venc = _ajustarDiaISO(y2, m2, diaVenc);
  }
  return { cierre, venc };
}

/** 'YYYY-MM-DD' un mes antes (para el inicio del ciclo más viejo de la lista). */
function _unMesAntesISO(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function abrirEditorCiclos(tarjetaId) {
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  _editorCiclosTarjetaId = tarjetaId;

  document.getElementById('edc-subtitulo').textContent = t.nombre;
  document.getElementById('edc-dia-cierre').value = t.dia_cierre || '';
  document.getElementById('edc-dia-venc').value = t.dia_vencimiento || '';

  // Ciclos de -5 a +3 meses (cubre lo que se ve en la lista + próximos)
  const hoy = new Date();
  const vistos = new Set();
  const filas = [];
  for (let i = -5; i <= 3; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const rm = resumenTarjeta(t, state.gastos, d);
    if (!rm.periodo || vistos.has(rm.periodo)) continue;
    vistos.add(rm.periodo);
    filas.push({ periodo: rm.periodo, cierre: rm.fecha_cierre, venc: rm.fecha_vencimiento });
  }
  filas.sort((a, b) => b.periodo.localeCompare(a.periodo)); // más reciente primero

  const cont = document.getElementById('edc-lista');
  cont.innerHTML = filas.map(f => {
    const [y, m] = f.periodo.split('-');
    const label = `${_CICLO_MESES[parseInt(m, 10) - 1]} ${y}`;
    return `
      <div class="edc-row" data-periodo="${f.periodo}">
        <span class="edc-row-mes">${label}</span>
        <label class="edc-row-field"><span>Cierre</span>
          <input type="date" class="input edc-cierre" value="${f.cierre || ''}"></label>
        <label class="edc-row-field"><span>Vence</span>
          <input type="date" class="input edc-venc" value="${f.venc || ''}"></label>
      </div>`;
  }).join('');

  document.getElementById('dlg-editar-ciclos').showModal();
}

async function guardarEditorCiclos() {
  try {
    const t = state.tarjetas.find(x => x.id === _editorCiclosTarjetaId);
    if (!t) return;

    const diaCierre = parseInt(document.getElementById('edc-dia-cierre').value, 10);
    const diaVenc   = parseInt(document.getElementById('edc-dia-venc').value, 10);
    if (diaCierre >= 1 && diaCierre <= 31) t.dia_cierre = diaCierre;
    if (diaVenc   >= 1 && diaVenc   <= 31) t.dia_vencimiento = diaVenc;

    // Filas en orden ascendente por período
    const rows = [...document.querySelectorAll('#edc-lista .edc-row')]
      .map(row => ({
        periodo: row.dataset.periodo,
        cierre:  row.querySelector('.edc-cierre').value,
        venc:    row.querySelector('.edc-venc').value,
      }))
      .filter(r => r.cierre)
      .sort((a, b) => a.periodo.localeCompare(b.periodo));

    // Validaciones
    for (const r of rows) {
      if (r.venc && r.venc <= r.cierre) {
        toast(`El vencimiento de ${r.periodo} debe ser posterior al cierre`, 3000); return;
      }
    }

    // Conservar ciclos custom fuera del rango editado
    const editados = new Set(rows.map(r => r.periodo));
    const custom = (t.ciclos_custom || []).filter(c => !editados.has(c.periodo));

    // Guardar siempre las fechas explícitas que el usuario tocó en el rango visible.
    // A diferencia de antes, NO comparamos con el día fijo: si el usuario abrió el
    // editor y guardó, las fechas quedan como ciclo custom para que no cambien al
    // modificar el día fijo más adelante.
    let prevCierre = null;
    for (const r of rows) {
      const inicio = prevCierre ? _diaSiguiente(prevCierre) : _diaSiguiente(_unMesAntesISO(r.cierre));
      custom.push({ periodo: r.periodo, inicio, fin: r.cierre, vencimiento: r.venc || null });
      prevCierre = r.cierre;
    }

    t.ciclos_custom = custom;
    t.updated_at = nowTs();
    await DB.put('tarjetas', t);

    document.getElementById('dlg-editar-ciclos').close();
    toast('✓ Fechas de los ciclos actualizadas');
    await reloadAll();
    abrirDrawerTarjeta(_editorCiclosTarjetaId);
  } catch (err) {
    console.error('[edc] Error al guardar:', err);
    toast('Error al guardar fechas: ' + (err?.message || String(err)), 4000);
  }
}

// Wiring del editor de ciclos
document.addEventListener('click', (e) => {
  if (e.target.closest('#td-editar-ciclos')) {
    if (_drawerTarjetaIdActual) abrirEditorCiclos(_drawerTarjetaIdActual);
  } else if (e.target.closest('#edc-guardar')) {
    guardarEditorCiclos();
  } else if (e.target.closest('#edc-cancelar') || e.target.closest('#edc-close-x')) {
    document.getElementById('dlg-editar-ciclos')?.close();
  }
});

/* ── Pago de ciclo de tarjeta (con descuento de cuenta) ────────── */
let _pagoCicloCtx = null;

function abrirPagoCiclo(tarjetaId, periodo, total) {
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  const [y, m] = periodo.split('-');
  const mesLabel = `${_CICLO_MESES[parseInt(m, 10) - 1]} ${y}`;
  document.getElementById('pc-subtitulo').textContent = `${t.nombre} · ${mesLabel}`;

  // Computar el resumen de ESE ciclo para separar pesos vs USD
  const resumenMes = resumenTarjeta(t, state.gastos, new Date(parseInt(y), parseInt(m) - 1, 1));
  const usdNominal = resumenMes.monedas_extranjeras?.USD || 0;
  const usdArs     = resumenMes.monedas_extranjeras_ars?.USD || 0;
  const arsConsumos = Math.max(0, (resumenMes.total_resumen || 0) - usdArs); // parte pura en pesos

  _pagoCicloCtx = { tarjetaId, periodo, arsConsumos, usdNominal };

  const usdWrap = document.getElementById('pc-usd-wrap');
  const cotizInp = document.getElementById('pc-usd-cotiz');
  const montoInp = document.getElementById('pc-monto');
  const detalle  = document.getElementById('pc-total-detalle');

  if (usdNominal > 0) {
    usdWrap.hidden = false;
    document.getElementById('pc-usd-saldo').textContent = `US$ ${usdNominal.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`;
    // Cotización sugerida: dólar tarjeta > blue > oficial
    const cam = state.ajustes?.tipos_cambio || {};
    const cotizSug = cam.USD_TARJETA?.valor || cam.USD_BLUE?.valor || cam.USD?.valor || 0;
    cotizInp.value = cotizSug ? Math.round(cotizSug) : '';
    const recompute = () => {
      const cz = parseFloat(cotizInp.value) || 0;
      const totalUsdArs = usdNominal * cz;
      const totalPagar = arsConsumos + totalUsdArs;
      montoInp.value = Math.round(totalPagar) || '';
      document.getElementById('pc-usd-equiv').textContent = cz > 0
        ? `US$ ${usdNominal.toFixed(2)} × $${cz} = ${FMT.format(totalUsdArs)}`
        : 'Ingresá la cotización para calcular el total en pesos';
      detalle.textContent = `Consumos en pesos ${FMT.format(arsConsumos)} + USD ${FMT.format(totalUsdArs)}`;
    };
    cotizInp.oninput = recompute;
    recompute();
  } else {
    usdWrap.hidden = true;
    montoInp.value = Math.round(total) || '';
    detalle.textContent = '';
  }

  // Poblar cuentas
  const sel = document.getElementById('pc-cuenta');
  const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
  sel.innerHTML = `<option value="">— No descontar (solo marcar pagado) —</option>` +
    cuentas.map(c => `<option value="${c.id}">${escapeHtml(c.nombre)} · saldo ${FMT.format(calcularSaldoCuenta(c))}</option>`).join('');

  document.getElementById('dlg-pago-ciclo')?.showModal();
}

async function confirmarPagoCiclo() {
  if (!_pagoCicloCtx) return;
  const { tarjetaId, periodo, usdNominal } = _pagoCicloCtx;
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  const cuentaId = document.getElementById('pc-cuenta')?.value || '';
  const monto = parseFloat(document.getElementById('pc-monto')?.value) || 0;
  const cotizUSD = parseFloat(document.getElementById('pc-usd-cotiz')?.value) || 0;

  // Si el ciclo tiene consumos en USD, fijamos la cotización al pagar en todos
  // los gastos USD del período. Así el resumen los convierte a pesos con ESA
  // cotización y el análisis de gasto por tarjeta queda exacto.
  let usdAplicados = 0;
  if (usdNominal > 0 && cotizUSD > 0) {
    const [py, pm] = periodo.split('-').map(Number);
    for (const g of state.gastos) {
      if (g.deleted || g.tarjeta_id !== tarjetaId) continue;
      if (!g.moneda || g.moneda === 'ARS') continue;
      if (!cuotaEnPeriodo(g.fecha, t, py, pm)) continue;
      g.cotizacion_al_pagar = cotizUSD;
      g.updated_at = nowTs();
      await DB.put('gastos', g);
      usdAplicados++;
    }
    // Histórico de cotizaciones de la tarjeta
    if (!t.cotizaciones_historico) t.cotizaciones_historico = [];
    t.cotizaciones_historico.push({
      periodo, moneda: 'USD', cotizacion: cotizUSD,
      fecha_aplicada: new Date().toISOString(), gastos_aplicados: usdAplicados, total_moneda: usdNominal,
    });
  }

  if (!t.ciclos_pagados) t.ciclos_pagados = [];
  if (!t.ciclos_pagados.includes(periodo)) t.ciclos_pagados.push(periodo);
  if (!t.ciclos_pagos) t.ciclos_pagos = {};

  if (cuentaId && monto > 0) {
    // Registrar el pago como movimiento que descuenta de la cuenta.
    // es_pago_tarjeta lo excluye del análisis de gasto por categoría (no es un
    // consumo nuevo, es la liquidación de la deuda ya registrada en la tarjeta).
    const [y, m] = periodo.split('-');
    const mesLabel = `${_CICLO_MESES[parseInt(m, 10) - 1]} ${y}`;
    const g = {
      id: uuid(),
      fecha: new Date().toISOString().slice(0, 10),
      monto, moneda: 'ARS',
      descripcion: `Pago ${t.nombre} · ${mesLabel}`,
      categoria: 'Pago tarjeta',
      metodo_pago: 'transferencia',
      tipo: 'unico',
      cuenta_id: cuentaId,
      tarjeta_id: null,
      es_pago_tarjeta: true,
      updated_at: Math.floor(Date.now() / 1000),
    };
    await DB.put('gastos', g);
    t.ciclos_pagos[periodo] = { cuenta_id: cuentaId, gasto_id: g.id, monto, fecha: g.fecha, cotiz_usd: cotizUSD || null };
  } else {
    t.ciclos_pagos[periodo] = { cuenta_id: null, monto, fecha: new Date().toISOString().slice(0, 10), cotiz_usd: cotizUSD || null };
  }

  await DB.put('tarjetas', t);
  notificarCambioLocal();
  document.getElementById('dlg-pago-ciclo')?.close();
  toast(`✓ Pago registrado${cuentaId ? ' y descontado de la cuenta' : ''}${usdAplicados ? ` · USD a $${cotizUSD}` : ''}`);
  await reloadAll();
  abrirDrawerTarjeta(tarjetaId);
}

async function marcarCicloPendiente(tarjetaId, periodo) {
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t) return;
  t.ciclos_pagados = (t.ciclos_pagados || []).filter(p => p !== periodo);
  const info = t.ciclos_pagos?.[periodo];
  if (info?.gasto_id) {
    if (confirm('Este ciclo tenía un pago descontado de una cuenta.\n\n¿Eliminar también ese movimiento para revertir el descuento del saldo?')) {
      await DB.softDelete('gastos', info.gasto_id);
    }
  }
  if (t.ciclos_pagos) delete t.ciclos_pagos[periodo];
  await DB.put('tarjetas', t);
  notificarCambioLocal();
  toast(`${periodo} marcado como pendiente`);
  await reloadAll();
  abrirDrawerTarjeta(tarjetaId);
}

/* ── FEATURE C: Plan de pago ──────────────────────────────────── */
function renderPlanPago(tarjeta, resumen) {
  const cont = document.getElementById('td-plan-pago');
  if (!cont) return;

  const hoy = new Date();
  const venc = resumen.fecha_vencimiento ? new Date(resumen.fecha_vencimiento + 'T12:00:00') : null;
  const diasAlVenc = venc ? Math.ceil((venc - hoy) / 86400000) : null;

  const proximoIngreso = (state.ingresos || [])
    .filter(i => !i.deleted && i.fecha)
    .map(i => ({ ...i, fechaD: new Date(i.fecha + 'T12:00:00') }))
    .filter(i => i.fechaD >= hoy)
    .sort((a, b) => a.fechaD - b.fechaD)[0];

  const total = resumen.total_resumen || 0;
  const urgente = diasAlVenc !== null && diasAlVenc <= 5;
  const colorUrg = urgente ? 'var(--danger)' : diasAlVenc !== null && diasAlVenc <= 15 ? 'var(--warning)' : 'var(--success)';

  let ingresoHtml = '';
  if (proximoIngreso) {
    const montoIngreso = (proximoIngreso.sueldo_neto || 0) + (proximoIngreso.bonos || 0);
    const llegaAntes = venc && proximoIngreso.fechaD <= venc;
    const llegaDespues = venc && proximoIngreso.fechaD > venc;
    ingresoHtml = `
      <div style="border-top:1px solid var(--border);margin-top:.5rem;padding-top:.5rem">
        <div class="flex justify-between items-center">
          <span class="text-xs" style="color:var(--ink-muted)">🤑 Próximo ingreso</span>
          <span class="text-xs font-semibold" style="color:var(--success)">${proximoIngreso.fecha} · ${FMT.format(montoIngreso)}</span>
        </div>
        ${llegaAntes ? '<p class="text-[10px] mt-1" style="color:var(--success)">✓ Ingreso llega antes del vencimiento</p>' : ''}
        ${llegaDespues ? '<p class="text-[10px] mt-1" style="color:var(--danger)">⚠ Ingreso llega DESPUÉS del vencimiento</p>' : ''}
      </div>`;
  } else {
    ingresoHtml = `<p class="text-[10px] mt-2" style="color:var(--ink-muted)">Sin ingresos próximos cargados. Cargá un recibo de sueldo.</p>`;
  }

  cont.innerHTML = `
    <div style="background:var(--surface-2);border-radius:12px;padding:1rem;border:1px solid var(--border)">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs" style="color:var(--ink-muted)">Total a pagar</span>
        <span class="ff-display font-bold" style="color:${urgente ? 'var(--danger)' : 'var(--ink)'}">${FMT.format(total)}</span>
      </div>
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs" style="color:var(--ink-muted)">Fecha de vencimiento</span>
        <span class="text-sm font-semibold" style="color:${colorUrg}">${resumen.fecha_vencimiento || '—'}${diasAlVenc !== null ? ' (' + diasAlVenc + 'd)' : ''}</span>
      </div>
      ${ingresoHtml}
    </div>`;
}

/* ── FEATURE B: Vista tarjetas mobile ────────────────────────── */
function renderTarjetasMobile() {
  const lista = document.getElementById('tm-lista');
  if (!lista) return;

  const tarjetas = (state.tarjetas || []).filter(t => !t.deleted && t.activa !== false);
  if (!tarjetas.length) {
    lista.innerHTML = `<p class="text-sm text-center py-8" style="color:var(--ink-muted)">Sin tarjetas. Tocá "+ Nueva".</p>`;
    const btnNuevaVacio = document.getElementById('btn-nueva-tarjeta-m');
    if (btnNuevaVacio) btnNuevaVacio.onclick = () => openDialog('dlg-tarjeta');
    return;
  }

  lista.innerHTML = tarjetas.map(t => {
    const r = resumenTarjeta(t, state.gastos);
    const pct = t.limite_un_pago ? Math.min(100, Math.round((r.total_resumen / t.limite_un_pago) * 100)) : 0;
    const colorBase = t.color || '#6366f1';
    const bgStyle = `background:${_gradienteTarjeta(colorBase)};`;
    const fmtCorto = (iso) => {
      if (!iso) return '—';
      const d = new Date(iso + 'T12:00:00');
      const mn = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      return `${d.getDate()}/${mn[d.getMonth()]}`;
    };
    return `<div>
      <div class="credit-card" style="${bgStyle}cursor:pointer" data-tm-detalle="${t.id}">
        <div class="flex items-start justify-between mb-2 relative z-10">
          <div>
            <p class="font-semibold text-white text-base leading-tight">${escapeHtml(t.nombre)}</p>
            ${t.banco ? `<p class="text-white/60 text-xs mt-0.5">${escapeHtml(t.banco)}</p>` : ''}
          </div>
          <span class="badge text-white/85" style="background:rgba(255,255,255,0.18);border:none;font-size:.6rem">Cierra en ${r.dias_para_cierre}d</span>
        </div>
        <p class="ff-display font-bold text-white text-2xl mb-2 relative z-10" style="text-shadow:0 2px 8px rgba(0,0,0,0.3)">${FMT.format(r.total_resumen)}</p>
        <div class="relative z-10 mb-2">
          <div class="bar" style="background:rgba(255,255,255,.18)">
            <span style="width:${pct}%;background:rgba(255,255,255,.85);box-shadow:none"></span>
          </div>
          <p class="text-white/60 text-[10px] mt-1">${pct}% del límite · vence ${fmtCorto(r.fecha_vencimiento)}</p>
        </div>
      </div>
      <div class="flex gap-2 mt-2">
        <button class="btn-primary flex-1 text-xs" data-tm-add="${t.id}">+ Agregar gasto</button>
        <button class="btn-secondary flex-1 text-xs" data-tm-detalle="${t.id}">Ver detalle</button>
      </div>
    </div>`;
  }).join('');

  lista.querySelectorAll('[data-tm-add]').forEach(btn => {
    btn.onclick = () => openDialog('dlg-gasto', { metodo_pago: 'credito', tarjeta_id: btn.dataset.tmAdd });
  });
  lista.querySelectorAll('[data-tm-detalle]').forEach(btn => {
    btn.onclick = () => abrirDrawerTarjeta(btn.dataset.tmDetalle);
  });

  const btnNueva = document.getElementById('btn-nueva-tarjeta-m');
  if (btnNueva) btnNueva.onclick = () => openDialog('dlg-tarjeta');
}

/** Vista de metas (tab Metas): lista todas las metas con botón agregar. */
function renderMetasMobile() {
  const lista = document.getElementById('mm-lista');
  if (!lista) return;
  const metas = (state.metas || []).filter(m => !m.deleted)
    .sort((a,b) => (b.prioridad||3) - (a.prioridad||3));

  const btnNueva = document.getElementById('btn-nueva-meta-m');
  if (btnNueva) btnNueva.onclick = () => openDialog('dlg-meta');

  if (!metas.length) {
    lista.innerHTML = `
      <div class="flex flex-col items-center py-12 gap-3" style="color:var(--ink-muted)">
        <span class="text-4xl opacity-40">🎯</span>
        <p class="text-sm text-center">Todavía no tenés metas.<br>Creá una para empezar a ahorrar.</p>
        <button class="btn-primary text-sm" id="mm-empty-add">+ Crear meta</button>
      </div>`;
    lista.querySelector('#mm-empty-add')?.addEventListener('click', () => openDialog('dlg-meta'));
    return;
  }

  const margen    = Math.max(0, state.estado?.margen_libre_mes || 0);
  const pesos     = metas.map(m => (m.prioridad || 3));
  const sumaPesos = pesos.reduce((a,b)=>a+b,0) || 1;

  lista.innerHTML = metas.map((m, i) => {
    const pct      = Math.min(100, Math.round((100*(m.monto_actual||0))/(m.monto_objetivo||1)));
    const sugerido = margen * (pesos[i] / sumaPesos);
    const icon     = m.es_emergencia ? '🛡️' : '🎯';
    const completa = pct >= 100;
    return `
      <div class="meta-card-m card-glass rounded-2xl p-4" data-meta-id="${m.id}" style="cursor:pointer">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-lg flex-shrink-0">${icon}</span>
            <p class="font-semibold text-sm truncate">${escapeHtml(m.nombre)}</p>
          </div>
          <span class="ff-display font-bold text-sm" style="color:${completa?'var(--success)':'var(--brand-3)'}">${pct}%</span>
        </div>
        <div class="bar mb-2"><span style="width:${pct}%;${completa?'background:var(--success)':''}"></span></div>
        <div class="flex justify-between items-center text-[11px]" style="color:var(--ink-2)">
          <span>${FMT.format(m.monto_actual||0)} <span style="color:var(--ink-muted)">/ ${FMT.format(m.monto_objetivo||0)}</span></span>
          ${m.fecha_objetivo ? `<span style="color:var(--ink-muted)">📅 ${m.fecha_objetivo}</span>` : ''}
          ${!completa ? `<span>Aportar <b style="color:var(--brand-3)">${FMT.format(sugerido)}</b>/mes</span>` : `<span style="color:var(--success)">✓ Completada</span>`}
        </div>
      </div>`;
  }).join('');

  // Click en una meta → editarla
  lista.querySelectorAll('[data-meta-id]').forEach(card => {
    card.addEventListener('click', async () => {
      const m = await DB.get('metas', card.dataset.metaId);
      if (!m) return;
      openDialog('dlg-meta', {
        _editing_id: m.id, nombre: m.nombre,
        monto_objetivo: m.monto_objetivo, monto_actual: m.monto_actual,
        fecha_objetivo: m.fecha_objetivo || '', prioridad: m.prioridad || 3,
      });
    });
  });
}

async function cerrarPeriodoUSD(tarjetaId) {
  const tarjeta = state.tarjetas.find(t => t.id === tarjetaId);
  if (!tarjeta) return;

  // Intentar refrescar cotizaciones live antes de pedirla
  try { await actualizarCotizacionesAuto(true); } catch {}

  const cambios = state.ajustes?.tipos_cambio || {};
  // Para tarjetas, usar el "dólar tarjeta" (oficial + impuestos) que es lo
  // que efectivamente cobran los bancos. Fallback: blue, después oficial.
  const cotizSugerida = cambios.USD_TARJETA?.valor
                     || cambios.USD_BLUE?.valor
                     || cambios.USD?.valor
                     || 0;
  const fuente = cambios.USD_TARJETA?.valor ? 'tarjeta (oficial + impuestos)'
              : cambios.USD_BLUE?.valor ? 'blue' : 'oficial';

  const cotizStr = prompt(
    `Ingresá la cotización USD de hoy para cerrar el período de "${tarjeta.nombre}".\n\n` +
    `Sugerencia live (${fuente}): $${cotizSugerida.toFixed(2)}`,
    cotizSugerida || ''
  );
  if (cotizStr === null) return;
  const cotiz = parseFloat(cotizStr);
  if (!cotiz || cotiz <= 0) {
    toast('Cotización inválida', 2000);
    return;
  }

  // Buscar el resumen actual de esta tarjeta para saber qué gastos son
  const resumen = state.resumenes.find(r => r.tarjeta_id === tarjetaId);
  if (!resumen) { toast('No hay resumen activo', 2000); return; }

  // Aplicar la cotización a TODOS los gastos USD/extranjeros pendientes del período actual
  const py = parseInt(resumen.periodo.slice(0, 4));
  const pm = parseInt(resumen.periodo.slice(5, 7));
  const { cuotaEnPeriodo: _cep } = await import('./cards.js');

  let aplicados = 0;
  let totalUSD = 0;
  for (const g of state.gastos) {
    if (g.deleted || g.tarjeta_id !== tarjetaId) continue;
    if (!g.moneda || g.moneda === 'ARS') continue;
    if (g.cotizacion_al_pagar) continue;  // ya cerrado
    if (!_cep(g.fecha, tarjeta, py, pm)) continue;
    g.cotizacion_al_pagar = cotiz;
    g.updated_at = nowTs();
    await DB.put('gastos', g);
    aplicados++;
    totalUSD += g.monto;
  }

  // Agregar al histórico de cotizaciones de la tarjeta
  if (!tarjeta.cotizaciones_historico) tarjeta.cotizaciones_historico = [];
  tarjeta.cotizaciones_historico.push({
    periodo: resumen.periodo,
    moneda: 'USD',
    cotizacion: cotiz,
    fecha_aplicada: new Date().toISOString(),
    gastos_aplicados: aplicados,
    total_moneda: totalUSD,
    total_ars: totalUSD * cotiz,
  });
  tarjeta.updated_at = nowTs();
  await DB.put('tarjetas', tarjeta);
  notificarCambioLocal();

  await reloadAll();
  toast(`✓ Período cerrado: ${aplicados} gastos USD a $${cotiz.toFixed(2)}`, 3000);
  // Re-abrir el drawer con datos refrescados
  abrirDrawerTarjeta(tarjetaId);
}

function bindDrawerTarjetaHandlers() {
  const dlg = document.getElementById('dlg-tarjeta-detalle');
  if (!dlg) return;

  document.getElementById('td-close')?.addEventListener('click',  () => dlg.close());
  document.getElementById('td-close-2')?.addEventListener('click', () => dlg.close());

  // Cerrar período USD con cotización
  document.getElementById('td-close-period')?.addEventListener('click', () => {
    if (_drawerTarjetaIdActual) cerrarPeriodoUSD(_drawerTarjetaIdActual);
  });

  document.getElementById('td-add-gasto')?.addEventListener('click', () => {
    if (!_drawerTarjetaIdActual) return;
    dlg.close();
    openDialog('dlg-gasto');
    // Pre-seleccionar la tarjeta + método crédito
    setTimeout(() => {
      const form = document.querySelector('#dlg-gasto form');
      if (!form) return;
      const radioCredito = form.querySelector('input[name="metodo_pago"][value="credito"]');
      if (radioCredito) {
        radioCredito.checked = true;
        radioCredito.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Esperar a que aparezca el row-tarjeta
      setTimeout(() => {
        const sel = form.querySelector('select[name="tarjeta_id_simple"]');
        if (sel) { sel.value = _drawerTarjetaIdActual; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        if (typeof actualizarCicloInfo === 'function') actualizarCicloInfo();
      }, 150);
    }, 100);
  });

  document.getElementById('td-sim-go')?.addEventListener('click', () => {
    if (!_drawerTarjetaIdActual) return;
    const monto  = parseFloat(document.getElementById('td-sim-monto').value) || 0;
    const cuotas = Math.max(1, parseInt(document.getElementById('td-sim-cuotas').value) || 1);
    if (monto <= 0) { toast('Ingresá un monto válido'); return; }

    const sim = simularCompra({
      monto, cuotas,
      tarjeta_id: _drawerTarjetaIdActual,
      capacidad: state.capacidad,
    });

    const simRes = document.getElementById('td-sim-result');
    simRes.hidden = false;
    const color = sim.permitido
      ? (sim.advertencias.length === 0 ? 'var(--success)' : 'var(--warning)')
      : 'var(--danger)';
    simRes.innerHTML = `
      <div class="mt-3 p-3 rounded-xl" style="background:${color}1a;border:1px solid ${color}">
        <p class="text-sm font-semibold mb-1" style="color:${color}">${escapeHtml(sim.mensaje)}</p>
        <div class="grid grid-cols-2 gap-2 mt-2 text-xs">
          <div>
            <p style="color:var(--ink-muted)">Cuota mensual</p>
            <p class="ff-display font-bold" style="color:var(--ink)">${FMT.format(sim.nueva_cuota_mensual)}</p>
          </div>
          <div>
            <p style="color:var(--ink-muted)">Nuevo % comprometido</p>
            <p class="ff-display font-bold" style="color:${color}">${Math.round(sim.nuevo_ratio*100)}%</p>
          </div>
        </div>
        ${sim.advertencias.length > 0 ? `
          <div class="mt-2 space-y-1">
            ${sim.advertencias.map(a => `<p class="text-[11px]" style="color:${color}">• ${escapeHtml(a)}</p>`).join('')}
          </div>` : ''}
      </div>`;
  });
}

/* ============ HISTORIAL POR WIDGET (drawer) ============ */

const WIDGET_META = {
  estado_global:      { icon: '💰', titulo: 'Estado global',          filtra: 'todos' },
  sueldo:             { icon: '💼', titulo: 'Sueldo y aguinaldo',      filtra: 'todos' },
  cuentas:            { icon: '🏦', titulo: 'Cuentas bancarias',      filtra: 'todos' },
  tarjetas:           { icon: '💳', titulo: 'Tarjetas de crédito',    filtra: 'tarjeta' },
  simulacion_credito: { icon: '📊', titulo: 'Capacidad crediticia',   filtra: 'tarjeta' },
  prediccion:         { icon: '🔮', titulo: 'Predicción de gasto',     filtra: 'todos' },
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
        : `${it.fecha}${tarj ? ' · 💳 ' + escapeHtml(tarj.nombre) : ''}`;
      const desc = it._tipo === 'gasto' && it.categoria
        ? `(${escapeHtml(it.categoria)}) - ${escapeHtml(it.descripcion || 'Movimiento')}`
        : escapeHtml(it.descripcion || 'Movimiento');
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">${icon}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${desc}</p>
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
      notificarCambioLocal();
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
  const c = _resolverColoresChart();

  const gradG = ctx.createLinearGradient(0, 0, 0, 160);
  gradG.addColorStop(0, _hexAlpha(c.danger, 0.35));
  gradG.addColorStop(1, _hexAlpha(c.danger, 0.02));

  const gradI = ctx.createLinearGradient(0, 0, 0, 160);
  gradI.addColorStop(0, _hexAlpha(c.success, 0.35));
  gradI.addColorStop(1, _hexAlpha(c.success, 0.02));

  // Decidir tipo de chart según selector
  const modo = _hdState.chartMode || 'lineas';

  // Respetar el filtro de tipo (Todos / Ingresos / Gastos)
  const filtroTipo = _hdState.tipo || 'todos';
  const showGastos   = filtroTipo === 'todos' || filtroTipo === 'gastos';
  const showIngresos = filtroTipo === 'todos' || filtroTipo === 'ingresos';

  let datasets = [];
  if (modo === 'lineas') {
    if (showGastos) {
      datasets.push({ label: 'Gastos', data: datG, borderColor: c.danger, backgroundColor: gradG, fill: true, tension: .3, pointRadius: 0, borderWidth: 1.5, order: 2 });
    }
    if (showIngresos) {
      datasets.push({ label: 'Ingresos', data: datI, borderColor: c.success, backgroundColor: gradI, fill: true, tension: .3, pointRadius: 0, borderWidth: 1.5, order: 1 });
    }
    // Media móvil solo si mostramos gastos
    if (showGastos) {
      datasets.push({ label: 'Media móvil (7d)', data: datMA, borderColor: _hexAlpha(c.brand, 0.6), borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: .3, order: 0 });
    }
  } else if (modo === 'acumulado') {
    const gradA = ctx.createLinearGradient(0, 0, 0, 160);
    gradA.addColorStop(0, _hexAlpha(c.brand, 0.4));
    gradA.addColorStop(1, _hexAlpha(c.brand, 0.02));
    // Si filtro = solo gastos → acumulado de gastos. Si solo ingresos → acumulado de ingresos. Sino → saldo neto.
    let datSerie, color, gradient, label;
    if (showGastos && !showIngresos) {
      let acum = 0;
      datSerie = datG.map(v => { acum += v; return acum; });
      color = c.danger;
      gradient = ctx.createLinearGradient(0,0,0,160);
      gradient.addColorStop(0,_hexAlpha(c.danger,0.4)); gradient.addColorStop(1,_hexAlpha(c.danger,0.02));
      label = 'Gastos acumulados';
    } else if (showIngresos && !showGastos) {
      let acum = 0;
      datSerie = datI.map(v => { acum += v; return acum; });
      color = c.success;
      gradient = ctx.createLinearGradient(0,0,0,160);
      gradient.addColorStop(0,_hexAlpha(c.success,0.4)); gradient.addColorStop(1,_hexAlpha(c.success,0.02));
      label = 'Ingresos acumulados';
    } else {
      datSerie = datAcum;
      color = c.brand;
      gradient = gradA;
      label = 'Saldo acumulado';
    }
    datasets = [
      { label, data: datSerie, borderColor: color, backgroundColor: gradient, fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
    ];
  } else { // barras
    if (showGastos)   datasets.push({ label: 'Gastos',   data: datG, backgroundColor: _hexAlpha(c.danger, 0.6), borderRadius: 4, borderSkipped: false });
    if (showIngresos) datasets.push({ label: 'Ingresos', data: datI, backgroundColor: _hexAlpha(c.success, 0.6),  borderRadius: 4, borderSkipped: false });
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
            color: c.inkMuted, boxWidth: 10, boxHeight: 10, padding: 8,
            font: { size: 10, family: "'Inter', sans-serif" },
          },
        },
        tooltip: {
          backgroundColor: c.tooltipBg,
          borderColor: _hexAlpha(c.brand, 0.5),
          borderWidth: 1,
          titleColor: c.inkMuted, bodyColor: c.ink,
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
            color: c.inkMuted,
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
          grid: { color: c.grid },
          ticks: {
            color: c.inkMuted, font: { size: 9 },
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

/* ============================================================
   RENDERERS ESPECÍFICOS POR WIDGET
   Cada renderer recibe (dlg) y configura header/KPIs/chart/lista
   según el tipo de dato del widget. Si no hay renderer custom,
   el código cae al flujo genérico (movimientos filtrados).
   ============================================================ */

function _hdSetKPIs(items) {
  // items: [{ label, value, color }] hasta 3
  const labels = ['hd-kpi-total', 'hd-kpi-count', 'hd-kpi-avg'];
  for (let i = 0; i < labels.length; i++) {
    const el = document.getElementById(labels[i]);
    if (!el) continue;
    const lblEl = el.previousElementSibling;
    const it = items[i];
    if (it) {
      el.textContent = it.value;
      el.style.color = it.color || 'var(--ink)';
      if (lblEl) lblEl.textContent = it.label;
    } else {
      el.textContent = '—';
      el.style.color = 'var(--ink-muted)';
      if (lblEl) lblEl.textContent = '';
    }
  }
}

// Chart.js no resuelve CSS variables — hay que pasarle colores hex/rgba reales.
// Leemos las CSS vars del :root al momento del render para que respete el tema activo.
function _resolverColoresChart() {
  const root = getComputedStyle(document.documentElement);
  const get = (k, fallback) => (root.getPropertyValue(k) || '').trim() || fallback;
  const esClaro = document.documentElement.classList.contains('light');
  return {
    ink:        get('--ink',        esClaro ? '#0f172a' : '#e8f5ff'),
    inkMuted:   get('--ink-muted',  esClaro ? '#64748b' : '#94a3b8'),
    grid:       'rgba(127,127,127,.18)',
    // Colores semánticos (siguen el acento custom y el tema)
    success:    get('--success',    esClaro ? '#059669' : '#00ff9f'),
    danger:     get('--danger',     esClaro ? '#dc2626' : '#ff2d6e'),
    brand:      get('--brand',      esClaro ? '#4f46e5' : '#00f0ff'),
    brand2:     get('--brand-2',    esClaro ? '#ec4899' : '#ff00ea'),
    warning:    get('--warning',    esClaro ? '#d97706' : '#ffb800'),
    tooltipBg:  esClaro ? 'rgba(255,255,255,0.96)' : 'rgba(13,16,33,0.96)',
  };
}

// Familias de color semántico que usan los renderers de widget (RGB de los
// defaults oscuros). Mapean a la clave resuelta de _resolverColoresChart().
const _HD_COLOR_FAMILIAS = [
  { rgb: [0, 255, 159],  key: 'success' },
  { rgb: [255, 45, 110], key: 'danger'  },
  { rgb: [0, 240, 255],  key: 'brand'   },
  { rgb: [181, 55, 255], key: 'brand2'  },
  { rgb: [122, 155, 194], key: 'inkMuted' },
];

/** Parsea '#rgb', '#rrggbb', 'rgb(...)' o 'rgba(...)' a {r,g,b,a} o null. */
function _parseColor(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16), a: 1 }; }
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16), a: 1 }; }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Devuelve la clave semántica si el color coincide con una familia conocida. */
function _familiaDeColor(str) {
  const p = _parseColor(str);
  if (!p) return null;
  for (const f of _HD_COLOR_FAMILIAS) {
    if (Math.abs(p.r - f.rgb[0]) <= 6 && Math.abs(p.g - f.rgb[1]) <= 6 && Math.abs(p.b - f.rgb[2]) <= 6) {
      return { key: f.key, alpha: p.a };
    }
  }
  return null;
}

/** Reemplaza border/backgroundColor estáticos por el color resuelto del tema. */
function _hdNormalizarColores(ds, c) {
  const remap = (val) => {
    if (typeof val !== 'string') return val;       // gradientes/funciones: dejar
    const fam = _familiaDeColor(val);
    if (!fam) return val;
    const base = c[fam.key];
    if (!base) return val;
    return fam.alpha < 1 ? _hexAlpha(base, fam.alpha) : base;
  };
  if ('borderColor' in ds)     ds.borderColor     = remap(ds.borderColor);
  if ('backgroundColor' in ds) ds.backgroundColor = remap(ds.backgroundColor);
  if ('pointBackgroundColor' in ds) ds.pointBackgroundColor = remap(ds.pointBackgroundColor);
  return ds;
}

function _hdRenderChartCustom({ labels, datasets }) {
  const canvas = document.getElementById('hd-chart');
  if (!canvas) return;
  if (_hdState.chart) { try { _hdState.chart.destroy(); } catch {} }
  const statsEl = document.getElementById('hd-chart-stats');
  if (statsEl) statsEl.innerHTML = '';
  const ctx = canvas.getContext('2d');
  const c = _resolverColoresChart();
  // Remapear los colores semánticos estáticos que usan los renderers a los
  // colores resueltos del tema/acento actual (border + relleno con alpha).
  const datasetsNorm = datasets.map(ds => _hdNormalizarColores({ ...ds }, c));
  _hdState.chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: datasetsNorm },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1, labels: { color: c.ink, boxWidth: 10 } } },
      scales: {
        x: { ticks: { color: c.inkMuted, font: { size: 11 } }, grid: { display: false }, border: { color: c.grid } },
        y: { ticks: { color: c.inkMuted, font: { size: 11 }, callback: (v) => Math.abs(v)>=1000 ? (v/1000).toFixed(0)+'k' : v }, grid: { color: c.grid }, border: { display: false } },
      },
    },
  });
}

function _hdSetEmpty(msg) {
  const list  = document.getElementById('hd-list');
  const empty = document.getElementById('hd-empty');
  if (list)  list.innerHTML = '';
  if (empty) {
    empty.classList.remove('hidden');
    const txt = empty.querySelector('p') || empty;
    txt.textContent = msg;
  }
}

const _widgetRenderers = {

  // ── SUELDO: lista de recibos (ingresos) + evolución del neto ────
  sueldo: () => {
    const items = (state.ingresos || []).filter(i => !i.deleted).sort((a,b) => (b.fecha||'').localeCompare(a.fecha||''));
    const totalNeto = items.reduce((a,i) => a + ((i.sueldo_neto||0) + (i.bonos||0)), 0);
    const promedio  = items.length ? totalNeto / items.length : 0;
    _hdSetKPIs([
      { label: 'Total acumulado', value: FMT.format(totalNeto), color: 'var(--success)' },
      { label: 'Recibos',         value: String(items.length) },
      { label: 'Promedio',        value: FMT.format(promedio) },
    ]);
    // Chart: evolución del neto por recibo
    const sorted = [...items].reverse();
    const labels = sorted.map(i => i.periodo_aplicacion || i.fecha || '');
    const data   = sorted.map(i => Math.round((i.sueldo_neto||0) + (i.bonos||0)));
    _hdRenderChartCustom({
      labels,
      datasets: [{
        label: 'Neto cobrado', data, borderColor: '#00ff9f',
        backgroundColor: 'rgba(0,255,159,.15)', tension: .3, fill: true,
      }],
    });
    // Lista
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!items.length) return _hdSetEmpty('No hay recibos cargados todavía');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const i of items) {
      const neto = (i.sueldo_neto||0) + (i.bonos||0);
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">💼</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(i.descripcion || 'Sueldo')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${i.fecha || '—'} · período ${i.periodo_aplicacion || '—'}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--success)">+${FMT.format(neto)}</span>
        </div>`);
    }
  },

  // ── CUENTAS: lista de cuentas con saldo y gráfico de saldos ─────
  cuentas: () => {
    const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
    const saldoCuenta = (c) => {
      const ingresoCuenta = (state.ingresos || []).filter(i => !i.deleted && i.cuenta_id === c.id).reduce((a,i) => a + ((i.sueldo_neto||0)+(i.bonos||0)), 0);
      const gastoCuenta   = (state.gastos   || []).filter(g => !g.deleted && g.cuenta_id === c.id).reduce((a,g) => a + (g.monto||0), 0);
      return (c.saldo_inicial || 0) + ingresoCuenta - gastoCuenta;
    };
    const saldoTotal = cuentas.reduce((a,c) => a + saldoCuenta(c), 0);
    _hdSetKPIs([
      { label: 'Saldo total', value: FMT.format(saldoTotal), color: saldoTotal>=0?'var(--success)':'var(--danger)' },
      { label: 'Cuentas',     value: String(cuentas.length) },
      { label: 'Promedio',    value: FMT.format(cuentas.length ? saldoTotal/cuentas.length : 0) },
    ]);
    _hdRenderChartCustom({
      labels: cuentas.map(c => c.nombre || 'Cuenta'),
      datasets: [{
        label: 'Saldo', data: cuentas.map(c => Math.round(saldoCuenta(c))),
        borderColor: '#00f0ff', backgroundColor: 'rgba(0,240,255,.2)',
        tension: 0, fill: true,
      }],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!cuentas.length) return _hdSetEmpty('No tenés cuentas configuradas');
    document.getElementById('hd-empty').classList.add('hidden');
    const TIPOS = { ahorro:'🏦', sueldo:'💼', conjunta:'👥', inversion:'📈', cripto:'₿' };
    for (const c of cuentas) {
      const s = saldoCuenta(c);
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon" style="background:${c.color||'#3b82f6'}33;color:${c.color||'#3b82f6'}">${TIPOS[c.tipo]||'🏦'}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(c.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${c.tipo||'cuenta'} · inicial ${FMT.format(c.saldo_inicial||0)}</p>
          </div>
          <span class="hd-item-monto" style="color:${s>=0?'var(--success)':'var(--danger)'}">${FMT.format(s)}</span>
        </div>`);
    }
  },

  // ── TARJETAS: consumos por tarjeta + chart por tarjeta ──────────
  tarjetas: () => {
    const tarjetas = (state.tarjetas || []).filter(t => !t.deleted && t.activa !== false);
    const consumoPorTarjeta = (t) =>
      (state.gastos || []).filter(g => !g.deleted && g.tarjeta_id === t.id).reduce((a,g) => a + (g.monto||0), 0);
    const totalConsumido = tarjetas.reduce((a,t) => a + consumoPorTarjeta(t), 0);
    const totalLimite    = tarjetas.reduce((a,t) => a + (t.limite_credito || 0), 0);
    _hdSetKPIs([
      { label: 'Total consumido', value: FMT.format(totalConsumido), color: 'var(--danger)' },
      { label: 'Tarjetas',        value: String(tarjetas.length) },
      { label: 'Límite total',    value: FMT.format(totalLimite), color: 'var(--brand)' },
    ]);
    _hdRenderChartCustom({
      labels: tarjetas.map(t => t.nombre || 'Tarjeta'),
      datasets: [
        { label: 'Consumido', data: tarjetas.map(t => Math.round(consumoPorTarjeta(t))),
          borderColor: '#ff2d6e', backgroundColor: 'rgba(255,45,110,.2)', tension: 0, fill: true },
        { label: 'Límite',    data: tarjetas.map(t => Math.round(t.limite_credito||0)),
          borderColor: '#00f0ff', backgroundColor: 'rgba(0,240,255,.05)', tension: 0, fill: false, borderDash:[5,5] },
      ],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!tarjetas.length) return _hdSetEmpty('No tenés tarjetas configuradas');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const t of tarjetas) {
      const cons = consumoPorTarjeta(t);
      const pct  = t.limite_credito ? Math.round((cons / t.limite_credito) * 100) : 0;
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon" style="background:${t.color||'#3b82f6'}33;color:${t.color||'#3b82f6'}">💳</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(t.nombre)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${pct}% usado · cierre día ${t.dia_cierre || '—'}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--danger)">${FMT.format(cons)}</span>
        </div>`);
    }
  },

  // ── METAS: progreso de cada meta ────────────────────────────────
  metas: () => {
    const metas = (state.metas || []).filter(m => !m.deleted);
    const totalObjetivo = metas.reduce((a,m) => a + (m.monto_objetivo || 0), 0);
    const totalAhorrado = metas.reduce((a,m) => a + (m.monto_actual || 0), 0);
    const pctGlobal     = totalObjetivo ? Math.round((totalAhorrado / totalObjetivo) * 100) : 0;
    _hdSetKPIs([
      { label: 'Ahorrado',  value: FMT.format(totalAhorrado), color: 'var(--success)' },
      { label: 'Objetivo',  value: FMT.format(totalObjetivo), color: 'var(--brand)' },
      { label: 'Progreso',  value: `${pctGlobal}%`,           color: 'var(--success)' },
    ]);
    _hdRenderChartCustom({
      labels: metas.map(m => m.nombre || 'Meta'),
      datasets: [
        { label: 'Ahorrado', data: metas.map(m => Math.round(m.monto_actual||0)),
          borderColor: '#00ff9f', backgroundColor: 'rgba(0,255,159,.25)', tension: 0, fill: true },
        { label: 'Objetivo', data: metas.map(m => Math.round(m.monto_objetivo||0)),
          borderColor: '#b537ff', backgroundColor: 'rgba(181,55,255,.05)', tension: 0, fill: false, borderDash:[5,5] },
      ],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!metas.length) return _hdSetEmpty('No tenés metas cargadas');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const m of metas) {
      const pct = m.monto_objetivo ? Math.min(100, Math.round((m.monto_actual||0)/m.monto_objetivo*100)) : 0;
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">🎯</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(m.nombre || 'Meta')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${FMT.format(m.monto_actual||0)} / ${FMT.format(m.monto_objetivo||0)} · prioridad ${m.prioridad||'—'}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--success)">${pct}%</span>
        </div>`);
    }
  },

  // ── CATEGORIAS: top categorías del período ──────────────────────
  categorias: () => {
    const ahora = new Date();
    const desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const gastos = (state.gastos || []).filter(g => !g.deleted && g.fecha && new Date(g.fecha+'T12:00:00') >= desde);
    const porCat = new Map();
    for (const g of gastos) {
      const k = g.categoria || 'general';
      porCat.set(k, (porCat.get(k) || 0) + (g.monto || 0));
    }
    const sorted = [...porCat.entries()].sort((a,b) => b[1] - a[1]);
    const total = sorted.reduce((a,[,v]) => a + v, 0);
    _hdSetKPIs([
      { label: 'Total mes',  value: FMT.format(total), color: 'var(--danger)' },
      { label: 'Categorías', value: String(sorted.length) },
      { label: 'Top cat',    value: sorted[0] ? sorted[0][0] : '—' },
    ]);
    _hdRenderChartCustom({
      labels: sorted.slice(0, 10).map(([k]) => k),
      datasets: [{
        label: 'Gastado este mes', data: sorted.slice(0, 10).map(([,v]) => Math.round(v)),
        borderColor: '#ff2d6e', backgroundColor: 'rgba(255,45,110,.2)', tension: 0, fill: true,
      }],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!sorted.length) return _hdSetEmpty('No hay gastos este mes');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const [cat, monto] of sorted) {
      const pct = total ? Math.round((monto/total)*100) : 0;
      const icon = CAT_ICON_HD[cat] || '📌';
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">${icon}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(cat)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${pct}% del total</p>
          </div>
          <span class="hd-item-monto" style="color:var(--danger)">${FMT.format(monto)}</span>
        </div>`);
    }
  },

  // ── TIPO DE CAMBIO: cotizaciones actuales + última actualización ─
  tipo_cambio: () => {
    const cot = state.ajustes?.tipos_cambio || {};
    const filas = Object.entries(cot).map(([key, c]) => ({
      moneda: key,
      nombre: c.nombre || key,
      simbolo: c.simbolo || '',
      compra: Number(c.compra || c.valor || 0),
      venta:  Number(c.venta  || c.valor || 0),
      manual: !!c.manual,
      fecha_api: c.fecha_api,
    })).filter(f => f.venta > 0 || f.compra > 0);

    const usd = filas.find(f => f.moneda === 'USD');
    const eur = filas.find(f => f.moneda === 'EUR');
    _hdSetKPIs([
      { label: 'USD venta', value: usd ? FMT.format(usd.venta) : '—', color: 'var(--success)' },
      { label: 'EUR venta', value: eur ? FMT.format(eur.venta) : '—', color: 'var(--brand)' },
      { label: 'Monedas',   value: String(filas.length) },
    ]);
    _hdRenderChartCustom({
      labels: filas.map(f => f.moneda),
      datasets: [
        { label: 'Compra', data: filas.map(f => f.compra),
          borderColor: '#00f0ff', backgroundColor: 'rgba(0,240,255,.15)', tension: 0, fill: true },
        { label: 'Venta',  data: filas.map(f => f.venta),
          borderColor: '#ff2d6e', backgroundColor: 'rgba(255,45,110,.15)', tension: 0, fill: true },
      ],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!filas.length) return _hdSetEmpty('Sin cotizaciones cargadas. Tocá el botón de actualizar en el widget.');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const f of filas) {
      const spread = f.compra ? (((f.venta - f.compra) / f.compra) * 100).toFixed(1) : '0';
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">💱</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(f.nombre)} (${f.moneda})${f.manual ? ' ✏' : ''}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">compra ${FMT.format(f.compra)} · spread ${spread}%${f.fecha_api ? ' · ' + new Date(f.fecha_api).toLocaleDateString('es-AR') : ''}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--danger)">${FMT.format(f.venta)}</span>
        </div>`);
    }
  },

  // ── IA LOCAL: diagnósticos detectados ───────────────────────────
  ia_local: () => {
    const diag = state.diagnosticos || [];
    const altas = diag.filter(d => d.nivel === 'alto' || d.severidad === 'alta').length;
    _hdSetKPIs([
      { label: 'Alertas',   value: String(diag.length) },
      { label: 'Críticas',  value: String(altas), color: 'var(--danger)' },
      { label: 'Sensibilidad', value: state.ajustes?.sensibilidad_ia || 'moderado' },
    ]);
    // Chart: alertas por categoría
    const porCat = new Map();
    for (const d of diag) {
      const k = d.categoria || d.tipo || 'general';
      porCat.set(k, (porCat.get(k) || 0) + 1);
    }
    const arr = [...porCat.entries()];
    _hdRenderChartCustom({
      labels: arr.map(([k]) => k),
      datasets: [{
        label: 'Alertas por tipo', data: arr.map(([,v]) => v),
        borderColor: '#b537ff', backgroundColor: 'rgba(181,55,255,.2)', tension: 0, fill: true,
      }],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!diag.length) return _hdSetEmpty('Sin alertas. La IA no detectó patrones inusuales.');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const d of diag) {
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">🧠</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(d.titulo || d.mensaje || 'Alerta IA')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${escapeHtml(d.descripcion || d.detalle || '')}</p>
          </div>
          <span class="hd-item-monto" style="color:${d.nivel === 'alto' ? 'var(--danger)' : 'var(--warning)'}">${escapeHtml(d.nivel || 'info')}</span>
        </div>`);
    }
  },

  // ── SIMULACIÓN CRÉDITO: capacidad de endeudamiento ──────────────
  simulacion_credito: () => {
    // Usar la capacidad ya calculada (gastos habituales + límite financiero por ingresos)
    const cap = state.capacidad || {};
    const limiteFinanciero = cap.limite_financiero || 0;
    const cuotasActuales   = cap.cuotas_mensuales_proyectadas || 0;
    const compromisoTarj   = cap.compromiso_tarjetas || 0;
    const disponible       = cap.capacidad_libre || 0;
    const usado            = cuotasActuales + compromisoTarj;
    const pctUsado = limiteFinanciero ? Math.round((usado / limiteFinanciero) * 100) : 0;
    _hdSetKPIs([
      { label: 'Disponible',      value: FMT.format(disponible), color: disponible>0?'var(--success)':'var(--danger)' },
      { label: 'Límite financ.',  value: FMT.format(limiteFinanciero), color: 'var(--brand)' },
      { label: 'Usado',           value: `${pctUsado}%`, color: pctUsado>70?'var(--danger)':'var(--warning)' },
    ]);
    _hdRenderChartCustom({
      labels: ['Ingreso', 'Gastos habituales', 'Límite financiero', 'Compromiso', 'Disponible'],
      datasets: [{
        label: 'Capacidad crediticia',
        data: [
          Math.round(cap.ingreso_mes || 0),
          Math.round(cap.gastos_habituales || 0),
          Math.round(limiteFinanciero),
          Math.round(usado),
          Math.max(0, Math.round(disponible)),
        ],
        borderColor: '#00f0ff', backgroundColor: 'rgba(0,240,255,.25)', tension: 0, fill: true,
      }],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    const cuotas = (state.gastos || []).filter(g => !g.deleted && g.tipo === 'cuotas');
    if (!cuotas.length) return _hdSetEmpty('No tenés cuotas activas. Tu capacidad está libre.');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const g of cuotas) {
      const cuota = (g.monto||0) / (g.cuotas_total || 1);
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">💳</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">(${escapeHtml(g.categoria || 'general')}) - ${escapeHtml(g.descripcion || 'Cuota')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${g.cuotas_total} cuotas de ${FMT.format(cuota)} · total ${FMT.format(g.monto||0)}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--warning)">${FMT.format(cuota)}/mes</span>
        </div>`);
    }
  },

  // ── PREDICCIÓN: proyección del mes en curso ─────────────────────
  prediccion: () => {
    const ahora = new Date();
    const desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const hasta = new Date(ahora.getFullYear(), ahora.getMonth()+1, 0);
    const gastosMes = (state.gastos || []).filter(g => !g.deleted && g.fecha && new Date(g.fecha+'T12:00:00') >= desde && new Date(g.fecha+'T12:00:00') <= hasta);
    const totalParcial = gastosMes.reduce((a,g) => a + (g.monto||0), 0);
    const diasTranscurridos = Math.max(1, ahora.getDate());
    const diasTotales       = hasta.getDate();
    const proyeccion = (totalParcial / diasTranscurridos) * diasTotales;
    const ritmo      = totalParcial / diasTranscurridos;
    _hdSetKPIs([
      { label: 'Gasto al cierre', value: FMT.format(proyeccion), color: 'var(--danger)' },
      { label: 'Parcial al día',  value: FMT.format(totalParcial), color: 'var(--warning)' },
      { label: 'Ritmo diario',    value: FMT.format(ritmo) },
    ]);
    // Chart: gasto acumulado real + proyección lineal
    const acumulado = [];
    let acum = 0;
    for (let d = 1; d <= diasTotales; d++) {
      const isoDia = `${ahora.getFullYear()}-${String(ahora.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const delDia = gastosMes.filter(g => g.fecha === isoDia).reduce((a,g) => a + (g.monto||0), 0);
      acum += delDia;
      acumulado.push(d <= diasTranscurridos ? Math.round(acum) : null);
    }
    const proyArr = Array(diasTotales).fill(null).map((_, i) => Math.round(((i+1) / diasTotales) * proyeccion));
    _hdRenderChartCustom({
      labels: Array(diasTotales).fill(0).map((_, i) => String(i+1)),
      datasets: [
        { label: 'Real',       data: acumulado, borderColor: '#ff2d6e', backgroundColor: 'rgba(255,45,110,.2)', tension: .3, fill: true },
        { label: 'Proyectado', data: proyArr,   borderColor: '#b537ff', backgroundColor: 'transparent', borderDash:[5,5], tension: .3, fill: false },
      ],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!gastosMes.length) return _hdSetEmpty('Sin gastos este mes para proyectar');
    document.getElementById('hd-empty').classList.add('hidden');
    // Ordenar por fecha desc y mostrar los del mes
    gastosMes.sort((a,b) => (b.fecha||'').localeCompare(a.fecha||''));
    for (const g of gastosMes.slice(0, 30)) {
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">${CAT_ICON_HD[g.categoria]||'📌'}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">(${escapeHtml(g.categoria||'general')}) - ${escapeHtml(g.descripcion||'Gasto')}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">${g.fecha}</p>
          </div>
          <span class="hd-item-monto" style="color:var(--danger)">${FMT.format(g.monto||0)}</span>
        </div>`);
    }
  },

  // ── CALCULADORA: info de uso (no tiene historial transaccional) ─
  calculadora: () => {
    _hdSetKPIs([
      { label: 'Tipo',      value: 'Herramienta' },
      { label: 'Operación', value: 'Conversión' },
      { label: 'Estado',    value: 'Activa', color: 'var(--success)' },
    ]);
    _hdRenderChartCustom({ labels: [], datasets: [] });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    document.getElementById('hd-empty').classList.add('hidden');
    list.innerHTML = `
      <div class="hd-item"><div class="hd-item-info">
        <p class="text-sm font-semibold" style="color:var(--ink)">¿Cómo usar la calculadora?</p>
        <p class="text-[10px]" style="color:var(--ink-muted)">Ingresá un monto en cualquier moneda (ARS/USD/EUR/BRL) y obtené la conversión automática usando las cotizaciones actuales.</p>
      </div></div>
      <div class="hd-item"><div class="hd-item-info">
        <p class="text-sm font-semibold" style="color:var(--ink)">Fuente de cotizaciones</p>
        <p class="text-[10px]" style="color:var(--ink-muted)">Usa los valores del widget Tipo de cambio. Refrescá ese widget para actualizar.</p>
      </div></div>`;
  },

  // ── COMPARADOR: este mes vs anterior ────────────────────────────
  comparador: () => {
    const ahora = new Date();
    const esteMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    const findMes = new Date(ahora.getFullYear(), ahora.getMonth()+1, 0);
    const antMes  = new Date(ahora.getFullYear(), ahora.getMonth()-1, 1);
    const antFin  = new Date(ahora.getFullYear(), ahora.getMonth(), 0);

    const gastosEnRango = (from, to) => (state.gastos || []).filter(g => !g.deleted && g.fecha && new Date(g.fecha+'T12:00:00') >= from && new Date(g.fecha+'T12:00:00') <= to);
    const ge = gastosEnRango(esteMes, findMes).reduce((a,g) => a + (g.monto||0), 0);
    const ga = gastosEnRango(antMes, antFin).reduce((a,g) => a + (g.monto||0), 0);
    const delta = ge - ga;
    const pct = ga ? Math.round((delta/ga)*100) : 0;
    _hdSetKPIs([
      { label: 'Este mes',  value: FMT.format(ge), color: 'var(--danger)' },
      { label: 'Anterior',  value: FMT.format(ga) },
      { label: 'Variación', value: `${pct>=0?'+':''}${pct}%`, color: pct>=0?'var(--danger)':'var(--success)' },
    ]);
    // Por categoría comparado
    const catSet = new Set();
    const porCat = (gastos) => {
      const m = new Map();
      for (const g of gastos) {
        const k = g.categoria || 'general';
        m.set(k, (m.get(k)||0) + (g.monto||0));
        catSet.add(k);
      }
      return m;
    };
    const eM = porCat(gastosEnRango(esteMes, findMes));
    const aM = porCat(gastosEnRango(antMes, antFin));
    const cats = [...catSet];
    _hdRenderChartCustom({
      labels: cats,
      datasets: [
        { label: 'Mes anterior', data: cats.map(c => Math.round(aM.get(c)||0)),
          borderColor: '#7a9bc2', backgroundColor: 'rgba(122,155,194,.2)', tension: 0, fill: true },
        { label: 'Este mes',     data: cats.map(c => Math.round(eM.get(c)||0)),
          borderColor: '#ff2d6e', backgroundColor: 'rgba(255,45,110,.2)', tension: 0, fill: true },
      ],
    });
    const list = document.getElementById('hd-list');
    list.innerHTML = '';
    if (!cats.length) return _hdSetEmpty('No hay datos para comparar todavía');
    document.getElementById('hd-empty').classList.add('hidden');
    for (const c of cats.sort((a,b) => (eM.get(b)||0) - (eM.get(a)||0))) {
      const ev = eM.get(c)||0; const av = aM.get(c)||0;
      const dlt = ev - av;
      const icon = CAT_ICON_HD[c] || '📌';
      list.insertAdjacentHTML('beforeend', `
        <div class="hd-item">
          <span class="hd-item-icon">${icon}</span>
          <div class="hd-item-info">
            <p class="text-sm font-semibold truncate" style="color:var(--ink)">${escapeHtml(c)}</p>
            <p class="text-[10px]" style="color:var(--ink-muted)">ant ${FMT.format(av)} → ahora ${FMT.format(ev)}</p>
          </div>
          <span class="hd-item-monto" style="color:${dlt>=0?'var(--danger)':'var(--success)'}">${dlt>=0?'+':''}${FMT.format(dlt)}</span>
        </div>`);
    }
  },
};

function abrirHistorialWidget(widgetId) {
  const dlg = document.getElementById('dlg-widget-history');
  if (!dlg) return;

  // Re-mostrar filtros y chart (por si se usaron como selector de entidades)
  const filtros = document.querySelector('.widget-drawer-filters');
  if (filtros) filtros.style.display = '';
  const chartWrap = document.getElementById('hd-chart-wrap');
  if (chartWrap) chartWrap.style.display = '';
  // Restaurar selector de modo del chart (líneas/acumulado/barras) — solo aplica
  // al renderer genérico de movimientos. Los renderers custom lo ocultan después.
  const chartModes = document.querySelector('.hd-chart-modes');
  if (chartModes) chartModes.style.display = '';
  // Restaurar labels KPI
  const kpiTotal = document.getElementById('hd-kpi-total');
  if (kpiTotal && kpiTotal.previousElementSibling) kpiTotal.previousElementSibling.textContent = 'Total';
  const kpiCount = document.getElementById('hd-kpi-count');
  if (kpiCount && kpiCount.previousElementSibling) kpiCount.previousElementSibling.textContent = 'Movimientos';
  const kpiAvg = document.getElementById('hd-kpi-avg');
  if (kpiAvg && kpiAvg.previousElementSibling) kpiAvg.previousElementSibling.textContent = 'Promedio';
  // Restaurar footer
  const addBtn = document.getElementById('hd-add');
  if (addBtn) addBtn.textContent = '+ Agregar movimiento';

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

  // Dispatch: si hay renderer específico para este widget, lo usamos.
  // Si no, cae al renderizado genérico de movimientos filtrados (estado_global,
  // grafico, resumen_anual, flujo_mensual usan el genérico que ya funciona).
  if (_widgetRenderers[widgetId]) {
    // Para renderers custom, ocultamos filtros que no aplican.
    // Se restauran arriba (línea ~3556) cada vez que se reabre el drawer,
    // así que aunque cierres con filtros ocultos, la próxima apertura los repone.
    const filtros2 = document.querySelector('.widget-drawer-filters');
    if (filtros2) filtros2.style.display = 'none';
    // Ocultar selector líneas/acumulado/barras: los renderers custom arman su
    // propio chart (líneas con datos específicos del widget) y los otros modos
    // no aplican (ej. "saldo acumulado" no tiene sentido para cotizaciones).
    const chartModes2 = document.querySelector('.hd-chart-modes');
    if (chartModes2) chartModes2.style.display = 'none';
    try { _widgetRenderers[widgetId](); }
    catch (e) {
      console.error('[historial widget] renderer custom falló para', widgetId, e);
      // Restaurar filtros si el renderer custom falla, para que el fallback los use
      if (filtros2) filtros2.style.display = '';
      _hdRenderItems();
      _hdRenderChart();
    }
  } else {
    _hdRenderItems();
    _hdRenderChart();
  }

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

  // Cargar version.json (no bloqueante: si falla, seguimos)
  cargarVersion();

  // Service Worker + auto-update
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      _swReg = reg;
      if ('sync' in reg) {
        try { await reg.sync.register('sync-data'); } catch {}
      }
      // Cuando un SW nuevo termina de instalarse y queda esperando, lo aplicamos
      // según la preferencia de auto-update del usuario.
      reg.addEventListener('updatefound', () => {
        const nuevo = reg.installing;
        if (!nuevo) return;
        nuevo.addEventListener('statechange', () => {
          if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
            _hayActualizacionSW = true;
            aplicarActualizacionSiCorresponde();
          }
        });
      });
    } catch (e) {
      console.warn('SW register failed', e);
    }
    // Recargar una sola vez cuando el SW nuevo toma control
    let _recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_recargando) return;
      _recargando = true;
      location.reload();
    });
  }

  // Chequeo periódico de actualizaciones (cada 10 min si la app está visible)
  iniciarChequeoActualizaciones();

  // Bloquear orientación a vertical (solo aplica en PWA instalada / fullscreen)
  bloquearOrientacionVertical();

  // Si venimos de un reset, NO hacer pull inicial: evita que el merge LWW
  // restaure datos del repo antes de que el usuario lo decida.
  const _vieneDeReset = new URLSearchParams(location.search).has('reset');

  // Pull inicial + arrancar auto-sync si hay config GitHub
  const cfg = state.ajustes?.github;
  if (cfg?.pat && !_vieneDeReset) {
    try { await pullAll(cfg); } catch (e) { console.warn('Pull inicial falló', e); }
  }

  await reloadAll();

  // Auto-fetch de cotizaciones live (cache 5min, silencioso si falla)
  actualizarCotizacionesAuto(false).then(fresh => {
    if (fresh) {
      // Re-render del widget si está visible (sin recargar todo)
      const w = document.querySelector('[data-widget="tipo_cambio"]');
      if (w && typeof renderTipoCambio === 'function') renderTipoCambio(w);
    }
  }).catch(() => {});

  // Refresh periódico cada 15 min (solo si la app está visible)
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      actualizarCotizacionesAuto(false).then(fresh => {
        if (fresh) {
          const w = document.querySelector('[data-widget="tipo_cambio"]');
          if (w) renderTipoCambio(w);
        }
      }).catch(() => {});
    }
  }, 15 * 60 * 1000);

  // Iniciar auto-sync (cada 5min + al volver online + al ocultar pestaña).
  // Si venimos de un reset, NO arrancamos auto-sync automáticamente para no
  // re-bajar datos; el usuario puede sincronizar manualmente cuando quiera.
  if (!_vieneDeReset) {
    reiniciarAutoSync();
  } else {
    toast('Datos reseteados. La sincronización automática está pausada hasta que sincronices manualmente.', 4000);
  }
  actualizarTimestampSync();

  // Chequeo de tarjetas + IA + margen disponible tras render
  setTimeout(async () => {
    await chequeoDiarioTarjetas();
    await chequeoMargenDisponible();
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
    } else if (tab === 'tarjetas') {
      switchTab('tarjetas');
    } else if (tab === 'metas') {
      switchTab('metas');
    } else {
      switchTab('home');
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
  document.getElementById('dlg-recibo')?.addEventListener('close', async (e) => {
    if (e.target.returnValue === 'save') await handleSubmitRecibo(e.target.querySelector('form'));
  });

  // ── Módulo: Resumen Bancario PDF ─────────────────────────────
  iniciarModuloResumenBancario();

  // Recalcular resumen del recibo en vivo
  document.addEventListener('input', (e) => {
    if (e.target.closest('#dlg-recibo')) {
      if (e.target.name === 'sueldo_neto') e.target.dataset.autoCalc = '';
      actualizarResumenRecibo();
    }
  });

  // Botón "calcular descuentos típicos 17%"
  document.getElementById('rec-auto-calcular')?.addEventListener('click', () => {
    const form = document.querySelector('#dlg-recibo form');
    const bruto = parseFloat(form.elements.sueldo_bruto?.value) || 0;
    if (bruto <= 0) { toast('Ingresá el sueldo bruto primero', 2000); return; }
    form.elements.desc_jubilacion.value         = (bruto * 0.11).toFixed(2);
    form.elements.desc_obra_social.value        = (bruto * 0.03).toFixed(2);
    form.elements.desc_ley_19032.value          = (bruto * 0.03).toFixed(2);
    actualizarResumenRecibo();
  });

  // ── Pago de ciclo de tarjeta ─────────────────────────────────
  document.getElementById('pc-confirmar')?.addEventListener('click', () => confirmarPagoCiclo());
  document.getElementById('pc-cancelar')?.addEventListener('click', () => document.getElementById('dlg-pago-ciclo')?.close());
  document.getElementById('pc-close-x')?.addEventListener('click', () => document.getElementById('dlg-pago-ciclo')?.close());

  // ── Salud financiera (análisis IA completo) ──────────────────
  document.getElementById('salud-close-x')?.addEventListener('click', () => document.getElementById('dlg-salud')?.close());
  document.getElementById('salud-cerrar')?.addEventListener('click', () => document.getElementById('dlg-salud')?.close());

  // ── Editor de cotizaciones (mostrar/ocultar + editar) ────────
  document.getElementById('ec-guardar')?.addEventListener('click', () => guardarEditorTiposCambio());
  document.getElementById('ec-cancelar')?.addEventListener('click', () => document.getElementById('dlg-editor-cotiz')?.close());
  document.getElementById('ec-close-x')?.addEventListener('click', () => document.getElementById('dlg-editor-cotiz')?.close());

  // ── Centro de carga de PDF (Documentos) ──────────────────────
  const abrirDocumentos = () => document.getElementById('dlg-documentos')?.showModal();
  document.getElementById('nav-docs')?.addEventListener('click', abrirDocumentos);
  document.getElementById('sb-docs')?.addEventListener('click', abrirDocumentos);
  document.getElementById('rp-btn-docs')?.addEventListener('click', abrirDocumentos);
  document.getElementById('qa-docs')?.addEventListener('click', abrirDocumentos);
  document.getElementById('docs-close-x')?.addEventListener('click', () => document.getElementById('dlg-documentos')?.close());

  // Tarjeta "Recibo de sueldo": abre el form de recibo y dispara el selector de PDF
  document.getElementById('docs-recibo')?.addEventListener('click', () => {
    document.getElementById('dlg-documentos')?.close();
    abrirDialogoRecibo();
    setTimeout(() => document.getElementById('rec-import-file')?.click(), 150);
  });

  // Tarjeta "Resumen de tarjeta": abre el flujo de cotejo de resúmenes
  document.getElementById('docs-resumen')?.addEventListener('click', () => {
    document.getElementById('dlg-documentos')?.close();
    abrirImportResumen('');
  });

  // File input del recibo (parsea y rellena el form ya abierto)
  document.getElementById('rec-import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    toast('⏳ Procesando recibo…', 1500);
    try {
      const { parsearRecibo } = await import('./pdf-import.js');
      const datos = await parsearRecibo(file);
      // Asegurar que el form de recibo esté abierto antes de rellenar
      const dlgRec = document.getElementById('dlg-recibo');
      if (dlgRec && !dlgRec.open) abrirDialogoRecibo();
      rellenarFormularioRecibo(datos);
      const detectados = [];
      if (datos.sueldo_neto)        detectados.push('neto');
      if (datos.sueldo_bruto)       detectados.push('bruto');
      if (datos.periodo_aplicacion) detectados.push('período');
      if (datos.fecha)              detectados.push('fecha');
      if (datos.empleador)          detectados.push('empleador');
      toast(`✓ Importado (${detectados.join(', ')}). Revisá los campos.`, 3500);
    } catch (err) {
      console.error('[pdf-import] error:', err);
      const dlgRec = document.getElementById('dlg-recibo');
      if (dlgRec && !dlgRec.open) abrirDialogoRecibo();
      alert('No se pudo procesar el PDF:\n\n' + (err?.message || err) +
            '\n\nProbá completar los campos manualmente.');
    } finally {
      e.target.value = ''; // permitir re-subir el mismo archivo
    }
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

  // (El saludo se quitó del header; solo queda el badge de versión)

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
      else if (tab === 'tarjetas') { switchTab('home'); abrirVistaTarjetas(); }
      else if (tab === 'cuentas')  { switchTab('home'); abrirVistaCuentas();  }
      else if (tab === 'metas')    { switchTab('home'); abrirVistaMetas();    }
      else switchTab('home');
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

  // Restablecer colores del sistema a los defaults del tema
  document.getElementById('colores-reset')?.addEventListener('click', async () => {
    if (state.ajustes?.ui) { state.ajustes.ui.colores = {}; state.ajustes.ui.color_primario = ''; }
    aplicarTema();
    renderColoresSistema();
    try { await DB.put('ajustes', state.ajustes); notificarCambioLocal(); } catch {}
    toast('Colores restablecidos');
  });

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

  // PDF: selector dinámico de período (mes / año / rango)
  document.querySelectorAll('input[name="pdf_periodo_tipo"]').forEach(r => {
    r.addEventListener('change', () => {
      const tipo = r.value;
      document.getElementById('pdf-mes-wrap').hidden   = tipo !== 'mes';
      document.getElementById('pdf-anio-wrap').hidden  = tipo !== 'anio';
      document.getElementById('pdf-rango-wrap').hidden = tipo !== 'rango';
    });
  });

  // Default: mes actual, año actual
  const _hoyPdf = new Date();
  const _mesPdfEl  = document.getElementById('pdf-mes');
  const _anioPdfEl = document.getElementById('pdf-anio');
  const _anioPdfSoloEl = document.getElementById('pdf-anio-solo');
  if (_mesPdfEl  && !_mesPdfEl.value)  _mesPdfEl.value = String(_hoyPdf.getMonth() + 1);
  if (_anioPdfEl && !_anioPdfEl.value) _anioPdfEl.value = String(_hoyPdf.getFullYear());
  if (_anioPdfSoloEl && !_anioPdfSoloEl.value) _anioPdfSoloEl.value = String(_hoyPdf.getFullYear());

  document.getElementById('btn-export-pdf')?.addEventListener('click', async () => {
    const tipoEl = document.querySelector('input[name="pdf_periodo_tipo"]:checked');
    const tipo = tipoEl?.value || 'mes';
    let periodo;
    if (tipo === 'mes') {
      const mes  = document.getElementById('pdf-mes')?.value;
      const anio = document.getElementById('pdf-anio')?.value;
      if (!mes || !anio) { toast('Completá mes y año', 2000); return; }
      periodo = { tipo: 'mes', mes, anio };
    } else if (tipo === 'anio') {
      const anio = document.getElementById('pdf-anio-solo')?.value;
      if (!anio) { toast('Completá el año', 2000); return; }
      periodo = { tipo: 'anio', anio };
    } else {
      const desde = document.getElementById('pdf-desde')?.value;
      const hasta = document.getElementById('pdf-hasta')?.value;
      if (!desde || !hasta) { toast('Completá las fechas', 2000); return; }
      if (desde > hasta)    { toast('La fecha "desde" debe ser anterior a "hasta"', 2500); return; }
      periodo = { tipo: 'rango', desde, hasta };
    }

    const btn = document.getElementById('btn-export-pdf');
    const txt = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando PDF…'; }
    try {
      const { exportarReportePDF } = await import('./pdf-export.js');
      const nombre = await exportarReportePDF(state, periodo);
      toast(`✓ PDF descargado: ${nombre}`, 3500);
    } catch (e) {
      console.error('[pdf-export] error:', e);
      alert('No se pudo generar el PDF:\n\n' + (e?.message || e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = txt; }
    }
  });

  // Resetear datos — local + remoto en GitHub, SIN tocar la config de Sync
  /**
   * Ejecuta un reset de datos.
   * @param {'todo'|'movimientos'} modo
   *   'todo' → borra gastos, ingresos, tarjetas, cuentas, metas (reset global).
   *   'movimientos' → borra solo gastos e ingresos, mantiene el resto.
   */
  async function ejecutarReset(modo) {
    const esTodo = modo === 'todo';
    const stores = esTodo
      ? ['gastos', 'ingresos', 'tarjetas', 'cuentas', 'metas']
      : ['gastos', 'ingresos'];

    try {
      // 1. Detener auto-sync para que no re-baje datos durante el borrado
      stopAutoSync();

      // 2. Config de GitHub
      const aj = (await DB.get('ajustes', 'ajustes_globales')) || null;
      const cfg = aj?.github || null;
      const haySync = !!(cfg && cfg.pat && cfg.owner && cfg.repo);

      // 3. Vaciar LOCAL siempre (esto arregla el bug de "no borró nada"
      //    cuando el remoto fallaba). Limpiamos también la cola de sync.
      for (const s of [...stores, 'sync_queue']) {
        try { await DB.clear(s); } catch (e) { console.warn('No se pudo limpiar', s, e); }
      }

      // 4. Resetear el _sync_state (sin tocar github/pat)
      if (aj) { delete aj._sync_state; await DB.put('ajustes', aj); }

      // 5. Limpiar caches de localStorage (no toca auth)
      for (const k of ['_cotiz_cache', 'app_last_build', 'app_last_version', 'cotiz_manual']) {
        try { localStorage.removeItem(k); } catch { /* noop */ }
      }

      // 6. Vaciar REMOTO best-effort. 'todo' marca reset global; 'movimientos'
      //    solo vacía gastos.json + ingresos.json (sin tocar tarjetas/cuentas).
      let remotoOk = true, remotoMsg = '';
      if (haySync) {
        try {
          toast('Borrando datos en GitHub…');
          await wipeRemoto(cfg, { stores, marcarReset: esTodo });
        } catch (e) {
          remotoOk = false;
          remotoMsg = e?.message || String(e);
          console.error('Error borrando datos remotos:', e);
        }
      }

      // 7. Avisar y recargar. El parámetro ?reset evita el pull/sync inicial
      //    que podría restaurar los datos antes de que el usuario sincronice.
      if (haySync && !remotoOk) {
        alert('Se borró todo en este dispositivo ✓\n\n' +
              'Pero NO se pudo borrar en GitHub:\n' + remotoMsg + '\n\n' +
              'La sincronización quedó en pausa. Cuando tengas conexión, sincronizá ' +
              'manualmente desde Ajustes → Sync para propagar el borrado (o reintentá el reset).');
      } else {
        toast('✓ Datos borrados. Recargando…');
      }
      setTimeout(() => { location.href = './?reset=' + Date.now(); }, 900);
    } catch (e) {
      console.error('Error reseteando datos:', e);
      alert('No se pudo resetear: ' + (e?.message || e) + '\n\nProbá cerrar otras pestañas y reintentar.');
    }
  }

  // Botón: borrar TODO
  document.getElementById('btn-clear-data')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar TODO?\n\nVas a perder: gastos, ingresos, tarjetas, cuentas y metas (acá y en GitHub si tenés Sync).\n\nSE MANTIENE: tu PAT y la config de Sync.\n\nNo se puede deshacer.')) return;
    if (!confirm('Última confirmación: vas a arrancar de cero con la app vacía. ¿Continuar?')) return;
    await ejecutarReset('todo');
  });

  // Botón: borrar solo movimientos (mantener tarjetas/cuentas/categorías/metas)
  document.getElementById('btn-clear-records')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar solo los movimientos?\n\nVas a perder TODOS los gastos e ingresos.\n\nSE MANTIENEN: tarjetas, cuentas, categorías y metas (vacías, listas para volver a cargar).\n\nNo se puede deshacer.')) return;
    await ejecutarReset('movimientos');
  });

  // ── DRAWER DE TARJETA handlers ────────────────────────────────
  bindDrawerTarjetaHandlers();

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
  // Gastos habituales
  document.getElementById('add-habitual')?.addEventListener('click', () => {
    state.ajustes.catalogos = state.ajustes.catalogos || {};
    if (!Array.isArray(state.ajustes.catalogos.habituales)) state.ajustes.catalogos.habituales = [];
    state.ajustes.catalogos.habituales.push({ id: 'hab_' + Date.now(), nombre: 'Nuevo', icono: '🔁', color: '#00f0ff', valor: 1000, categoria: 'general' });
    renderHabitualesSettings();
  });
  // Buscar actualizaciones manualmente
  document.getElementById('btn-check-update')?.addEventListener('click', () => chequearActualizacion(true));
}

/* ============ Editor de gastos habituales en Settings ============ */
function renderHabitualesSettings() {
  const cont = document.getElementById('habituales-list');
  if (!cont) return;
  if (!Array.isArray(state.ajustes?.catalogos?.habituales)) {
    state.ajustes.catalogos = state.ajustes.catalogos || {};
    state.ajustes.catalogos.habituales = [];
  }
  const lista = state.ajustes.catalogos.habituales;
  const catsGasto = state.ajustes?.catalogos?.categorias_gasto?.length
    ? state.ajustes.catalogos.categorias_gasto
    : (state.ajustes?.categorias_gasto || AJUSTES_DEFAULT.catalogos.categorias_gasto);

  cont.innerHTML = lista.length ? '' :
    `<p class="text-xs text-center py-3" style="color:var(--ink-muted)">Sin gastos habituales. Tocá "+ Agregar".</p>`;

  lista.forEach((h, idx) => {
    const optsCat = catsGasto.map(c => `<option value="${escapeHtml(c.id||c.nombre)}" ${(h.categoria===(c.id||c.nombre))?'selected':''}>${escapeHtml(c.icono||'')} ${escapeHtml(c.nombre)}</option>`).join('');
    cont.insertAdjacentHTML('beforeend', `
      <div class="hab-edit-card" data-idx="${idx}">
        <div class="hab-edit-top">
          <span class="hab-edit-emoji" data-hab-emoji="${idx}" style="background:${h.color}1a;border-color:${h.color}55" title="Cambiar emoji">${escapeHtml(h.icono||'🔁')}</span>
          <input class="input hab-edit-nombre" data-hab-nombre="${idx}" value="${escapeHtml(h.nombre||'')}" placeholder="Nombre (ej: Vianda)" maxlength="24" />
          <span class="hab-edit-color" data-hab-color="${idx}" style="background:${h.color}" title="Color"></span>
          <button type="button" class="hab-edit-del" data-hab-del="${idx}" title="Eliminar">✕</button>
        </div>
        <div class="hab-edit-bottom">
          <label class="hab-edit-field">
            <span>Valor</span>
            <div class="input-with-prefix"><span class="input-prefix">$</span>
              <input type="number" class="input" data-hab-valor="${idx}" value="${h.valor||0}" min="0" step="100" placeholder="0" /></div>
          </label>
          <label class="hab-edit-field">
            <span>Categoría</span>
            <select class="input" data-hab-cat="${idx}">${optsCat}</select>
          </label>
        </div>
      </div>`);
  });

  cont.querySelectorAll('[data-hab-nombre]').forEach(inp => inp.oninput = e => { lista[+e.target.dataset.habNombre].nombre = e.target.value; });
  cont.querySelectorAll('[data-hab-valor]').forEach(inp => inp.oninput = e => { lista[+e.target.dataset.habValor].valor = Number(e.target.value)||0; });
  cont.querySelectorAll('[data-hab-cat]').forEach(sel => sel.onchange = e => { lista[+e.target.dataset.habCat].categoria = e.target.value; });
  cont.querySelectorAll('[data-hab-emoji]').forEach(el => el.onclick = () => mostrarPickerEmojiHabitual(+el.dataset.habEmoji));
  cont.querySelectorAll('[data-hab-color]').forEach(el => el.onclick = () => mostrarPickerColorHabitual(+el.dataset.habColor));
  cont.querySelectorAll('[data-hab-del]').forEach(btn => btn.onclick = () => {
    lista.splice(+btn.dataset.habDel, 1); renderHabitualesSettings();
  });

  // Poblar el select de cuenta para descontar. Preserva lo seleccionado en el
  // DOM (si el usuario ya eligió pero aún no guardó) para no perder la elección
  // al re-renderizar tras agregar/eliminar habituales.
  const selCuenta = document.getElementById('sel-habituales-cuenta');
  if (selCuenta) {
    const seleccionActual = selCuenta.value || state.ajustes?.habituales_cuenta_id || '';
    const cuentas = (state.cuentas || []).filter(c => !c.deleted && c.activa !== false);
    selCuenta.innerHTML = `<option value="">No descontar de ninguna</option>` +
      cuentas.map(c => `<option value="${c.id}" ${seleccionActual===c.id?'selected':''}>${escapeHtml(c.nombre)}</option>`).join('');
    selCuenta.value = seleccionActual;
  }
}

/** Picker de emoji simple para un habitual (reutiliza prompt para no duplicar UI). */
function mostrarPickerEmojiHabitual(idx) {
  const h = state.ajustes.catalogos.habituales[idx];
  const e = prompt('Emoji para este gasto habitual:', h.icono || '🔁');
  if (e !== null) { h.icono = e.trim() || '🔁'; renderHabitualesSettings(); }
}
/** Picker de color simple para un habitual. */
function mostrarPickerColorHabitual(idx) {
  const h = state.ajustes.catalogos.habituales[idx];
  const inp = document.createElement('input');
  inp.type = 'color'; inp.value = h.color || '#00f0ff';
  inp.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(inp);
  inp.addEventListener('input', () => { h.color = inp.value; });
  inp.addEventListener('change', () => { h.color = inp.value; inp.remove(); renderHabitualesSettings(); });
  inp.click();
}

/* ============ Editor de catálogos en Settings ============ */

// Pool extendido de emojis organizados por categoría
const EMOJI_CATEGORIES = {
  'Comida':    ['🛒','🍽','🍕','🍔','🍟','🥗','🥪','🍱','🍜','🍣','🥘','🍳','🥖','🧀','🥕','🍎','🥑','🍰','🍪','🍫','🍩','🍦','☕','🍷','🍺','🍶','🥃','🍵'],
  'Hogar':     ['🏠','🏡','🛋','🛏','🛁','🚪','🪑','🧹','🧺','🪴','🌿','🧼','🧽','💡','🔌','🪞','🏘','🪟','🔑','🪛'],
  'Transporte':['🚗','🚙','🚕','🚌','🚎','🚐','🚓','🏎','🚲','🛵','🏍','🛺','🚖','⛽','⚡','🔋','🅿️','🛞','🛣','✈️','🚂','🚊'],
  'Ocio':      ['🎬','🎮','🎵','🎤','🎸','🎹','🎲','🎯','🎨','📚','📖','✏️','🎭','🎪','🎢','🎡','🎠','🏖','🌊','⛱','🎁','🎉','🎊','🎈'],
  'Salud':     ['💊','🩺','🏥','💉','🧴','🩹','🪥','🧻','😷','🦷','👁','👂','🧬','🫀','🫁','🧠','💪','🤲','👶','🧓'],
  'Trabajo':   ['💼','💻','📱','📞','📧','📊','📈','📉','📅','📋','🖨','📎','📌','🖋','✂️','🗂','📁','📦','💳','💰','💵','💸','🏦','🪙','📝'],
  'Ropa':      ['👗','👕','👖','🧥','👔','👚','🩱','👙','🩳','🩲','👘','🥻','🧣','🧤','🧦','👟','👞','👢','👠','👜','🛍','🎒','💍','💎','👓'],
  'Servicios': ['💡','🔥','💧','📡','📶','📺','📻','🔧','🪜','🔨','🛠','⚙️','🧰','🔍','✂️','🪒','💈','🧴'],
  'Educación': ['📚','🎓','🏫','📖','📝','✏️','🖊','🖍','📏','📐','🔬','🔭','🧮','🌐','🖥','⌨️','🖱'],
  'Animales':  ['🐶','🐱','🐭','🐰','🐢','🐠','🐦','🐔','🐴','🐺','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🦄','🐝','🐛','🐾'],
  'Naturaleza':['🌳','🌲','🌴','🌵','🌻','🌷','🌹','🌺','🌸','💐','🍀','🌿','🌱','☀️','⛅','☁️','🌧','⛈','❄️','⭐','🌈','🌊','🏔','🌋'],
  'Símbolos':  ['📌','✨','⭐','🔥','💎','💍','🎁','🎗','🏷','📍','✅','✔️','⚡','💡','💫','🌟','🆕','🆗','🔔','🔕','🚀','💯','⚠️','✖️'],
};

const EMOJI_POOL = Object.values(EMOJI_CATEGORIES).flat();

// Paleta extendida de colores neón + tradicionales
const COLOR_POOL = [
  // Cyberpunk neón
  '#00f0ff','#ff00ea','#39ff14','#ffea00','#ff2d92','#b537ff','#00ff9f','#ff2d6e',
  // Vibrantes
  '#10b981','#f59e0b','#a78bfa','#ec4899','#fb923c','#f43f5e','#c084fc','#38bdf8',
  // Suaves
  '#facc15','#f87171','#22d3ee','#94a3b8','#84cc16','#06b6d4','#fde047','#fda4af',
  // Profundos
  '#0ea5e9','#7c3aed','#db2777','#dc2626','#ea580c','#65a30d','#0d9488','#1e40af',
  // Neutros
  '#64748b','#475569','#334155','#1e293b',
];

function renderCatalogoSettings(tipo) {
  const lista = state.ajustes?.catalogos?.[`categorias_${tipo}`] || [];
  const contId = tipo === 'gasto' ? 'cat-gasto-list' : 'cat-ingreso-list';
  const cont = document.getElementById(contId);
  if (!cont) return;
  cont.innerHTML = '';

  lista.forEach((cat, idx) => {
    const item = document.createElement('div');
    item.className = 'catalog-item';
    item.dataset.idx = idx;
    item.dataset.tipo = tipo;
    item.draggable = true;
    const subcats = cat.subcategorias || [];
    item.innerHTML = `
      <button type="button" class="catalog-item-drag" title="Arrastrá para reordenar" data-action="drag" tabindex="-1">⋮⋮</button>
      <span class="catalog-item-emoji" data-action="emoji" data-idx="${idx}" data-tipo="${tipo}" style="border-color:${cat.color}33;background:${cat.color}11">${cat.icono}</span>
      <div style="flex:1;min-width:0">
        <input class="catalog-item-name" type="text" value="${escapeHtml(cat.nombre)}" data-idx="${idx}" data-tipo="${tipo}" maxlength="32" placeholder="Nombre"/>
        <div class="subcat-list catalog-subcat-list" data-idx="${idx}" data-tipo="${tipo}">
          ${subcats.map((s, si) => `<span class="subcat-chip">${escapeHtml(s)}<button type="button" data-action="delsubcat" data-idx="${idx}" data-tipo="${tipo}" data-si="${si}" title="Eliminar subcategoría">✕</button></span>`).join('')}
          <button type="button" class="subcat-chip" data-action="addsubcat" data-idx="${idx}" data-tipo="${tipo}" style="cursor:pointer;border-style:dashed;color:var(--brand)">+ subcategoría</button>
        </div>
      </div>
      <span class="catalog-item-color" data-action="color" data-idx="${idx}" data-tipo="${tipo}" style="background:${cat.color}" title="Color"></span>
      <div class="catalog-item-order">
        <button type="button" class="catalog-order-btn" data-action="up"   data-idx="${idx}" data-tipo="${tipo}" title="Mover arriba"  ${idx === 0 ? 'disabled' : ''}>▴</button>
        <button type="button" class="catalog-order-btn" data-action="down" data-idx="${idx}" data-tipo="${tipo}" title="Mover abajo"  ${idx === lista.length - 1 ? 'disabled' : ''}>▾</button>
      </div>
      <button type="button" class="catalog-item-del" data-action="del" data-idx="${idx}" data-tipo="${tipo}" title="Eliminar">✕</button>
    `;
    cont.appendChild(item);
  });

  // Editor de nombre con auto-id
  cont.querySelectorAll('.catalog-item-name').forEach(inp => {
    inp.oninput = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const tp = e.target.dataset.tipo;
      const arr = state.ajustes.catalogos[`categorias_${tp}`];
      arr[idx].nombre = e.target.value;
      if (!arr[idx].id) arr[idx].id = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '_');
    };
  });

  // Picker emoji con búsqueda
  cont.querySelectorAll('[data-action="emoji"]').forEach(el => {
    el.onclick = (e) => mostrarPickerEmoji(e.currentTarget);
  });

  // Picker color con paleta extendida
  cont.querySelectorAll('[data-action="color"]').forEach(el => {
    el.onclick = (e) => mostrarPickerColor(e.currentTarget);
  });

  // Botones flecha (orden manual)
  cont.querySelectorAll('[data-action="up"], [data-action="down"]').forEach(btn => {
    btn.onclick = (e) => {
      const idx = parseInt(btn.dataset.idx);
      const tp = btn.dataset.tipo;
      const arr = state.ajustes.catalogos[`categorias_${tp}`];
      const delta = btn.dataset.action === 'up' ? -1 : 1;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= arr.length) return;
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      renderCatalogoSettings(tp);
    };
  });

  // Drag & drop
  let dragSrcIdx = null;
  cont.querySelectorAll('.catalog-item').forEach(it => {
    it.addEventListener('dragstart', (e) => {
      dragSrcIdx = parseInt(it.dataset.idx);
      it.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragSrcIdx);
    });
    it.addEventListener('dragend', () => {
      it.classList.remove('dragging');
      cont.querySelectorAll('.catalog-item').forEach(x => x.classList.remove('drag-over'));
    });
    it.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cont.querySelectorAll('.catalog-item').forEach(x => x.classList.remove('drag-over'));
      it.classList.add('drag-over');
    });
    it.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetIdx = parseInt(it.dataset.idx);
      const tp = it.dataset.tipo;
      if (dragSrcIdx === null || dragSrcIdx === targetIdx) return;
      const arr = state.ajustes.catalogos[`categorias_${tp}`];
      const [moved] = arr.splice(dragSrcIdx, 1);
      arr.splice(targetIdx, 0, moved);
      dragSrcIdx = null;
      renderCatalogoSettings(tp);
    });
  });

  // Eliminar categoría
  cont.querySelectorAll('[data-action="del"]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      const tp = btn.dataset.tipo;
      if (!confirm('¿Eliminar esta categoría?')) return;
      state.ajustes.catalogos[`categorias_${tp}`].splice(idx, 1);
      renderCatalogoSettings(tp);
    };
  });

  // ── Subcategorías ────────────────────────────────────────────
  cont.querySelectorAll('[data-action="addsubcat"]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      const tp = btn.dataset.tipo;
      const nombre = prompt('Nombre de la subcategoría:');
      if (!nombre?.trim()) return;
      const cat = state.ajustes.catalogos[`categorias_${tp}`][idx];
      if (!Array.isArray(cat.subcategorias)) cat.subcategorias = [];
      if (!cat.subcategorias.includes(nombre.trim())) cat.subcategorias.push(nombre.trim());
      renderCatalogoSettings(tp);
    };
  });
  cont.querySelectorAll('[data-action="delsubcat"]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx);
      const tp  = btn.dataset.tipo;
      const si  = parseInt(btn.dataset.si);
      const cat = state.ajustes.catalogos[`categorias_${tp}`][idx];
      if (!Array.isArray(cat.subcategorias)) return;
      cat.subcategorias.splice(si, 1);
      renderCatalogoSettings(tp);
    };
  });
}

function mostrarPickerEmoji(target) {
  document.querySelectorAll('.catalog-item-edit-popover').forEach(p => p.remove());

  const idx = parseInt(target.dataset.idx);
  const tipo = target.dataset.tipo;
  const popover = document.createElement('div');
  popover.className = 'catalog-item-edit-popover popover-emoji';

  // Header con buscador y tabs de categoría
  const header = document.createElement('div');
  header.className = 'popover-header';
  header.innerHTML = `
    <input type="search" class="popover-search" placeholder="🔍 Buscar emoji…" autofocus />
    <div class="popover-tabs"></div>
  `;
  popover.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'popover-grid emoji-grid';
  popover.appendChild(grid);

  const render = (filtroBusqueda = '', categoriaActiva = 'all') => {
    grid.innerHTML = '';
    const f = (filtroBusqueda || '').toLowerCase().trim();

    // Si hay búsqueda, ignoramos tab y filtramos sobre categorías cuyo nombre matchee.
    let lista;
    if (f) {
      const matchingCats = Object.keys(EMOJI_CATEGORIES).filter(cat =>
        cat.toLowerCase().includes(f));
      const set = new Set();
      matchingCats.forEach(cat => EMOJI_CATEGORIES[cat].forEach(e => set.add(e)));
      lista = [...set];
      if (lista.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'popover-empty';
        empty.textContent = `Sin resultados para "${filtroBusqueda}"`;
        grid.appendChild(empty);
        return;
      }
    } else {
      lista = categoriaActiva === 'all'
        ? EMOJI_POOL
        : (EMOJI_CATEGORIES[categoriaActiva] || []);
    }

    lista.forEach(emoji => {
      const b = document.createElement('button');
      b.className = 'catalog-emoji-btn';
      b.type = 'button';
      b.textContent = emoji;
      b.title = emoji;
      b.onclick = () => {
        state.ajustes.catalogos[`categorias_${tipo}`][idx].icono = emoji;
        renderCatalogoSettings(tipo);
        popover.remove();
      };
      grid.appendChild(b);
    });
  };

  // Tabs categorías
  const tabsCont = header.querySelector('.popover-tabs');
  const cats = ['all', ...Object.keys(EMOJI_CATEGORIES)];
  cats.forEach((cat, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'popover-tab' + (i === 0 ? ' active' : '');
    t.textContent = cat === 'all' ? '✨ Todos' : cat;
    t.onclick = () => {
      tabsCont.querySelectorAll('.popover-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      render(header.querySelector('.popover-search').value, cat);
    };
    tabsCont.appendChild(t);
  });

  // Buscador
  header.querySelector('.popover-search').oninput = (e) => {
    const activeTab = tabsCont.querySelector('.popover-tab.active');
    render(e.target.value, activeTab ? (activeTab.textContent === '✨ Todos' ? 'all' : activeTab.textContent) : 'all');
  };

  render('', 'all');

  const host = target.closest('dialog[open]') || document.body;
  posicionarPopover(popover, target);
  host.appendChild(popover);
  cerrarAlClickearFuera(popover);
}

function mostrarPickerColor(target) {
  document.querySelectorAll('.catalog-item-edit-popover').forEach(p => p.remove());
  const idx = parseInt(target.dataset.idx);
  const tipo = target.dataset.tipo;

  const popover = document.createElement('div');
  popover.className = 'catalog-item-edit-popover popover-color';

  const header = document.createElement('div');
  header.className = 'popover-header';
  header.innerHTML = `
    <p class="popover-title">Color de la categoría</p>
    <div class="popover-custom-color">
      <input type="color" class="popover-color-input" value="${state.ajustes.catalogos[`categorias_${tipo}`][idx].color}" />
      <span>Color personalizado</span>
    </div>
  `;
  popover.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'popover-grid color-grid';
  popover.appendChild(grid);

  COLOR_POOL.forEach(c => {
    const b = document.createElement('button');
    b.className = 'catalog-emoji-btn color-swatch-btn';
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    if (c === state.ajustes.catalogos[`categorias_${tipo}`][idx].color) {
      b.classList.add('active');
    }
    b.onclick = () => {
      state.ajustes.catalogos[`categorias_${tipo}`][idx].color = c;
      renderCatalogoSettings(tipo);
      popover.remove();
    };
    grid.appendChild(b);
  });

  // Color custom
  header.querySelector('.popover-color-input').oninput = (e) => {
    state.ajustes.catalogos[`categorias_${tipo}`][idx].color = e.target.value;
    renderCatalogoSettings(tipo);
    popover.remove();
  };

  const host = target.closest('dialog[open]') || document.body;
  posicionarPopover(popover, target);
  host.appendChild(popover);
  cerrarAlClickearFuera(popover);
}

// Posiciona el popover debajo del target, ajustando si se sale del viewport.
// IMPORTANTE: si el target está dentro de un <dialog open>, el popover debe
// adjuntarse al dialog para quedar en el mismo top-layer; sino los modales
// modales interceptan los clicks.
function posicionarPopover(popover, target) {
  const dialogContainer = target.closest('dialog[open]');
  const host = dialogContainer || document.body;

  // Agregar oculto al host para medir
  popover.style.visibility = 'hidden';
  popover.style.left = '0px';
  popover.style.top = '0px';
  host.appendChild(popover);
  const popRect = popover.getBoundingClientRect();
  host.removeChild(popover);
  popover.style.visibility = '';

  const targetRect = target.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Posición DESEADA en coordenadas de viewport
  let leftVp = targetRect.left;
  if (leftVp + popRect.width > vw - 8) {
    leftVp = Math.max(8, vw - popRect.width - 8);
  }
  let topVp = targetRect.bottom + 6;
  if (topVp + popRect.height > vh - 8) {
    topVp = Math.max(8, targetRect.top - popRect.height - 6);
  }

  // CRÍTICO: cuando el popover se agrega DENTRO de un <dialog> (top-layer),
  // el dialog actúa como bloque contenedor de `position:fixed`, así que las
  // coordenadas son relativas al dialog, NO al viewport. Restamos el offset
  // del dialog para que aparezca donde corresponde (antes se iba de pantalla).
  const hostRect = (host === document.body) ? { left: 0, top: 0 } : host.getBoundingClientRect();
  popover.style.left = (leftVp - hostRect.left) + 'px';
  popover.style.top  = (topVp - hostRect.top) + 'px';
}

function cerrarAlClickearFuera(popover) {
  setTimeout(() => {
    const close = (e) => {
      if (!popover.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 50);
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
    notificarCambioLocal();
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
    notificarCambioLocal();
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
  // CRÍTICO: marcar como edición para que handleSubmit preserve el ID
  if (form.elements._editing_id) form.elements._editing_id.value = id;
  if (form.elements.nombre)          form.elements.nombre.value = t.nombre || '';
  if (form.elements.banco)           form.elements.banco.value = t.banco || '';
  if (form.elements.ultimos_4)       form.elements.ultimos_4.value = t.ultimos_4 || '';
  if (form.elements.limite_un_pago)  form.elements.limite_un_pago.value = t.limite_un_pago || 0;
  if (form.elements.limite_cuotas)   form.elements.limite_cuotas.value = t.limite_cuotas || 0;
  if (form.elements.dia_cierre)      form.elements.dia_cierre.value = t.dia_cierre || 15;
  if (form.elements.dia_vencimiento) form.elements.dia_vencimiento.value = t.dia_vencimiento || 5;
  if (form.elements.color)           form.elements.color.value = t.color || '#00f0ff';
  // Refrescar la preview y el visualizador del ciclo
  setTimeout(() => {
    if (typeof updateCardPreview === 'function')  updateCardPreview();
    if (typeof actualizarCicloVisual === 'function') actualizarCicloVisual();
  }, 100);
  // Cargar ciclos custom existentes
  if (typeof cargarCiclosCustomEnDialog === 'function') cargarCiclosCustomEnDialog(t);
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
// y actualizar el label "¿En qué gastaste?" con la categoría seleccionada
function _actualizarLabelGasto(cat) {
  const lbl = document.getElementById('lbl-descripcion-gasto');
  if (!lbl) return;
  const c = (cat || '').trim();
  lbl.textContent = c ? `(${c}) - ¿En qué gastaste?` : '¿En qué gastaste?';
}
document.addEventListener('change', (e) => {
  if (e.target.matches('#dlg-gasto input[name="cat_quick"]')) {
    const txtInput = document.querySelector('#dlg-gasto input[name="categoria"]');
    if (txtInput) txtInput.value = e.target.value;
    _actualizarLabelGasto(e.target.value);
  }
  if (e.target.matches('#dlg-gasto input[name="categoria"]')) {
    _actualizarLabelGasto(e.target.value);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.matches('#dlg-gasto input[name="categoria"]')) {
    _actualizarLabelGasto(e.target.value);
  }
});

/* ── Selector de moneda en dlg-gasto ─────────────────────────── */
const CURRENCY_SYMBOLS = { ARS: '$', USD: 'US$', EUR: '€', BRL: 'R$' };

document.addEventListener('change', (e) => {
  if (e.target.id !== 'gasto-moneda') return;
  actualizarRowCotizacion();
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'gasto-cotizacion' || e.target.matches('#dlg-gasto input[name="monto"]') || e.target.id === 'gasto-moneda') {
    actualizarEquivalenteCotizacion();
  }
});

function actualizarRowCotizacion() {
  const select  = document.getElementById('gasto-moneda');
  const row     = document.getElementById('row-cotizacion');
  const prefix  = document.getElementById('gasto-moneda-prefix');
  const label   = document.getElementById('cot-currency-label');
  const cotInp  = document.getElementById('gasto-cotizacion');
  if (!select || !row) return;

  const moneda = select.value || 'ARS';
  select.dataset.active = moneda;
  if (prefix) prefix.textContent = CURRENCY_SYMBOLS[moneda] || '$';
  if (label)  label.textContent  = moneda;

  if (moneda === 'ARS') {
    row.hidden = true;
    return;
  }
  row.hidden = false;

  // Sugerir cotización actual desde ajustes.tipos_cambio
  if (cotInp && !cotInp.value) {
    const cambios = state.ajustes?.tipos_cambio || {};
    const sugerencia = cambios[moneda]?.valor
      || (moneda === 'USD' ? (cambios.USD_BLUE?.valor || cambios.USD?.valor) : null);
    if (sugerencia) cotInp.value = sugerencia;
  }
  actualizarEquivalenteCotizacion();
}

function actualizarEquivalenteCotizacion() {
  const form    = document.querySelector('#dlg-gasto form');
  if (!form) return;
  const monto   = parseFloat(form.elements.monto?.value) || 0;
  const moneda  = form.elements.moneda?.value || 'ARS';
  const cotiz   = parseFloat(form.elements.cotizacion?.value) || 0;
  const equivEl = document.getElementById('cot-equiv');
  const valEl   = document.getElementById('cot-equiv-valor');
  if (!equivEl || !valEl) return;

  if (moneda === 'ARS' || cotiz <= 0 || monto <= 0) {
    equivEl.hidden = true;
    return;
  }
  equivEl.hidden = false;
  valEl.textContent = FMT.format(monto * cotiz);
}

// Cuando se abre dlg-gasto, resetear estado de moneda
const _origPreparar = prepararDialogoGasto;
if (typeof _origPreparar === 'function') {
  window._origPrepararGasto = _origPreparar;
}

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

  card.style.background = _gradienteTarjeta(color);
}

document.addEventListener('input', (e) => {
  if (e.target.closest('#dlg-tarjeta')) updateCardPreview();
});

// Slider días: actualizar badge
document.addEventListener('input', (e) => {
  if (e.target.id === 'ip-cierre') {
    document.getElementById('badge-cierre').textContent = e.target.value;
    actualizarCicloVisual();
  }
  if (e.target.id === 'ip-venc') {
    document.getElementById('badge-venc').textContent = e.target.value;
    actualizarCicloVisual();
  }
});

function actualizarCicloVisual() {
  const closeDay = parseInt(document.getElementById('ip-cierre')?.value) || 15;
  const dueDay   = parseInt(document.getElementById('ip-venc')?.value)   || 5;
  const closeMarker = document.getElementById('cycle-marker-close');
  const dueMarker   = document.getElementById('cycle-marker-due');
  const fill        = document.getElementById('cycle-fill');
  const summary     = document.getElementById('cycle-summary');
  if (!closeMarker) return;

  const pctClose = ((closeDay - 1) / 30) * 100;
  const pctDue   = ((dueDay - 1) / 30) * 100;
  closeMarker.style.left = pctClose + '%';
  dueMarker.style.left   = pctDue + '%';

  // El fill muestra el período de gastos: desde día siguiente al cierre anterior
  // hasta el día de cierre. Visualmente: del 0 al closeDay.
  if (fill) {
    fill.style.left = '0%';
    fill.style.width = pctClose + '%';
  }

  // Resumen explicativo
  if (summary) {
    const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const hoy   = new Date();
    const mesActual    = meses[hoy.getMonth()];
    const mesSiguiente = meses[(hoy.getMonth() + 1) % 12];

    const ventana = `Día <b>${closeDay + 1}</b> al <b>${closeDay}</b> del mes siguiente`;
    const explicacion = dueDay < closeDay
      ? `Todo lo que gastes desde el <b>día ${closeDay + 1} de ${mesActual}</b> hasta el <b>día ${closeDay} de ${mesSiguiente}</b> se factura en el resumen que se paga el <span class="pink">día ${dueDay}</span> del mes posterior.`
      : `Todo lo que gastes desde el <b>día ${closeDay + 1} de ${mesActual}</b> hasta el <b>día ${closeDay} de ${mesSiguiente}</b> se factura en el resumen que se paga el <span class="pink">día ${dueDay} de ${mesSiguiente}</span>.`;
    summary.innerHTML = explicacion;
  }
}

// Actualizar el visual cuando se abre el dialog
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="add-card"], [data-sidebar-tab="tarjetas"], [data-tab="tarjetas"], #add-tarjeta-btn')) {
    setTimeout(actualizarCicloVisual, 100);
    // Resetear lista de ciclos custom para tarjeta nueva
    setTimeout(() => {
      _ciclosCustomEditando = [];
      renderCiclosCustomList();
    }, 100);
  }
});

/* ============ Ciclos custom en dlg-tarjeta ============ */
let _ciclosCustomEditando = [];

function cargarCiclosCustomEnDialog(tarjeta) {
  _ciclosCustomEditando = Array.isArray(tarjeta?.ciclos_custom) ? [...tarjeta.ciclos_custom] : [];
  renderCiclosCustomList();
}

function renderCiclosCustomList() {
  const cont  = document.getElementById('ciclos-custom-list');
  const count = document.getElementById('ciclos-count');
  if (!cont) return;
  cont.innerHTML = '';
  if (count) count.textContent = _ciclosCustomEditando.length;

  if (_ciclosCustomEditando.length === 0) {
    cont.innerHTML = `<p class="text-[11px] text-center py-2" style="color:var(--ink-muted)">Sin ciclos personalizados (se usa el día fijo)</p>`;
    return;
  }
  const sorted = [..._ciclosCustomEditando].sort((a,b) => (a.inicio||'').localeCompare(b.inicio||''));
  const fmtCorto = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso + 'T12:00:00');
    const mn = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    return `${d.getDate()}/${mn[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}`;
  };
  sorted.forEach((c, realIdxFromSort) => {
    const idx = _ciclosCustomEditando.indexOf(c);
    cont.insertAdjacentHTML('beforeend', `
      <div class="ciclo-custom-row">
        <div class="ciclo-custom-row-info">
          <span class="periodo">${c.periodo || '—'}</span>
          <span class="dates">${fmtCorto(c.inicio)} → ${fmtCorto(c.fin)} · 💸 ${fmtCorto(c.vencimiento)}</span>
        </div>
        <button type="button" class="ciclo-custom-row-del" data-idx="${idx}" title="Eliminar">✕</button>
      </div>`);
  });
  cont.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.dataset.idx);
      _ciclosCustomEditando.splice(i, 1);
      renderCiclosCustomList();
    });
  });
}

// Botón "+ Agregar ciclo"
document.addEventListener('click', (e) => {
  if (e.target.id !== 'cc-add-btn') return;
  const inicio = document.getElementById('cc-inicio')?.value;
  const fin    = document.getElementById('cc-fin')?.value;
  const venc   = document.getElementById('cc-venc')?.value;
  if (!inicio || !fin || !venc) { toast('Completá las 3 fechas', 2000); return; }
  if (inicio > fin) { toast('Inicio debe ser anterior al cierre', 2000); return; }
  // El "periodo" del ciclo es YYYY-MM del cierre (el resumen)
  const periodo = fin.slice(0, 7);
  // Validar superposición
  const overlap = _ciclosCustomEditando.find(c => !(c.fin < inicio || c.inicio > fin));
  if (overlap) { toast('Las fechas se superponen con un ciclo existente', 2500); return; }
  _ciclosCustomEditando.push({ periodo, inicio, fin, vencimiento: venc });
  document.getElementById('cc-inicio').value = '';
  document.getElementById('cc-fin').value = '';
  document.getElementById('cc-venc').value = '';
  renderCiclosCustomList();
  toast('✓ Ciclo agregado');
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
// Convención NUEVA: 5 estrellas = máxima prioridad, 1 estrella = mínima.
// Internamente seguimos guardando 1-5 pero la UX invierte: estrellas
// "encendidas" = prioridad. Para mantener la regla de sort por menor=más
// importante en el resto del código, transformamos: valorReal = 6 - estrellas.
document.addEventListener('change', (e) => {
  if (!e.target.matches('#dlg-meta input[name="prioridad"]')) return;
  // El valor del radio ahora representa NÚMERO DE ESTRELLAS (1-5).
  // Lo convertimos a prioridad interna (1=máxima, 5=mínima) para guardar.
  const estrellas = parseInt(e.target.value);
  // Marcar visualmente las N estrellas encendidas
  document.querySelectorAll('#meta-priority .prio-star').forEach(s => {
    const p = parseInt(s.dataset.prio);
    s.classList.toggle('active', p <= estrellas);
  });
  const labels = { 5: 'Crítica', 4: 'Alta', 3: 'Media', 2: 'Baja', 1: 'Mínima' };
  const lbl = document.getElementById('prio-label');
  if (lbl) lbl.textContent = labels[estrellas] || 'Media';
});

// Inicializar estrellas en valor 3 al cargar
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const checked = document.querySelector('#dlg-meta input[name="prioridad"]:checked');
    if (checked) checked.dispatchEvent(new Event('change', { bubbles: true }));
  }, 100);
});

// Selector de modo del chart en historial — solo aplica al renderer genérico
// (estado_global, grafico, resumen_anual, flujo_mensual). Para widgets con
// renderer custom el botón está oculto, pero hacemos el handler defensivo
// para no romper el chart custom si alguien fuerza el click.
document.addEventListener('click', (e) => {
  if (!e.target.matches('.hd-chart-mode')) return;
  if (_widgetRenderers[_hdState.widget]) return;
  document.querySelectorAll('.hd-chart-mode').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  _hdState.chartMode = e.target.dataset.mode;
  _hdRenderChart();
});

/* ================================================================
   Módulo: Importar Resumen Bancario PDF
   ================================================================ */

/**
 * Abre el diálogo de cotejo de resumen bancario, opcionalmente con una
 * tarjeta preseleccionada.
 * @param {string} [tarjetaIdPreseleccionado]
 */
// Estado del módulo de resumen bancario: lista de resúmenes procesados.
// Cada item: { resultado, tarjetaId, movimientos, aplicarFechas }
let _rsbStatements = [];
let _rsbBiasTarjeta = '';

function abrirImportResumen(tarjetaIdPreseleccionado) {
  const dlg = document.getElementById('dlg-resumen-bancario');
  if (!dlg) return;

  _rsbBiasTarjeta = tarjetaIdPreseleccionado || '';
  _rsbStatements = [];

  // Reset pasos
  document.getElementById('rsb-paso-0').hidden = false;
  document.getElementById('rsb-paso-1').hidden = true;
  document.getElementById('rsb-paso-2').hidden = true;

  const fileInput = document.getElementById('rsb-file');
  if (fileInput) fileInput.value = '';

  dlg.showModal();
}

/**
 * Adivina a qué tarjeta corresponde un resumen según el banco detectado.
 * Prioriza la tarjeta cuyo `banco`/`nombre` contenga la keyword del banco.
 * Si no hay match, usa la tarjeta del drawer (bias) o la primera activa.
 */
function _rsbAutoCard(banco) {
  const norm = s => (s || '').toUpperCase();
  const b = norm(banco);
  const tarjetas = state.tarjetas.filter(t => !t.deleted && t.activa !== false);
  const KEYS = ['MACRO', 'BBVA', 'GALICIA', 'SANTANDER', 'NACION', 'ICBC', 'HSBC', 'NARANJA', 'BRUBANK', 'UALA', 'CREDICOOP'];
  const key = KEYS.find(k => b.includes(k));
  if (key) {
    const m = tarjetas.find(t => norm(t.banco).includes(key) || norm(t.nombre).includes(key));
    if (m) return m.id;
  }
  return _rsbBiasTarjeta || tarjetas[0]?.id || '';
}

/**
 * Aplica las fechas reales de cierre/vencimiento del resumen a la tarjeta.
 * - Actualiza dia_cierre / dia_vencimiento (para futuros ciclos).
 * - Agrega/actualiza un ciclo_custom para el período exacto del resumen.
 */
async function _rsbAplicarFechasTarjeta(tarjetaId, resultado) {
  const t = state.tarjetas.find(x => x.id === tarjetaId);
  if (!t || !resultado.fechaCierre) return false;

  t.dia_cierre = parseInt(resultado.fechaCierre.slice(8, 10), 10);
  if (resultado.fechaVencimiento) {
    t.dia_vencimiento = parseInt(resultado.fechaVencimiento.slice(8, 10), 10);
  }
  if (!Array.isArray(t.ciclos_custom)) t.ciclos_custom = [];

  // Inserta/actualiza un ciclo_custom por período. cards.js sólo respeta el
  // ciclo si tiene inicio Y fin, así que ambos son obligatorios.
  const upsert = (ciclo) => {
    const idx = t.ciclos_custom.findIndex(c => c.periodo === ciclo.periodo);
    if (idx >= 0) t.ciclos_custom[idx] = { ...t.ciclos_custom[idx], ...ciclo };
    else t.ciclos_custom.push(ciclo);
  };

  // ── Ciclo del resumen ──────────────────────────────────────
  // Va desde el día siguiente al cierre anterior hasta el cierre actual; se
  // paga al vencimiento. Los bancos con cierre variable (BBVA: 28-May, luego
  // 02-Jul) necesitan estas fechas explícitas, no un "día de cierre" fijo.
  upsert({
    periodo: resultado.periodo,
    inicio: resultado.cierreAnterior ? _diaSiguiente(resultado.cierreAnterior) : _inicioMesAprox(resultado.fechaCierre),
    fin: resultado.fechaCierre,
    vencimiento: resultado.fechaVencimiento || null,
  });

  // ── Próximo ciclo ──────────────────────────────────────────
  // Del día siguiente al cierre actual hasta el próximo cierre; se paga al
  // próximo vencimiento. Deja el ciclo en curso listo antes de su resumen.
  if (resultado.proximoCierre) {
    upsert({
      periodo: resultado.proximoCierre.slice(0, 7),
      inicio: _diaSiguiente(resultado.fechaCierre),
      fin: resultado.proximoCierre,
      vencimiento: resultado.proximoVencimiento || null,
    });
  }

  await DB.put('tarjetas', t);
  return true;
}

/** Devuelve el día siguiente a una fecha ISO (YYYY-MM-DD), también en ISO. */
function _diaSiguiente(iso) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Aproxima el inicio del ciclo al día 1 del mes del cierre (sin cierre anterior). */
function _inicioMesAprox(isoCierre) {
  return isoCierre.slice(0, 8) + '01';
}

const _RSB_MESES = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const _rsbDdmm = (iso) => iso ? iso.split('-').reverse().join('/') : '—';

/**
 * Renderiza todos los resúmenes apilados en el paso 2 (scroll único).
 */
function _rsbRenderStatements() {
  const cont = document.getElementById('rsb-statements');
  if (!cont) return;

  const tarjetasOpts = state.tarjetas.filter(t => !t.deleted && t.activa !== false);

  cont.innerHTML = _rsbStatements.map((st, sidx) => {
    const r = st.resultado;
    const [anio, mes] = (r.periodo || '').split('-');
    const periodoLabel = (anio && mes) ? `${_RSB_MESES[parseInt(mes, 10)] || mes} ${anio}` : (r.periodo || '—');

    const nExacto   = st.movimientos.filter(m => m.confianza === 'exacto').length;
    const nProbable = st.movimientos.filter(m => m.confianza === 'probable').length;
    const nFaltante = st.movimientos.filter(m => m.confianza === 'no_encontrado').length;

    const opciones = tarjetasOpts.map(t =>
      `<option value="${t.id}" ${t.id === st.tarjetaId ? 'selected' : ''}>${escapeHtml(t.nombre)}</option>`
    ).join('');

    const filas = st.movimientos.length ? st.movimientos.map((mov, idx) => {
      const fechaFmt = _rsbDdmm(mov.fecha);
      const baseFmt = (mov.moneda && mov.moneda !== 'ARS')
        ? `${mov.moneda} ${mov.monto.toLocaleString('es-AR', { minimumFractionDigits: 2 })}`
        : FMT.format(mov.monto);
      // En cuotas, el resumen muestra la cuota mensual → lo marcamos como "/mes"
      const montoFmt = mov.cuotasTotal ? `${baseFmt}<small style="color:var(--ink-muted);font-weight:400">/mes</small>` : baseFmt;
      const esFaltante = mov.confianza === 'no_encontrado';
      const checkHtml = esFaltante
        ? `<input type="checkbox" class="rsb-mov-check" data-sidx="${sidx}" data-idx="${idx}" checked title="Seleccionado para cargar">`
        : `<span style="display:inline-block;width:16px"></span>`;
      const badge = mov.confianza === 'exacto'
        ? `<span class="rsb-mov-badge exacto">✓ Ya cargado</span>`
        : mov.confianza === 'probable'
          ? `<span class="rsb-mov-badge probable">⚠ Probable</span>`
          : `<span class="rsb-mov-badge faltante">➕ Cargar</span>`;
      const cuotaTag = mov.cuotasTotal
        ? `<span class="rsb-mov-cuota" title="Compra en cuotas">cuota ${mov.cuotaActual}/${mov.cuotasTotal}</span>`
        : '';
      return `
        <div class="rsb-mov-row" data-confianza="${mov.confianza}">
          ${checkHtml}
          <div class="rsb-mov-info">
            <span class="rsb-mov-fecha">${escapeHtml(fechaFmt)}${cuotaTag}</span>
            <span class="rsb-mov-desc" title="${escapeHtml(mov.descripcion)}">${escapeHtml(mov.descripcion)}</span>
          </div>
          <span class="rsb-mov-monto">${montoFmt}</span>
          ${badge}
        </div>`;
    }).join('') : `<div class="rsb-empty">No se detectaron consumos en este PDF.</div>`;

    return `
      <div class="rsb-statement" data-sidx="${sidx}">
        <div class="rsb-statement-head">
          <div class="rsb-statement-titlebar">
            <div class="rsb-statement-bank">
              <span class="rsb-statement-bankname">${escapeHtml(r.banco || 'Banco')}</span>
              <span class="rsb-statement-period">${escapeHtml(periodoLabel)}</span>
            </div>
            <select class="input rsb-statement-cardsel" data-sidx="${sidx}" title="Tarjeta asociada">
              ${opciones || '<option value="">Sin tarjetas</option>'}
            </select>
          </div>
          <div class="rsb-statement-meta">
            <span title="Cierre → Vencimiento">📅 ${_rsbDdmm(r.fechaCierre)} → ${_rsbDdmm(r.fechaVencimiento)}</span>
            ${r.saldoTotal ? `<span title="Saldo a pagar en pesos" class="brand">💳 ${FMT.format(r.saldoTotal)}</span>` : ''}
            ${r.saldoTotalUSD ? `<span title="Saldo a pagar en dólares">💵 US$ ${Math.abs(r.saldoTotalUSD).toLocaleString('es-AR', { minimumFractionDigits: 2 })}${r.saldoTotalUSD < 0 ? ' a favor' : ''}</span>` : ''}
            ${r.pagoMinimo ? `<span title="Pago mínimo">mín ${FMT.format(r.pagoMinimo)}</span>` : ''}
          </div>
          ${(r.validacion && !r.validacion.confiable) ? `
          <div class="rsb-aviso-dudoso" title="${escapeHtml(r.validacion.advertencias.join(' '))}">
            ⚠ Lectura dudosa: ${escapeHtml(r.validacion.advertencias[0] || 'los totales no reconcilian')} Revisá los consumos antes de cargar.
          </div>` : ''}
          <label class="rsb-statement-fechas">
            <input type="checkbox" class="rsb-aplicar-fechas" data-sidx="${sidx}" ${st.aplicarFechas ? 'checked' : ''}>
            Actualizar fechas de cierre/vencimiento de la tarjeta con este resumen
          </label>
          <div class="rsb-stats">
            <span class="rsb-stat-pill exacto">✓ ${nExacto} ya cargados</span>
            ${nProbable ? `<span class="rsb-stat-pill probable">⚠ ${nProbable} probables</span>` : ''}
            <span class="rsb-stat-pill faltante">➕ ${nFaltante} faltantes</span>
          </div>
        </div>
        <div class="rsb-statement-list">${filas}</div>
      </div>`;
  }).join('');

  // Re-cotejar al cambiar la tarjeta asociada
  cont.querySelectorAll('.rsb-statement-cardsel').forEach(sel => {
    sel.addEventListener('change', async () => {
      const sidx = parseInt(sel.dataset.sidx, 10);
      const st = _rsbStatements[sidx];
      if (!st) return;
      st.tarjetaId = sel.value;
      const { matchearConGastos } = await import('./pdf-statement-parser.js');
      st.movimientos = matchearConGastos(st.resultado.movimientos, state.gastos, st.tarjetaId);
      _rsbRenderStatements();
    });
  });

  // Toggle de aplicar fechas
  cont.querySelectorAll('.rsb-aplicar-fechas').forEach(cb => {
    cb.addEventListener('change', () => {
      const sidx = parseInt(cb.dataset.sidx, 10);
      if (_rsbStatements[sidx]) _rsbStatements[sidx].aplicarFechas = cb.checked;
    });
  });
}

/**
 * Registra todos los listeners del módulo de resumen bancario.
 * Se llama una sola vez durante el init de la app.
 */
function iniciarModuloResumenBancario() {
  // El acceso al cotejo de resúmenes ahora está centralizado en el diálogo
  // "Cargar documentos" (nav → Cargar PDF). Ver handlers de #docs-resumen.

  // ── Drop zone: click y drag-and-drop ────────────────────
  const dropzone = document.getElementById('rsb-dropzone');
  const fileInput = document.getElementById('rsb-file');

  dropzone?.addEventListener('click', () => fileInput?.click());
  dropzone?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
  });
  dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])].filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (files.length) _rsbProcesarArchivos(files);
    else toast('Por favor arrastrá uno o más archivos PDF', 2500);
  });

  // ── File input change ────────────────────────────────────
  fileInput?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    if (files.length) _rsbProcesarArchivos(files);
  });

  // ── Botón "Cargar faltantes" (de todos los resúmenes) ────
  document.getElementById('rsb-cargar-faltantes')?.addEventListener('click', async () => {
    const cont = document.getElementById('rsb-statements');
    // Recopilar movimientos seleccionados por statement
    const aCargar = []; // { mov, tarjetaId }
    cont?.querySelectorAll('.rsb-mov-check').forEach(cb => {
      if (!cb.checked) return;
      const sidx = parseInt(cb.dataset.sidx, 10);
      const idx  = parseInt(cb.dataset.idx, 10);
      const st = _rsbStatements[sidx];
      const mov = st?.movimientos?.[idx];
      if (st && mov && mov.confianza === 'no_encontrado') {
        aCargar.push({ mov, tarjetaId: st.tarjetaId });
      }
    });

    const aplicarFechas = _rsbStatements.filter(s => s.aplicarFechas && s.tarjetaId);

    if (!aCargar.length && !aplicarFechas.length) {
      toast('Nada para cargar ni fechas para actualizar', 2500);
      return;
    }

    const btn = document.getElementById('rsb-cargar-faltantes');
    btn.disabled = true;
    btn.textContent = '⏳ Guardando…';

    let guardados = 0, fechasOk = 0;
    try {
      for (const { mov, tarjetaId } of aCargar) {
        if (!tarjetaId) continue;
        const esCuota = !!mov.cuotasTotal;
        const g = {
          id: uuid(),
          fecha: mov.fecha,
          // El resumen muestra la CUOTA MENSUAL; el modelo guarda el TOTAL y lo
          // reparte entre los meses. Reconstruimos: total = cuota mensual × cantidad.
          monto: esCuota ? mov.monto * mov.cuotasTotal : mov.monto,
          moneda: mov.moneda || 'ARS',
          descripcion: mov.descripcion,
          categoria: 'general',
          metodo_pago: 'credito',
          tipo: esCuota ? 'cuotas' : 'unico',
          tarjeta_id: tarjetaId,
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (esCuota) { g.cuotas_total = mov.cuotasTotal; g.cuota_numero = mov.cuotaActual || 1; }
        await DB.put('gastos', g);
        guardados++;
      }
      // Aplicar fechas de ciclo a las tarjetas marcadas
      for (const st of aplicarFechas) {
        if (await _rsbAplicarFechasTarjeta(st.tarjetaId, st.resultado)) fechasOk++;
      }

      notificarCambioLocal();
      await reloadAll();

      const partes = [];
      if (guardados) partes.push(`${guardados} gasto${guardados > 1 ? 's' : ''} cargado${guardados > 1 ? 's' : ''}`);
      if (fechasOk)  partes.push(`${fechasOk} tarjeta${fechasOk > 1 ? 's' : ''} con fechas actualizadas`);
      toast('✓ ' + (partes.join(' · ') || 'Listo'), 3500);
      document.getElementById('dlg-resumen-bancario')?.close();
    } catch (err) {
      console.error('[rsb] Error al guardar:', err);
      toast('Error al guardar: ' + (err?.message || err), 3500);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cargar faltantes seleccionados';
    }
  });

  document.getElementById('rsb-cancelar')?.addEventListener('click', () => {
    document.getElementById('dlg-resumen-bancario')?.close();
  });
  document.getElementById('rsb-close-x')?.addEventListener('click', () => {
    document.getElementById('dlg-resumen-bancario')?.close();
  });

  // ── Procesar uno o varios PDFs ──────────────────────────
  async function _rsbProcesarArchivos(files) {
    document.getElementById('rsb-paso-0').hidden = true;
    document.getElementById('rsb-paso-1').hidden = false;
    document.getElementById('rsb-paso-2').hidden = true;

    const progresoTxt = document.getElementById('rsb-progreso-txt');
    _rsbStatements = [];

    try {
      const { parsearResumenTarjeta, matchearConGastos } = await import('./pdf-statement-parser.js');

      for (let i = 0; i < files.length; i++) {
        progresoTxt.textContent = files.length > 1
          ? `Procesando resumen ${i + 1} de ${files.length}…`
          : 'Extrayendo movimientos…';
        try {
          const resultado = await parsearResumenTarjeta(files[i]);
          const tarjetaId = _rsbAutoCard(resultado.banco);
          const movimientos = matchearConGastos(resultado.movimientos, state.gastos, tarjetaId);
          _rsbStatements.push({ resultado, tarjetaId, movimientos, aplicarFechas: !!resultado.fechaCierre });
        } catch (errFile) {
          console.error(`[rsb] Error en ${files[i].name}:`, errFile);
          toast(`No se pudo leer ${files[i].name}`, 3000);
        }
      }

      if (!_rsbStatements.length) {
        document.getElementById('rsb-paso-1').hidden = true;
        document.getElementById('rsb-paso-0').hidden = false;
        toast('No se pudo procesar ningún PDF. Verificá que sean resúmenes de tarjeta.', 4000);
        return;
      }

      document.getElementById('rsb-paso-1').hidden = true;
      document.getElementById('rsb-paso-2').hidden = false;
      _rsbRenderStatements();

      const fi = document.getElementById('rsb-file');
      if (fi) fi.value = '';
    } catch (err) {
      console.error('[rsb] Error procesando PDFs:', err);
      document.getElementById('rsb-paso-1').hidden = true;
      document.getElementById('rsb-paso-0').hidden = false;
      toast('No se pudo procesar: ' + (err?.message || String(err)), 4000);
      const fi = document.getElementById('rsb-file');
      if (fi) fi.value = '';
    }
  }
}
