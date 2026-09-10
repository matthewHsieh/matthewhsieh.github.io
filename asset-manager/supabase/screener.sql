-- ============================================================
-- 選股（伺服器端）
--
-- **為什麼不在前端算。** 股票池從 171 檔放大到 4,000 檔之後，
-- 每次登入都把 4,000 列拉下來只為了篩出 30 檔是浪費的，手機更明顯。
-- 篩選與排序交給資料庫，一次只回前 N 檔。
--
-- 台股與美股欄位不同，但**篩選條件是同一組**，所以回傳格式統一：
--   台股的成長率 = 月營收年增（已發生），美股 = 明年營收預估（前瞻）
--   台股的本益比 = 分析師預估，沒有預估就退回近四季（官方每日公告，全市場都有）
-- 兩邊定義不同不能互相比較，畫面上要標清楚。
-- ============================================================

create or replace function public.screen_stocks(
  p_market   text    default 'tw',
  p_beat     boolean default true,      -- 報酬/波動要贏過大盤
  p_covered  boolean default false,     -- 要有分析師覆蓋
  p_clean    boolean default true,      -- 排除處置與注意股（只有台股有）
  p_drop     numeric default 20,        -- 從三年高點至少跌幾 %
  p_pe_max   numeric default 0,         -- 本益比上限，0 = 不限
  p_growth   numeric default null,      -- 營收年增至少幾 %
  p_sort     text    default 'drop',    -- drop / ratio / pe / growth
  p_limit    integer default 60
)
returns table (
  symbol text, name text, industry text,
  price numeric, drop_pct numeric, lo3y numeric, hi3y numeric,
  ratio numeric, vol numeric, cagr numeric, days integer,
  pe numeric, pe_src text, fy smallint, analysts smallint,
  growth numeric, themes text, alert_kind text, total integer
)
language sql stable security definer set search_path = public as $fn$
  with mk as (select case when lower(coalesce(p_market, '')) = 'us' then 'us' else 'tw' end as m),
  bench as (
    select case when (select m from mk) = 'us'
                then (select k.ratio from public.us_stats k where k.symbol = 'NDX')
                else (select k.ratio from public.risk_stats k where k.symbol = 'TAIEX') end as r
  ),
  -- **eps_resolved() 只呼叫一次。** 它是掃全表的 set-returning function，
  -- 如果寫成每一列一個 lateral，1,970 檔就是掃 1,970 次，
  -- 現在還跑得動只是因為 eps_estimate 才幾千列，之後一定會變慢。
  -- 取「今年起第一個有預估的年度」當基準年。
  eps as (
    select symbol, fy1, eps1, an1 from (
      select er.symbol, er.fy as fy1, er.eps as eps1, er.analysts as an1,
             row_number() over (partition by er.symbol order by er.fy) as rn
      from public.eps_resolved() er
      where er.eps is not null
        and er.fy >= extract(year from current_date)::int
    ) z where z.rn = 1
  ),
  base as (
    -- ── 台股 ───────────────────────────────────────
    select u.symbol, u.name, u.industry,
           coalesce(mp.price, k.last)                    as price,
           k.lo3y, k.hi3y, k.ratio, k.vol, k.cagr, k.days,
           -- 預估本益比優先，沒有就退回官方公告的近四季。
           -- **這個 fallback 很重要**：台股只有大約六成有人覆蓋，
           -- 沒有它的話四成的股票會因為「沒有本益比」被本益比條件濾掉，
           -- 而那不是它們貴或便宜的證據。
           coalesce(case when e.eps1 > 0 and coalesce(mp.price, k.last) > 0
                         then round(coalesce(mp.price, k.last) / e.eps1, 1) end, v.pe) as pe,
           case when e.eps1 > 0 and coalesce(mp.price, k.last) > 0 then '預估'
                when v.pe is not null then '近四季' end   as pe_src,
           e.fy1::smallint                               as fy,
           e.an1::smallint                               as analysts,
           r.yoy                                         as growth,
           (select string_agg(t.theme, '・' order by t.theme)
              from public.themes t where t.symbol = u.symbol) as themes,
           (select a.kind from public.trade_alerts a
             where a.symbol = u.symbol
               and ((a.kind = 'punish' and a.end_d >= current_date)
                    or (a.kind <> 'punish' and a.as_of >= current_date - 10))
             order by case a.kind when 'punish' then 3 when 'near' then 2 else 1 end desc
             limit 1)                                    as alert_kind
    from public.stock_universe u
    left join public.market_prices mp on mp.market = 'tw' and mp.symbol = u.symbol
    left join public.risk_stats k on k.symbol = u.symbol
    left join public.valuation v on v.symbol = u.symbol
    left join eps e on e.symbol = u.symbol
    left join lateral (
      select case when ly.amount > 0 then cur.amount / ly.amount - 1 end as yoy
      from public.revenue cur
      left join public.revenue ly on ly.symbol = cur.symbol
             and ly.ym = public.pm_ym_roc(public.pm_ym_add(cur.ym, -12))
      where cur.symbol = u.symbol
      order by cur.ym desc limit 1
    ) r on true
    where (select m from mk) = 'tw' and u.market = 'tw'

    union all

    -- ── 美股 ───────────────────────────────────────
    select u.symbol, u.name, u.industry,
           s.price, s.lo3y, s.hi3y, s.ratio, s.vol, s.cagr, s.days,
           s.pe_next, case when s.pe_next is not null then '明年預估' end,
           s.fy, s.analysts,
           s.rev_g_next,
           (select string_agg(t.theme, '・' order by t.theme)
              from public.us_themes t where t.symbol = u.symbol),
           null
    from public.stock_universe u
    left join public.us_stats s on s.symbol = u.symbol
    where (select m from mk) = 'us' and u.market = 'us'
  ),
  scored as (
    select b.*,
           case when b.hi3y > 0 and b.price > 0 then b.price / b.hi3y - 1 end as dp
    from base b
  ),
  hit as (
    select * from scored
    where (not p_beat    or (ratio is not null and ratio > (select r from bench)))
      and (not p_covered or coalesce(analysts, 0) >= 3)
      and (not p_clean   or alert_kind is null)
      and (coalesce(p_drop, 0) <= 0 or (dp is not null and dp <= -p_drop / 100))
      and (coalesce(p_pe_max, 0) <= 0 or (pe is not null and pe > 0 and pe <= p_pe_max))
      and (p_growth is null or (growth is not null and growth >= p_growth / 100))
  )
  select h.symbol, h.name, h.industry, h.price,
         round(h.dp, 4), h.lo3y, h.hi3y,
         h.ratio, h.vol, h.cagr, h.days,
         h.pe, h.pe_src, h.fy, h.analysts,
         h.growth, h.themes, h.alert_kind,
         (select count(*)::int from hit)
  from hit h
  order by
    case when p_sort = 'drop'   then h.dp end asc nulls last,
    case when p_sort = 'ratio'  then h.ratio end desc nulls last,
    case when p_sort = 'pe'     then h.pe end asc nulls last,
    case when p_sort = 'growth' then h.growth end desc nulls last,
    h.symbol
  limit greatest(1, least(coalesce(p_limit, 60), 200));
$fn$;

grant execute on function public.screen_stocks(text, boolean, boolean, boolean,
                                               numeric, numeric, numeric, text, integer)
  to authenticated, anon;
