// SnapFlow Service Worker — handles background push notifications
const CACHE = 'snapflow-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// ── PUSH NOTIFICATION HANDLER ──
self.addEventListener('push', e => {
  if (!e.data) return;

  let data;
  try { data = e.data.json(); }
  catch { data = { title: 'SnapFlow', body: e.data.text() }; }

  const title   = data.title || 'SnapFlow';
  const options = {
    body:    data.body  || 'You have a new notification',
    icon:    '/icon.png',
    badge:   '/icon.png',
    tag:     data.type  || 'snapflow',
    renotify: true,
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/', from: data.from || null },
    actions: data.type === 'message' ? [
      { action: 'open',    title: '💬 Open' },
      { action: 'dismiss', title: 'Dismiss' }
    ] : [
      { action: 'open',    title: '👀 View' },
      { action: 'dismiss', title: 'Dismiss' }
    ]
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;

  const url = e.notification.data?.url || '/';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // If app already open, focus it
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new tab
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── NOTIFICATION CLOSE ──
self.addEventListener('notificationclose', e => {
  // Optional analytics tracking here
});
