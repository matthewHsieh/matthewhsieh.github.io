-- ============================================================
-- 股票期貨保證金率（每檔不同，會隨級距調整與處置而變）
--
-- 為什麼需要這張表：risk.js 原本用一個固定的 `IM_RATE = 13.5%`、
-- `MM_RATE = IM_RATE * 0.75 = 10.125%`。那是「級距1」的數字，
-- 而期交所的實際級距是三級，處置股票還會個別調高：
--   級距1  維持 10.35%  原始 13.50%   （77 檔）
--   級距2  維持 12.42%  原始 16.20%   （74 檔）
--   級距3  維持 15.53%  原始 20.25%   （87 檔）
--   個別調整（無級距）                （11 檔，例如 2026-10 的金居 維持 17.60%）
-- 2026-10-09 用他當時的部位實測：加權維持率 15.81%，而程式用 10.125%，
-- 少算 80.5 萬的維持保證金 —— 追繳距離會顯示 14.2% 而真實是 10.2%，
-- **把安全度高估 39%**。這是會讓人在該減倉的時候覺得還有空間的那種錯。
--
-- 另外期交所還有一張「固定金額」表（21 檔），單位是元／口而不是比例，
-- 一併收進來（mm_amt / im_amt）。兩者都有的話以比例為準，只有金額的用金額。
--
-- 資料來源：https://www.taifex.com.tw/cht/5/stockMargining
--   頁面上有兩張表：比例表（9 欄，含「保證金所屬級距」）與固定金額表（8 欄）。
--   同一個標的證券代號會出現兩次（大型與小型各一行，英文代碼不同），
--   **但兩者的比例相同**，所以用標的代號當 primary key 就自動去重。
--   2026-10-07 曾經因為沒去重、按行數加權，算出 19.44% 的錯誤加權率
--   與 4.8% 的追繳距離（真實是 15.55% 與 9.2%）。
--
-- 更新頻率：保證金率只在期交所季度調整級距或個股進出處置時變動，
-- 一週一次就夠。重跑方式：node scripts/fetch-fut-margin.mjs
-- （不做成資料庫函式是因為要解 HTML，plpgsql 做這個很痛，
--  而且這張表不需要跟著行情排程走。）
-- ============================================================

create table if not exists public.fut_margin (
  symbol      text primary key,   -- 股票期貨標的證券代號
  codes       text,               -- 期貨英文代碼，大型／小型用 / 分隔
  name        text,
  tier        text,               -- 保證金所屬級距；空的代表個別調整
  settle_rate numeric,            -- 結算保證金適用比例
  mm_rate     numeric,            -- 維持保證金適用比例  ← 算追繳距離用這個
  im_rate     numeric,            -- 原始保證金適用比例
  settle_amt  numeric,            -- 固定金額表：結算保證金（元／口）
  mm_amt      numeric,            -- 固定金額表：維持保證金（元／口）
  im_amt      numeric,            -- 固定金額表：原始保證金（元／口）
  as_of       date,
  src         text,
  updated_at  timestamptz not null default now()
);

alter table public.fut_margin enable row level security;
drop policy if exists "read fut margin" on public.fut_margin;
create policy "read fut margin" on public.fut_margin for select to authenticated using (true);

grant select on public.fut_margin to authenticated;
