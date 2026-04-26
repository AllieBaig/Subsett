const VERSION = 'subliminal-v7'; // Increment for update
const CACHE_NAME = `subliminal-player-${VERSION}`;

// Core assets that MUST be available for the app to start
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
];

// Nature sounds are pre-cached to ensure they work in airplane mode
const NATURE_SOUNDS_ASSETS = [
  'https://assets.mixkit.co/sfx/preview/mixkit-light-rain-loop-2393.mp3',
  'https://assets.mixkit.co/sfx/preview/mixkit-ocean-waves-loop-1196.mp3',
  'https://assets.mixkit.co/sfx/preview/mixkit-forest-birds-ambience-loop-1210.mp3',
  'https://assets.mixkit.co/sfx/preview/mixkit-wind-whistle-loop-1159.mp3',
  'https://assets.mixkit.co/sfx/preview/mixkit-campfire-crackling-loop-1144.mp3',
  'https://assets.mixkit.co/sfx/preview/mixkit-river-flowing-water-loop-1195.mp3',
];

const PRECACHE_ASSETS = [...STATIC_ASSETS, ...NATURE_SOUNDS_ASSETS];

// Offline-first: Pre-cache core assets
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching core system assets');
      return Promise.allSettled(
        PRECACHE_ASSETS.map(asset => 
          fetch(asset, { mode: 'no-cors', cache: 'reload' }).then(response => {
            if (response.type === 'opaque' || response.ok) {
              return cache.put(asset, response);
            }
          }).catch(err => console.warn(`[SW] Pre-cache failed for ${asset}:`, err))
        )
      );
    })
  );
});

// Activate: Cleanup and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('subliminal-player-') && name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Purging stale cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Logic: Strictly Cache-First with Network Update (SWR)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') {
    // Handle Share Target
    if (event.request.method === 'POST' && url.pathname === '/share-target') {
      event.respondWith(
        (async () => {
          try {
            const formData = await event.request.formData();
            const audioFiles = formData.getAll('audio_files');
            if (audioFiles.length > 0) {
              const cache = await caches.open('shared-files');
              for (let i = 0; i < audioFiles.length; i++) {
                const file = audioFiles[i];
                const response = new Response(file);
                const headers = new Headers(response.headers);
                headers.set('x-filename', encodeURIComponent(file.name));
                const responseWithMeta = new Response(file, { headers });
                await cache.put(`/shared-files/temp-${i}`, responseWithMeta);
              }
              return Response.redirect('/?shared-count=' + audioFiles.length, 303);
            }
          } catch (err) {
            console.error('[SW] Share-target error:', err);
          }
          return Response.redirect('/', 303);
        })()
      );
    }
    return;
  }

  // Bypass for some specific things if needed (e.g. dev server HMR - though HMR is usually disabled)
  if (url.pathname.startsWith('/@vite') || url.pathname.includes('hot-update')) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // CACHE-FIRST strategy
      if (cachedResponse) {
        // Kick off a background update for non-static assets
        if (navigator.onLine) {
          fetch(event.request).then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              const cache = caches.open(CACHE_NAME);
              cache.then(c => c.put(event.request, networkResponse.clone()));
            }
          }).catch(() => {}); // Silent failure for background update
        }
        return cachedResponse;
      }

      // Fallback to network
      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const isLocal = url.origin === self.location.origin;
          const isFont = url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com');
          const isImage = url.pathname.match(/\.(png|jpg|jpeg|svg|gif|webp)$/);
          const isAudio = url.pathname.match(/\.(mp3|wav|m4a|aac)$/);
          const isJSorCSS = url.pathname.match(/\.(js|css)$/);

          if (isLocal || isFont || isImage || isAudio || isJSorCSS) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
        }
        return networkResponse;
      }).catch((err) => {
        // Network failed and no cache
        console.warn(`[SW] Offline fallback trigger for ${url.pathname}`);
        
        // Return blank index.html for navigation or blank if asset
        if (event.request.mode === 'navigate') {
          return caches.match('/');
        }
        return null;
      });
    })
  );
});
