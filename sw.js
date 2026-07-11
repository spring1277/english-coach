/* English Coach 서비스워커 — 네트워크 우선 (항상 최신 코드), 오프라인 시 캐시 폴백 */
const CACHE = "ec-v2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // CDN·API는 브라우저 기본 동작
  e.respondWith(
    // cache: "no-cache" — HTTP 캐시(GitHub Pages max-age=600)를 우회해 서버에 재검증,
    // 배포하면 폰에서도 즉시 최신 파일을 받는다 (변경 없으면 304라 데이터 부담 없음)
    fetch(req.url, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
