#!/usr/bin/env node
// ============================================================
// 換股清單：算出這一期該持有哪幾檔、各幾口
//
// 訊號規格（2026-10-13 用 248 檔個股期貨標的 × 十年 adjclose 跑出來的）：
//   1. 報酬/波動 Q5（前 20%）—— 窗口是 t-180 ~ t-60，**不含最近 60 日**
//   2. 其中分數前 1/3
//   3. 且 z > -0.5（離 60 日高點不到半個標準差）
//   4. 等權、取 10 檔、每 20 個交易日換一次
//
// 組合回測（109 期、來回成本 0.1%、排除金融股）：
//   年化 85.3%、最大回撤 -48.7%（2.0 倍）、期內最深 -25.2%、零追繳
//   相對 0050（含息，Sharpe 1.05）每 20 日超額 +1.5%，t = 2.15
//   **t 只有 2.15，而試過 8 種設定，Bonferroni 要 2.7 —— 這個優勢是薄的。**
//
// 為什麼每一條都長這樣，以及踩過的坑：
//
// 【品質窗口要落後 60 日】原本用 t-120~t 會跟回檔窗口重疊：最近 60 日跌 2σ 會
//   直接拉低分子、拉高分母，所以「好品質」和「深回檔」在數學上互相排斥。
//   實測：重疊版的 Q5 裡 z <= -2.5 只有 2 筆，落後版有 62 筆。
//
// 【前 1/3 濾網不是為了選更好的，是減震器】它會讓某些期只持 7 檔、其餘是現金。
//   年化從 98.7% 降到 85.3%，但最大回撤從 -65.0% 降到 -48.7%，報酬/回撤 1.52 -> 1.75。
//
// 【排除金融股是使用者的偏好，而且歷史上不花錢】十年來訊號平均只持有 1.1 檔金融股，
//   排除後年化 85.3% vs 85.9%、回撤 -48.7% vs -51.4%（更好）。
//   但代價要知道：剩下的會幾乎全是半導體供應鏈，組合波動 78% vs 66%。
//
// 【綁住你的是曝險上限，不是保證金】配置用低費率標的之後保證金只佔資金三成多，
//   但曝險（名目 + 槓桿型 ETF 的 delta）會先撞到 2.0 倍的天花板。
//   2.0 倍的來源：期內最深回撤 -25.2% -> 零追繳上限 2.72x，留餘裕取 2.0。
//
// 【小型契約不能用「代碼數」判斷】期交所那頁 codes 欄位裡 **O 結尾是股票選擇權**，
//   不是小型期貨。南亞 CAF/CAO 兩個代碼但**沒有**小型。正確判準：中文簡稱開頭是
//   「小型」。全市場只有 50 檔有小型。
//
// 【注意股要顯示倒數，不要直接排除】處置會讓保證金費率翻倍（金居 22.95% -> 45.90%
//   就是這樣打掉 37 個百分點的風險指標）。但直接排除注意股會把分數第一名也刷掉，
//   而它可能離門檻還有 5 次。門檻：證交所連續三次或十日內六次、櫃買連續五次。
//
// 用法：
//   node scripts/rebalance.mjs
//   node scripts/rebalance.mjs --lev 1.5 --n 15
//   node scripts/rebalance.mjs --keep-fin
//   node scripts/rebalance.mjs --capital 3600000
//   node scripts/rebalance.mjs --refresh
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_REF = 'ovyftgvprwzhlgnqkfvh';
const TOKEN_FILE = path.join(os.homedir(), '.claude', 'secrets', 'supabase-token');
const CACHE = path.join(os.tmpdir(), 'rebalance-adjclose.json');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0' };

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const flag = (k) => process.argv.includes('--' + k);
const LEV = Number(arg('lev', 2.0));
const N = Number(arg('n', 10));
const KEEP_FIN = flag('keep-fin');

const isFin = (s) => /^28[0-9]{2}$/.test(s) || ['5880', '5876', '2823', '2867'].includes(s);
const tw = (x) => Math.round(x).toLocaleString('en-US');
const pc = (x) => (x * 100).toFixed(1) + '%';
const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Supabase（權杖自己讀，呼叫端的命令列沒有憑證）----
let token;
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
catch { console.error('找不到權杖檔：' + TOKEN_FILE); process.exit(2); }
async function q(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const t = await r.text();
  if (!r.ok) { console.error('SQL 失敗：' + t.split(token).join('[REDACTED]').slice(0, 300)); process.exit(1); }
  return JSON.parse(t);
}

// ---- 期交所：費率與小型契約。小型要看中文簡稱，不能數代碼 ----
async function taifex() {
  const r = await fetch('https://www.taifex.com.tw/cht/5/stockMargining', { headers: UA });
  const buf = Buffer.from(await r.arrayBuffer());
  let html = buf.toString('utf8');
  if (!/保證金/.test(html)) html = new TextDecoder('big5').decode(buf);
  const cell = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const mini = new Set(), rate = {};
  for (const trm of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...trm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cell(x[1]));
    if (!/^\d+$/.test(c[0] || '')) continue;
    const sym = c[2];
    if (!/^[0-9]{4}$/.test(sym || '')) continue;
    if (/^小型/.test(c[3] || '')) { mini.add(sym); continue; }
    const im = String(c[8] || '').match(/^([\d.]+)\s*%$/);
    if (im) rate[sym] = Number(im[1]) / 100;
  }
  return { mini, rate };
}

// ---- Yahoo：一次請求拿十年。報酬一律用 adjclose（現金股利沒還原會低估高殖利率的）----
async function adjclose(univ) {
  if (!flag('refresh') && fs.existsSync(CACHE)) {
    const st = fs.statSync(CACHE);
    if (Date.now() - st.mtimeMs < 20 * 3600 * 1000) {
      console.log(`用快取 ${CACHE}`);
      return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    }
  }
  console.log(`抓 Yahoo 十年日線，${univ.length} 檔，約 2 分鐘`);
  const out = {}; let ok = 0, fail = 0;
  for (const row of univ) {
    const yh = `${row.symbol}.${row.exch === 'tpex' ? 'TWO' : 'TW'}`;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yh}?range=10y&interval=1d`, { headers: UA });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const res = (await r.json())?.chart?.result?.[0];
        const ts = res?.timestamp || [], ac = res?.indicators?.adjclose?.[0]?.adjclose || [];
        if (ts.length < 500) throw new Error(ts.length + ' 天');
        const rows = [];
        for (let i = 0; i < ts.length; i++) {
          if (ac[i] == null || !(ac[i] > 0)) continue;
          rows.push([new Date(ts[i] * 1000 + 8 * 3600e3).toISOString().slice(0, 10), +ac[i].toFixed(4)]);
        }
        out[row.symbol] = rows; ok++; break;
      } catch (e) { if (a === 2) fail++; else await sleep(1500); }
    }
    await sleep(210);
  }
  console.log(`抓到 ${ok} 檔、失敗 ${fail}`);
  fs.writeFileSync(CACHE, JSON.stringify(out), 'utf8');
  return out;
}

// ============================ 主程式 ============================
const [univ, prices, alerts, bal, pos, usPos, twPos] = await Promise.all([
  q(`select m.symbol, coalesce(p.exch, 'twse') exch
     from public.fut_margin m
     left join (select symbol, max(exch) exch from public.market_prices where market='tw' group by symbol) p
       on p.symbol = m.symbol
     where m.im_rate is not null and m.symbol ~ '^[0-9]{4}$' order by m.symbol`),
  q(`select symbol, price from public.market_prices where market='tw' and price > 0`),
  q(`select symbol, name, kind, src, streak, win10, last_rn from public.active_alerts(14)`),
  q(`select kind, name, amount, currency from public.balances`),
  q(`select symbol, contract, lots, size, price from public.futures`),
  q(`select symbol, shares, price_usd, leverage from public.us_stocks`),
  q(`select symbol, shares, price from public.stocks`),
]);
const { mini, rate } = await taifex();
const PX = Object.fromEntries(prices.map((r) => [r.symbol, Number(r.price)]));
const AL = Object.fromEntries(alerts.map((r) => [r.symbol, r]));
const D = await adjclose(univ);
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const NM = JSON.parse(fs.readFileSync(path.join(here, '..', 'tw-stocks.json'), 'utf8'));

const cnt = new Map();
for (const rows of Object.values(D)) for (const r of rows) cnt.set(r[0], (cnt.get(r[0]) || 0) + 1);
const CAL = [...cnt].filter((e) => e[1] >= 100).map((e) => e[0]).sort();
const IX = new Map(CAL.map((d, i) => [d, i]));
const i0 = CAL.length - 1;

const all = [];
for (const sym of Object.keys(D)) {
  if (!KEEP_FIN && isFin(sym)) continue;
  if (!(PX[sym] > 0) || !(rate[sym] > 0)) continue;
  const lp = new Array(CAL.length).fill(null);
  for (const r of D[sym]) { const k = IX.get(r[0]); if (k !== undefined) lp[k] = Math.log(r[1]); }
  const ret = lp.map((x, k) => (k === 0 || x == null || lp[k - 1] == null) ? null : x - lp[k - 1]);
  const qw = ret.slice(i0 - 179, i0 - 59).filter((x) => x != null);
  if (qw.length < 96 || lp[i0] == null || lp[i0 - 60] == null || lp[i0 - 180] == null) continue;
  const ratio = ((lp[i0 - 60] - lp[i0 - 180]) / 120 * 252) / (sd(qw) * Math.sqrt(252));
  const pw = lp.slice(i0 - 59, i0 + 1).filter((x) => x != null);
  const rw = ret.slice(i0 - 59, i0 + 1).filter((x) => x != null);
  if (pw.length < 48 || !(sd(rw) > 0)) continue;
  all.push({ sym, name: NM[sym] || '?', ratio, vol: sd(rw) * Math.sqrt(252),
    z: Math.min((lp[i0] - Math.max(...pw)) / (sd(rw) * Math.sqrt(60)), 0),
    px: PX[sym], im: rate[sym], mini: mini.has(sym), al: AL[sym] || null });
}
all.sort((a, b) => a.ratio - b.ratio);
all.forEach((o, k) => { o.q = Math.min(5, Math.floor(k / all.length * 5) + 1); });

const usd = 32;
const sumK = (k) => bal.filter((b) => b.kind === k)
  .reduce((a, b) => a + Number(b.amount) * (b.currency === 'USD' ? usd : 1), 0);
// 資金 = 總資產（現金 ＋ 期貨權益 ＋ 美股市值 ＋ 現股市值）。
// **用總資產不用淨資產** —— 淨資產是負的（負債大於資產），乘倍數沒有意義。
const usMv = usPos.reduce((a, u) => a + Number(u.shares) * Number(u.price_usd) * usd, 0);
const twMv = twPos.reduce((a, t) => a + Number(t.shares) * Number(t.price), 0);
const CAPITAL = Number(arg('capital', 0)) || (sumK('cash') + sumK('futures_equity') + usMv + twMv);
const CAP = CAPITAL * LEV, EACH = CAP / N, LOTMAX = EACH * 1.5;
const lotOf = (o) => o.px * (o.mini ? 100 : 2000);
// 已有的曝險。**槓桿型 ETF 要乘倍數** —— SKHL／SNXX 是 2 倍，55 萬的市值是 110 萬的曝險。
// 不乘的話上限會被高估一倍的 ETF 市值，而那正是 2026-10 撞到天花板的那一塊。
const heldFut = pos.reduce((a, p) => a + Number(p.lots) * Number(p.size) * Number(p.price), 0);
const heldUs = usPos.reduce((a, u) => a + Number(u.shares) * Number(u.price_usd) * usd
  * Math.max(1, Math.abs(Number(u.leverage) || 1)), 0);
const held = heldFut + heldUs + twMv;
const ROOM = CAP - held;

console.log(`\n資料日 ${CAL[i0]}　宇宙 ${all.length} 檔` + (KEEP_FIN ? '' : '（已排除金融股）'));
console.log(`資金（總資產）${tw(CAPITAL)} x ${LEV} 倍 = 曝險上限 ${tw(CAP)}　每檔目標 ${tw(EACH)}`);
console.log(`  現金 ${tw(sumK('cash'))}　期貨權益 ${tw(sumK('futures_equity'))}　美股 ${tw(usMv)}　現股 ${tw(twMv)}`);
console.log(`已有曝險 ${tw(held)} = 期貨名目 ${tw(heldFut)} ＋ 美股 delta ${tw(heldUs)} ＋ 現股 ${tw(twMv)}`);
console.log(`  ${pos.map((p) => p.contract + ' ' + p.lots + '口').join('、') || '無期貨部位'}`);
console.log(`→ 還能加名目 ${tw(ROOM)}（已用 ${pc(held / CAP)}）` + (ROOM <= 0 ? '　** 已滿，這一期不能加 **' : ''));
console.log('');

const q5 = all.filter((o) => o.q === 5).sort((a, b) => b.ratio - a.ratio);
const th = q5.length ? (q5[Math.floor(q5.length / 3)] || q5[q5.length - 1]).ratio : 9;
let pool = q5.filter((o) => o.ratio >= th && o.z > -0.5);
const nTop = q5.filter((o) => o.ratio >= th).length;
const dPun = pool.filter((o) => o.al && (o.al.kind === 'punish' || o.al.kind === 'near'));
pool = pool.filter((o) => !(o.al && (o.al.kind === 'punish' || o.al.kind === 'near')));
const dBig = pool.filter((o) => lotOf(o) > LOTMAX);
pool = pool.filter((o) => lotOf(o) <= LOTMAX);
console.log(`篩選　Q5 ${q5.length} -> 分數前 1/3（>= ${th.toFixed(2)}）${nTop} -> z > -0.5 ${pool.length + dPun.length + dBig.length}`
  + ` -> 排除處置/快達 ${pool.length + dBig.length} -> 排除顆粒太粗 ${pool.length}\n`);

const LIM = { twse: [3, 5], tpex: [5, 5] };
const cdText = (a) => {
  if (!a) return '';
  if (a.kind === 'punish') return '** 處置中 **';
  const lim = LIM[String(a.src || '').toLowerCase()] || [3, 5];
  const live = Number(a.last_rn) === 1;
  const s = Number(a.streak) || 0, w = Number(a.win10) || 0;
  return `注意股 連續 ${s}` + (live ? `/${lim[0]}` : '（已中斷）') + ` 十日內 ${w}/6`;
};

const heldSyms = new Set(pos.map((p) => String(p.symbol)));
const pick = pool.slice(0, N);
console.log(`【這一期：${pick.length} 檔】`);
console.log('  代號  名稱           分數     z    年化波動   費率   契約  一口名目   口數   名目       警示');
let tn = 0, tm = 0;
for (const o of pick) {
  const L = lotOf(o), k = Math.max(1, Math.round(EACH / L)), n = k * L;
  tn += n; tm += n * o.im;
  console.log(`  ${o.sym}  ${o.name.padEnd(11)} ${o.ratio.toFixed(2).padStart(5)} ${o.z.toFixed(2).padStart(6)} `
    + `${pc(o.vol).padStart(7)} ${pc(o.im).padStart(6)}  ` + (o.mini ? '小型' : '大型')
    + ` ${tw(L).padStart(8)} ${String(k).padStart(4)} 口 ${tw(n).padStart(9)}  `
    + (heldSyms.has(o.sym) ? '已持有　' : '') + cdText(o.al));
}
if (tn > 0) {
  console.log(`\n  合計名目 ${tw(tn)}（上限 ${tw(CAP)}，` + (tn <= CAP ? '剩 ' + tw(CAP - tn) : '超出 ' + tw(tn - CAP)) + '）');
  console.log(`  原始保證金 ${tw(tm)}　加權費率 ${pc(tm / tn)}　佔資金 ${pc(tm / CAPITAL)}`);
  console.log(`  組合平均年化波動 ${pc(pick.reduce((a, o) => a + o.vol, 0) / pick.length)}`);
}
if (dPun.length) console.log(`\n  因處置/快達處置剔除：` + dPun.map((o) => o.name + '(' + o.al.kind + ')').join('、'));
if (dBig.length) console.log(`  因一口放不下剔除：` + dBig.map((o) => o.name + ' ' + tw(lotOf(o))).join('、'));
const notices = pick.filter((o) => o.al);
if (notices.length) console.log(`\n  [!] 名單裡的注意股（處置會讓費率翻倍，要盯倒數）：` + notices.map((o) => o.name).join('、'));
