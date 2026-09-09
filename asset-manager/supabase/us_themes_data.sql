-- ============================================================
-- 美股 AI 產業分類（人工維護）
-- 每一檔都實測過 stockanalysis 抓得到預估。
-- 已排除：ASX（日月光 ADR，抓不到；台股那邊有 3711）、JNPR（已被 HPE 併購下市）。
-- 一檔可以屬於多個族群，各族群獨立加總。
-- ============================================================

delete from public.us_themes where true;

insert into public.us_themes (theme, symbol, name, sort) values
-- ── 運算核心 ─────────────────────────────────
('AI 加速器 GPU',      'NVDA', 'NVIDIA', 1),
('AI 加速器 GPU',      'AVGO', 'Broadcom', 2),
('AI 加速器 GPU',      'AMD',  'AMD', 3),
('AI 加速器 GPU',      'MRVL', 'Marvell', 4),

-- 機櫃內把 GPU 串起來的晶片。速率每翻一倍就多一顆料。
('AI 連接晶片',        'ALAB', 'Astera Labs', 1),
('AI 連接晶片',        'CRDO', 'Credo', 2),
('AI 連接晶片',        'MPWR', 'Monolithic Power', 3),

('EDA 矽智財',         'SNPS', 'Synopsys', 1),
('EDA 矽智財',         'CDNS', 'Cadence', 2),
('EDA 矽智財',         'ARM',  'Arm Holdings', 3),

('晶圓代工 封測',      'TSM',  '台積電 ADR', 1),
('晶圓代工 封測',      'INTC', 'Intel', 2),
('晶圓代工 封測',      'GFS',  'GlobalFoundries', 3),
('晶圓代工 封測',      'UMC',  '聯電 ADR', 4),

('半導體設備',         'ASML', 'ASML', 1),
('半導體設備',         'AMAT', 'Applied Materials', 2),
('半導體設備',         'LRCX', 'Lam Research', 3),
('半導體設備',         'KLAC', 'KLA', 4),
('半導體設備',         'TER',  'Teradyne', 5),

('記憶體 HBM',         'MU',   'Micron', 1),
('記憶體 HBM',         'SNDK', 'SanDisk', 2),
('記憶體 HBM',         'WDC',  'Western Digital', 3),
('記憶體 HBM',         'STX',  'Seagate', 4),

-- ── 資料中心硬體 ─────────────────────────────
('網通 交換器',        'ANET', 'Arista Networks', 1),
('網通 交換器',        'CSCO', 'Cisco', 2),
('網通 交換器',        'EXTR', 'Extreme Networks', 3),

('光通訊 光模組',      'COHR', 'Coherent', 1),
('光通訊 光模組',      'LITE', 'Lumentum', 2),
('光通訊 光模組',      'FN',   'Fabrinet', 3),
('光通訊 光模組',      'AAOI', 'Applied Optoelectronics', 4),

('高速連接器 線材',    'APH',  'Amphenol', 1),
('高速連接器 線材',    'TEL',  'TE Connectivity', 2),
('高速連接器 線材',    'GLW',  'Corning', 3),

('伺服器 ODM',         'DELL', 'Dell', 1),
('伺服器 ODM',         'HPE',  'HP Enterprise', 2),
('伺服器 ODM',         'SMCI', 'Super Micro', 3),

-- ── 電力與基礎建設。AI 的瓶頸已經從晶片變成電。────
('資料中心電力 散熱',  'ETN',  'Eaton', 1),
('資料中心電力 散熱',  'VRT',  'Vertiv', 2),
('資料中心電力 散熱',  'GEV',  'GE Vernova', 3),
('資料中心電力 散熱',  'PWR',  'Quanta Services', 4),
('資料中心電力 散熱',  'MOD',  'Modine', 5),

('電力供應 核能',      'CEG',  'Constellation Energy', 1),
('電力供應 核能',      'VST',  'Vistra', 2),
('電力供應 核能',      'NRG',  'NRG Energy', 3),
('電力供應 核能',      'TLN',  'Talen Energy', 4),
('電力供應 核能',      'OKLO', 'Oklo', 5),
('電力供應 核能',      'SMR',  'NuScale Power', 6),
('電力供應 核能',      'LEU',  'Centrus Energy', 7),

('資料中心 REIT',      'EQIX', 'Equinix', 1),
('資料中心 REIT',      'DLR',  'Digital Realty', 2),
('資料中心 REIT',      'IRM',  'Iron Mountain', 3),

-- ── 需求端 ───────────────────────────────────
('雲端超大規模',       'MSFT', 'Microsoft', 1),
('雲端超大規模',       'GOOGL','Alphabet', 2),
('雲端超大規模',       'AMZN', 'Amazon', 3),
('雲端超大規模',       'META', 'Meta', 4),
('雲端超大規模',       'ORCL', 'Oracle', 5),

('AI 軟體',            'PLTR', 'Palantir', 1),
('AI 軟體',            'NOW',  'ServiceNow', 2),
('AI 軟體',            'SNOW', 'Snowflake', 3),
('AI 軟體',            'CRM',  'Salesforce', 4),

-- ── 使用者持有的其他主題 ─────────────────────
('太空 衛星',          'RKLB', 'Rocket Lab', 1),
('太空 衛星',          'ASTS', 'AST SpaceMobile', 2),
('太空 衛星',          'LUNR', 'Intuitive Machines', 3),

('銅 礦業',            'FCX',  'Freeport-McMoRan', 1),
('銅 礦業',            'SCCO', 'Southern Copper', 2),
('銅 礦業',            'TECK', 'Teck Resources', 3);
