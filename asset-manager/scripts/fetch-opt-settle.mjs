// 抓台指選擇權各到期別的「契約到期日」，寫進 public.opt_settle。
// 背景與理由寫在 supabase/opt_settle.sql 的檔頭。
//
// 來源：https://www.taifex.com.tw/cht/3/optDailyMarketReport（POST）
//   openapi 的 JSON 版沒有「契約到期日」這一欄，只有這個 HTML 報表有。
//   欄位順序：契約 / 到期月份(週別) / **契約到期日** / 履約價 / 買賣權 / 開盤 / ...
//   頁面約 3.8 MB、2,900 多列，但我們只要 (到期月份, 契約到期日) 的去重結果，
//   實際上只有 8 個到期別。
//
// 一個到期別掛牌後它的到期日就不會變，所以一週跑一次就夠。
//
// 用法：node scripts/fetch-opt-settle.mjs [YYYY/MM/DD]
//   預設抓今天；今天沒有報表（假日）會回 0 列，這時給一個最近的交易日。
// 產出 /tmp/opt-settle.sql，再用 supabase-sql.mjs 套用（它自己讀權杖）。

import fs from 'fs';
import path from 'path';
import os from 'os';

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0',
  'Accept-Language': 'zh-TW,zh;q=0.9',
  'Content-Type': 'application/x-www-form-urlencoded',
};

const cell = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const sq = (s) => String(s ?? '').replace(/'/g, "''");

// 參數日期；沒給就用台北的今天
const argDate = process.argv[2];
const taipeiToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '/');
const queryDate = argDate || taipeiToday;

const body = new URLSearchParams({
  queryType: '2', marketCode: '0', dateaddcnt: '',
  commodity_id: 'TXO', commodity_id2t: '',
  queryDate, MarketCode: '0', commodity_idt: 'TXO',
});

const r = await fetch('https://www.taifex.com.tw/cht/3/optDailyMarketReport', { method: 'POST', headers: UA, body });
if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); }
const buf = Buffer.from(await r.arrayBuffer());
let html = buf.toString('utf8');
if (!/履約價/.test(html)) html = new TextDecoder('big5').decode(buf);

const map = new Map();
let asOf = null;
for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const c = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cell(x[1]));
  if (c[0] !== 'TXO' || c.length < 5) continue;
  const expiry = c[1];
  const d = String(c[2] || '').replace(/[^0-9]/g, '');
  if (!/^\d{6}(W\d|F\d)?$/.test(expiry)) continue;
  if (d.length !== 8) continue;
  map.set(expiry, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
}
// 報表日期：從頁面任一列的「日期」欄拿不到（這份表沒有日期欄），用查詢日
asOf = queryDate.replace(/\//g, '-');

console.log(`查詢日 ${queryDate} → ${map.size} 個到期別`);
if (!map.size) {
  console.error('沒有資料。那天可能不是交易日，給一個最近的交易日再試：node scripts/fetch-opt-settle.mjs 2026/10/08');
  process.exit(1);
}
for (const [e, d] of [...map].sort()) console.log(`  ${e.padEnd(12)} ${d}`);

const vals = [...map].map(([e, d]) => `('${sq(e)}','${d}','taifex_opt_html','${asOf}')`).join(',\n');
const sql = `insert into public.opt_settle (expiry, settle_date, src, as_of)
values
${vals}
on conflict (expiry) do update set
  settle_date = excluded.settle_date, src = excluded.src,
  as_of = excluded.as_of, updated_at = now();
`;
const out = path.join(os.tmpdir(), 'opt-settle.sql');
fs.writeFileSync(out, sql, 'utf8');
console.log(`\n寫出 ${out}`);
console.log('套用：node scripts/supabase-sql.mjs "' + out + '"');
