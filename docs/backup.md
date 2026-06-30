# 備份策略

實作見 `Sync.maybeBackup` / `Sync.pruneBackups` in [js/sync.js](../js/sync.js)。

`data.json` 是工作檔，但它**從來不是唯一一份**：

## 第一層：每日快照

- 觸發時機：**每天第一次同步成功時**（用本機 `bt_local_last_backup_date` 記錄今天是否已備份過，避免
  同一天重複寫入）。
- 命名規則：`backups/data-YYYY-MM-DD.json`，內容是合併後的完整 `data.json`。
- 寫入前會先檢查當天的備份檔是否已存在（避免覆蓋掉當天稍早、可能不同內容的快照——理論上同一天只會
  寫一次，這是雙重保險）。

## 保留策略

- 預設保留**最近 30 天**的每日備份。
- **每月 1 號的那份**永久保留，不會被清除（長期回溯用）。
- 超過 30 天且不是 1 號的快照，下次同步時會被自動刪除（`pruneBackups`）。

## 第二層：GitHub commit 歷史

每一次 `PUT /contents/data.json` 本身就是一個 git commit。就算 `backups/` 目錄被誤刪，仍然可以從
GitHub repo 的 commit 歷史（`git log` 或 GitHub 網頁的 "History" 按鈕）回溯任一次變更、看 diff、或
revert。

## 還原步驟（合併出錯 / 檔案損毀時）

1. 到你存資料的 GitHub repo 網頁，開 `backups/` 資料夾，找到要還原的日期（例如 `data-2026-06-15.json`）。
2. 確認內容正常（可以直接在 GitHub 網頁預覽 JSON）。
3. 兩種還原方式：
   - **手動**：把該檔內容複製，貼到 `data.json` 並 commit（GitHub 網頁可以直接編輯 commit）。
   - **App 內**（若有提供還原 UI）：呼叫 `Sync.restoreFromBackup('2026-06-15')`，會把該快照整份寫回
     `Store.data` 並存到 localStorage（之後仍需要再跑一次 `Sync.sync()` 才會推回 GitHub 的
     `data.json`）。
4. 還原後，請所有裝置都手動下拉同步一次，確保大家拉到的是還原後的版本（避免有裝置帶著損毀前的舊
   `data.json` 又把它推回去蓋掉還原結果）。
5. 如果連 `backups/` 都不可信，退回方案二：到 repo 的 commit 歷史找 `data.json` 在出問題之前的版本，
   用 GitHub 網頁的 "Revert"或直接複製該版本內容覆蓋現在的 `data.json`。
