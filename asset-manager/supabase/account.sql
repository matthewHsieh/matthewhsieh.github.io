-- ============================================================
-- 刪除帳號
--
--   開放註冊就要能刪。使用者有權把自己輸入的東西整個帶走或整個刪掉，
--   而且不該需要寄信拜託開發者。
--
--   **這是全站唯一一支會刪掉使用者資料的函式。**
--   所以它的設計原則是「沒有任何方式能刪到別人」：
--     · 不收參數。要刪誰完全由 auth.uid() 決定，呼叫端無從指定。
--     · 沒登入直接 raise，不會變成匿名可用的破壞工具。
--     · 只 grant 給 authenticated，anon 拿不到。
--
--   表的清單是**查出來的不是寫死的**。以後新增一張帶 user_id 的表，
--   這支函式自動會刪；寫死清單的話，漏掉那張就是刪不乾淨，
--   而且是那種「以為刪了其實沒刪」的漏法，最難發現。
--   auth.users 的外鍵本來就是 on delete cascade，所以下面的逐表 delete
--   其實是第二道保險，順便回報每張表刪了幾列讓使用者看得到。
-- ============================================================

create or replace function public.delete_me()
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  uid uuid := auth.uid();
  t   text;
  n   bigint;
  report jsonb := '{}'::jsonb;
begin
  if uid is null then
    raise exception '沒有登入，無法刪除帳號';
  end if;

  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'user_id'
      and tb.table_type = 'BASE TABLE'
    order by c.table_name
  loop
    execute format('delete from public.%I where user_id = $1', t) using uid;
    get diagnostics n = row_count;
    if n > 0 then
      report := report || jsonb_build_object(t, n);
    end if;
  end loop;

  -- 最後才刪 auth.users。順序反過來的話，cascade 會先把上面那些表清掉，
  -- 回報的數字就全部變成 0，使用者看不到自己刪掉了什麼。
  delete from auth.users where id = uid;

  return report;
end $$;

revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;

comment on function public.delete_me() is
  '刪除呼叫者自己的帳號與所有資料。不收參數，只作用在 auth.uid()。';
