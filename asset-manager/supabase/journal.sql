-- ============================================================
-- 交易日誌與紀律規則
--
-- 為什麼要放進系統而不是寫在筆記本：
-- 日誌只會讓你「事後後悔」，規則檢查才會讓你「事前看見」。
-- 手癢是在下單那一刻發生的，不是在晚上寫日誌的時候。
-- 所以規則不是拿來讀的，是拿來在記錄交易時跳出來擋你的。
--
-- 設計上刻意**不阻止**你存檔——那是你的錢、你的帳。
-- 但違規會被記下來，而且每天在心得頁攤開來給你看。
-- 能被計算的東西才管得住，寫在紙上的規則三天就忘了。
-- ============================================================

-- ------------------------------------------------------------
-- 每日心得
--   一天一則，可以隨時回來改。
--   pl_snapshot 存當下的已實現損益，這樣即使日後補記，
--   也看得到「當天寫的時候心裡的數字是多少」。
-- ------------------------------------------------------------
create table if not exists public.journal (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date  date not null default current_date,
  body        text,
  mood        smallint,      -- 1 很差 ~ 5 很好，自評當天的執行紀律不是損益
  followed    boolean,       -- 今天有沒有守住規則（自己勾，不是系統判的）
  pl_snapshot numeric,       -- 寫的當下的當日已實現損益
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, entry_date)
);
alter table public.journal enable row level security;
drop policy if exists "own journal" on public.journal;
create policy "own journal" on public.journal for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 紀律規則
--   kind 決定程式怎麼檢查，free 就只是提醒不做檢查。
--   started_on 記錄「什麼時候下的決心」，之後回頭看才知道守了多久。
--   規則本身也是使用者資料，程式更新不會動它。
-- ------------------------------------------------------------
create table if not exists public.rules (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null,     -- opt_only_hedge / day_one_at_a_time / day_max_amount / scale_in / free
  title      text not null,
  detail     text,
  amount     numeric,           -- 給有金額上限的規則用
  scope      text,              -- tw / futures / option / all
  active     boolean not null default true,
  -- **不要用 current_date**：那是 UTC，台北早上八點前建立的規則會標成昨天，
  -- 畫面上就變成「剛建好的規則已經守了 1 天」。
  started_on date not null default (now() at time zone 'Asia/Taipei')::date,
  sort       smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.rules enable row level security;
drop policy if exists "own rules" on public.rules;
create policy "own rules" on public.rules for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 違規紀錄
--   記錄交易當下偵測到的違規，用來算「守規天數」與回頭檢討。
--   不擋存檔，只留證據。
-- ------------------------------------------------------------
create table if not exists public.rule_breaks (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  break_date date not null default current_date,
  kind       text not null,
  detail     text,
  created_at timestamptz not null default now()
);
alter table public.rule_breaks enable row level security;
drop policy if exists "own rule breaks" on public.rule_breaks;
create policy "own rule breaks" on public.rule_breaks for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists rule_breaks_date_idx on public.rule_breaks(user_id, break_date);

-- ------------------------------------------------------------
-- 每日戰績：把已實現損益、違規數、心得併在一起
--   這頁的重點不是損益，是「有沒有照著自己的規則做」。
--   損益是結果，紀律是原因，看錯了就會在賺錢的時候放大錯誤習慣。
-- ------------------------------------------------------------
create or replace function public.journal_days(p_limit integer default 90)
returns table (
  d date, body text, mood smallint, followed boolean,
  realized numeric, trades integer, day_trades integer,
  opt_pl numeric, breaks integer
) language sql stable security definer set search_path = public as $fn$
  with t as (
    select trade_date as d,
           sum(coalesce(realized_pl, 0))                                   as realized,
           count(*)::int                                                   as trades,
           count(*) filter (where is_day_trade)::int                       as day_trades,
           sum(coalesce(realized_pl, 0)) filter (where market = 'option')  as opt_pl
    from public.trades where user_id = auth.uid() group by trade_date
  ),
  b as (
    select break_date as d, count(*)::int as breaks
    from public.rule_breaks where user_id = auth.uid() group by break_date
  ),
  days as (
    select d from t
    union select entry_date from public.journal where user_id = auth.uid()
    union select d from b
  )
  select x.d, j.body, j.mood, j.followed,
         coalesce(t.realized, 0), coalesce(t.trades, 0), coalesce(t.day_trades, 0),
         coalesce(t.opt_pl, 0), coalesce(b.breaks, 0)
  from days x
  left join t on t.d = x.d
  left join b on b.d = x.d
  left join public.journal j on j.entry_date = x.d and j.user_id = auth.uid()
  order by x.d desc
  limit p_limit;
$fn$;

grant execute on function public.journal_days(integer) to authenticated;
