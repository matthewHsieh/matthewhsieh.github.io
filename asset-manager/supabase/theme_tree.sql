-- ============================================================
-- 產業樹與供應鏈關係
--
-- 原本族群是一張平的清單，39 個並排，看不出誰餵誰。
-- 這裡補兩件事：
--   theme_meta   每個族群屬於哪個大類、在供應鏈的哪一段（上游/中游/下游）
--   theme_links  誰是誰的上游（src → dst 代表 src 出貨給 dst）
--
-- 有了這兩張表就能畫出樹狀圖與關係圖：
--   樹狀圖＝大類 → 族群 → 成分股
--   關係圖＝點一個族群，看它的上游餵它什麼、它又餵給誰
--
-- 為什麼值得做：投資 AI 供應鏈最常犯的錯是「買到同一個部位三次」。
-- 使用者的台玻、金居、和碩看起來是三檔，但玻纖布→CCL→PCB 是同一條鏈，
-- 攤開來看才知道自己重複押注在哪一段。
-- ============================================================

create table if not exists public.theme_meta (
  market text not null,          -- tw / us
  theme  text not null,
  parent text not null,          -- 大類
  stage  text,                   -- 上游 / 中游 / 下游
  sort   smallint not null default 0,
  primary key (market, theme)
);
alter table public.theme_meta enable row level security;
drop policy if exists "read theme meta" on public.theme_meta;
create policy "read theme meta" on public.theme_meta for select to authenticated using (true);

create table if not exists public.theme_links (
  market text not null,
  src    text not null,          -- 上游
  dst    text not null,          -- 下游
  note   text,                   -- 這條關係實際上在賣什麼
  primary key (market, src, dst)
);
alter table public.theme_links enable row level security;
drop policy if exists "read theme links" on public.theme_links;
create policy "read theme links" on public.theme_links for select to authenticated using (true);

delete from public.theme_meta where true;
delete from public.theme_links where true;

-- ── 台股 ─────────────────────────────────────────
insert into public.theme_meta (market, theme, parent, stage, sort) values
('tw', '矽晶圓',        '半導體製造', '上游', 1),
('tw', '半導體材料',    '半導體製造', '上游', 2),
('tw', '半導體設備',    '半導體製造', '上游', 3),
('tw', '無塵室廠務',    '半導體製造', '上游', 4),
('tw', '晶圓代工',      '半導體製造', '中游', 5),
('tw', '封測',          '半導體製造', '中游', 6),
('tw', '測試設備',      '半導體製造', '上游', 5),
('tw', '測試介面',      '半導體製造', '中游', 7),
('tw', '檢測分析',      '半導體製造', '中游', 8),

('tw', 'IC 設計',       'IC 設計',    '中游', 1),
('tw', '矽智財 ASIC',   'IC 設計',    '中游', 2),
('tw', '高速傳輸 IC',   'IC 設計',    '中游', 3),

('tw', '記憶體',        '記憶體',     '中游', 1),
('tw', '記憶體模組',    '記憶體',     '下游', 2),

('tw', '玻纖布',        '載板與電路板', '上游', 1),
('tw', '銅箔',          '載板與電路板', '上游', 2),
('tw', '玻璃基板',      '載板與電路板', '上游', 3),
('tw', 'PCB 設備耗材', '載板與電路板', '上游', 4),
('tw', 'CCL 銅箔基板',  '載板與電路板', '中游', 4),
('tw', 'PCB',           '載板與電路板', '中游', 5),
('tw', 'ABF 載板',      '載板與電路板', '中游', 6),

('tw', '散熱',          '伺服器硬體', '中游', 1),
('tw', '液冷',          '伺服器硬體', '中游', 2),
('tw', '機殼機構件',    '伺服器硬體', '中游', 3),
('tw', '連接器',        '伺服器硬體', '中游', 4),
('tw', '伺服器組裝',    '伺服器硬體', '下游', 5),
('tw', '電子代工 EMS',  '伺服器硬體', '下游', 6),

('tw', '光通訊 CPO',    '網通光通訊', '中游', 1),
('tw', '網通',          '網通光通訊', '下游', 2),

('tw', 'MLCC 電容',     '被動元件',   '中游', 1),
('tw', '石英元件',      '被動元件',   '中游', 2),
('tw', '電阻電感',      '被動元件',   '中游', 3),

('tw', '電線電纜',      '電力與機房', '上游', 1),
('tw', '重電電網',      '電力與機房', '中游', 2),
('tw', '電源供應',      '電力與機房', '中游', 3),
('tw', 'BBU 備援電池', '電力與機房', '中游', 4),
('tw', 'IDC 資料中心',  '電力與機房', '下游', 5),

('tw', '工業電腦',      '非 AI 主題', '下游', 1),
('tw', '光學鏡頭',      '非 AI 主題', '下游', 2),
('tw', '機器人自動化',  '非 AI 主題', '下游', 3),
('tw', '航太國防',      '非 AI 主題', '下游', 4),
('tw', '低軌衛星',      '非 AI 主題', '下游', 6),
('tw', '生技 CDMO',     '非 AI 主題', '下游', 5);

-- 台股供應鏈：src 出貨給 dst
insert into public.theme_links (market, src, dst, note) values
('tw', '矽晶圓',       '晶圓代工',     '晶圓'),
('tw', '半導體材料',   '晶圓代工',     '光阻、CMP 耗材、特化'),
('tw', '半導體設備',   '晶圓代工',     '製程設備'),
('tw', '無塵室廠務',   '晶圓代工',     '廠房與二次配管，領先設備一到兩季'),
('tw', '半導體設備',   '封測',         '封裝與測試設備'),
('tw', '無塵室廠務',   '封測',         '先進封裝廠擴建'),
('tw', 'IC 設計',      '晶圓代工',     '投片'),
('tw', '矽智財 ASIC',  '晶圓代工',     '雲端業者自研晶片的投片'),
('tw', '高速傳輸 IC',  '晶圓代工',     '投片'),
('tw', '晶圓代工',     '封測',         '晶圓'),
('tw', '測試設備',     '封測',         '測試機台與分選機，這是資本支出'),
('tw', '測試介面',     '封測',         '探針卡與測試座，是耗材不是設備'),
('tw', '檢測分析',     '封測',         '失效分析，先進封裝愈複雜需求愈大'),
('tw', 'ABF 載板',     '封測',         '覆晶封裝基板'),

('tw', '玻纖布',       'CCL 銅箔基板', '低介電玻纖布，M8 以上的真正瓶頸'),
('tw', '銅箔',         'CCL 銅箔基板', 'HVLP 低稜線銅箔'),
('tw', 'CCL 銅箔基板', 'PCB',          '高速板材'),
('tw', 'PCB 設備耗材', 'PCB',          '鑽針、電鍍藥水、乾膜、鑽孔機、AOI'),
('tw', 'PCB 設備耗材', 'ABF 載板',     '載板製程設備與耗材'),
('tw', 'CCL 銅箔基板', 'ABF 載板',     '載板用基材'),
('tw', '玻璃基板',     'ABF 載板',     '先進封裝的下一代基板，會取代部分有機 ABF'),
('tw', 'PCB',          '伺服器組裝',   'AI 伺服器主板'),
('tw', 'PCB',          '低軌衛星',     '衛星太空板與地面站板（華通、燿華）'),

('tw', '封測',         '伺服器組裝',   '封裝好的加速器'),
('tw', '記憶體',       '記憶體模組',   'DRAM 與 NAND 顆粒'),
('tw', '記憶體',       '伺服器組裝',   'HBM 與伺服器記憶體'),
('tw', '散熱',         '伺服器組裝',   '風扇、均熱片、冷板'),
('tw', '液冷',         '伺服器組裝',   'CDU、快接頭、分歧管'),
('tw', '機殼機構件',   '伺服器組裝',   '機櫃、滑軌、鈑金'),
('tw', '連接器',       '伺服器組裝',   '高速連接器與 NVLink 銅纜'),
('tw', '電源供應',     '伺服器組裝',   '機櫃供電與 BBU'),
('tw', 'BBU 備援電池', '伺服器組裝',   '機櫃內的備援電池，取代傳統大型 UPS'),
('tw', 'MLCC 電容',    '伺服器組裝',   '單片 baseboard 兩萬顆'),
('tw', '電阻電感',     '電源供應',     '一體成型電感'),
('tw', '石英元件',     '網通',         '時脈同步'),
('tw', '光通訊 CPO',   '網通',         '光模組與矽光子'),
('tw', '連接器',       '網通',         'OSFP 籠體'),

('tw', '伺服器組裝',   'IDC 資料中心', '整櫃出貨'),
('tw', '電子代工 EMS', '伺服器組裝',   '代工產能'),
('tw', '網通',         'IDC 資料中心', '交換器'),
('tw', '電線電纜',     '重電電網',     '電力電纜'),
('tw', '重電電網',     'IDC 資料中心', '變壓器與開關，交期以年計'),
('tw', '機器人自動化', '電子代工 EMS', '產線自動化');

-- ── 美股 ─────────────────────────────────────────
insert into public.theme_meta (market, theme, parent, stage, sort) values
('us', '微影設備',          '半導體製造', '上游', 1),
('us', '沉積 蝕刻設備',     '半導體製造', '上游', 2),
('us', '量測 檢測設備',     '半導體製造', '上游', 3),
('us', '設備零組件 材料',   '半導體製造', '上游', 4),
('us', '晶圓代工',          '半導體製造', '中游', 5),
('us', '封測 測試設備',     '半導體製造', '中游', 6),

('us', 'GPU 通用加速器',    '運算核心',   '中游', 1),
('us', '客製 ASIC XPU',     '運算核心',   '中游', 2),
('us', 'EDA 設計工具',      '運算核心',   '上游', 3),
('us', '矽智財 IP',         '運算核心',   '上游', 4),
('us', '邊緣 AI 終端晶片',  '運算核心',   '中游', 5),
('us', '類比 電源管理 IC',  '運算核心',   '中游', 6),

('us', 'PCIe CXL Retimer',  '互連',       '中游', 1),
('us', '光通訊晶片 DSP',    '互連',       '中游', 2),
('us', '雷射 光元件',       '互連',       '上游', 3),
('us', '光模組 光傳輸',     '互連',       '中游', 4),
('us', '連接器 光纖',       '互連',       '中游', 5),
('us', '資料中心交換器',    '互連',       '下游', 6),

('us', 'DRAM HBM',          '記憶與儲存', '中游', 1),
('us', 'NAND SSD',          '記憶與儲存', '中游', 2),
('us', '硬碟 企業儲存',     '記憶與儲存', '下游', 3),

('us', '伺服器 ODM 品牌',   '伺服器硬體', '下游', 1),
('us', 'EMS 電子代工',      '伺服器硬體', '中游', 2),
('us', '液冷 機房散熱',     '伺服器硬體', '中游', 3),
('us', 'HVAC 冷卻設備',     '伺服器硬體', '中游', 4),

('us', '電力設備 開關',     '電力與機房', '中游', 1),
('us', '發電設備 渦輪機',   '電力與機房', '中游', 2),
('us', '資料中心工程營造',  '電力與機房', '中游', 3),
('us', '電力供應商 IPP',    '電力與機房', '上游', 4),
('us', '小型模組核能 SMR',  '電力與機房', '上游', 5),
('us', '鈾 核燃料',         '電力與機房', '上游', 6),
('us', '資料中心 REIT',     '電力與機房', '下游', 7),
('us', 'AI 算力租賃',       '電力與機房', '下游', 8),

('us', '雲端超大規模',      '需求端',     '下游', 1),
('us', 'AI 應用軟體',       '需求端',     '下游', 2),
('us', '資料庫 可觀測性',   '需求端',     '下游', 3),
('us', '資安',              '需求端',     '下游', 4),

('us', '太空 衛星',         '非 AI 主題', '下游', 1),
('us', '銅 礦業',           '非 AI 主題', '上游', 2);

insert into public.theme_links (market, src, dst, note) values
('us', '微影設備',         '晶圓代工',        'EUV 曝光機，全球獨佔'),
('us', '沉積 蝕刻設備',    '晶圓代工',        '製程設備'),
('us', '量測 檢測設備',    '晶圓代工',        '良率控制'),
('us', '設備零組件 材料',  '沉積 蝕刻設備',   '次系統與耗材'),
('us', '設備零組件 材料',  '晶圓代工',        '製程材料'),
('us', 'EDA 設計工具',     'GPU 通用加速器',  '設計工具'),
('us', 'EDA 設計工具',     '客製 ASIC XPU',   '設計工具'),
('us', '矽智財 IP',        '客製 ASIC XPU',   'CPU 與介面 IP'),
('us', 'GPU 通用加速器',   '晶圓代工',        '投片'),
('us', '客製 ASIC XPU',    '晶圓代工',        '雲端業者自研晶片投片'),
('us', '晶圓代工',         '封測 測試設備',   '晶圓'),
('us', 'DRAM HBM',         'GPU 通用加速器',  'HBM 直接貼在加速器上'),

('us', '雷射 光元件',      '光模組 光傳輸',   '雷射與光學元件'),
('us', '光通訊晶片 DSP',   '光模組 光傳輸',   'DSP 與驅動'),
('us', '光模組 光傳輸',    '資料中心交換器',  '光模組'),
('us', '連接器 光纖',      '資料中心交換器',  '籠體與光纖'),
('us', 'PCIe CXL Retimer', '伺服器 ODM 品牌', '訊號重整，每代規格升級多一顆'),
('us', '連接器 光纖',      '伺服器 ODM 品牌', '高速連接器'),
('us', '類比 電源管理 IC', '伺服器 ODM 品牌', '供電'),

('us', 'GPU 通用加速器',   '伺服器 ODM 品牌', '加速器'),
('us', '客製 ASIC XPU',    '伺服器 ODM 品牌', '自研加速器'),
('us', 'NAND SSD',         '伺服器 ODM 品牌', '企業級 SSD'),
('us', '硬碟 企業儲存',    '伺服器 ODM 品牌', '近線儲存'),
('us', '液冷 機房散熱',    '伺服器 ODM 品牌', 'CDU 與冷板'),
('us', 'EMS 電子代工',     '伺服器 ODM 品牌', '代工產能'),
('us', 'HVAC 冷卻設備',    '資料中心 REIT',   '機房空調'),

('us', '鈾 核燃料',        '電力供應商 IPP',  '核燃料'),
('us', '小型模組核能 SMR', '電力供應商 IPP',  '新增機組，目前營收趨近於零'),
('us', '發電設備 渦輪機',  '電力供應商 IPP',  '燃氣渦輪機'),
('us', '電力設備 開關',    '資料中心工程營造', '變壓器與開關'),
('us', '電力供應商 IPP',   '資料中心 REIT',   '電力'),
('us', '電力供應商 IPP',   'AI 算力租賃',     '電力，這是算力租賃的核心成本'),
('us', '資料中心工程營造', '資料中心 REIT',   '機房建置，領先設備商'),
('us', '銅 礦業',          '電力設備 開關',   '銅'),

('us', '伺服器 ODM 品牌',  '雲端超大規模',    '整機'),
('us', '伺服器 ODM 品牌',  'AI 算力租賃',     '整機'),
('us', '資料中心 REIT',    '雲端超大規模',    '機房'),
('us', 'AI 算力租賃',      '雲端超大規模',    '外包算力'),
('us', '雲端超大規模',     'AI 應用軟體',     '算力'),
('us', '雲端超大規模',     '資料庫 可觀測性', '算力'),
('us', '雲端超大規模',     '資安',            '算力');

-- ------------------------------------------------------------
-- 樹狀結構：大類 → 族群，帶上已有的數字
-- ------------------------------------------------------------
create or replace function public.theme_tree(p_market text default 'tw')
returns table (parent text, theme text, stage text, sort smallint,
               members integer, ratio numeric, pe numeric, growth numeric,
               up_count integer, down_count integer)
language sql stable security definer set search_path = public as $fn$
  select m.parent, m.theme, m.stage, m.sort,
         case when p_market = 'tw'
              then (select count(*)::int from public.themes t where t.theme = m.theme)
              else (select count(*)::int from public.us_themes t where t.theme = m.theme) end,
         case when p_market = 'tw'
              then (select v.ratio_median from public.theme_valuation() v where v.theme = m.theme)
              else (select u.ratio_median from public.us_theme_trend() u where u.theme = m.theme) end,
         case when p_market = 'tw'
              then (select v.pe1_median from public.theme_valuation() v where v.theme = m.theme)
              else (select u.pe_median from public.us_theme_trend() u where u.theme = m.theme) end,
         case when p_market = 'tw'
              then (select tt.yoy from public.theme_trend(1) tt where tt.theme = m.theme)
              else (select u.growth_next from public.us_theme_trend() u where u.theme = m.theme) end,
         (select count(*)::int from public.theme_links l where l.market = p_market and l.dst = m.theme),
         (select count(*)::int from public.theme_links l where l.market = p_market and l.src = m.theme)
  from public.theme_meta m
  where m.market = p_market
  order by m.parent, m.sort;
$fn$;

-- 某個族群的上下游
create or replace function public.theme_chain(p_market text, p_theme text)
returns table (direction text, theme text, note text, stage text)
language sql stable security definer set search_path = public as $fn$
  select '上游', l.src, l.note, m.stage
  from public.theme_links l
  left join public.theme_meta m on m.market = l.market and m.theme = l.src
  where l.market = p_market and l.dst = p_theme
  union all
  select '下游', l.dst, l.note, m.stage
  from public.theme_links l
  left join public.theme_meta m on m.market = l.market and m.theme = l.dst
  where l.market = p_market and l.src = p_theme
  order by 1 desc, 2;
$fn$;

grant execute on function public.theme_tree(text)        to authenticated;
grant execute on function public.theme_chain(text, text) to authenticated;
