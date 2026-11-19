/* ClassSync OBEC — Service Worker for iPadOS / iOS / Android / Desktop Web Push & Offline Shell */

const CACHE_NAME = 'classsync-shell-v12';
const URLS_TO_CACHE = [
  '/',
  '/manifest.json',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          URLS_TO_CACHE.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] Precache skipped for', url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Handle standard Web Push API events (works when iPadOS Safari PWA is closed or force-swiped)
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || 'แจ้งเตือนตารางเรียน';
  const options = {
    body: data.body || 'ถึงเวลาเข้าเรียนตามตารางของคุณแล้ว',
    icon: data.icon || '/pwa-192x192.png',
    badge: data.badge || '/pwa-192x192.png',
    tag: data.tag || 'classsync-alert',
    renotify: true,
    requireInteraction: false,
    vibrate: [220, 100, 220],
    actions: [
      { action: 'snooze-5m', title: 'เลื่อนเตือน 5 นาที' },
      { action: 'open-app', title: 'เปิดดูตารางเรียน' }
    ],
    data: {
      url: data.url || '/',
      userId: data.userId || '',
      title: title,
      body: data.body || '',
      allowSnooze: data.allowSnooze !== false
    }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Handle notification interaction & Snooze 5 minutes
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};

  if (event.action === 'snooze-5m') {
    const snoozeTitle = notifData.title || 'แจ้งเตือนตารางเรียน (เลื่อนเตือน)';
    const snoozeBody = notifData.body || 'ครบกำหนดเวลาเลื่อนเตือน 5 นาทีแล้ว';
    const userId = notifData.userId || '';

    const snoozeWork = Promise.resolve()
      .then(() => {
        if (!userId) return null;
        return fetch('/api/push/snooze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId,
            title: snoozeTitle,
            body: snoozeBody,
            delaySeconds: 300
          })
        }).catch((err) => {
          console.warn('[SW] Server snooze failed, using local fallback:', err);
          return null;
        });
      })
      .then(() =>
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
          for (const client of windowClients) {
            client.postMessage({
              type: 'CLASSSYNC_SNOOZE_5M',
              title: snoozeTitle,
              body: snoozeBody,
              snoozeUntil: Date.now() + 300000
            });
          }
        })
      );

    event.waitUntil(snoozeWork);
    return;
  }

  const urlToOpen = notifData.url
    ? new URL(notifData.url, self.location.origin).href
    : new URL('/', self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const windowClient of windowClients) {
        if (windowClient.url.startsWith(self.location.origin) && 'focus' in windowClient) {
          return windowClient.focus();
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});

// Auto-renew Web Push subscription if Safari / Chrome rotates push endpoints
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/api/push/vapidPublicKey');
        const json = await res.json();
        const publicKey = json.publicKey;
        if (!publicKey) return;

        const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
        const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
          outputArray[i] = rawData.charCodeAt(i);
        }

        const newSub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: outputArray
        });

        const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          client.postMessage({
            type: 'PUSH_SUBSCRIPTION_CHANGED',
            subscription: JSON.parse(JSON.stringify(newSub))
          });
        }
      } catch (err) {
        console.warn('[SW] pushsubscriptionchange handler error:', err);
      }
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.location.origin)) {
    return;
  }

  const reqUrl = event.request.url;
  if (
    reqUrl.includes('/api/') ||
    reqUrl.includes('firebase') ||
    reqUrl.includes('firestore') ||
    reqUrl.includes('googleapis') ||
    reqUrl.includes('__vite')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const networkFetch = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('/');
          }
          return cachedResponse || Response.error();
        });

      return cachedResponse || networkFetch;
    })
  );
});
