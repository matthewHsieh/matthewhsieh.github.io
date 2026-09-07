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

-- ------------------------------------------------------------
-- 快照：每天最多一筆，記錄當時算出的總數與槓桿
-- ------------------------------------------------------------
create table if not exists public.snapshots (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  snap_date         date not null default current_date,
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
  foreach t in array array['settings','stocks','futures','us_stocks','balances'] loop
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
  foreach t in array array['settings','stocks','futures','us_stocks','balances','snapshots','trades'] loop
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
create index if not exists snapshots_user_idx on public.snapshots(user_id, snap_date desc);
create index if not exists trades_user_idx    on public.trades(user_id, trade_date desc, created_at desc);
