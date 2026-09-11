-- ============================================================
-- 轉型故事
--
-- 選股器與族群頁看的都是**已經發生的數字**：月營收年增、本益比、報酬/波動。
-- 但市場給價的常常是「它要變成什麼」，那件事在數字上還看不到。
-- 例如 1721 國慶科技（原三晃）——化工廠切進 CCL 用的阻燃劑，
-- 更名當天漲停，可是它的月營收只有 1 億，任何數字都看不出這件事。
--
-- 所以這張表記的是**故事本身**，而且一定要記兩件事：
--   stage    走到哪一步了。這是最重要的欄位。
--            「已成主業」跟「10 公斤送樣」在股價上可能一樣激動，在現實上差很遠。
--   caution  這個故事哪裡可能不成立。沒有但書的故事不要記。
--
-- **記故事不等於放進族群。** 南亞電子材料已經佔營收 52.8%，
-- 但它單月營收 305.7 億，而整個 CCL 銅箔基板族群加起來才 313.8 億——
-- 把它加進去，族群的「月營收年增」就變成南亞的塑化景氣，其他四家等於消失。
-- 所以這種營收量級差一個數量級的，只記故事、不進 themes。
-- ============================================================

create table if not exists public.stock_story (
  symbol     text primary key,
  title      text not null,       -- 一句話：從什麼變成什麼
  stage      text not null,       -- 已成主業 / 已量產 / 驗證中 / 試做送樣 / 規劃
  detail     text,                -- 證據與數字
  caution    text,                -- 這個故事哪裡可能不成立
  relates    text,                -- 轉型後實質上屬於哪些族群（不代表有加進 themes）
  source     text,
  checked_on date not null,
  updated_at timestamptz not null default now()
);
alter table public.stock_story enable row level security;
drop policy if exists "read stock story" on public.stock_story;
create policy "read stock story" on public.stock_story for select to authenticated using (true);
drop policy if exists "public read stock story" on public.stock_story;
create policy "public read stock story" on public.stock_story for select to anon using (true);
grant select on public.stock_story to anon, authenticated;

delete from public.stock_story where true;

insert into public.stock_story
  (symbol, title, stage, detail, caution, relates, source, checked_on) values

('1303',
 '塑化廠變成 AI 電子材料廠：CCL、銅箔、玻纖布、電子級樹脂',
 '已成主業',
 '2026 年 Q1 電子材料營收佔比**首度突破 52.8%**，扣掉南電之後本體仍有 43.6%。'
 'CCL 與銅箔產能利用率約 8 成、玻纖產品（布與絲）約 9 成，'
 'CCL 正在去瓶頸擴產並認證 M9 / M10。9 月 1 日起銅箔基板基材售價調漲兩成。',
 '**不要因為這個故事就把它當成純 AI 材料股。** 還有將近一半是塑化，'
 '那一半跟油價與中國產能走，跟 AI 無關，而且波動大得多。'
 '另外它的月營收 305.7 億，跟台光電 192 億以外的同業不是同一個量級，'
 '拿它的年增率去跟小廠比沒有意義。',
 'CCL 銅箔基板・銅箔・玻纖布',
 '南亞法說會（2026-05-26）／豐雲學堂／理財周刊／Yahoo 股市',
 date '2026-09-11'),

('5386',
 '技嘉代理通路商變成高階伺服器記憶體模組廠',
 '已成主業',
 '高階記憶體產品**佔營收結構逾七成**。2026/08 單月營收 45.5 億、'
 '年增 **1846%**；2026Q1 稅後純益 15.5 億、單季 EPS 43.05 元，'
 '**一季獲利就超過 1999 年掛牌以來的總和**。'
 '同時是美光與 Crucial 記憶體、SSD 的重要代理商，往工控與 AI 資料中心佈局。',
 '**成長主要來自代理的漲價價差，那是低毛利的過水生意。** '
 '跟威剛、十銓自己做模組的體質不一樣，記憶體報價一轉向，'
 '這種價差會消失得比製造毛利快。而且 1846% 是低基期算出來的，'
 '明年同期就是高基期。要看的是「漲價停了以後還剩多少」。',
 '記憶體模組',
 '鉅亨網營收速報／聯合新聞網財報／CMoney',
 date '2026-09-11'),

('1721',
 '三晃改名國慶科技：人工皮革與特化廠切進高階 CCL 用電子化學品',
 '試做送樣',
 '2026 年 8 月 10 日決議更名為「國慶科技」，更名首日攻漲停。'
 'CCL 用的雙馬來醯亞胺（BMI）品質已獲驗證合格；'
 'M8 / M9 / M10 高階 CCL 用的新型含磷阻燃劑正在試做，已取得**10 公斤**訂單供客戶試做。',
 '**10 公斤是送樣不是訂單。** 它 2026 年 7 月的月營收是 1.0 億，'
 '整個故事在財報上完全看不到，現在的股價是純題材。'
 '本業還是人工皮革原料與特用化學，正面臨中國低價競爭。'
 '要等的是「營收裡出現電子材料的佔比」，在那之前這是一張選擇權不是一張股票。',
 'CCL 銅箔基板（材料端）',
 'CMoney 研究／聯合新聞網（2026-08-10 更名）／股市爆料同學會',
 date '2026-09-11');

-- ------------------------------------------------------------
-- 有故事的股票清單，給畫面用
-- ------------------------------------------------------------
create or replace function public.stock_stories()
returns table (symbol text, name text, title text, stage text, detail text,
               caution text, relates text, source text, checked_on date)
language sql stable security definer set search_path = public as $fn$
  select s.symbol, coalesce(u.name, c.name), s.title, s.stage, s.detail,
         s.caution, s.relates, s.source, s.checked_on
  from public.stock_story s
  left join public.stock_universe u on u.market = 'tw' and u.symbol = s.symbol
  left join public.company_profile c on c.symbol = s.symbol
  order by case s.stage when '已成主業' then 1 when '已量產' then 2
                        when '驗證中' then 3 when '試做送樣' then 4 else 5 end,
           s.symbol;
$fn$;

grant execute on function public.stock_stories() to anon, authenticated;
