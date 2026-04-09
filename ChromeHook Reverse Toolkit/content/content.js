const BRIDGE_SOURCE = "chrome-hook-bridge";
const EXTENSION_SOURCE = "chrome-hook-extension";
const BRIDGE_SCRIPT_ID = "__chrome_hook_bridge__";
const ALL_HOOK_CATEGORIES = ["fetch", "xhr", "cookie", "storage", "json", "eval", "timer", "keyword"];

let bridgeReady = false;
let bridgeWaiters = [];
let autoConfigApplied = false;

function flushBridgeWaiters() {
  bridgeWaiters.forEach((resolve) => resolve());
  bridgeWaiters = [];
}

function markBridgeReady() {
  bridgeReady = true;
  flushBridgeWaiters();
}

function waitForBridge(timeoutMs = 600) {
  if (bridgeReady) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(resolve, timeoutMs);
    bridgeWaiters.push(() => {
      window.clearTimeout(timeoutId);
      resolve();
    });
  });
}

function injectBridgeScript() {
  if (document.getElementById(BRIDGE_SCRIPT_ID)) {
    return;
  }

  const script = document.createElement("script");
  script.id = BRIDGE_SCRIPT_ID;
  script.src = chrome.runtime.getURL("inject/injected-hook.js");
  script.async = false;

  const target = document.head || document.documentElement;
  if (target) {
    target.prepend(script);
  } else {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        (document.head || document.documentElement || document.body).prepend(script);
      },
      { once: true }
    );
  }
}

async function ensureBridge() {
  injectBridgeScript();
  await waitForBridge();
}

function postToPage(type, payload = {}) {
  window.postMessage({ source: EXTENSION_SOURCE, type, ...payload }, "*");
}

function toHeaderRows(headers) {
  return Object.entries(headers || {}).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      return value.map((item) => ({ key, value: item }));
    }
    return [{ key, value }];
  });
}

function logConsoleHeaders(title, headers) {
  const headerRows = toHeaderRows(headers);
  if (!headerRows.length) {
    return;
  }

  console.info(`${title}:`);
  console.table(headerRows);
}

function logConsoleNetworkDetails(details) {
  const request = details.request || {};
  const response = details.response || {};
  const header = details.header || null;

  if (header) {
    console.info("header:", header);
  }

  if (request.url || request.method || request.body !== undefined) {
    const requestSnapshot = { ...request };
    delete requestSnapshot.headers;
    delete requestSnapshot.scriptHeaders;
    console.info("request:", requestSnapshot);
  }

  logConsoleHeaders("request headers", request.headers);
  logConsoleHeaders("script-set headers", request.scriptHeaders);

  if (response.status !== undefined || response.url || response.bodyPreview !== undefined || Object.keys(response).length) {
    const responseSnapshot = { ...response };
    delete responseSnapshot.headers;
    console.info("response:", responseSnapshot);
  }

  logConsoleHeaders("response headers", response.headers);
}

function logStructuredConsole(payload) {
  const category = payload.category || "custom";
  const details = payload.details || {};

  if (category === "fetch") {
    const summary = details.summary || {};
    const request = details.request || {};
    const response = details.response || {};
    const phase = details.phase || "event";
    const titleParts = [`[ChromeHook][Fetch]`, phase.toUpperCase()];

    if (summary.method) {
      titleParts.push(summary.method);
    }
    if (summary.url) {
      titleParts.push(summary.url);
    }
    if (summary.status !== undefined) {
      titleParts.push(`status=${summary.status}`);
    }

    console.info(titleParts.join(" "));

    if (summary.requestId !== undefined) {
      console.info("requestId:", summary.requestId);
    }

    logConsoleNetworkDetails(details);

    if (payload.stack) {
      console.debug(payload.stack);
    }

    console.info("[ChromeHook] end");
    return;
  }

  if (category === "xhr") {
    const summary = details.summary || {};
    const request = details.request || {};
    const response = details.response || {};
    const header = details.header || null;
    const phase = details.phase || "event";
    const titleParts = [`[ChromeHook][XHR]`, phase.toUpperCase()];

    if (summary.method) {
      titleParts.push(summary.method);
    }
    if (summary.url) {
      titleParts.push(summary.url);
    }
    if (summary.status !== undefined) {
      titleParts.push(`status=${summary.status}`);
    }

    console.info(titleParts.join(" "));

    if (summary.requestId !== undefined) {
      console.info("requestId:", summary.requestId);
    }

    logConsoleNetworkDetails(details);

    if (payload.stack) {
      console.debug(payload.stack);
    }

    console.info("[ChromeHook] end");
    return;
  }

  if (category === "keyword") {
    const summary = details.summary || {};
    const matchedKeywords = Array.isArray(details.matchedKeywords) ? details.matchedKeywords : [];
    const phase = details.phase || "match";
    const sourceCategory = details.sourceCategory || "unknown";
    const titleParts = ["[ChromeHook][Keyword]", phase.toUpperCase()];

    if (matchedKeywords.length) {
      titleParts.push(`keywords=${matchedKeywords.join(",")}`);
    }

    titleParts.push(`source=${sourceCategory}`);

    if (summary.method) {
      titleParts.push(summary.method);
    }
    if (summary.url) {
      titleParts.push(summary.url);
    }
    if (summary.status !== undefined) {
      titleParts.push(`status=${summary.status}`);
    }

    console.info(titleParts.join(" "));
    console.info("matched keywords:", matchedKeywords);
    console.info("source:", {
      category: sourceCategory,
      label: details.sourceLabel,
      phase,
      summary
    });

    logConsoleNetworkDetails(details);

    if (details.sourceDetails && !details.request && !details.response && !details.header) {
      console.info("details:", details.sourceDetails);
    }

    if (payload.stack) {
      console.debug(payload.stack);
    }

    console.info("[ChromeHook] end");
    return;
  }

  console.info(`[ChromeHook][${category}] ${payload.label || "event"}`);
  console.info(details);
  if (payload.stack) {
    console.debug(payload.stack);
  }
  console.info("[ChromeHook] end");
}

function logObservedXhrHeaders(message) {
  const titleParts = ["[ChromeHook][XHR]", "NETWORK_HEADERS"];

  if (message.method) {
    titleParts.push(message.method);
  }

  if (message.url) {
    titleParts.push(message.url);
  }

  console.info(titleParts.join(" "));

  if (message.requestId !== undefined) {
    console.info("requestId:", message.requestId);
  }

  const requestHeaderRows = toHeaderRows(message.headers);
  if (requestHeaderRows.length) {
    console.table(requestHeaderRows);
  }

  console.info("[ChromeHook] end");
}

async function applyAutoConfig() {
  if (autoConfigApplied) {
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "GET_AUTO_HOOK_CONFIG" }).catch(() => null);
  const config = response?.config;
  if (!config?.categories?.length) {
    autoConfigApplied = true;
    return;
  }

  await ensureBridge();
  postToPage("INSTALL_HOOK_CATEGORIES", {
    categories: config.categories,
    options: config.options || {}
  });
  autoConfigApplied = true;
}

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || data.source !== BRIDGE_SOURCE) {
    return;
  }

  if (data.type === "HOOK_STATUS" && data.payload?.kind === "bridge-ready") {
    markBridgeReady();
    applyAutoConfig().catch(() => {});
  }

  if (data.type === "HOOK_EVENT") {
    const payload = data.payload || {};
    if (!payload.internal) {
      logStructuredConsole(payload);
    }
    chrome.runtime.sendMessage({ type: "HOOK_EVENT", payload }).catch(() => {});
    return;
  }

  if (data.type === "HOOK_STATUS") {
    chrome.runtime.sendMessage({ type: "HOOK_STATUS", payload: data.payload || {} }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "BACKGROUND_HOOK_EVENT") {
    logStructuredConsole(message.payload || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "XHR_NETWORK_HEADERS_CAPTURED") {
    logObservedXhrHeaders(message);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "PING_TAB") {
    ensureBridge().then(() => sendResponse({ ok: true, bridgeReady }));
    return true;
  }

  if (message.type === "INJECT_BASE_HOOKS") {
    ensureBridge().then(() => {
      postToPage("INSTALL_HOOK_CATEGORIES", {
        categories: ALL_HOOK_CATEGORIES,
        options: message.options || {}
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "INJECT_HOOK_CATEGORIES") {
    ensureBridge().then(() => {
      postToPage("INSTALL_HOOK_CATEGORIES", {
        categories: message.categories || [],
        options: message.options || {}
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "RUN_CUSTOM_HOOK") {
    ensureBridge().then(() => {
      postToPage("RUN_CUSTOM_HOOK", { code: message.code || "" });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "UNINSTALL_HOOKS") {
    ensureBridge().then(() => {
      postToPage("UNINSTALL_HOOKS");
      sendResponse({ ok: true });
    });
    return true;
  }

  sendResponse({ ok: false, error: "Unsupported command" });
  return false;
});

injectBridgeScript();
applyAutoConfig().catch(() => {});
