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
