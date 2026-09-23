-- 舊的 6 參數版本要先丟掉，否則 drop_hits() 呼叫會變成 ambiguous
drop function if exists public.drop_hits(numeric, numeric, integer, text, integer, numeric);
drop function if exists public.drop_hits(numeric, numeric, integer, text, integer);
drop function if exists public.top_ratio(integer, text, integer, numeric);

-- ------------------------------------------------------------
-- 「這檔算不算被排除的產業」
--
--   stock_universe 有漏：2883 凱基金、0050 都不在裡面（1,978 檔，
--   有 industry 的也是 1,978，但那兩檔整列就沒有），所以 left join 出來是 null，
--   單純比對 industry 會讓凱基金從「排除金融股」的篩選漏出去。
--
--   補一條代號規則當後援：**台股 28xx 全部是金融保險業**。
--   2026-09-17 驗證過兩個方向：31 檔金融保險業裡 28xx 佔 27 檔，
--   而且 `symbol ~ '^28' and industry <> '金融保險業'` 查出來是 0 筆。
--   58xx／60xx 不能這樣用（5871 中租-KY 是租賃、不是金融），所以只放 28xx。
-- ------------------------------------------------------------
create or replace function public.pm_industry_of(p_symbol text, p_industry text)
returns text language sql immutable as $fn$
  select coalesce(nullif(p_industry, ''),
                  case when p_symbol ~ '^28[0-9]{2}$' then '金融保險業' end);
$fn$;

create or replace function public.top_ratio(
  p_limit integer default 20,
  p_scope text default 'fut',
  p_min_days integer default 500,
  p_min_price numeric default 10,
  p_exclude_ind text[] default null)
returns table (symbol text, name text, ratio numeric, vol numeric, vol1y numeric,
               cagr numeric, last numeric, hi52 numeric, mdd numeric, industry text)
language sql stable security definer set search_path = public as $fn$
  select k.symbol,
         coalesce(u.name, f.name, k.symbol),
         k.ratio, k.vol, k.vol1y, k.cagr, k.last, k.hi52, k.mdd,
         public.pm_industry_of(k.symbol, u.industry)
    from public.risk_stats k
    left join public.stock_universe u on u.symbol = k.symbol and u.market = 'tw'
    left join public.fut_codes f on f.symbol = k.symbol
   where k.symbol <> 'TAIEX'
     and k.ratio is not null
     and k.days >= p_min_days
     and k.last >= p_min_price
     and k.rets is not null
     and array_length(k.rets, 1) >= 120
     and (p_scope <> 'fut' or exists (select 1 from public.fut_codes c where c.symbol = k.symbol))
     and (p_exclude_ind is null
          or coalesce(public.pm_industry_of(k.symbol, u.industry), '') <> all (p_exclude_ind))
   order by k.ratio desc
   limit greatest(1, least(p_limit, 60));
$fn$;

grant execute on function public.top_ratio(integer, text, integer, numeric, text[]) to authenticated;
revoke all on function public.top_ratio(integer, text, integer, numeric, text[]) from public, anon;


-- 舊的六參數版本（drop_hits.sql）要清掉，理由同 dd_rank.sql 裡那一段：
-- 參數數量不同的多載會並存，呼叫時少帶一個參數就變成不唯一。
drop function if exists public.drop_hits(numeric, numeric, integer, text, integer, numeric);

create or replace function public.drop_hits(
  p_z numeric default -2.0,
  p_min_ratio numeric default null,
  p_win integer default 63,
  p_scope text default 'fut',
  p_limit integer default 30,
  p_min_dd numeric default 0.12,
  p_exclude_ind text[] default null)
returns table (symbol text, name text, z numeric, dd numeric,
               vol1y numeric, vol_recent numeric, vol_shift numeric,
               ratio numeric, last numeric, industry text)
language sql stable security definer set search_path = public as $fn$
  with base as (
    select coalesce(p_min_ratio,
                    (select k.ratio from public.risk_stats k where k.symbol = 'TAIEX'),
                    1.0) as min_ratio
  ), s as (
    select k.symbol,
           coalesce(u.name, f.name, k.symbol) as nm,
           k.vol1y, k.ratio, k.last,
           public.pm_industry_of(k.symbol, u.industry) as ind,
           (select array_agg(x order by ord)
              from (select x, ord from unnest(k.rets) with ordinality t(x, ord)
                     order by ord desc limit p_win) q) as r,
           (select array_agg(x order by ord)
              from (select x, ord from unnest(k.rets) with ordinality t(x, ord)
                     order by ord desc limit 21) q) as r21
      from public.risk_stats k
      left join public.stock_universe u on u.symbol = k.symbol and u.market = 'tw'
      left join public.fut_codes f on f.symbol = k.symbol
     cross join base b
     where k.rets is not null
       and array_length(k.rets, 1) >= p_win + 5
       and k.symbol <> 'TAIEX'
       and k.ratio >= b.min_ratio
       and (p_scope <> 'fut'
            or exists (select 1 from public.fut_codes c where c.symbol = k.symbol))
       and (p_exclude_ind is null
            or coalesce(public.pm_industry_of(k.symbol, u.industry), '') <> all (p_exclude_ind))
  ), m as (
    select symbol, nm, vol1y, ratio, last, ind,
           (select stddev_pop(ln(1 + greatest(v, -0.99))) from unnest(r) v) as sd,
           (select stddev_pop(ln(1 + greatest(v, -0.99))) from unnest(r21) v) as sd21,
           -- 從最後一天往回累加對數報酬，c = 「從那一天收盤到現在漲了多少」。
           -- 期間高點是讓 c **最小**的那一天，所以取 min。
           -- **2026-09-23 修正：原本取 max，那是離期間最低點多遠再加負號**，
           -- 漲越多 z 越負——健策漲停創新高被標成 −1.8σ、聯發科貼高點 −1.5σ，
           -- 真正回檔中的台光電反而只有 −0.4σ。位階警示從 9/17 上線起列的其實是強勢股。
           -- App 的 risk.js dropZ() 同一天一起修，兩邊的定義必須一致。
           (select min(c) from (
              select sum(ln(1 + greatest(v, -0.99))) over (order by ord desc
                                  rows between unbounded preceding and current row) as c
                from unnest(r) with ordinality t(v, ord)) q) as worst
      from s
  )
  select symbol, nm,
         round((least(worst, 0) / (sd * sqrt(p_win)))::numeric, 2),
         round((exp(least(worst, 0)) - 1)::numeric, 4),
         vol1y,
         round((sd21 * sqrt(252.0))::numeric, 4),
         case when vol1y > 0 then round((sd21 * sqrt(252.0) / vol1y)::numeric, 2) end,
         ratio, last, ind
    from m
   where sd > 0
     and (least(worst, 0) / (sd * sqrt(p_win))) <= p_z
     and (exp(least(worst, 0)) - 1) <= -p_min_dd
   order by 3
   limit greatest(1, least(p_limit, 50));
$fn$;

grant execute on function public.drop_hits(numeric, numeric, integer, text, integer, numeric, text[])
  to authenticated;
revoke all on function public.drop_hits(numeric, numeric, integer, text, integer, numeric, text[])
  from public, anon;
