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
  };

  const STATUS = {
    pending: { label: "待處理" },
    doing: { label: "進行中" },
    done: { label: "已完成" },
    void: { label: "作廢" },
  };
  const STATUS_ORDER = ["pending", "doing", "done", "void"];

  const state = {
    token: localStorage.getItem(LS_TOKEN) || "",
    displayName: localStorage.getItem(LS_NAME) || "",
    tab: "backlog",
    backlogItems: [],
    modules: [],
    dailyDate: todayStr(),
    dailyEntries: {}, // moduleName -> {number, data}
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
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("todayDate").textContent = state.dailyDate;
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
    } catch (e) {
      /* ignore */
    }

    state.backlogItems = [];
    state.modules = [];
    switchTab(state.tab);
  }

  function bindStaticEvents() {
    document.getElementById("settingsBtn").addEventListener("click", () => openSettingsModal());

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    document.getElementById("addBacklogBtn").addEventListener("click", openAddBacklogModal);
    document.getElementById("refreshBacklogBtn").addEventListener("click", loadBacklog);
    document.getElementById("filterUnfinished").addEventListener("change", renderBacklog);
    document.getElementById("backlogColumns").addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (card) openBacklogDetail(Number(card.dataset.issue));
    });

    document.getElementById("addModuleForm").addEventListener("submit", onAddModuleSubmit);
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
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.getElementById("backlogView").classList.toggle("active", tab === "backlog");
    document.getElementById("dailyView").classList.toggle("active", tab === "daily");

    if (tab === "backlog" && state.backlogItems.length === 0) loadBacklog();
    if (tab === "daily" && state.modules.length === 0) loadModulesAndDaily();
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
      renderBacklog();
      setBacklogStatus("");
    } catch (e) {
      setBacklogStatus("讀取失敗：" + e.message, true);
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

  function backlogCardHTML(item) {
    const d = item.data;
    const urgency = getUrgency(d.deadline, d.status);
    return `
      <div class="card ${urgency.cls}" data-issue="${item.number}">
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
    const hideFinished = document.getElementById("filterUnfinished").checked;
    const cols = { pending: [], doing: [], done: [], void: [] };
    state.backlogItems.forEach((item) => {
      const st = STATUS[item.data.status] ? item.data.status : "pending";
      if (hideFinished && (st === "done" || st === "void")) return;
      cols[st].push(item);
    });
    Object.keys(cols).forEach((st) => {
      cols[st].sort((a, b) => (a.data.deadline || "9999-99-99").localeCompare(b.data.deadline || "9999-99-99"));
    });

    const container = document.getElementById("backlogColumns");
    container.innerHTML = STATUS_ORDER.map((key) => `
      <div class="board-col" data-status="${key}">
        <div class="col-head"><span>${STATUS[key].label}</span><span class="count-badge">${cols[key].length}</span></div>
        <div class="col-body">${cols[key].map(backlogCardHTML).join("") || '<div class="empty-hint">目前沒有項目</div>'}</div>
      </div>
    `).join("");
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
    const owner = document.getElementById("f_owner").value.trim();
    const deadline = document.getElementById("f_deadline").value;
    const submitter = document.getElementById("f_submitter").value.trim();
    const createdDate = document.getElementById("f_createdDate").value || todayStr();
    if (!content) return;

    const dataObj = { content, owner, submitter, createdDate, deadline, status: "pending" };
    const body = buildBody(dataObj, [
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
  // Daily test tracking
  // =========================================================
  function setDailyStatus(msg, isError) {
    const el = document.getElementById("dailyStatusMsg");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  }

  async function loadModulesAndDaily() {
    await loadModules();
    await loadDailyEntries(state.dailyDate);
  }

  async function loadModules() {
    setDailyStatus("載入模組中…");
    try {
      const issues = await ghFetch(`/issues?labels=${enc(LABEL.module)}&state=open&per_page=100`);
      state.modules = issues.map((issue) => ({
        number: issue.number,
        data: extractData(issue.body) || { name: issue.title, owners: [] },
      }));
      renderModuleList();
      setDailyStatus("");
    } catch (e) {
      setDailyStatus("讀取模組失敗：" + e.message, true);
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
      : '<span class="empty-hint">尚未新增任何模組</span>';

    el.querySelectorAll("[data-remove-module]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("確定要移除這個模組嗎？（歷史測試資料仍會保留在 GitHub Issues 中）")) return;
        try {
          await ghFetch(`/issues/${btn.dataset.removeModule}`, {
            method: "PATCH",
            body: JSON.stringify({ state: "closed" }),
          });
          await loadModules();
          renderDailyTable();
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
    btn.disabled = true;
    try {
      await ghFetch("/issues", {
        method: "POST",
        body: JSON.stringify({ title: `[module] ${name}`, body, labels: [LABEL.module] }),
      });
      document.getElementById("newModuleName").value = "";
      document.getElementById("newModuleOwners").value = "";
      await loadModules();
      await loadDailyEntries(state.dailyDate);
    } catch (err) {
      alert("新增模組失敗：" + err.message);
    }
    btn.disabled = false;
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
      renderDailyTable();
      renderSummary();
      setDailyStatus("");
    } catch (e) {
      setDailyStatus("讀取失敗：" + e.message, true);
    }
  }

  function dailyRowHTML(mod) {
    const name = mod.data.name;
    const entry = state.dailyEntries[name];
    const v = entry ? entry.data : { opened: 0, retested: 0, retestPassed: 0, preUat: 0 };
    return `
      <tr data-module="${escapeHTML(name)}">
        <td>${escapeHTML(name)}</td>
        <td class="muted">${escapeHTML((mod.data.owners || []).join("、"))}</td>
        <td><input type="number" min="0" class="num-input" data-field="opened" value="${v.opened || 0}"></td>
        <td><input type="number" min="0" class="num-input" data-field="retested" value="${v.retested || 0}"></td>
        <td><input type="number" min="0" class="num-input" data-field="retestPassed" value="${v.retestPassed || 0}"></td>
        <td><input type="number" min="0" class="num-input" data-field="preUat" value="${v.preUat || 0}"></td>
        <td><button type="button" class="btn-save" data-action="save-row">儲存</button></td>
      </tr>`;
  }

  function renderDailyTable() {
    const tbody = document.getElementById("dailyTableBody");
    tbody.innerHTML = state.modules.length
      ? state.modules.map(dailyRowHTML).join("")
      : `<tr><td colspan="7" class="empty-hint">尚未新增模組，請先在上方「模組管理」新增</td></tr>`;
  }

  async function saveDailyEntry(moduleName, btn) {
    const tr = btn.closest("tr");
    const get = (f) => Number(tr.querySelector(`[data-field="${f}"]`).value) || 0;
    const dataObj = {
      module: moduleName,
      date: state.dailyDate,
      opened: get("opened"),
      retested: get("retested"),
      retestPassed: get("retestPassed"),
      preUat: get("preUat"),
      reporter: state.displayName || "-",
    };
    const body = buildBody(dataObj, [
      `**模組**：${moduleName}`,
      `**日期**：${state.dailyDate}`,
      `**開單量**：${dataObj.opened}`,
      `**複測數量**：${dataObj.retested}`,
      `**複測通過量**：${dataObj.retestPassed}`,
      `**Pre-UAT 處理量**：${dataObj.preUat}`,
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
    const totals = { opened: 0, retested: 0, retestPassed: 0, preUat: 0 };
    Object.values(state.dailyEntries).forEach((e) => {
      totals.opened += e.data.opened || 0;
      totals.retested += e.data.retested || 0;
      totals.retestPassed += e.data.retestPassed || 0;
      totals.preUat += e.data.preUat || 0;
    });
    document.getElementById("summaryBoard").innerHTML = `
      <div class="summary-item"><span class="summary-num">${totals.opened}</span><span class="summary-label">開單量</span></div>
      <div class="summary-item"><span class="summary-num">${totals.retested}</span><span class="summary-label">複測數量</span></div>
      <div class="summary-item"><span class="summary-num">${totals.retestPassed}</span><span class="summary-label">複測通過量</span></div>
      <div class="summary-item"><span class="summary-num">${totals.preUat}</span><span class="summary-label">Pre-UAT 處理量</span></div>
    `;
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
