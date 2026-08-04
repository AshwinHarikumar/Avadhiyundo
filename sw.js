/* അവധിയുണ്ടോ? — offline shell
 *
 * The shell is cached so a dead connection still shows the last answer that
 * reached the phone. The DATA is deliberately network-first: a silently stale
 * verdict is the most dangerous thing this product can show. When the network
 * fails we fall back to the cached copy, and app.js states its age out loud.
 */

var CACHE = "krhw-v31";

var SHELL = [
  "./",
  "./index.html",
  "./app.css?v=31",
  "./app.js?v=31",
  "./logo.png",
  "./manifest.webmanifest"
];

/* The data is fetched again at install: the worker only starts controlling
   after the first load has already fetched it, so without this the very first
   offline visit would have a shell and no verdict. */
var DATA = ["./data/status.js", "./data/history.js"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL)
        .catch(function () { /* a missing shell entry must not block install */ })
        .then(function () {
          return Promise.all(DATA.map(function (u) {
            return fetch(u, { cache: "no-store" })
              .then(function (r) { return r && r.ok ? c.put(u, r) : null; })
              .catch(function () { /* history.js is optional */ });
          }));
        });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Never serve a cached verdict while the network can supply a fresher one. */
  if (url.pathname.indexOf("/data/") > -1 || url.pathname.indexOf("/api/") > -1) {
    e.respondWith(
      fetch(req, { cache: "no-store" })
        .then(function (res) {
          if (res && res.ok && url.pathname.indexOf("/data/") > -1) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || Response.error();
          });
        })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (hit) {
      /* Stale-while-revalidate: return cache immediately if available, then update in background. */
      if (hit) {
        fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
        }).catch(function () { /* offline, silently skip update */ });
        return hit;
      }
      /* No cache hit: fetch from network. */
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        /* A navigation with no cache entry still deserves the shell. */
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});

self.addEventListener("push", function (e) {
  if (!e.data) return;
  var payload = e.data.json();
  var tag = payload.district + "|" + payload.forDate;
  e.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./logo.png",
      tag: tag,
      requireInteraction: false,
      data: { url: "./" }
    })
  );
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window" }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf(self.location.origin) > -1 && "focus" in list[i]) {
          return list[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(e.notification.data.url);
    })
  );
});
