-- ============================================================
-- 讓沒有帳號的人也能用選股／配置
--
--   風險統計與日報酬序列本來就是公開市場資料的衍生值，不含任何個人部位，
--   所以開放 anon 讀。**但 stock_views（主觀看法）不開**——那是使用者資料。
--
--   注意 anon 角色的 statement_timeout 只有 3 秒（authenticated 是 8 秒），
--   所以這兩支 RPC 一定要夠快。實測 top_ratio 與 drop_hits 都在 200ms 以內
--   （掃 2,000 列、每列解一個 260 長度的陣列），沒問題。
--
--   **另外提醒使用者自己確認**：這些數字是證交所／櫃買／期交所資料的衍生值，
--   開放給非本人使用可能落入「交易資訊使用管理辦法」的範圍。
--   技術上做得到，法律上要不要開是他的決定。
-- ============================================================
drop policy if exists "read risk stats" on public.risk_stats;
create policy "read risk stats" on public.risk_stats for select to authenticated, anon using (true);

grant execute on function
  public.top_ratio(integer, text, integer, numeric, text[], numeric, integer, numeric) to anon;
grant execute on function
  public.drop_hits(numeric, numeric, integer, text, integer, numeric, text[]) to anon;
grant execute on function public.pm_industry_of(text, text) to anon;
