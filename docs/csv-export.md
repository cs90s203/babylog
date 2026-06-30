# CSV 匯出（Google 日曆）

實作見 [js/csv.js](../js/csv.js)。

## 欄位

嚴格採用 Google Calendar CSV import 的欄位順序：

```
Subject, Start Date, Start Time, End Date, End Time, All Day Event, Description
```

- 日期格式 `MM/DD/YYYY`，時間格式 `hh:mm AM/PM`（內部一律存 ISO 字串，匯出時才轉換，使用瀏覽器
  當地時區，亦即手機目前所在時區——若一家人不同時區同步使用，CSV 匯出的時間以「匯出當下那支手機」
  的時區為準）。
- `All Day Event` 固定為 `False`（本 app 沒有整天事件）。
- `Description` 固定為「由 {照顧者} 記錄」。

## Subject 規則

| 類型 | 範例 |
|---|---|
| 喝奶（母乳） | `🍼 喝奶 120ml（母乳）` |
| 喝奶（配方） | `🍼 喝奶 120ml（配方乳）` |
| 喝奶（混合） | `🍼 喝奶 150ml（混合）` |
| 排便 | `💩 排便` |
| 尿尿 | `💧 尿尿` |

## 起訖時間怎麼算

依「設定 → 事件時長」裡每種類型的 `mode` + `minutes`：

- `mode = "end"`：事件紀錄的時間當**結束**，往前推 `minutes` 分鐘當開始。
- `mode = "start"`：事件紀錄的時間當**開始**，往後推 `minutes` 分鐘當結束。
- `minutes = 0`：起訖相同（日曆上會是一個瞬間的事件）。

## 匯出範圍

使用者在「設定 → 匯出 Google 日曆」自由選 A 日 → B 日，**含頭含尾**，跟首頁時間軸的
今天/週/月/年切換完全脫鉤（互不影響）。

## 限制

- 這是**一次性快照匯出**，不是即時同步。匯出後，App 裡新增/修改的紀錄不會自動反映到已匯入的
  Google 日曆事件上。
- Google Calendar 的 CSV 匯入**沒有去重機制**：同一個範圍重複匯入兩次，會在日曆上產生兩份重複事件。
  建議每次只匯入「上次匯出之後」的新範圍。
- 若要做到真正的自動同步（App 新增紀錄即時反映到 Google 日曆），需要改走 **Google Calendar API +
  OAuth**，這是未來項目，本版不實作。
