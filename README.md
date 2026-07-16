# 站會看板 Standup Board

一個部署在 GitHub Pages 上、免自架後端的站會追蹤工具：

- **Backlog 追蹤**：記錄站會議題、類型、負責人、deadline、提出人/日期，用看板方式管理狀態，並可留言討論。「類型」是可自訂的下拉輸入框，會帶入目前已用過的類型供選擇，也可以直接輸入新分類。
- **每日測試追蹤**：多人可各自輸入 FSD 模組的每日追蹤數字，並自動加總成當日 Summary。追蹤項目（預設為開單量／複測數量／複測通過量／Pre-UAT 處理量）可在頁籤內的「追蹤項目設定」自行新增、移除。
- **交付測試追蹤**：依模組(FSD)分組總覽每個功能項目的交付/FT/SIT 測試狀態，含交付時程區間、逾期/已交付/部分交付統計、FT/SIT 狀態分布、SIT TC 總數與已測通數、待補 SIT TC 提示；可設定各交付階段的 FT/SIT 預計完成日與每個功能項目的基本測試天數，系統會自動回推預計測試時程並標示「測試時程不足」的風險項目；也可下載 Excel 範本、上傳填好的 Excel 批次新增/更新模組與功能項目資料。

**資料存在哪裡？** 這個網站本身是純靜態網頁（沒有自己的資料庫伺服器），所有資料都直接寫成**這個 repo 的 GitHub Issues**（用隱藏的資料區塊存結構化欄位、用 labels 做分類查詢、用 Issue 留言功能做討論串）。所以只要大家都指向同一個 repo，資料就是共用的。

---

## 部署步驟

### 1. 建立一個 GitHub repo

到 GitHub 建立一個新的 repository（例如叫 `standup-board`）。

> **公開 vs 私有**：GitHub Pages 若要免費使用，repo 必須是 **Public**（私有 repo 的 Pages 功能需要 GitHub Pro / Team / Enterprise 帳號）。因為資料是寫在這個 repo 的 Issues 裡，選 Public 代表任何人都能在 GitHub 上看到這些 Issues 內容。如果你們的站會內容較敏感，建議：
> - 改用 GitHub 內部/組織帳號的私有 repo + 付費方案，或
> - 只把「網頁靜態檔案」放在一個 public repo 做 Pages，但把 Issues 資料放在另一個 private repo（把 `config.js` 的 `GITHUB_REPO` 指向那個 private repo；team 成員的 Token 需要有該 private repo 的存取權限即可，Pages 網址仍是 public repo 的）。

### 2. 修改 `config.js`

打開 `config.js`，把兩個值改成你剛建立的 repo 資訊：

```js
window.APP_CONFIG = {
  GITHUB_OWNER: "你的GitHub帳號或組織名稱",
  GITHUB_REPO: "standup-board"
};
```

### 3. 把檔案推上 GitHub

在這個資料夾內執行：

```bash
git init
git add .
git commit -m "init standup board"
git branch -M main
git remote add origin https://github.com/<你的帳號>/<repo名稱>.git
git push -u origin main
```

### 4. 開啟 GitHub Pages

repo 頁面 → **Settings** → **Pages** → Source 選擇 **Deploy from a branch** → Branch 選 `main` / `/ (root)` → Save。

等 1-2 分鐘後，GitHub 會給你一個網址，格式通常是：

```
https://<你的帳號>.github.io/<repo名稱>/
```

這就是你要分享給團隊的共用連結。

### 5. 每位使用者設定自己的 Token

因為要寫入 GitHub Issues，每個使用者（包含你自己）都需要一組屬於自己的 **Personal Access Token**：

1. GitHub 右上角頭像 → **Settings** → 左側最下方 **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Repository access** 選 **Only select repositories**，選剛剛那個 repo
3. **Permissions** → **Repository permissions** → 找到 **Issues**，設為 **Read and write**
4. 產生後複製 token（`github_pat_...` 開頭），**它只會顯示一次**
5. 打開站會看板網站 → 右上角「⚙ 設定」→ 貼上 Token，填上自己的顯示名稱 → 儲存

Token 只會存在**該使用者自己瀏覽器**的 localStorage，不會被送到 GitHub 以外的任何地方，也不會被其他使用者看到。每個人要各自貼自己的 Token（不要共用同一組，方便之後個別撤銷）。

---

## 使用方式

- **Backlog 追蹤**：點「＋ 新增 Backlog」建立議題；點卡片可修改類型/負責人/deadline/狀態，並在下方留言記錄討論或處理進度；deadline 在兩天內或已逾期的卡片會自動標色提醒。工具列可勾選要顯示哪幾種狀態（預設只勾待處理/進行中）、依類型或負責人篩選、切換依 Deadline 近到遠或遠到近排序。
- **每日測試追蹤**：先在「模組管理」新增 FSD 模組與負責人；需要的話可在「追蹤項目設定」摺疊區塊新增/移除要追蹤的欄位（至少需保留一項）；選擇日期後，每個模組一列可輸入當日數字，按「儲存」寫回 GitHub；下方 Summary 會自動加總目前畫面上所有模組的數字。切換日期或有其他人更新資料後，按「重新整理」重新拉取最新資料（不是即時同步）。
- **交付測試追蹤**：
  - 點「下載 Excel 範本」取得欄位比照團隊既有《SIT測試管理五大表格》第一工作表的空白範本（FSD、FSD名稱、第一層/第二層、測試情境ID、預計交付時程、交付狀態、FT/SIT測試狀態、TC數量等 28 欄）。
  - 填好後點「上傳 Excel 更新」：系統會逐列檢查必要欄位與日期格式，若有問題會列出「第幾列、哪個欄位」的錯誤清單，**整批中止匯入**，不會寫入部分資料；全部通過才會寫入。上傳時若出現 Excel 裡沒建過的 FSD，會自動在「模組管理」新增對應模組。同一個「測試情境ID」重複上傳視為更新（不會產生重複項目），狀態欄位有變動時舊值會保留一份簡短的變更紀錄。
  - 匯入後可在「測試階段設定」摺疊區塊，針對資料中出現過的每個「交付階段」填 FT/SIT 預計完成日，並設定全域「基本測試天數」預設值；系統會用「該功能交付時程」+「基本測試天數」回推預計測試時程，並在可測試期間不足時標示風險。「交付階段」空白的項目不參與回推，畫面上會標示「未設定交付階段」。
  - 模組卡片依 FSD 分組，顯示交付時程區間、交付狀態統計（逾期未交付／已交付／部分交付）、FT/SIT 狀態分布、SIT TC 總數與已測通數；SIT 非「不需測試」但 TC 數量空白時會提示「需要補上 SIT TC」。點卡片可展開查看每個功能項目的明細與個別覆寫「基本測試天數」。

---

## 已知限制

- 沒有即時同步，多人同時看畫面時需要各自按「重新整理」才會看到別人剛存的資料。
- 目前一次讀取上限抓 100 筆（Backlog items、每日模組項目），對一般團隊用量足夠；若累積超過 100 筆 backlog，較舊的項目可能不會顯示在清單中，需要另外加分頁功能。
- Token 存在瀏覽器 localStorage：若使用共用電腦，建議使用完在瀏覽器清除資料，或使用權限範圍最小的 fine-grained token。
- 受 GitHub API 速率限制（已登入 Token 每小時 5000 次請求），一般團隊規模不會碰到上限。
- 「交付測試追蹤」的測試情境資料量可能上千筆，若比照其他功能「一筆一個 issue」會嚴重超過速率限制，因此改成**每個模組(FSD)合併成一個 issue**（body 存整批 JSON）。代價是單一測試情境沒有自己的 GitHub issue、無法個別留言；單一模組底下的測試情境筆數建議不要超過數百筆（issue body 上限 65536 字元）。
- Excel 讀寫透過外部 CDN（cdn.sheetjs.com）載入函式庫，需要網路連線才能下載/上傳範本；離線環境無法使用「交付測試追蹤」的 Excel 功能。
- 想直接在 GitHub 上看原始資料：到 repo 的 **Issues** 分頁即可看到所有 backlog / 模組 / 每日紀錄（會有一段人類可讀的摘要文字，方便直接瀏覽）。
