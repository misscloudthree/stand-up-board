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
    { key: "teamIt", header: "團+IT" },
    { key: "fglTest", header: "FGL交測" },
    { key: "passDate", header: "預計完成日(測試通過)" },
    { key: "seq", header: "序號" },
    { key: "fsd", header: "FSD" },
    { key: "fsdName", header: "FSD名稱" },
    { key: "layer1", header: "第一層" },
    { key: "layer2", header: "第二層" },
    { key: "itemType", header: "類型" },
    { key: "subType", header: "細分類" },
    { key: "id", header: "測試情境ID" },
    { key: "deliveryPhase", header: "交付階段" },
    { key: "plannedDeliveryDate", header: "預計交付時程" },
    { key: "actualDeliveryDate", header: "實際交付時程" },
    { key: "deliveryNote", header: "交付備註" },
    { key: "deliveryStatus", header: "交付狀態" },
    { key: "ftTestDate", header: "FT測試完成日期" },
    { key: "ftStatus", header: "FT測試狀態" },
    { key: "ftNote", header: "FT備註" },
    { key: "dependency", header: "相依外圍介接工項" },
    { key: "techCheck", header: "Tech盤點(介接)" },
    { key: "interfaceItem", header: "介接" },
    { key: "interfaceDeliveryStatus", header: "介接交付狀態" },
    { key: "sitTestDate", header: "SIT測試完成日期" },
    { key: "sitStatus", header: "SIT測試狀態" },
    { key: "tcCount", header: "TC數量" },
    { key: "sitNote", header: "SIT備註" },
    { key: "testSA", header: "測試SA" },
  ];
  // 範本必須包含的欄位（表頭檢查用）。實測參考資料顯示：FSD/測試情境ID 幾乎不會
  // 空白，但預計交付時程/交付狀態/FT/SIT 狀態在真實資料中常見空白（未排程、尚未測試等
  // 合理狀態），所以「欄位必須存在」跟「每列不可空白」分開處理，見 ROW_REQUIRED_KEYS。
  const REQUIRED_TEST_FIELD_KEYS = [
    "fsd", "fsdName", "layer1", "layer2", "id",
    "plannedDeliveryDate", "deliveryStatus", "ftStatus", "sitStatus",
  ];
  // 每一列真正不可空白的欄位（沒有就無法辨識這是哪個模組/哪個功能項目）。
  const ROW_REQUIRED_KEYS = ["fsd", "id"];
  const TEST_DATE_FIELD_KEYS = ["plannedDeliveryDate", "actualDeliveryDate", "ftTestDate", "sitTestDate", "passDate"];
  const NO_TEST_NEEDED = "不需測試";

  const state = {
    token: localStorage.getItem(LS_TOKEN) || "",
    displayName: localStorage.getItem(LS_NAME) || "",
    tab: "backlog",
    backlogItems: [],
    modules: [],
    dailyFields: [], // [{number, key, label}]
    dailyDate: todayStr(),
    dailyEntries: {}, // moduleName -> {number, data}
    dailyLoaded: false,
    testBatches: [], // [{number, fsd, fsdName, items: [...]}]
    testItems: [], // 攤平後的所有 item，each item 帶 _batchNumber/_fsd/_fsdName 反查用
    phaseSettings: { number: null, defaultTestDays: 3, phases: [] },
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

  function findPhaseSetting(phaseSettings, phase) {
    return (phaseSettings.phases || []).find((p) => p.phase === phase) || null;
  }

  // 依「該功能交付時程」+「基本測試天數」，用該測試階段完成日回推預計測試時程，
  // 並判斷「可測試期間 < 基本測試天數」的風險。stage 為 'ft' 或 'sit'。
  function computeSchedule(item, phaseSettings, stage) {
    const statusKey = stage === "ft" ? "ftStatus" : "sitStatus";
    const dateKey = stage === "ft" ? "ftDueDate" : "sitDueDate";
    const status = item[statusKey];

    if (!item.deliveryPhase) return { scheduled: false, reason: "no-phase", risk: false };
    const setting = findPhaseSetting(phaseSettings, item.deliveryPhase);
    const dueDate = setting ? setting[dateKey] : null;
    if (!dueDate) return { scheduled: false, reason: "no-due-date", risk: false };
    if (!item.plannedDeliveryDate) return { scheduled: false, reason: "no-delivery-date", risk: false };

    const availableDays = daysBetween(item.plannedDeliveryDate, dueDate);
    const testDays = Number.isFinite(item.testDays) ? item.testDays : phaseSettings.defaultTestDays;
    const skipRisk = status === NO_TEST_NEEDED;
    const risk = !skipRisk && availableDays !== null && availableDays < testDays;
    const windowStart = addDays(dueDate, -testDays);

    return {
      scheduled: true,
      dueDate,
      testDays,
      availableDays,
      windowStart,
      windowEnd: dueDate,
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
    document.getElementById("sortDeadline").addEventListener("change", renderBacklog);
    document.getElementById("backlogColumns").addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (card) openBacklogDetail(Number(card.dataset.issue));
    });

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
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.getElementById("backlogView").classList.toggle("active", tab === "backlog");
    document.getElementById("modulesView").classList.toggle("active", tab === "modules");
    document.getElementById("dailyView").classList.toggle("active", tab === "daily");
    document.getElementById("testingView").classList.toggle("active", tab === "testing");

    if (tab === "backlog" && state.backlogItems.length === 0) loadBacklog();
    if (tab === "modules" && state.modules.length === 0) loadModules();
    if (tab === "daily") {
      if (state.modules.length === 0 || state.dailyFields.length === 0) {
        loadModulesAndDaily();
      } else if (!state.dailyLoaded) {
        loadDailyEntries(state.dailyDate);
      } else {
        renderDailyTable();
        renderSummary();
      }
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

  function renderBacklog() {
    const selectedStatuses = new Set(
      [...document.querySelectorAll(".status-filter-cb:checked")].map((cb) => cb.value)
    );
    const categoryFilter = document.getElementById("filterCategory").value;
    const sortDir = document.getElementById("sortDeadline").value;

    const cols = { pending: [], doing: [], done: [], void: [] };
    state.backlogItems.forEach((item) => {
      const st = STATUS[item.data.status] ? item.data.status : "pending";
      if (!selectedStatuses.has(st)) return;
      if (categoryFilter && (item.data.category || "") !== categoryFilter) return;
      cols[st].push(item);
    });
    Object.keys(cols).forEach((st) => {
      cols[st].sort((a, b) => {
        const cmp = (a.data.deadline || "9999-99-99").localeCompare(b.data.deadline || "9999-99-99");
        return sortDir === "desc" ? -cmp : cmp;
      });
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

  async function refreshComments(issueNumber) {
    const el = document.getElementById("commentList");
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
    }
  }

  function syncPhaseListWithData() {
    const known = new Set(state.phaseSettings.phases.map((p) => p.phase));
    state.testItems.forEach((it) => {
      if (it.deliveryPhase && !known.has(it.deliveryPhase)) {
        state.phaseSettings.phases.push({ phase: it.deliveryPhase, ftDueDate: "", sitDueDate: "" });
        known.add(it.deliveryPhase);
      }
    });
  }

  async function loadPhaseSettings() {
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.testPhaseSetting)}&state=open&per_page=100`);
      if (issues.length === 0) {
        state.phaseSettings = { number: null, defaultTestDays: 3, phases: [] };
      } else {
        const d = extractData(issues[0].body) || {};
        state.phaseSettings = {
          number: issues[0].number,
          defaultTestDays: Number.isFinite(d.defaultTestDays) ? d.defaultTestDays : 3,
          phases: Array.isArray(d.phases) ? d.phases : [],
        };
      }
      syncPhaseListWithData();
      renderPhaseSettingsForm();
      renderTestingOverview();
    } catch (e) {
      setPhaseStatus("讀取階段設定失敗：" + e.message, true);
    }
  }

  function renderPhaseSettingsForm() {
    document.getElementById("defaultTestDaysInput").value = state.phaseSettings.defaultTestDays;
    const tbody = document.getElementById("phaseSettingsBody");
    tbody.innerHTML = state.phaseSettings.phases.length
      ? state.phaseSettings.phases.map((p) => `
          <tr data-phase="${escapeHTML(p.phase)}">
            <td>${escapeHTML(p.phase)}</td>
            <td><input type="date" class="num-input" style="width:150px" data-phase-field="ftDueDate" value="${escapeHTML(p.ftDueDate || "")}"></td>
            <td><input type="date" class="num-input" style="width:150px" data-phase-field="sitDueDate" value="${escapeHTML(p.sitDueDate || "")}"></td>
          </tr>`).join("")
      : `<tr><td colspan="3" class="empty-hint">尚未有資料中的交付階段可設定，請先上傳 Excel</td></tr>`;
  }

  async function onSavePhaseSettings() {
    const defaultTestDays = Number(document.getElementById("defaultTestDaysInput").value) || 0;
    const phases = [];
    document.querySelectorAll("#phaseSettingsBody tr[data-phase]").forEach((tr) => {
      phases.push({
        phase: tr.dataset.phase,
        ftDueDate: tr.querySelector('[data-phase-field="ftDueDate"]').value || "",
        sitDueDate: tr.querySelector('[data-phase-field="sitDueDate"]').value || "",
      });
    });
    const dataObj = { defaultTestDays, phases };
    const body = buildBody(dataObj, [
      `**全域預設基本測試天數**：${defaultTestDays}`,
      ...phases.map((p) => `**${p.phase} 階段**：FT ${p.ftDueDate || "-"}／SIT ${p.sitDueDate || "-"}`),
    ]);

    const btn = document.getElementById("savePhaseSettingsBtn");
    btn.disabled = true;
    setPhaseStatus("儲存中…");
    try {
      if (state.phaseSettings.number) {
        await ghFetch(`/issues/${state.phaseSettings.number}`, { method: "PATCH", body: JSON.stringify({ body }) });
      } else {
        const issue = await ghFetch("/issues", {
          method: "POST",
          body: JSON.stringify({ title: "[test-phase-setting] 測試階段設定", body, labels: [LABEL.testPhaseSetting] }),
        });
        state.phaseSettings.number = issue.number;
      }
      state.phaseSettings.defaultTestDays = defaultTestDays;
      state.phaseSettings.phases = phases;
      renderTestingOverview();
      setPhaseStatus("已儲存 ✓");
      setTimeout(() => setPhaseStatus(""), 1500);
    } catch (e) {
      alert("儲存階段設定失敗：" + e.message);
      setPhaseStatus("");
    }
    btn.disabled = false;
  }

  function renderTestingOverview() {
    const container = document.getElementById("testingOverview");
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
      const ft = computeSchedule(it, state.phaseSettings, "ft");
      const sit = computeSchedule(it, state.phaseSettings, "sit");
      if (ft.risk || sit.risk) riskCount++;
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

        <div class="item-detail-wrap ${expanded ? "" : "hidden"}">
          ${expanded ? renderItemDetailTable(batch, items) : ""}
        </div>
      </div>
    `;
  }

  function renderItemDetailTable(batch, items) {
    const scheduleText = (item, s) => {
      if (!item.deliveryPhase) return '<span class="item-phase-empty">未設定交付階段</span>';
      if (!s.scheduled) return '<span class="item-phase-empty">尚未設定完成日</span>';
      return `${escapeHTML(s.windowStart || "-")} ~ ${escapeHTML(s.windowEnd)}${s.risk ? ' <span class="risk-badge">風險</span>' : ""}`;
    };

    const rows = items.map((it) => {
      const ft = computeSchedule(it, state.phaseSettings, "ft");
      const sit = computeSchedule(it, state.phaseSettings, "sit");
      return `
        <tr data-item-id="${escapeHTML(it.id)}">
          <td>${escapeHTML(it.id)}</td>
          <td>${escapeHTML(it.layer1 || "")}${it.layer2 ? "／" + escapeHTML(it.layer2) : ""}</td>
          <td>${escapeHTML(it.deliveryStatus || "-")}</td>
          <td>${escapeHTML(it.ftStatus || "-")}</td>
          <td>${escapeHTML(it.sitStatus || "-")}</td>
          <td>${scheduleText(it, ft)}</td>
          <td>${scheduleText(it, sit)}</td>
          <td><input type="number" min="0" class="num-input" data-item-testdays value="${Number.isFinite(it.testDays) ? it.testDays : ""}" placeholder="${state.phaseSettings.defaultTestDays}"></td>
          <td><button type="button" class="btn-save" data-save-testdays="${escapeHTML(batch.number + ":" + it.id)}">儲存</button></td>
        </tr>`;
    }).join("");

    return `
      <table class="item-detail-table">
        <thead>
          <tr>
            <th>測試情境ID</th><th>功能項目</th><th>交付狀態</th><th>FT 狀態</th><th>SIT 狀態</th>
            <th>FT 預計測試時程</th><th>SIT 預計測試時程</th><th>基本測試天數</th><th></th>
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

      TEST_DATE_FIELD_KEYS.forEach((key) => {
        const val = rec[key];
        if (val === "" || val === null || val === undefined) {
          rec[key] = null;
          return;
        }
        const iso = parseExcelDateValue(val);
        if (!iso) {
          errors.push({ row: excelRow, field: fieldHeader(key), message: `日期格式無法解析：${val}` });
        } else {
          rec[key] = iso;
        }
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

    return { records, errors };
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
          layer1: r.layer1 || "",
          layer2: r.layer2 || "",
          itemType: r.itemType || "",
          subType: r.subType || "",
          deliveryPhase: r.deliveryPhase || "",
          plannedDeliveryDate: r.plannedDeliveryDate || null,
          actualDeliveryDate: r.actualDeliveryDate || null,
          deliveryNote: r.deliveryNote || "",
          deliveryStatus: r.deliveryStatus || "",
          ftTestDate: r.ftTestDate || null,
          ftStatus: r.ftStatus || "",
          ftNote: r.ftNote || "",
          dependency: r.dependency || "",
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

      const { records, errors } = parseAndValidateRows(rows.slice(1), keyByCol);
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
      setTestingStatus("已更新 ✓");
      setTimeout(() => setTestingStatus(""), 2000);
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
