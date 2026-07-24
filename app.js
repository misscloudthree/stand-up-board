// =========================================================
// 站會看板 app.js
// 資料庫策略：整個 app 沒有自己的後端，所有資料都寫成
// GitHub Issues（用隱藏的 JSON 區塊存結構化資料，
// 用 labels 做查詢索引，用原生 comments 做留言功能）。
// =========================================================
(function () {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const OWNER = CONFIG.GITHUB_OWNER;
  const REPO = CONFIG.GITHUB_REPO;
  const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

  const LS_TOKEN = "sb_gh_token";
  const LS_NAME = "sb_display_name";
  const LS_BACKLOG_VIEW = "sb_backlog_view_mode";

  const LABEL = {
    backlog: "type:backlog",
    module: "type:module",
    daily: "type:daily-entry",
    dailyField: "type:daily-field",
    testItemBatch: "type:test-item-batch",
    testPhaseSetting: "type:test-phase-setting",
  };

  const STATUS = {
    pending: { label: "待處理" },
    doing: { label: "進行中" },
    done: { label: "已完成" },
    void: { label: "作廢" },
  };
  const STATUS_ORDER = ["pending", "doing", "done", "void"];

  // 既有固定欄位的預設值，key 沿用舊資料的欄位名稱，讓歷史資料不受影響。
  const DEFAULT_DAILY_FIELDS = [
    { key: "opened", label: "開單量" },
    { key: "retested", label: "複測數量" },
    { key: "retestPassed", label: "複測通過量" },
    { key: "preUat", label: "Pre-UAT 處理量" },
  ];

  // Excel 範本欄位：key 是內部資料欄位名，header 是 Excel 表頭文字（比照
  // 《SIT測試管理五大表格.xlsx》「1A_測試情境庫(TS) _團險」工作表欄位順序）。
  const TEST_TEMPLATE_COLUMNS = [
    { key: "customerTestDate", header: "交測客戶日期" },
    { key: "seq", header: "序號" },
    { key: "fsd", header: "FSD" },
    { key: "fsdName", header: "FSD名字" },
    { key: "layer1", header: "第一層" },
    { key: "layer2", header: "第二層" },
    { key: "itemType", header: "類型" },
    { key: "backendOwner", header: "後端負責人" },
    { key: "frontendOwner", header: "前端負責人" },
    { key: "id", header: "測試情境 ID" },
    { key: "plannedDeliveryDate", header: "預計開發交付時程" },
    { key: "actualDeliveryDate", header: "實際開發交付時程" },
    { key: "deliveryStatus", header: "交付狀態" },
    { key: "ftTestDate", header: "FT 測試完成日期" },
    { key: "ftStatus", header: "FT測試狀態" },
    { key: "ftNote", header: "FT 備註" },
    { key: "sitTestDate", header: "SIT 測試完成日期" },
    { key: "sitStatus", header: "SIT測試狀態" },
    { key: "tcCount", header: "TC 數量" },
    { key: "sitNote", header: "SIT 備註" },
    { key: "testSA", header: "測試SA" },
  ];
  // 範本必須包含的欄位（表頭檢查用）。交測客戶日期是新欄位、實測資料常常還沒開始填，
  // 所以不列進「表頭必須存在」的必要清單，避免舊格式檔案上傳被擋。
  const REQUIRED_TEST_FIELD_KEYS = [
    "fsd", "fsdName", "layer1", "layer2", "id",
    "plannedDeliveryDate", "deliveryStatus", "ftStatus", "sitStatus",
  ];
  // 每一列真正不可空白的欄位（沒有就無法辨識這是哪個模組/哪個功能項目）。
  const ROW_REQUIRED_KEYS = ["fsd", "id"];
  const TEST_DATE_FIELD_KEYS = ["customerTestDate", "plannedDeliveryDate", "actualDeliveryDate", "ftTestDate", "sitTestDate"];
  const NO_TEST_NEEDED = "不需測試";

  const state = {
    token: localStorage.getItem(LS_TOKEN) || "",
    displayName: localStorage.getItem(LS_NAME) || "",
    tab: "backlog",
    backlogItems: [],
    backlogViewMode: localStorage.getItem(LS_BACKLOG_VIEW) === "list" ? "list" : "card",
    backlogExpanded: new Set(), // issue numbers expanded in list view
    modules: [],
    dailyFields: [], // [{number, key, label}]
    dailyDate: todayStr(),
    dailyEntries: {}, // moduleName -> {number, data}
    dailyLoaded: false,
    dailyHistory: [], // [{module, date, values}] 跨所有日期，供趨勢圖表用
    dailyHistoryLoaded: false,
    dashboardGranularity: "week",
    testBatches: [], // [{number, fsd, fsdName, items: [...]}]
    testItems: [], // 攤平後的所有 item，each item 帶 _batchNumber/_fsd/_fsdName 反查用
    phaseSettings: { number: null, defaultTestDays: 3 },
    testingLoaded: false,
    testingExpandedFsd: null,
  };

  // ---------- small helpers ----------
  function todayStr() {
    const d = new Date();
    const tz = d.getTimezoneOffset() * 60000;
    return new Date(d - tz).toISOString().slice(0, 10);
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, (s) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[s]));
  }

  function enc(s) {
    return encodeURIComponent(s);
  }

  function makeFieldKey() {
    return "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 相容舊版資料：舊的每日紀錄把數值直接放在頂層（opened/retested/...），
  // 新版統一收進 values 物件，這裡做個轉接讓歷史資料照樣顯示。
  function getEntryValues(data) {
    if (data.values) return data.values;
    const legacy = {};
    DEFAULT_DAILY_FIELDS.forEach((f) => {
      if (data[f.key] !== undefined) legacy[f.key] = data[f.key];
    });
    return legacy;
  }

  // ---------- testing overview: pure helpers ----------
  // Excel 上「交付狀態」欄位實際值很雜亂（逾期未交/逾期未交付/準時交付/延遲交付/
  // 部份準時交付...），這裡正規化成驗收標準要求的幾個桶。
  function classifyDeliveryStatus(raw) {
    const s = String(raw || "").trim();
    if (!s) return "other";
    if (s.includes("逾期")) return "overdue";
    if (s.includes("部分") || s.includes("部份")) return "partial";
    if (s.includes("已交付") || s.includes("準時交付") || s.includes("延遲交付")) return "delivered";
    return "other";
  }
  const DELIVERY_STATUS_LABEL = {
    overdue: "逾期未交付",
    delivered: "已交付",
    partial: "部分交付",
    other: "其他/未排程",
  };

  function daysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const from = new Date(fromISO);
    const to = new Date(toISO);
    if (isNaN(from) || isNaN(to)) return null;
    return Math.round((to - from) / 86400000);
  }

  function addDays(iso, days) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function isStatusDone(status) {
    return status === "測試通過" || status === NO_TEST_NEEDED;
  }

  // 直接比較「交測客戶日期」(deadline) 與「預計開發交付時程」(測試可以開始的時間點)，
  // 判斷可測試天數是否小於基本測試天數。FT/SIT 都不需要測試時完全略過風險判斷。
  function computeSchedule(item, phaseSettings) {
    if (isStatusDone(item.ftStatus) && isStatusDone(item.sitStatus)
      && item.ftStatus === NO_TEST_NEEDED && item.sitStatus === NO_TEST_NEEDED) {
      return { scheduled: true, risk: false, bothNotNeeded: true };
    }
    if (!item.customerTestDate || !item.plannedDeliveryDate) {
      return { scheduled: false, reason: "no-date", risk: false };
    }

    const availableDays = daysBetween(item.plannedDeliveryDate, item.customerTestDate);
    const testDays = Number.isFinite(item.testDays) ? item.testDays : phaseSettings.defaultTestDays;
    const risk = availableDays !== null && availableDays < testDays;
    const windowStart = addDays(item.customerTestDate, -testDays);

    return {
      scheduled: true,
      testDays,
      availableDays,
      windowStart,
      windowEnd: item.customerTestDate,
      risk,
    };
  }

  function extractData(body) {
    if (!body) return null;
    const m = body.match(/<!--DATA\n([\s\S]*?)\nDATA-->/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      return null;
    }
  }

  function buildBody(dataObj, humanLines) {
    return `<!--DATA\n${JSON.stringify(dataObj)}\nDATA-->\n\n${humanLines.join("  \n")}\n`;
  }

  function fmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // ---------- GitHub API ----------
  async function ghFetch(path, options = {}) {
    if (!state.token) throw new Error("尚未設定 GitHub Token，請點右上角「設定」輸入。");
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = await res.json();
        msg = j.message || "";
      } catch (e) {
        /* ignore */
      }
      if (res.status === 401) throw new Error("Token 無效或已過期，請重新設定。");
      if (res.status === 404) throw new Error("找不到 repo，請確認 config.js 的帳號/repo 名稱，以及 Token 是否有此 repo 的存取權限。");
      if (res.status === 403) throw new Error(`權限不足或觸發 API 速率限制：${msg}`);
      throw new Error(`GitHub API 錯誤 (${res.status})：${msg}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  // 其他查詢資料量小、per_page=100 單頁夠用；歷史資料會持續累積，需要真正翻頁抓完。
  async function ghFetchAllPages(path) {
    let all = [];
    for (let page = 1; page <= 20; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const pageItems = await ghFetch(`${path}${sep}page=${page}`);
      all = all.concat(pageItems);
      if (pageItems.length < 100) break;
    }
    return all;
  }

  async function ensureLabel(name, color) {
    try {
      await ghFetch("/labels", {
        method: "POST",
        body: JSON.stringify({ name, color: color || "5c6270" }),
      });
    } catch (e) {
      // 已存在或其他非致命錯誤，忽略即可
    }
  }

  // ---------- init ----------
  function updateClock() {
    document.getElementById("todayDate").textContent = todayStr();
    document.getElementById("todayTime").textContent = new Date().toLocaleTimeString("zh-TW", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    updateClock();
    setInterval(updateClock, 30000);
    document.getElementById("dailyDatePicker").value = state.dailyDate;
    bindStaticEvents();
    startApp();
  });

  // startApp can be called again (e.g. after saving settings) without
  // re-registering DOM event listeners a second time.
  async function startApp() {
    const notConfigured = !OWNER || !REPO || OWNER === "your-github-username" || REPO === "your-repo-name";
    if (notConfigured) {
      document.getElementById("configWarning").classList.remove("hidden");
      return;
    }
    document.getElementById("configWarning").classList.add("hidden");

    if (!state.token) {
      openSettingsModal();
      return;
    }

    try {
      await ensureLabel(LABEL.backlog, "5319e7");
      await ensureLabel(LABEL.module, "1d76db");
      await ensureLabel(LABEL.daily, "0e8a16");
      await ensureLabel(LABEL.dailyField, "fbca04");
      await ensureLabel(LABEL.testItemBatch, "0052cc");
      await ensureLabel(LABEL.testPhaseSetting, "d4c5f9");
    } catch (e) {
      /* ignore */
    }

    state.backlogItems = [];
    state.modules = [];
    state.dailyFields = [];
    state.dailyHistory = [];
    state.dailyHistoryLoaded = false;
    state.testBatches = [];
    state.testItems = [];
    state.testingLoaded = false;
    switchTab(state.tab);
  }

  function bindStaticEvents() {
    document.getElementById("settingsBtn").addEventListener("click", () => openSettingsModal());

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("addBacklogBtn").addEventListener("click", openAddBacklogModal);
    document.getElementById("refreshBacklogBtn").addEventListener("click", loadBacklog);
    document.querySelectorAll(".status-filter-cb").forEach((cb) => cb.addEventListener("change", renderBacklog));
    document.getElementById("filterCategory").addEventListener("change", renderBacklog);
    document.getElementById("filterOwner").addEventListener("change", renderBacklog);
    document.getElementById("sortDeadline").addEventListener("change", renderBacklog);
    document.getElementById("backlogColumns").addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (card) openBacklogDetail(Number(card.dataset.issue));
    });
    document.getElementById("backlogViewToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".view-toggle-btn");
      if (!btn) return;
      setBacklogViewMode(btn.dataset.view);
    });
    applyBacklogViewToggleUI();
    document.getElementById("backlogList").addEventListener("click", (e) => onBacklogListClick(e));

    document.getElementById("addModuleForm").addEventListener("submit", onAddModuleSubmit);
    document.getElementById("addFieldForm").addEventListener("submit", onAddFieldSubmit);
    document.getElementById("refreshDailyBtn").addEventListener("click", () => loadDailyEntries(state.dailyDate));
    document.getElementById("dailyDatePicker").addEventListener("change", (e) => {
      state.dailyDate = e.target.value || todayStr();
      loadDailyEntries(state.dailyDate);
    });
    document.getElementById("dailyTableBody").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action='save-row']");
      if (btn) {
        const tr = btn.closest("tr");
        saveDailyEntry(tr.dataset.module, btn);
      }
    });

    document.getElementById("downloadTemplateBtn").addEventListener("click", downloadTemplate);
    document.getElementById("uploadExcelBtn").addEventListener("click", () => {
      document.getElementById("uploadExcelInput").click();
    });
    document.getElementById("uploadExcelInput").addEventListener("change", onUploadExcelChange);
    document.getElementById("refreshTestingBtn").addEventListener("click", loadTestingAll);
    document.getElementById("savePhaseSettingsBtn").addEventListener("click", onSavePhaseSettings);

    document.getElementById("granularityToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".granularity-btn");
      if (!btn) return;
      state.dashboardGranularity = btn.dataset.granularity;
      document.querySelectorAll(".granularity-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderDailyDashboard();
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.getElementById("backlogView").classList.toggle("active", tab === "backlog");
    document.getElementById("dailyView").classList.toggle("active", tab === "daily");
    document.getElementById("testingView").classList.toggle("active", tab === "testing");
    document.getElementById("settingsView").classList.toggle("active", tab === "settings");

    if (tab === "backlog" && state.backlogItems.length === 0) loadBacklog();
    if (tab === "settings") {
      if (state.modules.length === 0) loadModules();
      if (state.dailyFields.length === 0) loadDailyFields();
    }
    if (tab === "daily") {
      // 切到這個頁籤時，即使不按「重新整理」也要讓日期跟上系統日（例如分頁開著跨過午夜）。
      const systemToday = todayStr();
      if (state.dailyDate !== systemToday) {
        state.dailyDate = systemToday;
        document.getElementById("dailyDatePicker").value = systemToday;
        state.dailyLoaded = false;
      }
      if (state.modules.length === 0 || state.dailyFields.length === 0) {
        loadModulesAndDaily();
      } else if (!state.dailyLoaded) {
        loadDailyEntries(state.dailyDate);
      } else {
        renderDailyTable();
        renderSummary();
      }
      if (!state.dailyHistoryLoaded) loadDailyHistory();
    }
    if (tab === "testing" && !state.testingLoaded) loadTestingAll();
  }

  // =========================================================
  // Backlog
  // =========================================================
  function setBacklogStatus(msg, isError) {
    const el = document.getElementById("backlogStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  async function loadBacklog() {
    setBacklogStatus("載入中…");
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.backlog)}&state=all&per_page=100`);
      state.backlogItems = issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        data: extractData(issue.body) || { status: "pending" },
        commentsCount: issue.comments || 0,
      }));
      renderCategoryFilterOptions();
      renderOwnerFilterOptions();
      renderBacklog();
      setBacklogStatus("");
    } catch (e) {
      setBacklogStatus("讀取失敗：" + e.message, true);
      document.getElementById("backlogColumns").innerHTML =
        `<div class="empty-hint error">無法載入 Backlog：${escapeHTML(e.message)}<br>請確認設定後點擊「重新整理」</div>`;
    }
  }

  function getUrgency(deadline, status) {
    if (!deadline || status === "done" || status === "void") return { cls: "", tag: "" };
    const today = new Date(todayStr());
    const dl = new Date(deadline);
    const diffDays = Math.round((dl - today) / 86400000);
    if (diffDays < 0) return { cls: "danger", tag: "已逾期" };
    if (diffDays <= 2) return { cls: "warn", tag: "即將到期" };
    return { cls: "", tag: "" };
  }

  function getBacklogCategories() {
    const set = new Set();
    state.backlogItems.forEach((item) => {
      const c = (item.data.category || "").trim();
      if (c) set.add(c);
    });
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }

  function categoryDatalistHTML(listId) {
    return `<datalist id="${listId}">${getBacklogCategories().map((c) => `<option value="${escapeHTML(c)}"></option>`).join("")}</datalist>`;
  }

  function renderCategoryFilterOptions() {
    const sel = document.getElementById("filterCategory");
    const current = sel.value;
    const categories = getBacklogCategories();
    sel.innerHTML = `<option value="">全部類型</option>` + categories.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
    if (categories.includes(current)) sel.value = current;
  }

  function getBacklogOwners() {
    const set = new Set();
    state.backlogItems.forEach((item) => {
      const o = (item.data.owner || "").trim();
      if (o) set.add(o);
    });
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  }

  function renderOwnerFilterOptions() {
    const sel = document.getElementById("filterOwner");
    const current = sel.value;
    const owners = getBacklogOwners();
    sel.innerHTML = `<option value="">全部負責人</option>` + owners.map((o) => `<option value="${escapeHTML(o)}">${escapeHTML(o)}</option>`).join("");
    if (owners.includes(current)) sel.value = current;
  }

  function backlogCardHTML(item) {
    const d = item.data;
    const urgency = getUrgency(d.deadline, d.status);
    return `
      <div class="card ${urgency.cls}" data-issue="${item.number}">
        ${d.category ? `<span class="chip category">${escapeHTML(d.category)}</span>` : ""}
        <div class="card-content">${escapeHTML(d.content || item.title)}</div>
        <div class="card-meta">
          <span class="chip owner">👤 ${escapeHTML(d.owner || "未指派")}</span>
          ${d.deadline ? `<span class="chip deadline ${urgency.cls}">⏰ ${escapeHTML(d.deadline)}${urgency.tag ? " · " + urgency.tag : ""}</span>` : ""}
        </div>
        <div class="card-foot">
          <span class="muted">提出：${escapeHTML(d.submitter || "-")} · ${escapeHTML(d.createdDate || "")}</span>
          <span class="comment-count">💬 ${item.commentsCount}</span>
        </div>
      </div>`;
  }

  function getBacklogFilteredItems() {
    const selectedStatuses = new Set(
      [...document.querySelectorAll(".status-filter-cb:checked")].map((cb) => cb.value)
    );
    const categoryFilter = document.getElementById("filterCategory").value;
    const ownerFilter = document.getElementById("filterOwner").value;
    const sortDir = document.getElementById("sortDeadline").value;

    const items = state.backlogItems.filter((item) => {
      const st = STATUS[item.data.status] ? item.data.status : "pending";
      if (!selectedStatuses.has(st)) return false;
      if (ownerFilter && (item.data.owner || "") !== ownerFilter) return false;
      if (categoryFilter && (item.data.category || "") !== categoryFilter) return false;
      return true;
    });

    return { items, selectedStatuses, sortDir };
  }

  function sortByDeadline(items, sortDir) {
    return [...items].sort((a, b) => {
      const cmp = (a.data.deadline || "9999-99-99").localeCompare(b.data.deadline || "9999-99-99");
      return sortDir === "desc" ? -cmp : cmp;
    });
  }

  function setBacklogViewMode(mode) {
    if (mode !== "card" && mode !== "list") return;
    state.backlogViewMode = mode;
    localStorage.setItem(LS_BACKLOG_VIEW, mode);
    applyBacklogViewToggleUI();
    renderBacklog();
  }

  function applyBacklogViewToggleUI() {
    document.querySelectorAll(".view-toggle-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === state.backlogViewMode);
    });
    document.getElementById("backlogColumns").classList.toggle("hidden", state.backlogViewMode !== "card");
    document.getElementById("backlogList").classList.toggle("hidden", state.backlogViewMode !== "list");
  }

  function renderBacklog() {
    applyBacklogViewToggleUI();
    if (state.backlogViewMode === "list") {
      renderBacklogListView();
    } else {
      renderBacklogCardView();
    }
  }

  function renderBacklogCardView() {
    const { items, selectedStatuses, sortDir } = getBacklogFilteredItems();

    const cols = { pending: [], doing: [], done: [], void: [] };
    items.forEach((item) => {
      const st = STATUS[item.data.status] ? item.data.status : "pending";
      cols[st].push(item);
    });
    Object.keys(cols).forEach((st) => {
      cols[st] = sortByDeadline(cols[st], sortDir);
    });

    let pendingWorst = "";
    cols.pending.forEach((item) => {
      const u = getUrgency(item.data.deadline, item.data.status);
      if (u.cls === "danger") pendingWorst = "danger";
      else if (u.cls === "warn" && pendingWorst !== "danger") pendingWorst = "warn";
    });
    const urgencyDot = pendingWorst
      ? `<span class="col-urgency-dot ${pendingWorst}" title="有項目即將到期或已逾期" aria-hidden="true"></span>`
      : "";

    const container = document.getElementById("backlogColumns");
    const visibleKeys = STATUS_ORDER.filter((key) => selectedStatuses.has(key));
    container.innerHTML = visibleKeys.length
      ? visibleKeys.map((key) => `
          <div class="board-col" data-status="${key}">
            <div class="col-head"><span>${key === "pending" ? urgencyDot : ""}${STATUS[key].label}</span><span class="count-badge">${cols[key].length}</span></div>
            <div class="col-body">${cols[key].map(backlogCardHTML).join("") || '<div class="empty-hint">目前沒有項目</div>'}</div>
          </div>
        `).join("")
      : '<div class="empty-hint">請至少勾選一種狀態才會顯示項目</div>';
  }

  function backlogListRowHTML(item) {
    const d = item.data;
    const urgency = getUrgency(d.deadline, d.status);
    const status = STATUS[d.status] ? d.status : "pending";
    const expanded = state.backlogExpanded.has(item.number);
    return `
      <div class="list-row ${expanded ? "expanded" : ""}" data-issue="${item.number}">
        <div class="list-row-summary ${urgency.cls}">
          <span class="list-expand-icon" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
          <span class="list-col list-title">${escapeHTML(d.content || item.title)}</span>
          <span class="list-col list-category">${escapeHTML(d.category || "未分類")}</span>
          <span class="list-col list-owner">👤 ${escapeHTML(d.owner || "未指派")}</span>
          <span class="list-col list-deadline ${urgency.cls}">${d.deadline ? "⏰ " + escapeHTML(d.deadline) : "-"}${urgency.tag ? " · " + urgency.tag : ""}</span>
          <span class="list-col list-status">${STATUS[status].label}</span>
        </div>
        <div class="list-row-detail" id="listDetail-${item.number}">
          ${expanded ? backlogListDetailHTML(item) : ""}
        </div>
      </div>`;
  }

  function backlogListDetailHTML(item) {
    const d = item.data;
    return `
      <div class="list-detail-fields">
        <div class="detail-field"><span class="detail-label">議題內容</span><div class="detail-value">${escapeHTML(d.content || item.title)}</div></div>
        <div class="detail-field"><span class="detail-label">類型</span><div class="detail-value">${escapeHTML(d.category || "未分類")}</div></div>
        <div class="detail-field"><span class="detail-label">負責人</span><div class="detail-value">${escapeHTML(d.owner || "未指派")}</div></div>
        <div class="detail-field"><span class="detail-label">Deadline</span><div class="detail-value">${escapeHTML(d.deadline || "未設定")}</div></div>
        <div class="detail-field"><span class="detail-label">狀態</span><div class="detail-value">${STATUS[d.status]?.label || d.status}</div></div>
        <div class="detail-field"><span class="detail-label">提出人</span><div class="detail-value">${escapeHTML(d.submitter || "-")}　·　站會提出日：${escapeHTML(d.createdDate || "-")}</div></div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-action="edit-issue" data-issue="${item.number}">編輯</button>
      </div>
      <hr style="border-color: var(--hairline); margin: 14px 0;">
      <div class="form-row"><label>留言 / 處理進度</label></div>
      <div class="comment-list" id="listCommentList-${item.number}"><div class="empty-hint">載入留言中…</div></div>
      <div class="form-row">
        <textarea id="listNewComment-${item.number}" placeholder="輸入留言，記錄討論內容或處理進度…"></textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn-primary" data-action="post-list-comment" data-issue="${item.number}">送出留言</button>
      </div>`;
  }

  function renderBacklogListView() {
    const { items, sortDir } = getBacklogFilteredItems();
    const sorted = sortByDeadline(items, sortDir);
    const container = document.getElementById("backlogList");
    container.innerHTML = sorted.length
      ? sorted.map(backlogListRowHTML).join("")
      : '<div class="empty-hint">目前沒有符合條件的項目</div>';

    sorted.forEach((item) => {
      if (state.backlogExpanded.has(item.number)) refreshComments(item.number, `listCommentList-${item.number}`);
    });
  }

  function onBacklogListClick(e) {
    const editBtn = e.target.closest("[data-action='edit-issue']");
    if (editBtn) {
      openBacklogDetail(Number(editBtn.dataset.issue));
      return;
    }
    const postBtn = e.target.closest("[data-action='post-list-comment']");
    if (postBtn) {
      submitListComment(Number(postBtn.dataset.issue), postBtn);
      return;
    }
    const summary = e.target.closest(".list-row-summary");
    if (summary) {
      const row = summary.closest(".list-row");
      const issueNumber = Number(row.dataset.issue);
      const item = state.backlogItems.find((i) => i.number === issueNumber);
      if (!item) return;
      const willExpand = !state.backlogExpanded.has(issueNumber);
      if (willExpand) {
        state.backlogExpanded.add(issueNumber);
      } else {
        state.backlogExpanded.delete(issueNumber);
      }
      row.classList.toggle("expanded", willExpand);
      row.querySelector(".list-expand-icon").textContent = willExpand ? "▾" : "▸";
      const detailEl = row.querySelector(".list-row-detail");
      detailEl.innerHTML = willExpand ? backlogListDetailHTML(item) : "";
      if (willExpand) refreshComments(issueNumber, `listCommentList-${issueNumber}`);
    }
  }

  async function submitListComment(issueNumber, btn) {
    const textarea = document.getElementById(`listNewComment-${issueNumber}`);
    const text = textarea.value.trim();
    if (!text) return;
    btn.disabled = true;
    try {
      await postComment(issueNumber, text);
      textarea.value = "";
      await refreshComments(issueNumber, `listCommentList-${issueNumber}`);
      const item = state.backlogItems.find((i) => i.number === issueNumber);
      if (item) item.commentsCount = (item.commentsCount || 0) + 1;
    } catch (err) {
      alert("送出留言失敗：" + err.message);
    }
    btn.disabled = false;
  }

  function openAddBacklogModal() {
    const today = todayStr();
    renderOverlay(`
      <div class="overlay-panel">
        <h2>新增 Backlog</h2>
        <form id="backlogForm">
          <div class="form-row">
            <label>議題內容</label>
            <textarea id="f_content" required placeholder="站會上提出的議題內容…"></textarea>
          </div>
          <div class="form-row">
            <label>類型</label>
            <input type="text" id="f_category" list="f_categoryList" placeholder="輸入或選擇類型（例如：Bug、需求、技術債）">
            ${categoryDatalistHTML("f_categoryList")}
          </div>
          <div class="form-row">
            <label>負責人</label>
            <input type="text" id="f_owner" placeholder="負責人姓名">
          </div>
          <div class="form-row">
            <label>Deadline（選填）</label>
            <input type="date" id="f_deadline">
          </div>
          <div class="form-row">
            <label>提出人</label>
            <input type="text" id="f_submitter" value="${escapeHTML(state.displayName)}" placeholder="你的名字">
          </div>
          <div class="form-row">
            <label>站會提出日期</label>
            <input type="date" id="f_createdDate" value="${today}">
          </div>
          <div class="form-actions">
            <button type="button" class="btn-ghost" data-close>取消</button>
            <button type="submit" class="btn-primary">新增</button>
          </div>
        </form>
      </div>
    `);
    document.getElementById("backlogForm").addEventListener("submit", submitNewBacklog);
  }

  async function submitNewBacklog(e) {
    e.preventDefault();
    const content = document.getElementById("f_content").value.trim();
    const category = document.getElementById("f_category").value.trim();
    const owner = document.getElementById("f_owner").value.trim();
    const deadline = document.getElementById("f_deadline").value;
    const submitter = document.getElementById("f_submitter").value.trim();
    const createdDate = document.getElementById("f_createdDate").value || todayStr();
    if (!content) return;

    const dataObj = { content, category, owner, submitter, createdDate, deadline, status: "pending" };
    const body = buildBody(dataObj, [
      `**類型**：${category || "未分類"}`,
      `**負責人**：${owner || "-"}`,
      `**提出人**：${submitter || "-"}`,
      `**站會提出日**：${createdDate}`,
      `**Deadline**：${deadline || "未設定"}`,
      `**狀態**：待處理`,
    ]);
    const title = content.slice(0, 80) || "(未命名 backlog)";

    const submitBtn = e.target.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    try {
      await ghFetch("/issues", {
        method: "POST",
        body: JSON.stringify({ title, body, labels: [LABEL.backlog] }),
      });
      if (submitter && submitter !== state.displayName) {
        state.displayName = submitter;
        localStorage.setItem(LS_NAME, submitter);
      }
      closeOverlay();
      loadBacklog();
    } catch (err) {
      alert("新增失敗：" + err.message);
      submitBtn.disabled = false;
    }
  }

  async function openBacklogDetail(issueNumber) {
    const item = state.backlogItems.find((i) => i.number === issueNumber);
    if (!item) return;
    const d = item.data;

    renderOverlay(`
      <div class="overlay-panel">
        <h2>Backlog #${issueNumber}</h2>
        <div class="form-row">
          <label>議題內容</label>
          <textarea id="d_content">${escapeHTML(d.content || "")}</textarea>
        </div>
        <div class="form-row">
          <label>類型</label>
          <input type="text" id="d_category" list="d_categoryList" value="${escapeHTML(d.category || "")}" placeholder="輸入或選擇類型（例如：Bug、需求、技術債）">
          ${categoryDatalistHTML("d_categoryList")}
        </div>
        <div class="form-row">
          <label>負責人</label>
          <input type="text" id="d_owner" value="${escapeHTML(d.owner || "")}">
        </div>
        <div class="form-row">
          <label>Deadline</label>
          <input type="date" id="d_deadline" value="${escapeHTML(d.deadline || "")}">
        </div>
        <div class="form-row">
          <label>狀態</label>
          <select id="d_status">
            ${STATUS_ORDER.map((k) => `<option value="${k}" ${d.status === k ? "selected" : ""}>${STATUS[k].label}</option>`).join("")}
          </select>
        </div>
        <div class="help-text">提出人：${escapeHTML(d.submitter || "-")}　·　站會提出日：${escapeHTML(d.createdDate || "-")}</div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" data-close>關閉</button>
          <button type="button" class="btn-primary" id="saveDetailBtn">儲存變更</button>
        </div>
        <hr style="border-color: var(--hairline); margin: 18px 0;">
        <div class="form-row"><label>留言 / 處理進度</label></div>
        <div class="comment-list" id="commentList"><div class="empty-hint">載入留言中…</div></div>
        <div class="form-row">
          <textarea id="newCommentText" placeholder="輸入留言，記錄討論內容或處理進度…"></textarea>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-primary" id="postCommentBtn">送出留言</button>
        </div>
      </div>
    `);

    document.getElementById("saveDetailBtn").addEventListener("click", async () => {
      const patch = {
        content: document.getElementById("d_content").value.trim(),
        category: document.getElementById("d_category").value.trim(),
        owner: document.getElementById("d_owner").value.trim(),
        deadline: document.getElementById("d_deadline").value,
        status: document.getElementById("d_status").value,
      };
      const saveBtn = document.getElementById("saveDetailBtn");
      saveBtn.disabled = true;
      try {
        await updateBacklogItem(item, patch);
        closeOverlay();
        renderBacklog();
      } catch (err) {
        alert("儲存失敗：" + err.message);
        saveBtn.disabled = false;
      }
    });

    document.getElementById("postCommentBtn").addEventListener("click", async () => {
      const text = document.getElementById("newCommentText").value.trim();
      if (!text) return;
      const btn = document.getElementById("postCommentBtn");
      btn.disabled = true;
      try {
        await postComment(issueNumber, text);
        document.getElementById("newCommentText").value = "";
        await refreshComments(issueNumber);
        item.commentsCount = (item.commentsCount || 0) + 1;
      } catch (err) {
        alert("送出留言失敗：" + err.message);
      }
      btn.disabled = false;
    });

    refreshComments(issueNumber);
  }

  async function refreshComments(issueNumber, elId) {
    const el = document.getElementById(elId || "commentList");
    if (!el) return;
    try {
      const comments = await ghFetch(`/issues/${issueNumber}/comments?per_page=100`);
      el.innerHTML = comments.length
        ? comments.map((c) => `
            <div class="comment-item">
              <span class="comment-author">${escapeHTML(c.user?.login || "?")}</span>
              <span class="comment-time">${fmtTime(c.created_at)}</span>
              <div class="comment-body">${escapeHTML(c.body)}</div>
            </div>`).join("")
        : '<div class="empty-hint">尚無留言</div>';
    } catch (e) {
      el.innerHTML = `<div class="empty-hint">留言讀取失敗：${escapeHTML(e.message)}</div>`;
    }
  }

  async function postComment(issueNumber, text) {
    return ghFetch(`/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: text }),
    });
  }

  async function updateBacklogItem(item, patch) {
    const newData = { ...item.data, ...patch };
    const body = buildBody(newData, [
      `**類型**：${newData.category || "未分類"}`,
      `**負責人**：${newData.owner || "-"}`,
      `**提出人**：${newData.submitter || "-"}`,
      `**站會提出日**：${newData.createdDate || "-"}`,
      `**Deadline**：${newData.deadline || "未設定"}`,
      `**狀態**：${STATUS[newData.status]?.label || newData.status}`,
    ]);
    const title = (newData.content || "").slice(0, 80) || item.title;
    await ghFetch(`/issues/${item.number}`, {
      method: "PATCH",
      body: JSON.stringify({ body, title }),
    });
    item.data = newData;
    item.title = title;
  }

  // =========================================================
  // Module management
  // =========================================================
  function setModuleStatus(msg, isError) {
    const el = document.getElementById("moduleStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  // =========================================================
  // Daily test tracking
  // =========================================================
  function setDailyStatus(msg, isError) {
    const el = document.getElementById("dailyStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  async function loadModulesAndDaily() {
    await loadModules();
    await loadDailyFields();
    await loadDailyEntries(state.dailyDate);
  }

  // =========================================================
  // Daily tracked-field management
  // =========================================================
  function setFieldStatus(msg, isError) {
    const el = document.getElementById("fieldStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  function mapFieldIssue(issue) {
    const d = extractData(issue.body) || {};
    return { number: issue.number, key: d.key || String(issue.number), label: d.label || issue.title };
  }

  async function loadDailyFields() {
    setFieldStatus("載入追蹤項目中…");
    try {
      let issues = await ghFetch(`/issues?labels=${enc(LABEL.dailyField)}&state=open&per_page=100`);
      if (issues.length === 0) {
        for (const f of DEFAULT_DAILY_FIELDS) {
          const body = buildBody(f, [`**追蹤項目**：${f.label}`]);
          await ghFetch("/issues", {
            method: "POST",
            body: JSON.stringify({ title: `[field] ${f.label}`, body, labels: [LABEL.dailyField] }),
          });
        }
        issues = await ghFetch(`/issues?labels=${enc(LABEL.dailyField)}&state=open&per_page=100`);
      }
      state.dailyFields = issues.map(mapFieldIssue).sort((a, b) => a.number - b.number);
      renderFieldList();
      renderDailyTableHead();
      setFieldStatus("");
    } catch (e) {
      setFieldStatus("讀取追蹤項目失敗：" + e.message, true);
      document.getElementById("fieldList").innerHTML =
        `<span class="empty-hint error">無法載入追蹤項目：${escapeHTML(e.message)}</span>`;
    }
  }

  function renderFieldList() {
    const el = document.getElementById("fieldList");
    el.innerHTML = state.dailyFields.length
      ? state.dailyFields.map((f) => `
          <span class="module-chip">
            ${escapeHTML(f.label)}
            <button type="button" data-remove-field="${f.number}" title="移除追蹤項目">✕</button>
          </span>`).join("")
      : '<span class="empty-hint">尚未設定追蹤項目</span>';

    el.querySelectorAll("[data-remove-field]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (state.dailyFields.length <= 1) {
          alert("至少需保留一個追蹤項目");
          return;
        }
        if (!confirm("確定要移除這個追蹤項目嗎？（歷史測試資料仍會保留在 GitHub Issues 中，只是不再顯示這個欄位）")) return;
        try {
          await ghFetch(`/issues/${btn.dataset.removeField}`, {
            method: "PATCH",
            body: JSON.stringify({ state: "closed" }),
          });
          await loadDailyFields();
          renderDailyTable();
          renderSummary();
          if (state.dailyHistoryLoaded) renderDailyDashboard();
        } catch (e) {
          alert("移除失敗：" + e.message);
        }
      });
    });
  }

  async function onAddFieldSubmit(e) {
    e.preventDefault();
    const label = document.getElementById("newFieldLabel").value.trim();
    if (!label) return;

    const dataObj = { key: makeFieldKey(), label };
    const body = buildBody(dataObj, [`**追蹤項目**：${label}`]);
    const btn = e.target.querySelector("button[type=submit]");
    const originalBtnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "新增中…";
    setFieldStatus("新增追蹤項目中，請稍候…");
    try {
      await ghFetch("/issues", {
        method: "POST",
        body: JSON.stringify({ title: `[field] ${label}`, body, labels: [LABEL.dailyField] }),
      });
      document.getElementById("newFieldLabel").value = "";
      await loadDailyFields();
      renderDailyTable();
      renderSummary();
      if (state.dailyHistoryLoaded) renderDailyDashboard();
      setFieldStatus("已新增追蹤項目 ✓");
      setTimeout(() => setFieldStatus(""), 1500);
    } catch (err) {
      alert("新增追蹤項目失敗：" + err.message);
      setFieldStatus("");
    }
    btn.disabled = false;
    btn.textContent = originalBtnText;
  }

  async function loadModules() {
    setModuleStatus("載入模組中…");
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.module)}&state=open&per_page=100`);
      state.modules = issues.map((issue) => ({
        number: issue.number,
        data: extractData(issue.body) || { name: issue.title, owners: [] },
      }));
      renderModuleList();
      setModuleStatus("");
    } catch (e) {
      setModuleStatus("讀取模組失敗：" + e.message, true);
      document.getElementById("moduleList").innerHTML =
        `<span class="empty-hint error">無法載入模組：${escapeHTML(e.message)}</span>`;
    }
  }

  function renderModuleList() {
    const el = document.getElementById("moduleList");
    el.innerHTML = state.modules.length
      ? state.modules.map((m) => `
          <span class="module-chip">
            ${escapeHTML(m.data.name)}${m.data.owners?.length ? " · " + escapeHTML(m.data.owners.join("、")) : ""}
            <button type="button" data-remove-module="${m.number}" title="移除模組">✕</button>
          </span>`).join("")
      : '<span class="empty-hint">還沒有模組，於下方新增一個開始追蹤</span>';

    el.querySelectorAll("[data-remove-module]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("確定要移除這個模組嗎？（歷史測試資料仍會保留在 GitHub Issues 中）")) return;
        try {
          await ghFetch(`/issues/${btn.dataset.removeModule}`, {
            method: "PATCH",
            body: JSON.stringify({ state: "closed" }),
          });
          await loadModules();
        } catch (e) {
          alert("移除失敗：" + e.message);
        }
      });
    });
  }

  async function onAddModuleSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("newModuleName").value.trim();
    const ownersRaw = document.getElementById("newModuleOwners").value.trim();
    if (!name) return;
    const owners = ownersRaw ? ownersRaw.split(/[,、]/).map((s) => s.trim()).filter(Boolean) : [];

    const dataObj = { name, owners };
    const body = buildBody(dataObj, [`**負責人**：${owners.join("、") || "-"}`]);
    const btn = e.target.querySelector("button[type=submit]");
    const originalBtnText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "新增中…";
    setModuleStatus("新增模組中，請稍候…");
    try {
      await ghFetch("/issues", {
        method: "POST",
        body: JSON.stringify({ title: `[module] ${name}`, body, labels: [LABEL.module] }),
      });
      document.getElementById("newModuleName").value = "";
      document.getElementById("newModuleOwners").value = "";
      await loadModules();
      setModuleStatus("已新增模組 ✓");
      setTimeout(() => setModuleStatus(""), 1500);
    } catch (err) {
      alert("新增模組失敗：" + err.message);
      setModuleStatus("");
    }
    btn.disabled = false;
    btn.textContent = originalBtnText;
  }

  async function loadDailyEntries(date) {
    setDailyStatus("載入當日資料中…");
    try {
      const dateLabel = `date:${date}`;
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.daily)},${enc(dateLabel)}&state=all&per_page=100`);
      const map = {};
      issues.forEach((issue) => {
        const d = extractData(issue.body);
        if (d && d.module) map[d.module] = { number: issue.number, data: d };
      });
      state.dailyEntries = map;
      state.dailyLoaded = true;
      renderDailyTable();
      renderSummary();
      setDailyStatus("");
    } catch (e) {
      setDailyStatus("讀取失敗：" + e.message, true);
      document.getElementById("dailyTableBody").innerHTML =
        `<tr><td colspan="${state.dailyFields.length + 3}" class="empty-hint error">無法載入每日資料：${escapeHTML(e.message)}</td></tr>`;
    }
  }

  // ---------- Daily dashboard: pure aggregation helpers ----------
  function weekStartOf(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return d.toISOString().slice(0, 10);
  }

  function bucketKeyOf(dateStr, granularity) {
    return granularity === "month" ? dateStr.slice(0, 7) : weekStartOf(dateStr);
  }

  function bucketLabelOf(key, granularity) {
    if (granularity === "month") {
      const [y, m] = key.split("-");
      return `${y}/${m}`;
    }
    const [, m, d] = key.split("-");
    return `${m}/${d}`;
  }

  // 把 state.dailyHistory（所有模組、所有日期）依週/月分桶加總，只取最近 N 個桶。
  function aggregateHistory(granularity) {
    const windowSize = granularity === "month" ? 6 : 8;
    const buckets = {};
    state.dailyHistory.forEach((entry) => {
      const key = bucketKeyOf(entry.date, granularity);
      if (!buckets[key]) buckets[key] = {};
      state.dailyFields.forEach((f) => {
        buckets[key][f.key] = (buckets[key][f.key] || 0) + (entry.values[f.key] || 0);
      });
    });
    const sortedKeys = Object.keys(buckets).sort().slice(-windowSize);
    const series = {};
    state.dailyFields.forEach((f) => {
      series[f.key] = sortedKeys.map((k) => buckets[k][f.key] || 0);
    });
    return { labels: sortedKeys.map((k) => bucketLabelOf(k, granularity)), series };
  }

  function setDashboardStatus(msg, isError) {
    const el = document.getElementById("dailyDashboard");
    if (msg) el.innerHTML = `<div class="chart-empty${isError ? " error" : ""}">${escapeHTML(msg)}</div>`;
  }

  async function loadDailyHistory() {
    setDashboardStatus("載入趨勢資料中…");
    try {
      const issues = await ghFetchAllPages(`/issues?labels=${enc(LABEL.daily)}&state=all&per_page=100`);
      state.dailyHistory = issues
        .map((issue) => extractData(issue.body))
        .filter((d) => d && d.module && d.date)
        .map((d) => ({ module: d.module, date: d.date, values: getEntryValues(d) }));
      state.dailyHistoryLoaded = true;
      renderDailyDashboard();
    } catch (e) {
      state.dailyHistoryLoaded = false;
      setDashboardStatus("無法載入趨勢資料：" + e.message, true);
    }
  }

  // 長條圖路徑：上緣圓角 4px、底部貼齊基準線（方角），高度為 0 時退化成極小圓角。
  function roundedTopBarPath(x, y, w, h) {
    const rad = Math.min(4, h / 2, w / 2);
    if (h <= 0) return "";
    return `M${x},${y + h} L${x},${y + rad} Q${x},${y} ${x + rad},${y} L${x + w - rad},${y} Q${x + w},${y} ${x + w},${y + rad} L${x + w},${y + h} Z`;
  }

  // 單一系列（一個追蹤項目）的小型長條圖，符合 dataviz 準則：≤24px 粗細、4px 圓角資料端、
  // 2px 間隔、只在最後一根標數值、軸線只標頭尾避免擁擠、hover 用原生 <title> 顯示數值。
  function buildBarChartSVG(labels, values) {
    const width = 280;
    const height = 140;
    const marginLeft = 30;
    const marginRight = 8;
    const marginTop = 18;
    const marginBottom = 22;
    const plotW = width - marginLeft - marginRight;
    const plotH = height - marginTop - marginBottom;
    const n = values.length;
    // 每個時間點各佔一個等寬 slot、平均分布在整個寬度上（而不是把長條擠在中間），
    // 這樣不管幾根長條，頭尾標籤都會撐到最開，才有空間不重疊。
    const slotW = plotW / n;
    const barW = Math.min(24, Math.max(4, slotW - 4));
    const slotCenterX = (i) => marginLeft + slotW * (i + 0.5);
    const maxVal = Math.max(1, ...values);

    const bars = values.map((v, i) => {
      const barH = maxVal > 0 ? (v / maxVal) * plotH : 0;
      const cx = slotCenterX(i);
      const x = cx - barW / 2;
      const y = marginTop + plotH - barH;
      const isLast = i === n - 1;
      const path = roundedTopBarPath(x, y, barW, barH);
      const valueLabel = isLast && v > 0
        ? `<text class="chart-value-label" x="${cx}" y="${Math.max(y - 4, 10)}" text-anchor="middle">${v}</text>`
        : "";
      return `${path ? `<path class="chart-bar" d="${path}"><title>${escapeHTML(labels[i])}：${v}</title></path>` : ""}${valueLabel}`;
    }).join("");

    // 只標頭尾兩個時間點，避免 slot 太窄時文字互相疊在一起。
    const axisLabels = [0, n - 1]
      .filter((i, idx, arr) => arr.indexOf(i) === idx)
      .map((i) => `<text class="chart-axis-label" x="${slotCenterX(i)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : "end"}">${escapeHTML(labels[i])}</text>`)
      .join("");

    const maxLabel = `<text class="chart-axis-label" x="${marginLeft - 6}" y="${marginTop + 4}" text-anchor="end">${maxVal}</text>`;
    const baseline = `<line x1="${marginLeft}" y1="${marginTop + plotH}" x2="${marginLeft + plotW}" y2="${marginTop + plotH}" stroke="var(--hairline)" stroke-width="1"/>`;

    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="長條圖">${baseline}${bars}${axisLabels}${maxLabel}</svg>`;
  }

  function renderDailyDashboard() {
    const container = document.getElementById("dailyDashboard");
    if (!state.dailyFields.length) {
      container.innerHTML = '<div class="chart-empty">尚未設定追蹤項目</div>';
      return;
    }
    if (!state.dailyHistory.length) {
      container.innerHTML = '<div class="chart-empty">尚無歷史資料可顯示趨勢，先在上方表格輸入並儲存每日數字</div>';
      return;
    }
    const { labels, series } = aggregateHistory(state.dashboardGranularity);
    if (labels.length === 0) {
      container.innerHTML = '<div class="chart-empty">尚無歷史資料可顯示趨勢</div>';
      return;
    }
    container.innerHTML = state.dailyFields.map((f) => `
      <div class="chart-card">
        <div class="chart-card-title">${escapeHTML(f.label)}</div>
        ${buildBarChartSVG(labels, series[f.key] || labels.map(() => 0))}
      </div>
    `).join("");
  }

  function renderDailyTableHead() {
    const tr = document.getElementById("dailyTableHead");
    tr.innerHTML = `<th>模組</th><th>負責人</th>${state.dailyFields.map((f) => `<th>${escapeHTML(f.label)}</th>`).join("")}<th></th>`;
  }

  function dailyRowHTML(mod) {
    const name = mod.data.name;
    const entry = state.dailyEntries[name];
    const values = entry ? getEntryValues(entry.data) : {};
    const cells = state.dailyFields
      .map((f) => `<td><input type="number" min="0" class="num-input" data-field-key="${escapeHTML(f.key)}" value="${values[f.key] || 0}"></td>`)
      .join("");
    return `
      <tr data-module="${escapeHTML(name)}">
        <td>${escapeHTML(name)}</td>
        <td class="muted">${escapeHTML((mod.data.owners || []).join("、"))}</td>
        ${cells}
        <td><button type="button" class="btn-save" data-action="save-row">儲存</button></td>
      </tr>`;
  }

  function renderDailyTable() {
    const tbody = document.getElementById("dailyTableBody");
    tbody.innerHTML = state.modules.length
      ? state.modules.map(dailyRowHTML).join("")
      : `<tr><td colspan="${state.dailyFields.length + 3}" class="empty-hint">尚未新增模組，請先在上方「模組管理」新增</td></tr>`;
  }

  async function saveDailyEntry(moduleName, btn) {
    const tr = btn.closest("tr");
    const values = {};
    state.dailyFields.forEach((f) => {
      const input = tr.querySelector(`[data-field-key="${CSS.escape(f.key)}"]`);
      values[f.key] = Number(input.value) || 0;
    });
    const dataObj = {
      module: moduleName,
      date: state.dailyDate,
      values,
      reporter: state.displayName || "-",
    };
    const body = buildBody(dataObj, [
      `**模組**：${moduleName}`,
      `**日期**：${state.dailyDate}`,
      ...state.dailyFields.map((f) => `**${f.label}**：${values[f.key]}`),
      `**回報人**：${dataObj.reporter}`,
    ]);

    btn.disabled = true;
    try {
      const existing = state.dailyEntries[moduleName];
      if (existing) {
        await ghFetch(`/issues/${existing.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
        existing.data = dataObj;
      } else {
        const dateLabel = `date:${state.dailyDate}`;
        const modLabel = `module:${moduleName}`;
        await ensureLabel(dateLabel, "c5def5");
        await ensureLabel(modLabel, "bfd4f2");
        const issue = await ghFetch("/issues", {
          method: "POST",
          body: JSON.stringify({
            title: `[daily] ${moduleName} - ${state.dailyDate}`,
            body,
            labels: [LABEL.daily, modLabel, dateLabel],
          }),
        });
        state.dailyEntries[moduleName] = { number: issue.number, data: dataObj };
      }
      renderSummary();
      if (state.dailyHistoryLoaded) {
        const existingHistoryEntry = state.dailyHistory.find((h) => h.module === moduleName && h.date === state.dailyDate);
        if (existingHistoryEntry) {
          existingHistoryEntry.values = values;
        } else {
          state.dailyHistory.push({ module: moduleName, date: state.dailyDate, values });
        }
        renderDailyDashboard();
      }
      btn.textContent = "已儲存 ✓";
      btn.classList.add("saved");
      setTimeout(() => {
        btn.textContent = "儲存";
        btn.classList.remove("saved");
      }, 1500);
    } catch (e) {
      alert("儲存失敗：" + e.message);
    }
    btn.disabled = false;
  }

  function renderSummary() {
    const totals = {};
    state.dailyFields.forEach((f) => { totals[f.key] = 0; });
    Object.values(state.dailyEntries).forEach((e) => {
      const values = getEntryValues(e.data);
      state.dailyFields.forEach((f) => { totals[f.key] += values[f.key] || 0; });
    });
    document.getElementById("summaryBoard").innerHTML = state.dailyFields.map((f) => `
      <div class="summary-item"><span class="summary-num">${totals[f.key]}</span><span class="summary-label">${escapeHTML(f.label)}</span></div>
    `).join("");
  }

  // =========================================================
  // Testing overview（交付/測試狀態追蹤）
  // =========================================================
  function setTestingStatus(msg, isError) {
    const el = document.getElementById("testingStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  function setPhaseStatus(msg, isError) {
    const el = document.getElementById("phaseStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  async function loadTestingAll() {
    if (state.modules.length === 0) await loadModules();
    await loadTestItems();
    await loadPhaseSettings();
  }

  function mapTestBatchIssue(issue) {
    const d = extractData(issue.body) || {};
    return {
      number: issue.number,
      fsd: d.fsd || "",
      fsdName: d.fsdName || "",
      items: Array.isArray(d.items) ? d.items : [],
    };
  }

  async function loadTestItems() {
    setTestingStatus("載入交付/測試資料中…");
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.testItemBatch)}&state=open&per_page=100`);
      state.testBatches = issues.map(mapTestBatchIssue);
      state.testItems = [];
      state.testBatches.forEach((batch) => {
        batch.items.forEach((item) => {
          state.testItems.push({ ...item, _batchNumber: batch.number, _fsd: batch.fsd, _fsdName: batch.fsdName });
        });
      });
      state.testingLoaded = true;
      renderTestingOverview();
      setTestingStatus("");
    } catch (e) {
      setTestingStatus("讀取失敗：" + e.message, true);
      document.getElementById("testingOverview").innerHTML =
        `<div class="empty-hint error">無法載入交付/測試資料：${escapeHTML(e.message)}</div>`;
      document.getElementById("customerTestMonthSummary").innerHTML =
        `<div class="empty-hint error">無法載入交付/測試資料：${escapeHTML(e.message)}</div>`;
    }
  }

  async function loadPhaseSettings() {
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.testPhaseSetting)}&state=open&per_page=100`);
      if (issues.length === 0) {
        state.phaseSettings = { number: null, defaultTestDays: 3 };
      } else {
        const d = extractData(issues[0].body) || {};
        state.phaseSettings = {
          number: issues[0].number,
          defaultTestDays: Number.isFinite(d.defaultTestDays) ? d.defaultTestDays : 3,
        };
      }
      renderPhaseSettingsForm();
      renderTestingOverview();
    } catch (e) {
      setPhaseStatus("讀取階段設定失敗：" + e.message, true);
    }
  }

  function renderPhaseSettingsForm() {
    document.getElementById("defaultTestDaysInput").value = state.phaseSettings.defaultTestDays;
  }

  async function onSavePhaseSettings() {
    const defaultTestDays = Number(document.getElementById("defaultTestDaysInput").value) || 0;
    const dataObj = { defaultTestDays };
    const body = buildBody(dataObj, [`**全域預設基本測試天數**：${defaultTestDays}`]);

    const btn = document.getElementById("savePhaseSettingsBtn");
    btn.disabled = true;
    setPhaseStatus("儲存中…");
    try {
      if (state.phaseSettings.number) {
        await ghFetch(`/issues/${state.phaseSettings.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
      } else {
        const issue = await ghFetch("/issues", {
          method: "POST",
          body: JSON.stringify({ title: "[test-phase-setting] 測試設定", body, labels: [LABEL.testPhaseSetting] }),
        });
        state.phaseSettings.number = issue.number;
      }
      state.phaseSettings.defaultTestDays = defaultTestDays;
      renderTestingOverview();
      setPhaseStatus("已儲存 ✓");
      setTimeout(() => setPhaseStatus(""), 1500);
    } catch (e) {
      alert("儲存階段設定失敗：" + e.message);
      setPhaseStatus("");
    }
    btn.disabled = false;
  }

  // 依「交測客戶日期」月份分群，橫向月份、直向已交付/未交付；已交付＝已超過交測客戶
  // 日期且 FT/SIT 都測試通過（或不需測試）。沒填交測客戶日期的項目無法歸月份，不計入。
  function groupByCustomerTestMonth() {
    const buckets = {};
    const today = todayStr();
    state.testItems.forEach((it) => {
      if (!it.customerTestDate) return;
      const month = it.customerTestDate.slice(0, 7);
      if (!buckets[month]) buckets[month] = { delivered: 0, pending: 0 };
      const ftDone = isStatusDone(it.ftStatus);
      const sitDone = isStatusDone(it.sitStatus);
      const delivered = today > it.customerTestDate && ftDone && sitDone;
      buckets[month][delivered ? "delivered" : "pending"]++;
    });
    return Object.keys(buckets).sort().map((m) => ({ month: m, ...buckets[m] }));
  }

  function renderCustomerTestMonthSummary() {
    const el = document.getElementById("customerTestMonthSummary");
    const rows = groupByCustomerTestMonth();
    if (rows.length === 0) {
      el.innerHTML = '<div class="empty-hint">尚無資料，請先在 Excel 填上「交測客戶日期」</div>';
      return;
    }
    el.innerHTML = `
      <table class="daily-table">
        <thead>
          <tr><th>月份</th>${rows.map((r) => `<th>${escapeHTML(r.month)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          <tr><td>已交付</td>${rows.map((r) => `<td>${r.delivered}</td>`).join("")}</tr>
          <tr><td>未交付</td>${rows.map((r) => `<td>${r.pending}</td>`).join("")}</tr>
        </tbody>
      </table>`;
  }

  function renderTestingOverview() {
    const container = document.getElementById("testingOverview");
    renderCustomerTestMonthSummary();
    if (!state.testingLoaded) return;
    if (state.testBatches.length === 0) {
      container.innerHTML = '<div class="empty-hint">尚無交付/測試資料，請先用「上傳 Excel 更新」匯入</div>';
      return;
    }
    container.innerHTML = state.testBatches
      .slice()
      .sort((a, b) => a.fsd.localeCompare(b.fsd))
      .map(renderOverviewCard)
      .join("");

    container.querySelectorAll(".overview-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("input") || e.target.closest("button")) return;
        const fsd = card.dataset.fsd;
        state.testingExpandedFsd = state.testingExpandedFsd === fsd ? null : fsd;
        renderTestingOverview();
      });
    });

    container.querySelectorAll("[data-save-testdays]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onSaveItemTestDays(btn.dataset.saveTestdays, btn);
      });
    });
  }

  function renderOverviewCard(batch) {
    const items = batch.items;
    const mod = state.modules.find((m) => m.data.name === batch.fsd);
    const owners = mod ? (mod.data.owners || []).join("、") : "";

    const dates = items.map((it) => it.plannedDeliveryDate).filter(Boolean).sort();
    const rangeText = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : "未設定";

    const deliveryCounts = { overdue: 0, delivered: 0, partial: 0, other: 0 };
    const ftCounts = {};
    const sitCounts = {};
    let tcTotal = 0;
    let sitPassed = 0;
    let needSitTcCount = 0;
    let riskCount = 0;
    const completion = { both: 0, ftOnly: 0, pending: 0 };

    items.forEach((it) => {
      deliveryCounts[classifyDeliveryStatus(it.deliveryStatus)]++;
      const ftKey = it.ftStatus || "未填";
      const sitKey = it.sitStatus || "未填";
      ftCounts[ftKey] = (ftCounts[ftKey] || 0) + 1;
      sitCounts[sitKey] = (sitCounts[sitKey] || 0) + 1;
      tcTotal += Number(it.tcCount) || 0;
      if (it.sitStatus === "測試通過") sitPassed++;
      if (it.sitStatus !== NO_TEST_NEEDED && (it.tcCount === null || it.tcCount === undefined || it.tcCount === "")) {
        needSitTcCount++;
      }
      const ftDone = isStatusDone(it.ftStatus);
      const sitDone = isStatusDone(it.sitStatus);
      if (ftDone && sitDone) completion.both++;
      else if (ftDone) completion.ftOnly++;
      else completion.pending++;

      const sched = computeSchedule(it, state.phaseSettings);
      if (sched.risk) riskCount++;
    });

    const riskyKeys = ["測試失敗", "測試阻塞"];
    const pillsHTML = (counts) => Object.entries(counts).map(([k, v]) =>
      `<span class="stat-pill${riskyKeys.includes(k) ? " danger" : ""}">${escapeHTML(k)} ${v}</span>`
    ).join("");

    const expanded = state.testingExpandedFsd === batch.fsd;

    return `
      <div class="overview-card ${riskCount > 0 ? "risk" : ""} ${expanded ? "expanded" : ""}" data-fsd="${escapeHTML(batch.fsd)}">
        <div class="overview-card-head">
          <div>
            <div class="overview-card-title"><span class="overview-card-fsd">${escapeHTML(batch.fsd)}</span>${escapeHTML(batch.fsdName)}</div>
            ${owners ? `<div class="overview-card-owner">👤 ${escapeHTML(owners)}</div>` : ""}
          </div>
          <div class="overview-card-range">${escapeHTML(rangeText)}</div>
        </div>

        ${riskCount > 0 ? `<div class="risk-badge">⚠ 測試時程不足 × ${riskCount}</div>` : ""}
        ${needSitTcCount > 0 ? `<div class="risk-badge" style="background:rgba(240,180,41,0.15);color:var(--status-warn);margin-left:6px;">需要補上 SIT TC × ${needSitTcCount}</div>` : ""}

        <div class="stat-group">
          <div class="stat-group-label">交付狀態（共 ${items.length} 項）</div>
          <div class="stat-pills">
            <span class="stat-pill danger">逾期未交付 ${deliveryCounts.overdue}</span>
            <span class="stat-pill done">已交付 ${deliveryCounts.delivered}</span>
            <span class="stat-pill warn">部分交付 ${deliveryCounts.partial}</span>
            <span class="stat-pill">其他/未排程 ${deliveryCounts.other}</span>
          </div>
        </div>

        <div class="stat-group">
          <div class="stat-group-label">FT 測試狀態</div>
          <div class="stat-pills">${pillsHTML(ftCounts)}</div>
        </div>

        <div class="stat-group">
          <div class="stat-group-label">SIT 測試狀態（TC 總數 ${tcTotal}，已測通 ${sitPassed}）</div>
          <div class="stat-pills">${pillsHTML(sitCounts)}</div>
        </div>

        <div class="stat-group">
          <div class="stat-group-label">測試完成度</div>
          <div class="stat-pills">
            <span class="stat-pill done">皆已測通 ${completion.both}</span>
            <span class="stat-pill warn">只測通FT尚待SIT ${completion.ftOnly}</span>
            <span class="stat-pill danger">尚未完成 ${completion.pending}</span>
          </div>
        </div>

        <div class="item-detail-wrap ${expanded ? "" : "hidden"}">
          ${expanded ? renderItemDetailTable(batch, items) : ""}
        </div>
      </div>
    `;
  }

  function renderItemDetailTable(batch, items) {
    const scheduleText = (item, s) => {
      if (s.bothNotNeeded) return '<span class="item-phase-empty">FT/SIT 皆不需測試</span>';
      if (!s.scheduled) return '<span class="item-phase-empty">未設定交測客戶日期</span>';
      return `${escapeHTML(s.windowStart || "-")} ~ ${escapeHTML(s.windowEnd)}${s.risk ? ' <span class="risk-badge">風險</span>' : ""}`;
    };

    const rows = items.map((it) => {
      const sched = computeSchedule(it, state.phaseSettings);
      return `
        <tr data-item-id="${escapeHTML(it.id)}">
          <td>${escapeHTML(it.id)}</td>
          <td>${escapeHTML(it.layer1 || "")}${it.layer2 ? "／" + escapeHTML(it.layer2) : ""}</td>
          <td>${escapeHTML(it.deliveryStatus || "-")}</td>
          <td>${escapeHTML(it.ftStatus || "-")}</td>
          <td>${escapeHTML(it.sitStatus || "-")}</td>
          <td>${scheduleText(it, sched)}</td>
          <td><input type="number" min="0" class="num-input" data-item-testdays value="${Number.isFinite(it.testDays) ? it.testDays : ""}" placeholder="${state.phaseSettings.defaultTestDays}"></td>
          <td><button type="button" class="btn-save" data-save-testdays="${escapeHTML(batch.number + ":" + it.id)}">儲存</button></td>
        </tr>`;
    }).join("");

    return `
      <table class="item-detail-table">
        <thead>
          <tr>
            <th>測試情境ID</th><th>功能項目</th><th>交付狀態</th><th>FT 狀態</th><th>SIT 狀態</th>
            <th>預計測試時窗</th><th>基本測試天數</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  async function onSaveItemTestDays(key, btn) {
    const sepIdx = key.indexOf(":");
    const batchNumber = Number(key.slice(0, sepIdx));
    const itemId = key.slice(sepIdx + 1);
    const batch = state.testBatches.find((b) => b.number === batchNumber);
    if (!batch) return;
    const item = batch.items.find((it) => it.id === itemId);
    if (!item) return;

    const tr = btn.closest("tr");
    const input = tr.querySelector("[data-item-testdays]");
    const value = input.value === "" ? null : Number(input.value);
    item.testDays = value;

    btn.disabled = true;
    try {
      const body = buildBody(
        { fsd: batch.fsd, fsdName: batch.fsdName, items: batch.items },
        [`**FSD**：${batch.fsd}`, `**FSD名稱**：${batch.fsdName}`, `**功能項目數**：${batch.items.length}`]
      );
      await ghFetch(`/issues/${batch.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
      state.testItems.forEach((it) => {
        if (it._batchNumber === batchNumber && it.id === itemId) it.testDays = value;
      });
      renderTestingOverview();
    } catch (e) {
      alert("儲存失敗：" + e.message);
    }
    btn.disabled = false;
  }

  // ---------- Excel 範本下載 ----------
  function downloadTemplate() {
    if (typeof XLSX === "undefined") {
      alert("Excel 函式庫尚未載入完成，請稍後再試一次。");
      return;
    }
    const header = TEST_TEMPLATE_COLUMNS.map((c) => c.header);
    const ws = XLSX.utils.aoa_to_sheet([header]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "測試情境範本");
    XLSX.writeFile(wb, "SIT測試情境範本.xlsx");
  }

  // ---------- Excel 上傳解析與驗證 ----------
  function normalizeHeader(s) {
    return String(s || "").replace(/\s+/g, "");
  }

  function parseExcelDateValue(val) {
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null;
      return val.toISOString().slice(0, 10);
    }
    const s = String(val).trim();
    if (!/\d{4}/.test(s)) return null;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  function fieldHeader(key) {
    const col = TEST_TEMPLATE_COLUMNS.find((c) => c.key === key);
    return col ? col.header : key;
  }

  function parseAndValidateRows(dataRows, keyByCol) {
    const records = [];
    const errors = [];
    let unparseableDateCount = 0;

    dataRows.forEach((rowArr, i) => {
      const excelRow = i + 2; // +1 表頭, +1 轉成 1-index
      if (rowArr.every((v) => v === "" || v === null || v === undefined)) return;

      const rec = {};
      keyByCol.forEach((key, colIdx) => {
        if (!key) return;
        const v = rowArr[colIdx];
        rec[key] = typeof v === "string" ? v.trim() : v;
      });

      ROW_REQUIRED_KEYS.forEach((key) => {
        if (rec[key] === "" || rec[key] === null || rec[key] === undefined) {
          errors.push({ row: excelRow, field: fieldHeader(key), message: "必填欄位空白" });
        }
      });

      // 日期欄沒有值、或格式無法辨識，一律視為「無日期」，不阻斷上傳。
      TEST_DATE_FIELD_KEYS.forEach((key) => {
        const val = rec[key];
        if (val === "" || val === null || val === undefined) {
          rec[key] = null;
          return;
        }
        const iso = parseExcelDateValue(val);
        if (!iso) unparseableDateCount++;
        rec[key] = iso;
      });

      if (rec.tcCount === "" || rec.tcCount === null || rec.tcCount === undefined) {
        rec.tcCount = null;
      } else {
        const n = Number(rec.tcCount);
        if (Number.isNaN(n)) {
          errors.push({ row: excelRow, field: "TC數量", message: `不是數字：${rec.tcCount}` });
        } else {
          rec.tcCount = n;
        }
      }

      rec._excelRow = excelRow;
      records.push(rec);
    });

    return { records, errors, unparseableDateCount };
  }

  function showUploadErrors(errors) {
    const el = document.getElementById("uploadErrors");
    el.classList.remove("hidden");
    el.innerHTML = `<div class="upload-errors-title">上傳未匯入，請修正以下 ${errors.length} 個問題後重新上傳：</div>` +
      errors.map((e) => `<div class="upload-error-item"><span class="row-tag">第 ${e.row} 列</span>${escapeHTML(e.field)}：${escapeHTML(e.message)}</div>`).join("");
  }

  function hideUploadErrors() {
    const el = document.getElementById("uploadErrors");
    el.classList.add("hidden");
    el.innerHTML = "";
  }

  async function mergeAndUploadRecords(records) {
    const fsdCodes = [...new Set(records.map((r) => r.fsd))];
    for (const fsd of fsdCodes) {
      const exists = state.modules.some((m) => m.data.name === fsd);
      if (!exists) {
        const body = buildBody({ name: fsd, owners: [] }, ["**負責人**：-"]);
        await ghFetch("/issues", {
          method: "POST",
          body: JSON.stringify({ title: `[module] ${fsd}`, body, labels: [LABEL.module] }),
        });
      }
    }
    await loadModules();

    const byFsd = {};
    records.forEach((r) => {
      if (!byFsd[r.fsd]) byFsd[r.fsd] = [];
      byFsd[r.fsd].push(r);
    });

    const nowISO = new Date().toISOString();

    for (const fsd of Object.keys(byFsd)) {
      const incoming = byFsd[fsd];
      const existingBatch = state.testBatches.find((b) => b.fsd === fsd);
      const existingItemsById = {};
      (existingBatch ? existingBatch.items : []).forEach((it) => { existingItemsById[it.id] = it; });

      incoming.forEach((r) => {
        const prev = existingItemsById[r.id];
        const nextItem = {
          id: r.id,
          customerTestDate: r.customerTestDate || null,
          layer1: r.layer1 || "",
          layer2: r.layer2 || "",
          itemType: r.itemType || "",
          backendOwner: r.backendOwner || "",
          frontendOwner: r.frontendOwner || "",
          plannedDeliveryDate: r.plannedDeliveryDate || null,
          actualDeliveryDate: r.actualDeliveryDate || null,
          deliveryStatus: r.deliveryStatus || "",
          ftTestDate: r.ftTestDate || null,
          ftStatus: r.ftStatus || "",
          ftNote: r.ftNote || "",
          sitTestDate: r.sitTestDate || null,
          sitStatus: r.sitStatus || "",
          tcCount: r.tcCount,
          sitNote: r.sitNote || "",
          testSA: r.testSA || "",
          testDays: prev && Number.isFinite(prev.testDays) ? prev.testDays : null,
          history: prev ? (prev.history || []) : [],
          updatedAt: nowISO,
        };
        if (prev && (prev.deliveryStatus !== nextItem.deliveryStatus || prev.ftStatus !== nextItem.ftStatus || prev.sitStatus !== nextItem.sitStatus)) {
          nextItem.history = [
            { at: prev.updatedAt || nowISO, deliveryStatus: prev.deliveryStatus, ftStatus: prev.ftStatus, sitStatus: prev.sitStatus },
            ...nextItem.history,
          ].slice(0, 20);
        }
        existingItemsById[r.id] = nextItem;
      });

      const mergedItems = Object.values(existingItemsById);
      const fsdName = incoming[incoming.length - 1].fsdName || (existingBatch ? existingBatch.fsdName : "");
      const body = buildBody({ fsd, fsdName, items: mergedItems }, [
        `**FSD**：${fsd}`,
        `**FSD名稱**：${fsdName}`,
        `**功能項目數**：${mergedItems.length}`,
      ]);

      if (existingBatch) {
        await ghFetch(`/issues/${existingBatch.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
      } else {
        await ghFetch("/issues", {
          method: "POST",
          body: JSON.stringify({ title: `[test-items] ${fsd}`, body, labels: [LABEL.testItemBatch] }),
        });
      }
    }

    await loadTestingAll();
  }

  async function onUploadExcelChange(e) {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (typeof XLSX === "undefined") {
      alert("Excel 函式庫尚未載入完成，請稍後再試一次。");
      return;
    }

    hideUploadErrors();
    setTestingStatus("讀取 Excel 中…");
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      if (rows.length < 2) throw new Error("Excel 沒有資料列");

      const headerRow = rows[0];
      const keyByCol = headerRow.map((h) => {
        const norm = normalizeHeader(h);
        const col = TEST_TEMPLATE_COLUMNS.find((c) => normalizeHeader(c.header) === norm);
        return col ? col.key : null;
      });

      const missingCols = REQUIRED_TEST_FIELD_KEYS.filter((k) => !keyByCol.includes(k));
      if (missingCols.length) {
        throw new Error(`Excel 缺少必要欄位：${missingCols.map(fieldHeader).join("、")}`);
      }

      const { records, errors, unparseableDateCount } = parseAndValidateRows(rows.slice(1), keyByCol);
      if (errors.length) {
        showUploadErrors(errors);
        setTestingStatus(`上傳未匯入：發現 ${errors.length} 個錯誤，請修正後重新上傳`, true);
        return;
      }
      if (records.length === 0) {
        setTestingStatus("Excel 沒有可匯入的資料列", true);
        return;
      }

      setTestingStatus(`解析成功，共 ${records.length} 列，寫入 GitHub 中…`);
      await mergeAndUploadRecords(records);
      const dateNote = unparseableDateCount > 0 ? `（其中 ${unparseableDateCount} 個日期欄無法辨識，已視為未設定）` : "";
      setTestingStatus(`已更新 ✓${dateNote}`);
      setTimeout(() => setTestingStatus(""), unparseableDateCount > 0 ? 4000 : 2000);
    } catch (err) {
      setTestingStatus("上傳失敗：" + err.message, true);
    }
  }

  // =========================================================
  // Overlay (modal) helpers
  // =========================================================
  function renderOverlay(innerHTML) {
    const root = document.getElementById("overlayRoot");
    root.innerHTML = `<div class="overlay-backdrop" id="overlayBackdrop">${innerHTML}</div>`;
    root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeOverlay));
    document.getElementById("overlayBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "overlayBackdrop") closeOverlay();
    });
  }

  function closeOverlay() {
    document.getElementById("overlayRoot").innerHTML = "";
  }

  function openSettingsModal() {
    renderOverlay(`
      <div class="overlay-panel">
        <h2>設定</h2>
        <div class="help-text">
          Token 只會存在你自己瀏覽器的 localStorage，不會上傳到任何地方（GitHub API 除外）。
          每個使用者都需要各自設定自己的 Token。詳細申請步驟請見 README.md。
        </div>
        <div class="form-row">
          <label>GitHub Personal Access Token</label>
          <input type="password" id="s_token" value="${escapeHTML(state.token)}" placeholder="ghp_... 或 github_pat_...">
        </div>
        <div class="form-row">
          <label>你的顯示名稱（作為預設提出人 / 回報人）</label>
          <input type="text" id="s_name" value="${escapeHTML(state.displayName)}" placeholder="例如：Alice">
        </div>
        <div class="form-row">
          <span class="status-msg" id="settingsTestMsg"></span>
        </div>
        <div class="form-actions">
          <button type="button" class="btn-ghost" id="testConnBtn">測試連線</button>
          <button type="button" class="btn-primary" id="saveSettingsBtn">儲存</button>
        </div>
      </div>
    `);

    document.getElementById("testConnBtn").addEventListener("click", async () => {
      const msgEl = document.getElementById("settingsTestMsg");
      const token = document.getElementById("s_token").value.trim();
      msgEl.textContent = "測試中…";
      msgEl.classList.remove("error");
      try {
        const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        if (res.ok) {
          msgEl.textContent = "連線成功 ✓";
        } else if (res.status === 401) {
          msgEl.textContent = "Token 無效";
          msgEl.classList.add("error");
        } else if (res.status === 404) {
          msgEl.textContent = "找不到 repo，或 Token 沒有存取權限";
          msgEl.classList.add("error");
        } else {
          msgEl.textContent = `連線失敗 (${res.status})`;
          msgEl.classList.add("error");
        }
      } catch (e) {
        msgEl.textContent = "無法連線，請檢查網路";
        msgEl.classList.add("error");
      }
    });

    document.getElementById("saveSettingsBtn").addEventListener("click", () => {
      const token = document.getElementById("s_token").value.trim();
      const name = document.getElementById("s_name").value.trim();
      state.token = token;
      state.displayName = name;
      localStorage.setItem(LS_TOKEN, token);
      localStorage.setItem(LS_NAME, name);
      closeOverlay();
      startApp();
    });
  }
})();
