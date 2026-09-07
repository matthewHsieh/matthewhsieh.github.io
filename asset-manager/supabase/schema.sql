-- ============================================================
-- 資產管理系統 Supabase schema
-- 使用方式：Supabase Dashboard → SQL Editor → New query → 貼上整段 → Run
-- 可重複執行（idempotent）
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
  usd_twd       numeric not null default 32,     -- USD → TWD 匯率
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
  price      numeric not null default 0,         -- 現價
  cost       numeric,                            -- 平均成本（選填）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 期貨部位
-- 名目價值 = lots × price × multiplier
-- 資產面只計 margin（帳戶權益 / 保證金）
-- ------------------------------------------------------------
create table if not exists public.futures (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  contract   text not null,                      -- 商品：台指期 / 小台 / 微台 ...
  side       text not null default 'long' check (side in ('long','short')),
  lots       numeric not null default 1,         -- 口數
  price      numeric not null default 0,         -- 目前價格（指數）
  multiplier numeric not null default 200,       -- 每點價值：大台 200 / 小台 50 / 微台 10
  margin     numeric not null default 0,         -- 帳戶權益 / 保證金 (TWD)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 複委託（美股，以 USD 計價）
-- ------------------------------------------------------------
create table if not exists public.us_stocks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  name       text,
  shares     numeric not null default 0,
  price_usd  numeric not null default 0,
  cost_usd   numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 現金 與 負債（同一張表，用 kind 區分）
-- ------------------------------------------------------------
create table if not exists public.balances (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('cash','liability')),
  name       text not null,                      -- 銀行活存 / 信貸 / 股票質押 ...
  currency   text not null default 'TWD' check (currency in ('TWD','USD')),
  amount     numeric not null default 0,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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
  futures_margin    numeric,
  futures_notional  numeric,      -- 期貨名目總額（多+空）
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
  foreach t in array array['settings','stocks','futures','us_stocks','balances','snapshots'] loop
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
