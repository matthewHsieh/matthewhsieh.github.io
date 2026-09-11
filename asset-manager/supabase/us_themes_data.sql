-- ============================================================
-- 美股 AI 產業分類（人工維護）
--
-- 分類原則跟台股那邊一樣：**寧可拆細也不要合併。**
-- 「AI 加速器」把 NVDA 跟 AVGO 放一起會看不出通用 GPU 與客製 ASIC 是兩門生意；
-- 「電力」把發電商、開關設備、工程營造混在一起，更是三個完全不同的循環。
--
-- 每一檔都實測過 stockanalysis 抓得到營收與 EPS 預估。
-- 抓不到而排除的：PSTG、POET、IESC、LTBR、ASX（台股那邊有 3711）、JNPR（已被併購）。
--
-- 只有一檔的族群刻意保留，因為那本身就是訊息：
--   微影設備只有 ASML、DRAM/HBM 只有 MU、燃氣渦輪機只有 GEV。
--   那不是分類偷懶，是這幾塊在美股市場上真的就是獨佔或接近獨佔。
-- ============================================================

delete from public.us_themes where true;

insert into public.us_themes (theme, symbol, name, sort) values
-- ── 運算核心 ─────────────────────────────────
('GPU 通用加速器',     'NVDA', 'NVIDIA', 1),
('GPU 通用加速器',     'AMD',  'AMD', 2),

-- 雲端業者自研晶片的代工設計，跟賣通用 GPU 是相反的商業模式
('客製 ASIC XPU',      'AVGO', 'Broadcom', 1),
('客製 ASIC XPU',      'MRVL', 'Marvell', 2),

('EDA 設計工具',       'SNPS', 'Synopsys', 1),
('EDA 設計工具',       'CDNS', 'Cadence', 2),

('矽智財 IP',          'ARM',  'Arm Holdings', 1),
('矽智財 IP',          'RMBS', 'Rambus', 2),
('矽智財 IP',          'LSCC', 'Lattice Semiconductor', 3),

('邊緣 AI 終端晶片',   'QCOM', 'Qualcomm', 1),
('邊緣 AI 終端晶片',   'NXPI', 'NXP Semiconductors', 2),
('邊緣 AI 終端晶片',   'MCHP', 'Microchip', 3),
('邊緣 AI 終端晶片',   'ON',   'onsemi', 4),

('類比 電源管理 IC',   'TXN',  'Texas Instruments', 1),
('類比 電源管理 IC',   'ADI',  'Analog Devices', 2),
('類比 電源管理 IC',   'MPWR', 'Monolithic Power', 3),

-- ── 互連。速率每翻一倍就多一顆料 ─────────────
('PCIe CXL Retimer',   'ALAB', 'Astera Labs', 1),
('PCIe CXL Retimer',   'CRDO', 'Credo', 2),

('光通訊晶片 DSP',     'MRVL', 'Marvell', 1),
('光通訊晶片 DSP',     'MTSI', 'MACOM', 2),
('光通訊晶片 DSP',     'SMTC', 'Semtech', 3),

-- ── 製造 ─────────────────────────────────────
('晶圓代工',           'TSM',  '台積電 ADR', 1),
('晶圓代工',           'INTC', 'Intel', 2),
('晶圓代工',           'GFS',  'GlobalFoundries', 3),
('晶圓代工',           'UMC',  '聯電 ADR', 4),

('封測 測試設備',      'AMKR', 'Amkor', 1),
('封測 測試設備',      'TER',  'Teradyne', 2),
('封測 測試設備',      'KLIC', 'Kulicke & Soffa', 3),

-- 全球獨佔。只有一檔不是分類偷懶，是市場結構就長這樣。
('微影設備',           'ASML', 'ASML', 1),

('沉積 蝕刻設備',      'AMAT', 'Applied Materials', 1),
('沉積 蝕刻設備',      'LRCX', 'Lam Research', 2),
('沉積 蝕刻設備',      'ACLS', 'Axcelis', 3),

('量測 檢測設備',      'KLAC', 'KLA', 1),
('量測 檢測設備',      'ONTO', 'Onto Innovation', 2),
('量測 檢測設備',      'CAMT', 'Camtek', 3),
('量測 檢測設備',      'NVMI', 'Nova', 4),

('設備零組件 材料',    'ENTG', 'Entegris', 1),
('設備零組件 材料',    'MKSI', 'MKS Instruments', 2),
('設備零組件 材料',    'AEIS', 'Advanced Energy', 3),
('設備零組件 材料',    'UCTT', 'Ultra Clean', 4),
('設備零組件 材料',    'ICHR', 'Ichor', 5),

-- ── 記憶與儲存。三種完全不同的循環 ───────────
('DRAM HBM',           'MU',   'Micron', 1),

('NAND SSD',           'SNDK', 'SanDisk', 1),
('NAND SSD',           'WDC',  'Western Digital', 2),

('硬碟 企業儲存',      'STX',  'Seagate', 1),
('硬碟 企業儲存',      'NTAP', 'NetApp', 2),

-- ── 網路 ─────────────────────────────────────
('資料中心交換器',     'ANET', 'Arista Networks', 1),
('資料中心交換器',     'CSCO', 'Cisco', 2),
('資料中心交換器',     'EXTR', 'Extreme Networks', 3),

('光模組 光傳輸',      'FN',   'Fabrinet', 1),
('光模組 光傳輸',      'CIEN', 'Ciena', 2),
('光模組 光傳輸',      'AAOI', 'Applied Optoelectronics', 3),

('雷射 光元件',        'COHR', 'Coherent', 1),
('雷射 光元件',        'LITE', 'Lumentum', 2),

('連接器 光纖',        'APH',  'Amphenol', 1),
('連接器 光纖',        'TEL',  'TE Connectivity', 2),
('連接器 光纖',        'GLW',  'Corning', 3),
('連接器 光纖',        'BELFB','Bel Fuse', 4),

-- ── 伺服器 ───────────────────────────────────
('伺服器 ODM 品牌',    'DELL', 'Dell', 1),
('伺服器 ODM 品牌',    'HPE',  'HP Enterprise', 2),
('伺服器 ODM 品牌',    'SMCI', 'Super Micro', 3),

('EMS 電子代工',       'JBL',  'Jabil', 1),
('EMS 電子代工',       'FLEX', 'Flex', 2),
('EMS 電子代工',       'CLS',  'Celestica', 3),
('EMS 電子代工',       'SANM', 'Sanmina', 4),

-- ── 電力與冷卻。原本混在一起，其實是四個循環 ──
('液冷 機房散熱',      'VRT',  'Vertiv', 1),
('液冷 機房散熱',      'MOD',  'Modine', 2),
('液冷 機房散熱',      'NVT',  'nVent Electric', 3),

('HVAC 冷卻設備',      'JCI',  'Johnson Controls', 1),
('HVAC 冷卻設備',      'TT',   'Trane Technologies', 2),
('HVAC 冷卻設備',      'AAON', 'AAON', 3),

('電力設備 開關',      'ETN',  'Eaton', 1),
('電力設備 開關',      'HUBB', 'Hubbell', 2),
('電力設備 開關',      'POWL', 'Powell Industries', 3),
('電力設備 開關',      'AZZ',  'AZZ', 4),
('電力設備 開關',      'ATKR', 'Atkore', 5),

('發電設備 渦輪機',    'GEV',  'GE Vernova', 1),

-- 蓋資料中心的人。訂單能見度領先設備商，是最前面的訊號。
('資料中心工程營造',   'PWR',  'Quanta Services', 1),
('資料中心工程營造',   'EME',  'EMCOR', 2),
('資料中心工程營造',   'DY',   'Dycom', 3),
('資料中心工程營造',   'MTZ',  'MasTec', 4),
('資料中心工程營造',   'STRL', 'Sterling Infrastructure', 5),
('資料中心工程營造',   'PRIM', 'Primoris', 6),
('資料中心工程營造',   'MYRG', 'MYR Group', 7),

-- ── 能源 ─────────────────────────────────────
('電力供應商 IPP',     'CEG',  'Constellation Energy', 1),
('電力供應商 IPP',     'VST',  'Vistra', 2),
('電力供應商 IPP',     'NRG',  'NRG Energy', 3),
('電力供應商 IPP',     'TLN',  'Talen Energy', 4),
('電力供應商 IPP',     'PEG',  'Public Service Enterprise', 5),
('電力供應商 IPP',     'EXC',  'Exelon', 6),

('小型模組核能 SMR',   'OKLO', 'Oklo', 1),
('小型模組核能 SMR',   'SMR',  'NuScale Power', 2),
('小型模組核能 SMR',   'NNE',  'Nano Nuclear', 3),

('鈾 核燃料',          'CCJ',  'Cameco', 1),
('鈾 核燃料',          'LEU',  'Centrus Energy', 2),
('鈾 核燃料',          'UEC',  'Uranium Energy', 3),
('鈾 核燃料',          'UUUU', 'Energy Fuels', 4),

-- ── 資料中心資產 ─────────────────────────────
('資料中心 REIT',      'EQIX', 'Equinix', 1),
('資料中心 REIT',      'DLR',  'Digital Realty', 2),
('資料中心 REIT',      'IRM',  'Iron Mountain', 3),

-- 原本挖比特幣，把電力與機房轉去租給 AI。跟 REIT 的商業模式完全不同。
('AI 算力租賃',        'CORZ', 'Core Scientific', 1),
('AI 算力租賃',        'IREN', 'IREN', 2),
('AI 算力租賃',        'WULF', 'TeraWulf', 3),
('AI 算力租賃',        'APLD', 'Applied Digital', 4),
('AI 算力租賃',        'CIFR', 'Cipher Mining', 5),

-- ── 需求端 ───────────────────────────────────
('雲端超大規模',       'MSFT', 'Microsoft', 1),
('雲端超大規模',       'GOOGL','Alphabet', 2),
('雲端超大規模',       'AMZN', 'Amazon', 3),
('雲端超大規模',       'META', 'Meta', 4),
('雲端超大規模',       'ORCL', 'Oracle', 5),

('AI 應用軟體',        'PLTR', 'Palantir', 1),
('AI 應用軟體',        'NOW',  'ServiceNow', 2),
('AI 應用軟體',        'CRM',  'Salesforce', 3),

('資料庫 可觀測性',    'SNOW', 'Snowflake', 1),
('資料庫 可觀測性',    'MDB',  'MongoDB', 2),
('資料庫 可觀測性',    'DDOG', 'Datadog', 3),
('資料庫 可觀測性',    'NET',  'Cloudflare', 4),

('資安',               'CRWD', 'CrowdStrike', 1),
('資安',               'PANW', 'Palo Alto Networks', 2),
('資安',               'ZS',   'Zscaler', 3),
('資安',               'S',    'SentinelOne', 4),

-- ── 使用者持有的其他主題 ─────────────────────
('太空 衛星',          'RKLB', 'Rocket Lab', 1),
('太空 衛星',          'ASTS', 'AST SpaceMobile', 2),
('太空 衛星',          'LUNR', 'Intuitive Machines', 3),

('銅 礦業',            'FCX',  'Freeport-McMoRan', 1),
('銅 礦業',            'SCCO', 'Southern Copper', 2),
('銅 礦業',            'TECK', 'Teck Resources', 3),

-- ── 2026-09-11 擴充 ──────────────────────────────
-- 原本只有 126 檔。這批是用**公司自己的業務描述**找出來的：
-- 先撈未分類的，再用具體字眼比對（optical transceiver、uranium、foundry…），
-- 然後一檔一檔看描述決定。**關鍵字直接套會出一堆假陽性**——
-- 搜 satellite 撈到 Fox 電視台跟 Boeing，搜 cybersecurity 撈到 KKR 私募基金，
-- 搜 uranium 撈到金礦公司，全部都要人看過才收。
-- 有幾檔是被關鍵字分錯再手動改的：FormFactor 與 Aehr 撈到「邊緣 AI 終端晶片」，
-- 但它們做的是探針卡與燒機測試，應該歸封測；SK hynix 撈到晶圓代工，實際是記憶體。
('AI 算力租賃',           'BRUN',  'Boost Run', 6),
('AI 算力租賃',           'NBIS',  'Nebius Group', 7),
('AI 算力租賃',           'SHAZ',  'SharonAI', 8),
('AI 算力租賃',           'WYFI',  'WhiteFiber', 9),
('DRAM HBM',          'SKHY',  'SK hynix', 2),
('EMS 電子代工',          'PLXS',  'Plexus', 5),
('GPU 通用加速器',         'CBRS',  'Cerebras Systems', 3),
('NAND SSD',          'SIMO',  'Silicon Motion', 3),
('光模組 光傳輸',           'POET',  'POET Technologies', 4),
('光通訊晶片 DSP',         'MXL',   'MaxLinear', 4),
('太空 衛星',             'BKSY',  'BlackSky', 4),
('太空 衛星',             'GSAT',  'Globalstar', 5),
('太空 衛星',             'IRDM',  'Iridium', 6),
('太空 衛星',             'MDA',   'MDA Space', 7),
('太空 衛星',             'PL',    'Planet Labs', 8),
('太空 衛星',             'SATL',  'Satellogic', 9),
('太空 衛星',             'VSAT',  'Viasat', 10),
('封測 測試設備',           'AEHR',  'Aehr Test Systems', 4),
('封測 測試設備',           'ASX',   'ASE Technology', 5),
('封測 測試設備',           'FORM',  'FormFactor', 6),
('小型模組核能 SMR',        'BWXT',  'BWX Technologies', 4),
('晶圓代工',              'TSEM',  'Tower Semiconductor', 5),
('沉積 蝕刻設備',           'VECO',  'Veeco Instruments', 4),
('發電設備 渦輪機',          'INIO',  'INNIO', 2),
('設備零組件 材料',          'APD',   'Air Products', 6),
('設備零組件 材料',          'LIN',   'Linde', 7),
('設備零組件 材料',          'Q',     'Qnity Electronics', 8),
('資安',                'FTNT',  'Fortinet', 5),
('資安',                'NTSK',  'Netskope', 6),
('資安',                'QLYS',  'Qualys', 7),
('資料中心工程營造',          'AGX',   'Argan', 8),
('資料庫 可觀測性',          'DT',    'Dynatrace', 5),
('量測 檢測設備',           'COHU',  'Cohu', 5),
('鈾 核燃料',             'DNN',   'Denison Mines', 5),
('鈾 核燃料',             'NXE',   'NexGen Energy', 6),
('鈾 核燃料',             'UROY',  'Uranium Royalty', 7),
('銅 礦業',              'ERO',   'Ero Copper', 4),
('銅 礦業',              'HBM',   'Hudbay Minerals', 5),
('雲端超大規模',            'AKAM',  'Akamai', 6),
('雲端超大規模',            'RXT',   'Rackspace', 7);
