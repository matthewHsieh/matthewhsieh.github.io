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
// 【池子填不滿就留現金，不要用現股／零股去補】2026-10-14 實測過四種配置，全部比現制差：
//                            年化    最大回撤  期內最深  最糟一期的追繳距離  報酬/回撤
//     現制：填不滿留現金         99.8%   -51.9%   -39.0%        41.2%        1.92
//     期貨宇宙 + 現股補顆粒      94.5%   -54.7%   -40.6%        17.4%        1.73
//     填不滿才用現股補          88.5%   -62.9%   -50.7%        16.6%        1.41
//     擴大宇宙（永遠用現股）      54.5%   -62.4%   -45.6%         8.7%        0.87
//   1.0 / 1.2 / 1.5 / 1.8 / 2.0 倍槓桿都測過，每一格都是補位比較差。
//   宇宙擴大的做法：把「沒有股票期貨、但近 60 日成交金額 >= 1 億」的 295 檔加進來，
//   宇宙 232 -> 523、池子 7.7 -> 10.5 檔。
//
//   **但這個結論很薄，不要當成鐵證**：選股差異不顯著（沒期貨的 vs 有期貨的，同期配對
//   -1.66%/期 t = -1.28；純選股 1.0x 下 -0.4%/期 t = -0.80），而回撤的惡化幾乎全部
//   來自一期（2026-07-02，現股佔曝險 29.2%、期內最深 -50.7%）。109 期裡有 86 期根本
//   沒補到現股。所以真正的理由不是回測，是算術：
//
//     期貨 1 元曝險 ~= 0.30 元資金（費率 ~20% x 1.5 倍風險指標緩衝）
//     現股 1 元曝險 == 1.00 元資金
//
//   一個期望報酬未經證實（點估計還是負的）、資金成本卻確定高 3 倍的工具，
//   在 2 倍槓桿下不該當常規配置。**顆粒太粗就跳過往下補，池子填不滿就留現金。**
//
//   也試過一個錯的解釋，記下來免得再想一次：「池子填不滿是市場要變壞的訊號」—— 不成立。
//   不滿的 50 期之後 20 天市場報酬 2.14% vs 滿檔 59 期的 1.93%（t = 0.15）、
//   期內最深 -5.21% vs -4.26%（t = -0.98）。前 1/3 濾網的減震效果仍然成立，
//   但機制是「平均槓桿較低」，不是會擇時。
//
//   例外（走的是另一條帳）：從**確定多餘**的保證金撥一小筆買「期貨買不到但想盯」的標的。
//   2026-10 試算：景碩+欣興各 200 股 = 447,000，追繳距離 41.9% -> 38.2%，
//   1.3 倍餘裕的上限是各 360 股。那是觀察部位，不是為了補滿檔數。
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
// --exclude 2454,3532：手動剔除訊號選到但你不想持有的。
// **記下你剔除了什麼** —— 否則回測績效跟實際持有的會慢慢分岔而你不知道為什麼。
// 例：2026-10-14 台勝科 營收 +27% 但本益比 341 倍、獲利接近零。
const EXCLUDE = new Set(String(arg('exclude', '')).split(',').map((x) => x.trim()).filter(Boolean));

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
// **那一頁有三張表，一定要先看欄數再讀欄位：**
//   9 欄  = 股票期貨比例表　　c[8] 是原始保證金適用比例　　← 只要這張
//   8 欄  = 固定金額表（ETF 期貨），單位是元／口，沒有比例
//   15 欄 = **股票選擇權**，c[8] 是 0.000%
// 2026-10-14 踩到：原本沒有欄數判斷，選擇權那一列會把同一個代號的費率蓋成 0，
// 於是 `rate[sym] > 0` 把它擋在選股宇宙外。而有選擇權的正好是最大的那些股票
// （台積電、鴻海、聯發科、日月光、南亞、台達電…），宇宙從 249 檔悄悄變成 210 檔。
// **症狀是「名單裡怎麼都沒有大型股」，不是報錯** —— 跟 fut_margin.codes 裡 O 結尾
// 是股票選擇權是同一個坑，scripts/fetch-fut-margin.mjs 有擋、這支當初漏了。
async function taifex() {
  const r = await fetch('https://www.taifex.com.tw/cht/5/stockMargining', { headers: UA });
  const buf = Buffer.from(await r.arrayBuffer());
  let html = buf.toString('utf8');
  if (!/保證金/.test(html)) html = new TextDecoder('big5').decode(buf);
  const cell = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const mini = new Set(), rate = {};
  let nRow = 0;
  for (const trm of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...trm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => cell(x[1]));
    if (!/^\d+$/.test(c[0] || '')) continue;
    if (c.length !== 9) continue;                       // 只收期貨比例表
    const sym = c[2];
    if (!/^[0-9]{4}$/.test(sym || '')) continue;
    if (/選擇權$/.test(c[3] || '')) continue;            // 保險：簡稱也擋一次
    if (/^小型/.test(c[3] || '')) { mini.add(sym); continue; }
    const im = String(c[8] || '').match(/^([\d.]+)\s*%$/);
    if (im) { rate[sym] = Number(im[1]) / 100; nRow++; }
  }
  if (nRow < 150) { console.error(`期交所比例表只解析到 ${nRow} 檔，版型可能變了，不要信這份名單`); process.exit(1); }
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
    // TAIEX 是加權指數，用來算 beta（等效大盤曝險）。它不是個股，所以走另一個代號。
    const yh = row.symbol === 'TAIEX' ? '%5ETWII'
      : `${row.symbol}.${row.exch === 'tpex' ? 'TWO' : 'TW'}`;
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
// 指數單獨抓（一個請求）。塞進 univ 的話，每次加新標的都要等整份快取過期才拿得到 beta。
{
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?range=10y&interval=1d', { headers: UA });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = (await r.json())?.chart?.result?.[0];
      const ts = res?.timestamp || [], ac = res?.indicators?.adjclose?.[0]?.adjclose || [];
      const rows = [];
      for (let i = 0; i < ts.length; i++) {
        if (ac[i] == null || !(ac[i] > 0)) continue;
        rows.push([new Date(ts[i] * 1000 + 8 * 3600e3).toISOString().slice(0, 10), +ac[i].toFixed(4)]);
      }
      if (rows.length < 500) throw new Error(rows.length + ' 天');
      D.TAIEX = rows; break;
    } catch (e) {
      if (a === 2) console.error('抓不到加權指數（' + e.message + '）→ 這次沒有 beta／等效大盤曝險');
      else await sleep(1500);
    }
  }
}
const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const NM = JSON.parse(fs.readFileSync(path.join(here, '..', 'tw-stocks.json'), 'utf8'));

const cnt = new Map();
for (const rows of Object.values(D)) for (const r of rows) cnt.set(r[0], (cnt.get(r[0]) || 0) + 1);
const CAL = [...cnt].filter((e) => e[1] >= 100).map((e) => e[0]).sort();
const IX = new Map(CAL.map((d, i) => [d, i]));
const i0 = CAL.length - 1;

// ---- 等效大盤曝險用的 beta ----
// 「名目 2.0 倍」不等於「大盤 2.0 倍」。這個池子選的是報酬/波動高的半導體供應鏈，
// beta 普遍在 1.2~1.8，所以名目 2 倍實際上是大盤 2.5~3.5 倍。
// 這是 2026-10 撞天花板時沒有被看見的那一層：規則盯的是名目，風險來自 beta x 名目。
// 窗口取 250 日（約一年）。再短會被單一事件主導，再長會混進已經不同的商業模式。
const BETA_WIN = 250;
const mLp = new Array(CAL.length).fill(null);
for (const r of (D.TAIEX || [])) { const k = IX.get(r[0]); if (k !== undefined) mLp[k] = Math.log(r[1]); }
const mRet = mLp.map((x, k) => (k === 0 || x == null || mLp[k - 1] == null) ? null : x - mLp[k - 1]);
const betaOf = (ret) => {
  const xs = [], ys = [];
  for (let k = Math.max(1, i0 - BETA_WIN + 1); k <= i0; k++) {
    if (ret[k] == null || mRet[k] == null) continue;
    xs.push(mRet[k]); ys.push(ret[k]);
  }
  if (xs.length < 120) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vr = 0;
  for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); vr += (xs[k] - mx) ** 2; }
  return vr > 0 ? cov / vr : null;
};
const mVol = (() => { const r = mRet.slice(i0 - BETA_WIN + 1).filter((x) => x != null);
  return r.length > 120 ? sd(r) * Math.sqrt(252) : null; })();

const all = [];
for (const sym of Object.keys(D)) {
  if (sym === 'TAIEX') continue;
  if (!KEEP_FIN && isFin(sym)) continue;
  if (EXCLUDE.has(sym)) continue;
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
    px: PX[sym], im: rate[sym], mini: mini.has(sym), al: AL[sym] || null,
    beta: betaOf(ret) });
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

console.log(`\n資料日 ${CAL[i0]}　宇宙 ${all.length} 檔` + (KEEP_FIN ? '' : '（已排除金融股）')
  + (EXCLUDE.size ? '（手動剔除 ' + [...EXCLUDE].join('、') + '）' : ''));
console.log(`資金（總資產）${tw(CAPITAL)} x ${LEV} 倍 = 曝險上限 ${tw(CAP)}　每檔目標 ${tw(EACH)}`);
console.log(`  現金 ${tw(sumK('cash'))}　期貨權益 ${tw(sumK('futures_equity'))}　美股 ${tw(usMv)}　現股 ${tw(twMv)}`);
console.log(`已有曝險 ${tw(held)} = 期貨名目 ${tw(heldFut)} ＋ 美股 delta ${tw(heldUs)} ＋ 現股 ${tw(twMv)}`);
console.log(`  ${pos.map((p) => p.contract + ' ' + p.lots + '口').join('、') || '無期貨部位'}`);
console.log(`→ 還能加名目 ${tw(ROOM)}（已用 ${pc(held / CAP)}）` + (ROOM <= 0 ? '　** 已滿，這一期不能加 **' : ''));

// 等效大盤曝險：beta 加權的名目。名目上限盯的是前者，真正的風險是後者。
const BETA = {};
for (const o of all) if (o.beta != null) BETA[o.sym] = o.beta;
const betaFor = (sym) => {
  if (BETA[sym] != null) return BETA[sym];
  const rows = D[sym]; if (!rows) return null;
  const lp = new Array(CAL.length).fill(null);
  for (const r of rows) { const k = IX.get(r[0]); if (k !== undefined) lp[k] = Math.log(r[1]); }
  return betaOf(lp.map((x, k) => (k === 0 || x == null || lp[k - 1] == null) ? null : x - lp[k - 1]));
};
{
  let bn = 0, known = 0, unknown = 0;
  for (const p of pos) {
    const n = Number(p.lots) * Number(p.size) * Number(p.price), b = betaFor(String(p.symbol));
    if (b == null) { unknown += n; } else { bn += n * b; known += n; }
  }
  for (const t of twPos) {
    const n = Number(t.shares) * Number(t.price), b = betaFor(String(t.symbol));
    if (b == null) { unknown += n; } else { bn += n * b; known += n; }
  }
  // 美股槓桿型 ETF 對台股加權指數沒有可靠的 beta，先當 1.0 並標示出來
  const usB = heldUs;
  const tot = bn + usB + unknown;
  console.log(`  等效大盤曝險 ${tw(tot)}（資金的 ${pc(tot / CAPITAL)}）`
    + `　名目 beta 加權 ${known > 0 ? (bn / known).toFixed(2) : '—'}`
    + (usB > 0 ? `　＋美股 delta ${tw(usB)}（beta 當 1.0）` : '')
    + (unknown > 0 ? `　＋無 beta 資料 ${tw(unknown)}（當 1.0）` : ''));
  if (mVol != null) console.log(`  加權指數近 ${BETA_WIN} 日年化波動 ${pc(mVol)}`);
}
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
console.log('  代號  名稱           分數     z    年化波動  beta   費率   契約  一口名目   口數   名目       警示');
let tn = 0, tm = 0, tb = 0, tbn = 0;
for (const o of pick) {
  const L = lotOf(o), k = Math.max(1, Math.round(EACH / L)), n = k * L;
  tn += n; tm += n * o.im;
  if (o.beta != null) { tb += n * o.beta; tbn += n; }
  console.log(`  ${o.sym}  ${o.name.padEnd(11)} ${o.ratio.toFixed(2).padStart(5)} ${o.z.toFixed(2).padStart(6)} `
    + `${pc(o.vol).padStart(7)} ${(o.beta == null ? '—' : o.beta.toFixed(2)).padStart(5)} ${pc(o.im).padStart(6)}  `
    + (o.mini ? '小型' : '大型')
    + ` ${tw(L).padStart(8)} ${String(k).padStart(4)} 口 ${tw(n).padStart(9)}  `
    + (heldSyms.has(o.sym) ? '已持有　' : '') + cdText(o.al));
}
if (tn > 0) {
  console.log(`\n  合計名目 ${tw(tn)}（上限 ${tw(CAP)}，` + (tn <= CAP ? '剩 ' + tw(CAP - tn) : '超出 ' + tw(tn - CAP)) + '）');
  console.log(`  原始保證金 ${tw(tm)}　加權費率 ${pc(tm / tn)}　佔資金 ${pc(tm / CAPITAL)}`);
  console.log(`  組合平均年化波動 ${pc(pick.reduce((a, o) => a + o.vol, 0) / pick.length)}`);
  if (tbn > 0) {
    const wb = tb / tbn, effLev = tb / CAPITAL;
    console.log(`  加權 beta ${wb.toFixed(2)}　→ ** 等效大盤曝險 ${tw(tb)}＝資金的 ${pc(effLev)} **`
      + `（名目是 ${pc(tn / CAPITAL)}）`);
    console.log(`  也就是：名目 ${(tn / CAPITAL).toFixed(2)} 倍的規則，實際承擔 ${effLev.toFixed(2)} 倍的大盤風險`);
  }
}
if (dPun.length) console.log(`\n  因處置/快達處置剔除：` + dPun.map((o) => o.name + '(' + o.al.kind + ')').join('、'));
if (dBig.length) console.log(`  因一口放不下剔除：` + dBig.map((o) => o.name + ' ' + tw(lotOf(o))).join('、'));
const notices = pick.filter((o) => o.al);
if (notices.length) console.log(`\n  [!] 名單裡的注意股（處置會讓費率翻倍，要盯倒數）：` + notices.map((o) => o.name).join('、'));
