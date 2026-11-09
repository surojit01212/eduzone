"use strict";

// App update korle shudhu ei version number ta barao (v12 -> v13)
const CACHE = "eduzone-v26";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) {
        // One missing file must never break the install, so files are added one by one.
        // cache:"reload" makes sure a new version never copies an old browser-cached file.
        return Promise.all(SHELL.map(function (u) {
          return c.add(new Request(u, { cache: "reload" })).catch(function () { /* skip */ });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Cache first (fast on slow phones, works offline). Database calls are never touched.
self.addEventListener("fetch", function (e) {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== location.origin && url.hostname !== "www.gstatic.com") return;

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(req)
        .then(function (res) {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () {
          if (req.mode === "navigate") {
            return caches.match("index.html").then(function (p) { return p || Response.error(); });
          }
          return Response.error();
        });
    })
  );
});