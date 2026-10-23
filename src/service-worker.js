// BASE/CACHE/FILES are injected by the build. Push is displayed by the worker,
// not a page timer, so delivery does not depend on Safari remaining active.
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch {}
  event.waitUntil(self.registration.showNotification(String(data.title || 'WEDX · Отдых закончен').slice(0, 100), {
    body: String(data.body || 'Можно начинать следующий подход.').slice(0, 200),
    tag: String(data.tag || 'wedx-rest').slice(0, 100), renotify: false,
    icon: BASE + 'icon-180.png', data: { url: BASE },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => {
      const url = new URL(client.url); return url.origin === self.location.origin && url.pathname.startsWith(BASE);
    });
    if (existing) { await existing.focus(); existing.postMessage({ type: 'OPEN_WORKOUT' }); }
    else await self.clients.openWindow(BASE);
  })());
});
