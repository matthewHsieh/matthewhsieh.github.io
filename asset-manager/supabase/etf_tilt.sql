-- ============================================================
-- 主動型 ETF 押在哪些產業（推估）
--
-- **先講清楚這不是持股。**
-- 每日持股（申購買回清單）沒有任何集中來源——證交所 OpenAPI 與 rwd、
-- 櫃買 OpenAPI、集保 fundclear、投信投顧公會、MoneyDJ 都查過，
-- 各家投信只在自己網站公布，格式各不相同，國泰那個網域還整站擋自動存取。
--
-- 但是「押在哪些產業」這件事，**不用持股也算得出來**。
-- 這是 Sharpe 的報酬式風格分析：一檔基金重押哪個族群，
-- 它的日報酬就會跟那個族群一起動。做法是
--
--   基金的超額報酬（基金 − 0050）  對上  族群的超額報酬（族群 − 0050）
--
-- 兩邊都先扣掉大盤，否則所有東西都跟所有東西相關 0.8 以上
-- （台股的共同因子太強），算出來每檔基金的前幾名族群會一模一樣。
-- 扣掉之後留下的才是「這檔基金跟大盤不一樣的地方」。
--
-- 侷限，用的時候要記得：
--   * 這是**相關性不是權重**。說「它跟 CCL 一起動」不等於「它持有 CCL 40%」。
--   * 族群報酬用等權重，但基金是市值或自由配置，兩者本來就不會完全對齊。
--   * 只對台股基金有意義。美股／全球基金的對照族群我們沒有建。
--   * 樣本最短的只有 24 個交易日，天數少的那幾檔看看就好。
-- ============================================================

-- ------------------------------------------------------------
-- 日線歷史
--
-- price_history 那張表只有 9 個日期（它是拿來做區間比較的快照），
-- 做不了相關性，所以另外存一份真正的日線。
-- ------------------------------------------------------------
create table if not exists public.px_daily (
  symbol text not null,
  d      date not null,
  adj    numeric not null,
  primary key (symbol, d)
);
create index if not exists px_daily_d on public.px_daily (d);

-- 上市是 .TW、上櫃是 .TWO。第一次要試兩次，試出來就記住，
-- 之後每次更新都省一半的請求。
create table if not exists public.px_src (
  symbol     text primary key,
  yf         text,                  -- 實際可用的 Yahoo 代號
  last_ok    date,
  fail_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.px_daily enable row level security;
alter table public.px_src  enable row level security;
drop policy if exists "read px daily" on public.px_daily;
create policy "read px daily" on public.px_daily for select to authenticated using (true);
drop policy if exists "read px src" on public.px_src;
create policy "read px src" on public.px_src for select to authenticated using (true);
grant select on public.px_daily, public.px_src to authenticated;

-- 要抓哪些代號：族群成員 ＋ 對照組 ＋ 主動型 ETF 自己
create or replace function public.px_wanted()
returns table (symbol text)
language sql stable set search_path = public as $fn$
  select distinct t.symbol from public.themes t
  union select unnest(array['0050', '00662', '00646'])
  union select e.symbol from public.active_etf e;
$fn$;

-- 一次只做一批。全部 250 檔一次抓會撞到 statement_timeout，
-- 而且一旦逾時整個交易回滾，連已經抓好的都沒了。
create or replace function public.refresh_px_daily(p_limit integer default 60)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; n integer := 0; got integer; v_yf text;
begin
  perform set_config('statement_timeout', '600s', true);

  insert into public.px_src (symbol)
  select w.symbol from public.px_wanted() w
  on conflict (symbol) do nothing;

  for r in
    select s.symbol, s.yf from public.px_src s
    join public.px_wanted() w on w.symbol = s.symbol
    where s.fail_count < 5
    -- 沒抓過的排前面，再來是最久沒更新的
    order by s.last_ok nulls first, s.updated_at
    limit p_limit
  loop
    begin
      got := 0;
      -- 記得住的就直接用；記不住的先試 .TW 再試 .TWO
      foreach v_yf in array (case when r.yf is not null then array[r.yf]
                                else array[r.symbol || '.TW', r.symbol || '.TWO'] end)
      loop
        body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                                || v_yf || '?interval=1d&range=2y');
        insert into public.px_daily (symbol, d, adj)
        select r.symbol, d, adj from public.pm_yahoo_series(body)
        on conflict (symbol, d) do update set adj = excluded.adj;
        get diagnostics got = row_count;
        if got > 0 then
          update public.px_src set yf = v_yf, last_ok = current_date,
                 fail_count = 0, updated_at = now()
          where symbol = r.symbol;
          n := n + 1;
          exit;
        end if;
      end loop;
      if got = 0 then
        update public.px_src set fail_count = fail_count + 1, updated_at = now()
        where symbol = r.symbol;
      end if;
    exception when others then
      update public.px_src set fail_count = fail_count + 1, updated_at = now()
      where symbol = r.symbol;
      perform public.pm_log('px_daily ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('px_daily', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_px_daily(integer) from public, anon;

-- ------------------------------------------------------------
-- 族群傾向
-- ------------------------------------------------------------
create table if not exists public.etf_tilt (
  symbol     text not null,
  theme      text not null,
  corr       numeric,       -- 扣掉大盤之後的相關係數
  members    integer,       -- 這個族群有幾檔有日線資料
  days       integer,       -- 重疊的交易日數
  rk         integer,       -- 這檔基金裡的名次
  updated_at timestamptz not null default now(),
  primary key (symbol, theme)
);
alter table public.etf_tilt enable row level security;
drop policy if exists "read etf tilt" on public.etf_tilt;
create policy "read etf tilt" on public.etf_tilt for select to authenticated using (true);
drop policy if exists "public read etf tilt" on public.etf_tilt;
create policy "public read etf tilt" on public.etf_tilt for select to anon using (true);
grant select on public.etf_tilt to anon, authenticated;

create or replace function public.refresh_etf_tilt()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare n integer;
begin
  perform set_config('statement_timeout', '600s', true);

  create temp table _r on commit drop as
  select symbol, d, adj / lag(adj) over (partition by symbol order by d) - 1 as r
  from public.px_daily;
  delete from _r where r is null;
  create index on _r (symbol, d);
  create index on _r (d);

  -- 大盤＝0050。每天一個數字，等一下兩邊都要扣掉它。
  create temp table _m on commit drop as select d, r from _r where symbol = '0050';
  create index on _m (d);

  -- 族群日報酬＝成員等權重平均
  create temp table _t on commit drop as
  select th.theme, x.d, avg(x.r) as r, count(*)::int as members
  from public.themes th join _r x on x.symbol = th.symbol
  group by th.theme, x.d;
  create index on _t (theme, d);

  delete from public.etf_tilt where true;

  insert into public.etf_tilt (symbol, theme, corr, members, days, rk, updated_at)
  select symbol, theme, c, members, days,
         row_number() over (partition by symbol order by c desc nulls last)::int,
         now()
  from (
    select f.symbol, t.theme,
           round(corr(f.r - m.r, t.r - m.r)::numeric, 3) as c,
           round(avg(t.members))::int as members,
           count(*)::int as days
    from _r f
    join _m m on m.d = f.d
    join _t t on t.d = f.d
    -- 只算台股基金。美股／全球基金拿台股族群去比是沒有意義的。
    join public.etf_perf p on p.symbol = f.symbol and p.bench = '0050'
    group by f.symbol, t.theme
    -- 30 天以下的相關係數雜訊大於訊號
    having count(*) >= 30
  ) s;
  get diagnostics n = row_count;

  perform public.pm_log('etf_tilt', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_etf_tilt() from public, anon;

-- ------------------------------------------------------------
-- 給畫面用：一次回一包
--
-- 基金 30 檔、每檔 6 個族群、擁擠度 35 列，全部加起來兩百多列。
-- 分開叫三次 RPC 沒有比較清楚，而且 PostgREST 預設 1000 列上限
-- 踩過一次了，包成一個 jsonb 最穩。
-- ------------------------------------------------------------
drop function if exists public.etf_tilts(text, integer);
drop function if exists public.theme_crowding(numeric);

create or replace function public.etf_board()
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'as_of', (select max(last_day) from public.etf_perf),
    'funds', coalesce((
      select jsonb_agg(to_jsonb(f) || jsonb_build_object('tilts', coalesce((
               select jsonb_agg(jsonb_build_object('theme', t.theme, 'corr', t.corr))
               from (select t2.theme, t2.corr from public.etf_tilt t2
                     where t2.symbol = f.symbol and t2.rk <= 6 order by t2.rk) t
             ), '[]'::jsonb))
             order by f.excess desc nulls last)
      from public.active_etf_perf() f), '[]'::jsonb),
    'crowd', coalesce((
      select jsonb_agg(jsonb_build_object('theme', c.theme, 'top5', c.top5,
                                          'top10', c.top10, 'corr', c.ac)
             order by c.top5 desc, c.top10 desc, c.ac desc)
      from (select t.theme,
                   count(*) filter (where t.rk <= 5)::int as top5,
                   count(*) filter (where t.rk <= 10)::int as top10,
                   round(avg(t.corr) filter (where t.rk <= 10), 3) as ac
            from public.etf_tilt t group by t.theme
            having count(*) filter (where t.rk <= 10) > 0) c), '[]'::jsonb),
    'rated', (select count(distinct symbol)::int from public.etf_tilt)
  );
$fn$;

grant execute on function public.etf_board() to anon, authenticated;
