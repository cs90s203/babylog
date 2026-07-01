# 同步機制（Firebase / Firestore）

> 這份文件描述目前的架構。專案早期版本用 GitHub repo 當儲存後端（拉取/合併/推送/SHA
> 重試），已經整個換掉；如果在別處看到 GitHub token 相關的說明，那是舊版文件，以這份為準。

實作見 [js/firebase-sync.js](../js/firebase-sync.js)。

## 為什麼換成 Firebase

GitHub 版本每支手機都要手動申請、貼上一組 GitHub token 才能同步，對非工程背景的家人不友善。
Firebase 提供現成的 Google 登入 + 即時資料庫，使用者只要「登入一次」，不用管任何 token。

## 身分驗證

- 用 **Firebase Authentication** 的 Google 登入（`signInWithPopup`，彈窗被擋時退回
  `signInWithRedirect`）。
- 誰能登入不是由前端程式碼決定，是由 **Firestore Security Rules**（見
  [firestore.rules](../firestore.rules)）裡的 email 白名單決定——就算有人拿到這個網站
  的網址、甚至拿到 `firebaseConfig`（這組本來就會公開在前端程式碼裡，不是密鑰），只要他的
  Google 帳號 email 不在白名單，Firestore 一律拒絕讀寫。
- 前端也會做一次同樣的 email 檢查（`ALLOWED_EMAILS`），純粹是為了在不符合白名單時能立刻
  顯示「此帳號未被授權」並自動登出，而不是讓使用者看到一堆 permission-denied 的技術錯誤。
  真正的防線一定是 Security Rules，前端檢查只是體驗優化。

## 資料流：即時監聽，沒有「同步」按鈕

```
本機新增/修改一筆事件
  → Store.addEvent()/updateEvent() 寫入 localStorage、觸發畫面重繪
  → 同時呼叫 Store._cloudPush()（如果已登入）
  → Firestore 寫入該筆文件

另一支手機（已登入同一白名單帳號）
  → Firestore onSnapshot 監聽器收到變動
  → Store.mergeRemote() 寫入本機 Store.data、觸發畫面重繪
```

跟舊版 GitHub 方案最大的差異：**每一筆事件/成長紀錄是 Firestore 裡獨立的一份文件**（不是
整包塞在一個 JSON 檔案裡），所以完全不需要「拉取整包 → 手動合併 → 推送 → 版本衝突重試」這
一整套邏輯——Firestore 本身就用文件等級處理併發寫入，兩支手機同時新增不同的兩筆紀錄，天生
不會互相覆蓋。也因為監聽器是即時的，**不需要下拉重新整理**；App 一開就是最新資料，其他裝置
的變動幾秒內就會自動出現。

## 合併規則（仍然保留，用在同一筆紀錄被兩邊都改到的罕見情況）

- `events` / `growth`：每個文件都有 `updatedAt`，收到遠端版本時比較時間戳，較新的才覆蓋本機
  （`Store.mergeRemote`）。
- `settings`：整包 last-write-wins，比較 `settings.updatedAt`（`Store.mergeRemoteSettings`）。

## 離線支援

`firebase-sync.js` 呼叫了 `fbDb.enablePersistence()`，Firestore SDK 會把資料快取在
IndexedDB。沒有網路時本機新增的紀錄照常可以記（`Store` 本來就是 localStorage-first），
Firestore SDK 會把還沒送出的寫入排隊，恢復網路後自動補送。

## 狀態回饋

首頁頂部同步小提示列：
- 尚未登入：「🔗 點擊登入以同步」（點擊觸發 Google 登入）
- 登入中：轉圈「登入中…」
- 監聽器連接中：轉圈「連接中…」
- 已連接：「✓ 即時同步中」（會一直顯示，不會像舊版那樣幾秒後消失——因為現在是持續連線狀態，
  不是一次性動作）
- 帳號不在白名單：紅字顯示「此 Google 帳號未被授權使用」，並自動登出
- 其他錯誤（網路、Firestore 規則問題等）：紅字顯示錯誤訊息，點擊可重新嘗試登入

## Firestore 安全規則

見專案根目錄的 [firestore.rules](../firestore.rules)，要貼到 Firebase 控制台
**Firestore Database → Rules** 才會生效（這個檔案本身放在 repo 裡只是留存 + 版本控制，
Firebase 不會自動讀取 repo 裡的檔案）。

要新增/移除允許存取的家庭成員，就是編輯這個規則檔裡的 email 陣列，重新貼到控制台存檔即可，
不需要改任何前端程式碼。
