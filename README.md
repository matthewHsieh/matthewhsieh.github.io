# Matthew Hsieh - 個人網站

這是一個使用 GitHub Pages 建置的個人網站，展示個人資訊、技能、專案和聯絡方式。

## 功能特色

- 📱 響應式設計，支援各種裝置
- ✨ 現代化的視覺效果和動畫
- 🎨 專業的色彩搭配和字體
- 📧 聯絡表單
- 🚀 快速載入和流暢的使用者體驗

## 網站結構

- `index.html` - 主頁面
- `style.css` - 樣式表
- `script.js` - JavaScript 互動功能
- `README.md` - 說明文件

## 自訂設定

### 修改個人資訊

1. 打開 `index.html`
2. 修改以下部分：
   - 姓名和職稱
   - 關於我的內容
   - 技能專長
   - 專案作品
   - 聯絡資訊

### 添加專案

在 `index.html` 的專案區塊中：
```html
<div class="project-card">
    <div class="project-image">
        <!-- 添加專案圖片或圖標 -->
    </div>
    <div class="project-content">
        <h3>專案名稱</h3>
        <p>專案描述</p>
        <div class="project-tech">
            <span class="tech-tag">技術標籤</span>
        </div>
        <div class="project-links">
            <a href="github連結" class="project-link">
                <i class="fab fa-github"></i> GitHub
            </a>
            <a href="demo連結" class="project-link">
                <i class="fas fa-external-link-alt"></i> Demo
            </a>
        </div>
    </div>
</div>
```

### 修改聯絡資訊

更新 `index.html` 中的聯絡方式：
- 電子郵件
- LinkedIn 個人檔案
- GitHub 使用者名稱

## 部署到 GitHub Pages

1. 確保你的 repository 名稱是 `yourusername.github.io`
2. 將所有文件推送到 main 分支
3. 在 GitHub repository 設定中啟用 GitHub Pages
4. 選擇 source 為 "Deploy from a branch"
5. 選擇 branch 為 "main" 和 folder 為 "/ (root)"
6. 等待幾分鐘後，你的網站就會在 `https://yourusername.github.io` 上線

## 本地預覽

你可以使用任何本地伺服器來預覽網站：

```bash
# 使用 Python
python -m http.server 8000

# 使用 Node.js
npx serve .

# 使用 VS Code Live Server 擴展
```

## 技術堆疊

- HTML5
- CSS3 (Grid, Flexbox, Animations)
- JavaScript (ES6+)
- Font Awesome Icons
- Google Fonts (Noto Sans TC)

## 自訂樣式

### 修改顏色主題

在 `style.css` 中找到以下 CSS 變數並修改：
```css
/* 主要顏色 */
#3498db - 主題藍色
#2c3e50 - 深灰色文字
#f8f9fa - 淺灰背景
```

### 修改字體

替換 Google Fonts 連結和 CSS 中的字體設定。

## 支援

如果你需要幫助或有任何問題，歡迎：
- 查看 GitHub Issues
- 參考 GitHub Pages 官方文檔
- 聯繫網站作者

---

🚀 **現在就開始自訂你的個人網站吧！**