// Offline support: the app shell is cached; same-origin requests go network-first so updates arrive,
// Google Fonts and Bombo flyers are cache-first (flyers live in their own cache that survives updates).
var CACHE = "comisiones-v64";
var FLYERS = "comisiones-flyers";
var SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== FLYERS; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // the API, the event reader and the public RRPP pages always go straight to the server
    if (/^\/(api\/|lector|eventos\/)/.test(url.pathname)) return;
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) { return hit || caches.match("./index.html"); });
    }));
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    }));
    return;
  }

  if (["files.wearebombo.com", "storage.googleapis.com", "images.venti.live", "d26en73i7b5aju.cloudfront.net", "www.passline.com", "cdn.getcrowder.com", "static.get-in.com", "flashpass.s3.us-east-1.amazonaws.com"].indexOf(url.hostname) >= 0 && /\.(jpe?g|png|webp|gif)$|\/events\/|user-images/i.test(url.pathname)) {
    e.respondWith(caches.open(FLYERS).then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { c.put(req, res.clone()); return res; });
      });
    }));
  }
});
