-- ============================================================
-- 主動型 ETF 的排程
--
-- **四件事要分成四個 cron job，不能包成一支 update_etf()。**
-- statement_timeout 是在敘述開始時就定下來的，函式裡面再 set_config 沒有用；
-- 一支函式就是一個交易，撞到 120 秒上限會整個回滾，連已經寫好的都沒了。
-- prices.sql 當初就是為了這件事拆成 24 個 job 的，這裡照同一個規矩。
--
-- 時間是 UTC，台北要 +8。台股 13:30 收，櫃買的收盤檔 16:00 後才出，
-- Yahoo 的日線還要再晚一點才穩，所以排在台北晚上八點之後。
-- ============================================================
do $do$
begin
  perform cron.unschedule(j) from unnest(array[
    'am-etf-list', 'am-etf-px', 'am-etf-perf', 'am-etf-tilt']) j
  where exists (select 1 from cron.job where jobname = j);

  -- 名冊：新基金掛牌才會變，一週一次就夠
  perform cron.schedule('am-etf-list', '0 12 * * 1',
    $c$select public.refresh_active_etf()$c$);                      -- 週一 20:00 台北

  -- 日線：族群成員 ＋ 對照組 ＋ 基金本身，250 檔實測 43 秒
  perform cron.schedule('am-etf-px', '10 12 * * 1-5',
    $c$select public.refresh_px_daily(250)$c$);                     -- 20:10

  -- 掛牌以來報酬 vs 同期被動對照組
  perform cron.schedule('am-etf-perf', '25 12 * * 1-5',
    $c$select public.refresh_etf_perf()$c$);                        -- 20:25

  -- 族群傾向。要等 px_daily 與 etf_perf 都跑完才有東西可以算。
  perform cron.schedule('am-etf-tilt', '40 12 * * 1-5',
    $c$select public.refresh_etf_tilt()$c$);                        -- 20:40
end $do$;
