const LOG_LIMIT = 250;
const LOGS_KEY = "tabLogs";
const STATUS_KEY = "tabStatus";
const CONFIG_KEY = "tabHookConfig";
const XHR_MATCH_WINDOW_MS = 4000;
const XHR_TRACK_TTL_MS = 15000;
const xhrTrackingState = new Map();

function normalizeKeywordRules(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[\n,]+/);
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))]
    .slice(0, 30)
    .map((rawKeyword) => {
      const match = rawKeyword.match(/^(exact-key|exact-value|exact|key|value):(.*)$/i);
      const mode = (match ? match[1] : "contains").toLowerCase();
      const keyword = (match ? match[2] : rawKeyword).trim();
      return {
        rawKeyword,
        keyword,
        normalized: keyword.toLowerCase(),
        scope: mode.endsWith("key") ? "key" : mode.endsWith("value") ? "value" : "all",
        exact: mode.startsWith("exact")
      };
    })
    .filter((rule) => Boolean(rule.keyword));
}

function collectSearchParts(value, keyParts, valueParts, depth = 0) {
  if (value === null || value === undefined || depth > 6) {
    return;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    valueParts.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectSearchParts(item, keyParts, valueParts, depth + 1));
    return;
  }

  if (typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => {
      keyParts.push(String(key));
      collectSearchParts(item, keyParts, valueParts, depth + 1);
    });
    return;
  }

  valueParts.push(String(value));
}

function matchesExactPart(parts, normalizedKeyword) {
  return parts.some((part) => {
    const text = String(part || "").toLowerCase();
    if (!text) {
      return false;
    }

    if (text === normalizedKeyword) {
      return true;
    }

    const tokens = text.match(/[a-z0-9._-]+/gi) || [];
    return tokens.includes(normalizedKeyword);
  });
}

function collectKeywordMatches(rules, value) {
  if (!rules.length) {
    return [];
  }

  const keyParts = [];
  const valueParts = [];
  collectSearchParts(value, keyParts, valueParts);

  const keyText = keyParts.join("\n").toLowerCase();
  const valueText = valueParts.join("\n").toLowerCase();
  if (!keyText && !valueText) {
    return [];
  }

  return rules
    .filter((rule) => {
      const matchKey = rule.exact ? matchesExactPart(keyParts, rule.normalized) : keyText.includes(rule.normalized);
      const matchValue = rule.exact ? matchesExactPart(valueParts, rule.normalized) : valueText.includes(rule.normalized);

      if (rule.scope === "key") {
        return matchKey;
      }

      if (rule.scope === "value") {
        return matchValue;
      }

      return matchKey || matchValue;
    })
    .map((rule) => rule.rawKeyword);
}

function buildKeywordSearchPayload(sourceEntry) {
  const details = sourceEntry?.details || {};
  const summary = details.summary || {};
  const request = details.request || {};
  const response = details.response || {};

  return {
    label: sourceEntry?.label,
    category: sourceEntry?.category,
    pageUrl: sourceEntry?.pageUrl,
    phase: details.phase,
    summary,
    header: details.header,
    request,
    requestHeaders: request.headers,
    scriptHeaders: request.scriptHeaders,
    requestBody: request.body,
    response,
    responseHeaders: response.headers,
    responseBody: response.bodyPreview,
    url: summary.url || request.url || response.url,
    method: summary.method || request.method,
    stack: sourceEntry?.stack
  };
}

function buildKeywordSignature(details = {}) {
  const summary = details.summary || {};
  const matchedKeywords = Array.isArray(details.matchedKeywords) ? [...details.matchedKeywords].sort().join("|") : "";
  return [
    details.sourceCategory || "",
    details.sourceLabel || "",
    details.phase || "",
    summary.requestId ?? "",
    summary.method || "",
    summary.url || "",
    matchedKeywords
  ].join("::");
}

function isSameKeywordHit(entry, candidate) {
  if (entry?.category !== "keyword" || candidate?.category !== "keyword") {
    return false;
  }

  return buildKeywordSignature(entry.details || {}) === buildKeywordSignature(candidate.details || {});
}

function buildKeywordHitEntry(sourceEntry, matchedKeywords) {
  const sourceDetails = sourceEntry.details || {};
  const sourceSummary = sourceDetails.summary || {};

  return {
    category: "keyword",
    level: "info",
    label: "keyword hit",
    details: {
      matchedKeywords,
      sourceCategory: sourceEntry.category,
      sourceLabel: sourceEntry.label,
      phase: sourceDetails.phase,
      summary: sourceSummary,
      header: sourceDetails.header,
      request: sourceDetails.request,
      response: sourceDetails.response,
      sourceDetails,
      preview: JSON.stringify(sourceDetails).slice(0, 600)
    },
    stack: sourceEntry.stack,
    pageUrl: sourceEntry.pageUrl,
    ts: Date.now(),
    recordedAt: Date.now()
  };
}

async function notifyBackgroundHookEvent(tabId, payload) {
  chrome.tabs.sendMessage(tabId, { type: "BACKGROUND_HOOK_EVENT", payload }).catch(() => {});
}

async function maybeAppendKeywordHit(tabId, sourceEntry, logs) {
  if (!sourceEntry || sourceEntry.category === "keyword") {
    return { logs, entry: null };
  }

  const tabConfig = await getBucket(CONFIG_KEY);
  const config = tabConfig[tabId] || null;
  const categories = Array.isArray(config?.categories) ? config.categories : [];
  if (!categories.includes("keyword")) {
    return { logs, entry: null };
  }

  const rules = normalizeKeywordRules(config?.options?.keywords);
  const matchedKeywords = [...new Set(collectKeywordMatches(rules, buildKeywordSearchPayload(sourceEntry)))];

  if (!matchedKeywords.length) {
    return { logs, entry: null };
  }

  const keywordEntry = buildKeywordHitEntry(sourceEntry, matchedKeywords);
  if (logs.some((entry) => isSameKeywordHit(entry, keywordEntry))) {
    return { logs, entry: null };
  }

  const nextLogs = [...logs, keywordEntry].slice(-LOG_LIMIT);
  return { logs: nextLogs, entry: keywordEntry };
}

function getXhrTabState(tabId) {
  if (!xhrTrackingState.has(tabId)) {
    xhrTrackingState.set(tabId, {
      pendingPageRequests: [],
      pendingNetworkRequests: [],
      resolvedHeaders: new Map()
    });
  }

  return xhrTrackingState.get(tabId);
}

function pruneXhrTabState(tabId) {
  const state = xhrTrackingState.get(tabId);
  if (!state) {
    return;
  }

  const cutoff = Date.now() - XHR_TRACK_TTL_MS;
  state.pendingPageRequests = state.pendingPageRequests.filter((entry) => entry.timestamp >= cutoff);
  state.pendingNetworkRequests = state.pendingNetworkRequests.filter((entry) => entry.timestamp >= cutoff);

  for (const [pageRequestId, entry] of state.resolvedHeaders.entries()) {
    if (entry.matchedAt < cutoff) {
      state.resolvedHeaders.delete(pageRequestId);
    }
  }
}

function appendHeaderValue(headers, key, value) {
  if (headers[key] === undefined) {
    headers[key] = value;
    return headers;
  }

  if (Array.isArray(headers[key])) {
    headers[key].push(value);
    return headers;
  }

  headers[key] = [headers[key], value];
  return headers;
}

function normalizeRequestHeaders(requestHeaders = []) {
  return requestHeaders.reduce((output, header) => {
    if (!header?.name) {
      return output;
    }

    appendHeaderValue(output, header.name, header.value ?? "");
    return output;
  }, {});
}

function cloneHeaders(headers) {
  return JSON.parse(JSON.stringify(headers || {}));
}

function getEntryRequestId(entry) {
  return entry?.details?.summary?.requestId;
}

function getResolvedHeaders(tabId, pageRequestId) {
  const state = xhrTrackingState.get(tabId);
  if (!state) {
    return null;
  }

  return state.resolvedHeaders.get(pageRequestId)?.headers || null;
}

function mergeXhrHeadersIntoEntry(entry, requestHeaders) {
  if (entry?.category !== "xhr") {
    return entry;
  }

  const pageRequestId = getEntryRequestId(entry);
  if (pageRequestId === undefined) {
    return entry;
  }

  const details = entry.details || {};
  const request = { ...(details.request || {}) };
  const existingHeaders = request.headers || {};
  const nextHeaders = cloneHeaders(requestHeaders);
  const existingHeadersJson = JSON.stringify(existingHeaders);
  const nextHeadersJson = JSON.stringify(nextHeaders);

  request.headers = nextHeaders;
  request.headerSource = "webRequest";

  if (existingHeadersJson && existingHeadersJson !== "{}" && existingHeadersJson !== nextHeadersJson) {
    request.scriptHeaders = existingHeaders;
  }

  return {
    ...entry,
    details: {
      ...details,
      summary: {
        ...(details.summary || {}),
        requestId: pageRequestId,
        requestHeaderSource: "webRequest"
      },
      request
    }
  };
}

function findBestMatchIndex(candidates, target) {
  let bestIndex = -1;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate.method !== target.method || candidate.url !== target.url) {
      continue;
    }

    const delta = Math.abs(candidate.timestamp - target.timestamp);
    if (delta > XHR_MATCH_WINDOW_MS || delta >= bestDelta) {
      continue;
    }

    bestIndex = index;
    bestDelta = delta;
  }

  return bestIndex;
}

async function notifyLogUpdate(tabId, logs, entry = null) {
  chrome.runtime.sendMessage({ type: "LOG_UPDATE", tabId, entry, logs }).catch(() => {});
}

async function notifyCapturedXhrHeaders(tabId, pageRequestId, requestHeaders, meta = {}) {
  chrome.tabs.sendMessage(tabId, {
    type: "XHR_NETWORK_HEADERS_CAPTURED",
    requestId: pageRequestId,
    method: meta.method,
    url: meta.url,
    headers: requestHeaders
  }).catch(() => {});
}

async function applyResolvedHeadersToStoredLogs(tabId, pageRequestId, requestHeaders, meta = {}) {
  const tabLogs = await getBucket(LOGS_KEY);
  const currentLogs = tabLogs[tabId] || [];
  let changed = false;
  let matchedEntry = null;

  const nextLogs = currentLogs.map((entry) => {
    if (entry?.category !== "xhr" || getEntryRequestId(entry) !== pageRequestId) {
      return entry;
    }

    changed = true;
    matchedEntry = mergeXhrHeadersIntoEntry(entry, requestHeaders);
    return matchedEntry;
  });

  if (!changed) {
    return;
  }

  const keywordResult = await maybeAppendKeywordHit(tabId, matchedEntry, nextLogs);
  tabLogs[tabId] = keywordResult.logs;
  await setBucket(LOGS_KEY, tabLogs);
  await Promise.all([
    notifyLogUpdate(tabId, keywordResult.logs),
    notifyCapturedXhrHeaders(tabId, pageRequestId, requestHeaders, meta),
    keywordResult.entry ? notifyBackgroundHookEvent(tabId, keywordResult.entry) : Promise.resolve()
  ]);
}

async function recordResolvedHeaders(tabId, pageRequestId, requestHeaders, meta = {}) {
  const state = getXhrTabState(tabId);
  pruneXhrTabState(tabId);
  state.resolvedHeaders.set(pageRequestId, {
    headers: cloneHeaders(requestHeaders),
    matchedAt: Date.now()
  });
  await applyResolvedHeadersToStoredLogs(tabId, pageRequestId, requestHeaders, meta);
}

function trackPendingPageRequest(tabId, entry) {
  const pageRequestId = getEntryRequestId(entry);
  if (pageRequestId === undefined || entry?.details?.phase !== "request") {
    return null;
  }

  const state = getXhrTabState(tabId);
  pruneXhrTabState(tabId);
  state.pendingPageRequests = state.pendingPageRequests.filter((item) => item.pageRequestId !== pageRequestId);

  const requestMeta = {
    pageRequestId,
    method: entry.details?.summary?.method || entry.details?.request?.method || "GET",
    url: entry.details?.summary?.url || entry.details?.request?.url || "",
    timestamp: entry.ts || entry.recordedAt || Date.now(),
    sourceEntry: entry.internal ? entry : null
  };

  const matchIndex = findBestMatchIndex(state.pendingNetworkRequests, requestMeta);
  if (matchIndex >= 0) {
    const [matchedRequest] = state.pendingNetworkRequests.splice(matchIndex, 1);
    state.resolvedHeaders.set(pageRequestId, {
      headers: cloneHeaders(matchedRequest.requestHeaders),
      matchedAt: Date.now()
    });
    return {
      headers: matchedRequest.requestHeaders,
      meta: {
        method: matchedRequest.method,
        url: matchedRequest.url
      }
    };
  }

  state.pendingPageRequests.push(requestMeta);
  return null;
}

async function captureNetworkXhrHeaders(details) {
  const tabId = details.tabId;
  if (tabId === undefined || tabId < 0) {
    return;
  }

  const state = getXhrTabState(tabId);
  pruneXhrTabState(tabId);

  const snapshot = {
    requestId: details.requestId,
    method: details.method,
    url: details.url,
    timestamp: details.timeStamp || Date.now(),
    requestHeaders: normalizeRequestHeaders(details.requestHeaders || [])
  };

  const matchIndex = findBestMatchIndex(state.pendingPageRequests, snapshot);
  if (matchIndex >= 0) {
    const [matchedPageRequest] = state.pendingPageRequests.splice(matchIndex, 1);
    if (matchedPageRequest.sourceEntry?.internal) {
      await appendKeywordHitForInternalSource(tabId, matchedPageRequest.sourceEntry, snapshot.requestHeaders);
    }
    await recordResolvedHeaders(tabId, matchedPageRequest.pageRequestId, snapshot.requestHeaders, {
      method: snapshot.method,
      url: snapshot.url
    });
    return;
  }

  const existingIndex = state.pendingNetworkRequests.findIndex((entry) => entry.requestId === snapshot.requestId);
  if (existingIndex >= 0) {
    state.pendingNetworkRequests[existingIndex] = snapshot;
    return;
  }

  state.pendingNetworkRequests.push(snapshot);
}

async function getBucket(key) {
  const result = await chrome.storage.session.get(key);
  return result[key] || {};
}

async function setBucket(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

async function appendLog(tabId, entry) {
  let nextEntry = entry;
  let shouldNotifyCapturedHeaders = false;
  const pageRequestId = getEntryRequestId(entry);
  const resolvedHeaders = pageRequestId === undefined ? null : getResolvedHeaders(tabId, pageRequestId);

  if (resolvedHeaders) {
    nextEntry = mergeXhrHeadersIntoEntry(entry, resolvedHeaders);
    shouldNotifyCapturedHeaders = entry?.category === "xhr" && entry?.details?.phase === "request";
  } else if (entry?.category === "xhr") {
    const match = trackPendingPageRequest(tabId, entry);
    if (match?.headers) {
      nextEntry = mergeXhrHeadersIntoEntry(entry, match.headers);
      shouldNotifyCapturedHeaders = entry?.details?.phase === "request";
    }
  }

  const tabLogs = await getBucket(LOGS_KEY);
  const currentLogs = tabLogs[tabId] || [];
  const baseLogs = entry.internal ? currentLogs : [...currentLogs, nextEntry].slice(-LOG_LIMIT);
  const keywordResult = await maybeAppendKeywordHit(tabId, nextEntry, baseLogs);
  const shouldPersistLogs = !entry.internal || Boolean(keywordResult.entry);

  if (shouldPersistLogs) {
    tabLogs[tabId] = keywordResult.logs;
    await setBucket(LOGS_KEY, tabLogs);
    await notifyLogUpdate(tabId, keywordResult.logs, entry.internal ? keywordResult.entry : nextEntry);
  }

  if (!entry.internal && shouldNotifyCapturedHeaders && pageRequestId !== undefined) {
    await notifyCapturedXhrHeaders(tabId, pageRequestId, nextEntry.details?.request?.headers || {}, {
      method: nextEntry.details?.summary?.method,
      url: nextEntry.details?.summary?.url
    });
  }

  if (keywordResult.entry) {
    await notifyBackgroundHookEvent(tabId, keywordResult.entry);
  }
}

async function appendKeywordHitForInternalSource(tabId, sourceEntry, requestHeaders) {
  const enrichedEntry = mergeXhrHeadersIntoEntry(sourceEntry, requestHeaders);
  const tabLogs = await getBucket(LOGS_KEY);
  const currentLogs = tabLogs[tabId] || [];
  const keywordResult = await maybeAppendKeywordHit(tabId, enrichedEntry, currentLogs);

  if (!keywordResult.entry) {
    return;
  }

  tabLogs[tabId] = keywordResult.logs;
  await setBucket(LOGS_KEY, tabLogs);
  await Promise.all([
    notifyLogUpdate(tabId, keywordResult.logs, keywordResult.entry),
    notifyBackgroundHookEvent(tabId, keywordResult.entry)
  ]);
}

async function updateStatus(tabId, status) {
  const tabStatus = await getBucket(STATUS_KEY);
  tabStatus[tabId] = {
    ...tabStatus[tabId],
    ...status,
    updatedAt: Date.now()
  };
  await setBucket(STATUS_KEY, tabStatus);
  chrome.runtime.sendMessage({ type: "STATUS_UPDATE", tabId, status: tabStatus[tabId] }).catch(() => {});
}

async function clearLogs(tabId) {
  const tabLogs = await getBucket(LOGS_KEY);
  tabLogs[tabId] = [];
  await setBucket(LOGS_KEY, tabLogs);
  chrome.runtime.sendMessage({ type: "LOG_UPDATE", tabId, entry: null, logs: [] }).catch(() => {});
}

async function getState(tabId) {
  const [tabLogs, tabStatus, tabConfig] = await Promise.all([getBucket(LOGS_KEY), getBucket(STATUS_KEY), getBucket(CONFIG_KEY)]);
  return {
    logs: tabLogs[tabId] || [],
    status: tabStatus[tabId] || null,
    config: tabConfig[tabId] || null
  };
}

async function saveHookConfig(tabId, config) {
  const tabConfig = await getBucket(CONFIG_KEY);
  tabConfig[tabId] = config;
  await setBucket(CONFIG_KEY, tabConfig);
}

async function clearHookConfig(tabId) {
  const tabConfig = await getBucket(CONFIG_KEY);
  delete tabConfig[tabId];
  await setBucket(CONFIG_KEY, tabConfig);
}

async function sendCommandToTab(tabId, payload) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, payload);
    return { ok: true, response };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || sender.tab?.id;

  if (message.type === "HOOK_EVENT" && tabId) {
    appendLog(tabId, {
      ...message.payload,
      recordedAt: Date.now()
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "HOOK_STATUS" && tabId) {
    updateStatus(tabId, message.payload).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "GET_TAB_STATE" && tabId) {
    getState(tabId).then((state) => sendResponse({ ok: true, ...state }));
    return true;
  }

  if (message.type === "CLEAR_TAB_LOGS" && tabId) {
    clearLogs(tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "GET_AUTO_HOOK_CONFIG" && tabId) {
    getBucket(CONFIG_KEY).then((tabConfig) => {
      sendResponse({ ok: true, config: tabConfig[tabId] || null });
    });
    return true;
  }

  if (message.type === "INJECT_HOOK_CATEGORIES" && tabId) {
    const config = {
      categories: message.categories || [],
      options: message.options || {}
    };

    saveHookConfig(tabId, config)
      .then(() =>
        sendCommandToTab(tabId, {
          type: "INJECT_HOOK_CATEGORIES",
          categories: config.categories,
          options: config.options
        })
      )
      .then(sendResponse);
    return true;
  }

  if (message.type === "INJECT_BASE_HOOKS" && tabId) {
    sendCommandToTab(tabId, {
      type: "INJECT_BASE_HOOKS",
      options: message.options || {}
    }).then(sendResponse);
    return true;
  }

  if (message.type === "UNINSTALL_HOOKS" && tabId) {
    clearHookConfig(tabId)
      .then(() =>
        sendCommandToTab(tabId, {
          type: "UNINSTALL_HOOKS"
        })
      )
      .then(sendResponse);
    return true;
  }

  if (message.type === "RUN_CUSTOM_HOOK" && tabId) {
    sendCommandToTab(tabId, {
      type: "RUN_CUSTOM_HOOK",
      code: message.code || ""
    }).then(sendResponse);
    return true;
  }

  if (message.type === "PING_TAB" && tabId) {
    sendCommandToTab(tabId, { type: "PING_TAB" }).then(sendResponse);
    return true;
  }

  sendResponse({ ok: false, error: "Unhandled message" });
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const [tabLogs, tabStatus, tabConfig] = await Promise.all([getBucket(LOGS_KEY), getBucket(STATUS_KEY), getBucket(CONFIG_KEY)]);
  delete tabLogs[tabId];
  delete tabStatus[tabId];
  delete tabConfig[tabId];
  xhrTrackingState.delete(tabId);
  await Promise.all([setBucket(LOGS_KEY, tabLogs), setBucket(STATUS_KEY, tabStatus), setBucket(CONFIG_KEY, tabConfig)]);
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    captureNetworkXhrHeaders(details).catch(() => {});
  },
  {
    urls: ["<all_urls>"],
    types: ["xmlhttprequest"]
  },
  ["requestHeaders", "extraHeaders"]
);
