self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  // 这是 PWA 标准所强制要求的最基础网络拦截器
  // 我们使用直接放行（Network Only）策略，不破坏你现有 WebSocket 的连接
  e.respondWith(fetch(e.request));
});