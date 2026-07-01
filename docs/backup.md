# 備份策略（Firebase / Firestore）

> 舊版（GitHub repo 當後端）靠「每日快照 + git commit 歷史」雙重備份，換成 Firestore 後
> 這兩層都不存在了——Firestore 沒有 git 那種版本歷史，Spark（免費）方案也沒有內建的排程備份
> /還原功能（那是 Blaze 付費方案 + Cloud Functions 才有的東西）。所以備份策略改成更陽春但
> 完全免費、使用者自己掌控的方式。

## 目前的備份方式：手動匯出 JSON

設定頁「資料備份」區塊有一顆「💾 下載備份 JSON」按鈕（見
[js/csv.js](../js/csv.js) 的 `downloadJsonBackup()`），會把 `Store.data`（events、
growth、settings 全部）匯出成一個 JSON 檔案下載到手機/電腦。

建議：
- 三不五時按一次，把檔案存到 Google Drive、雲端硬碟，或直接寄一份到自己信箱。
- 尤其是在做「大量編輯/刪除」之類的操作前後，手動存一份最安全。

這是**使用者主動觸發**的備份，不是自動排程——優點是不用額外的付費方案、不用寫
Cloud Function；缺點是「有沒有定期做」要靠自己養成習慣，App 不會主動提醒。

## Firestore 本身的保護

- Firestore 的寫入是逐筆文件更新（見 [sync.md](sync.md)），不是整包覆蓋，單一筆誤刪只會影響
  那一筆文件本身（軟刪除墓碑機制，見 [data-model.md](data-model.md)），不會波及其他紀錄。
- Firebase 主控台的 **Firestore Database → 資料** 分頁可以直接瀏覽/編輯任一筆文件，如果誤刪
  了一筆事件，只要備份 JSON 裡還有，可以手動在主控台重新建立那份文件（把 JSON 裡對應的欄位
  複製貼回去）。

## 還原步驟（資料出問題時）

1. 找一份最近的備份 JSON（設定頁匯出的那個檔案）。
2. 到 Firebase 主控台 **Firestore Database**，比對備份 JSON 裡的 `events`/`growth`/
   `settings` 跟目前雲端的資料差在哪。
3. 針對缺漏或錯誤的文件，用主控台的「新增文件」/「編輯欄位」手動修正（文件 ID 用備份 JSON
   裡該筆記錄的 `id` 欄位，路徑是 `families/default/events/{id}` 或
   `families/default/growth/{id}`）。
4. 修正完，所有裝置的即時監聽器會自動收到更新，不需要額外操作。

## 未來可以做但目前沒做的事

- 升級到 Blaze（用量計費，但家庭規模用量幾乎不會超出免費額度）之後，可以用 Cloud
  Functions 排程，每天自動把 Firestore 資料匯出一份到 Cloud Storage，恢復類似舊版
  GitHub 方案的自動每日備份。這是未來項目，目前為了維持零花費，先用手動匯出頂著。
