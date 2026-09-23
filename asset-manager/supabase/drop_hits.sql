-- ============================================================
-- 位階掃描：離近三個月高點超過 N 個標準差的標的
--
--   **用標準差不是百分比。** 金居月波動 26%，跌 20% 只是 −0.44σ，對它是家常便飯；
--   加權指數月波動 4%，跌 10% 卻是 −1.44σ。用百分比篩會整個篩錯對象。
--
--   **但只用標準差會掃出一堆金融股。** 2026-09-17 第一版就是這樣：
--   前七名有五檔是金控（2884 −2.62σ、2801 −2.31σ、2883 −2.31σ…）。
--   原因是 z 分數是相對的——波動 20% 的金控跌一點點就是好幾個標準差，
--   但那個「好幾個標準差」對應的實際跌幅小到沒有交易價值。
--   所以要**同時**要求兩件事：
--     1. z ≤ 門檻（相對於它自己夠極端）
--     2. 實際跌幅 ≥ p_min_dd（絕對值上真的跌得夠多，預設 12%）
--   另外把比值門檻預設綁到加權指數自己的比值——**贏不過指數就不值得單獨持有**，
--   這也是 App 其它地方一直在用的那條基準線。
--
--   窗口用 63 個交易日（約三個月）。60 個交易日其實也差不多是三個月，
--   但寫 63 意思清楚一點。
-- ============================================================
create or replace function public.drop_hits(
  p_z numeric default -2.0,
  p_min_ratio numeric default null,      -- null = 用加權指數的比值當門檻
  p_win integer default 63,
  p_scope text default 'fut',
  p_limit integer default 30,
  p_min_dd numeric default 0.12)         -- 實際至少要跌這麼多
returns table (symbol text, name text, z numeric, dd numeric,
               vol1y numeric, ratio numeric, last numeric)
language sql stable security definer set search_path = public as $fn$
  with base as (
    select coalesce(p_min_ratio,
                    (select k.ratio from public.risk_stats k where k.symbol = 'TAIEX'),
                    1.0) as min_ratio
  ), s as (
    select k.symbol,
           coalesce(u.name, f.name, k.symbol) as nm,
           k.vol1y, k.ratio, k.last,
           (select array_agg(x order by ord)
              from (select x, ord
                      from unnest(k.rets) with ordinality t(x, ord)
                     order by ord desc
                     limit p_win) q) as r
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
  ), m as (
    select symbol, nm, vol1y, ratio, last,
           (select stddev_pop(ln(1 + greatest(v, -0.99))) from unnest(r) v) as sd,
           -- 從最後一天往回累加對數報酬，c = 「從那一天收盤到現在漲了多少」。
           -- 期間高點是讓 c **最小**的那一天，所以取 min。
           -- **2026-09-23 修正：原本取 max，那是離期間最低點多遠再加負號**，
           -- 漲越多 z 越負——健策漲停創新高被標成 −1.8σ、聯發科貼高點 −1.5σ，
           -- 真正回檔中的台光電反而只有 −0.4σ。位階警示因此一直在列強勢股。
           (select min(c) from (
              select sum(ln(1 + greatest(v, -0.99))) over (order by ord desc
                                  rows between unbounded preceding and current row) as c
                from unnest(r) with ordinality t(v, ord)) q) as worst
      from s
  )
  select symbol, nm,
         round((least(worst, 0) / (sd * sqrt(p_win)))::numeric, 2) as z,
         round((exp(least(worst, 0)) - 1)::numeric, 4) as dd,
         vol1y, ratio, last
    from m
   where sd > 0
     and (least(worst, 0) / (sd * sqrt(p_win))) <= p_z
     and (exp(least(worst, 0)) - 1) <= -p_min_dd
   order by z
   limit greatest(1, least(p_limit, 50));
$fn$;

grant execute on function public.drop_hits(numeric, numeric, integer, text, integer, numeric)
  to authenticated;
revoke all on function public.drop_hits(numeric, numeric, integer, text, integer, numeric)
  from public, anon;
