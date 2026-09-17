-- ============================================================
-- 選股清單：報酬/波動 排行
--
--   2026-09-17 回測（251 檔個股期貨標的、2022-09~2026-09、每 20 日換股、
--   反波動權重、期貨費率）：
--       報酬/波動 前 10 檔   報酬/波動 3.01（指數 1.63）
--       前波強勢             2.32
--       短線跌最深           1.43   ← 比指數還差
--   **單一因子裡 報酬/波動 最強，而且加上「短線跌深」會把它拉低到 1.61。**
--   前 5 檔只有 2.20（太集中），前 15~30 檔在 2.4~2.5，所以預設給 20 檔。
--
--   但書都在 README 與畫面上：那四年指數本身就 3.40 倍，倖存者偏差存在，
--   而且 49 個換股點的 Sharpe 標準誤約 ±1.2。這是排行榜，不是保證。
--
--   scope = 'fut' 只給有掛個股期貨的（他能開槓桿、能放空、費率低 10 倍），
--   'all' 給全市場。
-- ============================================================
create or replace function public.top_ratio(
  p_limit integer default 20,
  p_scope text default 'fut',
  p_min_days integer default 500,
  p_min_price numeric default 10)
returns table (symbol text, name text, ratio numeric, vol numeric, vol1y numeric,
               cagr numeric, last numeric, hi52 numeric, mdd numeric)
language sql stable security definer set search_path = public as $fn$
  select k.symbol,
         coalesce(u.name, f.name, k.symbol),
         k.ratio, k.vol, k.vol1y, k.cagr, k.last, k.hi52, k.mdd
    from public.risk_stats k
    left join public.stock_universe u on u.symbol = k.symbol and u.market = 'tw'
    left join public.fut_codes f on f.symbol = k.symbol
   where k.symbol <> 'TAIEX'
     and k.ratio is not null
     and k.days >= p_min_days
     and k.last >= p_min_price
     -- **一定要有日報酬序列**，否則挑進來也算不出組合波動
     and k.rets is not null
     and array_length(k.rets, 1) >= 120
     and (p_scope <> 'fut' or exists (select 1 from public.fut_codes c where c.symbol = k.symbol))
   order by k.ratio desc
   limit greatest(1, least(p_limit, 60));
$fn$;

grant execute on function public.top_ratio(integer, text, integer, numeric) to authenticated;
revoke all on function public.top_ratio(integer, text, integer, numeric) from public, anon;
