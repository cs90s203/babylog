# 資料模型

## 同步資料：Firestore（見 [sync.md](sync.md)），鏡射在每支手機的 `localStorage['bt_data']`

`Store.data` 這個本機物件的形狀維持不變（下面這份 JSON 範例仍然準確），差別只在於它現在是
從 Firestore 的多份文件組裝出來的，而不是單一個 GitHub JSON 檔案：

```
Firestore 路徑                              對應到 Store.data 的哪裡
families/default/events/{id}       ──→     data.events 陣列裡的一筆
families/default/growth/{id}       ──→     data.growth 陣列裡的一筆
families/default/settings/main     ──→     data.settings（單一物件）
```

每筆文件的欄位：

```jsonc
{
  "events": [
    {
      "id": "uuid",                  // 同時也是 Firestore 文件 ID
      "type": "milk | poop | pee",
      "time": "2026-06-30T20:40:00.000Z",  // ISO 8601
      "breastMl": 120,              // 僅 milk
      "formulaMl": 0,                // 僅 milk
      "amountMl": 120,               // 僅 milk，= breastMl + formulaMl
      "by": "媽媽",                   // 記錄當下該裝置的照顧者名字（快照，不是同步身分）
      "updatedAt": "2026-06-30T20:40:01.000Z",
      "deleted": false                // 軟刪除墓碑，見 sync.md
    }
  ],
  "growth": [
    { "id": "uuid", "date": "2026-06-01", "weight": 8.5, "height": 70, "head": 44,
      "updatedAt": "...", "deleted": false }
  ],
  "settings": {
    "babyName": "",
    "babyBirth": "2025-08-15",
    "babySex": "girl",               // boy | girl | ''（未設定時不畫 WHO 百分位）
    "duration": {
      "milk": { "mode": "end", "minutes": 15 },
      "poop": { "mode": "end", "minutes": 15 },
      "pee":  { "mode": "end", "minutes": 15 }
    },
    "defaultMilk": { "breast": 120, "formula": 0 },
    "alarmOffsetMinutes": 0,
    "updatedAt": "2026-06-30T20:40:01.000Z"
  }
}
```

`mode` 語意（用於 CSV 匯出推算事件起訖）：
- `"end"`：`time` 當**結束**，往前推 `minutes` 當開始。
- `"start"`：`time` 當**開始**，往後推 `minutes` 當結束。
- `minutes = 0`：起訖相同。

### 為什麼 events/growth 多了 `updatedAt` / `deleted`，而不是原始規格的「純 append-only」？

原始規格假設 events 只新增不修改。但 UI 需要支援編輯時間、編輯奶量、刪除——這些操作如果直接「修改
陣列裡的物件」或「從陣列移除」，在多裝置合併時會有問題：裝置 A 刪除一筆事件、裝置 B 還沒同步到這個
刪除就推送了舊版本，合併時刪除可能被「復活」。加上 `updatedAt` + 軟刪除墓碑後，合併規則統一是
「同 id 取 `updatedAt` 較新的版本」，刪除也只是把 `deleted` 設成 `true` 的一次更新，能正確地在所有
裝置間收斂。畫面上一律用 `Store.liveEvents()` / `Store.liveGrowth()` 過濾掉已刪除的。

## 本機限定資料

| key | 說明 |
|---|---|
| `bt_caregiver` | 這支手機的「我是…」，跟 Google 登入身分是兩件事（見下方說明） |
| `bt_local_theme` | day / night / auto |
| `bt_local_last_sync` | 上次同步成功時間（顯示用） |

這些 key 完全是本機的，不會出現在任何 Firestore 文件裡，不會同步到其他裝置。

### 「我是…」跟 Google 登入帳號是分開的兩件事

- **Google 帳號**（Firebase Authentication）：決定「這支手機能不能存取家庭資料」，是安全機制，
  一次登入、長期有效。
- **「我是…」**（`bt_caregiver`）：純粹是顯示用的標籤（例如「媽媽」），用來標記每筆記錄的
  `by` 欄位，跟登入帳號無關——理論上同一個 Google 帳號的手機，也可以填不同的照顧者名字（例如
  保母借用某支手機時可以填「保母」）。這個設計沿用自舊版，換掉同步後端沒有改變這個決策。
