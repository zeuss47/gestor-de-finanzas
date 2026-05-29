/**
 * db.js
 * -----
 * Capa fina sobre IndexedDB. Proporciona promesas sobre los stores definidos
 * en database.py (INDEXEDDB_SCHEMA). El objetivo es que el resto del frontend
 * use exclusivamente esta API y nunca toque IDBTransaction directamente.
 *
 * Stores:
 *   gastos      keyPath=id      indexes: fecha, tarjeta_id, categoria, updated_at
 *   ingresos    keyPath=id      indexes: fecha, periodo_aplicacion, updated_at
 *   tarjetas    keyPath=id      indexes: nombre, updated_at
 *   metas       keyPath=id      indexes: prioridad, updated_at
 *   ajustes     keyPath=id      (singleton: id="ajustes_globales")
 *   sync_queue  keyPath=qid     autoIncrement (cola para background sync)
 */

const DB_NAME = 'gestor_finanzas_db';
const DB_VERSION = 2;

const SCHEMA = {
  gastos:     { keyPath: 'id', indexes: ['fecha', 'tarjeta_id', 'cuenta_id', 'categoria', 'updated_at'] },
  ingresos:   { keyPath: 'id', indexes: ['fecha', 'periodo_aplicacion', 'cuenta_id', 'categoria', 'updated_at'] },
  tarjetas:   { keyPath: 'id', indexes: ['nombre', 'updated_at'] },
  cuentas:    { keyPath: 'id', indexes: ['nombre', 'tipo', 'updated_at'] },
  metas:      { keyPath: 'id', indexes: ['prioridad', 'updated_at'] },
  ajustes:    { keyPath: 'id' },
  sync_queue: { keyPath: 'qid', autoIncrement: true },
};

let _dbPromise = null;

function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = ev.target.transaction;
      for (const [name, def] of Object.entries(SCHEMA)) {
        let store;
        if (db.objectStoreNames.contains(name)) {
          // Store ya existe → reusar para agregar índices nuevos
          store = tx.objectStore(name);
        } else {
          const opts = def.autoIncrement
            ? { keyPath: def.keyPath, autoIncrement: true }
            : { keyPath: def.keyPath };
          store = db.createObjectStore(name, opts);
        }
        // Crear índices nuevos sin tirar los existentes
        (def.indexes || []).forEach(ix => {
          if (!store.indexNames.contains(ix)) {
            store.createIndex(ix, ix, { unique: false });
          }
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function _tx(storeName, mode = 'readonly') {
  return _openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function _wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- API de uso ---------- */
export const DB = {
  async put(store, obj) {
    // Auto-actualiza updated_at antes de escribir (clave del LWW merge).
    if (!('updated_at' in obj)) obj.updated_at = Math.floor(Date.now() / 1000);
    obj.updated_at = Math.floor(Date.now() / 1000);
    const s = await _tx(store, 'readwrite');
    return _wrap(s.put(obj));
  },

  async bulkPut(store, items) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const s = tx.objectStore(store);
      items.forEach(it => s.put(it));
      tx.oncomplete = () => resolve(items.length);
      tx.onerror = () => reject(tx.error);
    });
  },

  async get(store, id) {
    const s = await _tx(store);
    return _wrap(s.get(id));
  },

  async all(store) {
    const s = await _tx(store);
    return _wrap(s.getAll());
  },

  /**
   * Soft delete: marca el registro como deleted=true y actualiza el sello.
   * Esto permite que el merge propague el borrado a otras réplicas.
   */
  async softDelete(store, id) {
    const cur = await this.get(store, id);
    if (!cur) return null;
    cur.deleted = true;
    cur.updated_at = Math.floor(Date.now() / 1000);
    return this.put(store, cur);
  },

  async hardDelete(store, id) {
    const s = await _tx(store, 'readwrite');
    return _wrap(s.delete(id));
  },

  async clear(store) {
    const s = await _tx(store, 'readwrite');
    return _wrap(s.clear());
  },

  /**
   * Devuelve sólo registros vivos (deleted !== true).
   */
  async live(store) {
    const items = await this.all(store);
    return items.filter(x => !x.deleted);
  },

  /* ---- sync queue: para Background Sync del Service Worker ---- */
  async enqueue(op) {
    return this.put('sync_queue', { ...op, ts: Date.now() });
  },
  async drainQueue() {
    const items = await this.all('sync_queue');
    await this.clear('sync_queue');
    return items;
  },
};

/* ---------- UUIDv4 ---------- */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // Fallback para navegadores antiguos
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowTs() { return Math.floor(Date.now() / 1000); }
