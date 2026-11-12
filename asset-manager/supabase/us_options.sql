-- ============================================================
-- 美股個股選擇權（複委託）  2026-11-12
--
--   跟台指選擇權（public.options）分開一張表，原因是幾乎每一個欄位的意義都不同：
--     幣別 USD、每口 100 股、標的是個股（要另外抓標的價）、到期日是真的日期。
--   **市值不進總資產**：部位在海期帳戶，券商回報的海期權益數已經含了浮動損益，
--     跟台指選擇權在期貨帳戶一樣（11/4 起不進總資產）。只進曝險。
--
--   報價：Yahoo chart 端點吃 OCC 代碼（NVDA261120C00155000），不用 crumb。
--   delta：用標的價當遠期價，套跟台指選擇權同一支 Black-76 反推（pm_solve_x / pm_delta）。
--          美股個股選擇權是美式、利率與股利都忽略，對 call 的 delta 影響是二階的。
--
--   這個檔案可以重跑（全部 if not exists / create or replace）。
-- ============================================================

create table if not exists public.us_options (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol        text not null,                     -- 標的代號，例如 NVDA
  expiry        date not null,                     -- 到期日（美東）
  strike        numeric not null,
  cp            text not null check (cp in ('call','put')),
  side          text not null default 'long' check (side in ('long','short')),
  lots          numeric not null default 1,        -- 口數（合約數）
  price_usd     numeric not null default 0,        -- 目前權利金（每股，USD），自動更新
  cost_usd      numeric,                           -- 平均成本（每股，USD）
  size          numeric not null default 100,      -- 每口 100 股
  underlying_px numeric,                           -- 標的價（USD），自動更新
  delta         numeric,                           -- 自動計算
  iv            numeric,                           -- 年化隱含波動，方便檢查
  quote_at      timestamptz,                       -- 權利金報價的成交時間（Yahoo regularMarketTime）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists us_options_user_idx on public.us_options(user_id);

drop trigger if exists set_updated_at on public.us_options;
create trigger set_updated_at before update on public.us_options
  for each row execute function public.set_updated_at();

alter table public.us_options enable row level security;
drop policy if exists "own rows" on public.us_options;
create policy "own rows" on public.us_options for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- 表的 SELECT 預設會給 anon（見記憶：Supabase 權限預設全開）；RLS 擋住了，但還是收回來
revoke all on public.us_options from anon;

-- 交易紀錄：新增 market = 'usopt'
--   symbol = 標的、opt_expiry = 'YYYY-MM-DD'、opt_strike、opt_cp、price = 每股權利金（USD）、
--   quantity = 口數、opt_fwd = 成交當下的標的價（選填，用來當場算 delta）
alter table public.trades drop constraint if exists trades_market_check;
alter table public.trades add constraint trades_market_check
  check (market = any (array['tw','futures','us','option','warrant','usopt']));

-- ------------------------------------------------------------
-- OCC 代碼：NVDA + 261120 + C + 00155000（履約價 × 1000，補滿 8 位）
-- ------------------------------------------------------------
create or replace function public.pm_occ(p_symbol text, p_expiry date, p_strike numeric, p_cp text)
returns text language sql immutable as $fn$
  select upper(btrim(p_symbol)) || to_char(p_expiry, 'YYMMDD')
         || case when p_cp = 'put' then 'P' else 'C' end
         || lpad(round(p_strike * 1000)::bigint::text, 8, '0');
$fn$;

-- ------------------------------------------------------------
-- 抓報價、反推 delta，直接寫回 us_options
--   p_user 為 null（排程）＝全部人；從 App 呼叫時一律只更新自己的。
--   **比部位還舊的報價不蓋掉成交價**：剛買的那一口，Yahoo 的最後成交可能是更早的，
--   蓋掉的話一存檔就會顯示一筆不存在的損益。標的價與 delta 照樣更新。
-- ------------------------------------------------------------
create or replace function public.refresh_us_options(p_user uuid default null)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare
  r record; body jsonb; ub jsonb; occ text;
  px numeric; qt timestamptz; s numeric; t float8; x float8;
  under jsonb := '{}'::jsonb; n integer := 0;
begin
  if auth.uid() is not null then p_user := auth.uid(); end if;
  for r in
    select o.* from public.us_options o
     where (p_user is null or o.user_id = p_user)
       and o.expiry >= (now() at time zone 'America/New_York')::date
  loop
    begin
      occ := public.pm_occ(r.symbol, r.expiry, r.strike, r.cp);
      body := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/' || occ
                              || '?interval=1d&range=1d')::jsonb;
      px := public.pm_num(body #>> '{chart,result,0,meta,regularMarketPrice}');
      qt := to_timestamp(public.pm_num(body #>> '{chart,result,0,meta,regularMarketTime}')::float8);

      -- 標的價：同一個代號只抓一次
      if not under ? upper(r.symbol) then
        ub := public.pm_fetch('https://query1.finance.yahoo.com/v8/finance/chart/' || upper(btrim(r.symbol))
                              || '?interval=1d&range=1d')::jsonb;
        under := under || jsonb_build_object(upper(r.symbol),
                   public.pm_num(ub #>> '{chart,result,0,meta,regularMarketPrice}'));
      end if;
      s := (under ->> upper(r.symbol))::numeric;

      -- 用新的權利金；報價比部位舊就沿用部位上的
      if not (px > 0) or (qt is not null and qt < r.created_at) then px := r.price_usd; end if;

      -- 到期前還剩幾年：算到到期日美東 16:00，最少留半天，避免到期日當天 σ√T 變 0
      t := greatest(extract(epoch from ((r.expiry::timestamp + interval '16 hours') at time zone 'America/New_York') - now())
                    / (365.0 * 86400), 0.5 / 365);
      x := public.pm_solve_x(s::float8, r.strike::float8, px::float8, r.cp = 'call');

      update public.us_options o
         set price_usd     = px,
             underlying_px = coalesce(s, o.underlying_px),
             delta         = coalesce(public.pm_delta(s::float8, r.strike::float8, x, r.cp = 'call'), o.delta),
             iv            = case when x > 0 then x / sqrt(t) end,
             quote_at      = case when px = r.price_usd and o.quote_at is not null then o.quote_at else qt end
       where o.id = r.id;
      n := n + 1;
    exception when others then
      perform public.pm_log('yahoo_opt:' || coalesce(occ, r.symbol), 0, false, sqlerrm);
    end;
  end loop;
  perform public.pm_log('yahoo_opt', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_us_options(uuid) from public, anon, authenticated;
grant execute on function public.refresh_us_options(uuid) to authenticated;
revoke all on function public.pm_occ(text, date, numeric, text) from public, anon, authenticated;

-- 美股盤中每 30 分鐘、收盤後一次（UTC；冬令 14:30–21:00 開盤）。
-- 收盤後那次排在 am-us（22:05，會存快照）之前。
do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname in ('am-usopt', 'am-usopt-close');
  perform cron.schedule('am-usopt', '*/30 14-21 * * 1-5', $c$select public.refresh_us_options()$c$);
  perform cron.schedule('am-usopt-close', '55 21 * * 1-5', $c$select public.refresh_us_options()$c$);
end $$;

-- ------------------------------------------------------------
-- 每日快照：加進美股選擇權
--   以 2026-11-12 線上版本為底（線上已經把台指選擇權拿出總資產，prices.sql 的檔案版本還沒同步，
--   這裡一併以線上為準）。改動只有一處，標了「usopt」：
--     delta 曝險算進 us_exposure：買方淨、賣方毛，跟台指選擇權同一套規則。
--   市值不加：已經含在海期權益數裡（記在 balances 的 futures_equity）。
-- ------------------------------------------------------------
create or replace function public.auto_snapshot()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with u as (select id from auth.users),
  s as (
    select u.id as user_id,
           coalesce((select sum(x.shares * x.price) from public.stocks x where x.user_id = u.id), 0) as stock_value,
           coalesce((select sum(x.shares * x.price_usd) from public.us_stocks x where x.user_id = u.id), 0) as us_usd,
           coalesce((select sum(x.shares * x.price_usd * abs(public.pm_us_leverage(x.leverage, x.name)))
                     from public.us_stocks x where x.user_id = u.id), 0)
           -- usopt：delta 曝險，買方淨、賣方毛
           + coalesce((select sum(case when x.side = 'short'
                                       then abs(x.lots * coalesce(x.delta, 0) * coalesce(x.underlying_px, 0) * x.size)
                                       else      x.lots * coalesce(x.delta, 0) * coalesce(x.underlying_px, 0) * x.size
                                  end)
                       from public.us_options x where x.user_id = u.id), 0) as us_expo_usd,
           coalesce((select sum(x.lots * x.price * x.size) from public.futures x where x.user_id = u.id), 0) as fut_notional,
           coalesce((select sum(x.lots * x.price * x.size * case when x.side = 'short' then -1 else 1 end)
                     from public.options x where x.user_id = u.id), 0) as opt_value,
           -- 2026-10-10：**買方淨、賣方毛**。原本一律 abs()，結果買進賣權這種純避險
           -- 的部位會增加總曝險——實測 2026-10-09 買 20 口價外賣權（delta 曝險 −551.6 萬）
           -- 讓曝險倍數從 3.36x「漲」到 4.61x，方向整個反掉，而這個數字還餵給
           -- max_exposure 規則，等於罰他做對的事。正確算法是 2.22x。
           -- 買方最大虧損就是權利金（已算在 opt_value／總資產裡），沒有尾部，可以淨；
           -- 賣方虧損無上限，淨掉會讓人用賣出買權把曝險壓低，所以維持絕對值。
           -- 這裡要跟 portfolio.js 的 compute() 用同一套規則，兩邊對不起來比算錯更糟。
           coalesce((select sum(case when x.side = 'short'
                                     then abs(x.lots * coalesce(x.delta, 0) * coalesce(x.forward, 0) * x.size)
                                     else      x.lots * coalesce(x.delta, 0) * coalesce(x.forward, 0) * x.size
                                end)
                     from public.options x where x.user_id = u.id), 0) as opt_exposure,
           coalesce((select sum(x.lots * 1000 * x.price)
                     from public.warrants x where x.user_id = u.id), 0) as war_value,
           coalesce((select sum(abs(x.lots * 1000 * coalesce(x.ratio, 0)
                        * coalesce(x.delta_override, x.delta, 0) * coalesce(x.underlying_price, 0)))
                     from public.warrants x where x.user_id = u.id), 0) as war_exposure,
           coalesce((select st.usd_twd from public.settings st where st.user_id = u.id), 32) as rate,
           coalesce((select st.target_amount from public.settings st where st.user_id = u.id), 0) as target
    from u
  ),
  b as (
    select s.*,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'cash'), 0) as cash,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'futures_equity'), 0) as fut_equity,
      coalesce((select sum(x.amount * case when x.currency = 'USD' then s.rate else 1 end)
                from public.balances x where x.user_id = s.user_id and x.kind = 'liability'), 0) as liab
    from s
  ),
  f as (
    select b.*,
           b.us_usd * b.rate as us_value,
           b.us_expo_usd * b.rate as us_exposure,
           -- **選擇權不加進總資產**（2026-11-04）：部位在期貨帳戶裡，券商回報的權益數
           -- 本來就含了未沖銷部位的浮動損益，再加 opt_value 就是同一筆錢算兩遍。
           -- 期貨部位一直都沒加（只進曝險），選擇權現在跟它一致。
           -- opt_value 仍然存進快照那一欄，只是不計入 total_assets。
           b.stock_value + b.us_usd * b.rate + b.fut_equity + b.cash + b.war_value as total_assets
    from b
  ),
  g as (
    select f.*, f.total_assets - f.liab as net_assets,
           -- 複委託這一項是曝險不是市值：槓桿型 ETF 兩者不同
           f.stock_value + f.us_exposure + f.fut_notional + f.opt_exposure + f.war_exposure as exposure
    from f
  )
  insert into public.snapshots (
    user_id, snap_date, price_as_of, total_assets, liabilities, net_assets, stock_value, us_value,
    futures_margin, futures_notional, cash, option_value, option_exposure,
    warrant_value, warrant_exposure, leverage_asset, leverage_exposure, target_amount, note)
  -- 日期用台北時區：美股那班排程在 UTC 22:00 跑，等於台北隔天早上 06:00
  select user_id, (now() at time zone 'Asia/Taipei')::date,
         (select max(as_of) from public.market_prices where market = 'tw'),
         round(total_assets, 2), round(liab, 2), round(net_assets, 2), round(stock_value, 2), round(us_value, 2),
         round(fut_equity, 2), round(fut_notional, 2), round(cash, 2),
         round(opt_value, 2), round(opt_exposure, 2),
         round(war_value, 2), round(war_exposure, 2),
         case when net_assets > 0 then round(total_assets / net_assets, 4) end,
         case when total_assets > 0 then round(exposure / total_assets, 4) end,
         round(target, 2), 'auto'
  from g
  where total_assets <> 0 or liab <> 0
  on conflict (user_id, snap_date) do update
    set price_as_of = excluded.price_as_of,
        total_assets = excluded.total_assets, liabilities = excluded.liabilities,
        net_assets = excluded.net_assets, stock_value = excluded.stock_value,
        us_value = excluded.us_value, futures_margin = excluded.futures_margin,
        futures_notional = excluded.futures_notional, cash = excluded.cash,
        option_value = excluded.option_value, option_exposure = excluded.option_exposure,
        warrant_value = excluded.warrant_value, warrant_exposure = excluded.warrant_exposure,
        leverage_asset = excluded.leverage_asset, leverage_exposure = excluded.leverage_exposure,
        target_amount = excluded.target_amount
    where public.snapshots.note = 'auto';   -- 手動存的快照不覆蓋
  get diagnostics n = row_count;
  perform public.pm_log('auto_snapshot', n, true, null);
  return n;
end $$;
revoke all on function public.auto_snapshot() from public, anon, authenticated;
