-- ============================================================
-- 換股法的名單，以及「家人委託」的現股（2026-10-30）
--
-- rotation_list：每一期（換股日）的正式名單。rebalance.mjs 跑出來、使用者確認過的那份。
--   App 用最新一期判斷一個部位是「名單內」還是「名單外」：
--     • 名單外的部位有上限（規則 off_list_cap，金額 = 總曝險的 %）；
--     • 名單外、留過夜的買進會進心得頁的記分板，算 20 個交易日後贏大盤多少。
--   每一期一份，不覆蓋舊的：記分板判斷「名單外」要用**那一天**有效的那一期。
--
-- stocks.sleeve：家人放在他帳戶裡、只准買指定現股的錢。那是獨立的 1 倍部位，
--   算進總資產與淨資產，但不算進槓桿與名單外的分母分子——
--   否則借來的錢會讓槓桿看起來變低，App 就會說還能再加。
-- ============================================================

create table if not exists public.rotation_list (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  period     date not null,
  symbol     text not null,
  name       text,
  note       text,
  created_at timestamptz not null default now(),
  unique (user_id, period, symbol)
);

alter table public.rotation_list enable row level security;
drop policy if exists "own rows" on public.rotation_list;
create policy "own rows" on public.rotation_list for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.rotation_list from anon;
create index if not exists rotation_list_user_idx on public.rotation_list(user_id, period desc);

alter table public.stocks add column if not exists sleeve boolean not null default false;
comment on column public.stocks.sleeve is
  '家人委託的獨立 1 倍部位：算進總資產，不算進槓桿與名單外上限';
