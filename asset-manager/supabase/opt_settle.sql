-- ============================================================
-- 台指選擇權各到期別的「契約到期日」（期交所公布的權威值）
--
-- 為什麼需要這張表：`instruments.js` 的 `optSettleISO()` 用
-- 「當月第 n 個週三（W 系列）／週五（F 系列）」推算結算日，**沒有假日順延**。
-- 期交所遇到結算日是假日會順延到次一營業日，於是：
--   2026 年 10 月的第 2 個週五是 10/09，但那天是國慶補假，
--   期交所公布 202610F2 的契約到期日是 **10/12**。
-- 後果不是差一天而已 —— `optExpired()` 會回 true，所以一張**還活著的合約**
-- 被標成「已到期」，`optDaysLeft()` 變負的，到期損益的漲跌幅上下界也塌成現價。
--
-- 為什麼不自己維護假日曆：每年要更新一次、而且漏一個就是同一個 bug 再來一遍。
-- 期交所的每日選擇權行情表本來就有「契約到期日」這一欄，那是權威來源。
--
-- 注意：openapi 的 `DailyMarketReportOpt`（JSON）**沒有**這一欄，
-- 只有 HTML 版 `https://www.taifex.com.tw/cht/3/optDailyMarketReport` 有
-- （欄位順序：契約 / 到期月份(週別) / **契約到期日** / 履約價 / 買賣權 / ...）。
-- 所以抓取走 Node（scripts/fetch-opt-settle.mjs），不放進資料庫的排程。
--
-- 更新頻率：一個到期別掛牌之後它的到期日就不會變，所以一週跑一次就夠；
-- 新的週選掛牌時會自己補進來。
--
-- 期貨那邊（`futSettleISO`，當月第三個週三）有完全相同的問題，
-- 但期貨的 openapi 與 HTML 報表都沒有契約到期日欄位，要另外找來源，先不處理。
-- ============================================================

create table if not exists public.opt_settle (
  expiry      text primary key,   -- 到期月份(週別)，例如 202610、202610W2、202610F2
  settle_date date not null,       -- 期交所公布的契約到期日
  src         text,
  as_of       date,                -- 這筆是哪一天的報表抓到的
  updated_at  timestamptz not null default now()
);

alter table public.opt_settle enable row level security;
drop policy if exists "read opt settle" on public.opt_settle;
create policy "read opt settle" on public.opt_settle for select to authenticated using (true);

grant select on public.opt_settle to authenticated;
