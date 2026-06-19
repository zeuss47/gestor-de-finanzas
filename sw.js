/**
 * sw.js — Service Worker
 * ----------------------
 * Estrategias:
 *
 *  1. INSTALL: precache del shell (HTML, CSS, JS, manifest). NO hace skipWaiting:
 *     el SW nuevo queda en "waiting" hasta que el cliente mande SKIP_WAITING.
 *  2. FETCH:
 *       - Navegacion HTML -> Network-first con fallback al shell cacheado.
 *       - Assets estaticos (js/css/png/svg) -> Cache-first.
 *       - version.json / changelog.json -> Network-first sin cache (detectar updates).
 *       - API de GitHub (api.github.com) -> Network-only, sin cache.
 *  3. SYNC (Background Sync): al recuperar conectividad dispara "sync-data" y
 *     avisa al cliente que ejecute syncAll() (el SW no accede al PAT).
 *  4. MESSAGE SKIP_WAITING: el cliente decide cuando activar el SW nuevo.
 */

const VERSION = 'v3.3.0-pages-b118';
const SHELL_CACHE = `shell-${VERSION}`;

// Base scope dinamico: el SW se registra en su propio directorio,
// asi funciona igual en localhost que en /usuario.github.io/repo/.
const BASE = new URL(self.registration.scope).pathname;

const SHELL_FILES = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'version.json',
  BASE + 'changelog.json',
  BASE + 'css/styles.css',
  BASE + 'css/desktop.css',
  BASE + 'css/mobile.css',
  BASE + 'css/tailwind.css',
  BASE + 'js/app.js',
  BASE + 'js/db.js',
  BASE + 'js/cards.js',
  BASE + 'js/sync.js',
  BASE + 'js/ai-local.js',
  BASE + 'js/ai-predict.js',
  BASE + 'js/ai-advisor.js',
  BASE + 'js/notifications.js',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  // CDN externos (cache-first del navegador):
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
      // NO se llama a skipWaiting aqui: el SW nuevo queda "waiting" hasta que el
      // cliente confirme la actualizacion (mensaje SKIP_WAITING).
    })
  );
});

/* ---------- ACTIVATE ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();

    // Habilitar navigation preload si esta disponible (acelera la primera nav)
    if ('navigationPreload' in self.registration) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
  })());
});

/* ---------- FETCH ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!request.url.startsWith('http')) return;
  const url = new URL(request.url);

  // GitHub API: network-only, sin tocar cache (datos siempre frescos).
  if (url.hostname === 'api.github.com') return;

  // Navegacion HTML: network-first con fallback al shell cacheado (offline).
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

  // version.json / changelog.json: network-first sin cache, para detectar
  // actualizaciones al instante (cae al cache solo si no hay red).
  if (url.pathname.endsWith('version.json') || url.pathname.endsWith('changelog.json')) {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() =>
      caches.open(SHELL_CACHE).then(c => c.match(request)) ));
    return;
  }

  // Scripts y estilos: network-first con cache de respaldo.
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

  // Imagenes y fuentes: stale-while-revalidate.
  if (['image', 'font'].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(request);
      const fetchPromise = fetch(request).then((net) => {
        if (net.ok && net.type === 'basic') cache.put(request, net.clone());
        return net;
      }).catch(() => null);
      return cached || (await fetchPromise) || Response.error();
    })());
    return;
  }
});

/* ---------- BACKGROUND SYNC ---------- */
self.addEventListener('sync', (event) => {
  if (event.tag !== 'sync-data') return;
  event.waitUntil(triggerClientSync());
});

async function triggerClientSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length === 0) return;
  clients.forEach(c => c.postMessage({ type: 'TRIGGER_SYNC' }));
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'daily-card-check') {
    event.waitUntil(triggerClientSync());
  }
});

/* ---------- NOTIFICACIONES ---------- */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let path = '/';
  if (data.kind === 'tarjeta') path = '/?focus=tarjetas';
  else if (data.kind === 'ia') path = '/?focus=ia';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
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

/* ---------- MENSAJES DEL CLIENTE ---------- */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
