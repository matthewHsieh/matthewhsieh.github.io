-- ============================================================
-- 位階加權排序：(年化報酬 ＋ k × 從高點的跌幅) ÷ 波動
--
--   使用者的想法：年化 100%、波動 70%、從高點跌 20% 的股票，
--   排序時應該算 (100 + 20) / 70 = 1.71，而不是 100 / 70 = 1.43。
--
--   **回測結論：方向對，但統計上證不出來。**
--   2022-2026、48 個不重疊的 20 日換股點、前 15 檔、反波動權重，
--   配對檢定（同宇宙、同日期、同權重，只差排序）：
--       跌幅用三個月高點、k=1：每期 +0.27%，標準誤 0.21%，t = +1.28
--       跌幅用半年高點、k=1  ：每期 +0.13%，t = +0.50
--       跌幅用一年高點、k=1  ：每期 +0.00%，t = +0.01
--   前後兩半期都是正的（2.45→2.49、1.06→1.27），但換持股檔數就沒有一致性
--   （8 檔與 10 檔反而變差、15 檔變好、20~30 檔打平），那是噪音的樣子。
--
--   **但它有一個統計以外的理由站得住：** 比值的分子是「過去 250 日的報酬」，
--   一檔剛跌 20% 的股票，它的分子正是**因為這段跌幅**而變低的。
--   把跌幅加回去約等於問「不算這一段回檔的話，它的報酬是多少」——
--   那是在拿掉一個回頭看才有的偏誤，不完全是在賭均值回歸。
--
--   所以做成**可以關掉的選項**，預設 k = 0（不啟用），視窗固定三個月
--   （回測裡唯一有正向跡象的那個）。
-- ============================================================
create or replace function public.top_ratio(
  p_limit integer default 20,
  p_scope text default 'fut',
  p_min_days integer default 500,
  p_min_price numeric default 10,
  p_exclude_ind text[] default null,
  p_dd_k numeric default 0,
  p_dd_win integer default 63,
  p_min_ratio numeric default null)
returns table (symbol text, name text, ratio numeric, ratio_adj numeric, dd numeric,
               vol numeric, vol1y numeric, cagr numeric, last numeric,
               hi52 numeric, mdd numeric, industry text)
language sql stable security definer set search_path = public as $fn$
  with s as (
    select k.symbol,
           coalesce(u.name, f.name, k.symbol) as nm,
           k.ratio, k.vol, k.vol1y, k.cagr, k.last, k.hi52, k.mdd,
           public.pm_industry_of(k.symbol, u.industry) as ind,
           (select max(c) from (
                select sum(v) over (order by ord desc
                                    rows between unbounded preceding and current row) as c
                  from (select x as v, ord
                          from unnest(k.rets) with ordinality t(x, ord)
                         order by ord desc limit p_dd_win) w) q) as best
      from public.risk_stats k
      left join public.stock_universe u on u.symbol = k.symbol and u.market = 'tw'
      left join public.fut_codes f on f.symbol = k.symbol
     where k.symbol <> 'TAIEX'
       and k.ratio is not null
       and k.days >= p_min_days
       and k.last >= p_min_price
       and k.rets is not null
       and array_length(k.rets, 1) >= greatest(120, p_dd_win + 5)
       and (p_scope <> 'fut' or exists (select 1 from public.fut_codes c where c.symbol = k.symbol))
       and (p_exclude_ind is null
            or coalesce(public.pm_industry_of(k.symbol, u.industry), '') <> all (p_exclude_ind))
       -- **開了位階加權就一定要守基本品質。** 不然這條會變成「誰跌最慘買誰」：
       -- 2026-09-17 實測，玉晶光原始比值 0.91（低於指數 1.76）跌 53.6% 之後
       -- 調整後衝到 2.49 排第三。那是接刀，不是好標的的回檔。
       and (p_dd_k = 0
            or k.ratio >= coalesce(p_min_ratio,
                 (select x.ratio from public.risk_stats x where x.symbol = 'TAIEX'), 1.0))
  )
  select symbol, nm, ratio,
         -- **跌幅要用對數報酬直接加，跟 cagr 同一個尺度。**
         -- cagr 是 exp 之後存的百分比，所以先還原回對數再加，最後不用再轉回去，
         -- 因為排序只看大小。
         round((case when p_dd_k <> 0 and vol > 0
                     then (ln(1 + cagr) + p_dd_k * greatest(coalesce(best, 0), 0)) / vol
                     else ratio end)::numeric, 2) as ratio_adj,
         round((exp(-greatest(coalesce(best, 0), 0)) - 1)::numeric, 4) as dd,
         vol, vol1y, cagr, last, hi52, mdd, ind
    from s
   where p_dd_k = 0 or cagr > -0.99
   order by 4 desc, ratio desc
   limit greatest(1, least(p_limit, 60));
$fn$;

grant execute on function
  public.top_ratio(integer, text, integer, numeric, text[], numeric, integer, numeric)
  to authenticated;
revoke all on function
  public.top_ratio(integer, text, integer, numeric, text[], numeric, integer, numeric)
  from public, anon;
