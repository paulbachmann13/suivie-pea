/* ==========================================================================
   Suivi PEA — service worker
   - Fichiers de l'appli : servis depuis le cache de LEUR version (hors ligne
     compris). Pas de mise à jour en arrière-plan fichier par fichier : on
     évite ainsi de mélanger l'index.html d'une version et l'app.js d'une autre.
   - Une nouvelle version arrive quand VERSION change : le nouveau service
     worker télécharge tout d'un bloc, puis remplace l'ancien.
   - Cours (data/*.json) : réseau d'abord, cache si hors ligne.
   Pensez à incrémenter VERSION (ici et dans app.js) à chaque modification.
   ========================================================================== */
const VERSION = '1.2.1'; // garder identique à APP_VERSION dans app.js (vérifié par les tests)
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
  // cache: 'reload' : on ignore le cache HTTP (10 min sur GitHub Pages) pour que
  // la nouvelle version installe bien les nouveaux fichiers, pas d'anciennes copies
  const fresh = ASSETS.map((url) => new Request(url, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
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
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch (e) {
        // Hors ligne : on renvoie la page principale pour les navigations
        if (req.mode === 'navigate') return cache.match('./index.html');
        return new Response('', { status: 504, statusText: 'Hors ligne' });
      }
    })
  );
});
