-- ============================================================
-- 公司在做什麼
--
-- 選股池放大到全市場之後，最缺的不是數字而是**這家公司到底做什麼**。
-- 證交所的「產業別」太粗——金居、台光電、國巨、禾伸堂全部都叫「電子零組件業」，
-- 那個欄位分不出銅箔、CCL、MLCC 與被動元件通路。
--
-- 公開資訊觀測站的「主要經營業務」剛好補這一格，而且是公司自己申報的：
--   8358 金居  電子零組件製造業／金屬表面處理業／鍊銅業
--   6274 台燿  銅箔基板、粘合片、多層壓合板之製造、加工及買賣
--   4989 榮科  電解銅箔之製造及銷售            ← 市場叫它「小金居」，這行就是證據
--
-- **為什麼不用 stockanalysis 的英文描述**：上櫃覆蓋不全，金居本身就 404。
-- **為什麼不用 t187ap03_L**：官方那份基本資料沒有業務欄位，只有地址與董監。
-- **為什麼不能批次查**：MOPS 的彙總表（ajax_t51sb01）不含這一欄，只有單檔頁面有。
-- 所以只能一檔一個 POST，靠分批輪替慢慢補完。內容幾乎不會變，一年跑一輪就夠。
-- ============================================================

create table if not exists public.company_profile (
  symbol     text primary key,
  name       text,
  business   text,          -- 主要經營業務（公司自己申報的原文）
  as_of      date,
  updated_at timestamptz not null default now()
);
alter table public.company_profile enable row level security;
drop policy if exists "read company profile" on public.company_profile;
create policy "read company profile" on public.company_profile for select to authenticated using (true);

-- pm_fetch 只做 GET，MOPS 要 POST，所以另外開一支
create or replace function public.pm_post(p_url text, p_body text)
returns text language plpgsql security definer set search_path = public, extensions as $fn$
declare body text;
begin
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '20');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '60');
  select content into body from extensions.http((
    'POST',
    p_url,
    array[extensions.http_header('User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36')],
    'application/x-www-form-urlencoded',
    p_body)::extensions.http_request);
  return body;
end $fn$;

revoke all on function public.pm_post(text, text) from public, anon;

-- 從 MOPS 的 HTML 挖出「主要經營業務」那一格。
-- **不要用 (.*?)</td> 去抓。** MOPS 的 HTML 是壞的——有些列根本沒有 </td>，
-- 那樣會一路吃到下一個有 </td> 的欄位，結果業務描述後面黏著
-- 「公司成立日期 43/12/13 營利事業統一編號…」。實測十檔有六檔中招。
-- 也不能只吃到下一個標籤（[^<]*），因為內容裡面有 <br> 分項——
-- 大成那筆「飼料<br>大宗油脂<br>肉品」會只剩「飼料」。
-- 正解是吃到 </td>、<tr、<th 三者中**最先出現的那一個**為止
--（有 </td> 的正常收在 </td>，沒有的靠下一個 <tr 收），再把裡面的 <br> 換成頓號。
--
-- **陷阱：Postgres 正則的貪婪與否，由整條式子裡「第一個有偏好的量詞」決定。**
-- 寫成 '...</th>\s*<td[^>]*>(.*?)(?:...)' 時，第一個量詞是貪婪的 \s*，
-- 於是整條變成貪婪，後面那個 .*? 的問號**完全失效**，一路吃到頁尾
-- （實測整段業務描述後面黏著董監、會計師、公司網址）。
-- 所以前面的 \s* 與 [^>]* 也要一起寫成非貪婪。
create or replace function public.pm_mops_business(p_html text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               (regexp_match(p_html, '主要經營業務</th>\s*?<td[^>]*?>(.*?)(?:</td>|<tr|<th)'))[1],
               '<br\s*/?>', '、', 'gi'),
             '<[^>]+>', '', 'g'),
           '&nbsp;?|&amp;|\s+', ' ', 'g')), '');
$$;

create or replace function public.refresh_company_profiles(p_limit integer default 40)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; html text; biz text; total integer := 0;
begin
  perform set_config('statement_timeout', '900s', true);

  -- 還沒抓到業務的排最前面。**這很重要**：MOPS 會限流，
  -- 失敗的那些也會留下時間戳，如果只照 updated_at 排，它們會被排到隊尾，
  -- 要等一整輪才會重試。實測第一輪 200 檔只成功 116 檔，其餘全是被限流的。
  for r in
    select u.symbol, u.name
    from public.stock_universe u
    left join public.company_profile c on c.symbol = u.symbol
    where u.market = 'tw'
    order by (c.business is not null), c.updated_at nulls first
    limit p_limit
  loop
    begin
      -- 打太快會被 MOPS 擋掉（回一頁沒有那個欄位的 HTML，不是 HTTP 錯誤，
      -- 所以看起來像「這家公司沒填」）。而且**限流會累積**：
      -- 0.4 秒間隔一開始 40 檔成功 37 檔，連續灌了一千多次之後掉到 60 檔只成功 9 檔。
      -- 這件事不急（業務描述幾乎不會變），所以間隔拉到 1.5 秒，交給排程慢慢補。
      perform pg_sleep(1.5);
      html := public.pm_post('https://mopsov.twse.com.tw/mops/web/ajax_t05st03',
        'encodeURIComponent=1&step=1&firstin=1&off=1&queryName=co_id&inpuType=co_id'
        || '&TYPEK=all&co_id=' || r.symbol);
      biz := public.pm_mops_business(html);
      insert into public.company_profile (symbol, name, business, as_of, updated_at)
      values (r.symbol, r.name, biz, current_date, now())
      on conflict (symbol) do update
        set name = coalesce(excluded.name, company_profile.name),
            -- 抓不到就保留舊的，不要用 null 蓋掉已經有的內容
            business = coalesce(excluded.business, company_profile.business),
            as_of = excluded.as_of, updated_at = now();
      if biz is not null then total := total + 1; end if;
    exception when others then
      perform public.pm_log('profile ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('company_profile', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_company_profiles(integer) from public, anon;

-- ============================================================
-- 美股的公司業務
--
-- 台股用公開資訊觀測站，美股用 stockanalysis 的 company 頁。
-- 這邊反過來——**美股用 stockanalysis 很完整，台股才是覆蓋不全**
--（金居在 stockanalysis 上是 404，見這個檔案開頭）。
--
-- 代號不會撞：台股是數字開頭、美股是字母開頭，所以共用同一張表。
-- ============================================================

alter table public.company_profile add column if not exists market text not null default 'tw';

-- __data.json 裡的角括號是 JSON 跳脫過的，原文是「反斜線 u003C p 反斜線 u003E」
-- 這六七個字元，不是真的 < 與 >。
--
-- **兩個都不能用正則直接寫。** Postgres 的正則把 uXXXX 形式當成字元跳脫，
-- 所以在正則裡寫那串會被解讀成角括號本身，反而配不到原文。
-- 這裡用 chr(92) 把反斜線接出來，再用 replace()（不是正則）換回角括號，
-- 之後就是一般的 HTML 解析。
--
-- **要抓前幾段不是只抓第一段。** 第一段通常只有一句「某某公司在某地區
-- 提供某類服務」，真正能搜的產品字眼在第二、三段。Vertiv 的第一段沒有
-- 「liquid cooling」，第二段才寫 AC/DC 電源、匯流排那些東西。
-- 只存第一段的話，搜「liquid cooling」「thermal management」全部落空。
-- 取前三段、上限 900 字，再多就是無關的樣板文字了。
create or replace function public.pm_sa_desc(p_body text)
returns text language sql immutable as $$
  with h as (
    select replace(replace(coalesce(p_body, ''), chr(92) || 'u003C', '<'),
                   chr(92) || 'u003E', '>') as s
  ),
  paras as (
    select rn, regexp_replace(m[1], '<[^>]*>', '', 'g') as txt
    from h, regexp_matches(h.s, '<p>(.*?)</p>', 'g') with ordinality as t(m, rn)
    where rn <= 3
  )
  select nullif(btrim(left(string_agg(txt, ' ' order by rn), 900)), '') from paras;
$$;

create or replace function public.refresh_us_profiles(p_limit integer default 150)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; biz text; total integer := 0;
begin
  perform set_config('statement_timeout', '900s', true);

  for r in
    select u.symbol, u.name
    from public.stock_universe u
    left join public.company_profile c on c.symbol = u.symbol
    where u.market = 'us' and u.symbol ~ '^[A-Z]{1,5}$'
    order by (c.business is not null), c.updated_at nulls first
    limit p_limit
  loop
    begin
      body := public.pm_fetch('https://stockanalysis.com/stocks/'
                              || lower(r.symbol) || '/company/__data.json');
      biz := public.pm_sa_desc(body);
      insert into public.company_profile (symbol, market, name, business, as_of, updated_at)
      values (r.symbol, 'us', r.name, biz, current_date, now())
      on conflict (symbol) do update
        set market = 'us',
            name = coalesce(excluded.name, company_profile.name),
            business = coalesce(excluded.business, company_profile.business),
            as_of = excluded.as_of, updated_at = now();
      if biz is not null then total := total + 1; end if;
    exception when others then
      perform public.pm_log('us_profile ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('us_profile', total, true, null);
  return total;
end $fn$;

revoke all on function public.refresh_us_profiles(integer) from public, anon;

-- ============================================================
-- 補漏：Yahoo 的「主要經營業務」
--
-- MOPS 是最好的來源（公司自己申報的原文），但它**累積限流**：
-- 打到大約一千次之後成功率從 37/40 掉到 9/60，所以 1,974 檔要磨好幾週。
-- 目前 516 檔有業務描述，選股器的關鍵字搜尋等於有七成的股票搜不到。
--
-- Yahoo 的個股資料頁有「主要經營業務」，涵蓋率是全部，而且跟 MOPS
-- 不是同一個主機、沒有觀察到限流。**但它比較粗**：給的是營業項目的
-- 分類（金居 → 電子零組件製造業／金屬表面處理業／鍊銅業），
-- 不是 MOPS 那種完整敘述。
--
-- 所以定位是補漏不是取代：
--   * Yahoo 只寫「還沒有業務描述」或「上次也是 Yahoo 寫的」那些
--   * MOPS 照跑，抓到就覆蓋掉 Yahoo 的
-- biz_src 記來源，才知道哪些還可以被 MOPS 升級。
-- ============================================================
alter table public.company_profile add column if not exists biz_src text;

-- 既有的：台股來自 MOPS，美股來自 stockanalysis。
-- **不要一律標成 mops**，美股那 2,161 檔根本沒碰過 MOPS。
update public.company_profile set biz_src = case when market = 'us' then 'sa' else 'mops' end
where business is not null and biz_src is null;

-- 版型固定：<span>主要經營業務</span></span><div class="…">甲\r\n乙\r\n丙</div>
-- **量詞全部非貪婪**，理由同 MOPS 那支：Postgres 的貪婪與否由第一個
-- 帶偏好的量詞決定，前面放一個貪婪的 .* 會讓整串一路吃到頁尾。
create or replace function public.pm_yahoo_business(p_body text)
returns text language sql immutable as $fn$
  select nullif(btrim(regexp_replace(
           regexp_replace((regexp_match(p_body,
             '主要經營業務</span></span><div[^>]*?>(.*?)</div>'))[1],
             '<[^>]*?>', '', 'g'),
           '[\r\n]+', '・', 'g')), '');
$fn$;

create or replace function public.refresh_business_yahoo(p_limit integer default 40)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; biz text; n integer := 0;
begin
  -- 實測一頁約 330KB，40 檔一批大約 20 秒，遠低於預設的 120 秒上限。
  -- （函式內 set_config('statement_timeout') 是無效的，上限在語句開始時就鎖定。）
  for r in
    select u.symbol,
           -- 上市是 .TW、上櫃是 .TWO，用 market_prices.exch 判斷
           case when m.exch = 'tpex' then '.TWO' else '.TW' end as suffix
    from public.stock_universe u
    left join public.company_profile c on c.symbol = u.symbol
    left join public.market_prices m on m.market = 'tw' and m.symbol = u.symbol
    where u.market = 'tw'
      and (c.business is null or c.biz_src in ('yahoo', 'yahoo-none'))
      and (c.updated_at is null or c.updated_at < now() - interval '30 days')
    order by c.updated_at nulls first
    limit p_limit
  loop
    begin
      body := public.pm_fetch('https://tw.stock.yahoo.com/quote/' || r.symbol || r.suffix || '/profile');
      biz := public.pm_yahoo_business(body);
      if biz is not null then
        insert into public.company_profile (symbol, market, business, biz_src, as_of, updated_at)
        values (r.symbol, 'tw', biz, 'yahoo', current_date, now())
        on conflict (symbol) do update
          -- MOPS 寫過的不要蓋掉，那份比較完整
          set business = case when company_profile.biz_src = 'mops'
                              then company_profile.business else excluded.business end,
              biz_src  = case when company_profile.biz_src = 'mops' then 'mops' else 'yahoo' end,
              updated_at = now();
        n := n + 1;
      else
        -- **抓不到也要記一筆時間戳。**
        -- 不寫的話 updated_at 還是 null，下一批排序又把它排到最前面，
        -- 整個回填會卡在同樣那幾檔上面永遠前進不了。
        insert into public.company_profile (symbol, market, biz_src, updated_at)
        values (r.symbol, 'tw', 'yahoo-none', now())
        on conflict (symbol) do update set updated_at = now();
      end if;
      perform pg_sleep(0.3);
    exception when others then
      perform public.pm_log('biz_yahoo ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;

  perform public.pm_log('biz_yahoo', n, true, null);
  return n;
end $fn$;

revoke all on function public.refresh_business_yahoo(integer) from public, anon;
revoke all on function public.pm_yahoo_business(text) from public, anon;

-- 一天四班。60 檔一批實測約 50 秒，遠低於預設的 120 秒上限
-- （一定要分成獨立的 cron job，理由見 etf_cron.sql）。
-- 一天補 240 檔，剩下的一千多檔大約一週補完。
do $do$
begin
  perform cron.unschedule(j) from unnest(array['am-biz-1','am-biz-2','am-biz-3','am-biz-4']) j
  where exists (select 1 from cron.job where jobname = j);
  perform cron.schedule('am-biz-1', '10 16 * * *', $c$select public.refresh_business_yahoo(60)$c$);
  perform cron.schedule('am-biz-2', '10 18 * * *', $c$select public.refresh_business_yahoo(60)$c$);
  perform cron.schedule('am-biz-3', '10 20 * * *', $c$select public.refresh_business_yahoo(60)$c$);
  perform cron.schedule('am-biz-4', '10 22 * * *', $c$select public.refresh_business_yahoo(60)$c$);
end $do$;

-- 針對指定名單補業務描述。
-- 用途是做專題盤點時（例如「跟著 PCB 成長但還沒被歸類的公司」），
-- 先用營收與股價篩出候選，再只抓那幾檔，不必等整批回填跑完。
create or replace function public.refresh_business_list(p_symbols text[], p_limit integer default 55)
returns integer language plpgsql security definer set search_path = public, extensions as $fn$
declare r record; body text; biz text; n integer := 0;
begin
  for r in
    select u.symbol,
           case when m.exch = 'tpex' then '.TWO' else '.TW' end as suffix
    from public.stock_universe u
    left join public.company_profile c on c.symbol = u.symbol
    left join public.market_prices m on m.market = 'tw' and m.symbol = u.symbol
    where u.market = 'tw' and u.symbol = any(p_symbols)
      and c.business is null
    limit p_limit
  loop
    begin
      body := public.pm_fetch('https://tw.stock.yahoo.com/quote/' || r.symbol || r.suffix || '/profile');
      biz := public.pm_yahoo_business(body);
      if biz is not null then
        insert into public.company_profile (symbol, market, business, biz_src, as_of, updated_at)
        values (r.symbol, 'tw', biz, 'yahoo', current_date, now())
        on conflict (symbol) do update
          set business = case when company_profile.biz_src = 'mops'
                              then company_profile.business else excluded.business end,
              biz_src  = case when company_profile.biz_src = 'mops' then 'mops' else 'yahoo' end,
              updated_at = now();
        n := n + 1;
      else
        insert into public.company_profile (symbol, market, biz_src, updated_at)
        values (r.symbol, 'tw', 'yahoo-none', now())
        on conflict (symbol) do update set updated_at = now();
      end if;
      perform pg_sleep(0.2);
    exception when others then
      perform public.pm_log('biz_list ' || r.symbol, 0, false, sqlerrm);
    end;
  end loop;
  return n;
end $fn$;

revoke all on function public.refresh_business_list(text[], integer) from public, anon;
