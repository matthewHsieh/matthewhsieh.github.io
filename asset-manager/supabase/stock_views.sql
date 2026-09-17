-- ============================================================
-- 主觀看法：把「我覺得這個產業會好」放進配置計算
--
--   最佳化用的預期報酬目前全部來自過去三年的比值。那是回頭看的數字，
--   看不到「這個產業明年才要起來」或「這檔數字漂亮但故事已經走完」。
--   使用者要能自己加進去。
--
--   **調整量放在「比值」而不是「報酬」。**
--   同樣 +0.5 的比值，在波動 60% 的股票上等於 +30%/年、在波動 25% 的
--   股票上等於 +12.5%/年——這才是對的縮放。看法講的是「每承受一單位風險
--   值不值得」，不是「會漲幾 %」，而後者他也估不準。
--
--   刻意只給五格而不是讓他填數字：**填數字會產生一種精確的錯覺**。
--   看法是序位判斷，給序位就好。
--     +2 很看好 → 比值 +1.0    +1 看好 → +0.5
--      0 中性   →  0
--     −1 看壞   → −0.5        −2 很看壞 → −1.0
--   對照：加權指數的比值 1.76，前段個股 2~3.4。一格 0.5 挪得動排名，
--   但挪不到「從最後一名變第一名」，這是刻意的。
--
--   **這是使用者資料，程式更新不會動它。**
-- ============================================================
create table if not exists public.stock_views (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  symbol     text not null,
  score      smallint not null default 0,
  note       text,
  updated_at timestamptz not null default now(),
  primary key (user_id, symbol),
  constraint stock_views_score_range check (score between -2 and 2)
);

alter table public.stock_views enable row level security;
drop policy if exists "own stock views" on public.stock_views;
create policy "own stock views" on public.stock_views for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.stock_views is
  '對個股的主觀看法，−2~+2。配置計算時換算成比值的 ±0.5/格。';
