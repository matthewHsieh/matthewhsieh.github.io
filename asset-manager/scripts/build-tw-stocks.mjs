// 產生 tw-stocks.json（台股代號 → 名稱），資料來源：證交所與櫃買中心 OpenAPI。
// 用法：node scripts/build-tw-stocks.mjs   （新上市櫃的股票要出現在自動帶名稱裡時再跑一次）
import fs from 'node:fs';

const ok = (c) => /^\d{4,5}[A-Z]?$/.test(c) || /^00\d{4}$/.test(c); // 股票、ETF、主動式 ETF；排除權證
const twse = await (await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')).json();
const tpex = await (await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes')).json();

const map = {};
for (const r of twse) { const c = (r.Code || '').trim(), n = (r.Name || '').trim(); if (ok(c) && n) map[c] = n; }
for (const r of tpex) { const c = (r.SecuritiesCompanyCode || '').trim(), n = (r.CompanyName || '').trim(); if (ok(c) && n && !map[c]) map[c] = n; }

const out = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
const target = new URL('../tw-stocks.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify(out));
console.log('tw-stocks.json:', Object.keys(out).length, 'entries');
