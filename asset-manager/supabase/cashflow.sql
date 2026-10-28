-- ============================================================
-- 金流：每月預算、獎金、存錢目標、每月記帳（2026-10-28）
--
--   為什麼要有這個：淨資產回到 0 靠的是薪水加時間，不是交易。
--   每天看的數字要從「今天賺賠多少」換成「每個月淨資產往 0 走了多少」。
--
--   只新增表，不動任何既有資料。可以重跑（if not exists / drop policy if exists）。
--
--   cash_items.kind：
--     income   每月收入（實拿）
--     expense  每月支出（生活、訂閱……）；per = 'year' 的會除以 12
--     debt     固定還款（信貸）。rate = 年利率 %，只有利息算淨資產的流失，本金是還債
--     invest   每月投入（定期定額）——錢從現金搬到股票，淨資產不變
--     bonus    獎金：month = 發放月份，amount = 預估實拿
--     goal     存錢目標：amount = 目標、saved = 已存、due_date = 要用的日子。
--              目標是**一年內要花的錢，不放股市**（蜜月、旅遊）
-- ============================================================

create table if not exists public.cash_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('income','expense','debt','invest','bonus','goal')),
  name       text not null,
  amount     numeric not null default 0,
  currency   text not null default 'TWD',
  per        text not null default 'month' check (per in ('month','year')),
  month      smallint check (month between 1 and 12),
  due_date   date,
  saved      numeric,
  rate       numeric,
  note       text,
  sort       smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 每月 5 號發薪日記一次。net_assets 是記帳當下 App 算出來的淨資產，用來畫「往 0 走」的線
create table if not exists public.cash_months (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  month      date not null,
  overspend  numeric,
  net_assets numeric,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month)
);

do $$
declare t text;
begin
  foreach t in array array['cash_items','cash_months'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create index if not exists cash_items_user_idx  on public.cash_items(user_id);
create index if not exists cash_months_user_idx on public.cash_months(user_id);
