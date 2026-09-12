-- ============================================================
-- ↻ 的冷卻與共用快取
--
--   `refresh_market()` 是開給登入者的，按一次會對證交所、櫃買、期交所、
--   Yahoo 連續發 14 輪請求。單人自用沒問題，開放註冊之後：
--     · 一個人按住 ↻ 連點，就是拿我們的資料庫去打別人的網站；
--     · 十個人同時按，十份一模一樣的資料被抓十次。
--
--   **這裡的冷卻是「全站共用」而不是「每人一份」，這是刻意的。**
--   收盤價是全站共用的一份資料，A 剛抓完 10 秒後 B 再按，
--   B 要的東西早就在資料庫裡了，不該再去打一次來源。
--   所以 gate 的主鍵是 kind，不是 (user_id, kind)。
--
--   冷卻長度分兩級：
--     盤中會變的（報價、匯率）      60 秒
--     一天只變一次的（營收、季報、
--     分析師預估、報酬波動）        10 分鐘——這幾支最重，
--                                   refresh_estimates 一輪要抓幾十檔
--     sync（把快取的價套到自己持倉）不冷卻，它只讀本地、只動自己的列
--
--   失敗不寫 gate：refresh 拋例外時整個交易回滾，gate 那一列也不會留下，
--   所以來源壞掉的時候使用者還是可以重試，不會被鎖在冷卻裡。
-- ============================================================

create table if not exists public.refresh_gate (
  kind      text primary key,
  last_run  timestamptz not null,
  last_rows integer not null default 0,
  last_ms   integer
);

-- 沒有任何 policy，等於前端一列都讀不到。
-- 只有 security definer 的 refresh_market() 碰得到它。
alter table public.refresh_gate enable row level security;
revoke all on table public.refresh_gate from anon, authenticated;

create or replace function public.refresh_market(p_kind text)
returns json
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  n integer := 0;
  t0 timestamptz := clock_timestamp();
  cool interval;
  g public.refresh_gate%rowtype;
  mk text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- 這一項算哪個市場的 as_of（冷卻回傳與正常回傳共用）
  mk := case p_kind
          when 'fut' then 'fut' when 'opt' then 'opt'
          when 'war' then 'war' when 'warp' then 'war'
          when 'fx'  then 'fx'  when 'us'  then 'us'
          else 'tw' end;

  cool := case p_kind
            when 'sync' then interval '0 seconds'
            when 'val'  then interval '10 minutes'
            when 'rev'  then interval '10 minutes'
            when 'fin'  then interval '10 minutes'
            when 'est'  then interval '10 minutes'
            when 'risk' then interval '10 minutes'
            when 'usx'  then interval '10 minutes'
            else interval '60 seconds'
          end;

  if cool > interval '0 seconds' then
    select * into g from public.refresh_gate where kind = p_kind;
    if found and clock_timestamp() - g.last_run < cool then
      return json_build_object(
        'kind', p_kind, 'rows', g.last_rows, 'ms', 0, 'cached', true,
        'age_s', round(extract(epoch from clock_timestamp() - g.last_run)),
        'as_of', (select max(as_of) from public.market_prices where market = mk));
    end if;
  end if;

  case p_kind
    when 'tw'  then n := public.refresh_tw_prices();
    when 'fut' then n := public.refresh_futures_prices();
    when 'opt' then n := public.refresh_option_prices();
    when 'war'  then n := public.refresh_warrant_prices('0999');   -- 認購
    when 'warp' then n := public.refresh_warrant_prices('0999P');  -- 認售
    when 'fx'  then n := coalesce((public.refresh_fx() is not null)::int, 0);
    when 'us'  then n := public.refresh_us_prices();
    when 'val' then n := public.refresh_valuation();
    when 'alert' then n := public.refresh_alerts();
    when 'rev' then n := public.refresh_revenue();
    when 'fin' then n := public.refresh_financials();
    when 'est' then n := public.refresh_estimates(12);
    when 'risk' then n := public.refresh_risk_stats(120);
    when 'usrisk' then n := public.refresh_us_risk(120);
    when 'prof' then n := public.refresh_company_profiles(8);
    when 'usest' then n := public.refresh_us_est(30);
    when 'usprof' then n := public.refresh_us_profiles(30);
    when 'usx' then n := public.refresh_us_stats(8);
    when 'sync' then n := public.sync_positions(auth.uid());
    else raise exception 'unknown market %', p_kind;
  end case;

  if cool > interval '0 seconds' then
    insert into public.refresh_gate (kind, last_run, last_rows, last_ms)
    values (p_kind, clock_timestamp(), n,
            round(extract(epoch from clock_timestamp() - t0) * 1000))
    on conflict (kind) do update
      set last_run  = excluded.last_run,
          last_rows = excluded.last_rows,
          last_ms   = excluded.last_ms;
  end if;

  return json_build_object(
    'kind', p_kind, 'rows', n, 'cached', false,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000),
    'as_of', (select max(as_of) from public.market_prices where market = mk));
end $function$;

revoke all on function public.refresh_market(text) from public, anon;
grant execute on function public.refresh_market(text) to authenticated;
