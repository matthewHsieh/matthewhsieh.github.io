-- ============================================================
-- 主動型 ETF
--
-- 2025 年起台灣開始有主動型 ETF，代號一律以 A 結尾（00980A 起、00400A 起）。
-- 目前 33 檔，其中約 21 檔是台股。
--
-- **能拿到什麼、拿不到什麼，要先講清楚。**
--
-- 拿得到（證交所的 ETF 商品資訊，一個 JSON 端點）：
--   名冊、發行人、上市日期、標的指數、主動或被動
-- 再接上既有的 Yahoo 日線管線（refresh_risk_stats），就有：
--   報酬、波動、報酬/波動、距高低點 —— 也就是**這些主動經理人到底有沒有打贏大盤**
--
-- 拿不到：**每日持股**。查過證交所 OpenAPI 與 rwd 端點、櫃買 OpenAPI、
-- 集保基金資訊觀測站（fundclear）、投信投顧公會、MoneyDJ，**沒有任何集中來源**。
-- 各家投信各自在自己網站公布申購買回清單，而且都是伺服器端算好的 HTML、
-- 每家結構不同，國泰那個網域還整站擋自動存取（Akamai Access Denied）。
-- 要做就是十三家各寫一支解析器，而且其中一家做不到。
-- ============================================================

create table if not exists public.active_etf (
  symbol     text primary key,
  name       text,
  issuer     text,
  listed_on  date,
  benchmark  text,
  scope      text,          -- tw / us / global，從名稱判斷
  as_of      date,
  updated_at timestamptz not null default now()
);
alter table public.active_etf enable row level security;
drop policy if exists "read active etf" on public.active_etf;
create policy "read active etf" on public.active_etf for select to authenticated using (true);
drop policy if exists "public read active etf" on public.active_etf;
create policy "public read active etf" on public.active_etf for select to anon using (true);
grant select on public.active_etf to anon, authenticated;

create or replace function public.refresh_active_etf()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare payload jsonb; n integer := 0;
begin
  perform set_config('statement_timeout', '120s', true);
  payload := public.pm_fetch('https://www.twse.com.tw/rwd/zh/ETF/list?response=json')::jsonb;
  if payload ->> 'stat' <> 'OK' then
    perform public.pm_log('active_etf', 0, false, 'stat not OK');
    return 0;
  end if;

  insert into public.active_etf (symbol, name, issuer, listed_on, benchmark, scope, as_of, updated_at)
  select upper(btrim(r ->> 1)), btrim(r ->> 2), btrim(r ->> 3),
         to_date(replace(r ->> 0, '.', ''), 'YYYYMMDD'),
         nullif(btrim(r ->> 4), ''),
         -- 從名稱猜範圍。主動型 ETF 的命名很一致：主動＋投信＋市場＋策略
         case when (r ->> 2) ~ '台股|臺灣|台灣' then 'tw'
              when (r ->> 2) ~ '美國|美股|ARK|S&P|那斯達克' then 'us'
              else 'global' end,
         current_date, now()
  from jsonb_array_elements(payload -> 'data') r
  -- A 結尾＝主動型。這是主管機關的編碼規則，不是猜的。
  where btrim(r ->> 1) ~ '^00[0-9]{3}A$'
  on conflict (symbol) do update
    set name = excluded.name, issuer = excluded.issuer,
        listed_on = excluded.listed_on, benchmark = excluded.benchmark,
        scope = excluded.scope, as_of = excluded.as_of, updated_at = now();
  get diagnostics n = row_count;

  -- **證交所那份只有上市的。** 上櫃的主動型 ETF（例如 00411A 主動統一前沿科技）
  -- 不在裡面，但行情表裡有——那是每天抓收盤時從櫃買一起帶回來的。
  -- 補進來時只有代號與名稱，發行人與標的指數留空。
  insert into public.active_etf (symbol, name, scope, as_of, updated_at)
  select m.symbol, m.name,
         case when m.name ~ '台股|臺灣|台灣' then 'tw'
              when m.name ~ '美國|美股|ARK|S&P|那斯達克' then 'us'
              else 'global' end,
         current_date, now()
  from public.market_prices m
  where m.market = 'tw' and m.symbol ~ '^00[0-9]{3}A$'
  on conflict (symbol) do update
    set name = coalesce(active_etf.name, excluded.name),
        scope = coalesce(active_etf.scope, excluded.scope),
        updated_at = now();

  perform public.pm_log('active_etf', n, true, null);
  return (select count(*)::int from public.active_etf);
exception when others then
  perform public.pm_log('active_etf', 0, false, sqlerrm);
  return 0;
end $fn$;

revoke all on function public.refresh_active_etf() from public, anon;

-- 成績與族群押注在 etf_perf.sql 與 etf_tilt.sql。
-- 這裡只管名冊：誰是主動型、誰發的、什麼時候掛牌。
drop function if exists public.active_etf_board();
