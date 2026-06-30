# 資料模型

## 同步資料：`data.json`（GitHub repo 內），鏡射在每支手機的 `localStorage['bt_data']`

```jsonc
{
  "events": [
    {
      "id": "uuid",
      "babyId": "default",          // 預留多寶寶擴充，本版固定值（未來用）
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
| `bt_caregiver` | 這支手機的「我是…」 |
| `bt_local_theme` | day / night / auto |
| `bt_local_gh_token` | GitHub fine-grained token |
| `bt_local_gh_repo` | `owner/repo` |
| `bt_local_last_sync` | 上次同步成功時間（顯示用） |
| `bt_local_last_backup_date` | 今天是否已寫過每日備份（避免重複寫入） |

這些 key 都不會出現在 `data.json` 裡，不會被推上 GitHub。
