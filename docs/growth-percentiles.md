# 成長百分位（WHO 標準）

實作見 [js/who-data.js](../js/who-data.js)。

## 資料來源

`WHO_LMS` 表格內的 L/M/S 參數，取自 CDC 代管的 WHO Child Growth Standards 資料檔：
`https://ftp.cdc.gov/pub/Health_Statistics/NCHS/growthcharts/WHO-{Boys|Girls}-{Weight|Length|Head-Circumference}-for-age-Percentiles.csv`，
涵蓋出生到 24 個月、男女分開、體重／身長／頭圍三項指標，每月一筆 L、M、S 參數（源自 WHO Multicentre
Growth Reference Study）。

如需更高精度或 24 個月以上的資料，請直接到 WHO 官方網站
`https://www.who.int/tools/child-growth-standards` 下載完整對照表替換 `who-data.js` 裡的 `WHO_LMS`。

## 計算方式（真正的 LMS Z-score，不是近似內插）

對任一年齡（月齡可以是小數，內插相鄰兩個月的 L/M/S），給定測量值 X：

```
若 |L| 很接近 0：
    Z = ln(X / M) / S
否則：
    Z = ((X / M)^L − 1) / (L * S)

percentile = Φ(Z) * 100   // Φ = 標準常態分布的累積分布函數
```

畫成長曲線上的參考百分位線（3rd/15th/50th/85th/97th）則是反過來，給定 percentile 算回 Z（用
Acklam 反常態分布近似算法），再代回：

```
X = M * exp(S * Z)              // L ≈ 0
X = M * (1 + L * S * Z)^(1/L)   // 其他情況
```

## 為什麼這樣比原型的「近似縮放」準確

最初的高保真原型只在 7 個年齡點（0/3/6/9/12/18/24 月）硬寫死中位數，且用固定倍率縮放出其他百分位
曲線，沒有逐月查表也沒有真正算 Z-score。現在改成：

1. 逐月（0–24，每月一筆）的真實 WHO LMS 參數，年齡用線性內插。
2. 用標準的 LMS 公式算精確 Z-score / percentile，而不是套固定倍率。

## 限制與免責聲明

- 範圍僅 0–24 個月；超過範圍的寶寶不會畫百分位曲線。
- 必須先在「設定」填寶寶生日與性別，才能算年齡、選對男女表。
- UI 上明確標註「僅供參考、非醫療診斷」——這是統計上的群體分布位置，不是醫療判斷，異常生長狀況請
  諮詢小兒科醫師。
