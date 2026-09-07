-- ============================================================
-- 每日行情自動更新（全部在資料庫裡跑，手機不用開著也會更新）
--   台股收盤價   ← 證交所 + 櫃買中心 OpenAPI
--   指數期貨結算價 ← 期交所 OpenAPI（TX 大台 / MTX 小台 / TMF 微台 ...）
--   個股期貨      ← 以標的股票收盤價計價（曝險 = 口數 × 等同股數 × 股價）
--   美股          ← Yahoo Finance（只抓你持有的代號）
--   美金匯率      ← 期交所每日匯率
-- 執行：SQL Editor 貼上整段 → Run（可重複執行）
-- ============================================================

create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

-- ------------------------------------------------------------
-- 行情快取（全站共用，登入者可讀，只有排程/RPC 能寫）
-- ------------------------------------------------------------
create table if not exists public.market_prices (
  market     text not null check (market in ('tw','us','fut','fx')),
  symbol     text not null,
  name       text,
  price      numeric not null,
  as_of      date,
  updated_at timestamptz not null default now(),
  primary key (market, symbol)
);

alter table public.market_prices enable row level security;
drop policy if exists "read prices" on public.market_prices;
create policy "read prices" on public.market_prices for select to authenticated using (true);

-- 每次更新的執行紀錄，方便查為什麼沒更新
create table if not exists public.price_runs (
  id         bigint generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  source     text not null,
  rows       integer,
  ok         boolean not null,
  message    text
);
alter table public.price_runs enable row level security;
drop policy if exists "read runs" on public.price_runs;
create policy "read runs" on public.price_runs for select to authenticated using (true);

-- ------------------------------------------------------------
-- 小工具
-- ------------------------------------------------------------
-- 寬鬆的數字轉換："1,234.5" → 1234.5，"--" / "NULL" / "" → null
create or replace function public.pm_num(t text)
returns numeric language plpgsql immutable as $$
begin
  return nullif(regexp_replace(coalesce(t, ''), '[^0-9.\-]', '', 'g'), '')::numeric;
exception when others then
  return null;
end $$;

-- 民國日期 "1150904" → 2026-09-04
create or replace function public.pm_roc_date(t text)
returns date language plpgsql immutable as $$
declare s text := regexp_replace(coalesce(t, ''), '[^0-9]', '', 'g');
begin
  if length(s) < 7 then return null; end if;
  return to_date(((substr(s, 1, length(s) - 4))::int + 1911)::text || right(s, 4), 'YYYYMMDD');
exception when others then
  return null;
end $$;

create or replace function public.pm_fetch(p_url text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare body text;
begin
  select content into body from extensions.http((
    'GET', p_url,
    array[extensions.http_header('User-Agent', 'Mozilla/5.0 (asset-manager)')],
    null, null)::extensions.http_request);
  return body;
end $$;

create or replace function public.pm_log(p_source text, p_rows integer, p_ok boolean, p_msg text)
returns void language sql security definer set search_path = public as $$
  insert into public.price_runs(source, rows, ok, message) values (p_source, p_rows, p_ok, left(p_msg, 500));
$$;

-- ------------------------------------------------------------
-- 台股收盤價（上市 + 上櫃）
--   上市：用證交所「每日收盤行情」MI_INDEX，要帶日期。
--         （原本用的 STOCK_DAY_ALL 會落後好幾天，2026-09-08 實測仍停在 09-04）
--         日期以台北時區為準，從最近一天往回找，遇到假日自動退一天。
--   上櫃：櫃買中心的端點永遠回最新交易日，不用帶日期。
-- ------------------------------------------------------------
create or replace function public.refresh_tw_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  n integer := 0; total integer := 0;
  payload jsonb; tbl jsonb;
  d date; i integer; got boolean := false;
begin
  perform set_config('statement_timeout', '180s', true);

  -- ---------- 上市：往回找最近一個有資料的交易日 ----------
  begin
    d := (now() at time zone 'Asia/Taipei')::date;
    for i in 0..8 loop
      begin
        payload := public.pm_fetch(
          'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date='
          || to_char(d - i, 'YYYYMMDD') || '&type=ALLBUT0999&response=json')::jsonb;
      exception when others then
        payload := null;
      end;

      if payload is not null and payload ->> 'stat' = 'OK' then
        select t into tbl
        from jsonb_array_elements(payload -> 'tables') t
        where t ->> 'title' like '%每日收盤行情%'
        limit 1;

        if tbl is not null and jsonb_array_length(coalesce(tbl -> 'data', '[]'::jsonb)) > 0 then
          insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
          select 'tw', upper(btrim(r ->> 0)), btrim(r ->> 1),
                 public.pm_num(r ->> 8), d - i, now()
          from jsonb_array_elements(tbl -> 'data') r
          where btrim(r ->> 0) ~ '^[0-9]{4,6}[A-Z]?$'
            and public.pm_num(r ->> 8) > 0
          on conflict (market, symbol) do update
            set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
                as_of = excluded.as_of, updated_at = now();
          get diagnostics n = row_count; total := total + n;
          perform public.pm_log('twse_mi_index ' || to_char(d - i, 'YYYY-MM-DD'), n, true, null);
          got := true;
          exit;
        end if;
      end if;
    end loop;

    if not got then
      perform public.pm_log('twse_mi_index', 0, false, 'no trading day found in last 9 days');
    end if;
  exception when others then
    perform public.pm_log('twse_mi_index', 0, false, sqlerrm);
  end;

  -- ---------- 上市備援：MI_INDEX 掛掉時才用（資料可能落後） ----------
  if not got then
    begin
      payload := public.pm_fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')::jsonb;
      insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
      select 'tw', upper(btrim(e ->> 'Code')), btrim(e ->> 'Name'),
             public.pm_num(e ->> 'ClosingPrice'), public.pm_roc_date(e ->> 'Date'), now()
      from jsonb_array_elements(payload) e
      where btrim(e ->> 'Code') ~ '^[0-9]{4,6}[A-Z]?$'
        and public.pm_num(e ->> 'ClosingPrice') > 0
      on conflict (market, symbol) do update
        set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
            as_of = excluded.as_of, updated_at = now();
      get diagnostics n = row_count; total := total + n;
      perform public.pm_log('twse_stock_day_all(備援)', n, true, null);
    exception when others then
      perform public.pm_log('twse_stock_day_all(備援)', 0, false, sqlerrm);
    end;
  end if;

  -- ---------- 上櫃 ----------
  begin
    payload := public.pm_fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes')::jsonb;
    insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
    select 'tw', upper(btrim(e ->> 'SecuritiesCompanyCode')), btrim(e ->> 'CompanyName'),
           public.pm_num(e ->> 'Close'), public.pm_roc_date(e ->> 'Date'), now()
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$'
      and public.pm_num(e ->> 'Close') > 0
    on conflict (market, symbol) do update
      set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
          as_of = excluded.as_of, updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('tpex', n, true, null);
  exception when others then
    perform public.pm_log('tpex', 0, false, sqlerrm);
  end;

  return total;
end $$;

-- ------------------------------------------------------------
-- 指數期貨結算價
--   期交所這個端點會在 JSON 與 CSV 之間變換格式，兩種都要能吃。
--   同一商品有多個月份，取成交量最大的那個＝近月。
--   注意：期交所的發布本身就有延遲，as_of 會誠實記錄資料日期。
-- ------------------------------------------------------------
create or replace function public.refresh_futures_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer := 0; body text; payload jsonb;
begin
  perform set_config('statement_timeout', '120s', true);
  begin
    body := public.pm_fetch('https://openapi.taifex.com.tw/v1/DailyMarketReportFut');

    begin
      payload := body::jsonb;                      -- JSON 格式
    exception when others then
      payload := null;                             -- 不是 JSON，改走 CSV
    end;

    if payload is not null then
      with rows as (
        select upper(btrim(e ->> 'Contract')) as symbol,
               coalesce(public.pm_num(e ->> 'SettlementPrice'), public.pm_num(e ->> 'Last')) as price,
               coalesce(public.pm_num(e ->> 'Volume'), 0) as volume,
               to_date(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g'), 'YYYYMMDD') as as_of
        from jsonb_array_elements(payload) e
        where btrim(e ->> 'TradingSession') = '一般'
      ), best as (
        select distinct on (symbol) symbol, price, as_of from rows where price > 0
        order by symbol, volume desc, price
      )
      insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
      select 'fut', symbol, null, price, as_of, now() from best
      on conflict (market, symbol) do update
        set price = excluded.price, as_of = excluded.as_of, updated_at = now();
      get diagnostics n = row_count;
      perform public.pm_log('taifex_fut(json)', n, true, null);
    else
      -- CSV：日期,契約代號,到期月份,開盤,最高,最低,最後成交價,漲跌,漲跌%,成交量,結算價,...,交易時段
      with lines as (
        select l, row_number() over () as rn
        from regexp_split_to_table(replace(body, chr(65279), ''), E'
?
') l
      ), parsed as (
        select string_to_array(l, ',') as a from lines where rn > 1 and btrim(l) <> ''
      ), rows as (
        select upper(btrim(a[2])) as symbol,
               coalesce(public.pm_num(a[11]), public.pm_num(a[7])) as price,
               coalesce(public.pm_num(a[10]), 0) as volume,
               to_date(regexp_replace(a[1], '[^0-9]', '', 'g'), 'YYYYMMDD') as as_of
        from parsed
        where array_length(a, 1) >= 18 and btrim(a[18]) = '一般'
      ), best as (
        select distinct on (symbol) symbol, price, as_of from rows where price > 0
        order by symbol, volume desc, price
      )
      insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
      select 'fut', symbol, null, price, as_of, now() from best
      on conflict (market, symbol) do update
        set price = excluded.price, as_of = excluded.as_of, updated_at = now();
      get diagnostics n = row_count;
      perform public.pm_log('taifex_fut(csv)', n, true, null);
    end if;
  exception when others then
    perform public.pm_log('taifex_fut', 0, false, sqlerrm);
  end;
  return n;
end $$;

-- ------------------------------------------------------------
-- 美金匯率
--   主要用 Yahoo 的 TWD=X（即時），期交所那份會落後好幾天，只當備援。
-- ------------------------------------------------------------
create or replace function public.refresh_fx()
returns numeric language plpgsql security definer set search_path = public, extensions as $$
declare rate numeric; d date; body text; payload jsonb;
begin
  -- Yahoo
  begin
    body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?interval=1d&range=5d');
    rate := public.pm_num(body::jsonb #>> '{chart,result,0,meta,regularMarketPrice}');
    d := to_timestamp((body::jsonb #>> '{chart,result,0,meta,regularMarketTime}')::bigint)::date;
    if rate between 10 and 100 then
      insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
      values ('fx', 'USDTWD', '美元兌新台幣', rate, coalesce(d, current_date), now())
      on conflict (market, symbol) do update
        set price = excluded.price, as_of = excluded.as_of, updated_at = now();
      perform public.pm_log('yahoo_fx', 1, true, null);
      return rate;
    end if;
  exception when others then
    perform public.pm_log('yahoo_fx', 0, false, sqlerrm);
  end;

  -- 備援：期交所每日匯率（取最新一天）
  begin
    payload := public.pm_fetch('https://openapi.taifex.com.tw/v1/DailyForeignExchangeRates')::jsonb;
    select public.pm_num(e ->> 'USD/NTD'),
           to_date(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g'), 'YYYYMMDD')
      into rate, d
    from jsonb_array_elements(payload) e
    where public.pm_num(e ->> 'USD/NTD') > 0
    order by 2 desc limit 1;

    if rate is not null then
      insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
      values ('fx', 'USDTWD', '美元兌新台幣', rate, d, now())
      on conflict (market, symbol) do update
        set price = excluded.price, as_of = excluded.as_of, updated_at = now();
      perform public.pm_log('taifex_fx(備援)', 1, true, null);
    else
      perform public.pm_log('taifex_fx(備援)', 0, false, 'no USD/NTD row');
    end if;
  exception when others then
    perform public.pm_log('taifex_fx(備援)', 0, false, sqlerrm);
  end;
  return rate;
end $$;

-- ------------------------------------------------------------
-- 美股：只抓大家實際持有的代號
-- ------------------------------------------------------------
create or replace function public.refresh_us_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare sym text; body text; px numeric; nm text; n integer := 0;
begin
  perform set_config('statement_timeout', '120s', true);
  for sym in select distinct upper(btrim(symbol)) from public.us_stocks where btrim(coalesce(symbol,'')) <> '' loop
    begin
      body := public.pm_fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/' || sym || '?interval=1d&range=1d');
      px := public.pm_num(body::jsonb #>> '{chart,result,0,meta,regularMarketPrice}');
      nm := body::jsonb #>> '{chart,result,0,meta,shortName}';
      if px > 0 then
        insert into public.market_prices (market, symbol, name, price, as_of, updated_at)
        values ('us', sym, nm, px, current_date, now())
        on conflict (market, symbol) do update
          set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
              as_of = excluded.as_of, updated_at = now();
        n := n + 1;
      end if;
    exception when others then
      perform public.pm_log('yahoo:' || sym, 0, false, sqlerrm);
    end;
  end loop;
  perform public.pm_log('yahoo', n, true, null);
  return n;
end $$;

-- ------------------------------------------------------------
-- 把行情寫回持倉
--   只在價格真的不同時才 UPDATE：不會新增、不會刪除任何項目
--   個股期貨用標的股票的收盤價（曝險 = 口數 × 等同股數 × 股價）
-- ------------------------------------------------------------
create or replace function public.sync_positions(p_user uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; c integer;
begin
  update public.stocks s
     set price = mp.price,
         name  = coalesce(nullif(btrim(s.name), ''), mp.name)
    from public.market_prices mp
   where mp.market = 'tw' and mp.symbol = upper(btrim(s.symbol))
     and (p_user is null or s.user_id = p_user)
     and (s.price is distinct from mp.price
          or (nullif(btrim(s.name), '') is null and mp.name is not null));
  get diagnostics c = row_count; n := n + c;

  update public.us_stocks u
     set price_usd = mp.price,
         name      = coalesce(nullif(btrim(u.name), ''), mp.name)
    from public.market_prices mp
   where mp.market = 'us' and mp.symbol = upper(btrim(u.symbol))
     and (p_user is null or u.user_id = p_user)
     and (u.price_usd is distinct from mp.price
          or (nullif(btrim(u.name), '') is null and mp.name is not null));
  get diagnostics c = row_count; n := n + c;

  -- 指數期貨：期交所結算價
  update public.futures f
     set price = mp.price
    from public.market_prices mp
   where f.kind = 'index' and mp.market = 'fut' and mp.symbol = upper(btrim(f.symbol))
     and (p_user is null or f.user_id = p_user)
     and f.price is distinct from mp.price;
  get diagnostics c = row_count; n := n + c;

  -- 個股期貨：標的股票收盤價
  update public.futures f
     set price = mp.price
    from public.market_prices mp
   where f.kind = 'stock' and mp.market = 'tw' and mp.symbol = upper(btrim(f.symbol))
     and (p_user is null or f.user_id = p_user)
     and f.price is distinct from mp.price;
  get diagnostics c = row_count; n := n + c;

  -- 匯率
  update public.settings st
     set usd_twd = mp.price
    from public.market_prices mp
   where mp.market = 'fx' and mp.symbol = 'USDTWD'
     and (p_user is null or st.user_id = p_user)
     and st.usd_twd is distinct from mp.price;
  get diagnostics c = row_count; n := n + c;

  return n;
end $$;

-- ------------------------------------------------------------
-- 每天自動存一筆快照（折線圖的資料來源）
-- 公式與 App 的 compute() 一致
--   槓桿① = 總資產 / 淨資產（淨資產須為正）
--   槓桿② = 總曝險 / 總資產
-- ------------------------------------------------------------
create or replace function public.auto_snapshot()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with u as (select id from auth.users),
  s as (
    select u.id as user_id,
           coalesce((select sum(x.shares * x.price) from public.stocks x where x.user_id = u.id), 0) as stock_value,
           coalesce((select sum(x.shares * x.price_usd) from public.us_stocks x where x.user_id = u.id), 0) as us_usd,
           coalesce((select sum(x.lots * x.price * x.size) from public.futures x where x.user_id = u.id), 0) as fut_notional,
           coalesce((select st.usd_twd from public.settings st where st.user_id = u.id), 32) as rate,
           coalesce((select st.target_amount from public.settings st where st.user_id = u.id), 0) as target
    from u
  ),
  b as (
    select s.*,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'cash'), 0) as cash,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'futures_equity'), 0) as fut_equity,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'liability'), 0) as liab
    from s
  ),
  f as (
    select b.*,
           b.us_usd * b.rate as us_value,
           b.stock_value + b.us_usd * b.rate + b.fut_equity + b.cash as total_assets
    from b
  ),
  g as (
    select f.*, f.total_assets - f.liab as net_assets,
           f.stock_value + f.us_value + f.fut_notional as exposure
    from f
  )
  insert into public.snapshots (
    user_id, snap_date, total_assets, liabilities, net_assets, stock_value, us_value,
    futures_margin, futures_notional, cash, leverage_asset, leverage_exposure, target_amount, note)
  -- 日期用台北時區：美股那班排程在 UTC 22:00 跑，等於台北隔天早上 06:00
  select user_id, (now() at time zone 'Asia/Taipei')::date,
         round(total_assets, 2), round(liab, 2), round(net_assets, 2), round(stock_value, 2), round(us_value, 2),
         round(fut_equity, 2), round(fut_notional, 2), round(cash, 2),
         case when net_assets > 0 then round(total_assets / net_assets, 4) end,
         case when total_assets > 0 then round(exposure / total_assets, 4) end,
         round(target, 2), 'auto'
  from g
  where total_assets <> 0 or liab <> 0
  on conflict (user_id, snap_date) do update
    set total_assets = excluded.total_assets, liabilities = excluded.liabilities,
        net_assets = excluded.net_assets, stock_value = excluded.stock_value,
        us_value = excluded.us_value, futures_margin = excluded.futures_margin,
        futures_notional = excluded.futures_notional, cash = excluded.cash,
        leverage_asset = excluded.leverage_asset, leverage_exposure = excluded.leverage_exposure,
        target_amount = excluded.target_amount
    where public.snapshots.note = 'auto';   -- 手動存的快照不覆蓋

  get diagnostics n = row_count;
  perform public.pm_log('auto_snapshot', n, true, null);
  return n;
end $$;

-- ------------------------------------------------------------
-- 排程用：抓所有行情 → 寫回持倉 → 存快照
-- ------------------------------------------------------------
create or replace function public.update_all_prices(p_include_us boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.refresh_tw_prices();
  perform public.refresh_futures_prices();
  perform public.refresh_fx();
  if p_include_us then perform public.refresh_us_prices(); end if;
  perform public.sync_positions(null);
  perform public.auto_snapshot();
end $$;

-- ------------------------------------------------------------
-- App 手動重新整理用的 RPC
--   行情 10 分鐘內剛更新過就只做同步，避免一直打對方的 API
-- ------------------------------------------------------------
create or replace function public.refresh_prices(p_force boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare last_at timestamptz; changed integer; fetched boolean := false;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select max(updated_at) into last_at from public.market_prices;

  if p_force or last_at is null or last_at < now() - interval '10 minutes' then
    perform public.refresh_tw_prices();
    perform public.refresh_futures_prices();
    perform public.refresh_fx();
    perform public.refresh_us_prices();
    fetched := true;
  end if;

  changed := public.sync_positions(auth.uid());

  return json_build_object(
    'fetched', fetched,
    'changed', changed,
    'as_of', (select max(as_of) from public.market_prices where market = 'tw'),
    'updated_at', (select max(updated_at) from public.market_prices));
end $$;

revoke all on function public.refresh_prices(boolean) from public, anon;
grant execute on function public.refresh_prices(boolean) to authenticated;
revoke all on function public.update_all_prices(boolean) from public, anon, authenticated;
revoke all on function public.sync_positions(uuid) from public, anon, authenticated;
revoke all on function public.auto_snapshot() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 排程（時間為 UTC；台灣 = UTC+8）
--   08:00 UTC = 16:00 台灣 → 台股收盤、期交所結算價出來後
--   22:00 UTC = 06:00 台灣 → 美股收盤後
-- ------------------------------------------------------------
do $$
begin
  perform cron.unschedule(jobname) from cron.job
   where jobname in ('asset-prices-tw', 'asset-prices-us');

  perform cron.schedule('asset-prices-tw', '0 8 * * 1-5',
    $c$select public.update_all_prices(false)$c$);
  perform cron.schedule('asset-prices-us', '0 22 * * 1-5',
    $c$select public.update_all_prices(true)$c$);
end $$;

-- ------------------------------------------------------------
-- 只同步、不外連：改完部位後馬上套用已快取的行情
-- （例如把代號從「台玻」改成 1802，價格要立刻跟上）
-- ------------------------------------------------------------
create or replace function public.sync_my_positions()
returns integer language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  return public.sync_positions(auth.uid());
end $$;

revoke all on function public.sync_my_positions() from public, anon;
grant execute on function public.sync_my_positions() to authenticated;

-- ------------------------------------------------------------
-- 各市場的行情日期（App 用來顯示「資料是哪一天的」）
-- ------------------------------------------------------------
create or replace view public.price_status
with (security_invoker = true) as
select market,
       max(as_of)      as as_of,
       max(updated_at) as updated_at,
       count(*)        as symbols
from public.market_prices
group by market;

grant select on public.price_status to authenticated;
