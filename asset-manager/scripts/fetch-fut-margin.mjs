// 抓期交所的股票期貨保證金率，寫進 public.fut_margin。
//
// 背景與陷阱都寫在 supabase/fut_margin.sql 的檔頭，這裡只記解析細節：
//
// 頁面 https://www.taifex.com.tw/cht/5/stockMargining 上有兩張表：
//   比例表（9 欄）：序號 | 英文代碼 | 標的證券代號 | 中文簡稱 | 標的證券
//                   | 保證金所屬級距 | 結算保證金適用比例 | 維持保證金適用比例 | 原始保證金適用比例
//   固定金額表（8 欄）：序號 | 英文代碼 | 標的證券代號 | 中文簡稱 | 標的證券
//                       | 結算保證金 | 維持保證金 | 原始保證金      ← 單位是元／口
// 用欄數 + 第 7 欄是否為百分比來區分兩張表，不要靠出現順序。
//
// 同一個標的代號會出現兩次（大型／小型，英文代碼不同），比例相同，
// 所以 upsert 時把英文代碼累積成 'PQF/..' 字串，比例直接覆寫。
//
// 產出 /tmp/fut-margin.sql，再用 supabase-sql.mjs 套用（它自己讀權杖）。

import fs from 'fs';
import path from 'path';
import os from 'os';

const URL = 'https://www.taifex.com.tw/cht/5/stockMargining';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0' };

const cell = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const sq = (s) => String(s ?? '').replace(/'/g, "''");
const asPct = (v) => { const m = String(v).match(/^([\d.]+)\s*%$/); return m ? Number(m[1]) / 100 : null; };
const asNum = (v) => { const x = String(v).replace(/,/g, ''); return /^\d+(\.\d+)?$/.test(x) ? Number(x) : null; };

const r = await fetch(URL, { headers: UA });
if (!r.ok) { console.error('HTTP ' + r.status); process.exit(1); }
const buf = Buffer.from(await r.arrayBuffer());
let html = buf.toString('utf8');
if (!/保證金/.test(html)) html = new TextDecoder('big5').decode(buf);

const rows = new Map();
let nPct = 0, nAmt = 0;
for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
  const c = [...tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cell(x[1]));
  if (!/^\d+$/.test(c[0] || '')) continue;                        // 第一欄是序號
  const sym = c[2];
  if (!/^[0-9]{4,6}[A-Z]?$/.test(sym || '')) continue;
  const prev = rows.get(sym) || { symbol: sym, codes: [] };
  if (c[1]) prev.codes.push(c[1]);
  // 名稱保留第一個出現的（大型在前）。寫成 `c[3] || prev.name` 的話
  // 小型那一行會把名稱蓋成「小型京元電子期貨」，比例對但畫面上看起來像抓錯標的。
  if (!prev.name && c[3]) prev.name = c[3];

  if (c.length === 9 && asPct(c[7]) != null) {
    prev.tier = c[5] || '';
    prev.settle_rate = asPct(c[6]);
    prev.mm_rate = asPct(c[7]);
    prev.im_rate = asPct(c[8]);
    nPct++;
  } else if (c.length === 8 && asNum(c[6]) != null) {
    prev.settle_amt = asNum(c[5]);
    prev.mm_amt = asNum(c[6]);
    prev.im_amt = asNum(c[7]);
    nAmt++;
  } else continue;
  rows.set(sym, prev);
}

console.log(`比例表 ${nPct} 行、固定金額表 ${nAmt} 行 → 去重後 ${rows.size} 檔`);
if (rows.size < 100) { console.error('檔數異常偏少，版型可能變了，不寫入'); process.exit(1); }

const tiers = {};
for (const v of rows.values()) if (v.mm_rate != null) tiers[v.tier || '（個別調整）'] = (tiers[v.tier || '（個別調整）'] || 0) + 1;
console.log('級距分布：' + Object.entries(tiers).sort().map(([k, n]) => `${k} ${n}`).join('、'));

const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 台北日期
const vals = [...rows.values()].map((v) => `('${sq(v.symbol)}','${sq([...new Set(v.codes)].join('/'))}','${sq(v.name)}','${sq(v.tier)}',`
  + `${v.settle_rate ?? 'null'},${v.mm_rate ?? 'null'},${v.im_rate ?? 'null'},`
  + `${v.settle_amt ?? 'null'},${v.mm_amt ?? 'null'},${v.im_amt ?? 'null'},'${today}','taifex')`).join(',\n');

const sql = `insert into public.fut_margin
  (symbol, codes, name, tier, settle_rate, mm_rate, im_rate, settle_amt, mm_amt, im_amt, as_of, src)
values
${vals}
on conflict (symbol) do update set
  codes = excluded.codes, name = excluded.name, tier = excluded.tier,
  settle_rate = excluded.settle_rate, mm_rate = excluded.mm_rate, im_rate = excluded.im_rate,
  settle_amt = excluded.settle_amt, mm_amt = excluded.mm_amt, im_amt = excluded.im_amt,
  as_of = excluded.as_of, src = excluded.src, updated_at = now()
-- **手動填的費率不要被蓋回去。** 處置造成的保證金調整通常是另外公告、隔日生效，
-- 而 stockMargining 那一頁當下還顯示舊費率：2026-10-12 盤後金居調到 44.5%，
-- 但頁面仍是 22.95%。如果這支照抄回去，風險指標會從 83% 變回 119%，
-- **而那個方向的錯誤正好會讓人以為不必減倉**。
-- 要讓它恢復自動更新，把那一列的 src 從 'manual%' 改掉就好。
where public.fut_margin.src is null or public.fut_margin.src not like 'manual%';
`;
const out = path.join(os.tmpdir(), 'fut-margin.sql');
fs.writeFileSync(out, sql, 'utf8');
console.log(`\n寫出 ${out}（${(sql.length / 1024).toFixed(0)} KB）`);
console.log('套用：node scripts/supabase-sql.mjs "' + out + '"');
