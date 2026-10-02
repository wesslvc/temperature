// 앱 셸만 캐시하고 데이터(/api)는 항상 네트워크에서 가져온다 (오프라인이면 마지막 화면 껍데기만 표시)
const CACHE = 'orion-room-v2';
const SHELL = ['/', '/icon.svg?v=2', '/manifest.webmanifest', '/icons/icon-192.png?v=2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // 화면(HTML)은 네트워크 우선 — 새 배포가 바로 반영되도록, 실패하면 캐시
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { caches.open(CACHE).then((c) => c.put('/', r.clone())); return r; }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })));
});
