-- ============================================================
-- 資產管理系統 Supabase schema
-- 使用方式：Supabase Dashboard → SQL Editor → New query → 貼上整段 → Run
-- 可重複執行（idempotent），也可用來從舊版升級
-- ============================================================

create extension if not exists pgcrypto;

-- 共用：自動更新 updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ------------------------------------------------------------
-- 設定（每位使用者一列）：目標金額、美金匯率
-- ------------------------------------------------------------
create table if not exists public.settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  target_amount numeric not null default 0,      -- 目標淨資產 (TWD)
  usd_twd       numeric not null default 32,     -- USD → TWD 匯率（每日自動更新）
  updated_at    timestamptz not null default now()
);

-- 交易成本設定（稅率是法定的寫在程式裡，手續費因人而異所以可設定）
alter table public.settings add column if not exists fee_stock_rate    numeric default 0.001425; -- 台股手續費率
alter table public.settings add column if not exists fee_stock_disc    numeric default 1.0;      -- 一般折數
alter table public.settings add column if not exists fee_day_disc      numeric default 0.3;      -- 當沖折數
alter table public.settings add column if not exists fee_min           numeric default 20;       -- 每筆最低手續費
alter table public.settings add column if not exists fee_warrant_disc  numeric default 1.0;      -- 權證折數
alter table public.settings add column if not exists fee_fut_per_lot   numeric default 30;       -- 期貨每口，買賣各收一次
alter table public.settings add column if not exists fee_opt_per_lot   numeric default 25;       -- 選擇權每口，買賣各收一次
-- 下面兩個是一度誤解需求時加的，程式已不使用；留著只為不動既有欄位
alter table public.settings add column if not exists fee_fut_day_round numeric;
alter table public.settings add column if not exists fee_opt_day_round numeric;
alter table public.settings add column if not exists fee_us_rate       numeric default 0;        -- 複委託費率
alter table public.settings add column if not exists fee_us_min        numeric default 0;        -- 複委託最低（USD）

-- ------------------------------------------------------------
-- 台股持倉
-- ------------------------------------------------------------
create table if not exists public.stocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,                      -- 代號，例如 2330
  name       text,                               -- 名稱
  shares     numeric not null default 0,         -- 股數
  price      numeric not null default 0,         -- 現價（每日自動更新）
  cost       numeric,                            -- 平均成本
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 期貨部位
--   kind='index' 指數期貨：symbol 為期交所代碼(TX/MTX/TMF...)，size = 每點價值
--   kind='stock' 個股期貨：symbol 為標的股票代號(2330)，size = 等同股數
--                          大型股票期貨 = 2000 股（2 張）、小型 = 100 股
--   名目/曝險 = lots × price × size（兩者都計入曝險）
--   帳戶權益數不放這裡，改記在 balances(kind='futures_equity')，避免多筆部位重複計算
-- ------------------------------------------------------------
create table if not exists public.futures (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contract   text not null,                      -- 顯示名稱：台指期 / 台積電
  side       text not null default 'long' check (side in ('long','short')),
  lots       numeric not null default 1,         -- 口數
  price      numeric not null default 0,         -- 結算價 / 標的股價（每日自動更新）
  cost       numeric,                            -- 平均成本（選填，填了才算損益）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 舊版升級：新增 kind / symbol / size 欄位
alter table public.futures add column if not exists kind   text;
alter table public.futures add column if not exists symbol text;
alter table public.futures add column if not exists size   numeric;
alter table public.futures add column if not exists cost   numeric;

do $$
begin
  -- 舊欄位 multiplier → size
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='futures' and column_name='multiplier') then
    update public.futures set size = coalesce(size, multiplier);
    alter table public.futures drop column multiplier;
  end if;

  update public.futures set kind = coalesce(kind, 'index');
  update public.futures set size = coalesce(size, 200);
  update public.futures set symbol = coalesce(symbol, 'TX') where symbol is null or btrim(symbol) = '';

  alter table public.futures alter column kind set default 'index';
  alter table public.futures alter column kind set not null;
  alter table public.futures alter column size set default 200;
  alter table public.futures alter column size set not null;
  alter table public.futures alter column symbol set not null;

  if not exists (select 1 from pg_constraint where conname = 'futures_kind_check') then
    alter table public.futures add constraint futures_kind_check check (kind in ('index','stock'));
  end if;
end $$;

-- ------------------------------------------------------------
-- 複委託（美股，以 USD 計價）
-- ------------------------------------------------------------
create table if not exists public.us_stocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  name       text,
  shares     numeric not null default 0,
  price_usd  numeric not null default 0,         -- 每日自動更新
  cost_usd   numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 現金、負債、期貨權益數（同一張表，用 kind 區分）
--   cash           現金 / 存款        → 計入總資產
--   futures_equity 期貨帳戶權益數      → 計入總資產
--   liability      負債               → 從總資產扣除
-- ------------------------------------------------------------
create table if not exists public.balances (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null,
  name       text not null,                      -- 銀行活存 / 元大期貨 / 信貸 ...
  currency   text not null default 'TWD' check (currency in ('TWD','USD')),
  amount     numeric not null default 0,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  -- 舊版的 kind 只允許 cash/liability，放寬以容納 futures_equity
  if exists (select 1 from pg_constraint where conname = 'balances_kind_check') then
    alter table public.balances drop constraint balances_kind_check;
  end if;
  alter table public.balances add constraint balances_kind_check
    check (kind in ('cash','liability','futures_equity'));
end $$;

-- 舊版升級：把期貨部位上的 margin 搬成帳戶權益數，再移除欄位
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='futures' and column_name='margin') then
    insert into public.balances (user_id, kind, name, currency, amount, note)
    select user_id, 'futures_equity', '期貨帳戶權益數', 'TWD', sum(margin), '由舊版部位保證金自動轉入'
    from public.futures where coalesce(margin,0) <> 0 group by user_id;
    alter table public.futures drop column margin;
  end if;
end $$;

-- ------------------------------------------------------------
-- 台指選擇權部位（TXO，每點 50 元）
--   expiry 直接存期交所的到期代碼：202609 / 202609W2 / 202609F2 ...
--   price  = 目前權利金（點），每日自動更新
--   delta / forward 由伺服器每天用 Black-76 反推，不用手動輸入
--   資產面看權利金市值（買方為正、賣方為負）
--   曝險看 delta 曝險；最大風險另外算，不混進槓桿
-- ------------------------------------------------------------
create table if not exists public.options (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contract   text not null default 'TXO',
  expiry     text not null,
  strike     numeric not null,
  cp         text not null check (cp in ('call','put')),
  side       text not null default 'long' check (side in ('long','short')),
  lots       numeric not null default 1,
  price      numeric not null default 0,        -- 目前權利金（點），自動更新
  cost       numeric,                           -- 平均成本（點）
  size       numeric not null default 50,       -- 每點 50 元
  delta      numeric,                           -- 自動計算
  forward    numeric,                           -- 計算時用的隱含遠期指數
  iv_sqrt_t  numeric,                           -- 解出來的 σ√T，方便檢查
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 交易紀錄要能記選擇權
-- 放寬 market 允許值（只加不減，既有列不會被擋掉）
do $tm$ begin
  alter table public.trades drop constraint if exists trades_market_check;
  alter table public.trades add constraint trades_market_check
    check (market in ('tw','futures','us','option','warrant'));
end $tm$;
alter table public.trades add column if not exists opt_expiry text;
alter table public.trades add column if not exists opt_strike numeric;
alter table public.trades add column if not exists opt_cp     text;

-- ------------------------------------------------------------
-- 權證部位（券商發行的認購/認售權證，1 張 = 1000 單位）
--   ratio  = 行使比例，每單位可換的標的股數
--   曝險 = 張數 × 1000 × 行使比例 × delta × 標的股價
--   權證只能做買方，最大損失就是付出的權利金
--   iv 是從市價反推的隱含波動率。發行券商可以事後調降隱波，
--   這是 delta 抓不到的風險，所以要逐日留存變化。
-- ------------------------------------------------------------
create table if not exists public.warrants (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code             text not null,                 -- 權證代號，例如 030573
  name             text,
  cp               text check (cp in ('call','put')),
  underlying       text,                          -- 標的代號
  underlying_name  text,
  strike           numeric,
  ratio            numeric,                       -- 行使比例
  last_trade_date  date,
  category         text,                          -- 一般型 / 界限型 / 重設型
  lots             numeric not null default 1,    -- 張數
  price            numeric not null default 0,    -- 目前權證價（元/單位），自動更新
  cost             numeric,                       -- 成本（元/單位）
  underlying_price numeric,
  iv               numeric,                       -- 反推的隱含波動率，自動更新
  delta            numeric,                       -- 自動更新
  theta_day        numeric,                       -- 每日時間價值流失（元/單位），自動更新
  gearing          numeric,                       -- 實質槓桿，自動更新
  delta_override   numeric,                       -- 手動覆寫（界限型/重設型模型不適用時用）
  iv_override      numeric,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 權證基本資料快取（全站共用，非使用者資料；每週更新一次即可）
create table if not exists public.warrant_info (
  code            text primary key,
  name            text,
  cp              text,
  underlying      text,
  underlying_name text,
  strike          numeric,
  ratio           numeric,
  last_trade_date date,
  category        text,
  updated_at      timestamptz not null default now()
);
alter table public.warrant_info enable row level security;
drop policy if exists "read warrant info" on public.warrant_info;
create policy "read warrant info" on public.warrant_info for select to authenticated using (true);

-- 隱含波動率逐日紀錄：用來看發行券商有沒有偷偷調降隱波
create table if not exists public.warrant_iv_history (
  code             text not null,
  as_of            date not null,
  iv               numeric,
  price            numeric,
  underlying_price numeric,
  primary key (code, as_of)
);
alter table public.warrant_iv_history enable row level security;
drop policy if exists "read iv history" on public.warrant_iv_history;
create policy "read iv history" on public.warrant_iv_history for select to authenticated using (true);

-- 交易紀錄要能記權證
alter table public.trades add column if not exists war_code text;
-- 當沖：買賣自成一組結算，完全不動長期部位的股數與均價
alter table public.trades add column if not exists is_day_trade boolean default false;

-- ------------------------------------------------------------
-- 交易紀錄：記一筆買/賣，App 會自動更新對應的部位
-- ------------------------------------------------------------
create table if not exists public.trades (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  trade_date  date not null default current_date,
  market      text not null check (market in ('tw','futures','us')),
  symbol      text not null,                   -- 台股/個股期貨標的代號、指數期貨代碼、美股代號
  name        text,
  side        text not null check (side in ('buy','sell')),
  quantity    numeric not null,                -- 台股、美股為股數；期貨為口數
  price       numeric not null,                -- 台股、期貨 TWD；美股 USD
  prev_shares numeric,                         -- 套用前的部位，刪除交易時用來還原
  prev_cost   numeric,
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.trades add column if not exists fut_kind text;   -- 'index' | 'stock'
alter table public.trades add column if not exists fut_size numeric;
-- 已實現損益：賣出（或回補空單）時，用當時的平均成本算出來的損益
-- 買進為 null。美股記在 USD，其餘 TWD。當沖也是靠這個欄位呈現。
alter table public.trades add column if not exists realized_pl  numeric;
alter table public.trades add column if not exists realized_ccy text;

-- ------------------------------------------------------------
-- 快照：每天最多一筆，記錄當時算出的總數與槓桿
-- ------------------------------------------------------------
create table if not exists public.snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  snap_date         date not null default current_date,
  price_as_of       date,         -- 這筆是用哪一天的行情算的（來源可能比當天晚發布）
  option_value      numeric,      -- 選擇權權利金市值（買方正、賣方負）
  option_exposure   numeric,      -- 選擇權 delta 曝險（絕對值加總）
  warrant_value     numeric,      -- 權證市值
  warrant_exposure  numeric,      -- 權證 delta 曝險
  total_assets      numeric,
  liabilities       numeric,
  net_assets        numeric,
  stock_value       numeric,
  us_value          numeric,      -- 複委託市值（已換算 TWD）
  futures_margin    numeric,      -- 期貨帳戶權益數
  futures_notional  numeric,      -- 期貨名目總額（多+空，含個股期貨）
  cash              numeric,
  leverage_asset    numeric,      -- 槓桿①：總資產 / 淨資產
  leverage_exposure numeric,      -- 槓桿②：總曝險 / 淨資產
  target_amount     numeric,
  note              text,
  created_at        timestamptz not null default now(),
  unique (user_id, snap_date)
);

-- ------------------------------------------------------------
-- updated_at triggers
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','stocks','futures','us_stocks','balances','options','warrants'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- Row Level Security：每個人只能看到 / 改自己的資料
-- （anon key 可以放在前端，因為有 RLS 保護）
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','stocks','futures','us_stocks','balances','snapshots','trades','options','warrants'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
end $$;

-- 索引
create index if not exists stocks_user_idx    on public.stocks(user_id);
create index if not exists futures_user_idx   on public.futures(user_id);
create index if not exists us_stocks_user_idx on public.us_stocks(user_id);
create index if not exists balances_user_idx  on public.balances(user_id);
alter table public.snapshots add column if not exists price_as_of date;
alter table public.snapshots add column if not exists option_value numeric;
alter table public.snapshots add column if not exists option_exposure numeric;
alter table public.snapshots add column if not exists warrant_value numeric;
alter table public.snapshots add column if not exists warrant_exposure numeric;
create index if not exists snapshots_user_idx on public.snapshots(user_id, snap_date desc);
create index if not exists trades_user_idx    on public.trades(user_id, trade_date desc, created_at desc);
create index if not exists options_user_idx   on public.options(user_id);
create index if not exists warrants_user_idx  on public.warrants(user_id);
create index if not exists warrant_info_ul_idx on public.warrant_info(underlying);
