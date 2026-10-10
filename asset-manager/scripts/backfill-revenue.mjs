// 月營收歷史回補（一次性）
//
// 為什麼需要：`refresh_revenue()` 走證交所/櫃買的 openapi，那個端點只給「當月」，
// payload 裡附帶的「上月」與「去年當月」已經被寫進去了，所以每次公告只能貢獻三個月份。
// 結果是 revenue 表只會從「它看過的公告」累積 —— 2026-10 時只有 11506–11508 與 11407–11408
// 五個月份，YoY 只有兩個月算得出來，而且完全無法判斷季節性或「是不是歷史新高」。
//
// 2026-10-08 和碩九月營收月增 143.2% 那次就踩到了：用 5 列資料推論「歷史新高」，
// 而實際上 2025-09 就有 1,149 億、2023-09 有 1,328 億，都高於表裡的最大值 913 億。
// 把月增當成驚喜，其實一半是季節性（2025-09 的月增就有 +74.5%）。
//
// 來源：公開資訊觀測站的月營收彙總檔，一個（市場 × 民國年 × 月）一個 HTML。
//   https://mopsov.twse.com.tw/nas/t21/sii/t21sc03_<ROC年>_<月>_0.html   上市
//   https://mopsov.twse.com.tw/nas/t21/otc/t21sc03_<ROC年>_<月>_0.html   上櫃
// 注意 mops.twse.com.tw（新網域）這個路徑是 404，要用 mopsov。
// 資料庫端抓上櫃歷史會 SSL 失敗（見 prices.sql 第 837 行的註解），所以走 Node。
//
// 欄位對位有陷阱：表頭 10 個欄名，但資料列從第 5 欄之後就偏一格
//   （台泥 [6] 是 98,726,969，表頭說是「去年同月增減(%)」，其實是「當月累計營收」）。
// 這支只取 [0] 代號、[1] 名稱、[2] 當月營收 —— 全部在偏移點之前，所以安全。
// 解析結果已對過資料庫現有的 11508（台泥/台光電/和碩/國巨/京元電/華新科 六檔全部吻合）。
//
// 寫入一律 `on conflict (symbol, ym) do nothing`：純新增，不碰任何既有列。
// industry 留空，`stock_detail.sql` 取產業別時有 `industry is not null` 過濾，不受影響。
//
// 用法：node scripts/backfill-revenue.mjs [起始ROC年月] [結束ROC年月]
//   預設回補 11209 ~ 11508（36 個月）。
//   產出 /tmp/revenue-backfill-NN.sql，再用 supabase-sql.mjs 套用（它自己讀權杖，
//   憑證不會出現在命令列）。

import fs from 'fs';
import path from 'path';
import os from 'os';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0' };
const THROTTLE_MS = 1200;          // 對 MOPS 客氣一點
const CHUNK_ROWS = 4000;           // 每個 .sql 檔的列數上限

const argFrom = process.argv[2] || '11209';
const argTo = process.argv[3] || '11508';

// 民國年月字串（如 '11508'）↔ 序號
const toIdx = (ym) => {
  const y = Number(String(ym).slice(0, -2));
  const m = Number(String(ym).slice(-2));
  return y * 12 + (m - 1);
};
const toYm = (idx) => {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}${String(m).padStart(2, '0')}`;
};

const months = [];
for (let i = toIdx(argFrom); i <= toIdx(argTo); i++) months.push(toYm(i));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cell = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const sq = (s) => String(s).replace(/'/g, "''");

async function fetchMonth(market, ym) {
  const y = String(ym).slice(0, -2);
  const m = Number(String(ym).slice(-2));
  const url = `https://mopsov.twse.com.tw/nas/t21/${market}/t21sc03_${y}_${m}_0.html`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return { url, status: r.status, rows: [] };
  const buf = Buffer.from(await r.arrayBuffer());
  let html = buf.toString('utf8');
  if (!/公司代號/.test(html)) html = new TextDecoder('big5').decode(buf);
  const rows = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cell(x[1]));
    if (c.length < 3) continue;
    if (!/^[0-9]{4,6}[A-Z]?$/.test(c[0])) continue;      // 代號欄
    const amt = c[2].replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(amt)) continue;           // 當月營收欄
    if (!c[1]) continue;
    rows.push({ symbol: c[0].toUpperCase(), name: c[1], amount: Number(amt) });
  }
  return { url, status: r.status, rows };
}

const all = [];
let fail = 0;
for (const ym of months) {
  for (const market of ['sii', 'otc']) {
    await sleep(THROTTLE_MS);
    try {
      const { status, rows } = await fetchMonth(market, ym);
      if (!rows.length) { fail++; console.log(`  ${ym} ${market}  HTTP ${status}  0 列 ← 失敗或無資料`); continue; }
      for (const r of rows) all.push({ ...r, ym });
      console.log(`  ${ym} ${market}  ${rows.length} 列`);
    } catch (e) {
      fail++;
      console.log(`  ${ym} ${market}  例外 ${e.message}`);
    }
  }
}

console.log(`\n共 ${all.length} 列、${months.length} 個月份、失敗 ${fail} 次`);
if (!all.length) process.exit(1);

// 同一個 (symbol, ym) 可能在上市/上櫃都出現（轉上市那種），去重保留第一筆
const seen = new Set();
const uniq = all.filter((r) => {
  const k = `${r.symbol}|${r.ym}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
console.log(`去重後 ${uniq.length} 列`);

const outDir = os.tmpdir();
const files = [];
for (let i = 0, n = 0; i < uniq.length; i += CHUNK_ROWS, n++) {
  const chunk = uniq.slice(i, i + CHUNK_ROWS);
  const values = chunk
    .map((r) => `('${sq(r.symbol)}','${r.ym}','${sq(r.name)}',${r.amount})`)
    .join(',\n');
  const sql = `insert into public.revenue (symbol, ym, name, amount, updated_at)\nselect v.symbol, v.ym, v.name, v.amount, now()\nfrom (values\n${values}\n) as v(symbol, ym, name, amount)\non conflict (symbol, ym) do nothing;\n`;
  const f = path.join(outDir, `revenue-backfill-${String(n).padStart(2, '0')}.sql`);
  fs.writeFileSync(f, sql, 'utf8');
  files.push(f);
}
console.log(`\n寫出 ${files.length} 個檔案：`);
for (const f of files) console.log('  ' + f);
console.log('\n套用方式（supabase-sql.mjs 自己讀權杖，憑證不會出現在命令列）：');
console.log(`  for f in ${path.join(outDir, 'revenue-backfill-*.sql').replace(/\\/g, '/')}; do node scripts/supabase-sql.mjs "$f"; done`);
