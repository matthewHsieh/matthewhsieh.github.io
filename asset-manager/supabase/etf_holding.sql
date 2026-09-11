-- ============================================================
-- 主動型 ETF 的實際持股
--
-- 上一版只能用日報酬的相關性**推估**押在哪些產業，因為每日申購買回清單
-- 各家投信只放在自己網站、格式都不一樣、國泰那個網域還整站擋自動存取。
--
-- **但是 MoneyDJ 有。** 它把每一檔 ETF 的前十大持股整理成同一個版型，
-- 伺服器端算好的 HTML，一支解析器吃得下全部 32 檔，資料日期幾乎是前一天。
--
-- 拿得到的：個股代號、**投資比例（佔該檔 ETF 幾 %）**、持有股數、資料日期。
-- 拿不到的：第十一名以後。主動型 ETF 通常持有三、五十檔，前十大大約佔
-- 五到七成。**這個限制要一路標到畫面上**——某檔股票沒出現，只代表它不在
-- 任何一檔的前十大，不代表沒有人持有。
--
-- 不過就這個功能要回答的問題來說，前十大剛好就是答案：
-- 「有沒有人重壓」這件事，照定義就發生在前十大裡面。
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

-- 解析一頁。版型是固定的三欄表格：
--   <td class="col05"><a …>台積電(2330.TW)</a></td>
--   <td class="col06">10.24</td><td class="col07">11,864,000.00</td>
-- **所有量詞都要非貪婪。** Postgres 的貪婪與否是由「第一個帶偏好的量詞」
-- 決定的，前面放一個貪婪的 .* 會讓整串跟著貪婪，一路吃到頁尾。
create or replace function public.pm_mdj_holdings(p_body text)
returns table (symbol text, name text, mkt text, weight numeric, shares_held numeric)
language sql immutable as $fn$
  select btrim(g[2]), btrim(g[1]), upper(btrim(g[3])),
         nullif(btrim(g[4]), '')::numeric,
         nullif(replace(btrim(g[5]), ',', ''), '')::numeric
  from regexp_matches(p_body,
    'col05">.*?([^<>(]+?)\(([^()]+?)\.(TW|TWO|US)\)<.*?col06">(.*?)</td>.*?col07">(.*?)</td>',
    'g') as g
  where btrim(g[4]) ~ '^[0-9.]+$' and replace(btrim(g[5]), ',', '') ~ '^[0-9.]+$';
$fn$;

create or replace function public.refresh_etf_holdings()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; d date; n integer := 0; got integer;
begin
  -- 實測 15 秒（32 頁 × 0.3 秒間隔）。函式內 set_config('statement_timeout')
  -- 無效，上限在語句開始時就鎖定了。

  for r in select symbol from public.active_etf order by symbol loop
    begin
      body := public.pm_fetch('https://www.moneydj.com/etf/x/Basic/Basic0007.xdjhtm?etfid='
                              || r.symbol || '.TW');
      -- 資料日期跟在 sdate3 那個 div 裡，抓不到就不寫，寧可沒有也不要寫錯日期
      d := to_date((regexp_match(body, 'sdate3.*?資料日期：([0-9]{4}/[0-9]{2}/[0-9]{2})'))[1],
                   'YYYY/MM/DD');

      insert into public.etf_holding (etf, symbol, name, mkt, weight, shares_held, as_of, updated_at)
      select r.symbol, h.symbol, h.name, h.mkt, h.weight, h.shares_held, d, now()
      from public.pm_mdj_holdings(body) h
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
          and not exists (select 1 from public.pm_mdj_holdings(body) x where x.symbol = h.symbol);
        n := n + 1;
      end if;
      perform pg_sleep(0.3);
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
    where h.mkt in ('TW', 'TWO')
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
-- **這支要放在最後。** 它同時讀 etf_perf、etf_tilt、etf_holding、stock_shares，
-- LANGUAGE SQL 建立時就會驗內文，放在前面的檔案裡全新資料庫會套用失敗。
-- ------------------------------------------------------------
create or replace function public.etf_board()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'as_of', (select max(last_day) from public.etf_perf),
    'hold_as_of', (select max(as_of) from public.etf_holding),
    'rated', (select count(distinct symbol)::int from public.etf_tilt),
    'funds', coalesce((
      select jsonb_agg(to_jsonb(f)
               -- 實際持股（前十大，MoneyDJ）
               || jsonb_build_object('holds', coalesce((
                    select jsonb_agg(jsonb_build_object('symbol', h.symbol, 'name', h.name,
                                                        'mkt', h.mkt, 'weight', h.weight)
                           order by h.weight desc)
                    from public.etf_holding h where h.etf = f.symbol), '[]'::jsonb))
               -- 風格推估（日報酬相關）。持股只有前十大，第十一名以後
               -- 看不到，這一欄補的就是那一段。
               || jsonb_build_object('tilts', coalesce((
                    select jsonb_agg(jsonb_build_object('theme', t.theme, 'corr', t.corr))
                    from (select t2.theme, t2.corr from public.etf_tilt t2
                          where t2.symbol = f.symbol and t2.rk <= 6 order by t2.rk) t
                  ), '[]'::jsonb))
             order by f.excess desc nulls last)
      from public.active_etf_perf() f), '[]'::jsonb),
    'crowd', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.top_own desc nulls last)
      from public.theme_etf() c), '[]'::jsonb)
  );
$fn$;

grant execute on function public.etf_board() to anon, authenticated;
