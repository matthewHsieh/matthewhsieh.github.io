-- ============================================================
-- 期貨各月份結算價（**備用，目前沒有接進排程**）
--
-- 原本打算用來自動填轉倉價格，但使用者選擇自己輸入成交價，
-- 理由很合理：實際成交價跟結算價本來就不一樣，自己填反而準。
-- 所以這個檔留著但不排程，避免每天重複下載同一份 864KB 的行情檔
-- （refresh_futures_prices 已經抓過同一個端點了）。
--
-- 想啟用的話只要兩行：在 prices.sql 的 update_all_prices 與
-- refresh_market 的 'fut' 分支各加一句 perform public.refresh_fut_months();
--
-- 期交所的股票期貨用兩碼英文代號加 F（台玻 1802 → KU → KUF），
-- 對照表在 fut_codes（爬期交所網頁生成，見 fut_codes.sql）。
-- 指數期貨的代號就是商品本身（TX、MTX），不需要對照。
--
-- 轉倉本身的邏輯在 app.js 的 rollFutures()，不需要這裡的資料也能用。
-- ============================================================

create table if not exists public.fut_months (
  code       text not null,      -- KUF / TX / MTX
  ym         text not null,      -- 202609
  settle     numeric,            -- 結算價，轉倉就是用這個
  last       numeric,
  volume     numeric,
  oi         numeric,            -- 未平倉，用來判斷遠月夠不夠流動
  as_of      date,
  updated_at timestamptz not null default now(),
  primary key (code, ym)
);
alter table public.fut_months enable row level security;
drop policy if exists "read fut months" on public.fut_months;
create policy "read fut months" on public.fut_months for select to authenticated using (true);

-- ------------------------------------------------------------
-- 各月份結算價
--   跳過價差列（ContractMonth 會長成 202609/202610），那不是單一月份。
--   只取一般交易時段，盤後盤的結算價不是正式的。
-- ------------------------------------------------------------
create or replace function public.refresh_fut_months()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer := 0; body text; payload jsonb;
begin
  perform set_config('statement_timeout', '120s', true);
  begin
    body := public.pm_fetch('https://openapi.taifex.com.tw/v1/DailyMarketReportFut');
    begin payload := body::jsonb; exception when others then payload := null; end;
    if payload is null then
      perform public.pm_log('fut_months', 0, false, '回傳不是 JSON');
      return 0;
    end if;

    insert into public.fut_months (code, ym, settle, last, volume, oi, as_of, updated_at)
    select upper(btrim(e ->> 'Contract')),
           btrim(e ->> 'ContractMonth(Week)'),
           coalesce(public.pm_num(e ->> 'SettlementPrice'), public.pm_num(e ->> 'Last')),
           public.pm_num(e ->> 'Last'),
           coalesce(public.pm_num(e ->> 'Volume'), 0),
           coalesce(public.pm_num(e ->> 'OpenInterest'), 0),
           to_date(regexp_replace(e ->> 'Date', '[^0-9]', '', 'g'), 'YYYYMMDD'),
           now()
    from jsonb_array_elements(payload) e
    where btrim(e ->> 'TradingSession') = '一般'
      and btrim(e ->> 'ContractMonth(Week)') ~ '^[0-9]{6}$'   -- 排除價差列
      and coalesce(public.pm_num(e ->> 'SettlementPrice'),
                   public.pm_num(e ->> 'Last')) > 0
    on conflict (code, ym) do update
      set settle = excluded.settle, last = excluded.last, volume = excluded.volume,
          oi = excluded.oi, as_of = excluded.as_of, updated_at = now();
    get diagnostics n = row_count;
    perform public.pm_log('fut_months', n, true, null);
  exception when others then
    perform public.pm_log('fut_months', 0, false, sqlerrm);
  end;
  return n;
end $fn$;

revoke all on function public.refresh_fut_months() from public, anon;

-- ------------------------------------------------------------
-- 轉倉報價：拿到近月與遠月的結算價
--   近月＝最小的月份（結算後期交所就不再列出已到期的月份）
--   遠月＝下一個月份
--   回傳未平倉量，遠月太冷清時前端要提醒。
-- ------------------------------------------------------------
create or replace function public.roll_quote(p_symbol text, p_kind text default 'stock')
returns table (code text, near_ym text, near_px numeric, near_oi numeric,
               far_ym text, far_px numeric, far_oi numeric,
               spread numeric, as_of date)
language sql stable security definer set search_path = public as $fn$
  with c as (
    select case when p_kind = 'stock'
                then (select f.code || 'F' from public.fut_codes f
                       where f.symbol = upper(btrim(p_symbol)))
                else upper(btrim(p_symbol)) end as code
  ),
  m as (
    select fm.ym, fm.settle, fm.oi, fm.as_of,
           row_number() over (order by fm.ym) as rn
    from public.fut_months fm, c
    where fm.code = c.code and fm.settle > 0
  )
  select c.code,
         n.ym, n.settle, n.oi,
         f.ym, f.settle, f.oi,
         -- 價差＝遠月減近月。多單轉倉時，遠月比近月低就是有利的
         case when n.settle is not null and f.settle is not null
              then round(f.settle - n.settle, 4) end,
         n.as_of
  from c
  left join m n on n.rn = 1
  left join m f on f.rn = 2;
$fn$;

grant execute on function public.roll_quote(text, text) to authenticated;
