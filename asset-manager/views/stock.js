import { ALERT_LABEL, alertLine, alertOf } from '../alerts.js';
import { $, $$, esc, fmt, fmtMax, isNum, norm, num, plClass, rocPrevYm, rocYm, sb, signed, state, stripTags } from '../core.js';
import { stockFutLabel } from '../instruments.js';
import { beatsIdx, idxRatio, usBeats, usIdxRatio, usdB } from '../portfolio.js';
import { TW_STOCKS, resolveTwSymbol } from '../symbols.js';
import { CAT_LABEL, realizedSummary, tradeCategory, tradeNet } from '../trades.js';
import { CONF_LABEL, mdBold, rangeHtml, riskHtml } from '../widgets.js';

// ------------------------------------------------------------
// 個股速覽
//   在任何地方看到一檔股票，點下去就要能知道它「現在大概是什麼狀態」。
//   絕大部分數字登入時就整批載好了，所以先用記憶體畫出來、立刻看得到，
//   再把需要往返一次的深度資料（股價淨值比、季報、每一年的預估、月營收明細）補上。
//
//   最上面那條區間帶是刻意放的：使用者的策略是「在下跌中買好公司」，
//   那就需要一個「現在站在哪裡」的數字，而不是只有報酬與波動。
//   金居就是例子——三年最低 38.6、最高 700、現在 521，
//   光看「三年漲 13 倍」跟光看「離高點還有 26%」是兩種完全不同的判斷。
// ------------------------------------------------------------

// 我在這一檔上的實際成績。看族群數字之前先看這個，
// 因為「這檔好不好」跟「我在這檔上做得好不好」常常是相反的。
function symbolRecord(mk, sym) {
  const rs = realizedSummary();
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  let net = 0, cost = 0, n = 0, last = null;
  const byCat = { day: 0, swing: 0, roll: 0 };
  for (const t of state.trades) {
    if (t.market === 'option') continue;
    const s = t.market === 'us' ? norm(t.symbol) : resolveTwSymbol(t.symbol);
    if (s !== key) continue;
    const r = tradeNet(t, rs);
    net += r.net; cost += r.cost; n += 1;
    byCat[tradeCategory(t)] += r.net;
    if (!last || t.trade_date > last) last = t.trade_date;
  }
  return { net, cost, n, last, byCat };
}

// 我現在手上有多少。現股、個股期、權證標的、複委託分開講，
// 因為同一檔用三種方式持有的風險完全不同。
function symbolHoldings(mk, sym) {
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  const out = [];
  if (mk === 'us') {
    for (const u of state.us) {
      if (norm(u.symbol) !== key) continue;
      out.push({ how: '複委託', qty: `${fmt(u.shares)} 股`,
                 cost: u.cost_usd, price: u.price_usd,
                 expo: num(u.shares) * num(u.price_usd), ccy: 'USD' });
    }
    return out;
  }
  for (const s of state.stocks) {
    if (norm(s.symbol) !== key) continue;
    out.push({ how: '現股', qty: `${fmt(s.shares)} 股`,
               cost: s.cost, price: s.price, expo: num(s.shares) * num(s.price), ccy: 'TWD' });
  }
  for (const f of state.futures) {
    if (f.kind !== 'stock' || norm(f.symbol) !== key) continue;
    out.push({ how: `個股期（${stockFutLabel(f.size)}型・${f.side === 'short' ? '空' : '多'}）`,
               qty: `${fmt(f.lots)} 口`, cost: f.cost, price: f.price,
               expo: num(f.lots) * num(f.price) * num(f.size || 2000), ccy: 'TWD' });
  }
  for (const w of state.warrants) {
    if (norm(w.underlying) !== key) continue;
    // 權證的曝險不是它的市值，是 delta 換算後的標的曝險，所以這裡只列不加總
    out.push({ how: `權證 ${esc(w.code || '')}（標的）`, qty: `${fmt(w.lots)} 張`,
               cost: w.cost, price: w.price, expo: null, ccy: 'TWD' });
  }
  return out;
}

function stockCardHtml(mk, sym) {
  const key = mk === 'us' ? norm(sym) : resolveTwSymbol(sym);
  const mem = (mk === 'us' ? state.usThemeMembers : state.themeMembers)
    .filter((m) => norm(m.symbol) === key);
  const m0 = mem[0] || null;
  const risk = mk === 'us'
    ? state.usStats.find((r) => norm(r.symbol) === key)
    : state.riskStats.find((r) => norm(r.symbol) === key);
  const name = m0?.name || (mk === 'tw' ? TW_STOCKS[key] : '') || '';
  const price = mk === 'us'
    ? num(risk?.price) || num(state.us.find((u) => norm(u.symbol) === key)?.price_usd)
    : num(state.stocks.find((s) => norm(s.symbol) === key)?.price)
      || num(state.futures.find((f) => norm(f.symbol) === key)?.price)
      || num(risk?.last);
  const cur = mk === 'us' ? '$' : '';
  const bench = mk === 'us' ? usIdxRatio() : idxRatio();
  const beats = mk === 'us' ? usBeats : beatsIdx;
  const holds = symbolHoldings(mk, key);
  const rec = symbolRecord(mk, key);
  const themes = mem.map((m) => {
    const meta = state.themeMeta.find((x) => x.market === mk && x.theme === m.theme);
    const c = { up: state.themeLinks.filter((l) => l.market === mk && l.dst === m.theme),
                down: state.themeLinks.filter((l) => l.market === mk && l.src === m.theme) };
    return { theme: m.theme, meta, c };
  });

  const sec = (title, body) => body
    ? `<div class="sc-sec"><div class="sc-title">${title}</div>${body}</div>` : '';
  const kv = (k, v) => `<div class="row-between sub"><span class="muted">${k}</span><span>${v}</span></div>`;

  return `
    <div class="sc-head">
      <div class="row-between">
        <span class="sc-name" data-sc-nm="${esc(name)}"><b>${esc(key)}</b> ${esc(name)}</span>
        <span class="sc-px" data-px="${isNum(price) && num(price) > 0 ? 1 : 0}">${
          isNum(price) && num(price) > 0 ? cur + fmtMax(price, 2) : '…'}</span>
      </div>
      <div class="row-between sub muted">
        <span>${mk === 'us' ? '複委託 / 美股' : '台股'}${
          m0?.industry ? '・' + esc(m0.industry) : ''}<span data-sc-industry></span></span>
        <span>${state.guest ? '' : (holds.length ? '持有中' : '未持有')}</span>
      </div>
    </div>

    <div data-sc-biz></div>
    <div data-sc-range>${rangeHtml(risk, price)}</div>

    ${mk === 'tw' && alertOf(key) ? (() => {
      const a = alertOf(key);
      return `<div class="alert-box alert-${esc(a.kind)}">
        <div class="row-between"><b>${ALERT_LABEL[a.kind] || '警示'}</b>
          <span class="sub">${esc(a.name || '')}</span></div>
        <div class="sub">${esc(alertLine(a))}</div>
        ${a.reason ? `<div class="sub muted">${esc(stripTags(a.reason))}</div>` : ''}
        ${a.detail ? `<details class="sc-note"><summary>交易所公告原文</summary><p>${
          esc(a.detail)}</p></details>` : ''}
      </div>`;
    })() : ''}

    <div data-sc-day></div>

    ${state.guest ? '' : sec('我的部位', holds.length
      ? holds.map((h) => `${kv(h.how, `${h.qty}${
          isNum(h.expo) && num(h.expo) > 0
            ? `　曝險 ${h.ccy === 'USD' ? 'US$ ' : ''}${fmt(h.expo)}` : ''}`)}${
          isNum(h.cost) ? kv('　成本 / 現價', `${fmtMax(h.cost, 2)} → ${fmtMax(h.price, 2)}　<span class="${
            plClass(num(h.price) - num(h.cost))}">${signed((num(h.price) / num(h.cost) - 1) * 100, 1)}%</span>`) : ''}`).join('')
      : '<p class="sub muted">現在沒有部位。</p>')}
    ${state.guest ? '<p class="sub muted">登入之後這裡會顯示你在這一檔的部位與歷史成績。</p>' : ''}

    ${state.guest ? '' : sec('我在這一檔的成績', rec.n
      ? `${kv('已實現（扣成本後）', `<b class="${plClass(rec.net)}">${signed(rec.net)}</b>`)}
         ${kv('交易筆數', `${fmt(rec.n)} 筆　最後一筆 ${esc(rec.last || '')}`)}
         ${kv('手續費與稅', fmt(rec.cost))}
         ${['day', 'swing', 'roll'].filter((c) => rec.byCat[c]).map((c) =>
            kv('　' + CAT_LABEL[c], `<span class="${plClass(rec.byCat[c])}">${signed(rec.byCat[c])}</span>`)).join('')}`
      : '<p class="sub muted">還沒有在這一檔交易過。</p>')}

    ${sec('估值', mk === 'us'
      ? `${kv('本年本益比', isNum(m0?.pe_this) ? fmtMax(m0.pe_this, 1) + 'x' : '–')}
         ${kv('明年本益比', isNum(m0?.pe_next) ? fmtMax(m0.pe_next, 1) + 'x' : '–')}
         ${kv('分析師', num(m0?.analysts) > 0
            ? `${fmt(m0.analysts)} 位${num(m0.analysts) <= 5 ? ' ⚠ 樣本少' : ''}` : '無人覆蓋')}`
      : `${kv('近四季本益比', isNum(m0?.pe) ? fmtMax(m0.pe, 1) + 'x' : '虧損或無資料')}
         ${isNum(m0?.pe1) ? kv(`${String(m0.fy1).slice(2)} 年預估`,
            `<b>${fmtMax(m0.pe1, 1)}x</b>　EPS ${fmtMax(m0.eps1, 2)}`) : ''}
         ${isNum(m0?.pe2) ? kv(`${String(m0.fy2).slice(2)} 年預估`,
            `<b>${fmtMax(m0.pe2, 1)}x</b>　EPS ${fmtMax(m0.eps2, 2)}`) : ''}
         ${kv('分析師', num(m0?.an1) > 0
            ? `${fmt(m0.an1)} 位${num(m0.an1) <= 2 ? ' ⚠ 樣本少' : ''}` : '無人覆蓋')}`)
      + '<div data-sc-val></div>'}

    <div data-sc-risk>${riskHtml(risk, bench, beats)}</div>

    ${sec(mk === 'us' ? '營收預估' : '月營收', mk === 'us'
      ? `${kv('本年營收', `${usdB(m0?.rev_this)}美元　<span class="${plClass(num(m0?.rev_g))}">${
            isNum(m0?.rev_g) ? signed(num(m0.rev_g) * 100, 1) + '%' : '–'}</span>`)}
         ${kv('明年營收', `<span data-sc-revnext></span><span class="${plClass(num(m0?.rev_g_next))}">${
            isNum(m0?.rev_g_next) ? signed(num(m0.rev_g_next) * 100, 1) + '%' : '–'}</span>`)}`
      : (m0 ? kv(rocYm(m0.ym), `${fmt(num(m0.amount) / 100000, 1)} 億　<span class="${plClass(num(m0.yoy))}">${
            isNum(m0.yoy) ? signed(num(m0.yoy) * 100, 1) + '%' : '–'}</span>`) : '')
        + '<div data-sc-rev></div>')}

    <div data-sc-fin></div>

    ${sec('族群與供應鏈', themes.length
      ? themes.map((t) => `<div class="sc-theme">
          <div class="row-between">
            <span>${t.meta?.stage ? `<span class="stage stage-${esc(t.meta.stage)}">${esc(t.meta.stage)}</span>` : ''}
              <b>${esc(t.theme)}</b></span>
            <span class="sub muted">${esc(t.meta?.parent || '')}</span>
          </div>
          ${t.c.up.length ? `<div class="sub muted">↑ 上游　${t.c.up.map((l) => esc(l.src)).join('、')}</div>` : ''}
          ${t.c.down.length ? `<div class="sub muted">↓ 下游　${t.c.down.map((l) => esc(l.dst)).join('、')}</div>` : ''}
        </div>`).join('')
      : '<p class="sub muted">沒有登記在任何族群裡。</p>')}

    <p class="hint" data-sc-hint>價格與估值每天自動更新，區間與波動取自 Yahoo 三年日線。${
      state.guest ? '' : '「我在這一檔的成績」是這個帳號所有相關交易扣掉手續費與稅之後的淨額。'}</p>`;
}

// 任何列了股票的地方都可以掛這個：元素上寫 data-stock="tw:2330" 就能點開速覽
// 主動型 ETF 有沒有重壓這一檔。
//
//   **兩個數字要一起看。** 佔該檔 ETF 的權重高，只說明經理人押得重；
//   真正影響股價的是「這些基金合計吃掉這檔股票的幾 % 股本」——那是浮額
//   真的變少。小型股可能是三檔基金的第一大持股，但合計只買到 0.1% 股本，
//   對籌碼沒有意義；緯穎被 14 檔合計吃掉 6.9%，那才是。
//
//   資料是 CMoney 的完整持股（一檔平均 50 檔），不是前十大，
//   所以「沒出現」就真的是沒有人持有。
function etfOwnHtml(e) {
  if (!e || !num(e.funds)) return '';
  const own = num(e.own_pct);
  // 5% 是一個實務上的門檻：到這個量級，主動型 ETF 的申贖會直接影響股價
  const heavy = own >= 3;
  const list = (e.list || []).slice(0, 6);
  return `<div class="sc-etf${heavy ? ' heavy' : ''}">
    <div class="row-between">
      <span class="sc-story-tag">主動型 ETF</span>
      <span class="sc-own ${heavy ? 'gain' : ''}">${
        isNum(e.own_pct) ? fmt(own, 2) + '% 股本' : '–'}</span>
    </div>
    <p class="sub">${fmt(e.funds)} 檔主動型 ETF 持有它，單檔押最重的佔該檔基金
      <b>${fmt(e.max_weight, 1)}%</b>${
      heavy ? '，合計吃掉的股本已經到<b>浮額會變少</b>的量級' : ''}。</p>
    <div class="etf-chips">${list.map((x) => `<span class="etf-chip hold">${
      esc(x.name || x.etf)} <b>${fmt(x.weight, 1)}%</b></span>`).join('')}${
      (e.list || []).length > list.length
        ? `<span class="etf-chip">還有 ${(e.list || []).length - list.length} 檔</span>` : ''}</div>
    <p class="sub muted">${esc(e.as_of || '')}　資料來源 CMoney</p>
  </div>`;
}

export function bindStockOpen(host) {
  $$('[data-stock]', host).forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    const [mk, sym] = b.dataset.stock.split(':');
    openStock(mk, sym);
  }));
}

// 開啟速覽。先用記憶體裡的資料立刻畫出來，再把需要往返的深度資料補進去。
export async function openStock(mk, sym) {
  const market = mk === 'us' ? 'us' : 'tw';
  const key = market === 'us' ? norm(sym) : resolveTwSymbol(sym);
  if (!key) return;
  const dlg = $('#info-dialog');
  $('.info-body', dlg).innerHTML = stockCardHtml(market, key);
  $('#info-close').onclick = () => dlg.close();
  dlg.showModal();

  let d = null;
  try {
    const { data, error } = await sb.rpc('stock_detail', { p_market: market, p_symbol: key });
    if (!error) d = data;
  } catch { /* 補充資料拿不到就算了，上面該有的都已經畫出來 */ }
  if (!d || !dlg.open) return;
  const body = $('.info-body', dlg);
  const kv = (k, v) => `<div class="row-between sub"><span class="muted">${k}</span><span>${v}</span></div>`;

  const ind = $('[data-sc-industry]', body);
  if (ind && d.industry) ind.textContent = '・' + d.industry;

  // 名稱以 RPC 回來的為準。前端的 tw-stocks.json 是靜態檔，改名不會跟著動——
  // 1721 已經是國慶科技了，那份還寫三晃，而改名本身就是那一檔的重點。
  const nm = $('[data-sc-nm]', body);
  if (nm && d.name && d.name !== nm.dataset.scNm) {
    nm.innerHTML = `<b>${esc(key)}</b> ${esc(d.name)}`;
  }

  // 記憶體裡只有幾百檔的風險數字，全市場其他四千檔要靠這裡補。
  // 價格也一樣：沒持有、又不在族群裡的股票，前端沒有它的收盤價。
  const k = market === 'us' ? d.usrisk : d.risk;
  if (k) {
    const px = num(d.day?.price) || num(k.price) || num(k.last);
    const bench2 = market === 'us' ? usIdxRatio() : idxRatio();
    const beats2 = market === 'us' ? usBeats : beatsIdx;
    const rg = $('[data-sc-range]', body);
    if (rg && !rg.innerHTML.trim()) rg.innerHTML = rangeHtml(k, px);
    const rk = $('[data-sc-risk]', body);
    if (rk && !rk.innerHTML.trim()) rk.innerHTML = riskHtml(k, bench2, beats2);
    const pxEl = $('.sc-px', body);
    if (pxEl && isNum(px) && num(px) > 0 && !num(pxEl.dataset.px)) {
      pxEl.textContent = (market === 'us' ? '$' : '') + fmtMax(px, 2);
    }
  }
  // 公司自己申報的主要經營業務。證交所的「產業別」把金居、國巨、台光電
  // 全叫做電子零組件業，這一行才分得出誰在做什麼。
  const bz = $('[data-sc-biz]', body);
  if (bz) {
    // 轉型故事放在業務描述前面。**stage 要比標題顯眼**——
    //「已成主業」跟「試做送樣」在股價上可能一樣激動，在現實上差很遠。
    const st = d.story;
    bz.innerHTML = (st ? `<div class="sc-story stage-${esc(String(st.stage || '').slice(0, 4))}">
        <div class="row-between">
          <span class="sc-story-tag">轉型故事</span>
          <span class="sc-stage">${esc(st.stage || '')}</span>
        </div>
        <p class="sc-story-title">${mdBold(st.title)}</p>
        ${st.detail ? `<p class="sub">${mdBold(st.detail)}</p>` : ''}
        ${st.caution ? `<p class="sub sc-caution"><b>但書</b>　${mdBold(st.caution)}</p>` : ''}
        ${st.relates ? `<p class="sub muted">實質上屬於：${esc(st.relates)}</p>` : ''}
        <p class="sub muted">${esc(st.source || '')}${
          st.checked_on ? `　查證於 ${esc(st.checked_on)}` : ''}</p>
      </div>` : '')
      + etfOwnHtml(d.etf)
      + (d.business ? `<p class="sc-biz">${esc(d.business)}</p>` : '');
    bindStockOpen(bz);
  }

  const rn = $('[data-sc-revnext]', body);
  if (rn && isNum(d.us?.rev_next)) rn.textContent = usdB(d.us.rev_next) + '美元　';

  // 今天的表現。**「從當日低點拉起多少」才是強弱**，不是對昨收的漲跌幅。
  // 華新科 2026-09-10 對昨收 +4.5% 看起來還好，但它從低點 303 拉到 334 是 +10.2%。
  const dh = $('[data-sc-day]', body);
  if (dh && d.day && isNum(d.day.chg)) {
    const strong = num(d.day.off_low) > 0.05;
    dh.innerHTML = `<div class="sc-sec"><div class="sc-title">今日（${esc(d.day.as_of || '')} 收盤）</div>
      ${kv('對昨收', `<b class="${plClass(num(d.day.chg_pct))}">${
        signed(num(d.day.chg_pct) * 100, 2)}%</b>　${signed(num(d.day.chg), 2)}`)}
      ${kv('從當日低點拉起', `<b class="${strong ? 'gain' : ''}">${
        signed(num(d.day.off_low) * 100, 1)}%</b>${strong ? '　⚠ 今天是強勢股' : ''}`)}
      ${kv('開 / 高 / 低', `${fmtMax(d.day.open, 2)} / ${fmtMax(d.day.high, 2)} / ${fmtMax(d.day.low, 2)}`)}
      ${strong ? '<p class="sub warn-text">今天從低點拉起超過 5%。你的紀律是<b>不放空當天強勢的股票</b>，'
        + '尤其族群一起漲的時候。</p>' : ''}</div>`;
  }

  const vh = $('[data-sc-val]', body);
  if (vh && d.val) {
    vh.innerHTML = (isNum(d.val.pb) ? kv('股價淨值比', fmtMax(d.val.pb, 2) + 'x') : '')
      + (isNum(d.val.dy) && num(d.val.dy) > 0 ? kv('現金殖利率', fmtMax(d.val.dy, 2) + '%') : '');
  }
  // 每一年的預估：theme_members 只給兩年，這裡把 2028 與註解補齊。
  // 註解常常比數字重要——台玻那筆寫的是「這不是分析師共識，是新聞引述的無名法人」。
  if (Array.isArray(d.fc) && d.fc.length && vh) {
    // 上面已經用記憶體畫過 fy1 與 fy2 了，這裡只補沒畫到的年份（通常是 2028）
    const mem0 = (market === 'us' ? state.usThemeMembers : state.themeMembers)
      .find((m) => norm(m.symbol) === key);
    const shown = new Set([Number(mem0?.fy1), Number(mem0?.fy2)].filter(Number.isFinite));
    const rest = d.fc.filter((f) => !shown.has(Number(f.fy)));
    vh.insertAdjacentHTML('beforeend', rest.map((f) => kv(
      `${f.fy} 年 EPS`,
      `${fmtMax(f.eps, 2)}${isNum(f.analysts) && num(f.analysts) > 0 ? `　${fmt(f.analysts)} 位` : ''}${
        f.confidence ? `　<span class="muted">${CONF_LABEL[f.confidence] || esc(f.confidence)}</span>` : ''}`
    )).join('')
      + (d.fc.some((f) => f.note)
        ? `<details class="sc-note"><summary>預估的來源與但書</summary>${
            d.fc.filter((f) => f.note).map((f) =>
              `<p><b>${f.fy}：</b>${esc(f.note)}</p>`).join('')}</details>` : ''));
  }

  // 月營收表只留三個月：當月、上個月、去年同月。並排列出來會像資料斷掉，
  // 所以標成「上月」與「去年同月」，順便看得到月增率。
  const rh = $('[data-sc-rev]', body);
  if (rh && Array.isArray(d.rev) && d.rev.length > 1) {
    const cur = d.rev[0];
    const prev = d.rev.find((r) => r !== cur && r.ym === rocPrevYm(cur.ym));
    const ly = d.rev.find((r) => r !== cur && r !== prev);
    rh.innerHTML = (prev ? kv(`上月 ${rocYm(prev.ym)}`,
        `${fmt(num(prev.amount) / 100000, 1)} 億　<span class="${plClass(num(cur.amount) - num(prev.amount))}">月增 ${
          signed((num(cur.amount) / num(prev.amount) - 1) * 100, 1)}%</span>`) : '')
      + (ly ? kv(`去年同月 ${rocYm(ly.ym)}`, `${fmt(num(ly.amount) / 100000, 1)} 億`) : '');
  }

  // 季報累計 EPS。這是「已經賺到的」，拿來對照上面的預估合不合理。
  const fh = $('[data-sc-fin]', body);
  if (fh && Array.isArray(d.fin) && d.fin.length) {
    fh.innerHTML = `<div class="sc-sec"><div class="sc-title">財報（累計）</div>${
      d.fin.slice(0, 4).map((f) => kv(`${f.fy} 年 Q1–Q${f.q}`,
        `EPS ${fmtMax(f.eps_cum, 2)}${isNum(f.revenue) ? `　營收 ${fmt(num(f.revenue) / 100000, 1)} 億` : ''}`)).join('')}
      <p class="sub muted">累計是年初到該季的合計，不是單季。用來檢查上面的預估合不合理——
        已經賺到的如果比整年預估還多，那個預估就有問題。</p></div>`;
  }
}
