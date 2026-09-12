// ============================================================
// Service worker
//
//   目的只有兩個：讓它可以「安裝」成 app，以及沒網路時還打得開。
//   **不是為了加速**——這個 app 的瓶頸在 Supabase 的查詢，不在靜態檔。
//
//   策略一律是 network-first，不是 cache-first。這是刻意的：
//   cache-first 會讓使用者更新程式之後還跑舊版，而且是那種
//   「清了瀏覽器快取也沒用、要自己去反註冊 service worker」的卡法。
//   一個每天要看部位的工具卡在舊版，比慢 200ms 嚴重得多。
//   所以：有網路就一定拿新的，順手存一份；沒網路才拿存的那一份。
//
//   **絕對不碰 Supabase 的請求。** 那些是使用者的部位與交易紀錄，
//   存進 Cache Storage 等於把個人資料落地在裝置上，而且 POST/RPC
//   本來就不該被快取。下面用網域白名單，只收自己的檔案與 CDN。
// ============================================================

const VERSION = 'am-2026-09-12b';
const SHELL = 'shell-' + VERSION;

// 只快取這幾個來源。其餘（Supabase、證交所……）一律直接走網路。
const CACHEABLE_HOSTS = new Set([self.location.host, 'cdn.jsdelivr.net']);

self.addEventListener('install', (e) => {
  // 只放首頁，其餘等真的被要求時再進快取。
  // 列一份完整的 app shell 清單看起來比較週到，但那份清單
  // 每次新增模組都要記得改，忘了就是離線開起來少一塊。
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(['./', './index.html']))
      .catch(() => {})          // 裝不起來也不要卡住安裝
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (!CACHEABLE_HOSTS.has(url.host)) return;      // Supabase 等等：完全不插手
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return;

  // 帶參數的首頁（?go=trade 這種捷徑）不另外存一份。
  // 存了的話離線開首頁會拿到「?go=trade」那一版，一進去就自己彈出交易表單。
  // 網址列的參數是一次性的動作，不是一個要被快取的頁面。
  const isNav = req.mode === 'navigate';
  const skipStore = isNav && url.search !== '';

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      // 只存成功的回應。把 404 或 500 存進去，離線時就會拿到一個壞掉的檔案
      if (res && res.ok && !skipStore) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      // 導覽時忽略查詢字串再找一次，?go=… 進來也拿得到快取的首頁
      const hit = await caches.match(req, isNav ? { ignoreSearch: true } : undefined);
      if (hit) return hit;
      if (isNav) {
        const home = await caches.match('./index.html');
        if (home) return home;
      }
      throw err;
    }
  })());
});
