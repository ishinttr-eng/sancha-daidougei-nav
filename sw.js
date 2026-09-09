// Service Worker: VERSIONを上げるとactivate時に旧キャッシュを一括削除する。
// データだけ変えてもUIの見た目は変わらないため、UI変更時は必ずVERSIONを上げること。
const VERSION = "v1";
const CACHE_NAME = `sancha-daidougei-${VERSION}`;

const APP_SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "css/style.css",
  "js/app.js",
  "js/store.js",
  "js/util.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => cache.put(url, res))
            .catch(() => {})
        )
      );
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 地図タイルはキャッシュ対象外（容量対策）
  if (url.hostname.includes("tile.openstreetmap.org")) return;

  // /data/ 配下: ネットワーク優先、失敗時のみキャッシュにフォールバック
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // アプリシェル・地図ライブラリ: キャッシュ優先
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
