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
  market     text not null check (market in ('tw','us','fut','fx','opt','war')),
  symbol     text not null,
  name       text,
  price      numeric not null,
  as_of      date,
  src        text,                    -- twse / tpex / taifex / yahoo，用來各自判斷是否已抓過
  updated_at timestamptz not null default now(),
  primary key (market, symbol)
);
alter table public.market_prices add column if not exists src text;
do $mp$ begin
  alter table public.market_prices drop constraint if exists market_prices_market_check;
  alter table public.market_prices add constraint market_prices_market_check
    check (market in ('tw','us','fut','fx','opt','war'));
end $mp$;

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
returns text language plpgsql security definer set search_path = public, extensions as $fn$
declare body text;
begin
  -- 預設連線逾時只有 1 秒，抓大檔或對方忙碌時會失敗
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '20');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '180');
  select content into body from extensions.http((
    'GET', p_url,
    array[extensions.http_header('User-Agent', 'Mozilla/5.0 (asset-manager)')],
    null, null)::extensions.http_request);
  return body;
end $fn$;

create or replace function public.pm_log(p_source text, p_rows integer, p_ok boolean, p_msg text)
returns void language sql security definer set search_path = public as $$
  insert into public.price_runs(source, rows, ok, message) values (p_source, p_rows, p_ok, left(p_msg, 500));
$$;

-- ------------------------------------------------------------
-- 台股收盤價（上市 + 上櫃）
--   上市：證交所「每日收盤行情」MI_INDEX，要帶日期。
--         （原本用的 STOCK_DAY_ALL 會落後好幾天，2026-09-08 實測仍停在 09-04）
--         日期以台北時區為準，往回找最近一個有資料的交易日。
--   上櫃：櫃買中心，永遠回最新交易日。
--   兩邊各自判斷「是不是已經有今天的資料」，已經有就跳過，
--   所以一天可以安全地跑很多次，不會重複打對方的 API。
-- ------------------------------------------------------------
create or replace function public.refresh_tw_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  n integer := 0; total integer := 0;
  payload jsonb; tbl jsonb;
  d date; i integer;
  have_twse date; have_tpex date;
  got boolean := false;
begin
  perform set_config('statement_timeout', '180s', true);
  d := (now() at time zone 'Asia/Taipei')::date;

  select max(as_of) into have_twse from public.market_prices where market = 'tw' and src = 'twse';
  select max(as_of) into have_tpex from public.market_prices where market = 'tw' and src = 'tpex';

  -- ---------- 上市 ----------
  if have_twse is not null and have_twse >= d then
    perform public.pm_log('twse(略過，已有 ' || have_twse || ')', 0, true, null);
    got := true;
  else
    begin
      for i in 0..8 loop
        -- 往回走到「我們已經有的日期」就停：收盤未發布、假日、或已是最新都會很快停下來
        if have_twse is not null and have_twse >= (d - i) then
          perform public.pm_log('twse(略過，已有 ' || have_twse || ')', 0, true, null);
          got := true;
          exit;
        end if;

        begin
          payload := public.pm_fetch(
            'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date='
            || to_char(d - i, 'YYYYMMDD') || '&type=ALLBUT0999&response=json')::jsonb;
        exception when others then
          payload := null;
        end;

        if payload is not null and payload ->> 'stat' = 'OK' then
          select t into tbl from jsonb_array_elements(payload -> 'tables') t
          where t ->> 'title' like '%每日收盤行情%' limit 1;

          if tbl is not null and jsonb_array_length(coalesce(tbl -> 'data', '[]'::jsonb)) > 0 then
            insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
            select 'tw', upper(btrim(r ->> 0)), btrim(r ->> 1), public.pm_num(r ->> 8), d - i, 'twse', now()
            from jsonb_array_elements(tbl -> 'data') r
            where btrim(r ->> 0) ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_num(r ->> 8) > 0
            on conflict (market, symbol) do update
              set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
                  as_of = excluded.as_of, src = excluded.src, updated_at = now();
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

    -- 備援：只有 MI_INDEX 真的失敗才用（資料可能落後）
    if not got then
      begin
        payload := public.pm_fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')::jsonb;
        insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
        select 'tw', upper(btrim(e ->> 'Code')), btrim(e ->> 'Name'),
               public.pm_num(e ->> 'ClosingPrice'), public.pm_roc_date(e ->> 'Date'), 'twse', now()
        from jsonb_array_elements(payload) e
        where btrim(e ->> 'Code') ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_num(e ->> 'ClosingPrice') > 0
        on conflict (market, symbol) do update
          set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
              as_of = excluded.as_of, src = excluded.src, updated_at = now();
        get diagnostics n = row_count; total := total + n;
        perform public.pm_log('twse_stock_day_all(備援)', n, true, null);
      exception when others then
        perform public.pm_log('twse_stock_day_all(備援)', 0, false, sqlerrm);
      end;
    end if;
  end if;

  -- ---------- 上櫃（4MB） ----------
  -- 用「上市已經抓到哪一天」當基準：兩邊是同一批交易日。
  -- 上櫃不落後於上市就代表沒有新東西可抓，不用再拉這 4MB。
  select max(as_of) into have_twse from public.market_prices where market = 'tw' and src = 'twse';
  if have_tpex is not null and have_twse is not null and have_tpex >= have_twse then
    perform public.pm_log('tpex(略過，已有 ' || have_tpex || ')', 0, true, null);
  else
    begin
      payload := public.pm_fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes')::jsonb;
      insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
      select 'tw', upper(btrim(e ->> 'SecuritiesCompanyCode')), btrim(e ->> 'CompanyName'),
             public.pm_num(e ->> 'Close'), public.pm_roc_date(e ->> 'Date'), 'tpex', now()
      from jsonb_array_elements(payload) e
      where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_num(e ->> 'Close') > 0
      on conflict (market, symbol) do update
        set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
            as_of = excluded.as_of, src = excluded.src, updated_at = now();
      get diagnostics n = row_count; total := total + n;
      perform public.pm_log('tpex', n, true, null);
    exception when others then
      perform public.pm_log('tpex', 0, false, sqlerrm);
    end;
  end if;

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

-- ============================================================
-- 台指選擇權（TXO）
--   結算價來自期交所每日選擇權行情（實測比期貨那份還新）。
--   delta 用 Black-76 反推：不折現時理論價只取決於 F、K 與 x = sigma*sqrt(T)，
--   所以由市場權利金直接解出 x，不需要分別知道到期日與波動率。
--   遠期指數 F 由選擇權鏈自己的買賣權平價反推（F = K + C - P，取價平那組），
--   與權利金同一天同一市場，不受期貨行情落後影響。
-- ============================================================

-- 選擇權在 market_prices 裡的 key（履約價統一格式，避免 46500 與 46500.00 對不起來）
create or replace function public.pm_optkey(p_expiry text, p_strike numeric, p_cp text)
returns text language sql immutable as $fn$
  select 'TXO|' || btrim(p_expiry) || '|' || rtrim(trim(to_char(p_strike, 'FM9999999990.999')), '.') || '|' || btrim(p_cp);
$fn$;

-- 標準常態累積分配（Abramowitz-Stegun 7.1.26，誤差 < 1e-7）
create or replace function public.pm_ncdf(x double precision)
returns double precision language plpgsql immutable as $fn$
declare ax double precision; t double precision; d double precision; pp double precision;
begin
  ax := abs(x);
  t  := 1.0 / (1.0 + 0.2316419 * ax);
  d  := 0.3989422804014327 * exp(-ax * ax / 2.0);
  pp := d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if x >= 0 then return 1.0 - pp; else return pp; end if;
end $fn$;

-- Black-76 理論價（不折現），x = sigma*sqrt(T)
create or replace function public.pm_bs76(f double precision, k double precision, x double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare d1 double precision; d2 double precision;
begin
  if f is null or k is null or f <= 0 or k <= 0 then return null; end if;
  if x is null or x <= 0 then
    return greatest(0, case when is_call then f - k else k - f end);
  end if;
  d1 := (ln(f / k) + x * x / 2.0) / x;
  d2 := d1 - x;
  if is_call then return f * public.pm_ncdf(d1) - k * public.pm_ncdf(d2);
  else            return k * public.pm_ncdf(-d2) - f * public.pm_ncdf(-d1); end if;
end $fn$;

-- 由市場權利金用二分法解出 x
create or replace function public.pm_solve_x(f double precision, k double precision,
                                             premium double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare lo double precision := 1e-6; hi double precision := 5.0; mid double precision;
        intrinsic double precision; i integer;
begin
  if f is null or k is null or premium is null or f <= 0 or k <= 0 then return null; end if;
  intrinsic := greatest(0, case when is_call then f - k else k - f end);
  if premium <= intrinsic + 1e-9 then return 0; end if;
  if public.pm_bs76(f, k, hi, is_call) < premium then return hi; end if;
  for i in 1..80 loop
    mid := (lo + hi) / 2.0;
    if public.pm_bs76(f, k, mid, is_call) < premium then lo := mid; else hi := mid; end if;
  end loop;
  return (lo + hi) / 2.0;
end $fn$;

create or replace function public.pm_delta(f double precision, k double precision,
                                           x double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare d1 double precision;
begin
  if f is null or k is null or f <= 0 or k <= 0 then return null; end if;
  if x is null or x <= 0 then
    if is_call then return case when f > k then 1 else 0 end;
    else            return case when f < k then -1 else 0 end; end if;
  end if;
  d1 := (ln(f / k) + x * x / 2.0) / x;
  if is_call then return public.pm_ncdf(d1); else return public.pm_ncdf(d1) - 1.0; end if;
end $fn$;

-- 抓每日選擇權結算價，並反推每個到期的隱含遠期指數
create or replace function public.refresh_option_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; body text; payload jsonb;
begin
  perform set_config('statement_timeout', '180s', true);
  begin
    body := public.pm_fetch('https://openapi.taifex.com.tw/v1/DailyMarketReportOpt');
    begin payload := body::jsonb; exception when others then payload := null; end;

    create temp table if not exists _opt (expiry text, strike numeric, cp text, prem numeric, as_of date);
    -- **不能寫成 delete from _opt**。Supabase 對 PostgREST 的連線載入了 safeupdate，
    -- 它會擋掉沒有 WHERE 的 DELETE，而 SECURITY DEFINER 不會卸載這個 session 設定。
    -- 結果是：用 Management API（postgres session）跑得過，但 App 按「立即更新」一定失敗。
    -- 實測 2026-09-08 這一天就失敗了 7 次，選擇權結算價完全沒更新到。
    delete from _opt where true;

    if payload is not null then
      insert into _opt
      select btrim(e ->> 'ContractMonth(Week)'), public.pm_num(e ->> 'StrikePrice'),
             case when (e ->> 'CallPut') like '%買%' then 'call' else 'put' end,
             public.pm_num(e ->> 'SettlementPrice'),
             to_date(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g'), 'YYYYMMDD')
      from jsonb_array_elements(payload) e
      where btrim(e ->> 'Contract') = 'TXO' and btrim(e ->> 'TradingSession') = '一般'
        and public.pm_num(e ->> 'SettlementPrice') is not null;
    else
      insert into _opt
      select btrim(a[3]), public.pm_num(a[4]),
             case when a[5] like '%買%' then 'call' else 'put' end,
             public.pm_num(a[11]),
             to_date(regexp_replace(a[1], '[^0-9]', '', 'g'), 'YYYYMMDD')
      from (
        select string_to_array(l, ',') as a
        from (select l, row_number() over () rn
              from regexp_split_to_table(replace(body, chr(65279), ''), E'\r?\n') l) x
        where rn > 1 and btrim(l) <> ''
      ) y
      where array_length(a, 1) >= 18 and btrim(a[2]) = 'TXO' and btrim(a[18]) = '一般'
        and public.pm_num(a[11]) is not null;
    end if;

    insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
    select 'opt', public.pm_optkey(expiry, strike, cp),
           'TXO ' || expiry || ' ' || rtrim(trim(to_char(strike, 'FM9999999990.999')), '.') || ' ' || cp,
           prem, as_of, 'taifex_opt', now()
    from _opt where prem >= 0
    on conflict (market, symbol) do update
      set price = excluded.price, as_of = excluded.as_of, src = excluded.src, updated_at = now();
    get diagnostics n = row_count;

    insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
    select 'opt', 'FWD|' || expiry, 'TXO ' || expiry || ' 隱含遠期', f, as_of, 'taifex_opt', now()
    from (
      select distinct on (c.expiry) c.expiry, c.strike + c.prem - p.prem as f, c.as_of
      from _opt c join _opt p on p.expiry = c.expiry and p.strike = c.strike and p.cp = 'put'
      where c.cp = 'call'
      order by c.expiry, abs(c.prem - p.prem)
    ) z
    where f > 0
    on conflict (market, symbol) do update
      set price = excluded.price, as_of = excluded.as_of, updated_at = now();

    drop table if exists _opt;
    perform public.pm_log('taifex_opt' || case when payload is null then '(csv)' else '(json)' end, n, true, null);
  exception when others then
    perform public.pm_log('taifex_opt', 0, false, sqlerrm);
  end;
  return n;
end $fn$;

-- ============================================================
-- 權證（券商發行的認購/認售權證）
--   基本資料 20MB，每週更新一次就夠（只有除權息調整才會變）。
--   每日報價含標的收盤價；約半數權證當天沒成交，
--   這時用造市商的委買賣中價當作評價基準。
--   隱含波動率由市價反推並逐日留存，用來偵測發行券商調降隱波。
-- ============================================================

-- 標準常態機率密度
create or replace function public.pm_npdf(x double precision)
returns double precision language sql immutable as $fn$
  select 0.3989422804014327 * exp(-x * x / 2.0);
$fn$;

-- Black-Scholes（歐式、不含股利），回傳每股理論價
create or replace function public.pm_bs(s double precision, k double precision, t double precision,
                                        r double precision, sig double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare d1 double precision; d2 double precision;
begin
  if s is null or k is null or s <= 0 or k <= 0 then return null; end if;
  if t is null or t <= 0 or sig is null or sig <= 0 then
    return greatest(0, case when is_call then s - k else k - s end);
  end if;
  d1 := (ln(s / k) + (r + sig * sig / 2.0) * t) / (sig * sqrt(t));
  d2 := d1 - sig * sqrt(t);
  if is_call then return s * public.pm_ncdf(d1) - k * exp(-r * t) * public.pm_ncdf(d2);
  else            return k * exp(-r * t) * public.pm_ncdf(-d2) - s * public.pm_ncdf(-d1); end if;
end $fn$;

create or replace function public.pm_bs_delta(s double precision, k double precision, t double precision,
                                              r double precision, sig double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare d1 double precision;
begin
  if s is null or k is null or s <= 0 or k <= 0 then return null; end if;
  if t is null or t <= 0 or sig is null or sig <= 0 then
    if is_call then return case when s > k then 1 else 0 end;
    else            return case when s < k then -1 else 0 end; end if;
  end if;
  d1 := (ln(s / k) + (r + sig * sig / 2.0) * t) / (sig * sqrt(t));
  if is_call then return public.pm_ncdf(d1); else return public.pm_ncdf(d1) - 1.0; end if;
end $fn$;

-- 每日時間價值流失（每股，負值）
create or replace function public.pm_bs_theta_day(s double precision, k double precision, t double precision,
                                                  r double precision, sig double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare d1 double precision; d2 double precision; th double precision;
begin
  if s is null or k is null or s <= 0 or k <= 0 or t is null or t <= 0 or sig is null or sig <= 0 then
    return null;
  end if;
  d1 := (ln(s / k) + (r + sig * sig / 2.0) * t) / (sig * sqrt(t));
  d2 := d1 - sig * sqrt(t);
  if is_call then
    th := -s * public.pm_npdf(d1) * sig / (2.0 * sqrt(t)) - r * k * exp(-r * t) * public.pm_ncdf(d2);
  else
    th := -s * public.pm_npdf(d1) * sig / (2.0 * sqrt(t)) + r * k * exp(-r * t) * public.pm_ncdf(-d2);
  end if;
  return th / 365.0;
end $fn$;

-- 由市價反推隱含波動率（二分法）
create or replace function public.pm_solve_iv(s double precision, k double precision, t double precision,
                                              r double precision, px double precision, is_call boolean)
returns double precision language plpgsql immutable as $fn$
declare lo double precision := 0.001; hi double precision := 5.0; mid double precision;
        intrinsic double precision; i integer;
begin
  if s is null or k is null or px is null or t is null or s <= 0 or k <= 0 or t <= 0 or px <= 0 then
    return null;
  end if;
  intrinsic := greatest(0, case when is_call then s - k * exp(-r * t) else k * exp(-r * t) - s end);
  if px <= intrinsic + 1e-9 then return null; end if;        -- 價格已在內含價值以下，模型不適用
  if public.pm_bs(s, k, t, r, hi, is_call) < px then return null; end if;
  for i in 1..80 loop
    mid := (lo + hi) / 2.0;
    if public.pm_bs(s, k, t, r, mid, is_call) < px then lo := mid; else hi := mid; end if;
  end loop;
  return (lo + hi) / 2.0;
end $fn$;

-- 權證基本資料（20MB，每週跑一次）
create or replace function public.refresh_warrant_info()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; payload jsonb;
begin
  perform set_config('statement_timeout', '300s', true);
  begin
    payload := public.pm_fetch('https://openapi.twse.com.tw/v1/opendata/t187ap37_L')::jsonb;
    insert into public.warrant_info (code, name, cp, underlying, underlying_name,
                                     strike, ratio, last_trade_date, category, updated_at)
    select upper(btrim(e ->> '權證代號')),
           btrim(e ->> '權證簡稱'),
           case when (e ->> '權證類型') like '%購%' then 'call' else 'put' end,
           null,                                                    -- 標的代號由每日報價補
           btrim(e ->> '標的證券/指數'),
           public.pm_num(e ->> '最新履約價格(元)/履約指數'),
           public.pm_num(e ->> '最新標的履約配發數量(每仟單位權證)') / 1000.0,
           public.pm_roc_date(e ->> '最後交易日'),
           btrim(e ->> '類別'),
           now()
    from jsonb_array_elements(payload) e
    where btrim(e ->> '權證代號') <> ''
      and public.pm_num(e ->> '最新履約價格(元)/履約指數') > 0
    on conflict (code) do update
      set name = excluded.name, cp = excluded.cp, underlying_name = excluded.underlying_name,
          strike = excluded.strike, ratio = excluded.ratio,
          last_trade_date = excluded.last_trade_date, category = excluded.category, updated_at = now();
    get diagnostics n = row_count;
    perform public.pm_log('twse_warrant_info', n, true, null);
  exception when others then
    perform public.pm_log('twse_warrant_info', 0, false, sqlerrm);
  end;
  return n;
end $fn$;

-- 權證每日報價（認購 + 認售）
create or replace function public.refresh_warrant_prices()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; total integer := 0; payload jsonb; tbl jsonb;
        d date; i integer; kind text; have date;
begin
  perform set_config('statement_timeout', '300s', true);
  select max(as_of) into have from public.market_prices where market = 'war';
  d := (now() at time zone 'Asia/Taipei')::date;

  foreach kind in array array['0999', '0999P'] loop
    begin
      for i in 0..8 loop
        exit when have is not null and have >= (d - i);
        begin
          payload := public.pm_fetch(
            'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date='
            || to_char(d - i, 'YYYYMMDD') || '&type=' || kind || '&response=json')::jsonb;
        exception when others then payload := null; end;

        if payload is not null and payload ->> 'stat' = 'OK' then
          select t into tbl from jsonb_array_elements(payload -> 'tables') t
          where jsonb_array_length(coalesce(t -> 'data', '[]'::jsonb)) > 0 limit 1;

          if tbl is not null then
            -- 有成交用收盤價，沒成交用造市商委買賣中價
            insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
            select 'war', upper(btrim(r ->> 1)), btrim(r ->> 2),
                   coalesce(public.pm_num(r ->> 9),
                            (public.pm_num(r ->> 12) + public.pm_num(r ->> 14)) / 2.0,
                            public.pm_num(r ->> 12)),
                   d - i, 'twse_warrant', now()
            from jsonb_array_elements(tbl -> 'data') r
            where btrim(r ->> 1) ~ '^[0-9A-Z]{6}$'
              and coalesce(public.pm_num(r ->> 9),
                           (public.pm_num(r ->> 12) + public.pm_num(r ->> 14)) / 2.0,
                           public.pm_num(r ->> 12)) > 0
            on conflict (market, symbol) do update
              set price = excluded.price, name = coalesce(excluded.name, market_prices.name),
                  as_of = excluded.as_of, src = excluded.src, updated_at = now();
            get diagnostics n = row_count; total := total + n;

            -- 順便把標的代號補進基本資料
            update public.warrant_info wi
               set underlying = z.ul
              from (select upper(btrim(r ->> 1)) as code, btrim(r ->> 17) as ul
                    from jsonb_array_elements(tbl -> 'data') r
                    where btrim(r ->> 17) ~ '^[0-9A-Z]{4,6}$') z
             where wi.code = z.code and wi.underlying is distinct from z.ul;

            perform public.pm_log('twse_warrant_' || kind || ' ' || to_char(d - i, 'YYYY-MM-DD'), n, true, null);
            exit;
          end if;
        end if;
      end loop;
    exception when others then
      perform public.pm_log('twse_warrant_' || kind, 0, false, sqlerrm);
    end;
  end loop;
  return total;
end $fn$;

-- ============================================================
-- 歷史月底收盤價（族群年化報酬用）
--   上市：證交所 MI_INDEX 帶日期
--   上櫃：櫃買 afterTrading/otc 帶日期
--   只存月底，一年 12 筆，抓三年也才 36 次請求
-- ============================================================
create table if not exists public.price_history (
  market  text not null,
  symbol  text not null,
  as_of   date not null,
  close   numeric not null,
  name    text,
  primary key (market, symbol, as_of)
);
alter table public.price_history enable row level security;
drop policy if exists "read history" on public.price_history;
create policy "read history" on public.price_history for select to authenticated using (true);
create index if not exists price_history_sym_idx on public.price_history(symbol, as_of);

-- 抓某一天的上市 + 上櫃收盤。回傳筆數；那天沒開盤回 0。
create or replace function public.fetch_history_day(p_date date)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; total integer := 0; payload jsonb; tbl jsonb;
begin
  perform set_config('statement_timeout', '120s', true);

  -- 上市
  begin
    payload := public.pm_fetch(
      'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date='
      || to_char(p_date, 'YYYYMMDD') || '&type=ALLBUT0999&response=json')::jsonb;
    if payload ->> 'stat' = 'OK' then
      select t into tbl from jsonb_array_elements(payload -> 'tables') t
      where t ->> 'title' like '%每日收盤行情%' limit 1;
      if tbl is not null then
        insert into public.price_history (market, symbol, as_of, close, name)
        select 'tw', upper(btrim(r ->> 0)), p_date, public.pm_num(r ->> 8), btrim(r ->> 1)
        from jsonb_array_elements(tbl -> 'data') r
        where btrim(r ->> 0) ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_num(r ->> 8) > 0
        on conflict (market, symbol, as_of) do update set close = excluded.close;
        get diagnostics n = row_count; total := total + n;
      end if;
    end if;
  exception when others then
    perform public.pm_log('hist_twse ' || p_date, 0, false, sqlerrm);
  end;

  -- 上櫃的歷史端點在資料庫端會 SSL 失敗，改由每月存檔累積（見 snapshot_month_end）

  perform public.pm_log('hist ' || p_date, total, total > 0, null);
  return total;
end $fn$;

-- 每月存檔：把當月最新的收盤價寫進歷史。
-- 每天跑，同月份會被覆蓋，月份一過就等於凍結成該月最後一個交易日的收盤。
-- 上櫃沒有可用的歷史端點，就是靠這個機制長出歷史。
create or replace function public.snapshot_month_end()
returns integer language plpgsql security definer set search_path = public as $fn$
declare d date; n integer;
begin
  select max(as_of) into d from public.market_prices where market = 'tw';
  if d is null then return 0; end if;

  delete from public.price_history
   where as_of >= date_trunc('month', d)::date and as_of <= d
     and as_of <> d;

  insert into public.price_history (market, symbol, as_of, close, name)
  select 'tw', symbol, d, price, name
  from public.market_prices where market = 'tw' and price > 0
  on conflict (market, symbol, as_of) do update
    set close = excluded.close, name = coalesce(excluded.name, price_history.name);
  get diagnostics n = row_count;
  return n;
end $fn$;

-- ------------------------------------------------------------
-- 族群分類（人工維護，可隨時增修）
-- ------------------------------------------------------------
create table if not exists public.themes (
  theme  text not null,
  symbol text not null,
  note   text,
  sort   integer default 0,
  primary key (theme, symbol)
);
alter table public.themes enable row level security;
drop policy if exists "read themes" on public.themes;
create policy "read themes" on public.themes for select to authenticated using (true);

-- ============================================================
-- 產業趨勢：用月營收年增率衡量族群景氣
--   台灣強制上市櫃每月公告營收，是全球少見的高頻基本面資料。
--   把族群成分股的營收加總再比去年同期，就是這個產業的真實成長率，
--   比看股價漲跌更接近「產業趨勢」本身。
--   每筆公告都含「當月、上月、去年當月」，所以一次抓就能寫進三個月份，
--   歷史會隨著每月公告自然累積。
-- ============================================================
create table if not exists public.revenue (
  symbol     text not null,
  ym         text not null,          -- 資料年月，民國格式如 11507
  name       text,
  industry   text,
  amount     numeric not null,       -- 當月營收
  updated_at timestamptz not null default now(),
  primary key (symbol, ym)
);
alter table public.revenue enable row level security;
drop policy if exists "read revenue" on public.revenue;
create policy "read revenue" on public.revenue for select to authenticated using (true);
create index if not exists revenue_ym_idx on public.revenue(ym);

-- 民國年月 11507 → 前一個月 / 去年同月
create or replace function public.pm_ym_add(p_ym text, p_months integer)
returns text language sql immutable as $fn$
  select to_char(
    (to_date(((substr(p_ym,1,3))::int + 1911)::text || right(p_ym,2) || '01','YYYYMMDD')
     + (p_months || ' months')::interval), 'YYYYMM')::text
$fn$;

create or replace function public.pm_ym_roc(p_ad text)
returns text language sql immutable as $fn$
  select ((substr(p_ad,1,4))::int - 1911)::text || substr(p_ad,5,2)
$fn$;

create or replace function public.refresh_revenue()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; total integer := 0; payload jsonb; src text;
begin
  perform set_config('statement_timeout', '180s', true);
  foreach src in array array[
    'https://openapi.twse.com.tw/v1/opendata/t187ap05_L',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O'
  ] loop
    begin
      payload := public.pm_fetch(src)::jsonb;
      -- 當月
      insert into public.revenue (symbol, ym, name, industry, amount, updated_at)
      select upper(btrim(e ->> '公司代號')), btrim(e ->> '資料年月'),
             btrim(e ->> '公司名稱'), btrim(e ->> '產業別'),
             public.pm_num(e ->> '營業收入-當月營收'), now()
      from jsonb_array_elements(payload) e
      where btrim(e ->> '公司代號') ~ '^[0-9]{4,6}[A-Z]?$'
        and public.pm_num(e ->> '營業收入-當月營收') is not null
      on conflict (symbol, ym) do update
        set amount = excluded.amount, name = excluded.name,
            industry = excluded.industry, updated_at = now();
      get diagnostics n = row_count; total := total + n;

      -- 上月與去年同月：同一筆公告就有，順手補進歷史
      insert into public.revenue (symbol, ym, name, industry, amount, updated_at)
      select upper(btrim(e ->> '公司代號')),
             public.pm_ym_roc(public.pm_ym_add(btrim(e ->> '資料年月'), -1)),
             btrim(e ->> '公司名稱'), btrim(e ->> '產業別'),
             public.pm_num(e ->> '營業收入-上月營收'), now()
      from jsonb_array_elements(payload) e
      where btrim(e ->> '公司代號') ~ '^[0-9]{4,6}[A-Z]?$'
        and public.pm_num(e ->> '營業收入-上月營收') > 0
      on conflict (symbol, ym) do nothing;

      insert into public.revenue (symbol, ym, name, industry, amount, updated_at)
      select upper(btrim(e ->> '公司代號')),
             public.pm_ym_roc(public.pm_ym_add(btrim(e ->> '資料年月'), -12)),
             btrim(e ->> '公司名稱'), btrim(e ->> '產業別'),
             public.pm_num(e ->> '營業收入-去年當月營收'), now()
      from jsonb_array_elements(payload) e
      where btrim(e ->> '公司代號') ~ '^[0-9]{4,6}[A-Z]?$'
        and public.pm_num(e ->> '營業收入-去年當月營收') > 0
      on conflict (symbol, ym) do nothing;

      perform public.pm_log('revenue ' || right(src, 12), n, true, null);
    exception when others then
      perform public.pm_log('revenue ' || right(src, 12), 0, false, sqlerrm);
    end;
  end loop;
  return total;
end $fn$;

-- ------------------------------------------------------------
-- 族群趨勢：把成分股營收加總後比去年同期
--   回傳最近 12 個月，每個月一列，可直接畫折線
-- ------------------------------------------------------------
create or replace function public.theme_trend(p_months integer default 12)
returns table (theme text, ym text, amount numeric, yoy numeric, members integer)
language sql stable security definer set search_path = public as $fn$
  -- 先把所有月份都聚合起來，才有去年同月可以比；最後才截取要顯示的區間
  with agg as (
    select t.theme, r.ym,
           sum(r.amount) as amount,
           count(r.symbol)::int as members
    from public.themes t
    join public.revenue r on r.symbol = t.symbol
    group by t.theme, r.ym
  ),
  months as (
    select distinct ym from public.revenue order by ym desc limit p_months
  )
  select a.theme, a.ym, a.amount,
         case when b.amount > 0 then a.amount / b.amount - 1 end as yoy,
         a.members
  from agg a
  join months m on m.ym = a.ym
  left join agg b on b.theme = a.theme
                 and b.ym = public.pm_ym_roc(public.pm_ym_add(a.ym, -12))
  order by a.theme, a.ym;
$fn$;

-- 族群裡每一檔的最新營收年增與估值，用來看是誰在拉動、以及貴不貴
--   pe   近四季本益比（官方每日公告）
--   fy1 / eps1 / pe1  最近一個有預估的年度
--   fy2 / eps2 / pe2  再下一年
--   年度不寫死，從資料推出來，明年就自動變成 2027 / 2028。
create or replace function public.theme_members(p_ym text default null)
returns table (theme text, symbol text, name text, ym text,
               amount numeric, last_year numeric, yoy numeric, pe numeric,
               fy1 smallint, eps1 numeric, pe1 numeric, an1 smallint,
               fy2 smallint, eps2 numeric, pe2 numeric,
               ratio numeric, vol numeric, cagr numeric)
language sql stable security definer set search_path = public as $fn$
  with target as (
    select coalesce(p_ym, (select max(ym) from public.revenue)) as ym
  ),
  er as (select * from public.eps_resolved()),
  yr as (
    select er.symbol, min(er.fy) as fy1 from er
    where er.fy >= extract(year from current_date)::int and er.eps is not null
    group by er.symbol
  ),
  ep as (
    select y.symbol, y.fy1,
           max(e1.eps) as eps1, max(e1.analysts) as an1,
           max(e2.eps) as eps2
    from yr y
    left join er e1 on e1.symbol = y.symbol and e1.fy = y.fy1
    left join er e2 on e2.symbol = y.symbol and e2.fy = y.fy1 + 1
    group by y.symbol, y.fy1
  )
  select t.theme, t.symbol, r.name, r.ym, r.amount, ly.amount,
         case when ly.amount > 0 then r.amount / ly.amount - 1 end,
         v.pe,
         ep.fy1::smallint, ep.eps1,
         case when ep.eps1 > 0 and mp.price > 0 then round(mp.price / ep.eps1, 1) end,
         ep.an1::smallint,
         (ep.fy1 + 1)::smallint, ep.eps2,
         case when ep.eps2 > 0 and mp.price > 0 then round(mp.price / ep.eps2, 1) end,
         k.ratio, k.vol, k.cagr
  from public.themes t
  cross join target g
  join public.revenue r on r.symbol = t.symbol and r.ym = g.ym
  left join public.revenue ly on ly.symbol = t.symbol
        and ly.ym = public.pm_ym_roc(public.pm_ym_add(g.ym, -12))
  left join public.valuation v on v.symbol = t.symbol
  left join public.market_prices mp on mp.market = 'tw' and mp.symbol = t.symbol
  left join ep on ep.symbol = t.symbol
  left join public.risk_stats k on k.symbol = t.symbol
  order by t.theme, t.sort, coalesce(r.amount, 0) desc;
$fn$;

grant execute on function public.theme_trend(integer) to authenticated;
grant execute on function public.theme_members(text) to authenticated;

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

  -- 選擇權：更新權利金，並用 Black-76 反推 delta
  with px as (
    select o.id,
           mp.price as prem,
           fw.price as fwd,
           public.pm_solve_x(fw.price::float8, o.strike::float8, mp.price::float8, o.cp = 'call') as x
    from public.options o
    join public.market_prices mp
      on mp.market = 'opt' and mp.symbol = public.pm_optkey(o.expiry, o.strike, o.cp)
    join public.market_prices fw
      on fw.market = 'opt' and fw.symbol = 'FWD|' || btrim(o.expiry)
    where (p_user is null or o.user_id = p_user)
  )
  update public.options o
     set price     = px.prem,
         forward   = px.fwd,
         iv_sqrt_t = px.x,
         delta     = public.pm_delta(px.fwd::float8, o.strike::float8, px.x, o.cp = 'call')
    from px
   where px.id = o.id
     and (o.price is distinct from px.prem
          or o.forward is distinct from px.fwd
          or o.delta is null);
  get diagnostics c = row_count; n := n + c;

  -- 權證：補基本資料、市價、標的價，反推隱波後算 delta / theta / 實質槓桿
  with w as (
    select wr.id,
           coalesce(wi.name, wr.name) as name,
           coalesce(wi.cp, wr.cp) as cp,
           coalesce(wi.underlying, wr.underlying) as underlying,
           coalesce(wi.underlying_name, wr.underlying_name) as underlying_name,
           coalesce(wi.strike, wr.strike) as strike,
           coalesce(wi.ratio, wr.ratio) as ratio,
           coalesce(wi.last_trade_date, wr.last_trade_date) as last_trade_date,
           coalesce(wi.category, wr.category) as category,
           mp.price as px, ul.price as ulpx,
           greatest((coalesce(wi.last_trade_date, wr.last_trade_date)
                     - (now() at time zone 'Asia/Taipei')::date)::double precision / 365.0, 0) as tt
    from public.warrants wr
    -- 用 left join：就算基本資料還沒抓到，價格也要更新，不要整筆卡住
    left join public.warrant_info wi on wi.code = upper(btrim(wr.code))
    left join public.market_prices mp on mp.market = 'war' and mp.symbol = upper(btrim(wr.code))
    left join public.market_prices ul on ul.market = 'tw'
      and ul.symbol = upper(btrim(coalesce(wi.underlying, wr.underlying)))
    where (p_user is null or wr.user_id = p_user)
  ), calc as (
    select w.*,
           public.pm_solve_iv(w.ulpx::double precision, w.strike::double precision, w.tt, 0.015,
                              (w.px / nullif(w.ratio, 0))::double precision, w.cp = 'call') as iv_calc
    from w
  ), greeks as (
    select c.*,
           public.pm_bs_delta(c.ulpx::double precision, c.strike::double precision, c.tt, 0.015,
                              c.iv_calc, c.cp = 'call') as delta_calc,
           public.pm_bs_theta_day(c.ulpx::double precision, c.strike::double precision, c.tt, 0.015,
                                  c.iv_calc, c.cp = 'call') as theta_calc
    from calc c
  )
  update public.warrants wr
     set name             = coalesce(f.name, wr.name),
         cp               = coalesce(f.cp, wr.cp),
         underlying       = coalesce(f.underlying, wr.underlying),
         underlying_name  = coalesce(f.underlying_name, wr.underlying_name),
         strike           = coalesce(f.strike, wr.strike),
         ratio            = coalesce(f.ratio, wr.ratio),
         last_trade_date  = coalesce(f.last_trade_date, wr.last_trade_date),
         category         = coalesce(f.category, wr.category),
         price            = coalesce(f.px, wr.price),
         underlying_price = f.ulpx,
         iv               = f.iv_calc,
         delta            = f.delta_calc,
         theta_day        = f.theta_calc * f.ratio,
         gearing          = case when f.px > 0 and f.delta_calc is not null
                                 then (f.ulpx * f.ratio / f.px) * f.delta_calc end
    from greeks f
   where f.id = wr.id
     and (wr.price is distinct from coalesce(f.px, wr.price)
          or wr.underlying_price is distinct from f.ulpx
          or wr.iv is distinct from f.iv_calc
          or wr.delta is null
          or wr.strike is distinct from f.strike);
  get diagnostics c = row_count; n := n + c;

  -- 逐日留存隱波，用來看發行券商有沒有調降
  insert into public.warrant_iv_history (code, as_of, iv, price, underlying_price)
  select upper(btrim(wr.code)), mp.as_of, wr.iv, wr.price, wr.underlying_price
  from public.warrants wr
  join public.market_prices mp on mp.market = 'war' and mp.symbol = upper(btrim(wr.code))
  where wr.iv is not null and mp.as_of is not null
    and (p_user is null or wr.user_id = p_user)
  on conflict (code, as_of) do update
    set iv = excluded.iv, price = excluded.price, underlying_price = excluded.underlying_price;

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
           coalesce((select sum(x.lots * x.price * x.size * case when x.side = 'short' then -1 else 1 end)
                     from public.options x where x.user_id = u.id), 0) as opt_value,
           coalesce((select sum(abs(x.lots * coalesce(x.delta, 0) * coalesce(x.forward, 0) * x.size))
                     from public.options x where x.user_id = u.id), 0) as opt_exposure,
           coalesce((select sum(x.lots * 1000 * x.price)
                     from public.warrants x where x.user_id = u.id), 0) as war_value,
           coalesce((select sum(abs(x.lots * 1000 * coalesce(x.ratio, 0)
                        * coalesce(x.delta_override, x.delta, 0) * coalesce(x.underlying_price, 0)))
                     from public.warrants x where x.user_id = u.id), 0) as war_exposure,
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
           b.stock_value + b.us_usd * b.rate + b.fut_equity + b.cash + b.opt_value + b.war_value as total_assets
    from b
  ),
  g as (
    select f.*, f.total_assets - f.liab as net_assets,
           f.stock_value + f.us_value + f.fut_notional + f.opt_exposure + f.war_exposure as exposure
    from f
  )
  insert into public.snapshots (
    user_id, snap_date, price_as_of, total_assets, liabilities, net_assets, stock_value, us_value,
    futures_margin, futures_notional, cash, option_value, option_exposure,
    warrant_value, warrant_exposure, leverage_asset, leverage_exposure, target_amount, note)
  -- 日期用台北時區：美股那班排程在 UTC 22:00 跑，等於台北隔天早上 06:00
  select user_id, (now() at time zone 'Asia/Taipei')::date,
         (select max(as_of) from public.market_prices where market = 'tw'),
         round(total_assets, 2), round(liab, 2), round(net_assets, 2), round(stock_value, 2), round(us_value, 2),
         round(fut_equity, 2), round(fut_notional, 2), round(cash, 2),
         round(opt_value, 2), round(opt_exposure, 2),
         round(war_value, 2), round(war_exposure, 2),
         case when net_assets > 0 then round(total_assets / net_assets, 4) end,
         case when total_assets > 0 then round(exposure / total_assets, 4) end,
         round(target, 2), 'auto'
  from g
  where total_assets <> 0 or liab <> 0
  on conflict (user_id, snap_date) do update
    set price_as_of = excluded.price_as_of,
        total_assets = excluded.total_assets, liabilities = excluded.liabilities,
        net_assets = excluded.net_assets, stock_value = excluded.stock_value,
        us_value = excluded.us_value, futures_margin = excluded.futures_margin,
        futures_notional = excluded.futures_notional, cash = excluded.cash,
        option_value = excluded.option_value, option_exposure = excluded.option_exposure,
        warrant_value = excluded.warrant_value, warrant_exposure = excluded.warrant_exposure,
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
  perform public.refresh_option_prices();
  -- 權證基本資料 20MB：超過 2 天沒更新，或有持倉查不到基本資料時才重抓
  if (select coalesce(max(updated_at), '2000-01-01'::timestamptz) from public.warrant_info)
       < now() - interval '2 days'
     or exists (select 1 from public.warrants w
                left join public.warrant_info wi on wi.code = upper(btrim(w.code))
                where wi.code is null or w.ratio is null) then
    perform public.refresh_warrant_info();
  end if;
  perform public.refresh_warrant_prices();
  perform public.refresh_fx();
  if p_include_us then perform public.refresh_us_prices(); end if;
  -- 估值（官方每日公告的本益比/淨值比/殖利率）
  perform public.refresh_valuation();
  -- 月營收：每月 10 日前後才會變，但天天跑很快，而且漏掉一天就整個月是舊的
  perform public.refresh_revenue();
  -- 季報 EPS：每季才變，跟著月營收一起跑
  perform public.refresh_financials();
  -- 分析師預估 EPS：190 檔約 40 秒，只有排程跑，手動更新分批
  perform public.refresh_estimates(400);
  -- 報酬/波動計分：170 檔約 30 秒
  perform public.refresh_risk_stats(400);
  -- 美股 AI 產業地圖：66 檔約 30 秒
  perform public.refresh_us_stats(200);
  perform public.sync_positions(null);
  perform public.snapshot_month_end();
  perform public.auto_snapshot();
  -- price_runs 是純日誌，不清會無限長（實測佔年成長的 24%），只留 60 天
  delete from public.price_runs where ran_at < now() - interval '60 days';
end $$;

-- ------------------------------------------------------------
-- 逐項更新（App 手動重新整理用）
--   authenticated 角色的 statement_timeout 是 8 秒，
--   七個來源一次跑完要 10 秒以上，一定逾時，所以拆成一次做一項。
--   權證基本資料 20MB 要 50 秒，不放進互動流程，只由排程處理。
-- ------------------------------------------------------------
create or replace function public.refresh_market(p_kind text)
returns json language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; t0 timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  case p_kind
    when 'tw'  then n := public.refresh_tw_prices();
    when 'fut' then n := public.refresh_futures_prices();
    when 'opt' then n := public.refresh_option_prices();
    when 'war' then n := public.refresh_warrant_prices();
    when 'fx'  then n := coalesce((public.refresh_fx() is not null)::int, 0);
    when 'us'  then n := public.refresh_us_prices();
    when 'val' then n := public.refresh_valuation();
    when 'rev' then n := public.refresh_revenue();
    when 'fin' then n := public.refresh_financials();
    when 'est' then n := public.refresh_estimates(12);
    when 'risk' then n := public.refresh_risk_stats(15);
    when 'usx' then n := public.refresh_us_stats(8);
    when 'sync' then n := public.sync_positions(auth.uid());
    else raise exception 'unknown market %', p_kind;
  end case;

  return json_build_object(
    'kind', p_kind, 'rows', n,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000),
    'as_of', (select max(as_of) from public.market_prices
              where market = case p_kind when 'tw' then 'tw' when 'fut' then 'fut'
                                         when 'opt' then 'opt' when 'war' then 'war'
                                         when 'fx' then 'fx' when 'us' then 'us' else 'tw' end));
end $fn$;

revoke all on function public.refresh_market(text) from public, anon;
grant execute on function public.refresh_market(text) to authenticated;

-- ------------------------------------------------------------
-- App 手動重新整理用的 RPC
--   行情 10 分鐘內剛更新過就只做同步，避免一直打對方的 API
-- ------------------------------------------------------------
create or replace function public.refresh_prices(p_force boolean default false)
returns json language plpgsql security definer set search_path = public as $fn$
declare changed integer;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  -- 這支只做「把已快取的行情套到部位上」，很快。
  -- 真正的外部抓取請用 refresh_market() 一項一項來，否則會超過 8 秒上限。
  changed := public.sync_positions(auth.uid());
  return json_build_object(
    'fetched', false,
    'changed', changed,
    'as_of', (select max(as_of) from public.market_prices where market = 'tw'),
    'updated_at', (select max(updated_at) from public.market_prices));
end $fn$;

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
   where jobname in ('asset-prices-tw', 'asset-prices-tw2', 'asset-prices-tw3',
                     'asset-prices-tw4', 'asset-prices-us');

  -- 台股：台北 14:30 / 16:00 / 18:00 / 21:00 各試一次。
  -- 抓到當天資料後，後面幾次會被守則擋掉，不會重複打對方的 API。
  -- 多跑幾次是為了避免「來源比排程晚發布」造成當天快照用到前一天的價格。
  perform cron.schedule('asset-prices-tw',   '30 6 * * 1-5', $c$select public.update_all_prices(false)$c$);
  perform cron.schedule('asset-prices-tw2',  '0 8 * * 1-5',  $c$select public.update_all_prices(false)$c$);
  perform cron.schedule('asset-prices-tw3',  '0 10 * * 1-5', $c$select public.update_all_prices(false)$c$);
  perform cron.schedule('asset-prices-tw4',  '0 13 * * 1-5', $c$select public.update_all_prices(false)$c$);
  perform cron.schedule('asset-prices-us',   '0 22 * * 1-5', $c$select public.update_all_prices(true)$c$);
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
