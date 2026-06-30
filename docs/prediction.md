# 下一餐預測

實作見 [js/predict.js](../js/predict.js)。

## 演算法

取最近幾餐（最多近 8 餐）的**相鄰間隔**，用**中位數**而非平均數，因為半夜一次超長的空檔（例如戒
半夜奶之後）會讓平均數大幅偏移，但中位數對單一離群值不敏感。

```
feeds = events.filter(type == 'milk').sortByTime()
if feeds.length < 2 or span(feeds) < 2 天:
    return "資料蒐集中"

intervals = []
for i in last min(8, feeds.length) 筆 feeds（從第二筆起）:
    intervals.push(feeds[i].time - feeds[i-1].time)

medianInterval = median(intervals)
nextTime = last(feeds).time + medianInterval + alarmOffsetMinutes
```

## 資料不足時

少於 2 筆喝奶紀錄，或最早與最新一筆喝奶紀錄相差不到 2 天，回傳「資料蒐集中」狀態，畫面顯示
🔍「資料蒐集中…記錄滿兩天後即可預測下一餐」而不是亂猜一個時間。

## 未來可擴充（本版未實作）

- **日夜分桶**：白天間隔通常比晚上短，分開算中位數、依現在是白天還是晚上挑對應的桶。
- **母乳 / 配方分開估**：配方乳通常撐比較久，混在一起算中位數可能被其中一種拉偏。
- **離群值過濾**：例如自動排除「超過 6 小時」的間隔（可能是漏記，不是真的撐那麼久）。
