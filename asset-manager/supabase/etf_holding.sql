-- ============================================================
-- 主動型 ETF 的實際持股
--
-- 每日申購買回清單各家投信只放在自己網站，格式都不一樣、國泰那個網域
-- 還整站擋自動存取，一度以為只能寫十七支解析器。中間退而求其次用過
-- MoneyDJ，但它只給**前十大**。
--
-- **最後找到 CMoney 有完整持股，而且是一個 GET 就回一包 JSON。**
--   https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx
--     ?action=getdtnodata&DtNo=59449513&ParamStr=AssignID=<代號>;...MajorTable=M722;
-- 32 檔全部涵蓋，每檔 38～98 筆，台股上市上櫃與美股持股都有，
-- 回應才兩三 KB（MoneyDJ 一頁 60KB）。
--
-- 口袋證券（pocket.tw）是同一份資料，但它的 /api/cm/ 只是代理，
-- **而且從 Supabase 連過去 TLS 會被擋**（SSL_ERROR_SYSCALL，換 UA 沒用，
-- 應該是 WAF 或機房 IP），所以直接打上游 www.cmoney.tw。
--
-- 回傳裡不是每一列都是持股，要看「單位」欄：
--   股  真正的持股。台股是裸代號 2330，美股是 'TSLA US'
--   元  現金、應收處分款、附買回債券
--   口  期貨（例如 202609TX 台指期貨）
-- ============================================================

-- ------------------------------------------------------------
-- 已發行股數
--
-- 要算「這些 ETF 合計吃掉這檔股票的幾 %」，分母是已發行普通股數。
-- stock_universe.market_cap 整欄是空的（1,974 檔沒有一檔有值），不能用。
-- 證交所與櫃買的公司基本資料都直接有這個欄位，不必拿實收資本額去除面額。
-- ------------------------------------------------------------
create table if not exists public.stock_shares (
  market     text not null,
  symbol     text not null,
  shares     numeric,           -- 已發行普通股數
  as_of      date,
  updated_at timestamptz not null default now(),
  primary key (market, symbol)
);
alter table public.stock_shares enable row level security;
drop policy if exists "read stock shares" on public.stock_shares;
create policy "read stock shares" on public.stock_shares for select to authenticated using (true);
drop policy if exists "public read stock shares" on public.stock_shares;
create policy "public read stock shares" on public.stock_shares for select to anon using (true);
grant select on public.stock_shares to anon, authenticated;

create or replace function public.refresh_stock_shares()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare payload jsonb; n integer := 0; m integer := 0;
begin
  -- 兩個 OpenAPI 各一次請求，實測幾秒。函式內 set_config('statement_timeout')
  -- 無效，上限在語句開始時就鎖定了。

  -- 上市
  begin
    payload := public.pm_fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L')::jsonb;
    insert into public.stock_shares (market, symbol, shares, as_of, updated_at)
    select 'tw', btrim(r ->> '公司代號'),
           nullif(btrim(r ->> '已發行普通股數或TDR原股發行股數'), '')::numeric,
           current_date, now()
    from jsonb_array_elements(payload) r
    where btrim(r ->> '公司代號') ~ '^[0-9]{4}$'
      and nullif(btrim(r ->> '已發行普通股數或TDR原股發行股數'), '') is not null
    on conflict (market, symbol) do update
      set shares = excluded.shares, as_of = excluded.as_of, updated_at = now();
    get diagnostics n = row_count;
  exception when others then
    perform public.pm_log('stock_shares 上市', 0, false, sqlerrm);
  end;

  -- 上櫃。欄位名是英文的，IssueShares。
  begin
    payload := public.pm_fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O')::jsonb;
    insert into public.stock_shares (market, symbol, shares, as_of, updated_at)
    select 'tw', btrim(r ->> 'SecuritiesCompanyCode'),
           nullif(btrim(r ->> 'IssueShares'), '')::numeric,
           current_date, now()
    from jsonb_array_elements(payload) r
    where btrim(r ->> 'SecuritiesCompanyCode') ~ '^[0-9]{4}$'
      and nullif(btrim(r ->> 'IssueShares'), '') ~ '^[0-9]+$'
    on conflict (market, symbol) do update
      set shares = excluded.shares, as_of = excluded.as_of, updated_at = now();
    get diagnostics m = row_count;
  exception when others then
    perform public.pm_log('stock_shares 上櫃', 0, false, sqlerrm);
  end;

  perform public.pm_log('stock_shares', n + m, true, null);
  return n + m;
end $fn$;

revoke all on function public.refresh_stock_shares() from public, anon;

-- ------------------------------------------------------------
-- 持股
-- ------------------------------------------------------------
create table if not exists public.etf_holding (
  etf         text not null,
  symbol      text not null,
  name        text,
  mkt         text,             -- TW / TWO / US，MoneyDJ 標在代號後面
  weight      numeric,          -- 佔該檔 ETF 的 %
  shares_held numeric,
  as_of       date,
  updated_at  timestamptz not null default now(),
  primary key (etf, symbol)
);
create index if not exists etf_holding_symbol on public.etf_holding (symbol);
alter table public.etf_holding enable row level security;
drop policy if exists "read etf holding" on public.etf_holding;
create policy "read etf holding" on public.etf_holding for select to authenticated using (true);
drop policy if exists "public read etf holding" on public.etf_holding;
create policy "public read etf holding" on public.etf_holding for select to anon using (true);
grant select on public.etf_holding to anon, authenticated;

-- CMoney 的回傳是 {"Title":[...],"Data":[[...],...]}，每一列是一個陣列，
-- 欄序固定：日期 / 標的代號 / 標的名稱 / 權重(%) / 持有數 / 單位。
create or replace function public.pm_cm_holdings(p_body text)
returns table (symbol text, name text, mkt text, weight numeric,
               shares_held numeric, d date)
language sql immutable as $fn$
  select upper(split_part(btrim(e ->> 1), ' ', 1)),
         btrim(e ->> 2),
         -- 代號是彭博格式：台股是裸代號 2330，國外是「代號 市場」。
         -- **不能只認 US**，實際出現過 JP / LN / KS / GY / IM / NA / FP /
         -- GA / CH / HK / JT / KP / SM / UW 共 16 種。只認 US 的話，
         -- 日本的 6997 NIPPON CHEMI-CON 會被當成台股 6997，
         -- 算出「被吃掉 5.77% 股本」這種完全錯誤的數字。
         case when btrim(e ->> 1) like '% %'
              then upper(split_part(btrim(e ->> 1), ' ', 2)) else 'TW' end,
         nullif(btrim(e ->> 3), '')::numeric,
         nullif(replace(btrim(e ->> 4), ',', ''), '')::numeric,
         to_date(btrim(e ->> 0), 'YYYYMMDD')
  from jsonb_array_elements((p_body::jsonb) -> 'Data') e
  -- 只要真正的持股。'元' 是現金與應收款、'口' 是期貨。
  where btrim(e ->> 5) = '股'
    and btrim(e ->> 0) ~ '^[0-9]{8}$'
    and nullif(replace(btrim(e ->> 4), ',', ''), '') ~ '^[0-9.]+$';
$fn$;

create or replace function public.refresh_etf_holdings()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; n integer := 0; got integer;
begin
  -- 32 檔各一個小請求，實測十幾秒，遠低於預設的 120 秒上限。
  -- （函式內 set_config('statement_timeout') 是無效的，上限在語句開始時就鎖定。）
  for r in select symbol from public.active_etf order by symbol loop
    begin
      body := public.pm_fetch(
        'https://www.cmoney.tw/MobileService/ashx/GetDtnoData.ashx'
        || '?action=getdtnodata&DtNo=59449513&ParamStr=AssignID%3D' || r.symbol
        || '%3BMTPeriod%3D0%3BDTMode%3D0%3BDTRange%3D1%3BDTOrder%3D1%3BMajorTable%3DM722%3B'
        || '&FilterNo=0');

      insert into public.etf_holding (etf, symbol, name, mkt, weight, shares_held, as_of, updated_at)
      select r.symbol, h.symbol, h.name, h.mkt, h.weight, h.shares_held, h.d, now()
      from public.pm_cm_holdings(body) h
      on conflict (etf, symbol) do update
        set name = excluded.name, mkt = excluded.mkt, weight = excluded.weight,
            shares_held = excluded.shares_held, as_of = excluded.as_of, updated_at = now();
      get diagnostics got = row_count;

      -- 換股會讓上一次的那一檔留在表裡變成幽靈。
      -- **不能用 updated_at 的時間差來判斷**——now() 在同一個交易裡是固定值，
      -- 剛寫進去的列跟「舊列」的時間戳會分不出來。直接比對這次解析到的清單。
      if got > 0 then
        delete from public.etf_holding h
        where h.etf = r.symbol
          and not exists (select 1 from public.pm_cm_holdings(body) x where x.symbol = h.symbol);
        n := n + 1;
      end if;
      perform pg_sleep(0.2);
    exception when others then
      perform public.pm_log('etf_holding ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('etf_holding', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_etf_holdings() from public, anon;

-- ------------------------------------------------------------
-- 族群層級：這個族群有沒有被主動型 ETF 重壓
--
-- 三個數字各自回答不同的問題，畫面上要挑對：
--   funds    幾檔主動 ETF 在這個族群裡有持股 → 有多少人同意這個題材
--   top_own  族群內被吃最兇的那一檔佔股本幾 % → 籌碼鎖住的程度
--   val_yi   這些 ETF 押在這個族群的總市值 → 錢的絕對量
-- 只看 funds 會被大型股騙（每檔基金都放台積電，不代表它是題材）；
-- 只看 val_yi 會被權值股騙。要看「有人重壓」，top_own 才是那個數字。
-- ------------------------------------------------------------
create or replace function public.theme_etf()
returns table (theme text, funds integer, names integer, val_yi numeric,
               top_symbol text, top_name text, top_own numeric, as_of date)
language sql stable security definer set search_path = public as $fn$
  with own as (
    select h.symbol, max(h.name) as name,
           sum(h.shares_held) / nullif(max(s.shares), 0) * 100 as own_pct,
           sum(h.shares_held) * max(m.price) as val
    from public.etf_holding h
    join public.stock_shares s on s.market = 'tw' and s.symbol = h.symbol
    left join public.market_prices m on m.market = 'tw' and m.symbol = h.symbol
    where h.mkt = 'TW'
    group by h.symbol
  ),
  per as (
    select t.theme, o.symbol, o.name, o.own_pct, o.val,
           row_number() over (partition by t.theme order by o.own_pct desc nulls last) as rk
    from public.themes t join own o on o.symbol = t.symbol
  )
  select p.theme,
         (select count(distinct h.etf)::int from public.etf_holding h
          join public.themes t2 on t2.symbol = h.symbol and t2.theme = p.theme),
         count(*)::int,
         round(sum(p.val) / 1e8, 1),
         max(p.symbol) filter (where p.rk = 1),
         max(p.name)   filter (where p.rk = 1),
         round(max(p.own_pct) filter (where p.rk = 1), 3),
         (select max(as_of) from public.etf_holding)
  from per p group by p.theme
  order by max(p.own_pct) desc nulls last;
$fn$;

grant execute on function public.theme_etf() to anon, authenticated;

-- ------------------------------------------------------------
-- 主動 ETF 那一頁的全部資料，一次回一包
--
-- 基金 32 檔、每檔十筆持股、族群 23 列，分開叫三次 RPC 沒有比較清楚，
-- 而且 PostgREST 預設 1000 列上限踩過一次，包成一個 jsonb 最穩。
--
-- 原本還回一份「日報酬相關性推估的族群風格」。**拿掉了**：
-- 有了實際持股之後，同一頁擺兩套講同一件事的東西只會讓人搞不清楚
-- 在看什麼。推估的管線（etf_tilt / px_daily）也一起停掉，
-- 不然就是每天抓 250 檔日線去算一份沒有人看的數字。
--
-- **這支要放在最後。** 它同時讀 etf_perf、etf_holding、stock_shares，
-- LANGUAGE SQL 建立時就會驗內文，放在前面的檔案裡全新資料庫會套用失敗。
-- ------------------------------------------------------------
create or replace function public.etf_board()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'as_of', (select max(last_day) from public.etf_perf),
    'hold_as_of', (select max(as_of) from public.etf_holding),
    'funds', coalesce((
      select jsonb_agg(to_jsonb(f)
               -- 實際持股。**只放權重前 12 大**——一檔平均 50 檔持股，
               -- 32 檔全放進來是 1,592 列，畫面上也不會列那麼多。
               -- holds_n 帶總檔數，讓畫面可以寫「還有 N 檔」。
               || jsonb_build_object(
                    'holds_n', (select count(*) from public.etf_holding h where h.etf = f.symbol),
                    'holds', coalesce((
                      select jsonb_agg(jsonb_build_object('symbol', x.symbol, 'name', x.name,
                                                          'mkt', x.mkt, 'weight', x.weight)
                             order by x.weight desc)
                      from (select h.symbol, h.name, h.mkt, h.weight
                            from public.etf_holding h where h.etf = f.symbol
                            order by h.weight desc limit 12) x), '[]'::jsonb))
             order by f.excess desc nulls last)
      from public.active_etf_perf() f), '[]'::jsonb),
    'crowd', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.top_own desc nulls last)
      from public.theme_etf() c), '[]'::jsonb)
  );
$fn$;

grant execute on function public.etf_board() to anon, authenticated;
