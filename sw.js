// FlockLab Service Worker
// 目的只有一个：装成应用之后，冷启动不必等网络——静态壳走「先给缓存、后台更新」，
// 三个 CDN 依赖（版本号写死在 URL 里，内容不会再变）走「缓存优先」，
// 断网时导航请求退回缓存里的 index.html。
//
// 缓存策略刻意选「stale-while-revalidate」而不是「cache-first」：
// 前者最多落后一个版本（第二次打开就是新的），后者会让改了代码的页面一直发不出去。

// 缓存代次：跟产品版本走。每次发版改这一行，旧缓存在新 SW 激活时整批清掉，
// 装成应用的用户重开一次就能拿到新代码（不依赖 stale-while-revalidate 的第二次刷新）。
const VER = 'v1.4.22';
const CACHE = `flocklab-${VER}`;

// 应用壳：离线也必须能起来
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/main.js',
  './js/forces.js',
  './js/sim-worker.js',
  './js/version.js',
  './js/audio.js',
  './js/grass.js',
  './js/backdrop.js',
  './assets/logo.svg',
  './assets/favicon.ico',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './manifest.json'
];

// CDN 依赖：离线时同样要能加载，否则 module 直接 import 失败、整页白屏
const CDN = [
  'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js',
  'https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/dist/lil-gui.esm.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个 add：任何一个失败都不该让整次 install 挂掉（CDN 被墙时也要能装）
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await Promise.all(CDN.map((u) => cache.add(new Request(u, { mode: 'cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// 先给缓存、同时后台拉新。没有缓存就走网络。
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  if (hit) { net; return hit; }
  const res = await net;
  return res || new Response('', { status: 504, statusText: 'offline' });
}

// CDN：URL 里带版本号 → 内容不可变 → 缓存优先
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

// 导航：网络优先，断了就回缓存里的壳（单页应用只有这一个入口）
async function navigateFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put('./index.html', res.clone()).catch(() => {});
    return res;
  } catch (_) {
    return (await cache.match('./index.html')) || (await cache.match('./'))
      || new Response('离线，且缓存里没有页面。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (req.mode === 'navigate') { event.respondWith(navigateFirst(req)); return; }
  if (url.origin === self.location.origin) { event.respondWith(staleWhileRevalidate(req)); return; }
  event.respondWith(cacheFirst(req));
});
