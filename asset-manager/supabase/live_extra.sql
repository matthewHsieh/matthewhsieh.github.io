-- ============================================================
-- 盤中：權證與加權指數也進 market_live（2026-10-30）
--
-- 症狀：盤中大跌那天，App 上的權證價格一整天停在前一天早上的報價，
--   標的跌停、權證市值卻多算了兩成；美股要等到隔天下午兩點半才換成新的收盤價。
--
-- 原因有兩個：
--   1. refresh_live()（每 5 分鐘）只問 pm_live_channels() 給的股票代號，
--      **權證從來不在裡面**。權證只有在使用者按 ↻ 時才走 refresh_warrant_held()。
--   2. update_us()（台北時間早上 6:05）只更新 market_prices，
--      寫進部位要等下一次 sync_positions()，也就是下午 2:35 的 update_quotes()。
--
-- 修法：
--   1. refresh_live_extra()：持有的權證 ＋ 加權指數（tse_t00）一起問 MIS，寫進 market_live。
--      前端本來就會把新鮮的 market_live 疊在部位價格上（live.js），權證只要能被查到就好。
--      加權指數存成 market='idx'、symbol='TAIEX'：選擇權規則要知道「今天是不是大跌日」。
--      權證估值跟 refresh_warrant_held() 一致：有成交用成交價，沒成交用委買賣中價。
--   2. refresh_live() 最後呼叫它；update_us() 抓完報價馬上 sync_positions()。
--      兩處都包 begin/exception：附加的工作失敗，不能讓原本的工作一起回滾。
-- ============================================================

create or replace function public.refresh_live_extra()
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare ch text; body text; got integer; total integer := 0;
begin
  -- 一次最多 50 個通道（MIS 的上限）。權證沒有存交易所別，上市／上櫃各問一次，
  -- 問錯的那個 MIS 直接不回，不會報錯。
  for ch in
    select string_agg(c, '|')
    from (
      select c, (row_number() over (order by c) - 1) / 50 as batch
      from (
        select 'tse_t00.tw' as c
        union all
        select unnest(array['tse_' || code || '.tw', 'otc_' || code || '.tw'])
        from (select distinct upper(btrim(w.code)) as code
              from public.warrants w
              where w.code is not null and btrim(w.code) <> '') k
      ) y
    ) x
    group by x.batch
    order by x.batch
  loop
    begin
      body := public.pm_fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch='
                              || replace(ch, '|', '%7C') || '&json=1&delay=0');
      insert into public.market_live (market, symbol, price, chg, open, high, low, at)
      select case when q.code = 'T00' then 'idx' else 'war' end,
             case when q.code = 'T00' then 'TAIEX' else q.code end,
             q.px,
             case when q.prev > 0 then q.px - q.prev end,
             q.o, q.h, q.l, now()
      from (
        select upper(btrim(e ->> 'c')) as code,
               coalesce(
                 nullif(public.pm_num(e ->> 'z'), 0),                 -- 有成交
                 case when public.pm_num(split_part(e ->> 'b', '_', 1)) > 0
                       and public.pm_num(split_part(e ->> 'a', '_', 1)) > 0
                      then (public.pm_num(split_part(e ->> 'b', '_', 1))
                          + public.pm_num(split_part(e ->> 'a', '_', 1))) / 2.0 end,
                 nullif(public.pm_num(split_part(e ->> 'b', '_', 1)), 0)   -- 只有委買
               ) as px,
               public.pm_num(e ->> 'y') as prev,
               public.pm_num(e ->> 'o') as o,
               public.pm_num(e ->> 'h') as h,
               public.pm_num(e ->> 'l') as l,
               to_date(nullif(btrim(e ->> 'd'), ''), 'YYYYMMDD') as dd
        from jsonb_array_elements((body::jsonb) -> 'msgArray') e
        where btrim(e ->> 'd') ~ '^[0-9]{8}$'
      ) q
      -- 只接受今天的。MIS 在非交易日會回上一個交易日的資料。
      where q.px > 0 and q.dd = (now() at time zone 'Asia/Taipei')::date
      on conflict (market, symbol) do update
        set price = excluded.price, chg = excluded.chg, open = excluded.open,
            high = excluded.high, low = excluded.low, at = now();
      get diagnostics got = row_count;
      total := total + got;
    exception when others then
      perform public.pm_log('live_extra', 0, false, sqlerrm);
    end;
  end loop;
  return total;
end $fn$;

revoke all on function public.refresh_live_extra() from public, anon, authenticated;
comment on function public.refresh_live_extra() is
  '盤中把持有的權證與加權指數寫進 market_live。refresh_live() 每 5 分鐘呼叫。';

-- refresh_live() 與 update_us() 是拿線上的 pg_get_functiondef 做字串替換套上去的
-- （這兩支在 repo 裡的版本不是線上版本的完整來源，見 asset-manager-dev-workflow）。
-- 套用後的完整定義：

create or replace function public.update_us()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public.refresh_us_prices();
  -- 抓到就寫進部位。不寫的話要等到下午 2:35 的 update_quotes()，
  -- 這中間 App 顯示的是前一天的美股收盤價。
  begin
    perform public.sync_positions(null);
  exception when others then
    perform public.pm_log('us_sync', 0, false, sqlerrm);
  end;
  perform public.refresh_us_stats(60);
end $function$;

-- refresh_live()：在原本的迴圈之後加呼叫 refresh_live_extra()（拿線上定義做字串替換）。套用後的完整定義：
CREATE OR REPLACE FUNCTION public.refresh_live()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare ch text; body text; n integer := 0; got integer; nowt time; dow integer;
begin
  nowt := (now() at time zone 'Asia/Taipei')::time;
  dow  := extract(isodow from (now() at time zone 'Asia/Taipei'));
  -- 只在台股交易時段內跑。收盤後的補抓是 update_quotes_live 的事。
  if dow > 5 or nowt < time '09:00' or nowt > time '13:35' then return 0; end if;

  -- 一批一批問。單一使用者只會有一批，人多了才會有第二批。
  for ch in select * from public.pm_live_channels() loop
    begin
      body := public.pm_fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch='
                              || replace(ch, '|', '%7C') || '&json=1&delay=0');
      insert into public.market_live (market, symbol, price, chg, open, high, low, at)
      select 'tw', q.symbol, q.price,
             case when q.prev > 0 then q.price - q.prev end,
             q.open, q.high, q.low, now()
      from public.pm_mis_quotes(body) q
      where q.d = (now() at time zone 'Asia/Taipei')::date
      on conflict (market, symbol) do update
        set price = excluded.price, chg = excluded.chg, open = excluded.open,
            high = excluded.high, low = excluded.low, at = now();
      get diagnostics got = row_count;
      n := n + got;
    exception when others then
      perform public.pm_log('live', 0, false, sqlerrm);
    end;
  end loop;
  -- 持有的權證與加權指數（supabase/live_extra.sql）。失敗不能讓上面的股票報價一起回滾。
  begin
    n := n + public.refresh_live_extra();
  exception when others then
    perform public.pm_log('live_extra', 0, false, sqlerrm);
  end;
  return n;
end $function$
;
