const STORAGE_KEYS = {
  snippet: "chromeHook.customSnippet",
  categories: "chromeHook.selectedCategories",
  logQuery: "chromeHook.logQuery",
  keywords: "chromeHook.keywords",
  keywordMode: "chromeHook.keywordMode"
};

const KEYWORD_RULE_PREFIX = /^(exact-key|exact-value|exact|key|value):/i;
const KEYWORD_MODE_PREFIX = {
  "contains-all": "",
  "contains-key": "key:",
  "contains-value": "value:",
  "exact-all": "exact:",
  "exact-key": "exact-key:",
  "exact-value": "exact-value:"
};

const MAX_VISIBLE_LOGS = 120;
const LOG_RENDER_DELAY = 90;
const DEFAULT_SELECTED_CATEGORIES = ["xhr"];
const HOOK_CATEGORIES = [
  { id: "fetch", label: "Fetch", description: "追踪 window.fetch 请求与响应。" },
  { id: "xhr", label: "XHR", description: "追踪 open、setRequestHeader、send 与响应头。" },
  { id: "cookie", label: "Cookie", description: "追踪 document.cookie 与 cookieStore 读写。" },
  { id: "storage", label: "Storage", description: "追踪 localStorage / sessionStorage 读写。" },
  { id: "json", label: "JSON", description: "追踪 JSON.parse / JSON.stringify。" },
  { id: "eval", label: "Eval", description: "追踪动态执行代码入口。" },
  { id: "timer", label: "Timer", description: "追踪 setTimeout / setInterval。" },
  { id: "keyword", label: "Keyword", description: "独立监控 fetch / xhr / cookie，并按关键词命中输出。" }
];

const CATEGORY_LABELS = Object.fromEntries(HOOK_CATEGORIES.map((item) => [item.id, item.label]));

const templates = {
  atob: `const decodeTarget = hook.resolvePath("window.atob");
const encodeTarget = hook.resolvePath("window.btoa");

if (decodeTarget) {
  hook.wrapMethod(decodeTarget.target, decodeTarget.key, "hook.atob", (original) => function (...args) {
    hook.log("info", "window.atob call", { args }, { stack: hook.captureStack() });
    const result = original.apply(this, args);
    hook.log("info", "window.atob result", { result });
    return result;
  });
}

if (encodeTarget) {
  hook.wrapMethod(encodeTarget.target, encodeTarget.key, "hook.btoa", (original) => function (...args) {
    hook.log("info", "window.btoa call", { args });
    return original.apply(this, args);
  });
}`,
  fetch: `const target = hook.resolvePath("window.fetch");

if (target) {
  hook.wrapMethod(target.target, target.key, "hook.fetch.deep", (original) => async function (...args) {
    hook.log("info", "deep fetch request", { args }, { category: "fetch", stack: hook.captureStack() });
    const response = await original.apply(this, args);
    const clone = response.clone();
    const body = await clone.text().catch(() => "[body unreadable]");
    hook.log("info", "deep fetch response", {
      url: response.url,
      status: response.status,
      body
    }, { category: "fetch" });
    return response;
  }, "fetch");
}`,
  json: `const target = hook.resolvePath("JSON.parse");

if (target) {
  hook.wrapMethod(target.target, target.key, "hook.json.parse.break", (original) => function (...args) {
    debugger;
    hook.log("warn", "JSON.parse breakpoint", { args }, { category: "json", stack: hook.captureStack() });
    return original.apply(this, args);
  }, "json");
}`,
  storage: `const setTarget = hook.resolvePath("Storage.prototype.setItem");
const getTarget = hook.resolvePath("Storage.prototype.getItem");

if (setTarget) {
  hook.wrapMethod(setTarget.target, setTarget.key, "hook.storage.set", (original) => function (...args) {
    hook.log("info", "localStorage.setItem custom", { args }, { category: "storage", stack: hook.captureStack() });
    return original.apply(this, args);
  }, "storage");
}

if (getTarget) {
  hook.wrapMethod(getTarget.target, getTarget.key, "hook.storage.get", (original) => function (...args) {
    const result = original.apply(this, args);
    hook.log("info", "localStorage.getItem custom", { args, result }, { category: "storage" });
    return result;
  }, "storage");
}`
};

const state = {
  activeTabId: null,
  logs: [],
  status: null,
  logQuery: "",
  keywordText: "",
  keywordMode: "contains-all",
  selectedCategories: new Set(DEFAULT_SELECTED_CATEGORIES),
  logRenderTimer: null
};

const pageTitle = document.getElementById("pageTitle");
const statusText = document.getElementById("statusText");
const statusBadge = document.getElementById("statusBadge");
const activeCategories = document.getElementById("activeCategories");
const categoryGrid = document.getElementById("categoryGrid");
const logFeed = document.getElementById("logFeed");
const logCount = document.getElementById("logCount");
const logSummary = document.getElementById("logSummary");
const logSearch = document.getElementById("logSearch");
const keywordMode = document.getElementById("keywordMode");
const keywordInput = document.getElementById("keywordInput");
const customCode = document.getElementById("customCode");
const captureStack = document.getElementById("captureStack");
const injectSelectedHooksButton = document.getElementById("injectSelectedHooks");
const removeHooksButton = document.getElementById("removeHooks");
const clearLogsButton = document.getElementById("clearLogs");
const runCustomHookButton = document.getElementById("runCustomHook");

function formatTime(ts) {
  if (!ts) {
    return "--:--:--";
  }
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (_error) {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCategoryLabel(category) {
  return CATEGORY_LABELS[category] || category || "Custom";
}

function formatPageLabel(pageUrl) {
  try {
    return pageUrl ? new URL(pageUrl).hostname : "当前激活标签页";
  } catch (_error) {
    return pageUrl || "当前激活标签页";
  }
}

function compactUrl(url) {
  if (!url) {
    return "";
  }

  return url.length > 76 ? `${url.slice(0, 76)}...` : url;
}

function getLogHeadline(entry) {
  const details = entry.details || {};
  const summary = details.summary || {};
  const phase = details.phase ? details.phase.toUpperCase() : "";
  const method = summary.method || details.request?.method || "";
  const url = compactUrl(summary.url || details.request?.url || details.response?.url || "");
  const status = summary.status ?? details.response?.status;
  const parts = [phase, method, url, status !== undefined ? `status=${status}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : entry.label || "untitled";
}

function normalizeHeaderRows(headers) {
  return Object.entries(headers || {}).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return value.map((item) => ({ key, value: stringify(item) }));
    }
    return [{ key, value: stringify(value) }];
  });
}

function renderHeaderTable(title, headers) {
  const rows = normalizeHeaderRows(headers);
  if (!rows.length) {
    return "";
  }

  return `
    <div class="log-section-title">${escapeHtml(title)}</div>
    <div class="header-table-wrap">
      <table class="header-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>${escapeHtml(row.key)}</td>
                  <td>${escapeHtml(row.value)}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderJsonSection(title, value) {
  return `
    <div class="log-section-title">${escapeHtml(title)}</div>
    <pre class="log-details">${escapeHtml(stringify(value))}</pre>
  `;
}

function buildStructuredSections(entry) {
  const details = entry.details || {};
  const sections = [];

  if (details.header) {
    sections.push(renderHeaderTable("Header", details.header));
  }

  if (details.request) {
    const request = { ...details.request };
    const requestHeaders = request.headers;
    const scriptHeaders = request.scriptHeaders;
    delete request.headers;
    delete request.scriptHeaders;

    if (Object.keys(request).length) {
      sections.push(renderJsonSection("Request", request));
    }
    sections.push(renderHeaderTable("Request Headers", requestHeaders));
    sections.push(renderHeaderTable("Script-set Headers", scriptHeaders));
  }

  if (details.response) {
    const response = { ...details.response };
    const responseHeaders = response.headers;
    delete response.headers;

    if (Object.keys(response).length) {
      sections.push(renderJsonSection("Response", response));
    }
    sections.push(renderHeaderTable("Response Headers", responseHeaders));
  }

  if (!sections.length) {
    sections.push(renderJsonSection("Details", details));
  }

  return sections.filter(Boolean).join("");
}

function renderCategoryGrid() {
  categoryGrid.innerHTML = HOOK_CATEGORIES.map(
    (item) => `
      <label class="category-option">
        <input type="checkbox" value="${item.id}" ${state.selectedCategories.has(item.id) ? "checked" : ""} />
        <span>
          <span class="category-title">${escapeHtml(item.label)}</span>
          <span class="category-description">${escapeHtml(item.description)}</span>
        </span>
      </label>
    `
  ).join("");
}

function renderActiveCategories() {
  const installedCategories = state.status?.installedCategories || [];

  if (!installedCategories.length) {
    activeCategories.innerHTML = '<span class="tag muted-tag">未安装分类</span>';
    return;
  }

  activeCategories.innerHTML = installedCategories
    .map((category) => `<span class="tag">${escapeHtml(formatCategoryLabel(category))}</span>`)
    .join("");
}

function renderStatus() {
  const installedCategories = state.status?.installedCategories || [];
  const installed = installedCategories.length > 0;
  statusBadge.textContent = installed ? "已注入" : "未注入";
  statusBadge.className = `badge ${installed ? "live" : "pending"}`;
  removeHooksButton.disabled = !installed;

  pageTitle.textContent = formatPageLabel(state.status?.pageUrl);
  statusText.textContent = installed
    ? `已安装 ${installedCategories.map(formatCategoryLabel).join(" / ")}，当前累计 ${state.status?.hookCount || 0} 个包装。`
    : "请选择需要的分类后再注入，避免一次性全量 Hook。";
  renderActiveCategories();
}

function buildLogSearchText(entry) {
  return [
    entry.category,
    entry.label,
    entry.level,
    entry.pageUrl,
    stringify(entry.details || {}),
    entry.stack || ""
  ]
    .join(" ")
    .toLowerCase();
}

function getKeywordList() {
  const prefix = KEYWORD_MODE_PREFIX[state.keywordMode] || "";
  return [...new Set(keywordInput.value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))].map((item) => {
    if (KEYWORD_RULE_PREFIX.test(item) || !prefix) {
      return item;
    }

    return `${prefix}${item}`;
  });
}

function getVisibleLogs() {
  const totalLogs = state.logs || [];
  const query = state.logQuery.trim().toLowerCase();
  const filteredLogs = query ? totalLogs.filter((entry) => buildLogSearchText(entry).includes(query)) : totalLogs;
  const visibleLogs = filteredLogs.slice(-MAX_VISIBLE_LOGS).reverse();
  return {
    totalLogs,
    filteredLogs,
    visibleLogs
  };
}

function renderLogsNow() {
  const { totalLogs, filteredLogs, visibleLogs } = getVisibleLogs();
  logCount.textContent = `${visibleLogs.length} / ${totalLogs.length} 条`;
  logSummary.textContent = state.logQuery
    ? `命中 ${filteredLogs.length} 条，展示最新 ${visibleLogs.length} 条`
    : `展示最新 ${visibleLogs.length} 条`;

  if (!visibleLogs.length) {
    logFeed.innerHTML = state.logQuery
      ? '<p class="empty-state">没有匹配到日志。可以试试分类名、接口地址、标签或响应内容关键词。</p>'
      : '<p class="empty-state">暂无日志。先勾选分类并注入，然后在页面里触发对应行为。</p>';
    return;
  }

  logFeed.innerHTML = visibleLogs
    .map(
      (entry) => `
        <article class="log-item">
          <div class="log-top">
            <span class="log-label">${escapeHtml(getLogHeadline(entry))}</span>
            <div class="log-tags">
              <span class="log-chip ${escapeHtml(entry.category || "custom")}">${escapeHtml(formatCategoryLabel(entry.category || "custom"))}</span>
              <span class="log-level">${escapeHtml(entry.level || "info")}</span>
            </div>
          </div>
          <div class="log-meta">
            <span>${escapeHtml(formatTime(entry.ts || entry.recordedAt))}</span>
            <span>${escapeHtml(entry.pageUrl || "")}</span>
          </div>
          ${buildStructuredSections(entry)}
          ${entry.stack ? `<div class="log-section-title">Stack</div><pre class="log-stack">${escapeHtml(entry.stack)}</pre>` : ""}
        </article>
      `
    )
    .join("");
}

function scheduleRenderLogs() {
  if (state.logRenderTimer) {
    window.clearTimeout(state.logRenderTimer);
  }

  state.logRenderTimer = window.setTimeout(() => {
    state.logRenderTimer = null;
    renderLogsNow();
  }, LOG_RENDER_DELAY);
}

async function request(message) {
  if (!state.activeTabId) {
    throw new Error("当前没有可用标签页");
  }

  const response = await chrome.runtime.sendMessage({
    ...message,
    tabId: state.activeTabId
  });

  if (!response?.ok) {
    throw new Error(response?.error || "请求失败");
  }

  return response;
}

async function savePreferences() {
  state.keywordText = keywordInput.value;
  state.keywordMode = keywordMode.value;
  await chrome.storage.local.set({
    [STORAGE_KEYS.snippet]: customCode.value,
    [STORAGE_KEYS.categories]: [...state.selectedCategories],
    [STORAGE_KEYS.logQuery]: state.logQuery,
    [STORAGE_KEYS.keywords]: state.keywordText,
    [STORAGE_KEYS.keywordMode]: state.keywordMode
  });
}

async function loadPreferences() {
  const result = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  customCode.value = result[STORAGE_KEYS.snippet] || templates.atob;
  state.logQuery = result[STORAGE_KEYS.logQuery] || "";
  logSearch.value = state.logQuery;
  state.keywordText = result[STORAGE_KEYS.keywords] || "";
  state.keywordMode = result[STORAGE_KEYS.keywordMode] || "contains-all";
  keywordInput.value = state.keywordText;
  keywordMode.value = state.keywordMode;

  const storedCategories = result[STORAGE_KEYS.categories];
  const selectedCategories = Array.isArray(storedCategories) ? storedCategories : DEFAULT_SELECTED_CATEGORIES;
  state.selectedCategories = new Set(selectedCategories.filter((category) => Boolean(CATEGORY_LABELS[category])));
  renderCategoryGrid();
}

async function refreshState() {
  try {
    await request({ type: "PING_TAB" });
    const response = await request({ type: "GET_TAB_STATE" });
    state.logs = response.logs || [];
    state.status = response.status || null;
    renderStatus();
    scheduleRenderLogs();
  } catch (error) {
    pageTitle.textContent = "当前页面不支持注入";
    statusText.textContent = error.message;
    statusBadge.textContent = "受限页面";
    statusBadge.className = "badge pending";
    activeCategories.innerHTML = '<span class="tag muted-tag">无法建立 bridge</span>';
    logFeed.innerHTML = '<p class="empty-state">Chrome 内置页、扩展页或无权限页无法注入内容脚本。</p>';
    logCount.textContent = "0 / 0 条";
    logSummary.textContent = "无法读取日志";
    removeHooksButton.disabled = true;
  }
}

async function init() {
  renderCategoryGrid();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTabId = tab?.id || null;
  await loadPreferences();
  await refreshState();
}

injectSelectedHooksButton.addEventListener("click", async () => {
  const categories = [...state.selectedCategories];
  if (!categories.length) {
    statusText.textContent = "请至少选择一个 Hook 分类。";
    return;
  }

  injectSelectedHooksButton.disabled = true;
  try {
    await request({
      type: "INJECT_HOOK_CATEGORIES",
      categories,
      options: {
        captureStack: captureStack.checked,
        keywords: getKeywordList()
      }
    });
    await refreshState();
  } finally {
    injectSelectedHooksButton.disabled = false;
  }
});

removeHooksButton.addEventListener("click", async () => {
  removeHooksButton.disabled = true;
  try {
    await request({ type: "UNINSTALL_HOOKS" });
    await refreshState();
  } finally {
    removeHooksButton.disabled = false;
  }
});

clearLogsButton.addEventListener("click", async () => {
  clearLogsButton.disabled = true;
  try {
    await request({ type: "CLEAR_TAB_LOGS" });
    state.logs = [];
    scheduleRenderLogs();
  } finally {
    clearLogsButton.disabled = false;
  }
});

runCustomHookButton.addEventListener("click", async () => {
  runCustomHookButton.disabled = true;
  try {
    await savePreferences();
    await request({ type: "RUN_CUSTOM_HOOK", code: customCode.value });
    await refreshState();
  } finally {
    runCustomHookButton.disabled = false;
  }
});

customCode.addEventListener("input", () => {
  savePreferences().catch(() => {});
});

logSearch.addEventListener("input", () => {
  state.logQuery = logSearch.value;
  savePreferences().catch(() => {});
  scheduleRenderLogs();
});

keywordInput.addEventListener("input", () => {
  state.keywordText = keywordInput.value;
  savePreferences().catch(() => {});
});

keywordMode.addEventListener("change", () => {
  state.keywordMode = keywordMode.value;
  savePreferences().catch(() => {});
});

categoryGrid.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") {
    return;
  }

  if (target.checked) {
    state.selectedCategories.add(target.value);
  } else {
    state.selectedCategories.delete(target.value);
  }

  savePreferences().catch(() => {});
});

document.querySelectorAll("[data-template]").forEach((button) => {
  button.addEventListener("click", () => {
    const templateName = button.getAttribute("data-template");
    customCode.value = templates[templateName] || templates.atob;
    savePreferences().catch(() => {});
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== state.activeTabId) {
    return;
  }

  if (message.type === "LOG_UPDATE") {
    state.logs = message.logs || [];
    scheduleRenderLogs();
    return;
  }

  if (message.type === "STATUS_UPDATE") {
    state.status = message.status || null;
    renderStatus();
  }
});

init().catch((error) => {
  pageTitle.textContent = "初始化失败";
  statusText.textContent = error.message;
  activeCategories.innerHTML = '<span class="tag muted-tag">初始化失败</span>';
  removeHooksButton.disabled = true;
});
