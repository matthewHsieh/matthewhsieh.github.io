-- ============================================================
-- 免登入瀏覽
--
-- 產業地圖、族群、今日漲跌、選股這幾頁是市場資料，沒有理由要登入才能看。
-- 但**持倉、交易紀錄、資金、心得、設定一律不開**，那些是他自己的錢。
--
-- 開放的方式是給 anon 角色加 select policy。這裡刻意一張一張列出來，
-- 不用迴圈掃全部表——**漏掉一張就是把買賣紀錄公開**，
-- 寧可以後新增表時要記得回來加一行，也不要用「除了這幾張以外都開」的寫法。
--
-- 對照組（**永遠不開**）：
--   stocks / futures / us_stocks / warrants / options / balances /
--   trades / snapshots / settings / journal / rules / rule_breaks / eps_override
-- ============================================================

do $$
declare t text;
begin
  foreach t in array array[
    -- 市場行情與統計
    'market_prices', 'price_history', 'risk_stats', 'us_stats', 'valuation',
    -- 基本面
    'revenue', 'financials', 'eps_estimate', 'eps_forecast',
    -- 族群與產業地圖
    'themes', 'theme_info', 'theme_meta', 'theme_links', 'us_themes',
    -- 交易所警示、契約對照
    'trade_alerts', 'fut_codes', 'fut_months', 'stock_universe', 'company_profile',
    -- 轉型故事、主動型 ETF
    'stock_story', 'active_etf', 'etf_perf', 'etf_tilt', 'etf_holding', 'stock_shares',
    -- 更新狀態（只有市場名稱與日期，沒有任何個人資料）
    'price_runs'
  ] loop
    execute format('drop policy if exists "public read %1$s" on public.%1$I', t);
    execute format('create policy "public read %1$s" on public.%1$I for select to anon using (true)', t);
    execute format('grant select on public.%1$I to anon', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 先全部關掉，再一支一支開回來。
--
-- **PostgreSQL 建新函式時預設就把 EXECUTE 給 PUBLIC。** 這代表每一支
-- 沒有明確 revoke 的函式，拿著 anon key 的任何人都叫得動。實測開放的有 56 支，
-- 其中包含：
--   pm_fetch(url)          security definer，從資料庫對任意網址發 HTTP GET
--   refresh_warrant_info() 一次下載 20MB
--   snapshot_month_end()   會寫進 snapshots
-- 第一支等於把資料庫變成別人的跳板，第二支是免費的流量炸彈。
--
-- 所以這裡的做法是：先 revoke public schema 底下所有函式的 PUBLIC 與 anon 權限，
-- 再把該開的開回來。**日後新增函式一定要重跑這個檔**，否則又會預設全開。
-- ------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
  end loop;
end $$;

-- ------------------------------------------------------------
-- RPC。security definer 會繞過 RLS，所以這裡要更小心：
-- 只開「回傳的內容跟登入者無關」的那幾支。
--
-- **不開的**：my_valuation()（只回自己的持股）、journal_days()、
-- sync_my_positions()、refresh_market()、refresh_prices()，
-- 以及任何 refresh_* / update_*（會對外抓資料，開給匿名等於開放濫用）。
-- ------------------------------------------------------------
grant execute on function public.theme_trend(integer)      to anon;
grant execute on function public.theme_members(text)       to anon;
grant execute on function public.theme_valuation()         to anon;
grant execute on function public.theme_day()               to anon;
grant execute on function public.stock_day(text[])         to anon;
grant execute on function public.us_theme_trend()          to anon;
grant execute on function public.us_theme_members()        to anon;
grant execute on function public.theme_tree(text)          to anon;
grant execute on function public.theme_chain(text, text)   to anon;
grant execute on function public.active_alerts(integer)    to anon;
grant execute on function public.screen_stocks(text, boolean, boolean, boolean,
                                               numeric, numeric, numeric, text, text, integer) to anon;
grant execute on function public.app_risk()                to anon;

-- stock_detail 內部會呼叫 eps_resolved()，而 eps_resolved 讀 eps_override
-- 時是用 auth.uid() 過濾的。匿名時 auth.uid() 是 null，所以拿不到任何人的自填值，
-- 只會看到自動抓的與人工整理的公開預估——這正是我們要的。
grant execute on function public.eps_resolved()            to anon;
grant execute on function public.stock_detail(text, text)  to anon;
grant execute on function public.stock_stories()           to anon;
grant execute on function public.etf_board()               to anon;
grant execute on function public.theme_etf()               to anon;

-- ------------------------------------------------------------
-- 登入者：市場資料那幾支照開，另外加上只跟自己有關的那幾支。
-- 這一份要跟 app.js 裡的 sb.rpc(...) 對得上，少一支畫面就會壞。
-- ------------------------------------------------------------
grant execute on function public.theme_trend(integer)      to authenticated;
grant execute on function public.theme_members(text)       to authenticated;
grant execute on function public.theme_valuation()         to authenticated;
grant execute on function public.theme_day()               to authenticated;
grant execute on function public.stock_day(text[])         to authenticated;
grant execute on function public.us_theme_trend()          to authenticated;
grant execute on function public.us_theme_members()        to authenticated;
grant execute on function public.theme_tree(text)          to authenticated;
grant execute on function public.theme_chain(text, text)   to authenticated;
grant execute on function public.active_alerts(integer)    to authenticated;
grant execute on function public.eps_resolved()            to authenticated;
grant execute on function public.stock_detail(text, text)  to authenticated;
grant execute on function public.stock_stories()           to authenticated;
grant execute on function public.etf_board()               to authenticated;
grant execute on function public.theme_etf()               to authenticated;
grant execute on function public.my_valuation()            to authenticated;
grant execute on function public.journal_days(integer)     to authenticated;
grant execute on function public.refresh_market(text)      to authenticated;
grant execute on function public.refresh_prices(boolean)   to authenticated;
grant execute on function public.sync_my_positions()       to authenticated;
grant execute on function public.screen_stocks(text, boolean, boolean, boolean,
                                               numeric, numeric, numeric, text, text, integer) to authenticated;
grant execute on function public.app_risk()                to authenticated;

-- ------------------------------------------------------------
-- 驗一次：對外開放的函式清單要跟預期一模一樣。
-- 多出任何一支都要當成事故處理，尤其是 pm_fetch。
-- ------------------------------------------------------------
do $$
declare extra text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into extra
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'execute')
    and p.proname not in ('theme_trend', 'theme_members', 'theme_valuation', 'theme_day',
                          'stock_day', 'us_theme_trend', 'us_theme_members',
                          'theme_tree', 'theme_chain', 'active_alerts',
                          'eps_resolved', 'stock_detail', 'screen_stocks', 'app_risk',
                          'stock_stories', 'etf_board', 'theme_etf');
  if extra is not null then
    raise exception '這些函式不該開給匿名：%', extra;
  end if;
end $$;

-- ------------------------------------------------------------
-- 驗一次：個人資料表一定要擋得住匿名
--
-- **不要用「有沒有 GRANT SELECT 給 anon」來驗。** Supabase 預設就會把 public
-- schema 底下所有表的 SELECT 權限給 anon，十三張個人資料表全都有——
-- 真正擋住的是 RLS。所以要驗的是兩件事：
--   1. RLS 有開；
--   2. 沒有任何 policy 把 anon 或 PUBLIC 放進 roles 裡。
-- ------------------------------------------------------------
do $$
declare bad text;
begin
  select string_agg(c.relname || ' (RLS 沒開)', ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    and c.relname in ('stocks', 'futures', 'us_stocks', 'warrants', 'options',
                      'balances', 'trades', 'snapshots', 'settings',
                      'journal', 'rules', 'rule_breaks', 'eps_override');
  if bad is not null then raise exception '個人資料表沒開 RLS：%', bad; end if;

  select string_agg(c.relname || '.' || p.polname, ', ') into bad
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname in ('stocks', 'futures', 'us_stocks', 'warrants', 'options',
                      'balances', 'trades', 'snapshots', 'settings',
                      'journal', 'rules', 'rule_breaks', 'eps_override')
    and (p.polroles = '{0}'::oid[]    -- 0 = PUBLIC，等於所有角色
         or 'anon' in (select rolname from pg_roles where oid = any (p.polroles)));
  if bad is not null then raise exception '個人資料表的 policy 開給匿名了：%', bad; end if;
end $$;
