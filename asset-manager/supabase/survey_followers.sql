-- ============================================================
-- 找「跟隨者」：營收已經在漲，但還沒被市場歸類的公司
--
-- 起點是尖點（8021）。它的營收年增破百、吃的是 PCB 的成長，
-- 但登記行業只是「電子零組件業」，在我們的族群表裡原本只掛在 PCB 底下，
-- 而它其實不是 PCB 廠——是賣鑽針給 PCB 廠的。
--
-- **這一類公司有共同特徵，所以可以用查詢找，不用靠印象：**
--   1. 營收年增已經起來了（產業的需求真的傳導到它身上）
--   2. 股價距 52 週高點還有一段（市場還沒給它產業的評價）
--   3. **不在任何族群裡**（我們自己也還沒認出它）
--
-- **一定要限定產業。** 不限的話前二十名全是建商——建案是專案認列，
-- 這個月交屋、上個月沒有，年增率會出現 115060% 這種數字，
-- 那不是成長是會計。預設只看電子相關與化工。
--
-- 第 3 點是關鍵。已經在族群裡的公司，市場早就有人在追蹤；
-- 真正「後期還沒發力」的，是連分類都還沒有的那些。
--
-- 用法：
--   select * from public.survey_followers();                       -- 預設門檻
--   select * from public.survey_followers(50, -0.20, 5);           -- 更嚴格
--   select * from public.survey_followers(30, -0.12, 2, null);     -- 不限產業
--   select * from public.survey_followers() where business ~ '液冷|散熱';
--
-- 找到候選之後**還要兩步**，不能直接寫進 themes：
--   a. 業務描述可能還沒抓到 → public.refresh_business_list(array[...])
--   b. 登記營業項目寫得籠統的（例如牧德只寫「非接觸式機械視覺檢測
--      系統設備」），要另外查法說會或報導確認終端市場是哪一塊。
--      實例：牧德 PCB 佔 85% 所以算 PCB 跟隨者；由田的半導體線
--      70–80% 是先進封裝，那是半導體不是 PCB，就不能放進來。
-- ============================================================
create or replace function public.survey_followers(
  p_min_yoy    numeric default 30,      -- 最近一個月營收年增的門檻（%）
  p_off_hi     numeric default -0.12,   -- 距 52 週高點至少要有多遠
  p_min_amt    numeric default 2,       -- 月營收下限（億），太小的不看
  p_industries text[] default array[    -- 產業別。建商那種專案認列的要擋掉
    '電子零組件業', '半導體業', '光電業', '電腦及週邊設備業',
    '電機機械', '其他電子業', '通信網路業', '化學工業', '電子通路業']
)
returns table (symbol text, name text, industry text, business text,
               yoy numeric, amt_yi numeric, off_hi numeric,
               ratio numeric, pe numeric)
language sql stable security definer set search_path = public as $fn$
  with last_ym as (
    select r.symbol, max(r.ym) as ym from public.revenue r group by r.symbol
  ),
  growth as (
    select l.symbol, max(cur.industry) as industry,
           round((max(cur.amount) / nullif(max(prev.amount), 0) - 1) * 100, 0) as yoy,
           round(max(cur.amount) / 1e5, 1) as amt_yi
    from last_ym l
    join public.revenue cur on cur.symbol = l.symbol and cur.ym = l.ym
    -- 去年同月＝民國年 −1、月份不變
    left join public.revenue prev on prev.symbol = l.symbol
         and prev.ym = ((substring(l.ym, 1, 3)::int - 1)::text || substring(l.ym, 4, 2))
    group by l.symbol
  )
  select u.symbol, u.name, g.industry, c.business,
         g.yoy, g.amt_yi,
         round((m.price / nullif(k.hi52, 0) - 1) * 100, 0),
         k.ratio, round(v.pe, 1)
  from public.stock_universe u
  join growth g on g.symbol = u.symbol
  left join public.company_profile c on c.symbol = u.symbol
  left join public.market_prices m on m.market = 'tw' and m.symbol = u.symbol
  left join public.risk_stats k on k.symbol = u.symbol
  left join public.valuation v on v.symbol = u.symbol
  where u.market = 'tw'
    and (p_industries is null or g.industry = any(p_industries))
    and g.yoy >= p_min_yoy
    and g.amt_yi >= p_min_amt
    and m.price / nullif(k.hi52, 0) - 1 <= p_off_hi
    -- 還沒被我們歸類的才算「還沒發力」
    and not exists (select 1 from public.themes t where t.symbol = u.symbol)
  order by g.yoy desc nulls last;
$fn$;

revoke all on function public.survey_followers(numeric, numeric, numeric, text[]) from public, anon;
drop function if exists public.survey_followers(numeric, numeric, numeric);

-- 盤點用的暫存表已經不需要了
drop table if exists public.pcf_cand;
