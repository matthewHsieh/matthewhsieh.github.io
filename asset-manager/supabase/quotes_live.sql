-- ============================================================
-- 收盤後立刻補上櫃的收盤價
--
-- **問題：上櫃的收盤價會晚一個多小時。**
-- 13:30 收盤，但櫃買那份 4.4MB 的 OpenAPI 收盤檔要到 14:15 左右才出得來，
-- 我們第一班排 14:35。上市的 MI_INDEX 14:35 就有，所以 13:30 到 14:35 之間
-- 打開持倉，上市部位是今天的、金居（8358，上櫃）還停在昨天——看起來像壞掉。
--
-- 再加上櫃買那份大檔會中途斷線（見 pm_fetch_json），只要 14:35 那班掛掉，
-- 原本要等到 16:05，那就是一個半小時。2026-09-11 就是這樣。
--
-- **解法：收盤後先用證交所的即時行情（MIS）補。**
-- MIS 同時涵蓋上市與上櫃，13:30:00 就有成交價，一次可以問一批代號。
-- 但它只給價格與買賣檔位，**沒有完整的當日統計**，所以定位是「暫時頂著」：
-- 只補持倉相關的那幾檔，等櫃買的正式檔案出來就會被蓋掉。
--
-- src 故意寫成 'mis' 而不是 'tpex'。update_quotes 的守則是看
-- 「src='tpex' 的最新日期」決定要不要拉那 4MB，寫成 tpex 會讓它誤以為
-- 已經抓過而永遠跳過正式檔案。
--
-- 但這樣一來 src 就不能當交易所別用了，所以另外有一欄 exch，
-- 只有正式檔案會寫，MIS 不碰。理由見 pm_live_channels。
-- ============================================================

-- MIS 的欄位名是單字母：c 代號、z 成交、y 昨收、o 開、h 高、l 低、d 日期。
-- 沒成交時 z 會是 '-'，pm_num 會轉成 null，那種就不要寫。
create or replace function public.pm_mis_quotes(p_body text)
returns table (symbol text, price numeric, prev numeric,
               open numeric, high numeric, low numeric, d date)
language sql immutable set search_path = public as $fn$
  select upper(btrim(e ->> 'c')),
         public.pm_num(e ->> 'z'), public.pm_num(e ->> 'y'),
         public.pm_num(e ->> 'o'), public.pm_num(e ->> 'h'), public.pm_num(e ->> 'l'),
         to_date(nullif(btrim(e ->> 'd'), ''), 'YYYYMMDD')
  from jsonb_array_elements((p_body::jsonb) -> 'msgArray') e
  where public.pm_num(e ->> 'z') > 0
    and btrim(e ->> 'd') ~ '^[0-9]{8}$';
$fn$;

create or replace function public.update_quotes_live()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare ch text; body text; n integer := 0; today date; nowt time;
begin
  today := (now() at time zone 'Asia/Taipei')::date;
  nowt  := (now() at time zone 'Asia/Taipei')::time;
  -- 盤中不要寫。這張表存的是「收盤價」，寫進未定案的盤中價會讓
  -- 漲跌幅、從低點拉起這些數字全部對不上。
  if nowt < time '13:31' then return 0; end if;

  -- 只補**持倉相關**而且還沒有今天資料的那幾檔。
  -- 全市場有 MI_INDEX 與櫃買的正式檔案可以用，不需要拿即時行情去打。
  -- 上市要 tse_ 前綴、上櫃要 otc_，用上一個交易日的 src 判斷是哪一種。
  select string_agg(case when s.exch = 'tpex' then 'otc_' else 'tse_' end || s.symbol || '.tw', '|')
    into ch
  from (
    select distinct m.symbol, coalesce(m.exch, m.src) as exch
    from public.market_prices m
    where m.market = 'tw' and m.as_of < today
      and m.symbol in (
        select st.symbol from public.stocks st
        union select f.symbol from public.futures f where f.symbol is not null
        union select w.underlying from public.warrants w where w.underlying is not null)
    limit 50
  ) s;

  if ch is null then
    perform public.pm_log('mis(不用補)', 0, true, null);
    return 0;
  end if;

  begin
    body := public.pm_fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch='
                            || replace(ch, '|', '%7C') || '&json=1&delay=0');
    insert into public.market_prices (market, symbol, price, chg, open, high, low,
                                      as_of, src, updated_at)
    select 'tw', q.symbol, q.price,
           case when q.prev > 0 then q.price - q.prev end,
           q.open, q.high, q.low, q.d, 'mis', now()
    from public.pm_mis_quotes(body) q
    -- 只接受今天的。MIS 在非交易日會回上一個交易日的資料。
    where q.d = today
    on conflict (market, symbol) do update
      set price = excluded.price, chg = excluded.chg,
          open = excluded.open, high = excluded.high, low = excluded.low,
          as_of = excluded.as_of, src = excluded.src, updated_at = now();
    get diagnostics n = row_count;
    perform public.pm_log('mis', n, true, null);
  exception when others then
    perform public.pm_log('mis', 0, false, sqlerrm);
  end;

  return n;
end $fn$;

revoke all on function public.update_quotes_live() from public, anon;
revoke all on function public.pm_mis_quotes(text) from public, anon;

-- ------------------------------------------------------------
-- 排程：收盤後到櫃買正式檔案出來之前，每十分鐘補一次
--
-- 抓到今天的之後就自己跳過（條件是 as_of < today），所以這幾班
-- 平常只會打一次 MIS。14:35 之後櫃買的正式檔案會蓋掉這些值。
-- ------------------------------------------------------------
do $do$
begin
  perform cron.unschedule(j) from unnest(array[
    'am-live-1', 'am-live-2', 'am-live-3', 'am-live-4']) j
  where exists (select 1 from cron.job where jobname = j);

  perform cron.schedule('am-live-1', '33 5 * * 1-5', $c$select public.update_quotes_live()$c$); -- 13:33
  perform cron.schedule('am-live-2', '45 5 * * 1-5', $c$select public.update_quotes_live()$c$); -- 13:45
  perform cron.schedule('am-live-3', '0 6 * * 1-5',  $c$select public.update_quotes_live()$c$); -- 14:00
  perform cron.schedule('am-live-4', '20 6 * * 1-5', $c$select public.update_quotes_live()$c$); -- 14:20
end $do$;

-- ============================================================
-- 盤中即時價
--
-- market_prices 存的是**收盤價**，盤中不能寫進去——漲跌幅、從當日低點
-- 拉起這些數字都是拿它算的，塞未定案的價格會讓整頁的判斷失真，
-- 而且收盤後還會被正式檔案蓋掉，中間的歷史就亂了。
--
-- 所以盤中價另外開一張表。畫面上是**兩個不同的東西**：
-- 收盤價是事實，盤中價是現在的報價，標示清楚才不會看錯。
-- ============================================================
create table if not exists public.market_live (
  market text not null,
  symbol text not null,
  price  numeric,
  chg    numeric,
  open   numeric,
  high   numeric,
  low    numeric,
  at     timestamptz not null default now(),
  primary key (market, symbol)
);
alter table public.market_live enable row level security;
drop policy if exists "read market live" on public.market_live;
create policy "read market live" on public.market_live for select to authenticated using (true);
drop policy if exists "public read market live" on public.market_live;
create policy "public read market live" on public.market_live for select to anon using (true);
grant select on public.market_live to anon, authenticated;

-- 要問哪些代號：持倉相關的。全市場沒必要拿即時行情去打。
--
-- **交易所別要看 exch 不能看 src。**
-- MIS 上市要 tse_ 前綴、上櫃要 otc_，前綴錯就整檔查不到。
-- 原本是拿 src 反推（src='tpex' 就是上櫃），但 update_quotes_live 補完之後
-- 會把 src 改成 'mis'，交易所別就消失了——下一次組通道 8358 金居變成
-- tse_8358.tw，MIS 直接不回。**我們想修的那一檔，補過一次就再也補不到。**
-- 所以另外存 exch，只有證交所／櫃買的正式檔案會寫它，MIS 不碰。
create or replace function public.pm_live_channels()
returns text language sql stable security definer set search_path = public as $fn$
  select string_agg(case when s.exch = 'tpex' then 'otc_' else 'tse_' end || s.symbol || '.tw', '|')
  from (
    select distinct m.symbol, coalesce(m.exch, m.src) as exch
    from public.market_prices m
    where m.market = 'tw'
      and m.symbol in (
        select st.symbol from public.stocks st
        union select f.symbol from public.futures f where f.symbol is not null
        union select w.underlying from public.warrants w where w.underlying is not null)
    limit 50
  ) s;
$fn$;

create or replace function public.refresh_live()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare ch text; body text; n integer := 0; nowt time; dow integer;
begin
  nowt := (now() at time zone 'Asia/Taipei')::time;
  dow  := extract(isodow from (now() at time zone 'Asia/Taipei'));
  -- 只在台股交易時段內跑。收盤後的補抓是 update_quotes_live 的事。
  if dow > 5 or nowt < time '09:00' or nowt > time '13:35' then return 0; end if;

  ch := public.pm_live_channels();
  if ch is null then return 0; end if;

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
    get diagnostics n = row_count;
  exception when others then
    perform public.pm_log('live', 0, false, sqlerrm);
  end;
  return n;
end $fn$;

revoke all on function public.refresh_live() from public, anon;
revoke all on function public.pm_live_channels() from public, anon;

do $do$
begin
  perform cron.unschedule('am-live-tick')
  where exists (select 1 from cron.job where jobname = 'am-live-tick');
  -- 台北 09:00–13:35，每五分鐘。函式自己會判斷時段，排太寬也不會亂寫。
  perform cron.schedule('am-live-tick', '*/5 1-5 * * 1-5',
    $c$select public.refresh_live()$c$);
end $do$;
