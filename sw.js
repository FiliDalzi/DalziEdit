// ============================================================
//  DalziEdit — Service Worker
//  v1.0.0
//  Strategie: Cache-First per asset statici, Network-First per
//  risorse dinamiche, Background Sync per auto-salvataggio.
// ============================================================

const CACHE_NAME = 'dalziedit-v1.0.0';
const RUNTIME_CACHE = 'dalziedit-runtime-v1';
const FONT_CACHE = 'dalziedit-fonts-v1';

// Asset da pre-cachare all'installazione (App Shell)
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Pattern di font da Google Fonts da cachare separatamente
const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

// ===================== INSTALL =====================
self.addEventListener('install', event => {
  console.log('[DalziEdit SW] Installing v1.0.0...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[DalziEdit SW] Pre-caching app shell');
        return cache.addAll(PRECACHE_ASSETS);
      })
      .then(() => {
        console.log('[DalziEdit SW] Install complete — skip waiting');
        return self.skipWaiting();
      })
      .catch(err => {
        console.warn('[DalziEdit SW] Pre-cache failed (some assets may be missing):', err);
        return self.skipWaiting();
      })
  );
});

// ===================== ACTIVATE =====================
self.addEventListener('activate', event => {
  console.log('[DalziEdit SW] Activating...');
  event.waitUntil(
    Promise.all([
      // Pulisci vecchie cache
      caches.keys().then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name =>
              name !== CACHE_NAME &&
              name !== RUNTIME_CACHE &&
              name !== FONT_CACHE
            )
            .map(name => {
              console.log('[DalziEdit SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        )
      ),
      // Prendi controllo di tutti i client immediatamente
      self.clients.claim(),
    ]).then(() => {
      console.log('[DalziEdit SW] Active — controlling all clients');
      // Notifica tutti i client dell'aggiornamento
      return self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(client =>
          client.postMessage({
            type: 'SW_ACTIVATED',
            version: '1.0.0',
            message: 'DalziEdit aggiornato alla v1.0.0 — ricarica per le novità!',
          })
        )
      );
    })
  );
});

// ===================== FETCH =====================
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignora richieste non-GET e richieste di estensioni browser
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.protocol === 'moz-extension:') return;

  // Font Google → Cache-First con fallback rete
  if (FONT_ORIGINS.some(origin => request.url.startsWith(origin))) {
    event.respondWith(fontCacheStrategy(request));
    return;
  }

  // Blob URL (video importati) → passa direttamente
  if (url.protocol === 'blob:') return;

  // Data URL → passa direttamente
  if (url.protocol === 'data:') return;

  // App Shell (HTML, JS, CSS, manifest) → Cache-First + aggiornamento background
  if (
    url.origin === self.location.origin &&
    (
      request.destination === 'document' ||
      request.destination === 'script' ||
      request.destination === 'style' ||
      request.destination === 'manifest' ||
      request.url.endsWith('.html') ||
      request.url.endsWith('.json') ||
      request.url.endsWith('.js') ||
      request.url.endsWith('.css')
    )
  ) {
    event.respondWith(cacheFirstWithUpdate(request));
    return;
  }

  // Icone e immagini statiche → Cache-First
  if (
    request.destination === 'image' ||
    request.url.includes('/icons/')
  ) {
    event.respondWith(cacheFirstStrategy(request, RUNTIME_CACHE));
    return;
  }

  // Tutto il resto → Network-First con fallback cache
  event.respondWith(networkFirstStrategy(request));
});

// ===================== STRATEGIE DI CACHE =====================

/**
 * Cache-First: cerca in cache, poi rete. Aggiorna la cache in background.
 */
async function cacheFirstWithUpdate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // Aggiornamento in background (stale-while-revalidate)
  const fetchPromise = fetch(request)
    .then(networkResponse => {
      if (networkResponse && networkResponse.status === 200) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch(() => null);

  return cached || fetchPromise || offlineFallback(request);
}

/**
 * Cache-First puro — ottimo per asset che cambiano raramente.
 */
async function cacheFirstStrategy(request, cacheName = CACHE_NAME) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    return offlineFallback(request);
  }
}

/**
 * Network-First: prova la rete, in caso di errore usa la cache.
 */
async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    return cached || offlineFallback(request);
  }
}

/**
 * Strategia font: cache-first con TTL lungo (30 giorni).
 */
async function fontCacheStrategy(request) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch {
    // Font non disponibile offline — il browser userà fallback
    return new Response('', { status: 503 });
  }
}

/**
 * Risposta offline di fallback.
 */
async function offlineFallback(request) {
  // Se è una navigazione → serve l'HTML dall'App Shell
  if (request.destination === 'document' || request.mode === 'navigate') {
    const cache = await caches.open(CACHE_NAME);
    return cache.match('./index.html') || cache.match('./') || offlineHTML();
  }
  return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
}

/**
 * HTML di fallback quando tutto il resto fallisce.
 */
function offlineHTML() {
  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DalziEdit — Offline</title>
  <style>
    body { margin:0; background:#0a0a0f; color:#f0f0f8; font-family:system-ui,sans-serif;
           display:flex; align-items:center; justify-content:center; height:100vh; flex-direction:column; gap:16px; }
    .logo { font-size:48px; }
    h1 { font-size:24px; font-weight:700; margin:0; }
    p { color:#9090b0; font-size:14px; text-align:center; max-width:300px; }
    button { padding:10px 24px; background:#7c6fff; border:none; border-radius:8px;
             color:#fff; font-size:14px; cursor:pointer; margin-top:8px; }
  </style>
</head>
<body>
  <div class="logo">✂</div>
  <h1>DalziEdit</h1>
  <p>Sei offline. Riconnettiti a internet per usare l'editor.</p>
  <button onclick="location.reload()">Riprova</button>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ===================== BACKGROUND SYNC =====================
self.addEventListener('sync', event => {
  console.log('[DalziEdit SW] Background sync:', event.tag);

  if (event.tag === 'autosave-project') {
    event.waitUntil(handleAutoSave());
  }
});

async function handleAutoSave() {
  try {
    // Recupera dati salvati nel DB locale dal client
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client =>
      client.postMessage({ type: 'TRIGGER_AUTOSAVE' })
    );
    console.log('[DalziEdit SW] Auto-save triggered');
  } catch (err) {
    console.error('[DalziEdit SW] Auto-save failed:', err);
  }
}

// ===================== PUSH NOTIFICATIONS =====================
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'DalziEdit', body: event.data.text() }; }

  const options = {
    body: data.body || 'Aggiornamento disponibile',
    icon: './icons/icon-192.png',
    badge: './icons/icon-72.png',
    vibrate: [100, 50, 100],
    data: { url: data.url || './' },
    actions: [
      { action: 'open', title: 'Apri' },
      { action: 'dismiss', title: 'Ignora' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'DalziEdit', options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// ===================== MESSAGGI DAL CLIENT =====================
self.addEventListener('message', event => {
  const { type, payload } = event.data || {};

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'CACHE_URLS':
      if (Array.isArray(payload)) {
        event.waitUntil(
          caches.open(RUNTIME_CACHE).then(cache => cache.addAll(payload))
        );
      }
      break;

    case 'CLEAR_CACHE':
      event.waitUntil(
        Promise.all([
          caches.delete(CACHE_NAME),
          caches.delete(RUNTIME_CACHE),
          caches.delete(FONT_CACHE),
        ]).then(() => {
          event.source?.postMessage({ type: 'CACHE_CLEARED' });
        })
      );
      break;

    case 'GET_CACHE_SIZE':
      event.waitUntil(
        getCacheSize().then(size => {
          event.source?.postMessage({ type: 'CACHE_SIZE', payload: size });
        })
      );
      break;

    default:
      break;
  }
});

// ===================== UTILITIES =====================
async function getCacheSize() {
  let total = 0;
  const cacheNames = await caches.keys();
  await Promise.all(
    cacheNames.map(async name => {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      await Promise.all(
        keys.map(async key => {
          const response = await cache.match(key);
          if (response) {
            const blob = await response.blob();
            total += blob.size;
          }
        })
      );
    })
  );
  return total;
}

console.log('[DalziEdit SW] Service Worker loaded — DalziEdit v1.0.0');