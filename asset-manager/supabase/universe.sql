-- ============================================================
-- 可選股的股票池
--
-- 原本選股只能在 39 個族群的 171 檔裡面挑，那是「已經有人整理過的」，
-- 等於先幫自己把答案範圍縮小了。這裡把池子放到：
--   台股  全市場有在公告月營收的普通股，約 1,970 檔
--   美股  日成交額達門檻的股票，約 2,000 檔
--
-- **為什麼美股要設流動性門檻而不是全開。** 美國有 7,100 檔上市股票，
-- 其中一半以上一天成交不到兩百萬美元。那種標的就算篩出來也不能買——
-- 進得去出不來，滑價會吃掉所有價差。門檻設在日成交額 2,000 萬美元，
-- 剩下約 2,000 檔，都是真的可以下單的。
--
-- 台股不用設門檻，因為全市場才 1,970 檔，而且他本來就在這個市場裡交易。
-- ============================================================

create table if not exists public.stock_universe (
  market     text not null,          -- tw / us
  symbol     text not null,
  name       text,
  sector     text,
  industry   text,
  dollar_vol numeric,                -- 美股：抓取當日成交額（美元）
  market_cap numeric,
  as_of      date,
  updated_at timestamptz not null default now(),
  primary key (market, symbol)
);
create index if not exists stock_universe_market_idx on public.stock_universe (market);
alter table public.stock_universe enable row level security;
drop policy if exists "read universe" on public.stock_universe;
create policy "read universe" on public.stock_universe for select to authenticated using (true);

-- ------------------------------------------------------------
-- 台股：以「有在公告月營收」當作真正的營運公司名單。
-- 用這個而不是直接掃 market_prices，是因為 market_prices 裡混了
-- ETF（00 開頭）、特別股（2881A 這種）、TDR 與受益證券。
-- ------------------------------------------------------------
create or replace function public.refresh_universe_tw()
returns integer language plpgsql security definer set search_path = public as $fn$
declare n integer;
begin
  insert into public.stock_universe (market, symbol, name, industry, as_of, updated_at)
  select 'tw', r.symbol,
         coalesce(mp.name, r.name),
         r.industry,
         current_date, now()
  from (
    select distinct on (symbol) symbol, name, industry
    from public.revenue
    where symbol ~ '^[1-9][0-9]{3}$'
    order by symbol, ym desc
  ) r
  left join public.market_prices mp on mp.market = 'tw' and mp.symbol = r.symbol
  on conflict (market, symbol) do update
    set name = coalesce(excluded.name, stock_universe.name),
        industry = coalesce(excluded.industry, stock_universe.industry),
        as_of = excluded.as_of, updated_at = now();
  get diagnostics n = row_count;
  perform public.pm_log('universe tw', n, true, null);
  return n;
end $fn$;

-- ------------------------------------------------------------
-- 美股：Nasdaq 的 screener API 一次回全部 7,100 檔，含成交量、市值、產業。
-- 免費、免金鑰，但要帶瀏覽器 User-Agent，否則會被擋。
--
-- volume 是「抓取當天」的成交量，本身有雜訊（法說會、除息、指數調整都會爆量）。
-- 所以判斷用的是**現有值與新值取大**：一檔曾經有過足夠的流動性就留著，
-- 不會因為某天冷清就被踢出池子、隔天又加回來。
-- ------------------------------------------------------------
create or replace function public.refresh_universe_us(p_min_dollar_vol numeric default 20000000)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare payload jsonb; n integer := 0;
begin
  perform set_config('statement_timeout', '180s', true);
  payload := public.pm_fetch(
    'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&offset=0&download=true')::jsonb;

  insert into public.stock_universe (market, symbol, name, sector, industry,
                                     dollar_vol, market_cap, as_of, updated_at)
  select 'us', upper(btrim(e ->> 'symbol')), btrim(e ->> 'name'),
         nullif(btrim(e ->> 'sector'), ''), nullif(btrim(e ->> 'industry'), ''),
         public.pm_num(e ->> 'lastsale') * public.pm_num(e ->> 'volume'),
         public.pm_num(e ->> 'marketCap'),
         current_date, now()
  from jsonb_array_elements(payload -> 'data' -> 'rows') e
  where btrim(e ->> 'symbol') ~ '^[A-Z]{1,5}$'          -- 排除權證、特別股那種帶 ^ 或 / 的代號
    and public.pm_num(e ->> 'lastsale') * public.pm_num(e ->> 'volume') >= p_min_dollar_vol
  on conflict (market, symbol) do update
    set name = coalesce(excluded.name, stock_universe.name),
        sector = coalesce(excluded.sector, stock_universe.sector),
        industry = coalesce(excluded.industry, stock_universe.industry),
        -- 取大值：一檔曾經夠流動就留著，不要因為某天冷清就進進出出
        dollar_vol = greatest(coalesce(excluded.dollar_vol, 0),
                              coalesce(stock_universe.dollar_vol, 0)),
        market_cap = coalesce(excluded.market_cap, stock_universe.market_cap),
        as_of = excluded.as_of, updated_at = now();
  get diagnostics n = row_count;
  perform public.pm_log('universe us', n, true, null);
  return n;
exception when others then
  perform public.pm_log('universe us', 0, false, sqlerrm);
  return 0;
end $fn$;

revoke all on function public.refresh_universe_tw() from public, anon;
revoke all on function public.refresh_universe_us(numeric) from public, anon;

-- ------------------------------------------------------------
-- 美股的報酬/波動：只打 Yahoo，不碰 stockanalysis。
--
-- **為什麼要跟 refresh_us_stats 分開。** 那一支每檔要打兩個請求
-- （stockanalysis 的預估頁 ＋ Yahoo 日線），2,000 檔就是 4,000 次。
-- 但選股真正需要的只有價格區間與報酬/波動，那只要 Yahoo 一次。
-- 分析師預估留給 AI 產業地圖那 126 檔就好——那裡本益比才是重點。
--
-- 寫進同一張 us_stats，但**只碰風險欄位**，不會蓋掉預估欄位。
-- ------------------------------------------------------------
create or replace function public.refresh_us_risk(p_limit integer default 200)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; total integer := 0; got integer;
begin
  perform set_config('statement_timeout', '900s', true);

  for r in
    select u.symbol
    from (
      select symbol from public.stock_universe where market = 'us'
      union select symbol from public.us_themes
      union select upper(btrim(symbol)) from public.us_stocks
    ) u
    left join public.us_stats k on k.symbol = u.symbol
    order by k.updated_at nulls first
    limit p_limit
  loop
    begin
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || r.symbol || '?interval=1d&range=3y');
      insert into public.us_stats (symbol, price, vol, cagr, ratio, mdd, days,
                                   hi52, lo52, hi3y, lo3y, as_of, updated_at)
      select r.symbol, public.pm_yahoo_last(body),
             c.vol, c.cagr, c.ratio, c.mdd, c.days,
             c.hi52, c.lo52, c.hi3y, c.lo3y, current_date, now()
      from public.pm_risk_calc(body) c
      on conflict (symbol) do update
        set price = excluded.price, vol = excluded.vol, cagr = excluded.cagr,
            ratio = excluded.ratio, mdd = excluded.mdd, days = excluded.days,
            hi52 = excluded.hi52, lo52 = excluded.lo52,
            hi3y = excluded.hi3y, lo3y = excluded.lo3y,
            as_of = excluded.as_of, updated_at = now();
      get diagnostics got = row_count;
      total := total + got;
      if got = 0 then
        -- 查過但算不出來也要留時間戳，否則會一直重抓同一檔
        insert into public.us_stats (symbol, days, as_of, updated_at)
        values (r.symbol, 0, current_date, now())
        on conflict (symbol) do update set updated_at = now();
      end if;
    exception when others then
      perform public.pm_log('us_risk ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('us_risk', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_us_risk(integer) from public, anon;
