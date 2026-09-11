-- ============================================================
-- 處置股與注意股
--
-- 為什麼這個對他特別重要：他的做法是「一次只沖一檔、每檔上限 100 萬」。
-- 買到處置股會卡住——**第二次處置是全額圈存**，買進要先付全部價金、
-- 賣出要先有券，等於當沖做不成；撮合又變成人工約每兩分鐘一次，
-- 想跑的時候排不進去。這是進場前就該知道的事，不是事後才發現。
--
-- 三種等級，嚴重度由高到低：
--   punish  處置中        已經在名單上，期間內都受限
--   near    快達處置標準  注意次數累計已經逼近門檻，隨時會被處置
--   notice  注意股        最近上過注意交易資訊
--
-- 六個來源（上市三個、上櫃三個），全部免費、無金鑰。
-- 注意股當天收盤後才公布，所以查的是最近兩週的區間而不是單日。
-- ============================================================

create table if not exists public.trade_alerts (
  kind    text not null,          -- punish / near / notice
  symbol  text not null,
  as_of   date not null,          -- 公布日期
  name    text,
  src     text,                   -- twse / tpex
  start_d date,                   -- 處置起日
  end_d   date,                   -- 處置迄日
  level   text,                   -- 第一次處置 / 第二次處置（上櫃沒有這個欄位）
  reason  text,
  detail  text,
  updated_at timestamptz not null default now(),
  primary key (kind, symbol, as_of)
);
-- 從公告原文解析出來的兩個數字，直接影響下不下得了單
alter table public.trade_alerts add column if not exists match_min   integer;  -- 幾分鐘撮合一次
alter table public.trade_alerts add column if not exists prepay_lots integer;  -- 幾張以上要圈存，null = 全部
create index if not exists trade_alerts_symbol_idx on public.trade_alerts (symbol);
alter table public.trade_alerts enable row level security;
drop policy if exists "read alerts" on public.trade_alerts;
create policy "read alerts" on public.trade_alerts for select to authenticated using (true);

-- "115/09/07～115/09/15" 或 "1150910~1150916" → 起日或迄日
-- 只切區間分隔符。**不能用 [^0-9]+ 一律換掉**——那會連日期裡的斜線一起切，
-- "115/09/07～115/09/15" 會變成六段，取第一段只剩 "115"，整個範圍就沒了。
create or replace function public.pm_roc_range(t text, p_end boolean default false)
returns date language sql immutable as $$
  select public.pm_roc_date(
    split_part(regexp_replace(coalesce(t, ''), '[～~至]|--', '|', 'g'), '|',
               case when p_end then 2 else 1 end));
$$;

-- 從公告原文抽出兩個真正影響下單的數字。
-- **不要自己歸納「第二次處置就是全額圈存」**——上櫃的公告寫得很清楚：
-- 金居是「單筆達 10 交易單位或多筆累積達 30 交易單位以上時」才圈存，
-- 沒到那個量還是照常委託。照抄官方文字比套規則安全。
-- 撮合間隔不是固定的，實測有 2 / 5 / 20 / 45 分鐘四種，所以一定要從公告裡讀，
-- 不能寫死。證交所用國字（「約每二分鐘」），櫃買用阿拉伯數字（「約每2分鐘」），兩種都要吃。
create or replace function public.pm_disp_match(t text)
returns integer language plpgsql immutable as $$
declare m text;
begin
  m := (regexp_match(coalesce(t, ''), '約每([0-9]+|[一二三四五六七八九十]+)分鐘撮合'))[1];
  if m is null then return null; end if;
  if m ~ '^[0-9]+$' then return m::int; end if;
  return case m
    when '二' then 2 when '五' then 5 when '十' then 10
    when '十五' then 15 when '二十' then 20 when '三十' then 30
    when '四十五' then 45 end;
end $$;

-- 圈存門檻（交易單位＝張）。抓不到代表全部委託都要圈存。
create or replace function public.pm_disp_prepay(t text)
returns integer language sql immutable as $$
  select nullif((regexp_match(coalesce(t, ''), '單筆達([0-9]+)交易單位'))[1], '')::int;
$$;

create or replace function public.refresh_alerts()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare
  payload jsonb; n integer; total integer := 0;
  d0 date; d1 date;
begin
  perform set_config('statement_timeout', '180s', true);
  d1 := (now() at time zone 'Asia/Taipei')::date;
  d0 := d1 - 14;

  -- **六支都用 pm_fetch_json（會重試三次），不要用 pm_fetch。**
  -- 證交所與櫃買都會偶發斷線：2026-09-10 那天 tpex notice 與 tpex near
  -- 同時 SSL_ERROR_SYSCALL，當天就少了 18 筆注意股，而這張表是
  -- 拿來擋「別去空處置股」用的，少一天就是漏一天的風險。
  -- ---------- 上市：處置 ----------
  begin
    payload := public.pm_fetch_json(
      'https://www.twse.com.tw/rwd/zh/announcement/punish?response=json', 3);
    if payload ->> 'stat' = 'OK' then
      insert into public.trade_alerts (kind, symbol, as_of, name, src, start_d, end_d, level,
                                       reason, detail, match_min, prepay_lots)
      select 'punish', upper(btrim(r ->> 2)), public.pm_roc_date(r ->> 1), btrim(r ->> 3), 'twse',
             public.pm_roc_range(r ->> 6, false), public.pm_roc_range(r ->> 6, true),
             btrim(r ->> 7), btrim(r ->> 5), left(btrim(r ->> 8), 1500),
             public.pm_disp_match(r ->> 8), public.pm_disp_prepay(r ->> 8)
      from jsonb_array_elements(payload -> 'data') r
      where btrim(r ->> 2) ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_roc_date(r ->> 1) is not null
      on conflict (kind, symbol, as_of) do update
        set name = excluded.name, start_d = excluded.start_d, end_d = excluded.end_d,
            level = excluded.level, reason = excluded.reason, detail = excluded.detail,
            match_min = excluded.match_min, prepay_lots = excluded.prepay_lots,
            updated_at = now();
      get diagnostics n = row_count; total := total + n;
      perform public.pm_log('alerts twse punish', n, true, null);
    end if;
  exception when others then
    perform public.pm_log('alerts twse punish', 0, false, sqlerrm);
  end;

  -- ---------- 上市：注意 ----------
  -- 當天收盤後才公布，不帶日期會回空的，所以一定要給區間
  begin
    payload := public.pm_fetch_json(
      'https://www.twse.com.tw/rwd/zh/announcement/notice?startDate='
      || to_char(d0, 'YYYYMMDD') || '&endDate=' || to_char(d1, 'YYYYMMDD')
      || '&response=json', 3);
    if payload ->> 'stat' = 'OK' then
      insert into public.trade_alerts (kind, symbol, as_of, name, src, reason)
      select 'notice', upper(btrim(r ->> 1)), public.pm_roc_date(r ->> 5), btrim(r ->> 2), 'twse',
             btrim(r ->> 4)
      from jsonb_array_elements(payload -> 'data') r
      where btrim(r ->> 1) ~ '^[0-9]{4,6}[A-Z]?$' and public.pm_roc_date(r ->> 5) is not null
      on conflict (kind, symbol, as_of) do update
        set name = excluded.name, reason = excluded.reason, updated_at = now();
      get diagnostics n = row_count; total := total + n;
      perform public.pm_log('alerts twse notice', n, true, null);
    end if;
  exception when others then
    perform public.pm_log('alerts twse notice', 0, false, sqlerrm);
  end;

  -- ---------- 上市：快達處置標準 ----------
  begin
    payload := public.pm_fetch_json(
      'https://www.twse.com.tw/rwd/zh/announcement/notetrans?response=json', 3);
    if payload ->> 'stat' = 'OK' then
      insert into public.trade_alerts (kind, symbol, as_of, name, src, reason)
      select 'near', upper(btrim(r ->> 1)), d1, btrim(r ->> 2), 'twse', btrim(r ->> 3)
      from jsonb_array_elements(payload -> 'data') r
      where btrim(r ->> 1) ~ '^[0-9]{4,6}[A-Z]?$'
      on conflict (kind, symbol, as_of) do update
        set name = excluded.name, reason = excluded.reason, updated_at = now();
      get diagnostics n = row_count; total := total + n;
      perform public.pm_log('alerts twse near', n, true, null);
    end if;
  exception when others then
    perform public.pm_log('alerts twse near', 0, false, sqlerrm);
  end;

  -- ---------- 上櫃：處置 ----------
  begin
    payload := public.pm_fetch_json('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', 3);
    insert into public.trade_alerts (kind, symbol, as_of, name, src, start_d, end_d,
                                     reason, detail, match_min, prepay_lots)
    select 'punish', upper(btrim(e ->> 'SecuritiesCompanyCode')),
           public.pm_roc_date(e ->> 'Date'), btrim(e ->> 'CompanyName'), 'tpex',
           public.pm_roc_range(e ->> 'DispositionPeriod', false),
           public.pm_roc_range(e ->> 'DispositionPeriod', true),
           btrim(e ->> 'DispositionReasons'), left(btrim(e ->> 'DisposalCondition'), 1500),
           public.pm_disp_match(e ->> 'DisposalCondition'),
           public.pm_disp_prepay(e ->> 'DisposalCondition')
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$'
      and public.pm_roc_date(e ->> 'Date') is not null
    on conflict (kind, symbol, as_of) do update
      set name = excluded.name, start_d = excluded.start_d, end_d = excluded.end_d,
          reason = excluded.reason, detail = excluded.detail,
          match_min = excluded.match_min, prepay_lots = excluded.prepay_lots,
          updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('alerts tpex punish', n, true, null);
  exception when others then
    perform public.pm_log('alerts tpex punish', 0, false, sqlerrm);
  end;

  -- ---------- 上櫃：注意 ----------
  begin
    payload := public.pm_fetch_json('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information', 3);
    insert into public.trade_alerts (kind, symbol, as_of, name, src, reason)
    select 'notice', upper(btrim(e ->> 'SecuritiesCompanyCode')),
           public.pm_roc_date(e ->> 'Date'), btrim(e ->> 'CompanyName'), 'tpex',
           btrim(e ->> 'TradingInformation')
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$'
      and public.pm_roc_date(e ->> 'Date') is not null
    on conflict (kind, symbol, as_of) do update
      set name = excluded.name, reason = excluded.reason, updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('alerts tpex notice', n, true, null);
  exception when others then
    perform public.pm_log('alerts tpex notice', 0, false, sqlerrm);
  end;

  -- ---------- 上櫃：快達處置標準 ----------
  -- 這支的 Date 是西元 YYYYMMDD，不是民國，跟同一個 API 的其他端點不一樣
  begin
    payload := public.pm_fetch_json('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_note', 3);
    insert into public.trade_alerts (kind, symbol, as_of, name, src, reason)
    select 'near', upper(btrim(e ->> 'SecuritiesCompanyCode')),
           coalesce(
             (case when length(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g')) = 8
                   then to_date(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g'), 'YYYYMMDD') end),
             public.pm_roc_date(e ->> 'Date'), d1),
           btrim(e ->> 'CompanyName'), 'tpex', btrim(e ->> 'AccumulationSituation')
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4,6}[A-Z]?$'
    on conflict (kind, symbol, as_of) do update
      set name = excluded.name, reason = excluded.reason, updated_at = now();
    get diagnostics n = row_count; total := total + n;
    perform public.pm_log('alerts tpex near', n, true, null);
  exception when others then
    perform public.pm_log('alerts tpex near', 0, false, sqlerrm);
  end;

  -- 處置結束、注意過期的就沒有意義了，只留 90 天
  delete from public.trade_alerts where as_of < current_date - 90;

  perform public.pm_log('alerts', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_alerts() from public, anon;

-- ------------------------------------------------------------
-- 現在還有效的警示。處置看期間有沒有過，注意與快達門檻看最近幾天。
-- ------------------------------------------------------------
create or replace function public.active_alerts(p_days integer default 10)
returns table (symbol text, name text, kind text, level text,
               start_d date, end_d date, as_of date, reason text, detail text,
               match_min integer, prepay_lots integer, notices integer)
language sql stable security definer set search_path = public as $fn$
  with live as (
    select a.*,
           case a.kind when 'punish' then 3 when 'near' then 2 else 1 end as sev
    from public.trade_alerts a
    where (a.kind = 'punish' and a.end_d >= current_date)
       or (a.kind <> 'punish' and a.as_of >= current_date - p_days)
  ),
  -- 同一檔可能同時有處置與注意，只留最嚴重的那一筆。
  -- 但注意的「次數」本身就是訊息（連續五次就會被處置），所以另外算近 30 天幾次。
  cnt as (
    select symbol, count(*)::int as notices
    from public.trade_alerts
    where kind = 'notice' and as_of >= current_date - 30
    group by symbol
  )
  select distinct on (l.symbol)
         l.symbol, l.name, l.kind, l.level, l.start_d, l.end_d, l.as_of,
         l.reason, l.detail, l.match_min, l.prepay_lots, coalesce(c.notices, 0)
  from live l left join cnt c on c.symbol = l.symbol
  order by l.symbol, l.sev desc, l.as_of desc;
$fn$;

grant execute on function public.active_alerts(integer) to authenticated;
