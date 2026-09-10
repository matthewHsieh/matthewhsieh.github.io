-- ============================================================
-- 個股速覽
--
-- 族群頁與產業鏈上點到一檔股票時，要能馬上看到它「大概是什麼狀態」。
-- 大部分數字（現價、本益比、報酬/波動、營收年增）在登入時就已經整批
-- 抓進記憶體了，畫面用那些就能立刻畫出來，不需要等這支函式。
--
-- 這支只補「不值得為了全市場都載一份」的深度資料：
--   股價淨值比與殖利率、產業別、近幾季的累計 EPS、每一年的預估 EPS
--   （包含 2028，theme_members 只給兩年）、月營收明細。
--
-- 一檔一次往返，資料量小，不快取。
-- ============================================================

create or replace function public.stock_detail(p_market text, p_symbol text)
returns jsonb
language sql stable security definer set search_path = public as $fn$
  with s as (
    select upper(btrim(p_symbol)) as sym,
           case when lower(coalesce(p_market, '')) = 'us' then 'us' else 'tw' end as mk
  )
  select jsonb_build_object(
    'symbol', s.sym,
    'market', s.mk,
    'name', case when s.mk = 'us'
              then (select t.name from public.us_themes t where t.symbol = s.sym and t.name is not null limit 1)
              else coalesce(
                (select m.name from public.market_prices m
                  where m.market = 'tw' and m.symbol = s.sym and m.name is not null),
                (select r.name from public.revenue r
                  where r.symbol = s.sym and r.name is not null order by r.ym desc limit 1))
            end,
    -- 產業別是證交所公告月營收時附的，比自己分的族群粗，但可以當交叉檢查
    'industry', (select r.industry from public.revenue r
                  where r.symbol = s.sym and r.industry is not null order by r.ym desc limit 1),
    -- 今天的開高低與漲跌。**「從當日低點拉起多少」才是判斷強弱的數字**，
    -- 不是對昨收的漲跌幅，理由見 theme_day.sql。
    'day', (select jsonb_build_object('price', m.price, 'chg', m.chg,
                     'chg_pct', case when m.price - coalesce(m.chg, 0) > 0
                                     then m.chg / (m.price - m.chg) end,
                     'open', m.open, 'high', m.high, 'low', m.low,
                     'off_low', case when m.low > 0 then m.price / m.low - 1 end,
                     'as_of', m.as_of)
             from public.market_prices m
             where s.mk = 'tw' and m.market = 'tw' and m.symbol = s.sym and m.chg is not null),
    'val', (select jsonb_build_object('pe', v.pe, 'pb', v.pb, 'dy', v.dy,
                                      'as_of', v.as_of, 'src', v.src)
              from public.valuation v where v.symbol = s.sym),
    'us', (select jsonb_build_object(
                    'fy', u.fy, 'analysts', u.analysts,
                    'rev_this', u.rev_this, 'rev_next', u.rev_next,
                    'rev_g', u.rev_g, 'rev_g_next', u.rev_g_next,
                    'eps_this', u.eps_this, 'eps_next', u.eps_next, 'eps_g', u.eps_g,
                    'pe_this', u.pe_this, 'pe_next', u.pe_next, 'as_of', u.as_of)
             from public.us_stats u where s.mk = 'us' and u.symbol = s.sym),
    -- 累計 EPS：官方季報，是「已經發生」的部分，用來判斷預估合不合理
    'fin', coalesce((
      select jsonb_agg(jsonb_build_object('fy', f.fy, 'q', f.q, 'eps_cum', f.eps_cum,
                                          'revenue', f.revenue, 'net_income', f.net_income)
                       order by f.fy desc, f.q desc)
      from public.financials f where f.symbol = s.sym), '[]'::jsonb),
    -- 每一年的預估 EPS，含來源與可信度；theme_members 只給兩年，這裡給全部
    'fc', coalesce((
      select jsonb_agg(jsonb_build_object('fy', e.fy, 'eps', e.eps, 'analysts', e.analysts,
                                          'src', e.src, 'confidence', e.confidence, 'note', e.note)
                       order by e.fy)
      from public.eps_resolved() e where e.symbol = s.sym and e.eps is not null), '[]'::jsonb),
    'rev', coalesce((
      select jsonb_agg(jsonb_build_object('ym', r.ym, 'amount', r.amount,
                       'yoy', case when ly.amount > 0 then r.amount / ly.amount - 1 end)
                       order by r.ym desc)
      from public.revenue r
      left join public.revenue ly on ly.symbol = r.symbol
             and ly.ym = public.pm_ym_roc(public.pm_ym_add(r.ym, -12))
      where r.symbol = s.sym), '[]'::jsonb)
  )
  from s;
$fn$;

grant execute on function public.stock_detail(text, text) to authenticated;
