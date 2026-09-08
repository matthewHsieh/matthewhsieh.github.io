-- ============================================================
-- 族群的「未來年化成長率」預測（人工維護）
--
-- 這類資料沒有免費 API，是各研究機構發布的市場預測，只能人工整理。
-- 各家估計差異很大，所以同時存區間，不要只看單一數字。
--
-- **最重要的一件事：頭條 CAGR 常常不是你要的那個數字。**
-- 很多族群的整體市場成長很慢，但 AI 相關的細分成長極快。
-- 例如一般 CCL 只有 6%，但 AI 伺服器用的高速 CCL 完全是另一回事
-- （台光電實際營收年增 +129% 就是證據）。
-- 所以 note 欄位要寫清楚這個數字涵蓋的是整體還是細分。
--
-- 查證日期 2026-09-08。過期了就重查，別讓舊預測誤導判斷。
-- ============================================================

create table if not exists public.theme_info (
  theme      text primary key,
  cagr       numeric,      -- 預測年化成長率（中位或代表值）
  cagr_low   numeric,      -- 各家估計下緣
  cagr_high  numeric,      -- 各家估計上緣
  horizon    text,         -- 預測期間
  source     text,
  note       text,         -- 這個數字涵蓋整體還是細分，務必說明
  checked_on date,
  updated_at timestamptz not null default now()
);
alter table public.theme_info enable row level security;
drop policy if exists "read theme info" on public.theme_info;
create policy "read theme info" on public.theme_info for select to authenticated using (true);

delete from public.theme_info;

insert into public.theme_info (theme, cagr, cagr_low, cagr_high, horizon, source, note, checked_on) values
('散熱',          0.519, null,  null,  '2024-2030', 'ResearchAndMarkets',
 '資料中心液冷，8.7 億 → 107 億美元。這是純 AI 細分，不含傳統散熱', date '2026-09-08'),

('光通訊 CPO',    0.481, null,  null,  '2024-2030', 'TrendForce / LightCounting',
 '資料中心光互連整體 137 億 → 1,444 億美元；其中 CPO/NPO 從約 1 億 → 390 億美元', date '2026-09-08'),

('伺服器組裝',    0.280, 0.209, 0.347, '2024-2030', 'MarketsandMarkets / Grand View / Precedence',
 'AI 伺服器整體。各家估計 21%～35% 差距很大，因為對「AI 伺服器」定義不同', date '2026-09-08'),

('記憶體',        0.268, 0.268, 0.681, '2024-2030', '多家',
 'HBM。估計從 27% 到 68% 都有，是所有族群裡分歧最大的。傳統 DRAM/NAND 是循環股，不適用', date '2026-09-08'),

('ABF 載板',      0.201, null,  null,  '2023-2030', 'Kings Research',
 'ABF 載板 10 億 → 44 億美元', date '2026-09-08'),

('半導體設備',    0.100, null,  null,  '2024-2032', 'MarketsandMarkets',
 '設備整體。2025 年測試設備成長 48%、封裝設備 20%，短期遠高於長期均值', date '2026-09-08'),

('矽智財 ASIC',   0.072, null,  null,  '2026-2033', 'Persistence Market Research',
 'ASIC 設計服務整體 → 307 億美元。台灣的世芯、創意接的是 AI ASIC 訂單，成長遠高於此', date '2026-09-08'),

('CCL 銅箔基板',  0.061, 0.054, 0.071, '2024-2030', 'Grand View / IndustryArc / SMR',
 '⚠ 這是 CCL 整體市場。AI 伺服器用的高速 CCL（M8/M9）是高成長細分，成長遠高於整體', date '2026-09-08'),

('銅箔',          0.061, null,  null,  '2024-2030', '同 CCL',
 '⚠ 隨 CCL 整體。AI 用高階銅箔（HVLP）是另一個等級', date '2026-09-08'),

('封測',          0.058, null,  null,  '2024-2030', 'NextMSC',
 '⚠ OSAT 整體 392 億 → 581 億美元。先進封裝細分成長遠高於此', date '2026-09-08'),

('玻璃基板',      0.040, null,  null,  '2024-2030', 'Diligence Insights',
 '⚠ 這是玻璃基板整體市場 74 億 → 93 億美元。先進封裝用玻璃基板是全新的高成長細分，'
 '產量預估 2025 年 100-200 萬片 → 2030 年 800-1,000 萬片', date '2026-09-08');

-- 其餘族群尚未查證，刻意留空而不是填假數字
