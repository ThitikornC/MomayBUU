// ================= Cache / Offline =================
const CACHE_NAME = 'momay-cache-vB3';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/style.css?v=2.8.3',
  '/script.js?v=2.8.3',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Add debug logs to trace service worker lifecycle
console.log('Service Worker Loaded');

// ---------------- Install ----------------
self.addEventListener('install', event => {
  console.log('Service Worker Installed');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(err => console.error('❌ Cache install failed:', err))
  );
});

// ---------------- Activate ----------------
self.addEventListener('activate', event => {
  console.log('Service Worker Activated');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ---------------- Fetch ----------------
const API_PATHS = ['/daily-energy', '/solar-size', '/daily-bill'];
self.addEventListener('fetch', event => {
  console.log('Service Worker Fetch Event:', event.request.url);
  const requestUrl = new URL(event.request.url);

  if (event.request.method !== 'GET' || !['http:', 'https:'].includes(requestUrl.protocol)) return;

  if (API_PATHS.some(path => requestUrl.pathname.includes(path))) {
    // Network-first สำหรับ API
    event.respondWith(
      fetch(event.request)
        .then(resp => resp.ok ? resp : caches.match(event.request))
        .catch(() => caches.match(event.request) ||
          new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' } })
        )
    );
    return;
  }

  // Cache-first สำหรับ static files
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(networkResp => {
          // Clone response before using it
          const responseToCache = networkResp.clone();
          if (networkResp && networkResp.ok) {
            caches.open(CACHE_NAME)
              .then(cache => cache.put(event.request, responseToCache))
              .catch(err => console.warn('❌ Cache put failed:', err));
          }
          return networkResp;
        })
        .catch(err => {
          console.warn('❌ Fetch failed:', err);
          if (event.request.mode === 'navigate') return caches.match('/index.html');
          return new Response('', { status: 504, statusText: 'offline' });
        })
    })
  );
});

// ================= Push Notification =================
self.addEventListener('push', event => {
  let data = { title: 'Energy Notification', body: 'แจ้งเตือนการใช้ไฟฟ้าสูงสุดใหม่', url: '/' };
  if (event.data) {
    try { data = event.data.json(); } catch (e) { console.error('❌ Push data parse error', e); }
  }

  const options = {
    body: data.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options).then(() => {
      // ส่ง message ไปหน้าเว็บให้ popup แสดง
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        clients.forEach(client => {
          client.postMessage({ type: 'dailyPopup', payload: data });
        });
      });
    })
  );
});

// ---------------- Notification Click ----------------
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const url = new URL(event.notification.data.url, self.location.origin).href;
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ---------------- Push Subscription Change ----------------
self.addEventListener('pushsubscriptionchange', async event => {
  console.log('🔄 Push subscription changed');
  const applicationServerKey = urlBase64ToUint8Array('BB2fZ3NOzkWDKOi8H5jhbwICDTv760wIB6ZD2PwmXcUA_B5QXkXtely4b4JZ5v5b88VX1jKa7kRfr94nxqiksqY');
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
      .then(newSub => fetch('https://momaydocbn-production.up.railway.app/api/subscribe', {
        method: 'POST',
        body: JSON.stringify(newSub),
        headers: { 'Content-Type': 'application/json' }
      }))
  );
});

// ---------------- Utility ----------------
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

// ---------------- Daily Peak Notification ----------------
self.addEventListener('message', event => {
  if (event.data) {
    if (event.data.type === 'NEW_DAILY_PEAK') {
      const { power } = event.data;

      // Notification for New Daily Peak with rounded value
      self.registration.showNotification('⚡ New Daily Peak!', {
        body: `Peak Power: ${power.toFixed(2)} kW`,
        icon: '/icons/peak-icon.png',
        badge: '/icons/peak-badge.png',
        vibrate: [300, 100, 300],
        tag: 'daily-peak-notification',
        renotify: true
      });
    } else if (event.data.type === 'DAILY_ENERGY_REPORT') {
      const { date, energy_kwh, electricity_bill, rate_per_kwh } = event.data;

      // Notification for Daily Energy Report with rounded values
      self.registration.showNotification('💰 Daily Energy Report', {
        body: `Date: ${date}\nEnergy: ${energy_kwh.toFixed(2)} kWh\nBill: ${electricity_bill.toFixed(2)} ฿\nRate: ${rate_per_kwh.toFixed(2)} ฿/kWh`,
        icon: '/icons/energy-report-icon.png',
        badge: '/icons/energy-report-badge.png',
        vibrate: [200, 100, 200],
        tag: 'daily-energy-report-notification',
        renotify: true
      });
    }
  }
});
