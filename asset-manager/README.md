# 資產管理系統

手機 Chrome 就能用的個人資產登記與淨值 / 槓桿追蹤工具。
純靜態網頁（無需 build），後端用 **Supabase 免費方案**（Postgres 資料庫 + Email 登入）。

功能：
- 登記 **台股、期貨、複委託（USD）、現金、負債**
- 自動算 **總資產、淨資產、槓桿①（資產槓桿）、槓桿②（曝險槓桿）**、目標達成率
- 一鍵存 **每日快照**，在「紀錄」看淨資產與槓桿的變化
- Email + 密碼登入，資料以 Row Level Security 隔離，只有自己看得到

---

## 1. 建立 Supabase 專案（免費）

1. 到 <https://supabase.com> 註冊，**New project**，區域選 Singapore 或 Tokyo（離台灣近）。
2. 左側 **SQL Editor → New query**，把 `supabase/schema.sql` 整段貼上 → **Run**。
   會建立 6 張表、RLS 政策與索引，可重複執行。
3. 左側 **Project Settings → API**，複製：
   - `Project URL`
   - `anon` `public` key
4. 打開 `config.js`，填入這兩個值：
   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```
   anon key 本來就是設計給前端用的，資料由資料庫的 RLS 保護，放在公開網頁沒問題。

## 2. 建立自己的帳號（建議做法）

個人使用最省事、也最安全的方式是**自己在後台建帳號、然後關閉公開註冊**：

1. **Authentication → Users → Add user → Create new user**，輸入 Email 與密碼，勾選 **Auto Confirm User**。
2. **Authentication → Sign In / Providers → Email**，關閉 **Allow new users to sign up**（可選，關掉後別人就不能在你的網站註冊）。

之後直接用網頁上的「登入」即可。若想改用網頁「註冊」功能也可以，Supabase 會寄確認信（免費方案每小時只有少量額度）。

## 3. 本機試跑

ES module 不能用 `file://` 直接開，需要一個靜態伺服器：

```powershell
cd asset-manager
python -m http.server 8000
# 開 http://localhost:8000
```

## 4. 部署到 GitHub Pages（讓手機可以用）

你已經有 `matthewhsieh.github.io` 這個 repo，把整個資料夾放進去即可：

```powershell
# 在 code 資料夾
Copy-Item -Recurse asset-manager matthewhsieh.github.io\asset-manager
cd matthewhsieh.github.io
git add asset-manager
git commit -m "add asset manager"
git push
```

幾分鐘後網址是 **https://matthewhsieh.github.io/asset-manager/**

然後回 Supabase：**Authentication → URL Configuration**
- **Site URL** 填 `https://matthewhsieh.github.io/asset-manager/`
- **Redirect URLs** 加同一個網址（忘記密碼、註冊確認信會導回這裡）

## 5. 手機使用

1. Android Chrome 開上面的網址並登入。
2. 右上角選單 → **加到主畫面**，之後就像 App 一樣全螢幕開啟。
3. 登入狀態會保留，不用每次輸入密碼。

---

## 數字定義

| 名稱 | 公式 |
|---|---|
| 總資產 | 台股市值 ＋ 複委託市值×匯率 ＋ 期貨帳戶權益 ＋ 現金/存款 |
| 淨資產 | 總資產 － 負債 |
| 槓桿①（資產槓桿） | 總資產 ÷ 淨資產 |
| 槓桿②（曝險槓桿） | （台股市值 ＋ 複委託市值 ＋ 期貨名目多單 ＋ 期貨名目空單）÷ 淨資產 |
| 期貨名目 | 口數 × 價格 × 每點價值（大台 200 / 小台 50 / 微台 10） |

想改定義，只要改 `app.js` 裡的 `compute()`。

## 檔案說明

```
asset-manager/
├── index.html            頁面骨架（登入、5 個分頁、編輯對話框）
├── app.js                所有邏輯：登入、CRUD、計算、畫面
├── style.css             手機優先樣式，支援深色模式
├── config.js             Supabase URL / anon key（要自己填）
├── manifest.webmanifest  讓 Chrome 可「加到主畫面」
├── icon.svg              App 圖示
└── supabase/schema.sql   資料表 + RLS，貼到 SQL Editor 執行
```

## 免費方案注意事項

- Supabase 免費專案 **7 天沒有任何請求會被暫停**，打開 Dashboard 按 **Restore** 即可恢復，資料不會消失（暫停 90 天內都可還原）。每週至少開一次 App 就不會被暫停。
- 免費額度：500 MB 資料庫、50,000 月活躍使用者，個人使用綽綽有餘。
- 資料要匯出：Dashboard → **Table Editor** → 選表 → 右上 **Export to CSV**。
