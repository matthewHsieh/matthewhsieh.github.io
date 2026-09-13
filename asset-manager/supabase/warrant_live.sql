-- ============================================================
-- 權證：前端按 ↻ 時不要去抓 5.2 MB 的全市場行情檔
--
-- 症狀：使用者回報「權證之前有時候會抓失敗」。
--
-- 查出來的原因，三件事疊在一起：
--
--   1. 證交所的 MI_INDEX 認購權證檔**有 5.2 MB**，而且回應時間極不穩定。
--      同一支網址實測兩次：1.3 秒與 8.8 秒。
--
--   2. 前端這條路有 8 秒的硬上限。`authenticated` 角色設了
--      statement_timeout=8s，而 PostgREST 呼叫 refresh_market() 時
--      那 8 秒就latched 在最外層語句上，裡面所有東西都受同一個上限。
--
--   3. **refresh_warrant_prices() 裡的 set_config('statement_timeout','300s')
--      完全無效。** statement_timeout 的計時器在語句開始時就上好了，
--      語句執行到一半改 GUC 不會重新上鏈。實測：先 set local 2s，
--      再在函式裡 set_config 60s 然後 sleep 3 秒 → 照樣被砍。
--      全站有 25 支函式寫了這一行，全部是死碼，而且會給人「已經加長了」的錯覺。
--
--   所以：證交所快的時候成功，慢的時候失敗。排程那條路沒有 8 秒上限，
--   所以**只有你自己按 ↻ 的時候會失敗**，這就是「有時候」的來源。
--
-- 修法：前端那條路改抓 MIS（mis.twse.com.tw），而且**只抓有人持有的那幾檔**。
--   實測 5 檔 3.5 KB、91 毫秒，跟 5.2 MB／1.3–8.8 秒差了兩個數量級，
--   永遠不會靠近 8 秒。排程那條路照舊抓全檔，因為那裡沒有時間壓力，
--   而且全市場的權證基本資料本來就只有全檔才有。
--
-- 估值方法跟全檔那條路一致：有成交用成交價，沒成交用造市商委買賣中價。
--   （實測 067836 買 7.60 賣 8.00 → 中價 7.80，跟收盤檔存的 7.80 一致。）
-- ============================================================

create or replace function public.refresh_warrant_held()
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare ch text; body text; got integer; total integer := 0;
begin
  -- 一次問 50 個通道是 MIS 的上限。每檔權證問兩個通道（上市／上櫃各一），
  -- 因為 warrant_info 沒有存交易所別，問錯的那個 MIS 直接不回，不會報錯。
  for ch in
    select string_agg(c, '|')
    from (
      select c, (row_number() over (order by c) - 1) / 50 as batch
      from (
        select unnest(array['tse_' || code || '.tw', 'otc_' || code || '.tw']) as c
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

      insert into public.market_prices (market, symbol, name, price, as_of, src, updated_at)
      select 'war', q.code, q.nm, q.px, q.dd, 'mis_war', now()
      from (
        select upper(btrim(e ->> 'c')) as code,
               nullif(btrim(e ->> 'n'), '') as nm,
               coalesce(
                 nullif(public.pm_num(e ->> 'z'), 0),                 -- 有成交
                 case when public.pm_num(split_part(e ->> 'b', '_', 1)) > 0
                       and public.pm_num(split_part(e ->> 'a', '_', 1)) > 0
                      then (public.pm_num(split_part(e ->> 'b', '_', 1))
                          + public.pm_num(split_part(e ->> 'a', '_', 1))) / 2.0 end,
                 nullif(public.pm_num(split_part(e ->> 'b', '_', 1)), 0)   -- 只有委買
               ) as px,
               to_date(nullif(btrim(e ->> 'd'), ''), 'YYYYMMDD') as dd
        from jsonb_array_elements((body::jsonb) -> 'msgArray') e
        where btrim(e ->> 'd') ~ '^[0-9]{8}$'
      ) q
      where q.px > 0 and q.dd is not null
      -- **src 一定要跟全檔那條路不一樣。**
      -- 如果沿用 twse_warrant_0999，refresh_warrant_prices() 判斷
      -- 「max(as_of) 已經是今天」就會跳過全檔，結果只有你持有的那幾檔是新的，
      -- 其餘整個市場停在舊日期，而且畫面上看不出來。
      on conflict (market, symbol) do update
        set price = excluded.price,
            name = coalesce(excluded.name, market_prices.name),
            as_of = excluded.as_of, src = excluded.src, updated_at = now();
      get diagnostics got = row_count;
      total := total + got;
    exception when others then
      perform public.pm_log('mis_war', 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('mis_war', total, true, null);
  return total;
end $function$;

revoke all on function public.refresh_warrant_held() from public, anon, authenticated;
comment on function public.refresh_warrant_held() is
  '只更新有人持有的權證報價，走 MIS。給前端 ↻ 用，避開 5.2MB 全檔與 8 秒上限。';
