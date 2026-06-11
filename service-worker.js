self.addEventListener("install", event => {
  event.waitUntil(
    caches.open("ptt-field-logger-v0.2.1").then(cache => {
      return cache.addAll([
        "./",
        "./index.html",
        "./app.js",
        "./style.css",
        "./manifest.json",
        "./icon.svg"
      ]);
    })
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
