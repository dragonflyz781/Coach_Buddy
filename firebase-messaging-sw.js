/* Coach Buddy - push service worker (v25)
   Lives next to index.html, so on GitHub Pages it is /Coach_Buddy/firebase-messaging-sw.js with the scope
   /Coach_Buddy/ (registered by js/push.js). It ONLY shows pushes and opens the app when one is tapped:
   no caching / offline handling, so it can never serve an old copy of the app.
   The Cloud Functions send "data" messages: { title, body, tag, link, open, day, thread }. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; } catch (e) { p = { data: { body: event.data ? event.data.text() : "" } }; }
  const d = p.data || {}, n = p.notification || {};
  const title = d.title || n.title || "Coach Buddy";
  const opts = {
    body: d.body || n.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/badge-96.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,                        // a newer change to the same duty replaces the old one, and still buzzes
    vibrate: [180, 90, 180],
    timestamp: Date.now(),
    data: { link: d.link || "./", open: d.open || "", day: d.day || "", thread: d.thread || "" }
  };
  event.waitUntil(self.registration.showNotification(title, opts));   // always visible (iOS / Chrome require it)
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.link || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (w) {
      w.postMessage({ type: "rt-push-open", open: data.open, day: data.day, thread: data.thread });
      try { await w.focus(); } catch (e) { /* ignore */ }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
