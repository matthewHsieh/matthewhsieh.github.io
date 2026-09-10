-- ============================================================
-- 新使用者的起始狀態
--
-- 註冊完直接進來會看到一個空的「心得」頁：沒有任何紀律規則，
-- 那頁的自動檢查就完全沒作用，等於少了一半功能。
--
-- 這裡給一組**通用**的起手式規則，不是把原本那個帳號的個人規則複製過去
--（「戒掉 buy call」是他自己的教訓，不是別人的）。給的是三條大部分
-- 當沖／波段的人都適用的，加一條提醒。使用者可以改、可以刪、可以自己加。
--
-- 用 RPC 不用 auth.users 的 trigger，因為：
--   1. trigger 要動 auth schema，權限與備份都比較麻煩；
--   2. 之後要調整預設規則，改 RPC 立刻生效，trigger 要重建。
-- App 在載入後發現「一條規則都沒有」才呼叫，所以只會跑一次。
-- ============================================================

create or replace function public.bootstrap_me()
returns integer language plpgsql security invoker set search_path = public as $fn$
declare n integer := 0;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;

  -- 已經有規則就什麼都不做。**這支必須可以重複呼叫而不產生副作用**，
  -- 因為前端是「發現空的就呼叫」，網路重試會叫到第二次。
  if exists (select 1 from public.rules where user_id = auth.uid()) then
    return 0;
  end if;

  -- **started_on 要用台北日期。** 資料庫的 current_date 是 UTC，
  -- 台北時間早上八點以前建立的規則會標成昨天，畫面上就變成
  -- 「剛建好的規則已經守了 1 天」，看起來像資料錯了。
  insert into public.rules (kind, title, detail, amount, scope, sort, started_on) values
    ('day_one_at_a_time',
     '個股當沖一次只做一檔',
     '手上那檔沖完（買賣相抵歸零）才能開下一檔。同時開兩檔就是注意力不夠，'
     '而注意力不夠正是當沖唯一會致命的地方。期貨當沖不受這條限制。',
     null, 'tw', 1, (now() at time zone 'Asia/Taipei')::date),
    ('day_max_amount',
     '個股當沖每檔上限',
     '單一標的當日買進或賣出金額的上限。這個數字要填「就算完全做錯也還在」的金額，'
     '不是「這檔我很有把握」的金額。到「心得」頁可以改。',
     500000, 'tw', 2, (now() at time zone 'Asia/Taipei')::date),
    ('scale_in',
     '一律分批進出',
     '不論個股或期貨，一律分批。一次全押的問題不是錯了會賠多少，'
     '是對了也學不到東西、錯了沒有第二次判斷的機會。',
     null, 'all', 3, (now() at time zone 'Asia/Taipei')::date),
    ('free',
     '不放空當天強勢的股票',
     '尤其是整個族群一起大漲的時候。要空就等它轉弱再說——'
     '強勢股的逆勢空單沒有停損點可言。族群頁的「今日」可以看今天哪一群在漲，'
     '個股速覽會顯示它從當日低點拉了多少，那個才是判斷強弱的數字。',
     null, 'all', 4, (now() at time zone 'Asia/Taipei')::date);
  get diagnostics n = row_count;

  -- 設定列讓 App 之後可以直接 update 而不用先判斷有沒有
  insert into public.settings (user_id) values (auth.uid())
  on conflict (user_id) do nothing;

  return n;
end $fn$;

revoke all on function public.bootstrap_me() from public, anon;
grant execute on function public.bootstrap_me() to authenticated;
