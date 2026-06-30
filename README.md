# 寶寶日誌

手機優先的寶寶飲食 / 排便 / 尿尿 / 成長紀錄 web app。沒有後端伺服器——資料存在每支手機的
`localStorage`，並透過你自己的 **GitHub private repo** 在多支手機間同步。

## 功能

- 首頁快速記錄喝奶（母乳＋配方可混合）／排便／尿尿，含下一餐預測
- 活動時間軸（今天 / 本週 / 本月 / 本年），可長按拖曳調整時間
- 統計：餵養摘要、照顧者分擔排行、WHO 成長百分位曲線（體重／身高／頭圍，0–24 月）
- 紀錄列表、編輯、刪除
- 設定：寶寶資料、本機照顧者身分、日夜主題、事件時長、預設奶量、Alarm 微調
- 匯出 Google 日曆 CSV（一次性快照）
- GitHub Contents API 同步（pull → merge → push，含重試）＋ 每日備份快照

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

## 設定資料同步（GitHub Token）

App 本身不需要登入帳號；資料同步是透過 **你自己的一個 GitHub repo** 當儲存後端：

1. 另外建立一個 **private** repo 專門存資料（例如 `yourname/baby-records`），裡面不用放任何檔案。
2. 到 GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token。
   - Repository access：只選剛剛那個 repo（不要選 All repositories）。
   - Permissions：**Contents → Read and write**，其他都不用開。
3. 把產生的 token 貼到 App 的「設定 → 同步與帳號 → GitHub Token」，Repo 位置填 `yourname/baby-records`。
4. 每支手機（爸爸的、媽媽的…）都各自貼一次同一組 token/repo，資料就會同步在一起。
5. 「我是…」（照顧者名字）不會同步，是每支手機自己的設定，用來標記是誰記錄的。

⚠️ Token 只會存在該支手機的 localStorage，不會上傳到任何地方（除了你自己指定的那個 repo 的
Contents API 呼叫）。請勿把 token 分享給不信任的人，且只給該 repo 的最小權限。

## 文件

- [docs/architecture.md](docs/architecture.md) — 整體架構、模組劃分
- [docs/data-model.md](docs/data-model.md) — `data.json` 結構、本機 vs 同步資料界線
- [docs/sync.md](docs/sync.md) — 同步流程、合併規則、重試
- [docs/backup.md](docs/backup.md) — 備份策略與還原步驟
- [docs/prediction.md](docs/prediction.md) — 下一餐預測演算法
- [docs/csv-export.md](docs/csv-export.md) — CSV 匯出規格與限制
- [docs/growth-percentiles.md](docs/growth-percentiles.md) — WHO 成長百分位資料來源與計算方式

## 已知限制（本版範圍）

- 單一寶寶（資料結構有 `babyId` 擴充空間，但沒有切換 UI）
- 不支援親餵計時，只記錄瓶餵（含擠出母乳）的量
- CSV 匯出是一次性快照，不會自動同步到 Google 日曆；真要自動同步需改走 Calendar API + OAuth
- 沒有背景推播通知，「預計下一餐」只在開 App 時顯示
