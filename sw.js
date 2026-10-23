// عامل خدمة منصة انسياب: يخزن واجهة التطبيق فقط ليفتح بسرعة ويُثبَّت كتطبيق.
// لا يخزن أي بيانات مرور أو طقس أو خرائط: كل طلبات /api والمصادر الخارجية تمر إلى الشبكة دائمًا،
// حتى لا تُعرض بيانات متقادمة بوصفها حية. عند انقطاع الشبكة تعرض الواجهة أخطاء المصادر كما هي.
const CACHE = 'ansiyab-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/vendor/mapbox-gl-rtl-text.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // الصفحة: الشبكة أولًا ثم النسخة المخزنة. الملفات ذات البصمة (/assets): المخزن أولًا.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })),
    );
  }
});
