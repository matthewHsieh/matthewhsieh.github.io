-- ============================================================
-- 風險調整後的選股計分：報酬 ÷ 波動
--
-- 為什麼要有這個欄位：
-- 「這檔漲很多」是最容易騙人的說法。實測 2022-2026，金居買進持有 7.79 倍，
-- 但它的年化波動 52.4%，在風險等價的前提下只能開 0.81 倍槓桿，
-- 套上同一條交易規則後只有 4.03 倍，**反而輸給加權指數的 7.75 倍**。
-- 台玻更明顯：年化報酬 24.2% 跟指數的 24.8% 差不多，波動卻是指數的 2.4 倍。
--
-- 所以判斷一檔值不值得買，要看「每承受一單位波動換到多少報酬」。
-- 加權指數這個比值大約 1.17。**低於它的個股，不如直接開槓桿買指數。**
-- 一檔波動 50% 的股票，年化要超過 58% 才配得上它的風險。
--
-- 資料來源：Yahoo Finance chart API，一次請求就給三年日線。
-- 上市用 <代號>.TW，上櫃用 <代號>.TWO。用 close 不要用 adjclose。
-- ============================================================

create table if not exists public.risk_stats (
  symbol      text primary key,
  vol         numeric,     -- 年化波動（三年）
  cagr        numeric,     -- 年化報酬（三年）
  ratio       numeric,     -- cagr / vol，越高越值得承受它的波動
  mdd         numeric,     -- 期間最大回撤
  vol1y       numeric,     -- 近一年波動，用來看波動是不是變了
  days        integer,
  as_of       date,
  updated_at  timestamptz not null default now()
);
-- 價格區間。**跟現價比才知道現在站在哪裡。**
-- 使用者的策略是「在下跌中買好公司」，那就需要一個「現在離高點多遠」的數字，
-- 而不是只有報酬與波動。這些值 Yahoo 的三年日線裡本來就有，順手算完不用多打一次請求。
alter table public.risk_stats add column if not exists hi52 numeric;   -- 近一年最高收盤
alter table public.risk_stats add column if not exists lo52 numeric;   -- 近一年最低收盤
alter table public.risk_stats add column if not exists hi3y numeric;   -- 三年最高收盤
alter table public.risk_stats add column if not exists lo3y numeric;   -- 三年最低收盤
alter table public.risk_stats add column if not exists last numeric;   -- 這次抓到的最後收盤（跟 hi/lo 同一份資料）
alter table public.risk_stats enable row level security;
drop policy if exists "read risk stats" on public.risk_stats;
create policy "read risk stats" on public.risk_stats for select to authenticated using (true);

-- ------------------------------------------------------------
-- 解析 Yahoo chart JSON 並算出統計量
-- ------------------------------------------------------------
drop function if exists public.pm_risk_calc(text);
create or replace function public.pm_risk_calc(p_body text)
returns table (vol numeric, cagr numeric, ratio numeric, mdd numeric,
               vol1y numeric, days integer,
               hi52 numeric, lo52 numeric, hi3y numeric, lo3y numeric, last numeric)
language plpgsql immutable as $fn$
declare
  arr jsonb; e jsonb;
  p numeric; prev numeric := null;
  n integer := 0;
  s double precision := 0; s2 double precision := 0;
  s1 double precision := 0; s21 double precision := 0; n1 integer := 0;
  first_p numeric := null; last_p numeric := null;
  peak numeric := null; dd numeric := 0; worst numeric := 0;
  h52 numeric := null; l52 numeric := null;
  h3 numeric := null; l3 numeric := null;
  total integer; idx integer := 0; cut integer;
  r double precision; sd double precision; sd1 double precision;
begin
  arr := (p_body::jsonb) -> 'chart' -> 'result' -> 0 -> 'indicators' -> 'quote' -> 0 -> 'close';
  if jsonb_typeof(arr) <> 'array' then return; end if;
  total := jsonb_array_length(arr);
  cut := greatest(total - 252, 0);          -- 近一年的起點

  for e in select * from jsonb_array_elements(arr) loop
    idx := idx + 1;
    if jsonb_typeof(e) <> 'number' then continue; end if;
    p := e::text::numeric;
    if p <= 0 then continue; end if;
    if first_p is null then first_p := p; peak := p; end if;
    last_p := p;
    if peak < p then peak := p; end if;
    if h3 is null or p > h3 then h3 := p; end if;
    if l3 is null or p < l3 then l3 := p; end if;
    if idx > cut then
      if h52 is null or p > h52 then h52 := p; end if;
      if l52 is null or p < l52 then l52 := p; end if;
    end if;
    dd := p / peak - 1;
    if dd < worst then worst := dd; end if;
    if prev is not null then
      r := ln(p / prev);
      n := n + 1; s := s + r; s2 := s2 + r * r;
      if idx > cut then
        n1 := n1 + 1; s1 := s1 + r; s21 := s21 + r * r;
      end if;
    end if;
    prev := p;
  end loop;

  if n < 200 or first_p is null or last_p is null then return; end if;

  sd := sqrt((s2 - s * s / n) / (n - 1));
  vol := round((sd * sqrt(252.0))::numeric, 4);
  -- **上市或分拆未滿兩年的，不給年化報酬與比值。**
  -- 把 1.5 年的報酬年化再標成「三年」會產生假的高分：
  -- SNDK 2025-02 才從 WDC 分拆，只有 393 個交易日，算出來比值 10.57，
  -- 拿去跟真的跑滿三年的公司比完全沒有意義。波動用 200 天估就夠，所以保留。
  if n >= 500 then
    cagr := round((power(last_p / first_p, 252.0 / n) - 1)::numeric, 4);
    ratio := case when vol > 0 then round(cagr / vol, 2) end;
  end if;
  mdd := round(worst, 4);
  if n1 > 30 then
    sd1 := sqrt((s21 - s1 * s1 / n1) / (n1 - 1));
    vol1y := round((sd1 * sqrt(252.0))::numeric, 4);
  end if;
  days := n;
  hi52 := h52; lo52 := l52; hi3y := h3; lo3y := l3; last := last_p;
  return next;
exception when others then
  return;
end $fn$;

-- ------------------------------------------------------------
-- 抓取。一檔一個請求，約 0.4 秒，170 檔約 70 秒。
-- 波動變化是月級的，不需要每天全抓，但天天跑也無妨。
-- ------------------------------------------------------------
create or replace function public.refresh_risk_stats(p_limit integer default 400)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; suffix text; total integer := 0; got integer;
begin
  perform set_config('statement_timeout', '900s', true);

  for r in
    select s.symbol, coalesce(v.src, 'twse') as src
    from (
      select symbol from public.themes
      union select upper(btrim(symbol)) from public.stocks
      union select upper(btrim(symbol)) from public.futures where kind = 'stock' and symbol is not null
      union select upper(btrim(underlying)) from public.warrants where underlying is not null
    ) s
    left join public.valuation v on v.symbol = s.symbol
    left join public.risk_stats k on k.symbol = s.symbol
    where s.symbol ~ '^[0-9]{4,6}[A-Z]?$'
    order by k.updated_at nulls first
    limit p_limit
  loop
    suffix := case when r.src = 'tpex' then '.TWO' else '.TW' end;
    begin
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || r.symbol || suffix || '?interval=1d&range=3y');
      insert into public.risk_stats (symbol, vol, cagr, ratio, mdd, vol1y, days,
                                     hi52, lo52, hi3y, lo3y, last, as_of, updated_at)
      select r.symbol, c.vol, c.cagr, c.ratio, c.mdd, c.vol1y, c.days,
             c.hi52, c.lo52, c.hi3y, c.lo3y, c.last, current_date, now()
      from public.pm_risk_calc(body) c
      on conflict (symbol) do update
        set vol = excluded.vol, cagr = excluded.cagr, ratio = excluded.ratio,
            mdd = excluded.mdd, vol1y = excluded.vol1y, days = excluded.days,
            hi52 = excluded.hi52, lo52 = excluded.lo52,
            hi3y = excluded.hi3y, lo3y = excluded.lo3y, last = excluded.last,
            as_of = excluded.as_of, updated_at = now();
      get diagnostics got = row_count;
      total := total + got;
      if got = 0 then
        -- 查過但算不出來（資料太短或代號在 Yahoo 上找不到），也要留紀錄免得一直重抓
        insert into public.risk_stats (symbol, days, as_of, updated_at)
        values (r.symbol, 0, current_date, now())
        on conflict (symbol) do update set updated_at = now();
      end if;
    exception when others then
      perform public.pm_log('risk ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  -- 加權指數當基準線，沒有它就不知道個股的比值算好還是壞
  begin
    body := public.pm_fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=3y');
    insert into public.risk_stats (symbol, vol, cagr, ratio, mdd, vol1y, days,
                                  hi52, lo52, hi3y, lo3y, last, as_of, updated_at)
    select 'TAIEX', c.vol, c.cagr, c.ratio, c.mdd, c.vol1y, c.days,
           c.hi52, c.lo52, c.hi3y, c.lo3y, c.last, current_date, now()
    from public.pm_risk_calc(body) c
    on conflict (symbol) do update
      set vol = excluded.vol, cagr = excluded.cagr, ratio = excluded.ratio,
          mdd = excluded.mdd, vol1y = excluded.vol1y, days = excluded.days,
          hi52 = excluded.hi52, lo52 = excluded.lo52,
          hi3y = excluded.hi3y, lo3y = excluded.lo3y, last = excluded.last,
          as_of = excluded.as_of, updated_at = now();
  exception when others then
    perform public.pm_log('risk TAIEX', 0, false, sqlerrm);
  end;

  perform public.pm_log('risk_stats', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_risk_stats(integer) from public, anon;
