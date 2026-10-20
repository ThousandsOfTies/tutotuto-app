self.addEventListener('notificationclick', event => {
  if (event.notification.tag !== 'tutotuto-time-limit') return;
  event.notification.close();
  event.waitUntil((async () => {
    const scope = new URL(self.registration.scope);
    const target = new URL(event.notification.data?.url || 'manage.html', scope);
    if (target.origin !== scope.origin || !target.pathname.startsWith(scope.pathname)) return;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url === target.href);
    if (existing) await existing.focus();
    else await self.clients.openWindow(target.href);
  })());
});
