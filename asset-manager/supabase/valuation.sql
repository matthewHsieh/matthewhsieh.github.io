-- ============================================================
-- 估值：本益比、股價淨值比、殖利率
--
-- 分成兩件性質完全不同的事，不要混為一談：
--
--   1. 「近四季本益比」——證交所與櫃買中心每天公告，**完全自動**，不需要任何人工輸入。
--      這是用已經發生的獲利算的，是事實不是預測。
--
--   2. 「26 / 27 / 28 年預估本益比」——需要分析師預估 EPS，
--      **台灣沒有任何免費 API 提供這個**。共識預估在 FactSet、彭博與券商報告裡，都要錢。
--      所以做法是：預估 EPS 存在資料庫（可以人工維護、可以自己改），
--      股價每天自動更新，本益比就跟著每天重算。
--      預估值變動頻率是季度級的，股價是每日級的，這樣分工才合理。
--
-- 重要觀念：預估本益比的分母是「別人的猜測」。
-- 同一檔股票不同券商的 2028 年 EPS 可以差一倍，算出來的本益比自然也差一倍。
-- 所以每一筆預估都存來源與查證日期，並且允許存區間，不要只看中位數。
-- ============================================================

-- ------------------------------------------------------------
-- 每日估值（官方公告，自動更新）
--   上市：證交所 BWIBBU_ALL，含本益比、殖利率、股價淨值比
--   上櫃：櫃買中心 tpex_mainboard_peratio_analysis
--   虧損公司本益比會是 "-"，pm_num 會轉成 null，不要當成 0
-- ------------------------------------------------------------
create table if not exists public.valuation (
  symbol     text primary key,
  name       text,
  pe         numeric,        -- 近四季本益比（虧損為 null）
  pb         numeric,        -- 股價淨值比
  dy         numeric,        -- 現金殖利率 %
  as_of      date,
  src        text,           -- twse / tpex
  updated_at timestamptz not null default now()
);
alter table public.valuation enable row level security;
drop policy if exists "read valuation" on public.valuation;
create policy "read valuation" on public.valuation for select to authenticated using (true);

create or replace function public.refresh_valuation()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; total integer := 0; payload jsonb; d date;
begin
  perform set_config('statement_timeout', '120s', true);

  -- 上市
  begin
    payload := public.pm_fetch(
      'https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?response=json')::jsonb;
    d := to_date(nullif(regexp_replace(coalesce(payload ->> 'date', ''), '[^0-9]', '', 'g'), ''),
                 'YYYYMMDD');
    insert into public.valuation (symbol, name, pe, dy, pb, as_of, src, updated_at)
    select upper(btrim(e ->> 0)), btrim(e ->> 1),
           public.pm_num(e ->> 2), public.pm_num(e ->> 3), public.pm_num(e ->> 4),
           d, 'twse', now()
    from jsonb_array_elements(payload -> 'data') e
    where btrim(e ->> 0) ~ '^[0-9]{4,6}[A-Z]?$'
    on conflict (symbol) do update
      set name = excluded.name, pe = excluded.pe, dy = excluded.dy, pb = excluded.pb,
          as_of = excluded.as_of, src = excluded.src, updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('valuation twse', n, true, null);
  exception when others then
    perform public.pm_log('valuation twse', 0, false, sqlerrm);
  end;

  -- 上櫃
  begin
    payload := public.pm_fetch(
      'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis')::jsonb;
    insert into public.valuation (symbol, name, pe, dy, pb, as_of, src, updated_at)
    select upper(btrim(e ->> 'SecuritiesCompanyCode')), btrim(e ->> 'CompanyName'),
           public.pm_num(e ->> 'PriceEarningRatio'),
           public.pm_num(e ->> 'YieldRatio'),
           public.pm_num(e ->> 'PriceBookRatio'),
           public.pm_roc_date(e ->> 'Date'), 'tpex', now()
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$'
    on conflict (symbol) do update
      set name = excluded.name, pe = excluded.pe, dy = excluded.dy, pb = excluded.pb,
          as_of = excluded.as_of, src = excluded.src, updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('valuation tpex', n, true, null);
  exception when others then
    perform public.pm_log('valuation tpex', 0, false, sqlerrm);
  end;

  return total;
end $fn$;

-- ------------------------------------------------------------
-- 預估 EPS（人工維護的共用參考值）
--   台灣沒有免費的分析師共識 API，這裡存的是新聞與券商報告裡公開引用的數字。
--   一定要寫來源與查證日期，因為這種數字三個月就會過期。
--   low / high 存不同券商的分歧，中位數會騙人。
-- ------------------------------------------------------------
create table if not exists public.eps_forecast (
  symbol     text not null,
  fy         smallint not null,        -- 會計年度，例如 2026
  eps        numeric,                  -- 預估每股盈餘（新台幣）
  low        numeric,
  high       numeric,
  source     text,                     -- 哪一家券商 / 機構
  note       text,
  checked_on date,
  updated_at timestamptz not null default now(),
  primary key (symbol, fy)
);
alter table public.eps_forecast enable row level security;
drop policy if exists "read eps forecast" on public.eps_forecast;
create policy "read eps forecast" on public.eps_forecast for select to authenticated using (true);

-- ------------------------------------------------------------
-- 使用者自己的預估（覆蓋共用參考值）
--   你不同意券商的數字時，自己填一個。填了就以你的為準。
--   這是使用者資料，受 RLS 保護，程式更新絕對不會動到。
-- ------------------------------------------------------------
create table if not exists public.eps_override (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  fy         smallint not null,
  eps        numeric,
  note       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol, fy)
);
alter table public.eps_override enable row level security;
drop policy if exists "own eps override" on public.eps_override;
create policy "own eps override" on public.eps_override for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 我的持倉估值
--   把現股、個股期貨標的、權證標的全部收進來，一檔一列。
--   股價用每日自動更新的收盤價，所以本益比每天都是新的。
--   預估本益比 = 現價 ÷ 預估 EPS；EPS <= 0 時回 null，因為虧損算本益比沒有意義。
-- ------------------------------------------------------------
create or replace function public.my_valuation()
returns table (
  symbol text, name text, price numeric, held text, ccy text,
  pe numeric, pb numeric, dy numeric, as_of date,
  fy2026 numeric, fy2027 numeric, fy2028 numeric,
  eps2026 numeric, eps2027 numeric, eps2028 numeric,
  eps_src text, eps_checked date, mine boolean
) language sql stable security definer set search_path = public as $fn$
  with held as (
    select upper(btrim(s.symbol)) as symbol, '現股' as how, 'TWD' as ccy from public.stocks s
     where s.user_id = auth.uid()
    union
    select upper(btrim(f.symbol)), '個股期', 'TWD' from public.futures f
     where f.user_id = auth.uid() and f.kind = 'stock' and f.symbol is not null
    union
    select upper(btrim(w.underlying)), '權證標的', 'TWD' from public.warrants w
     where w.user_id = auth.uid() and w.underlying is not null
    union
    -- 複委託：Yahoo 的估值端點現在要 crumb，抓不到近四季本益比，
    -- 但股價每天更新，所以只要自己填預估 EPS，預估本益比一樣會每天重算。
    select upper(btrim(u.symbol)), '複委託', 'USD' from public.us_stocks u
     where u.user_id = auth.uid()
  ),
  agg as (
    select symbol, string_agg(distinct how, '・' order by how) as how,
           min(ccy) as ccy
    from held group by symbol
  ),
  eps as (
    select coalesce(o.symbol, f.symbol) as symbol,
           coalesce(o.fy, f.fy)         as fy,
           coalesce(o.eps, f.eps)       as eps,
           (o.eps is not null)          as overridden,
           f.source, f.checked_on
    from public.eps_forecast f
    full outer join public.eps_override o
      on o.symbol = f.symbol and o.fy = f.fy and o.user_id = auth.uid()
    where coalesce(o.user_id, auth.uid()) = auth.uid()
  ),
  e as (
    select symbol,
           max(eps) filter (where fy = 2026) as e26,
           max(eps) filter (where fy = 2027) as e27,
           max(eps) filter (where fy = 2028) as e28,
           bool_or(overridden)                as overridden,
           max(source)     as source,
           max(checked_on) as checked_on
    from eps group by symbol
  )
  select a.symbol,
         coalesce(v.name, mp.name, us.name),
         coalesce(mp.price, us.price_usd),
         a.how, a.ccy,
         v.pe, v.pb, v.dy, v.as_of,
         case when e.e26 > 0 then round(coalesce(mp.price, us.price_usd) / e.e26, 1) end,
         case when e.e27 > 0 then round(coalesce(mp.price, us.price_usd) / e.e27, 1) end,
         case when e.e28 > 0 then round(coalesce(mp.price, us.price_usd) / e.e28, 1) end,
         e.e26, e.e27, e.e28,
         e.source, e.checked_on, coalesce(e.overridden, false)
  from agg a
  left join public.valuation v on v.symbol = a.symbol
  left join public.market_prices mp on mp.market = 'tw' and mp.symbol = a.symbol
  left join (select distinct on (upper(btrim(symbol))) upper(btrim(symbol)) as symbol, name, price_usd
             from public.us_stocks where user_id = auth.uid()) us on us.symbol = a.symbol
  left join e on e.symbol = a.symbol
  order by a.ccy desc, a.symbol;
$fn$;

-- ------------------------------------------------------------
-- 族群估值：成分股本益比的中位數
--   用中位數不用平均，因為一檔虧損或一檔異常高就會把平均拉爛。
--   虧損公司（pe 為 null）不計入，但另外回報有幾檔在虧損，那本身就是訊息。
-- ------------------------------------------------------------
create or replace function public.theme_valuation()
returns table (theme text, pe_median numeric, pb_median numeric, dy_median numeric,
               rated integer, loss integer)
language sql stable security definer set search_path = public as $fn$
  select t.theme,
         round(percentile_cont(0.5) within group (order by v.pe)::numeric, 1),
         round(percentile_cont(0.5) within group (order by v.pb)::numeric, 2),
         round(percentile_cont(0.5) within group (order by v.dy)::numeric, 2),
         count(v.pe)::int,
         count(*) filter (where v.symbol is not null and v.pe is null)::int
  from public.themes t
  left join public.valuation v on v.symbol = t.symbol
  group by t.theme
  order by t.theme;
$fn$;

grant execute on function public.my_valuation()    to authenticated;
grant execute on function public.theme_valuation() to authenticated;
revoke all on function public.refresh_valuation() from public, anon;
