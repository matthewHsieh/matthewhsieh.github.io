-- ============================================================
-- 配置計算：把「這檔該買多少」變成算得出來的數字
--
--   risk_stats 已經有每一檔的年化波動，單檔要買多少用它就夠：
--       曝險 = 總資產 × 風險預算 ÷ 年化波動
--   但「這幾檔加起來的風險是多少」**不能把波動相加**，要看相關係數。
--   2026-09-17 實測他的部位：金居與聯茂相關 0.50、MUU 與 SNXX 0.78，
--   而 SNXX 對台股只有 0.12。用單因子（只看對大盤的 beta）去近似，
--   金居-聯茂會被算成 0.29，**低估了實際的 0.50**——低估風險是最糟的方向。
--
--   所以老實存日報酬，讓前端自己算精確的相關係數矩陣。
--   一檔 260 天、每天一個 real（4 bytes）≈ 1KB，整個個股期貨宇宙也才 250KB，
--   而且他一次只會挑幾檔，抓下來的量很小。
--
--   **一定要連日期一起存。** 只存報酬、靠「從最後一天往回數」對齊，
--   遇到停牌就會整條錯開，而錯開的效果是相關係數被稀釋成 0——
--   又是低估風險。存 days（epoch 日數）就能精確對齊。
-- ============================================================

alter table public.risk_stats add column if not exists ret_days integer[];
alter table public.risk_stats add column if not exists rets     real[];
alter table public.us_stats   add column if not exists ret_days integer[];
alter table public.us_stats   add column if not exists rets     real[];

comment on column public.risk_stats.rets is
  '最近約 260 個交易日的日對數報酬，與 ret_days 等長。給前端算相關係數用。';

-- ------------------------------------------------------------
-- 從 Yahoo chart JSON 取出日報酬序列
-- ------------------------------------------------------------
create or replace function public.pm_ret_series(p_body text, p_n integer default 260)
returns table (days integer[], rets real[])
language plpgsql immutable as $fn$
declare
  j jsonb; ts jsonb; cl jsonb;
  n integer; i integer; startk integer;
  c numeric; prev numeric := null;
  dd integer[] := '{}'; rr real[] := '{}';
begin
  begin
    j := (p_body::jsonb) -> 'chart' -> 'result' -> 0;
  exception when others then
    return;
  end;
  if j is null then return; end if;
  ts := j -> 'timestamp';
  cl := j -> 'indicators' -> 'quote' -> 0 -> 'close';
  if ts is null or cl is null then return; end if;

  n := jsonb_array_length(ts);
  -- 多留一天，因為第一天只拿來當前一天的基準，算不出報酬
  startk := greatest(0, n - p_n - 1);

  for i in startk .. n - 1 loop
    if jsonb_typeof(cl -> i) = 'number' then
      c := (cl ->> i)::numeric;
      if c > 0 then
        if prev is not null and prev > 0 then
          dd := dd || ((ts ->> i)::bigint / 86400)::integer;
          rr := rr || ln(c / prev)::real;
        end if;
        prev := c;
      end if;
    end if;
  end loop;

  if array_length(rr, 1) is null then return; end if;
  days := dd;
  rets := rr;
  return next;
end $fn$;

-- ------------------------------------------------------------
-- 補日報酬序列
--
--   只做「他真的可能拿來配置」的範圍：有掛個股期貨的標的（能開槓桿、能空）
--   ＋ 他自己的持股與期貨部位。全市場兩千檔沒必要，也塞不進 cron 的時間。
--   一樣用 updated_at 輪替，配合既有的每小時排程。
-- ------------------------------------------------------------
create or replace function public.refresh_ret_series(p_limit integer default 60)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; suffix text; total integer := 0; got integer;
begin
  perform set_config('statement_timeout', '900s', true);

  for r in
    select s.symbol, coalesce(v.src, 'twse') as src
    from (
      select symbol from public.fut_codes
      union select upper(btrim(symbol)) from public.stocks
      union select upper(btrim(symbol)) from public.futures
             where kind = 'stock' and symbol is not null
    ) s
    left join public.valuation v on v.symbol = s.symbol
    left join public.risk_stats k on k.symbol = s.symbol
    where s.symbol ~ '^[0-9]{4,6}[A-Z]?$'
      -- 已經是今天補過的就跳過
      and (k.rets is null or k.as_of is distinct from current_date
           or array_length(k.rets, 1) is null)
    order by k.updated_at nulls first
    limit p_limit
  loop
    suffix := case when r.src = 'tpex' then '.TWO' else '.TW' end;
    begin
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || r.symbol || suffix || '?interval=1d&range=2y');
      update public.risk_stats k
         set ret_days = c.days, rets = c.rets, updated_at = now()
        from public.pm_ret_series(body) c
       where k.symbol = r.symbol;
      get diagnostics got = row_count;
      total := total + got;
    exception when others then
      perform public.pm_log('rets ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  -- 加權指數是基準線，一定要有
  begin
    body := public.pm_fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=2y');
    update public.risk_stats k
       set ret_days = c.days, rets = c.rets, updated_at = now()
      from public.pm_ret_series(body) c
     where k.symbol = 'TAIEX';
  exception when others then
    perform public.pm_log('rets TAIEX', 0, false, sqlerrm);
  end;

  perform public.pm_log('ret_series', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_ret_series(integer) from public, anon;

-- 前端只讀，不需要 execute 權限；讀取走 risk_stats 既有的 select policy。
-- 美股的日報酬序列。
--   他的 SNXX（2X SNDK）佔曝險 23%、卻佔風險 49%——把它排除在組合波動之外，
--   算出來的數字會從 216% 掉到 142%，**低估三分之一**。所以美股一定要補。
create or replace function public.refresh_us_ret_series(p_limit integer default 40)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; total integer := 0; got integer;
begin
  perform set_config('statement_timeout', '900s', true);
  for r in
    select s.symbol from (
      select upper(btrim(symbol)) as symbol from public.us_stocks
      union select symbol from public.us_themes
    ) s
    left join public.us_stats k on k.symbol = s.symbol
    where s.symbol ~ '^[A-Z.]{1,6}$'
      and (k.rets is null or k.as_of is distinct from current_date
           or array_length(k.rets, 1) is null)
    order by k.updated_at nulls first
    limit p_limit
  loop
    begin
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/'
                              || r.symbol || '?interval=1d&range=2y');
      -- **沒有那一列就先建一列**，否則 update 會靜靜地更新 0 列
      insert into public.us_stats (symbol, as_of, updated_at)
      values (r.symbol, current_date, now())
      on conflict (symbol) do nothing;

      update public.us_stats k
         set ret_days = c.days, rets = c.rets, updated_at = now()
        from public.pm_ret_series(body) c
       where k.symbol = r.symbol;
      get diagnostics got = row_count;
      total := total + got;
    exception when others then
      perform public.pm_log('usrets ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;
  perform public.pm_log('us_ret_series', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_us_ret_series(integer) from public, anon;
