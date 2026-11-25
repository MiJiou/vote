# 用自己的電腦＋Cloudflare 上線

看板跑在你自己的電腦上，Cloudflare Tunnel 從電腦「往外」連到 Cloudflare，觀眾透過你的網址（例如 `https://vote.你的網域.tw`）看到看板。
不需要開放家裡或公司的網路埠，也不需要固定 IP。

> 不能用 Cloudflare 免帳號的「Quick Tunnel」（trycloudflare.com）：它最多只能同時處理 200 個請求、不支援即時推播、每次重開網址都會變，開票當晚撐不住。

## 需要準備的東西

| 項目 | 說明 |
|---|---|
| 一台電腦 | Windows 10/11 或 macOS。開票當晚從傍晚到深夜要一直開機、不能睡眠。建議用有線網路，並接上不斷電或筆電電源。 |
| Node.js 22 | 到 <https://nodejs.org/> 下載「LTS」版本安裝（需要 22.18 以上）。 |
| Cloudflare 帳號 | 免費，到 <https://dash.cloudflare.com/sign-up> 註冊。 |
| 一個網域 | **建議直接在 Cloudflare 買**（後台 **Domain Registration › Register Domains**，`.com` 每年約 US$10）。在 Cloudflare 買的網域立即生效；如果用其他地方買的網域，要把名稱伺服器改到 Cloudflare，可能要等幾小時到一天，**請今天就處理**。 |

## 步驟一：在電腦上啟動看板

1. 把這個專案下載到電腦（GitHub 頁面 › **Code** › **Download ZIP** 後解壓縮，或用 git clone）。
2. 啟動：
   - **Windows**：雙擊 `deploy/start-windows.bat`。
   - **macOS**：雙擊 `deploy/start-mac.command`（第一次若被擋，在檔案上按右鍵 › **打開**）。
3. 第一次會要你設定管理員密碼，接著自動安裝、建置（約 1–2 分鐘）。看到「即時開票看板已啟動」就完成了。
4. 用瀏覽器打開 <http://localhost:3000/admin>，帳號 `admin`、密碼是剛剛設定的。

**這個視窗開票當晚要一直開著。** 程式意外停止時會自動重啟。
Windows 請到 **設定 › 系統 › 電源** 把「睡眠」設為「永不」；macOS 開著視窗期間會自動防止睡眠，但筆電請不要闔上螢幕。

## 步驟二：建立 2026 選舉與候選人

在專案資料夾開一個終端機（Windows：在資料夾路徑列輸入 `cmd` 按 Enter；macOS：終端機 `cd` 到資料夾），執行：

```bash
npm run setup:2026
```

這會建立「2026 直轄市長、縣市長選舉」（草稿）並匯入 22 縣市共 81 位候選人，號次取自中選會選舉公報。
**請到後台「候選人」頁逐一核對一次**，特別是 `scripts/data/candidates-2026.csv` 裡「備註」欄有註記的幾筆（政黨名稱寫法、罕見字、臺東縣的政黨）。
照片可以在同一頁用「從維基共享資源找照片」和「批次上傳」處理。

## 步驟三：建立 Cloudflare Tunnel

1. 登入 <https://dash.cloudflare.com/>，到 **Networking › Tunnels**，按 **Create Tunnel**。
2. 名稱填 `vote`，按 **Create Tunnel**。
3. 在 **Setup Environment** 選你電腦的作業系統（Windows／macOS）與架構，**照畫面上 Install and Run 的指令在你電腦上執行**（Windows 用「以系統管理員身分執行」的命令提示字元）。這會把 `cloudflared` 安裝成背景服務，開機會自動連線。
4. 狀態變成 **Healthy** 後按 **Continue**。
5. 在這個通道的 **Routes** 按 **Add route › Published application**：
   - **Hostname**：子網域填 `vote`（或你喜歡的名字），網域選你的網域
   - **Service URL**：`http://localhost:3000`
6. 按 **Add route**。幾秒後用手機（關掉 Wi-Fi，用行動網路）打開 `https://vote.你的網域`，看得到看板就成功了。

## 步驟四：讓 Cloudflare 分擔流量（數千人必做）

每位觀眾每次更新要抓約 4 KB。若全部由你的電腦送出，5,000 人同時在線、每 1.5 秒更新一次，約需 **115 Mbps 上傳頻寬**，家用網路通常不夠。
加一條快取規則後，同一份資料 Cloudflare 每 2 秒只向你的電腦拿一次，其餘觀眾由 Cloudflare 供應，你的電腦幾乎不受觀眾人數影響。

1. Cloudflare 後台選你的網域 › **Caching › Cache Rules** › **Create rule**。
2. **Rule name**：`開票看板資料`
3. **When incoming requests match** 選 **Custom filter expression**：
   - Field 選 **URI Path**、Operator 選 **starts with**、Value 填 `/api/elections/`
4. **Then › Cache eligibility** 選 **Eligible for cache**，再設定：
   - **Edge TTL**：**Use cache-control header if present, bypass cache if not**
   - **Browser TTL**：**Respect origin**
5. 按 **Deploy**。

看板程式會自己告訴 Cloudflare 每份資料只能保留 2 秒（設定在 `.env` 的 `EDGE_CACHE_SECONDS=2`，啟動程式會自動加上）；草稿選舉一律不會被快取。
觀眾端拿到 Cloudflare 尚未更新的舊資料時會自動再抓一次，畫面不會卡在舊數字。

檢查是否生效：用手機打開 `https://vote.你的網域/api/elections/1/summary` 重新整理幾次，或在電腦上執行下面的指令，第二次應看到 `cf-cache-status: HIT`：

```bash
curl -sI https://vote.你的網域/api/elections/1/summary
```

## 步驟五：上線前檢查

- [ ] 用手機行動網路開看板首頁、轉播版面 `/e/選舉編號/tv` 都正常，右上角顯示「即時更新中」
- [ ] 從外部網址登入後台 `/admin` 正常（登入 Cookie 只在 https 下有效，這是預期的）
- [ ] 後台改一個數字，手機上的看板幾秒內跟著變
- [ ] 跑一次模擬開票演練（見下方），確認電腦撐得住、畫面流暢
- [ ] 演練完把演練用的選舉刪掉或改回草稿；正式選舉在開票前改為「開票中」
- [ ] 選舉當天備份 `data/vote.db`（整個系統的資料都在這一個檔案）

### 模擬開票演練

看板開著的情況下，另開一個終端機：

```bash
npm run demo -- --simulate --seconds 300
```

會建立一場「模擬開票演練」，在 5 分鐘內把 2024 總統大選的票數分批送進系統，可以同時在手機上看即時跳動。

## 加強安全（建議）

- 管理後台密碼請用 12 個字元以上、不要跟其他地方共用。
- 可以在 Cloudflare **Zero Trust › Access** 對 `vote.你的網域/admin*` 和 `/report*` 加上 Email 驗證，只有你指定的信箱能打開後台與回報頁；公開看板不受影響。

## 容量

- 實測一台 4 核心的電腦，不經 CDN 直接面對 9,000 位觀眾同時在線（票數每 0.2 秒變動），零錯誤。
- 照步驟四設定快取後，觀眾抓資料由 Cloudflare 供應；你的電腦只需維持每位觀眾一條很省流量的即時通知連線（每人每秒約 40 bytes，5,000 人約 0.2 MB/s）。
- 觀眾比預期多、或電腦負擔太重時，可以在 `.env` 加一行 `NOTIFY_INTERVAL_MS=3000`（更新通知改為最多每 3 秒一次）後重新啟動。
