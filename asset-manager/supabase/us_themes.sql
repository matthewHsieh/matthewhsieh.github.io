-- ============================================================
-- 美股 AI 產業地圖
--
-- 跟台股那一頁的差別：**訊號方向相反，而且更好。**
-- 台股用的是每月營收公告，那是「已經發生」的落後指標。
-- 美股沒有月營收，但 stockanalysis 的預估頁同時給「本年度與次年度的營收預估」，
-- 那是前瞻指標。把族群成分股的營收預估加總再比，就是這個產業被預期要長多快。
--
-- 資料來源與台股同一套：
--   stockanalysis.com/stocks/<sym>/forecast/__data.json  營收與 EPS 預估、分析師人數
--   query1.finance.yahoo.com/v8/finance/chart/<sym>      三年日線 → 報酬/波動、現價
-- 一樣是 devalue 索引壓縮格式，一樣只有當年度與次年度免費。
--
-- 注意：美股各公司會計年度不一致（NVDA 的 FY2027 其實是 2026 曆年），
-- 所以欄位存的是「本年度」與「次年度」而不是寫死的年份。
-- ============================================================

create table if not exists public.us_themes (
  theme  text not null,
  symbol text not null,
  name   text,
  sort   smallint not null default 0,
  primary key (theme, symbol)
);
alter table public.us_themes enable row level security;
drop policy if exists "read us themes" on public.us_themes;
create policy "read us themes" on public.us_themes for select to authenticated using (true);

create table if not exists public.us_stats (
  symbol      text primary key,
  fy          smallint,     -- 本年度的會計年度標籤
  analysts    smallint,
  rev_this    numeric,      -- 本年度營收預估（美元）
  rev_next    numeric,
  rev_g       numeric,      -- 本年度營收年增
  rev_g_next  numeric,      -- 次年度營收年增
  eps_this    numeric,
  eps_next    numeric,
  eps_g       numeric,
  price       numeric,
  pe_this     numeric,      -- 現價 ÷ 本年度預估 EPS
  pe_next     numeric,
  vol         numeric,      -- 三年年化波動
  cagr        numeric,      -- 三年年化報酬
  ratio       numeric,      -- cagr / vol
  mdd         numeric,
  days        integer,     -- 三年窗實際有幾個交易日，未滿兩年就不給比值
  as_of       date,
  updated_at  timestamptz not null default now()
);
-- create table if not exists 不會幫既有的表加欄位，新欄位一律用 alter
alter table public.us_stats add column if not exists days integer;
-- 價格區間，跟台股的 risk_stats 同一套定義（見 risk_stats.sql）
alter table public.us_stats add column if not exists hi52 numeric;
alter table public.us_stats add column if not exists lo52 numeric;
alter table public.us_stats add column if not exists hi3y numeric;
alter table public.us_stats add column if not exists lo3y numeric;

alter table public.us_stats enable row level security;
drop policy if exists "read us stats" on public.us_stats;
create policy "read us stats" on public.us_stats for select to authenticated using (true);

-- ------------------------------------------------------------
-- 解析 stockanalysis 的預估頁（比台股那支多回傳營收）
-- ------------------------------------------------------------
create or replace function public.pm_sa_full(p_body text)
returns table (fy smallint, analysts smallint,
               eps_this numeric, eps_next numeric, eps_g numeric,
               rev_this numeric, rev_next numeric, rev_g numeric, rev_g_next numeric)
language plpgsql immutable as $fn$
declare
  doc jsonb; node jsonb; pool jsonb; est jsonb; o jsonb;
  i integer; k integer; ann integer; tann integer;
  fy_arr jsonb; eps_arr jsonb; an_arr jsonb;
  fy_this integer; an_this integer;
begin
  doc := p_body::jsonb;
  if jsonb_typeof(doc -> 'nodes') <> 'array' then return; end if;

  for node in select * from jsonb_array_elements(doc -> 'nodes') loop
    if jsonb_typeof(node) <> 'object' or node ->> 'type' <> 'data' then continue; end if;
    pool := node -> 'data';
    if jsonb_typeof(pool) <> 'array' then continue; end if;
    est := null;
    for i in 0 .. jsonb_array_length(pool) - 1 loop
      o := pool -> i;
      if jsonb_typeof(o) = 'object' and o ? 'stats' and o ? 'table' then est := o; exit; end if;
    end loop;
    if est is null then continue; end if;

    ann := ((pool -> (est ->> 'stats')::int) ->> 'annual')::int;
    tann := ((pool -> (est ->> 'table')::int) ->> 'annual')::int;
    fy_arr  := pool -> ((pool -> tann) ->> 'fiscalYear')::int;
    eps_arr := pool -> ((pool -> tann) ->> 'eps')::int;
    an_arr  := pool -> ((pool -> tann) ->> 'analysts')::int;

    -- 當年度＝最後一個不是 [PRO] 的年份。不能用「最後一個是數字的」，
    -- 有些公司當年度那格是 null，會讓整組年份往前位移一年。
    if jsonb_typeof(fy_arr) = 'array' and jsonb_typeof(eps_arr) = 'array' then
      for k in 0 .. jsonb_array_length(fy_arr) - 1 loop
        if (pool ->> (eps_arr ->> k)::int) is distinct from '[PRO]' then
          fy_this := (pool ->> (fy_arr ->> k)::int)::numeric::int;
          an_this := case when jsonb_typeof(an_arr) = 'array'
                           and jsonb_typeof(pool -> (an_arr ->> k)::int) = 'number'
                          then (pool ->> (an_arr ->> k)::int)::numeric::int end;
        end if;
      end loop;
    end if;
    if fy_this is null then return; end if;

    fy := fy_this::smallint;
    analysts := an_this::smallint;

    o := pool -> ((pool -> ann) ->> 'epsThis')::int;
    if jsonb_typeof(pool -> (o ->> 'this')::int) = 'number' then
      eps_this := (pool ->> (o ->> 'this')::int)::numeric;
    end if;
    if jsonb_typeof(pool -> (o ->> 'growth')::int) = 'number' then
      eps_g := round(((pool ->> (o ->> 'growth')::int)::numeric) / 100, 4);
    end if;
    o := pool -> ((pool -> ann) ->> 'epsNext')::int;
    if jsonb_typeof(pool -> (o ->> 'this')::int) = 'number' then
      eps_next := (pool ->> (o ->> 'this')::int)::numeric;
    end if;

    o := pool -> ((pool -> ann) ->> 'revenueThis')::int;
    if jsonb_typeof(pool -> (o ->> 'this')::int) = 'number' then
      rev_this := (pool ->> (o ->> 'this')::int)::numeric;
    end if;
    if jsonb_typeof(pool -> (o ->> 'growth')::int) = 'number' then
      rev_g := round(((pool ->> (o ->> 'growth')::int)::numeric) / 100, 4);
    end if;
    o := pool -> ((pool -> ann) ->> 'revenueNext')::int;
    if jsonb_typeof(pool -> (o ->> 'this')::int) = 'number' then
      rev_next := (pool ->> (o ->> 'this')::int)::numeric;
    end if;
    if jsonb_typeof(pool -> (o ->> 'growth')::int) = 'number' then
      rev_g_next := round(((pool ->> (o ->> 'growth')::int)::numeric) / 100, 4);
    end if;

    return next;
    return;
  end loop;
  return;
exception when others then
  return;
end $fn$;

-- Yahoo chart 的最後一筆收盤，用來算預估本益比
create or replace function public.pm_yahoo_last(p_body text)
returns numeric language plpgsql immutable as $fn$
declare arr jsonb; e jsonb; last_p numeric := null;
begin
  arr := (p_body::jsonb) -> 'chart' -> 'result' -> 0 -> 'indicators' -> 'quote' -> 0 -> 'close';
  if jsonb_typeof(arr) <> 'array' then return null; end if;
  for e in select * from jsonb_array_elements(arr) loop
    if jsonb_typeof(e) = 'number' then last_p := e::text::numeric; end if;
  end loop;
  return last_p;
exception when others then
  return null;
end $fn$;

-- ------------------------------------------------------------
-- 抓取。每檔兩個請求（預估 + 三年日線），70 檔約 70 秒。
-- ------------------------------------------------------------
create or replace function public.refresh_us_stats(p_limit integer default 200)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; b1 text; b2 text; total integer := 0; got integer;
begin
  perform set_config('statement_timeout', '900s', true);
  for r in
    select s.symbol from (
      select symbol from public.us_themes
      union select upper(btrim(symbol)) from public.us_stocks
    ) s
    left join public.us_stats k on k.symbol = s.symbol
    where s.symbol ~ '^[A-Z.]{1,6}$'
    order by k.updated_at nulls first
    limit p_limit
  loop
    begin
      b1 := public.pm_fetch('https://stockanalysis.com/stocks/' || lower(r.symbol)
                            || '/forecast/__data.json');
      b2 := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                            || r.symbol || '?interval=1d&range=3y');
      insert into public.us_stats (symbol, fy, analysts, rev_this, rev_next, rev_g, rev_g_next,
                                   eps_this, eps_next, eps_g, price, pe_this, pe_next,
                                   vol, cagr, ratio, mdd, days,
                                   hi52, lo52, hi3y, lo3y, as_of, updated_at)
      select r.symbol, f.fy, f.analysts, f.rev_this, f.rev_next, f.rev_g, f.rev_g_next,
             f.eps_this, f.eps_next, f.eps_g,
             public.pm_yahoo_last(b2),
             case when f.eps_this > 0 then round(public.pm_yahoo_last(b2) / f.eps_this, 1) end,
             case when f.eps_next > 0 then round(public.pm_yahoo_last(b2) / f.eps_next, 1) end,
             c.vol, c.cagr, c.ratio, c.mdd, c.days,
             c.hi52, c.lo52, c.hi3y, c.lo3y, current_date, now()
      from public.pm_sa_full(b1) f
      left join lateral public.pm_risk_calc(b2) c on true
      on conflict (symbol) do update
        set fy = excluded.fy, analysts = excluded.analysts,
            rev_this = excluded.rev_this, rev_next = excluded.rev_next,
            rev_g = excluded.rev_g, rev_g_next = excluded.rev_g_next,
            eps_this = excluded.eps_this, eps_next = excluded.eps_next, eps_g = excluded.eps_g,
            price = excluded.price, pe_this = excluded.pe_this, pe_next = excluded.pe_next,
            vol = excluded.vol, cagr = excluded.cagr, ratio = excluded.ratio, mdd = excluded.mdd,
            days = excluded.days,
            hi52 = excluded.hi52, lo52 = excluded.lo52,
            hi3y = excluded.hi3y, lo3y = excluded.lo3y,
            as_of = excluded.as_of, updated_at = now();
      get diagnostics got = row_count;
      total := total + got;
      if got = 0 then
        -- 查過但沒有預估，也要留下時間戳，否則會一直重抓同一檔
        insert into public.us_stats (symbol, as_of, updated_at)
        values (r.symbol, current_date, now())
        on conflict (symbol) do update set updated_at = now();
      end if;
    exception when others then
      perform public.pm_log('us_stats ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  -- 那斯達克 100 當基準線，用來判斷個股的報酬/波動算好還是壞
  begin
    b2 := public.pm_fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1d&range=3y');
    insert into public.us_stats (symbol, price, vol, cagr, ratio, mdd, days,
                                hi52, lo52, hi3y, lo3y, as_of, updated_at)
    select 'NDX', public.pm_yahoo_last(b2), c.vol, c.cagr, c.ratio, c.mdd, c.days,
           c.hi52, c.lo52, c.hi3y, c.lo3y, current_date, now()
    from public.pm_risk_calc(b2) c
    on conflict (symbol) do update
      set price = excluded.price, vol = excluded.vol, cagr = excluded.cagr,
          ratio = excluded.ratio, mdd = excluded.mdd, days = excluded.days,
          hi52 = excluded.hi52, lo52 = excluded.lo52,
          hi3y = excluded.hi3y, lo3y = excluded.lo3y,
          as_of = excluded.as_of, updated_at = now();
  exception when others then
    perform public.pm_log('us_stats NDX', 0, false, sqlerrm);
  end;

  perform public.pm_log('us_stats', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_us_stats(integer) from public, anon;

-- ------------------------------------------------------------
-- 族群層級：把成分股的營收預估加總，得出整個產業被預期要長多快
--   這跟台股那頁的差別是**前瞻**而不是落後。
-- ------------------------------------------------------------
create or replace function public.us_theme_trend()
returns table (theme text, members integer, covered integer,
               rev_this numeric, rev_next numeric,
               growth numeric, growth_next numeric,
               pe_median numeric, pe_next_median numeric,
               ratio_median numeric, vol_median numeric, beat_idx integer)
language sql stable security definer set search_path = public as $fn$
  select t.theme,
         count(*)::int,
         count(s.rev_this)::int,
         sum(s.rev_this), sum(s.rev_next),
         -- 用加總後的營收算年增，等於以營收規模加權，大公司自然佔比較重
         case when sum(s.rev_this / nullif(1 + s.rev_g, 0)) > 0
              then round(sum(s.rev_this) / sum(s.rev_this / nullif(1 + s.rev_g, 0)) - 1, 4) end,
         case when sum(s.rev_this) > 0
              then round(sum(s.rev_next) / sum(s.rev_this) - 1, 4) end,
         round(percentile_cont(0.5) within group (order by s.pe_this)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.pe_next)::numeric, 1),
         round(percentile_cont(0.5) within group (order by s.ratio)::numeric, 2),
         round(percentile_cont(0.5) within group (order by s.vol)::numeric, 3),
         count(*) filter (where s.ratio > (select ratio from public.us_stats
                                           where symbol = 'NDX'))::int
  from public.us_themes t
  left join public.us_stats s on s.symbol = t.symbol
  group by t.theme
  order by t.theme;
$fn$;

create or replace function public.us_theme_members()
returns table (theme text, symbol text, name text, fy smallint, analysts smallint,
               rev_this numeric, rev_g numeric, rev_g_next numeric,
               pe_this numeric, pe_next numeric, price numeric,
               ratio numeric, vol numeric, cagr numeric, days integer)
language sql stable security definer set search_path = public as $fn$
  select t.theme, t.symbol, t.name, s.fy, s.analysts,
         s.rev_this, s.rev_g, s.rev_g_next, s.pe_this, s.pe_next, s.price,
         s.ratio, s.vol, s.cagr, s.days
  from public.us_themes t
  left join public.us_stats s on s.symbol = t.symbol
  order by t.theme, t.sort, coalesce(s.rev_this, 0) desc;
$fn$;

grant execute on function public.us_theme_trend()   to authenticated;
grant execute on function public.us_theme_members() to authenticated;
