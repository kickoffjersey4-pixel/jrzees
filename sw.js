const CACHE_NAME = 'jrzees-v3.8.0';
const STATIC_ASSETS = [
  '/',
  '/css/style.css?v=3.8.0',
  '/js/app.js?v=3.8.0'
];

// Install — skip waiting, take control immediately
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  // Jersey images (Yupoo and any image) — CacheFirst, immutable for 1y
  // First visit: network fetch ~ slow, store in CacheStorage. Next visit: cache hit instant.
  // New jersey = new URL → cache miss → network. Old URLs stay cached.
  if (
    url.hostname.includes('yupoo.com') ||
    url.hostname.includes('photo.') ||
    (url.pathname.match(/\.(png|jpg|jpeg|webp|avif|svg)$/i) && !url.pathname.includes('api'))
  ) {
    e.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((res) => {
              // Only cache successful (including opaque 0)
              if (res && (res.ok || res.type === 'opaque')) {
                cache.put(req, res.clone());
              }
              return res;
            })
            .catch(() => cached);
        })
      )
    );
    return;
  }

  // API: NetworkFirst with cache fallback — so newly added jerseys appear, but second visit still fast if offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Cache successful GET api responses for 5 min
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // CSS/JS/logo — CacheFirst (versioned via ?v=, so new deploy = new URL)
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/images/')
  ) {
    e.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        })
      )
    );
  }
});
