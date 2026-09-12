import { fmt, fmtMax, isNum, norm, num, state, sum } from './core.js';
import { WAR_UNITS, futDisplayName, optDeltaExp, optLabel, optMaxRisk, optPl, optValue, stockFutLabel, usExposureUsd, usLevLabel, warDelta, warExposure, warLabel, warMaxRisk, warPl, warValue } from './instruments.js';
import { futNotional, futPl, pxOf } from './live.js';

// 曝險明細：每一檔股票、每一筆期貨、每一檔美股各算一塊
// 依金額由大到小排，前 7 名各給一個顏色，其餘合併成「其他」
const POS_COLORS = ['var(--pos-1)', 'var(--pos-2)', 'var(--pos-3)', 'var(--pos-4)', 'var(--pos-5)', 'var(--pos-6)', 'var(--pos-7)'];

const POS_MAX = POS_COLORS.length;

export function exposureSlices() {
  const rate = num(state.settings.usd_twd);
  const items = [];
  for (const s of state.stocks) {
    const v = num(s.shares) * pxOf(s);
    if (v > 0) items.push({ label: `${norm(s.symbol)} ${s.name || ''}`.trim(), sub: '台股', value: v });
  }
  for (const f of state.futures) {
    const v = futNotional(f);
    if (v > 0) items.push({
      label: f.contract || futDisplayName(f.kind, f.symbol, f.size),
      sub: (f.kind === 'stock' ? `個股期・${stockFutLabel(f.size)}型` : '指數期') + (f.side === 'short' ? '・空單' : ''),
      value: v,
    });
  }
  for (const u of state.us) {
    // 槓桿型的要用曝險不是市值，否則圓餅圖會把 2X 的部位畫成一半大小
    const v = usExposureUsd(u) * rate;
    const lv = usLevLabel(u);
    if (v > 0) items.push({
      label: `${norm(u.symbol)} ${u.name || ''}`.trim(),
      sub: lv ? `複委託・${lv}` : '複委託',
      value: v,
    });
  }
  for (const w of state.warrants) {
    const v = Math.abs(warExposure(w) ?? 0);
    if (v > 0) items.push({
      label: warLabel(w),
      sub: `權證・${w.cp === 'put' ? '認售' : '認購'}（delta 曝險）`,
      value: v,
    });
  }
  for (const o of state.options) {
    const v = Math.abs(optDeltaExp(o) ?? 0);
    if (v > 0) items.push({
      label: optLabel(o),
      sub: `選擇權・${o.side === 'short' ? '賣方' : '買方'}（delta 曝險）`,
      value: v,
    });
  }
  items.sort((a, b) => b.value - a.value);
  const out = items.slice(0, POS_MAX).map((it, i) => ({ ...it, color: POS_COLORS[i] }));
  const rest = items.slice(POS_MAX);
  if (rest.length) {
    out.push({ label: `其他 ${rest.length} 筆`, sub: '', value: sum(rest, (r) => r.value), color: 'var(--pos-other)' });
  }
  return out;
}

export function compute() {
  const { settings, stocks, futures, us, balances } = state;
  const rate = num(settings.usd_twd);

  const stockValue = sum(stocks, (s) => num(s.shares) * pxOf(s));
  const stockCost = sum(stocks, (s) => num(s.shares) * (isNum(s.cost) ? num(s.cost) : pxOf(s)));

  const usValueUsd = sum(us, (s) => num(s.shares) * num(s.price_usd));
  const usCostUsd = sum(us, (s) => num(s.shares) * (isNum(s.cost_usd) ? num(s.cost_usd) : num(s.price_usd)));
  const usValue = usValueUsd * rate;
  // **槓桿型 ETF 的曝險要乘倍數，資產價值不行。**
  // MUU 是 2X MU：買 US$3,143 只拿得回 US$3,143（資產），
  // 但承受的是 MU 的 US$6,286 波動（曝險）。跟期貨「權益 vs 名目」一樣。
  const usExposure = sum(us, usExposureUsd) * rate;
  const usLevExtra = usExposure - usValue;   // 純粹因為槓桿多出來的曝險

  const longs = futures.filter((f) => f.side !== 'short');
  const shorts = futures.filter((f) => f.side === 'short');
  const futLong = sum(longs, futNotional);
  const futShort = sum(shorts, futNotional);
  const futGross = futLong + futShort;
  const futNet = futLong - futShort;
  const futIndex = sum(futures.filter((f) => f.kind !== 'stock'), futNotional);
  const futStock = sum(futures.filter((f) => f.kind === 'stock'), futNotional);
  const withCost = futures.filter((f) => isNum(f.cost));
  const futProfit = withCost.length ? sum(withCost, futPl) : null;

  // 選擇權
  const opts = state.options;
  const optMarket = sum(opts, optValue);                       // 權利金市值（買方正、賣方負）
  const optExposure = opts.reduce((a, o) => a + Math.abs(optDeltaExp(o) ?? 0), 0);  // 曝險取絕對值加總
  const optNetDelta = opts.reduce((a, o) => a + (optDeltaExp(o) ?? 0), 0);          // 淨方向部位
  const optWithPl = opts.filter((o) => isNum(o.cost));
  const optProfit = optWithPl.length ? sum(optWithPl, optPl) : null;
  const optRisks = opts.map(optMaxRisk);
  const optRiskUnlimited = optRisks.some((r) => r.unlimited);
  const optMaxLoss = optRisks.reduce((a, r) => a + (r.value ?? 0), 0);
  const optNoDelta = opts.some((o) => !isNum(o.delta));

  // 權證
  const wars = state.warrants;
  const warMarket = sum(wars, warValue);
  const warExp = wars.reduce((a, w) => a + Math.abs(warExposure(w) ?? 0), 0);
  const warWithPl = wars.filter((w) => isNum(w.cost));
  const warProfit = warWithPl.length ? sum(warWithPl, warPl) : null;
  const warMaxLoss = sum(wars, warMaxRisk);
  const warTheta = sum(wars.filter((w) => isNum(w.theta_day)), (w) => num(w.theta_day) * num(w.lots) * WAR_UNITS);
  const warNoDelta = wars.some((w) => warDelta(w) === null);

  const toTwd = (b) => num(b.amount) * (b.currency === 'USD' ? rate : 1);
  const cash = sum(balances.filter((b) => b.kind === 'cash'), toTwd);
  const futEquity = sum(balances.filter((b) => b.kind === 'futures_equity'), toTwd);
  const liabilities = sum(balances.filter((b) => b.kind === 'liability'), toTwd);

  const totalAssets = stockValue + usValue + futEquity + cash + optMarket + warMarket;
  const netAssets = totalAssets - liabilities;
  const exposure = stockValue + usExposure + futGross + optExposure + warExp;

  const leverageAsset = netAssets > 0 ? totalAssets / netAssets : NaN;
  // 曝險槓桿以「總資產」為分母：淨資產為負時仍算得出來
  const leverageExposure = totalAssets > 0 ? exposure / totalAssets : NaN;

  const target = num(settings.target_amount);
  const progress = target > 0 ? netAssets / target : NaN;

  return {
    rate, stockValue, stockCost, usValueUsd, usCostUsd, usValue, usExposure, usLevExtra,
    futEquity, futLong, futShort, futGross, futNet, futIndex, futStock, futProfit,
    optMarket, optExposure, optNetDelta, optProfit, optMaxLoss, optRiskUnlimited, optNoDelta,
    warMarket, warExp, warProfit, warMaxLoss, warTheta, warNoDelta,
    cash, liabilities, totalAssets, netAssets, exposure,
    leverageAsset, leverageExposure, target, progress,
  };
}

// ------------------------------------------------------------
// 估值
//   近四季本益比：證交所與櫃買中心每天公告，是用「已經發生」的獲利算的，是事實。
//   26/27/28 年本益比：現價 ÷ 預估 EPS。台灣沒有免費的分析師共識 API，
//     所以預估 EPS 是存在資料庫裡人工維護的，而股價每天自動更新，
//     因此比值每天都會變，但分母的品質取決於那個預估準不準。
//   虧損的公司沒有本益比，顯示「虧損」而不是 0，因為 0 會讓人誤以為很便宜。
// ------------------------------------------------------------
export const valOf = (symbol) => state.valuation.find((v) => norm(v.symbol) === norm(symbol)) || null;

export const peLabel = (pe) => (isNum(pe) ? `${fmtMax(pe, 1)}x` : '虧損');

export const themePe = (theme) => state.themeVal.find((t) => t.theme === theme) || null;

// ------------------------------------------------------------
// 報酬 ÷ 波動
//   「這檔漲很多」最會騙人。實測 2022-2026，金居買進持有 7.79 倍看起來很猛，
//   但波動 52% 讓風險等價槓桿只能開 0.81 倍，套上同一條規則後只有 4.03 倍，
//   反而輸給加權指數的 7.75 倍。**漲得多不等於賺得多。**
//   所以用加權指數的比值當及格線：低於它的個股，不如直接開槓桿買指數。
// ------------------------------------------------------------
export const riskOf = (symbol) => state.riskStats.find((r) => norm(r.symbol) === norm(symbol)) || null;

export const idxRatio = () => num(state.riskStats.find((r) => r.symbol === 'TAIEX')?.ratio);

export const beatsIdx = (ratio) => isNum(ratio) && isNum(idxRatio()) && num(ratio) > idxRatio();

export const FWD_YEARS = [
  [2026, 'fy2026', 'eps2026', 'conf2026', 'an2026'],
  [2027, 'fy2027', 'eps2027', 'conf2027', 'an2027'],
  [2028, 'fy2028', 'eps2028', 'conf2028', 'an2028'],
];

// ------------------------------------------------------------
// 族群趨勢
//   用月營收年增率衡量產業景氣，不是看股價漲跌。
//   台灣強制上市櫃每月公告營收，這是全球少見的高頻基本面資料。
// ------------------------------------------------------------
export const heldSymbols = () => new Set([
  ...state.stocks.map((x) => norm(x.symbol)),
  ...state.futures.filter((f) => f.kind === 'stock').map((f) => norm(f.symbol)),
  ...state.warrants.map((w) => norm(w.underlying)),
]);

// ------------------------------------------------------------
// 美股 AI 產業地圖
//   跟台股那頁的訊號方向相反：台股用已公告的月營收（落後），
//   美股用分析師的營收預估（前瞻）。後者更接近「產業趨勢」本身，
//   但分母是別人的猜測，看的時候要連分析師人數一起看。
//   基準線用那斯達克 100，不是加權指數，因為比較對象要同一個市場。
// ------------------------------------------------------------
export const usIdxRatio = () => num(state.usStats.find((r) => r.symbol === 'NDX')?.ratio);

export const usBeats = (r) => isNum(r) && isNum(usIdxRatio()) && num(r) > usIdxRatio();

export const usdB = (v) => (isNum(v) ? `${fmt(num(v) / 100000000, 0)} 億` : '–');
