# 台股觀測站

[![測試](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/ci.yml/badge.svg)](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/ci.yml) [![公開版網站](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/publish.yml/badge.svg)](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/publish.yml) [![官方資料來源檢查](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/check-sources.yml/badge.svg)](https://github.com/foktengkit/tw-stock-predictor/actions/workflows/check-sources.yml)

台灣股市即時看盤 + 股價預測網站，介面參考 TradingView：中間是可互動的 K 線圖，右側是自選股與五檔報價，下方是 AI 預測、技術分析與熱力圖。

有兩個版本：

| | 私人版（本機執行） | 公開版（GitHub Pages） |
| --- | --- | --- |
| 網址 | <http://localhost:3000> | <https://foktengkit.github.io/tw-stock-predictor/> |
| 報價 | 盤中即時（證交所 MIS，延遲 30–60 秒） | 收盤資料，官方公布後約 15 分鐘內更新 |
| 資料來源 | MIS、Yahoo、官方盤後資料 | 只用官方盤後資料（證交所、櫃買中心、公開資訊觀測站） |
| K 線週期 | 1 / 5 / 15 / 60 分、日、週、月 | 日、週、月 |

公開版的做法見下方「[公開版（GitHub Pages）](#公開版github-pages)」。

## 啟動

需要 Node.js 22.13 以上（使用內建的 SQLite）。

```bash
npm install
npm run sync     # 第一次：下載官方資料（約 1.5–2 小時，可中斷、下次會接著抓）
npm start
```

沒有執行 `npm run sync` 也能使用網站，只是「籌碼・營收」分頁與官方成交量會是空的。伺服器啟動後，會在平日盤後自動補上最新的官方資料。

然後打開 <http://localhost:3000>。Windows 也可以直接雙擊 `start.bat`。

可以用網址指定股票，例如 `http://localhost:3000/#2454`；加權指數是 `#t00`。

## 功能

| 區塊 | 內容 |
| --- | --- |
| K 線圖 | 1 / 5 / 15 / 60 分、日、週、月線；K 線、美國線、折線、面積圖；MA、EMA、布林通道、成交量、RSI、MACD、KD；均線金叉 / 死叉標記 |
| 即時同步 | 伺服器每 5 秒向證交所 MIS 取報價，透過 WebSocket 推給瀏覽器，最後一根 K 棒、指標、自選股、五檔同步跳動。MIS 是公開的免費資料，盤中實測快照約 25 秒更新一次、延遲約 30–60 秒（券商的即時報價需要另外申請） |
| AI 預測 | 4 個模型集成預測未來 20 個交易日，畫在圖上（虛線＋80% 區間），附回測準確率 |
| 技術分析 | 26 項指標的偏多 / 偏空訊號統計，儀表板呈現「強烈偏空 ~ 強烈偏多」（不是買賣建議），可切換週期；經典 / 費波那契 / 卡瑪利拉樞紐點 |
| 籌碼・營收 | 三大法人買賣超、融資融券餘額、月營收與年增率（官方資料），以及「這些資料能不能預測相對強弱」的因子檢驗 |
| 熱力圖 | 台灣 50 主要成分股，面積＝成交值、顏色＝漲跌幅，每 10 秒更新 |
| 其他 | 搜尋全部上市櫃股票與 ETF（在頁面任意處直接打代號也能搜尋）、自選股（存在瀏覽器）、水平線工具、截圖、深淺色主題、手機版排版 |

顏色採台股習慣：**紅漲綠跌**。

## 使用聲明

- **僅供個人研究與學習。** 本專案不構成任何投資建議。預測與技術指標的檢驗結果都顯示，它們扣除交易成本後沒有可靠的預測力（見下方「預測模型」與「因子檢驗」）。投資請自行判斷並承擔風險。
- **請勿把即時報價架成公開網站轉播。** 程式會從證交所「基本市況報導」（MIS）與 Yahoo 取得報價。這些資料的版權屬於證交所及各資料提供者，轉播即時行情需要另外取得授權。請只在自己的電腦上執行即時版。
- **盤後資料**：來自證交所、櫃買中心與公開資訊觀測站，依各單位的使用規範（政府資料開放授權條款）註明出處後使用。
- 程式碼以 [MIT 授權](LICENSE)釋出；資料本身不在授權範圍內。

## 預測模型

`lib/predict.js`，用日 K 收盤價（對數價格）計算：

1. **阻尼趨勢指數平滑（Damped Holt）**：參數用格點搜尋最小化一步預測誤差
2. **線性趨勢回歸**：近 60 日回歸，斜率折半避免過度外插
3. **AR(5) 自我迴歸**：以前 5 日報酬預測下一日（Ridge 正則化）
4. **K 近鄰型態比對**：在歷史中找出與近 20 日走勢形狀最像的 12 段，平均其後續走勢

**樣本外回測（walk-forward）**：在過去約 2 年中，每 5 個交易日站在當時做一次「5 日後價格」預測，共 100 次。規則如下：

- 每次都只用當時以前的資料重新估計模型參數
- 相鄰兩次預測的評估區間互不重疊
- 集成權重只用「當時已揭曉答案」的過去誤差（誤差倒數）
- 盤中尚未收盤的今日 K 棒不當回測答案

`npm test` 會跑前視偏差的金絲雀測試：改動某時點之後的資料，確認該時點以前的預測、權重與技術指標完全不變。

**價格**：模型使用還原權息價格，避免把除息缺口當成下跌；畫面上的預測價再依已公告的除權息預告換回原始股價。

**區間與機率**：以 EWMA 波動度估計 80% / 95% 區間與上漲機率。

**基準**：介面同時顯示兩個基準：

- 「隨機漫步」（未來價格＝今天價格）的誤差
- 「永遠猜漲」的方向命中率

方向準確率要高於兩者的 95% 信賴區間下緣，才標示為顯著。5 日與 20 日預測都會回測；20 日預測每 5 日做一次，區間互相重疊，信賴區間以有效樣本數計算。

實測台灣 50 成分股（2024/10–2026/11），結果如下：

- 80% 區間的實際涵蓋率約 80–82%，校準良好
- 集成模型**沒有**打敗基準：20 日方向準確率 55.9%，低於「永遠猜漲」的 59.4%
- 上漲機率在這段多頭期間偏低：模型說 45–50% 的，實際約 60% 上漲

這是正常的：只靠歷史價格很難穩定打敗市場。技術面評等只當參考資訊，不和預測混成買賣建議，因為實測評等最空（舊稱「強力賣出」）之後 20 日平均仍上漲 2.2%，所以畫面改用「偏多／偏空」，不用買賣字眼。法人、融資券、月營收等資料的檢驗見下方「因子檢驗」。

> ⚠️ 預測僅供研究與學習，不構成投資建議。

## 資料來源

| 資料 | 來源 | 說明 |
| --- | --- | --- |
| 即時報價、五檔、指數 | 證交所基本市況報導 MIS `mis.twse.com.tw` | 實測約 25 秒更新、延遲 30–60 秒；多台伺服器回傳的快照新舊不一，程式會丟棄較舊的快照。程式已限制每秒最多 1 次請求 |
| 歷史 K 線 | Yahoo Finance chart API | 上市 `.TW`、上櫃 `.TWO`、加權指數 `^TWII`。非官方 API，日後格式可能改變 |
| 股票清單 | 證交所 / 櫃買中心 OpenAPI | 每 12 小時更新，快取在 `data/stocks.json` |
| 休市日曆 | 證交所「市場開休市日期」 | 抓今年與明年，每 6 小時同步，快取在 `data/holidays.json` |
| 颱風停班 | 人事行政總處「天然災害停止上班及上課情形」 | 每 10 分鐘檢查臺北市公告 |

### 休市日曆同步

休市日曆和報價一樣由伺服器持續同步。只要日曆有變動，伺服器會立刻透過 WebSocket 通知所有開著的頁面：跳出提示、重新計算預測日期、更新盤勢狀態。點右上角的盤勢徽章可以看到日曆與三項檢查的最新狀態。

| 檢查 | 頻率 | 判斷 |
| --- | --- | --- |
| 證交所開休市日曆 | 每 6 小時 | 國定假日、補假、春節前「僅辦理結算交割」的無交易日。日曆裡的「開始交易日」「最後交易日」有開盤，不算休市 |
| 臺北市颱風停班 | 每 10 分鐘 | 依[證交所規定](https://www.twse.com.tw/zh/about/suspended_faq.html)：臺北市宣布「全日」或「上午」停止上班 → 全日休市；只宣布「下午」停班 → 照常開盤。區里層級的公告不列入 |
| 開盤確認 | 每次取加權指數 | 平日 09:10 後連續 3 次都沒有當日資料 → 判定臨時休市；一出現當日資料 → 確認有開盤，可推翻推估或誤判 |

- **明年日曆還沒公布時**（通常在年底才公布），該年只排除固定日期的國定假日，例如 1/1、2/28、10/10，介面會標示「推估」。農曆節日與補假在官方公布前無法得知。
- 颱風停班通常在前一晚 19:00–22:00 公布，因此隔天休市會在前一晚就反映在預測日期上。
- 伺服器即使沒有人連線，也會持續取得加權指數，以便確認當天是否開盤。

測試用環境變數：`DGPA_URL`（停班頁面網址）、`CALENDAR_FILE`（日曆快取路徑）、`TYPHOON_CHECK_MS`（停班檢查間隔）。

已知限制：

- 櫃買指數在 Yahoo 沒有歷史資料，只顯示即時報價

## 官方資料：成交量、籌碼、月營收

`npm run sync` 會把下列官方資料存進 `data/official.db`（SQLite）。之後伺服器在平日 14:00–23:30 每 30 分鐘補最新資料，有新資料時即時通知頁面。

| 資料 | 來源 | 範圍 |
| --- | --- | --- |
| 上市每日收盤行情（官方總成交量） | 證交所 MI_INDEX | 5 年 |
| 上櫃每日收盤行情 | 櫃買中心 | 2.5 年 |
| 上櫃官方總成交量 | 櫃買「個股日成交資訊」，看到哪檔就在背景下載哪檔 | 5 年 |
| 三大法人買賣超 | 證交所 T86、櫃買中心 | 2.5 年 |
| 融資融券 | 證交所 MI_MARGN、櫃買中心 | 2.5 年 |
| 除權除息結果 | 證交所 TWT49U、櫃買中心 | 與股價相同（5 年） |
| 月營收 | 公開資訊觀測站 | 5 年 |

每個主機每 2.5 秒最多 1 次請求，失敗會退避重試。最近 7 天的「沒資料」會再重抓，因為資料可能只是還沒公布。

### 為什麼 Yahoo 的成交量比官方少

官方的「成交股數」是五類交易的合計。以台積電 2026/11/03 為例，合計正好等於官方的 46,137,336 股：

| 交易類別 | 股數 | Yahoo 歷史 K 棒 | MIS 即時 |
| --- | --- | --- | --- |
| 盤中整股 | 36,567,000 | ✅ | ✅ |
| 盤中零股 | 7,827,582 | ❌ | ❌ |
| 鉅額交易 | 1,311,000 | ❌ | ❌ |
| 盤後零股 | 263,754 | ❌ | ❌ |
| 盤後定價 | 168,000 | ❌ | ❌ |

Yahoo 的歷史 K 棒只算盤中整股。所以零股比例越高的股票，差距越大：台積電、0050 這類高價或存股熱門標的差 10–20%，鴻海約 2–3%。

網站的日、週、月線成交量已改用官方總量。分線圖沒有官方資料，仍是盤中整股。當天收盤、官方資料公布前，最後一根 K 棒用的是 MIS 的盤中整股量。

另外，櫃買中心的「全市場每日收盤行情」也只含整股，官方總量要從「個股日成交資訊」逐檔下載。

### 因子檢驗：股價以外的資料能預測什麼？

這裡問的不是「明天會漲還是跌」，而是「哪些股票接下來比其他股票強」。

**檢驗方法**

1. 每 5 個交易日，從成交值前 300 大的普通股中，用「當天收盤後已公布」的資料計算因子。月營收要過了次月 10 日的申報期限才能使用。
2. 從**隔天收盤**起，量之後 20 個交易日的還原權息報酬。
3. 計算因子排名與報酬排名的相關係數（IC），以及因子最高 20% 與最低 20% 兩組股票的報酬差。

每次檢驗的 20 日區間互相重疊，t 值已依重疊程度調整。本頁共做 12 個檢定（主檢驗 8 個、長期檢驗 4 個），所以顯著門檻設為 |t| ≥ 2.87（Bonferroni）。計算在伺服器的背景執行緒進行，約 10 秒，不影響即時推播。

**結果（資料到 2026/11/04）**

| 因子 | 主檢驗：上市＋上櫃，2024/06–2026/10 | 長期檢驗：僅上市，2021/12–2026/09 | 各年 IC（長期） |
| --- | --- | --- | --- |
| 月營收年增率 | IC 0.053、t 2.39（邊緣） | IC 0.044、t 2.73（邊緣） | 2022 +0.002、2023 +0.031、2024 +0.036、2025 +0.078、2026 +0.101 |
| 營收年增率加速 | IC 0.019、t 1.34 | IC 0.033、t 2.96（**顯著**） | 每年都是正值（+0.02～+0.06） |
| 外資買超強度 | IC 0.022、t 1.29 | —（籌碼只有 2.5 年） | |
| 投信、融資、券資比 | \|t\| < 0.4 | — | |
| 價格動能、短期反轉 | \|t\| < 0.3 | \|t\| < 1 | |

**怎麼解讀**

- **籌碼因子（法人、融資券）沒有預測力。** 2.5 年的資料裡，看不出它們能分辨後續的強弱。
- **月營收年增率的效果集中在近兩年。** 2022 年空頭幾乎沒有效果（IC +0.002），之後逐年變強。這比較像是 AI 供應鏈「營收大增、股價也大漲」這段行情造成的，還不能說是穩定的規律。
- **營收年增率加速是唯一通過門檻、而且每年都是正值的因子。** 但效果很小：最高與最低兩組的 20 日報酬差只有 0.68%。台股來回一趟的成本約 0.59%（手續費 0.1425% × 2，加上證交稅 0.3%），扣掉之後幾乎沒有剩下。
- 因此這些因子只在「籌碼・營收」分頁顯示本股的排名與檢驗結果，**沒有加進股價預測**。

## 公開版（GitHub Pages）

網址：<https://foktengkit.github.io/tw-stock-predictor/>

公開版沒有伺服器，是官方資料一有更新就重新產生的靜態網站：`scripts/build-public.js` 把官方資料庫轉成靜態 JSON（每檔股票的日 K、籌碼與營收、報價、因子檢驗、休市日曆、除權息預告），連同前端一起輸出到 `dist/`（約 150 MB），再發布到 GitHub Pages。自動化流程見下方「[CI/CD](#cicd)」。

前端與私人版是同一份程式。`public/js/util.js` 的 `api()` 在公開版改呼叫 `public/js/static-api.js` 讀靜態檔案；預測模型與技術評等直接在瀏覽器計算。

**為什麼只放盤後資料**：轉播證交所即時行情需要授權，Yahoo 的資料也不能轉載；盤後資料屬於政府開放資料，註明出處即可使用。詳見上方「使用聲明」。

和私人版的差異：

- 沒有盤中報價、五檔與分線（分線沒有官方公開的歷史資料）
- 還原權息由官方除權息資料自行計算：普通股超過漲跌幅限制、又沒有除權息紀錄的跳空（減資、分割），視為公司行動而非漲跌
- **上櫃股票的成交量只含盤中整股**（不含零股、鉅額、盤後）。櫃買中心的官方總量要逐檔逐月下載，不適合每天全部更新；上市股票則是官方總量

本機預覽：

```bash
npm run sync -- --otc-daily-years 5    # 上櫃股價補到 5 年、加權與櫃買指數歷史
npm run build:public                   # 輸出到 dist/
```

`dist/` 要用網頁伺服器開啟（例如 `python -m http.server -d dist`），直接開檔案會因瀏覽器安全限制無法讀取資料。

## CI/CD

三個 GitHub Actions 工作流程，任何一個失敗 GitHub 都會寄信通知：

| 工作流程 | 何時執行 | 做什麼 |
| --- | --- | --- |
| **測試**（`ci.yml`） | 每次推送、每個 Pull Request | Node 22 與 24 跑全部 Node 測試，Python 3.12 跑回測測試 |
| **公開版網站**（`publish.yml`） | 平日 14:00–22:45 每 15 分鐘（cron-job.org）；網站相關程式推送到 main；手動 | 測試 → 同步官方資料 → 有新資料才建置 → 發布 → 上線驗證 |
| **官方資料來源檢查**（`check-sources.yml`） | 每個平日 22:07 | 12 個官方來源連得上嗎？格式有沒有變？ |

發布流程的每一關都會擋下有問題的版本，網站維持前一版：

1. **測試**：沒過就不建置、不發布。
2. **同步官方資料**：資料庫存在 Actions 快取，每次只補新資料（第一次約 3 小時，之後幾十秒）。
3. **有沒有新資料**（`scripts/check-new-data.js`）：比對資料庫的「資料指紋」（每個資料表的筆數與最新日期）和線上網站記錄的指紋。一樣就到此結束，不建置、不發布；推送程式碼或手動勾選「強制發布」時一律發布。
4. **建置**：資料不完整（例如股票清單只拿到一個市場）就中止。
5. **發布**到 GitHub Pages。
6. **上線驗證**（`scripts/verify-site.js`）：等 CDN 換成這次的版本，檢查關鍵資料檔與資料日期，再用 Chrome 實際打開網站，確認 K 線、預測、籌碼都畫得出來，而且沒有任何 JavaScript 錯誤。

### 為什麼用外部排程（cron-job.org）

官方盤後資料是分批公布的：收盤行情約下午 2 點多、三大法人約下午 3–4 點、融資融券要到晚上。要在公布後馬上更新，就得在這段時間頻繁檢查。

GitHub 內建的排程（`schedule`）不準時：實測設定 22:30 的排程，每次都延遲 7–11 小時，到隔天早上才執行。用 API 觸發（`workflow_dispatch`）則幾秒內就會開始，所以改由 cron-job.org 準時呼叫 API。大部分的觸發都沒有新資料，約半分鐘就結束；公開儲存庫的 Actions 不用錢。

GitHub 內建排程仍保留在每個平日 22:23，當作 cron-job.org 萬一沒觸發時的備援。

設定方式（只需要做一次）：

1. **GitHub token**：Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token。Repository access 選「Only select repositories」→ `tw-stock-predictor`，Permissions 只開 **Actions: Read and write**。這個 token 只能觸發這個儲存庫的工作流程，不能改程式碼。
2. **cron-job.org** 新增排程：
   - URL：`https://api.github.com/repos/foktengkit/tw-stock-predictor/actions/workflows/publish.yml/dispatches`
   - 時間：時區 Asia/Taipei，星期一到五，14–22 點，每 15 分鐘（0、15、30、45 分）
   - Advanced → Request method：`POST`；Request body：`{"ref":"main"}`
   - Headers：`Authorization: Bearer <token>`、`Accept: application/vnd.github+json`、`X-GitHub-Api-Version: 2022-11-28`、`Content-Type: application/json`
   - 開啟失敗通知：token 過期時呼叫會失敗（HTTP 401），cron-job.org 會寄信提醒
3. 按 Test run，回應 **204** 就成功，GitHub 的 Actions 頁面會出現一次「公開版網站」的執行。

資料來源檢查會驗證數值之間的關係，例如「三大法人合計 = 外資 + 投信 + 自營商」，官方調整欄位時才抓得到。

在本機執行同樣的檢查：

```bash
npm test                 # 全部 Node 測試
python backtest/test_tw_backtest.py
npm run check-sources    # 官方資料來源
npm run verify-site      # 線上網站（需要 Chrome）
node scripts/check-new-data.js --site https://foktengkit.github.io/tw-stock-predictor/   # 本機資料比線上新嗎
```

## Python 虛擬交易回測（backtest/）

把含 `Date`、`Close`、`Signal` 欄位的 DataFrame 丟進去，就會輸出文字報告。報告內容包括總報酬、年化報酬、夏普比率、最大回撤與發生時間、勝率與盈虧比，並附上「買進持有」對照。

```python
from tw_backtest import backtest, TaiwanCosts
result = backtest(df)                                         # 預設：訊號隔日收盤成交、台股成本
print(result.report())
backtest(df, costs=TaiwanCosts(sell_tax_rate=0.001))          # ETF 證交稅 0.1%
```

- 驗證測試：`python backtest/test_tw_backtest.py`
- 範例報告：`python backtest/tw_backtest.py`

## 專案結構

```
server.js            Express + WebSocket 伺服器、API 路由、即時推播迴圈
lib/
  twse.js            MIS 即時報價（節流、快取、解析五檔）
  yahoo.js           歷史 K 線（各週期、快取、週 / 月線合併）
  stocklist.js       上市櫃清單與搜尋
  predict.js         預測模型、walk-forward 回測、信賴區間
  dividends.js       除權除息預告（證交所、櫃買）
  rating.js          技術面綜合評等
  market.js          交易時段判斷
  holidays.js        休市日曆（官方日曆 + 即時偵測的臨時休市），變動時發出事件
  closure-watch.js   颱風停班公告與開盤確認
  heatmap.js         熱力圖成分股與產業分類
  factors.js         因子檢驗（法人、融資券、月營收、價格動能的橫斷面 IC、逐年拆解、長期檢驗）；npm run factors
  factors-service.js 伺服器用：在背景執行緒（factors-worker.js）計算並快取，不卡住即時推播
  official/
    sources.js       官方資料下載與解析（證交所、櫃買中心、公開資訊觀測站）
    sync.js          回補與每日同步（限速、續傳）；node lib/official/sync.js
    db.js, query.js  SQLite 資料庫與查詢
    fingerprint.js   資料指紋：有新資料才改變，公開版用來判斷要不要發布
scripts/
  build-public.js    公開版建置：官方資料 → 靜態 JSON + 前端（dist/）
  check-new-data.js  公開版要不要發布：本機資料指紋 vs 線上網站
  check-sources.js   官方資料來源健康檢查
  verify-site.js     公開版上線驗證（HTTP + 用 Chrome 實際打開）
test/
  leakage.test.js    前視偏差、時間切分、除權息、技術指標因果性測試（npm test）
  factors.test.js    因子檢驗的前視偏差測試（月營收公布時間、隔日進場、除權息）
  mis.test.js        MIS 即時報價解析（盤中實際回應格式）
  static-data.test.js 公開版的還原權息、公司行動斷點、週 / 月 K 合併
  stocklist.test.js  股票清單：CSV 格式、取得失敗時沿用上一份
  fingerprint.test.js 資料指紋：有新資料才改變
public/
  index.html, css/style.css
  js/indicators.js   技術指標函式庫（前後端共用）
  js/chart.js        圖表（TradingView Lightweight Charts v5）
  js/app.js          主程式：載入、即時更新、工具列
  js/static-api.js   公開版：/api/* 改讀靜態檔案，預測在瀏覽器計算
  js/*.js            自選股、報價、搜尋、預測、技術分析、熱力圖、WebSocket
.github/workflows/
  ci.yml             每次推送都跑全部測試
  publish.yml        公開版：測試、同步、有新資料才建置發布、上線驗證
  check-sources.yml  官方資料來源每日檢查
```

## API

| 路徑 | 說明 |
| --- | --- |
| `GET /api/search?q=台積` | 搜尋股票 |
| `GET /api/quotes?codes=2330,2317` | 即時報價 |
| `GET /api/history?code=2330&tf=D` | K 線（`tf`：`1m` `5m` `15m` `60m` `D` `W` `M`） |
| `GET /api/predict?code=2330` | 預測結果與回測 |
| `GET /api/rating?code=2330&tf=D` | 技術面評等 |
| `GET /api/heatmap` | 熱力圖資料 |
| `GET /api/market` | 盤勢狀態與大盤指數 |
| `GET /api/calendar` | 今天是否交易日、90 天內休市日、各項檢查狀態 |
| `GET /api/chips?code=2330` | 法人、融資券、月營收序列與該股的因子排名 |
| `GET /api/factors` | 因子檢驗報告 |
| `GET /api/official/status` | 官方資料同步進度與涵蓋範圍 |
| `WS /ws` | 送出 `{"type":"subscribe","codes":["2330"]}`，伺服器持續推送 `{"type":"quotes",...}`；日曆變動時推送 `{"type":"calendar",...}` |

圖表使用 [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)（Apache-2.0），圖表左下角保留其標誌以符合授權要求。
