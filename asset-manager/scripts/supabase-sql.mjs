#!/usr/bin/env node
// ============================================================
// 對 asset-manager 的 Supabase 專案跑 SQL（Management API）
//
//   為什麼要有這支：Management API 要帶 Bearer 權杖。把權杖寫進命令列，
//   它就會留在 shell 歷史、工作階段紀錄與各種日誌裡。這支腳本自己去讀
//   權杖檔，所以**呼叫端的命令裡完全沒有憑證**。
//
//   專案 ref 寫死，不吃參數——能力就限定在「對這一個專案跑 SQL」。
//
//   權杖放在 ~/.claude/secrets/supabase-token（單獨一行，不要引號）。
//   那個位置在兩個 git repo 之外，不會被 commit 出去。
//   權杖是帳號層級的，隨時可以在 Supabase 後台撤銷。
//
//   用法：
//     node scripts/supabase-sql.mjs supabase/etf_perf.sql
//     node scripts/supabase-sql.mjs --query "select count(*) from public.stocks"
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_REF = 'ovyftgvprwzhlgnqkfvh';
const TOKEN_FILE = path.join(os.homedir(), '.claude', 'secrets', 'supabase-token');

const arg = process.argv[2];
if (!arg) {
  console.error('用法：node scripts/supabase-sql.mjs <檔案.sql>');
  console.error('　　　node scripts/supabase-sql.mjs --query "select 1"');
  process.exit(2);
}

let sql;
try {
  sql = arg === '--query' ? String(process.argv[3] ?? '') : fs.readFileSync(arg, 'utf8');
} catch (e) {
  console.error('讀不到 SQL：' + e.message);
  process.exit(2);
}
if (!sql.trim()) { console.error('SQL 是空的'); process.exit(2); }

let token;
try {
  token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.error('找不到權杖檔：' + TOKEN_FILE);
  process.exit(2);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
});

const body = await res.text();
// 保險：萬一伺服器把權杖回吐在錯誤訊息裡，不要讓它印出來
console.log('HTTP ' + res.status);
console.log(body.split(token).join('[REDACTED]').slice(0, process.argv.includes('--full') ? undefined : 4000));
process.exit(res.ok ? 0 : 1);
