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
              -- **stock_universe 優先。** 它是跟著最新的月營收公告更新的，
              -- market_prices 的名字會落後——1721 已經改名國慶科技了，
              -- 行情表裡還寫三晃，而改名本身正是那檔的重點。
              else coalesce(
                (select u.name from public.stock_universe u
                  where u.market = 'tw' and u.symbol = s.sym and u.name is not null),
                (select m.name from public.market_prices m
                  where m.market = 'tw' and m.symbol = s.sym and m.name is not null),
                (select r.name from public.revenue r
                  where r.symbol = s.sym and r.name is not null order by r.ym desc limit 1))
            end,
    -- 產業別是證交所公告月營收時附的，比自己分的族群粗，但可以當交叉檢查
    'industry', (select r.industry from public.revenue r
                  where r.symbol = s.sym and r.industry is not null order by r.ym desc limit 1),
    -- 公司自己在公開資訊觀測站申報的「主要經營業務」。
    -- 產業別分不出銅箔與 MLCC，這一行分得出來。
    'business', (select c.business from public.company_profile c where c.symbol = s.sym),
    -- 轉型故事。數字看不到的那一半：它「要變成什麼」。
    'story', (select jsonb_build_object('title', t.title, 'stage', t.stage, 'detail', t.detail,
                       'caution', t.caution, 'relates', t.relates, 'source', t.source,
                       'checked_on', t.checked_on)
                from public.stock_story t where t.symbol = s.sym),
    -- **有沒有主動型 ETF 重壓。**
    -- 兩個數字要一起看才有意義：
    --   weight   佔該檔 ETF 的幾 %——這是基金經理人押多重
    --   own_pct  這些 ETF 合計吃掉這檔股票的幾 % 股本——這是籌碼被鎖住多少
    -- 只看第一個會誤判：某檔小型股可能是三檔基金的第一大持股，
    -- 但如果它們合計只買到股本的 0.1%，對籌碼沒有影響。
    -- 反過來，緯穎被 14 檔合計吃掉 6.9% 股本，那是實打實的浮額減少。
    --
    -- **資料只有前十大。** 沒出現不代表沒人持有，只代表不在任何一檔的前十大。
    'etf', (select jsonb_build_object(
              'funds', count(*),
              'sum_weight', round(sum(h.weight), 1),
              'max_weight', round(max(h.weight), 2),
              'own_pct', round(sum(h.shares_held) / nullif(max(sh.shares), 0) * 100, 3),
              'as_of', max(h.as_of),
              'list', jsonb_agg(jsonb_build_object('etf', h.etf, 'name', e.name,
                                                   'weight', h.weight)
                                order by h.weight desc))
            from public.etf_holding h
            join public.active_etf e on e.symbol = h.etf
            left join public.stock_shares sh on sh.market = 'tw' and sh.symbol = h.symbol
            where h.symbol = s.sym and s.mk = 'tw'),
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
    -- 報酬/波動與價格區間。**這個一定要由這支回**，不能靠前端整批載——
    -- risk_stats 現在有 1,975 列，PostgREST 預設只回前 1,000 列，
    -- 整批載會安靜地少掉一半，而且是「有些股票沒有風險數字」這種不好察覺的壞法。
    'risk', (select jsonb_build_object(
                      'ratio', k.ratio, 'vol', k.vol, 'cagr', k.cagr, 'mdd', k.mdd,
                      'days', k.days, 'hi52', k.hi52, 'lo52', k.lo52,
                      'hi3y', k.hi3y, 'lo3y', k.lo3y, 'last', k.last, 'as_of', k.as_of)
              from public.risk_stats k where s.mk = 'tw' and k.symbol = s.sym),
    'usrisk', (select jsonb_build_object(
                      'ratio', k.ratio, 'vol', k.vol, 'cagr', k.cagr, 'mdd', k.mdd,
                      'days', k.days, 'hi52', k.hi52, 'lo52', k.lo52,
                      'hi3y', k.hi3y, 'lo3y', k.lo3y, 'price', k.price, 'as_of', k.as_of)
                from public.us_stats k where s.mk = 'us' and k.symbol = s.sym),
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

-- ------------------------------------------------------------
-- App 要整批載的風險數字，**只回真的用得到的那幾百檔**：
-- 兩個基準指數、族群成分股、自己的持股。
--
-- 為什麼不直接 select 整張表：risk_stats 有 1,975 列、us_stats 2,064 列，
-- PostgREST 預設上限 1,000 列，整批載會安靜地截斷。
-- 截斷的症狀很難察覺——畫面不會報錯，只會有些股票的報酬/波動變成「–」。
-- ------------------------------------------------------------
create or replace function public.app_risk()
returns table (market text, symbol text, ratio numeric, vol numeric, cagr numeric,
               mdd numeric, days integer, hi52 numeric, lo52 numeric,
               hi3y numeric, lo3y numeric, last numeric, price numeric)
language sql stable security definer set search_path = public as $fn$
  select 'tw', k.symbol, k.ratio, k.vol, k.cagr, k.mdd, k.days,
         k.hi52, k.lo52, k.hi3y, k.lo3y, k.last, null::numeric
  from public.risk_stats k
  where k.symbol = 'TAIEX'
     or k.symbol in (select t.symbol from public.themes t)
     -- security definer 會繞過 RLS，所以持股這幾張表要自己加 auth.uid()，
     -- 否則會把別人持有哪些代號一起回出去（匿名瀏覽時更明顯）
     or k.symbol in (select upper(btrim(x.symbol)) from public.stocks x
                      where x.user_id = auth.uid())
     or k.symbol in (select upper(btrim(x.symbol)) from public.futures x
                      where x.user_id = auth.uid() and x.kind = 'stock' and x.symbol is not null)
     or k.symbol in (select upper(btrim(x.underlying)) from public.warrants x
                      where x.user_id = auth.uid() and x.underlying is not null)
  union all
  select 'us', k.symbol, k.ratio, k.vol, k.cagr, k.mdd, k.days,
         k.hi52, k.lo52, k.hi3y, k.lo3y, null::numeric, k.price
  from public.us_stats k
  where k.symbol = 'NDX'
     or k.symbol in (select t.symbol from public.us_themes t)
     or k.symbol in (select upper(btrim(x.symbol)) from public.us_stocks x
                      where x.user_id = auth.uid());
$fn$;

grant execute on function public.app_risk() to authenticated, anon;
