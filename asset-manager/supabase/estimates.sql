-- ============================================================
-- 自動抓取分析師預估 EPS
--
-- 為什麼要自己解析：台灣沒有免費的共識預估 API，但 stockanalysis.com 的
-- 個股預估頁是 SvelteKit 做的，它的 __data.json 端點會回傳整頁資料，
-- 而且上市（tpe）與上櫃（tpex）都有。**當年度與次年度是免費的，
-- 再往後一年被鎖在 [PRO] 後面**，所以 2028 仍然只能靠人工整理。
--
-- 資料格式是 devalue 的索引壓縮：pool 是一個扁平陣列，
-- 物件裡每個「值」都是指向 pool 的索引而不是字面值。所以不能直接讀，
-- 要照著索引鏈走：estimates → stats → annual → epsThis → this → 數字。
-- 好消息是整個 pool 裡同時具有 stats 與 table 兩個 key 的元素只有一個，
-- 定位是唯一的，不會抓錯。
--
-- 注意：這裡拿到的是「某一個分析師樣本的共識」，跟 FactSet 的樣本不一樣。
-- 實測聯茂 2026 年 stockanalysis 給 15.0、FactSet 給 8.5，差了將近一倍。
-- 兩個都是真的，只是統計的人不同。所以來源一定要寫出來。
-- ============================================================

create table if not exists public.eps_estimate (
  symbol     text not null,
  fy         smallint not null,
  eps        numeric,
  analysts   smallint,
  src        text not null default 'stockanalysis.com',
  fetched_on date,
  updated_at timestamptz not null default now(),
  primary key (symbol, fy)
);
alter table public.eps_estimate enable row level security;
drop policy if exists "read eps estimate" on public.eps_estimate;
create policy "read eps estimate" on public.eps_estimate for select to authenticated using (true);

-- 抓取狀態。covered=false 代表「查過了，但沒有任何分析師在報這檔」，
-- 這跟「還沒查」是兩回事，畫面上要分得出來。
create table if not exists public.eps_fetch_log (
  symbol     text primary key,
  ok         boolean,
  covered    boolean,
  msg        text,
  fetched_at timestamptz not null default now()
);
alter table public.eps_fetch_log enable row level security;
drop policy if exists "read eps fetch log" on public.eps_fetch_log;
create policy "read eps fetch log" on public.eps_fetch_log for select to authenticated using (true);

-- ------------------------------------------------------------
-- 解析 devalue 索引壓縮格式
--   回傳 (會計年度, 預估 EPS, 分析師人數)，最多兩列（當年度與次年度）。
--   查不到預估就回 0 列。
-- ------------------------------------------------------------
create or replace function public.pm_sa_parse(p_body text)
returns table (fy smallint, eps numeric, analysts smallint)
language plpgsql immutable as $fn$
declare
  doc jsonb; node jsonb; pool jsonb; est jsonb; o jsonb;
  i integer; n integer; k integer;
  ann integer; tann integer;
  fy_arr jsonb; eps_arr jsonb; an_arr jsonb;
  eps_this numeric; eps_next numeric;
  fy_this integer; an_this integer;
  idx integer;
begin
  doc := p_body::jsonb;
  if jsonb_typeof(doc -> 'nodes') <> 'array' then return; end if;

  for node in select * from jsonb_array_elements(doc -> 'nodes') loop
    if jsonb_typeof(node) <> 'object' or node ->> 'type' <> 'data' then continue; end if;
    pool := node -> 'data';
    if jsonb_typeof(pool) <> 'array' then continue; end if;

    -- 整個 pool 裡同時有 stats 與 table 的元素只會有一個，就是 estimates
    est := null;
    n := jsonb_array_length(pool);
    for i in 0 .. n - 1 loop
      o := pool -> i;
      if jsonb_typeof(o) = 'object' and o ? 'stats' and o ? 'table' then est := o; exit; end if;
    end loop;
    if est is null then continue; end if;

    -- stats → annual → epsThis / epsNext → this
    ann := ((pool -> (est ->> 'stats')::int) ->> 'annual')::int;
    o := pool -> ((pool -> ann) ->> 'epsThis')::int;
    idx := (o ->> 'this')::int;
    if jsonb_typeof(pool -> idx) = 'number' then eps_this := (pool ->> idx)::numeric; end if;

    o := pool -> ((pool -> ann) ->> 'epsNext')::int;
    idx := (o ->> 'this')::int;
    if jsonb_typeof(pool -> idx) = 'number' then eps_next := (pool ->> idx)::numeric; end if;

    -- table → annual：判斷 epsThis 指的是哪一年。
    --
    -- **這裡踩過坑**：原本用「最後一個 eps 還是數字的年度」，結果錯一年。
    -- 因為當年度的 eps 欄位可能是 null（華新、上詮、聖暉、融程電都是），
    -- 於是抓到前一年的「實際值」當成預估年度，整組年度往前位移。
    -- 正確規則是「最後一個不是 [PRO] 的年度」——[PRO] 是付費牆標記，
    -- 它之前的最後一格必然就是當年度。
    tann := ((pool -> (est ->> 'table')::int) ->> 'annual')::int;
    fy_arr  := pool -> ((pool -> tann) ->> 'fiscalYear')::int;
    eps_arr := pool -> ((pool -> tann) ->> 'eps')::int;
    an_arr  := pool -> ((pool -> tann) ->> 'analysts')::int;
    if jsonb_typeof(fy_arr) = 'array' and jsonb_typeof(eps_arr) = 'array' then
      for k in 0 .. jsonb_array_length(fy_arr) - 1 loop
        if (pool ->> (eps_arr ->> k)::int) is distinct from '[PRO]' then
          fy_this := (pool ->> (fy_arr ->> k)::int)::numeric::int;
          if jsonb_typeof(an_arr) = 'array'
             and jsonb_typeof(pool -> (an_arr ->> k)::int) = 'number' then
            an_this := (pool ->> (an_arr ->> k)::int)::numeric::int;
          else
            an_this := null;
          end if;
        end if;
      end loop;
    end if;

    -- 沒有分析師人數就代表沒有人在報，那不是預估。
    if fy_this is null or an_this is null then return; end if;
    -- 年度必須合理。對不上就寧可不要，位移一年的預估比沒有預估更糟。
    if fy_this < extract(year from current_date)::int - 1
       or fy_this > extract(year from current_date)::int + 1 then return; end if;

    if eps_this is not null then
      fy := fy_this::smallint; eps := eps_this; analysts := an_this::smallint; return next;
    end if;
    if eps_next is not null then
      fy := (fy_this + 1)::smallint; eps := eps_next; analysts := null; return next;
    end if;
    return;
  end loop;
  return;
exception when others then
  return;
end $fn$;

-- ------------------------------------------------------------
-- 抓取預估
--   p_limit 控制一次抓幾檔，因為 authenticated 有 8 秒上限。
--   每檔約 0.5 秒，排程可以一次抓完，手動更新則分批抓最久沒更新的。
--   預估值變動是季度級的，不需要每天全抓。
-- ------------------------------------------------------------
create or replace function public.refresh_estimates(p_limit integer default 400)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; board text; got integer; total integer := 0;
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
    left join public.eps_fetch_log l on l.symbol = s.symbol
    where s.symbol ~ '^[0-9]{4,6}[A-Z]?$'
    order by l.fetched_at nulls first
    limit p_limit
  loop
    board := case when r.src = 'tpex' then 'tpex' else 'tpe' end;
    begin
      body := public.pm_fetch('https://stockanalysis.com/quote/' || board || '/'
                              || lower(r.symbol) || '/forecast/__data.json');
      insert into public.eps_estimate (symbol, fy, eps, analysts, fetched_on, updated_at)
      select r.symbol, p.fy, p.eps, p.analysts, current_date, now()
      from public.pm_sa_parse(body) p
      where p.eps is not null and p.fy between 2000 and 2100
      on conflict (symbol, fy) do update
        set eps = excluded.eps, analysts = excluded.analysts,
            fetched_on = excluded.fetched_on, updated_at = now();
      get diagnostics got = row_count;
      total := total + got;

      insert into public.eps_fetch_log (symbol, ok, covered, msg, fetched_at)
      values (r.symbol, true, got > 0, null, now())
      on conflict (symbol) do update
        set ok = true, covered = excluded.covered, msg = null, fetched_at = now();
    exception when others then
      insert into public.eps_fetch_log (symbol, ok, covered, msg, fetched_at)
      values (r.symbol, false, null, sqlerrm, now())
      on conflict (symbol) do update
        set ok = false, msg = excluded.msg, fetched_at = now();
    end;
  end loop;

  perform public.pm_log('estimates', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_estimates(integer) from public, anon;
