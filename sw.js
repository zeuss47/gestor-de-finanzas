/**
 * sw.js — Service Worker
 * ----------------------
 * Estrategias:
 *
 *  1. INSTALL: precache del shell (HTML, CSS, JS, manifest).
 *  2. FETCH:
 *       - Navegación HTML -> Network-first con fallback al shell cacheado
 *         (modo offline: muestra la app sin recargar).
 *       - Assets estáticos (js/css/png/svg) -> Cache-first.
 *       - API de GitHub (api.github.com) -> Network-only, sin cache, para
 *         no servir datos viejos.
 *  3. SYNC (Background Sync): cuando el navegador detecta que recuperaste
 *     conectividad, dispara la tarea "sync-data". Aquí avisamos al cliente
 *     que ejecute syncAll() (el SW no tiene acceso directo al PAT del
 *     usuario porque vive en IndexedDB; pero sí puede abrir IndexedDB y
 *     publicar un mensaje al cliente).
 *  4. NOTIFICATIONCLICK: enfoca/abre la PWA y, si el payload contiene
 *     una ruta de acción, la pasa por la querystring.
 */

const VERSION = 'v3.2.0-pages';
const SHELL_CACHE = `shell-${VERSION}`;

// Base scope dinámico: el SW se registra en su propio directorio,
// así funciona igual en localhost que en /usuario.github.io/repo/.
const BASE = new URL(self.registration.scope).pathname;

const SHELL_FILES = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'css/styles.css',
  BASE + 'js/app.js',
  BASE + 'js/db.js',
  BASE + 'js/cards.js',
  BASE + 'js/sync.js',
  BASE + 'js/ai-local.js',
  BASE + 'js/ai-predict.js',
  BASE + 'js/notifications.js',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  // CDN externos (cache-first del navegador):
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
];

/* ---------- INSTALL ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(async (cache) => {
      // addAll falla si un solo recurso falla; usamos add individual con catch.
      await Promise.all(
        SHELL_FILES.map((u) => cache.add(u).catch((e) => console.warn('precache miss', u, e)))
      );
      self.skipWaiting();
    })
  );
});

/* ---------- ACTIVATE ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();

    // Habilitar navigation preload si está disponible (acelera la primera nav)
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
  })());
});

/* ---------- FETCH ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Ignorar esquemas no-HTTP (chrome-extension://, moz-extension://, etc.)
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // No tocamos la API de GitHub: siempre online para datos frescos.
  if (url.hostname === 'api.github.com') return;

  // Navegación: network-first, fallback shell.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        const net = await fetch(request);
        return net;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(BASE + 'index.html')) || (await cache.match(BASE));
      }
    })());
    return;
  }

  // CSS y JS: network-first para que siempre se vea la última versión.
  // Solo se usa caché si la red falla (modo offline real).
  if (['style', 'script'].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const net = await fetch(request, { cache: 'no-store' });
        if (net.ok && net.type === 'basic') cache.put(request, net.clone());
        return net;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    })());
    return;
  }

  // Imágenes y fuentes: cache-first (no cambian con frecuencia)
  if (['image', 'font'].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const net = await fetch(request);
        if (net.ok && net.type === 'basic') cache.put(request, net.clone());
        return net;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});

/* ---------- BACKGROUND SYNC ---------- */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'sync-data') return;
  event.waitUntil(triggerClientSync());
});

/**
 * No podemos invocar syncAll() directamente desde el SW (depende de import
 * dinámico y de variables sólo accesibles al cliente). En su lugar enviamos
 * un mensaje a TODOS los clients activos para que ejecuten la sync.
 * Si no hay clientes vivos, lo intentamos al próximo arranque.
 */
async function triggerClientSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length === 0) return;
  clients.forEach(c => c.postMessage({ type: 'TRIGGER_SYNC' }));
}

/* ---------- PERIODIC SYNC (opcional, soportado en Android Chrome) ---------- */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'daily-card-check') {
    event.waitUntil(triggerClientSync());
  }
});

/* ---------- NOTIFICATION CLICK ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let path = '/';
  if (data.kind === 'tarjeta') path = '/?focus=tarjetas';
  else if (data.kind === 'ia') path = '/?focus=ia';

  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // Si ya hay una ventana abierta, la enfocamos.
      if ('focus' in c) {
        try {
          c.postMessage({ type: 'NOTIFICATION_OPEN', data });
          return c.focus();
        } catch {}
      }
    }
    return self.clients.openWindow(path);
  })());
});

/* ---------- MENSAJES DESDE EL CLIENTE ---------- */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
