-- ============================================================
-- 報酬類的統計改用還原價（adjclose）
--
--   2026-09-17 使用者提出「分割跟配股配息要先還原」。查證結果：
--     **分割本來就已經還原了。** Yahoo chart API 的 close 已經是還原分割的，
--     MUU 在 2026-07-15 做過 20:1，原始收盤序列的單日最大變動仍只有 39.4%，
--     不是 1900%。所以 SNXX 的 224%、MUU 的 144% 年化波動是真的，
--     那是 2 倍槓桿 ETF 掛在半導體上該有的樣子，不是資料錯。
--
--     **但現金股利沒有還原，而這個影響很大。** 實測三年比值（報酬÷波動）：
--       中華電 0.66 → 1.11（+0.45）   華南金 1.49 → 1.81
--       玉山金 1.34 → 1.66            凱基金 1.81 → 2.07
--       永豐金 1.85 → 2.09            台積電 2.09 → 2.18
--       金居   1.65 → 1.70            聯茂   1.43 → 1.48
--     高殖利率的被系統性低估最多 0.45，**足以改變前 20 名的名單**，
--     而比值正是現在選股與配置的主因子。
--
--   所以：**報酬、波動、比值、最大回撤用 adjclose；
--   價格區間（hi52/lo52/hi3y/lo3y/last）維持用 close。**
--   後者是他看到的、下單用的那個數字，還原價拿來顯示只會對不上。
--   這也修正了舊筆記「用 close 不要用 adjclose」——那句話只對顯示成立。
-- ============================================================
drop function if exists public.pm_risk_calc(text);
create or replace function public.pm_risk_calc(p_body text)
returns table (vol numeric, cagr numeric, ratio numeric, mdd numeric,
               vol1y numeric, days integer,
               hi52 numeric, lo52 numeric, hi3y numeric, lo3y numeric, last numeric)
language plpgsql immutable as $fn$
declare
  root jsonb; arr jsonb; adjarr jsonb;
  p numeric;                      -- 收盤價：只給價格區間用
  a numeric;                      -- 還原價：給報酬用
  prev numeric := null;
  n integer := 0;
  s double precision := 0; s2 double precision := 0;
  s1 double precision := 0; s21 double precision := 0; n1 integer := 0;
  first_a numeric := null; last_a numeric := null; last_p numeric := null;
  peak numeric := null; dd numeric := 0; worst numeric := 0;
  h52 numeric := null; l52 numeric := null;
  h3 numeric := null; l3 numeric := null;
  total integer; i integer; cut integer;
  r double precision; sd double precision; sd1 double precision;
begin
  root := (p_body::jsonb) -> 'chart' -> 'result' -> 0;
  arr := root -> 'indicators' -> 'quote' -> 0 -> 'close';
  adjarr := root -> 'indicators' -> 'adjclose' -> 0 -> 'adjclose';
  if jsonb_typeof(arr) <> 'array' then return; end if;
  total := jsonb_array_length(arr);
  cut := greatest(total - 252, 0);          -- 近一年的起點（0-based）

  for i in 0 .. total - 1 loop
    if jsonb_typeof(arr -> i) <> 'number' then continue; end if;
    p := (arr ->> i)::numeric;
    if p <= 0 then continue; end if;
    -- 還原價缺漏就退回收盤價，**不要跳過這一天**：跳過會讓報酬序列接錯
    if jsonb_typeof(adjarr -> i) = 'number' then a := (adjarr ->> i)::numeric; else a := p; end if;
    if a <= 0 then a := p; end if;

    -- 價格區間：用收盤價
    last_p := p;
    if h3 is null or p > h3 then h3 := p; end if;
    if l3 is null or p < l3 then l3 := p; end if;
    if i >= cut then
      if h52 is null or p > h52 then h52 := p; end if;
      if l52 is null or p < l52 then l52 := p; end if;
    end if;

    -- 報酬 / 波動 / 回撤：用還原價
    if first_a is null then first_a := a; peak := a; end if;
    last_a := a;
    if peak < a then peak := a; end if;
    dd := a / peak - 1;
    if dd < worst then worst := dd; end if;
    if prev is not null then
      r := ln(a / prev);
      n := n + 1; s := s + r; s2 := s2 + r * r;
      if i >= cut then
        n1 := n1 + 1; s1 := s1 + r; s21 := s21 + r * r;
      end if;
    end if;
    prev := a;
  end loop;

  if n < 200 or first_a is null or last_a is null then return; end if;

  sd := sqrt((s2 - s * s / n) / (n - 1));
  vol := round((sd * sqrt(252.0))::numeric, 4);
  -- **上市或分拆未滿兩年的，不給年化報酬與比值。**
  -- 把 1.5 年的報酬年化再標成「三年」會產生假的高分：
  -- SNDK 2025-02 才從 WDC 分拆，只有 393 個交易日，算出來比值 10.57。
  if n >= 500 then
    cagr := round((power(last_a / first_a, 252.0 / n) - 1)::numeric, 4);
    ratio := case when vol > 0 then round(cagr / vol, 2) end;
  end if;
  mdd := round(worst, 4);
  if n1 > 30 then
    sd1 := sqrt((s21 - s1 * s1 / n1) / (n1 - 1));
    vol1y := round((sd1 * sqrt(252.0))::numeric, 4);
  end if;
  days := n;
  hi52 := h52; lo52 := l52; hi3y := h3; lo3y := l3; last := last_p;
  return next;
exception when others then
  return;
end $fn$;

-- 日報酬序列一樣改用還原價
create or replace function public.pm_ret_series(p_body text, p_n integer default 260)
returns table (days integer[], rets real[])
language plpgsql immutable as $fn$
declare
  root jsonb; ts jsonb; cl jsonb; adjarr jsonb;
  n integer; i integer; startk integer;
  c numeric; prev numeric := null;
  dd integer[] := '{}'; rr real[] := '{}';
begin
  begin
    root := (p_body::jsonb) -> 'chart' -> 'result' -> 0;
  exception when others then
    return;
  end;
  if root is null then return; end if;
  ts := root -> 'timestamp';
  cl := root -> 'indicators' -> 'quote' -> 0 -> 'close';
  adjarr := root -> 'indicators' -> 'adjclose' -> 0 -> 'adjclose';
  if ts is null or cl is null then return; end if;

  n := jsonb_array_length(ts);
  startk := greatest(0, n - p_n - 1);

  for i in startk .. n - 1 loop
    c := null;
    if jsonb_typeof(adjarr -> i) = 'number' then c := (adjarr ->> i)::numeric; end if;
    if c is null and jsonb_typeof(cl -> i) = 'number' then c := (cl ->> i)::numeric; end if;
    if c is not null and c > 0 then
      if prev is not null and prev > 0 then
        dd := dd || ((ts ->> i)::bigint / 86400)::integer;
        rr := rr || ln(c / prev)::real;
      end if;
      prev := c;
    end if;
  end loop;

  if array_length(rr, 1) is null then return; end if;
  days := dd;
  rets := rr;
  return next;
end $fn$;
