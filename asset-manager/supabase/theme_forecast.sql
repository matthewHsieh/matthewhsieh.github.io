-- ============================================================
-- 產業地圖：整體市場 vs 小眾領域的未來年化成長率
--
-- 這類資料沒有免費 API，是各研究機構發布的市場預測，只能人工整理。
--
-- **核心觀念：頭條 CAGR 幾乎都是「整體市場」，而 AI 相關的錢在小眾領域。**
-- 例如 CCL 整體只有 6%，但 AI 伺服器用的高速 CCL（M8/M9）完全是另一個世界，
-- 而且 M9 等級全球合格供應商不到五家。用整體數字會嚴重誤判。
--
-- 所以每個族群存兩組數字：
--   cagr        整體市場的年化成長率
--   niche_cagr  小眾領域的年化成長率（真正的成長來源）
--
-- 各家估計差異很大，能存區間就存區間。
-- 查證日期 2026-09-08。預測會過期，checked_on 就是重查的依據。
-- ============================================================

create table if not exists public.theme_info (
  theme      text primary key,
  cagr       numeric,      -- 整體市場預測年化成長率
  cagr_low   numeric,
  cagr_high  numeric,
  horizon    text,
  source     text,
  note       text,
  checked_on date,
  updated_at timestamptz not null default now()
);
-- 小眾領域欄位
alter table public.theme_info add column if not exists niche       text;
alter table public.theme_info add column if not exists niche_cagr  numeric;
alter table public.theme_info add column if not exists niche_low   numeric;
alter table public.theme_info add column if not exists niche_high  numeric;
alter table public.theme_info add column if not exists niche_note  text;

alter table public.theme_info enable row level security;
drop policy if exists "read theme info" on public.theme_info;
create policy "read theme info" on public.theme_info for select to authenticated using (true);

delete from public.theme_info;

insert into public.theme_info
  (theme, cagr, cagr_low, cagr_high, horizon, source, note,
   niche, niche_cagr, niche_low, niche_high, niche_note, checked_on) values

('CCL 銅箔基板', 0.061, 0.054, 0.071, '2024-2030', 'Grand View / IndustryArc / SMR',
 'CCL 整體市場含消費電子與車用等低成長板材',
 '高速 CCL（M8 / M9）', 0.342, null, null,
 'CCL 整體 2025 年 160 億 → 2026 年 215 億美元，年增 34%；其中高速 CCL 2026 年約 80 億美元。'
 'AI 伺服器規格已從 M4/M6（Hopper）走到 M8（GB200）、M8U/M8.5（GB300）、M9（Rubin）。'
 '**M9 等級全球合格供應商不到五家**，這是護城河所在。', date '2026-09-08'),

('銅箔', 0.061, null, null, '2024-2030', '同 CCL 產業鏈',
 '銅箔整體隨 CCL 與一般電子需求',
 'HVLP 高階銅箔', 0.342, null, null,
 '高速 CCL 必須搭配低稜線（HVLP）銅箔，需求隨 M8/M9 世代放大。'
 '一般電解銅箔與鋰電銅箔是完全不同的市場，成長慢很多。', date '2026-09-08'),

('PCB', 0.109, 0.048, 0.109, '2024-2030', 'KBV Research / Lucintel（HDI）',
 'HDI PCB 整體 4.8%～10.9%，各家差異大',
 'AI 伺服器高層板', null, null, null,
 'AI 伺服器主板層數與材料等級雙升，帶動 PCB 原料價格上漲最高 40%。'
 '沒查到獨立的 AI 伺服器 PCB 市場 CAGR，但台廠實際營收年增可當替代指標。', date '2026-09-08'),

('ABF 載板', 0.201, null, null, '2023-2030', 'Kings Research',
 'ABF 載板 10 億 → 44 億美元',
 'AI 晶片用大尺寸 ABF', null, null, null,
 'ABF 載板本身就已是先進封裝專用品，整體數字大致等於小眾數字。', date '2026-09-08'),

('玻璃基板', 0.040, null, null, '2024-2030', 'Diligence Insights',
 '玻璃基板整體市場 74 億 → 93 億美元，含顯示器等傳統用途',
 '先進封裝用玻璃基板', 0.400, null, null,
 '這是全新的市場，不是既有市場的延伸。產量預估 2025 年 100–200 萬片 → 2030 年 800–1,000 萬片，'
 '換算約 40% 年化。目前單價是有機 ABF 的 2–4 倍，隨量產預計降價 35–45%。'
 '台玻的轉型故事在這裡，不在那個 4%。', date '2026-09-08'),

('伺服器組裝', 0.280, 0.209, 0.347, '2024-2030', 'MarketsandMarkets / Grand View / Precedence',
 'AI 伺服器整體。各家 21%～35%，差異來自對「AI 伺服器」的定義不同',
 'AI 機櫃整機（GB200/GB300 NVL）', null, null, null,
 '從賣板子變成賣整櫃，單價與含金量大幅提高，但也更吃資金與交期。', date '2026-09-08'),

('散熱', 0.519, null, null, '2024-2030', 'ResearchAndMarkets',
 '這個數字本身就是 AI 細分，不是傳統散熱',
 '資料中心液冷', 0.519, null, null,
 '8.7 億 → 107 億美元。傳統氣冷散熱是低成長生意，兩者不要混為一談。', date '2026-09-08'),

('光通訊 CPO', 0.481, null, null, '2024-2030', 'TrendForce / LightCounting',
 '資料中心光互連整體 137 億 → 1,444 億美元',
 'CPO / NPO 共同封裝光學', null, null, null,
 'CPO/NPO 從 2025 年約 1 億 → 2030 年逾 390 億美元，是所有細分裡基期最低、倍數最大的。'
 '矽光子預計佔光互連營收的 63.7%。', date '2026-09-08'),

('網通', null, null, null, null, null,
 '沒查到網通整體的可靠數字',
 '800G / 1.6T 交換器', 0.355, 0.327, 0.385, '2024-2033/2034',
 date '2026-09-08'),

('記憶體', 0.268, 0.268, 0.681, '2024-2030', '多家',
 'HBM。估計從 27% 到 68% 都有，是所有族群裡分歧最大的',
 'HBM', 0.268, 0.268, 0.681,
 '傳統 DRAM/NAND 是循環股，看的是報價循環不是成長率，不適用 CAGR 思維。'
 '目前 DRAM 報價單季漲 90%，同時新增產能正在路上，這是循環尾聲的典型形態。', date '2026-09-08'),

('封測', 0.058, null, null, '2024-2030', 'NextMSC',
 'OSAT 整體 392 億 → 581 億美元，含大量成熟製程封測',
 '先進封裝', 0.122, 0.095, 0.148,
 'Yole 估 9.5% 至 794 億美元，另一家估 14.8% 至 876 億美元。'
 'CoWoS 等先進封裝產能 2025 年需求成長約 113%，短期遠高於長期均值。', date '2026-09-08'),

('晶圓代工', 0.074, null, null, '2025-2030', 'Research and Markets / Knowledge Sourcing',
 '代工整體 1,524 億 → 2,180 億美元。產能面 CAGR 僅 4.3%',
 '先進製程（3nm 以下）', null, null, null,
 '整體數字被成熟製程稀釋。台積電先進製程與 CoWoS 才是成長來源。'
 '中國大陸產能份額預估 2030 年達 30%，是結構性變數。', date '2026-09-08'),

('矽智財 ASIC', 0.072, null, null, '2026-2033', 'Persistence Market Research',
 'ASIC 設計服務整體 → 307 億美元',
 'AI ASIC 設計服務', null, null, null,
 '台灣的世芯、創意接的是雲端業者自研 AI 晶片訂單，成長遠高於整體數字。'
 '實際營收年增 +132% 就是證據。這個族群的整體 CAGR 幾乎沒有參考價值。', date '2026-09-08'),

('半導體設備', 0.100, null, null, '2024-2032', 'MarketsandMarkets',
 '設備整體 → 3,444 億美元',
 'AI 相關測試與封裝設備', null, null, null,
 '2025 年測試設備銷售成長 48%、組裝封裝設備成長 20%，短期遠高於長期均值。'
 '設備是循環性最強的次產業，資本支出一轉向就會急凍。', date '2026-09-08'),

('電源供應', 0.063, null, null, '2024-2030', 'IndustryARC',
 '資料中心交換式電源 → 111 億美元',
 '48V / HVDC AI 機櫃供電', null, null, null,
 'AI 機櫃單櫃功耗從數十 kW 走向 100kW 以上，供電架構整個換代。'
 '沒查到獨立的高壓直流供電市場 CAGR。', date '2026-09-08'),

('被動元件', null, null, null, null, null,
 '沒查到可靠的整體或 AI 細分數字',
 'AI 伺服器用 MLCC', null, null, null,
 'AI 伺服器單機 MLCC 用量遠高於一般伺服器，且與 AI 產能排擠效應同時發生而漲價，'
 '但沒有找到可引用的市場預測。實際營收年增 +48% 可當替代指標。', date '2026-09-08'),

('矽晶圓', null, null, null, null, null,
 '沒查到可靠數字',
 '300mm 先進製程用晶圓', null, null, null,
 '矽晶圓是重資本、長循環的上游，與 AI 需求的連動比下游慢。', date '2026-09-08'),

('IC 設計', null, null, null, null, null,
 '沒查到可靠的整體數字',
 null, null, null, null,
 '這個族群成分很雜，聯發科、瑞昱、聯詠的終端市場差異極大，'
 '用單一 CAGR 描述意義不大，建議看個股而非族群。', date '2026-09-08'),

('電子代工 EMS', null, null, null, null, null,
 '沒查到可靠數字',
 'AI 伺服器代工', null, null, null,
 'EMS 整體是低毛利、隨終端需求波動的生意。'
 '真正的差異在有沒有吃到 AI 伺服器訂單，這要看個股不是看族群。'
 '和碩實際營收年增僅 +12%，族群 +63%，落差就是這個原因。', date '2026-09-08');
