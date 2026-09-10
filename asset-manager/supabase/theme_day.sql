-- ============================================================
-- 今天誰在動
--
-- 使用者 2026-09-10 立的紀律：**永遠不要放空當天強勢的股票，
-- 尤其是族群性大漲。** 那條規則要能執行，就得先看得到兩件事：
--
--   1. 今天哪個族群整群在漲（不是單一檔在漲）
--   2. 一檔股票今天「從當日低點拉了多少」
--
-- 第二點才是他真正的判準。華新科 2026-09-10 對昨收 319.5 還是跌的，
-- 看漲跌幅會以為它弱，但它已經從低點 303 拉了 14 塊——他在 317.5 空 2 口、
-- 328 回補，賠了 42,000。**只看對昨收的漲跌會做出完全相反的判斷。**
--
-- 資料在 market_prices 的 open/high/low/chg，跟收盤價同一個請求抓回來的。
-- 這是收盤資料，不是即時報價，用途是隔天回頭檢查自己做了什麼，
-- 不是盤中攔截（系統跟下單 App 沒有連線，他常常下單完才回來記錄）。
-- ============================================================

create or replace function public.stock_day(p_symbols text[] default null)
returns table (symbol text, name text, price numeric, chg numeric, chg_pct numeric,
               open numeric, high numeric, low numeric,
               off_low numeric,    -- 從當日低點拉起幾 %
               off_high numeric,   -- 離當日高點還差幾 %
               as_of date)
language sql stable security definer set search_path = public as $fn$
  select m.symbol, m.name, m.price, m.chg,
         case when m.price - coalesce(m.chg, 0) > 0
              then m.chg / (m.price - m.chg) end,
         m.open, m.high, m.low,
         case when m.low > 0 then m.price / m.low - 1 end,
         case when m.high > 0 then m.price / m.high - 1 end,
         m.as_of
  from public.market_prices m
  where m.market = 'tw'
    and (p_symbols is null or m.symbol = any (select upper(btrim(x)) from unnest(p_symbols) x));
$fn$;

-- 族群層級：整群在漲還是只有一兩檔在漲，是完全不同的兩件事。
-- 用中位數不用平均，一檔漲停就把平均拉爛。
create or replace function public.theme_day()
returns table (theme text, members integer, up integer, down integer,
               chg_med numeric, chg_avg numeric,
               off_low_med numeric,
               top_symbol text, top_name text, top_chg numeric,
               as_of date)
language sql stable security definer set search_path = public as $fn$
  with d as (
    select t.theme, m.symbol, coalesce(m.name, '') as name, m.as_of,
           case when m.price - coalesce(m.chg, 0) > 0 then m.chg / (m.price - m.chg) end as pct,
           case when m.low > 0 then m.price / m.low - 1 end as off_low
    from public.themes t
    join public.market_prices m on m.market = 'tw' and m.symbol = t.symbol
    where m.chg is not null
  ),
  agg as (
    select d.theme,
           count(*)::int as members,
           count(*) filter (where d.pct > 0)::int as up,
           count(*) filter (where d.pct < 0)::int as down,
           round(percentile_cont(0.5) within group (order by d.pct)::numeric, 4) as chg_med,
           round(avg(d.pct)::numeric, 4) as chg_avg,
           round(percentile_cont(0.5) within group (order by d.off_low)::numeric, 4) as off_low_med,
           max(d.as_of) as as_of
    from d group by d.theme
  ),
  top as (
    select distinct on (theme) theme, symbol, name, pct
    from d where pct is not null order by theme, pct desc
  )
  select a.theme, a.members, a.up, a.down, a.chg_med, a.chg_avg, a.off_low_med,
         t.symbol, t.name, t.pct, a.as_of
  from agg a left join top t on t.theme = a.theme
  order by a.chg_med desc nulls last;
$fn$;

grant execute on function public.stock_day(text[]) to authenticated;
grant execute on function public.theme_day()      to authenticated;
