-- ============================================================
-- 主動型 ETF：掛牌以來 vs 同期的被動替代品
--
-- **既有的 refresh_risk_stats 對這群人沒用。** 它要 500 個交易日才給年化與比值
-- （那條規則是對的，1.5 年的報酬年化成「三年」會生出假的高分），
-- 而最老的一檔主動型 ETF 也才 343 天，所以整欄都是空的。
--
-- 改算「掛牌以來報酬」，而且要注意三件事，少一件數字就會騙人：
--
-- 1. **期間必須對齊。** 2025-04-22 掛牌的跟 2026-08-11 掛牌的，
--    經歷的是完全不同的市場，比絕對報酬等於在比誰運氣好。
--
-- 2. **要用 adjclose 不要用 close。** risk_stats 那邊刻意用 close，
--    這裡刻意相反。主動型 ETF 很多有配息，除息當天價格會掉下來，
--    用 close 算等於把配出去的錢當成虧損——00984A、00999A 這種高息的
--    會被平白扣掉一大截。adjclose 還原配息與分割，才是投資人實拿的。
--
-- 3. **比較對象要是「真的買得到的替代品」，不是指數。**
--    拿台幣計價的基金去比美元計價的 NDX，超額報酬裡混進去的是匯率，
--    不是選股能力。所以對照組是 0050、00662（富邦 NASDAQ）、00646
--    （元大 S&P 500）——都在台灣掛牌、都是台幣、都是被動、都買得到。
--    這樣算出來的超額報酬才回答了真正的問題：
--    **付主動的管理費，到底有沒有比直接買被動的好？**
--
--    而且**對照組是用日報酬的相關係數挑的，不是用基金名稱**。
--    名字會騙人：00991A「主動復華未來50」、00403A「主動統一升級50」
--    名稱裡沒有「台灣」兩個字，照名字配會被丟進全球組跟 S&P 500 比，
--    但它們公開說明書上的比較指標就是臺灣加權股價報酬指數。
--
--    這個做法驗得過：32 檔裡有 7 檔在證交所資料中有填標的指數，
--    全部是臺灣加權或臺灣 50，相關係數挑出來的對照組**7 檔全部都是 0050**。
-- ============================================================

create table if not exists public.etf_perf (
  symbol      text primary key,
  first_day   date,
  last_day    date,
  days        integer,
  first_price numeric,
  last_price  numeric,
  ret         numeric,       -- 掛牌以來總報酬（含息）
  bench       text,          -- 拿哪一檔被動的來比
  bench_ret   numeric,       -- 同期該被動 ETF 的總報酬
  bench_corr  numeric,       -- 跟對照組的日報酬相關係數，用來說明為什麼挑它
  excess      numeric,       -- ret - bench_ret
  updated_at  timestamptz not null default now()
);
alter table public.etf_perf add column if not exists bench text;
alter table public.etf_perf add column if not exists bench_corr numeric;
alter table public.etf_perf enable row level security;
drop policy if exists "read etf perf" on public.etf_perf;
create policy "read etf perf" on public.etf_perf for select to authenticated using (true);
drop policy if exists "public read etf perf" on public.etf_perf;
create policy "public read etf perf" on public.etf_perf for select to anon using (true);
grant select on public.etf_perf to anon, authenticated;

-- Yahoo 的日線拆成 (日期, 收盤, 還原收盤)。
--
-- **兩個陣列一定要用 with ordinality 配對。** 先前寫成兩個 CTE 各自
-- row_number() over () 再 join，結果是笛卡兒積——343 天的基金算出 117,992 筆，
-- 而且報酬全部變成 0。SRF 在 target list 的展開時機跟 window function 不同，
-- rn 不會是想像中的 1..n。
drop function if exists public.pm_yahoo_series(text);
create or replace function public.pm_yahoo_series(p_body text)
returns table (d date, close numeric, adj numeric)
language sql immutable as $fn$
  with j as (select p_body::jsonb as b),
  t as (select x.ts, x.rn from j,
        jsonb_array_elements(b -> 'chart' -> 'result' -> 0 -> 'timestamp')
          with ordinality as x(ts, rn)),
  c as (select y.px, y.rn from j,
        jsonb_array_elements(b -> 'chart' -> 'result' -> 0
          -> 'indicators' -> 'quote' -> 0 -> 'close')
          with ordinality as y(px, rn)),
  -- 指數沒有 adjclose，這段會是空的，所以用 left join 接回去再 fallback 到 close
  a as (select z.px, z.rn from j,
        jsonb_array_elements(coalesce(b -> 'chart' -> 'result' -> 0
          -> 'indicators' -> 'adjclose' -> 0 -> 'adjclose', '[]'::jsonb))
          with ordinality as z(px, rn))
  select to_timestamp((t.ts)::text::bigint)::date,
         (c.px)::text::numeric,
         case when jsonb_typeof(a.px) = 'number' and (a.px)::text::numeric > 0
              then (a.px)::text::numeric else (c.px)::text::numeric end
  from t join c on c.rn = t.rn left join a on a.rn = t.rn
  where jsonb_typeof(c.px) = 'number' and (c.px)::text::numeric > 0;
$fn$;

create or replace function public.refresh_etf_perf()
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare
  r record; body text; n integer := 0; y_sym text;
  f_day date; l_day date; cnt integer;
  f_px numeric; l_px numeric; f_adj numeric; l_adj numeric;
  b_sym text; b_corr numeric; b_f numeric; b_l numeric;
begin
  perform set_config('statement_timeout', '900s', true);

  -- 兩張暫存表都在迴圈外建好。在迴圈裡 create 的話，只要有一檔丟例外、
  -- 子交易回滾，下一圈就會踩到半建好的狀態。
  create temp table _bench (bsym text, d date, adj numeric, primary key (bsym, d)) on commit drop;
  create temp table _px (d date, close numeric, adj numeric) on commit drop;

  -- 被動替代品先抓起來放，每檔基金都重抓一次是沒有意義的
  for r in select * from (values ('0050'), ('00662'), ('00646')) v(k) loop
    begin
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || r.k || '.TW?interval=1d&range=2y');
      insert into _bench select r.k, d, adj from public.pm_yahoo_series(body)
      on conflict do nothing;
    exception when others then
      perform public.pm_log('etf_perf bench ' || r.k, 0, false, sqlerrm);
    end;
  end loop;
  -- 三檔缺一檔就有一整組沒有對照組，寧可整批不更新也不要寫進半套數字
  if (select count(distinct bsym) from _bench) < 3 then
    perform public.pm_log('etf_perf', 0, false, 'benchmark incomplete');
    return 0;
  end if;

  for r in select symbol, name, benchmark from public.active_etf order by symbol loop
    begin
      delete from _px;
      b_sym := null;
      -- 上市的是 .TW，上櫃的是 .TWO。哪一檔在哪裡不用另外查，抓不到就換。
      y_sym := r.symbol || '.TW';
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || y_sym || '?interval=1d&range=2y');
      insert into _px select * from public.pm_yahoo_series(body);
      if (select count(*) from _px) < 20 then
        y_sym := r.symbol || '.TWO';
        body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                                || y_sym || '?interval=1d&range=2y');
        delete from _px;
        insert into _px select * from public.pm_yahoo_series(body);
      end if;

      select min(d), max(d), count(*) into f_day, l_day, cnt from _px;
      -- 20 個交易日以下不給數字。掛牌第一週的漲跌只是承銷價差。
      if cnt < 20 then continue; end if;
      select close, adj into f_px, f_adj from _px order by d limit 1;
      select close, adj into l_px, l_adj from _px order by d desc limit 1;

      -- 對照組怎麼挑，按證據強度排，強的先用：
      --
      --   1. 證交所資料裡有填標的指數的（32 檔裡有 7 檔）——那是公開說明書
      --      寫的比較指標，最硬。
      --   2. 名稱裡明講市場的（「美國」「台灣」「ARK」…）——投信自己命的名，
      --      算是宣告。
      --   3. 都沒有，才用日報酬相關係數推。
      --
      -- **不能只用其中一種。** 只用名字：00991A 主動復華未來50、
      -- 00403A 主動統一升級50 名稱裡沒有「台灣」，會落到全球組去跟 S&P 500 比，
      -- 但它們說明書上的比較指標就是臺灣加權報酬指數，超額報酬會憑空多幾十個百分點。
      -- 只用相關係數：00997A 主動群益美國增長 對 0050 是 0.781、對 00662 是 0.772，
      -- 差 0.009 等於擲銅板，可是它名字就寫著美國。
      select bsym, cr into b_sym, b_corr from (
        select b.bsym,
               corr(f.r, b.r) as cr,
               count(*) as n
        from (select d, adj / lag(adj) over (order by d) - 1 as r from _px) f
        join (select bsym, d, adj / lag(adj) over (partition by bsym order by d) - 1 as r
              from _bench) b on b.d = f.d
        where f.r is not null and b.r is not null
        group by b.bsym
        having count(*) >= 20
      ) s order by cr desc nulls last limit 1;
      if b_sym is null then continue; end if;

      -- 有更硬的證據就蓋掉推估的結果
      if r.benchmark ~ '臺灣|台灣' then b_sym := '0050';
      elsif r.name ~ '那斯達克|NASDAQ|ARK' then b_sym := '00662';
      elsif r.name ~ 'S&P|標普' then b_sym := '00646';
      elsif r.name ~ '美國|美股' then b_sym := '00662';
      elsif r.name ~ '台灣|臺灣|台股' then b_sym := '0050';
      end if;
      -- 被動的取「不早於基金首日」的第一筆與「不晚於基金末日」的最後一筆，期間才對得上
      select adj into b_f from _bench where bsym = b_sym and d >= f_day order by d limit 1;
      select adj into b_l from _bench where bsym = b_sym and d <= l_day order by d desc limit 1;

      insert into public.etf_perf (symbol, first_day, last_day, days, first_price, last_price,
                                   ret, bench, bench_corr, bench_ret, excess, updated_at)
      values (r.symbol, f_day, l_day, cnt, f_px, l_px,
              round(l_adj / f_adj - 1, 4), b_sym, round(b_corr, 3),
              case when b_f > 0 then round(b_l / b_f - 1, 4) end,
              case when b_f > 0 then round((l_adj / f_adj) - (b_l / b_f), 4) end,
              now())
      on conflict (symbol) do update
        set first_day = excluded.first_day, last_day = excluded.last_day, days = excluded.days,
            first_price = excluded.first_price, last_price = excluded.last_price,
            ret = excluded.ret, bench = excluded.bench, bench_corr = excluded.bench_corr,
            bench_ret = excluded.bench_ret,
            excess = excluded.excess, updated_at = now();
      n := n + 1;
    exception when others then
      perform public.pm_log('etf_perf ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('etf_perf', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_etf_perf() from public, anon;

-- ------------------------------------------------------------
-- 給畫面用：一檔一列，加上發行人與規模
-- ------------------------------------------------------------
drop function if exists public.active_etf_perf();
create or replace function public.active_etf_perf()
returns table (symbol text, name text, issuer text, scope text, listed_on date,
               days integer, price numeric, ret numeric, bench text, bench_corr numeric,
               bench_ret numeric, excess numeric, vol numeric, beats boolean)
language sql stable security definer set search_path = public as $fn$
  -- scope 用「實際挑到的對照組」回推，比基金名稱可靠
  select e.symbol, e.name, e.issuer,
         case p.bench when '0050' then 'tw' when '00662' then 'us'
                      when '00646' then 'global' else e.scope end,
         e.listed_on,
         p.days, coalesce(m.price, p.last_price), p.ret, p.bench, p.bench_corr,
         p.bench_ret, p.excess, k.vol,
         case when p.excess is not null then p.excess > 0 end
  from public.active_etf e
  left join public.etf_perf p on p.symbol = e.symbol
  left join public.market_prices m on m.market = 'tw' and m.symbol = e.symbol
  left join public.risk_stats k on k.symbol = e.symbol
  order by p.excess desc nulls last, e.symbol;
$fn$;

grant execute on function public.active_etf_perf() to anon, authenticated;
