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
-- **am-etf-px 與 am-etf-tilt 已經停用，這裡只負責把它們排掉。**
--   那兩個 job 叫的是 refresh_px_daily() 與 refresh_etf_tilt()，
--   而 etf_tilt.sql 結尾已經把這兩支函式 drop 掉了（改用 MoneyDJ 的實際持股）。
--   這個檔案原本還照排，所以**只要有人重跑一次 etf_cron.sql，
--   兩個叫不到函式的 job 就會復活**，然後每個交易日固定失敗兩次。
--   排程檔與它呼叫的函式必須一起改，不然「重跑安裝腳本」就是一個陷阱。
do $do$
begin
  perform cron.unschedule(j) from unnest(array[
    'am-etf-list', 'am-etf-px', 'am-etf-perf', 'am-etf-tilt']) j
  where exists (select 1 from cron.job where jobname = j);

  -- 名冊：新基金掛牌才會變，一週一次就夠
  perform cron.schedule('am-etf-list', '0 12 * * 1',
    $c$select public.refresh_active_etf()$c$);                      -- 週一 20:00 台北

  -- 掛牌以來報酬 vs 同期被動對照組。
  -- 它自己抓 Yahoo 日線進暫存表，不依賴已經停用的 px_daily。
  perform cron.schedule('am-etf-perf', '25 12 * * 1-5',
    $c$select public.refresh_etf_perf()$c$);                        -- 20:25
end $do$;

-- ------------------------------------------------------------
-- 實際持股（MoneyDJ）與已發行股數
--
-- 一樣要分開，理由同上。實測時間：
--   refresh_stock_shares    幾秒（證交所＋櫃買各一次 OpenAPI）
--   refresh_etf_holdings    15 秒（32 頁，每頁間隔 0.3 秒）
-- 兩支都遠低於預設的 120 秒上限。
--
-- MoneyDJ 的資料日期是前一個交易日，所以不必等當天收盤，
-- 但還是排在行情之後，這樣 theme_etf 算市值時用的是當天的價。
-- ------------------------------------------------------------
do $do$
begin
  perform cron.unschedule(j) from unnest(array['am-etf-shares', 'am-etf-hold']) j
  where exists (select 1 from cron.job where jobname = j);

  -- 股數變動要等增資或減資，一週一次就夠
  perform cron.schedule('am-etf-shares', '2 12 * * 1',
    $c$select public.refresh_stock_shares()$c$);                    -- 週一 20:02 台北

  perform cron.schedule('am-etf-hold', '20 12 * * 1-5',
    $c$select public.refresh_etf_holdings()$c$);                    -- 20:20
end $do$;
