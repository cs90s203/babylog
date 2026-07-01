# 寶寶日誌

手機優先的寶寶飲食 / 排便 / 尿尿 / 成長紀錄 web app。沒有自己的伺服器——資料存在每支手機的
`localStorage`，並透過 **Firebase（Google 登入 + Firestore）** 在多支手機間即時同步。

## 功能

- 首頁快速記錄喝奶（母乳＋配方可混合）／排便／尿尿，含下一餐預測
- 活動時間軸（今天 / 本週 / 本月 / 本年），可長按拖曳調整時間
- 統計：餵養摘要、照顧者分擔排行、WHO 成長百分位曲線（體重／身高／頭圍，0–24 月）
- 紀錄列表、編輯、刪除
- 設定：寶寶資料、本機照顧者身分、日夜主題、事件時長、預設奶量、Alarm 微調
- 匯出 Google 日曆 CSV（一次性快照）+ 完整資料 JSON 備份下載
- Google 登入即時同步（Firestore，白名單限制哪些帳號能存取）

## 本機開發

不需要任何建置工具，純靜態檔案：

```bash
cd babylog
python3 -m http.server 8765
# 開瀏覽器 http://localhost:8765
```

## 部署到 GitHub Pages

1. 把這個資料夾整個 push 到一個 GitHub repo（可以跟存資料的 repo分開，也可以同一個）。
2. Repo → Settings → Pages → Source 選 `main` 分支 / root，存檔。
3. 等個一兩分鐘，網址會是 `https://<你的帳號>.github.io/<repo>/`。
4. 用手機開這個網址，「加入主畫面」就會像 app 一樣全螢幕使用。

## 設定資料同步（Firebase 專案擁有者，只需做一次）

1. 到 [Firebase Console](https://console.firebase.google.com/) 建一個專案（或用現有的）。
2. **Authentication → Sign-in method** 啟用 **Google** 登入。
3. **Authentication → Settings → Authorized domains** 加入你的 GitHub Pages 網域
   （例如 `yourname.github.io`）。
4. **Firestore Database** 建立資料庫（地區選離你近的，例如 `asia-east1`）。
5. 把專案設定的 `firebaseConfig` 貼進 [js/firebase-sync.js](js/firebase-sync.js)
   （這組設定本來就是公開的，可以放心 commit，安全性由下一步的規則把關，不是靠藏這組設定）。
6. 把 [firestore.rules](firestore.rules) 的內容貼到 Firebase 主控台
   **Firestore Database → Rules**，並把裡面的 email 陣列改成你自己允許存取的家庭成員。

## 使用（其他家庭成員，不用碰 Firebase 後台）

打開 App → 設定 → 同步與帳號 → 「使用 Google 帳號登入」，用被列在白名單裡的 Google 帳號登入
即可，資料會即時同步到所有已登入的裝置。不在白名單的帳號登入會被自動擋掉並登出。

「我是…」（照顧者名字）跟 Google 登入帳號是分開的兩件事，見
[docs/data-model.md](docs/data-model.md) 說明。

## 文件

- [docs/architecture.md](docs/architecture.md) — 整體架構、模組劃分
- [docs/data-model.md](docs/data-model.md) — 資料結構、本機 vs 同步資料界線
- [docs/sync.md](docs/sync.md) — Firebase 同步流程、身分驗證、合併規則
- [docs/backup.md](docs/backup.md) — 備份策略與還原步驟
- [docs/prediction.md](docs/prediction.md) — 下一餐預測演算法
- [docs/csv-export.md](docs/csv-export.md) — CSV 匯出規格與限制
- [docs/growth-percentiles.md](docs/growth-percentiles.md) — WHO 成長百分位資料來源與計算方式
- [firestore.rules](firestore.rules) — Firestore 安全規則（email 白名單）

## 已知限制（本版範圍）

- 單一寶寶（資料結構有 `babyId` 擴充空間，但沒有切換 UI）
- 不支援親餵計時，只記錄瓶餵（含擠出母乳）的量
- CSV 匯出是一次性快照，不會自動同步到 Google 日曆；真要自動同步需改走 Calendar API + OAuth
- 沒有背景推播通知，「預計下一餐」只在開 App 時顯示
- Google 登入需要 `http://` 或 `https://` 才能用（`localhost` 沒問題），直接用 `file://`
  雙擊打開檔案測試時，其他功能都正常，但登入按鈕會失敗——這是 Google OAuth 的安全限制，不是
  bug。
