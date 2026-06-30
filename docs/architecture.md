# 架構

純前端 web app，沒有自己的伺服器。GitHub repo 的 Contents API 當「資料庫」。

```
index.html
css/style.css        設計 token（日/夜主題 CSS 變數）+ 共用元件樣式
js/
  who-data.js         WHO LMS 成長曲線資料 + z-score / 百分位數學
  predict.js           下一餐預測（純函式，吃 events 陣列）
  store.js             狀態 + localStorage 持久化（events / growth / settings / caregiver）
  sync.js               GitHub Contents API：pull → merge → push、每日備份
  csv.js                Google 日曆 CSV 匯出
  app.js                所有使用者互動的「動作」（window.A），呼叫 store/sync/csv
  views.js              純渲染：state + Store → innerHTML 字串
  main.js               啟動、全域 pointer/touch 事件（拖曳、下拉同步）
```

## 資料流

```
使用者點按鈕 (onclick="A.xxx()")
  → app.js 的 Action 修改 Store / App.state
  → Store.persist() 寫 localStorage，並通知監聽者
  → views.render(state) 重新產生整個畫面的 HTML
```

沒有 virtual DOM；每次狀態變動就整個畫面字串重繪一次。這個 app 的資料量很小（一個家庭的紀錄），
重繪整個 `#root` 的成本可以忽略，換來的是不需要任何建置工具、純靜態檔案就能部署。

## 同步邊界

| 資料 | 存哪裡 | 同步嗎 |
|---|---|---|
| `events`（喝奶/排便/尿尿）、`growth`、`settings`（寶寶資料、時長設定…） | `localStorage['bt_data']`，鏡射 GitHub repo 的 `data.json` | ✅ 跨裝置同步 |
| `caregiver`（「我是誰」） | `localStorage['bt_caregiver']` | ❌ 只在本機 |
| GitHub token / repo 位置、主題、上次同步時間 | `localStorage['bt_local_*']` | ❌ 只在本機 |

詳見 [data-model.md](data-model.md)。
