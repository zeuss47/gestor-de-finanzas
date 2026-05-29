/**
 * sync.js
 * -------
 * Sincronización directa con la API REST de GitHub (sin pasar por backend).
 * Implementa pull + merge LWW + push para los archivos de datos definidos
 * en ARCHIVOS (espeja database.py -> ARCHIVOS_SYNC).
 *
 * Endpoints GitHub:
 *   GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
 *   PUT /repos/{owner}/{repo}/contents/{path}     (requiere sha si existía)
 *
 * Encoding: GitHub devuelve el contenido en base64. Hay que convertir
 * usando atob/btoa con UTF-8 safe (TextEncoder/Decoder).
 *
 * Conflictos: misma estrategia que el backend (mergePorTimestamp).
 */

import { DB } from './db.js';

const GITHUB_API = 'https://api.github.com';

const ARCHIVOS = {
  gastos:   'gastos.json',
  ingresos: 'ingresos.json',
  tarjetas: 'tarjetas.json',
  cuentas:  'cuentas.json',
  metas:    'metas.json',
};
// "ajustes" NO se sincroniza con GitHub: contiene el PAT y otros datos locales.

/* ---------- Base64 UTF-8 safe ---------- */
function toB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => bin += String.fromCharCode(b));
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------- Merge LWW espejo del backend ---------- */
export function mergePorTimestamp(locales, remotos) {
  const idx = new Map();
  for (const r of locales) if (r && r.id) idx.set(r.id, r);
  for (const r of remotos) {
    if (!r || !r.id) continue;
    const loc = idx.get(r.id);
    if (!loc) { idx.set(r.id, r); continue; }
    const a = r.updated_at || 0;
    const b = loc.updated_at || 0;
    if (a >= b) idx.set(r.id, r);  // empate -> remoto (convención)
  }
  return [...idx.values()];
}

/* ---------- HTTP helper ---------- */
async function gh(method, url, cfg, body) {
  const headers = {
    'Authorization': `token ${cfg.pat}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  if (r.status === 404) return null;
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`GitHub ${method} ${url} -> ${r.status}: ${txt}`);
  }
  return r.json();
}

function urlArchivo(cfg, archivo) {
  const path = `${cfg.ruta_datos || 'data'}/${archivo}`;
  return `${GITHUB_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
}

/* ---------- Pull individual ---------- */
async function pullArchivo(cfg, archivo) {
  const url = `${urlArchivo(cfg, archivo)}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
  const data = await gh('GET', url, cfg);
  if (!data) return { items: [], sha: null };
  try {
    const json = JSON.parse(fromB64(data.content));
    return { items: json.items || [], sha: data.sha };
  } catch {
    return { items: [], sha: data.sha };
  }
}

/* ---------- Push individual ---------- */
async function pushArchivo(cfg, archivo, items, shaPrevio, mensaje) {
  const cuerpo = {
    schema_version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    items,
  };
  const body = {
    message: mensaje || `sync(${archivo}) ${items.length} items`,
    content: toB64(JSON.stringify(cuerpo, null, 2)),
    branch: cfg.branch || 'main',
  };
  if (shaPrevio) body.sha = shaPrevio;
  const res = await gh('PUT', urlArchivo(cfg, archivo), cfg, body);
  return res.content.sha;
}

/* ---------- Estado de la última sync ---------- */
const STATE_KEY = 'sync_state'; // se guarda dentro de ajustes para no tocar el schema

async function getState() {
  const aj = await DB.get('ajustes', 'ajustes_globales');
  return (aj && aj._sync_state) || {};
}
async function setState(patch) {
  const aj = (await DB.get('ajustes', 'ajustes_globales')) || { id: 'ajustes_globales' };
  aj._sync_state = { ...(aj._sync_state || {}), ...patch };
  await DB.put('ajustes', aj);
}

/* ---------- SYNC orquestada (pull -> merge -> push si hubo cambios) ---------- */
export async function syncAll(cfg, { onProgress } = {}) {
  if (!cfg || !cfg.pat || !cfg.owner || !cfg.repo) {
    throw new Error('Configurá GitHub PAT/owner/repo en Ajustes.');
  }

  const resultados = {};
  for (const [store, archivo] of Object.entries(ARCHIVOS)) {
    onProgress?.(`Pull ${archivo}…`);
    const { items: remotos, sha } = await pullArchivo(cfg, archivo);
    const locales = await DB.all(store);
    const merged = mergePorTimestamp(locales, remotos);

    // Persistimos el merge en local
    onProgress?.(`Merge ${archivo}…`);
    await DB.clear(store);
    if (merged.length) await DB.bulkPut(store, merged);

    // Subir SIEMPRE que detectemos diferencias (más simple y robusto que
    // calcular hashes; el merge ya es idempotente).
    onProgress?.(`Push ${archivo}…`);
    const nuevoSha = await pushArchivo(cfg, archivo, merged, sha);
    resultados[archivo] = { count: merged.length, sha: nuevoSha };
  }

  await setState({ last_sync_ts: Math.floor(Date.now() / 1000), last_ok: true });
  return resultados;
}

/* ---------- Pull-only (útil para arranque inicial) ---------- */
export async function pullAll(cfg) {
  if (!cfg?.pat) throw new Error('Sin PAT configurado.');
  for (const [store, archivo] of Object.entries(ARCHIVOS)) {
    const { items: remotos } = await pullArchivo(cfg, archivo);
    const locales = await DB.all(store);
    const merged = mergePorTimestamp(locales, remotos);
    await DB.clear(store);
    if (merged.length) await DB.bulkPut(store, merged);
  }
  await setState({ last_pull_ts: Math.floor(Date.now() / 1000) });
}

/* ---------- Helpers para SW (background sync) ---------- */
export async function flushQueueAndSync(cfg) {
  // Los cambios ya están en IndexedDB (escritura local instantánea), así que
  // basta con disparar syncAll. La cola sync_queue está reservada para
  // operaciones que SÍ necesitan red (ej. notificaciones push remotas).
  return syncAll(cfg);
}

export { ARCHIVOS };

/* ============================================================
   AUTO-SYNC: orquestador automático multi-dispositivo
   ============================================================

   Estrategias combinadas:

   1. SYNC INICIAL: al abrir la app, si hay config GitHub válida
      → ejecuta syncAll() para traer cambios remotos al instante.

   2. SYNC PERIÓDICO: timer cada N minutos (default 5min).
      → mantiene la app fresca mientras el usuario la tiene abierta.

   3. SYNC AL CAMBIO (debounce): cuando el usuario edita algo,
      esperar 30s de inactividad antes de hacer push.
      → evita saturar GitHub con un PR por cada tecla.

   4. SYNC AL VOLVER ONLINE: listener navigator.onLine.
      → si estuviste offline y volvió la red, sincroniza.

   5. SYNC AL CERRAR/MINIMIZAR: visibilitychange = hidden.
      → asegura que tus cambios suban antes de cerrar.

   Todo lo orquesta startAutoSync(cfg, callbacks). El llamador
   recibe eventos vía callbacks para actualizar UI (sidebar dot,
   timestamp, errores) sin que sync.js conozca el DOM.
   ============================================================ */

let _autoSyncState = {
  timer: null,
  pendingPush: null,
  cfg: null,
  callbacks: null,
  inflightPromise: null,
  intervalMs: 5 * 60_000, // 5 minutos default
  debounceMs: 30_000,     // 30 segundos
};

/**
 * Inicia el sistema de auto-sync. Cancela cualquier instancia previa.
 * @param {Object} cfg - { pat, owner, repo, branch, ruta_datos }
 * @param {Object} callbacks - { onStart, onSuccess, onError, onProgress }
 * @param {Object} options - { intervalMs, debounceMs, syncAlInicio: true }
 */
export function startAutoSync(cfg, callbacks = {}, options = {}) {
  stopAutoSync(); // limpiar instancia previa

  if (!cfg?.pat || !cfg?.owner || !cfg?.repo) {
    // Sin config válida: no arrancar pero no fallar
    return false;
  }

  _autoSyncState.cfg = cfg;
  _autoSyncState.callbacks = callbacks;
  if (options.intervalMs) _autoSyncState.intervalMs = options.intervalMs;
  if (options.debounceMs) _autoSyncState.debounceMs = options.debounceMs;

  // 1. Sync inicial (si corresponde)
  if (options.syncAlInicio !== false) {
    // Lanzar después de un breve delay para no bloquear el render inicial
    setTimeout(() => triggerSync('inicial'), 1500);
  }

  // 2. Timer periódico
  _autoSyncState.timer = setInterval(() => {
    triggerSync('periodico');
  }, _autoSyncState.intervalMs);

  // 4. Volver a online
  window.addEventListener('online', _onOnline);

  // 5. Visibilitychange (cerrar/minimizar)
  document.addEventListener('visibilitychange', _onVisChange);

  return true;
}

export function stopAutoSync() {
  if (_autoSyncState.timer) clearInterval(_autoSyncState.timer);
  if (_autoSyncState.pendingPush) clearTimeout(_autoSyncState.pendingPush);
  window.removeEventListener('online', _onOnline);
  document.removeEventListener('visibilitychange', _onVisChange);
  _autoSyncState.timer = null;
  _autoSyncState.pendingPush = null;
  _autoSyncState.inflightPromise = null;
}

/**
 * Programa un push diferido por debounce. Cancela el push anterior si
 * el usuario sigue editando. Cuando expira el timeout sin más cambios,
 * hace sync.
 */
export function programarPush() {
  if (!_autoSyncState.cfg) return;
  if (_autoSyncState.pendingPush) clearTimeout(_autoSyncState.pendingPush);
  _autoSyncState.pendingPush = setTimeout(() => {
    triggerSync('debounce');
  }, _autoSyncState.debounceMs);
}

/**
 * Dispara una sync ahora mismo (de-duplicando concurrentes).
 * Si hay una sync en vuelo, espera esa misma promesa.
 */
export function triggerSync(motivo = 'manual') {
  if (!_autoSyncState.cfg) return Promise.resolve(null);
  if (!navigator.onLine) {
    _autoSyncState.callbacks?.onError?.(new Error('offline'), motivo);
    return Promise.resolve(null);
  }
  // Dedup: si hay una sync en curso, devolverla
  if (_autoSyncState.inflightPromise) return _autoSyncState.inflightPromise;

  _autoSyncState.callbacks?.onStart?.(motivo);

  _autoSyncState.inflightPromise = (async () => {
    try {
      const result = await syncAll(_autoSyncState.cfg, {
        onProgress: (m) => _autoSyncState.callbacks?.onProgress?.(m, motivo),
      });
      _autoSyncState.callbacks?.onSuccess?.(result, motivo);
      return result;
    } catch (e) {
      _autoSyncState.callbacks?.onError?.(e, motivo);
      throw e;
    } finally {
      _autoSyncState.inflightPromise = null;
    }
  })();

  return _autoSyncState.inflightPromise;
}

/** Devuelve el timestamp Unix de la última sync exitosa. */
export async function ultimaSync() {
  const st = await getState();
  return st.last_sync_ts || null;
}

function _onOnline() {
  triggerSync('online');
}

function _onVisChange() {
  if (document.visibilityState === 'hidden') {
    // No await: el usuario está cerrando, no podemos bloquear.
    // Pero sí intentamos disparar.
    triggerSync('hidden').catch(() => {});
  }
}
