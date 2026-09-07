# 資產管理系統

手機 Chrome 就能用的個人資產登記與淨值 / 槓桿追蹤工具。
純靜態網頁（無需 build），後端用 **Supabase 免費方案**（Postgres 資料庫 + Email 登入）。

功能：
- **每日報價自動更新**：收盤價、期貨結算價、美股、美金匯率每天自動抓，手機不用開著，也不用自己改數字
- **記一筆交易**：選買/賣、打代號、輸入張數（或股數／口數）與價格，自動加減部位、重算均價
- **代號自動帶名稱**：台股打 `2330` 或「台積」就跳出台積電（上市＋上櫃約 2,700 檔）；期貨打「小台」自動帶每點價值
- **期貨**：指數期貨（大台/小台/微台/電子/金融）與**個股期貨**（大型 2 張、小型 100 股），權益數計入總資產、名目金額計入曝險
- **圖表**：圓餅圖可切換「資產組成」與「曝險明細」（每一檔股票、每一筆期貨各自的曝險佔比），另有資產與槓桿折線圖
- **期貨也有平均成本與損益**，跟股票一樣；沒填成本就不顯示損益
- **歷史交易紀錄**，可刪除並自動還原部位
- 登記 **台股、期貨、複委託（USD）、現金、期貨權益數、負債**
- 自動算 **總資產、淨資產、槓桿①（資產槓桿）、槓桿②（曝險槓桿）**、目標達成率
- 一鍵存 **每日快照**，在「紀錄」看淨資產與槓桿的變化
- Email + 密碼登入，資料以 Row Level Security 隔離，只有自己看得到

---

## 1. 建立 Supabase 專案（免費）

1. 到 <https://supabase.com> 註冊，**New project**，區域選 Singapore 或 Tokyo（離台灣近）。
2. 左側 **SQL Editor → New query**，依序執行兩個檔案（都可重複執行）：
   - `supabase/schema.sql` — 建立資料表、RLS 政策與索引
   - `supabase/prices.sql` — 建立每日自動更新報價的排程
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
| 總資產 | 台股市值 ＋ 複委託市值×匯率 ＋ **期貨帳戶權益數** ＋ 現金/存款 |
| 淨資產 | 總資產 － 負債 |
| 槓桿①（資產槓桿） | 總資產 ÷ 淨資產 |
| 槓桿②（曝險槓桿） | （台股市值 ＋ 複委託市值 ＋ 期貨名目）÷ **總資產**，指數期貨與個股期貨都算 |
| 指數期貨名目 | 口數 × 結算價 × 每點價值（大台 200 / 小台 50 / 微台 10 / 電子 4000 / 金融 1000） |
| 個股期貨名目 | 口數 × 標的股價 × 等同股數（**大型 2,000 股 ＝ 2 張**、**小型 100 股**） |
| 期貨損益 | 多單（現價 − 平均成本）、空單（平均成本 − 現價），再乘口數與規格 |

> 期貨的「權益數」是帳戶層級的一個數字，記在「資金」頁，只計入總資產一次；
> 各個部位的「名目金額」只影響曝險，不會重複計入資產。

## 每日自動更新

全部在 Supabase 資料庫裡用排程跑，手機關著也會更新，也不會用到你的電腦。

| 時間（台灣） | 內容 | 來源 |
|---|---|---|
| 交易日 16:00 | 台股收盤價、期貨結算價、美金匯率、當日快照 | 證交所、櫃買中心、期交所 OpenAPI |
| 交易日隔天 06:00 | 美股收盤價 | Yahoo Finance |

- 個股期貨用**標的股票收盤價**計價，因為曝險的定義就是「等同 N 股現股」。
- 價格只會 `UPDATE`，**不會新增或刪除任何項目**；只有賣光時部位才會被移除。
- 想立刻更新：App 右上角 ↻，或到「設定 → 立即重新抓取報價」。
- 排程狀態可查：SQL Editor 執行 `select * from price_runs order by id desc limit 20;`

想改定義，只要改 `app.js` 裡的 `compute()`。

## 記一筆交易的規則

| 情境 | 處理 |
|---|---|
| 台股 / 美股 買進 | 股數相加；均價 =（原股數×原均價 ＋ 新股數×成交價）÷ 總股數；現價更新為成交價 |
| 台股 / 美股 賣出 | 股數相減；均價不變；賣到 0 自動移除部位；賣超過持有會擋下 |
| 期貨 | 以淨口數計算：買進 +、賣出 −；穿越 0 自動翻多／翻空；歸零移除部位。新部位的「帳戶權益」要到持倉頁補填 |
| 刪除交易 | 若是該標的最新一筆，精確還原到交易前；否則只反向調整數量（均價不動） |
| 台股單位 | 預設「張」（1 張 = 1000 股），可切換成「股」 |

交易本身不會動現金餘額，現金請在「資金」頁自行維護。

## 更新台股名稱清單

`tw-stocks.json` 是靜態檔，新上市櫃股票要重新產生：

```powershell
node scripts/build-tw-stocks.mjs
```

## 檔案說明

```
asset-manager/
├── index.html            頁面骨架（登入、5 個分頁、編輯對話框）
├── app.js                所有邏輯：登入、CRUD、計算、畫面
├── style.css             手機優先樣式，支援深色模式
├── config.js             Supabase URL / anon key（要自己填）
├── charts.js             圓餅圖與折線圖（純 SVG，無外部套件）
├── tw-stocks.json        台股代號→名稱（自動帶名稱用）
├── scripts/build-tw-stocks.mjs  重新產生上面那個檔
├── manifest.webmanifest  讓 Chrome 可「加到主畫面」
├── icon.svg              App 圖示
└── supabase/
    ├── schema.sql        資料表 + RLS
    └── prices.sql        每日自動更新報價的排程
```

## 免費方案注意事項

- Supabase 免費專案 **7 天沒有任何請求會被暫停**，打開 Dashboard 按 **Restore** 即可恢復，資料不會消失（暫停 90 天內都可還原）。每週至少開一次 App 就不會被暫停。
- 免費額度：500 MB 資料庫、50,000 月活躍使用者，個人使用綽綽有餘。
- 資料要匯出：Dashboard → **Table Editor** → 選表 → 右上 **Export to CSV**。
