/* ==========================================================================
   Suivi PEA — service worker
   Stratégie « stale-while-revalidate » : l'appli s'ouvre instantanément
   depuis le cache (hors ligne compris) et se met à jour en arrière-plan.
   Pensez à incrémenter VERSION (ici et dans app.js) à chaque modification.
   ========================================================================== */
const VERSION = '1.1.1'; // garder identique à APP_VERSION dans app.js (vérifié par les tests)
const CACHE = 'suivi-pea-v' + VERSION;

// Chemins relatifs : fonctionne aussi sous https://<user>.github.io/<depot>/
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// Supprime les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Cours (data/*.json) : réseau d'abord, cache si hors ligne
  if (new URL(req.url).pathname.includes('/data/')) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        fetch(req)
          .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
          .catch(() => cache.match(req, { ignoreSearch: true }).then((r) => r || new Response('', { status: 504 })))
      )
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      // ignoreSearch : « ./?source=pwa » sert la même page
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }
      const res = await network;
      if (res) return res;
      // Hors ligne et rien en cache : on renvoie la page principale pour les navigations
      if (req.mode === 'navigate') return cache.match('./index.html');
      return new Response('', { status: 504, statusText: 'Hors ligne' });
    })
  );
});
