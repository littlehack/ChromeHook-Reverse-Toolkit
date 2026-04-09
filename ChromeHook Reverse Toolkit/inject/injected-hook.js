(() => {
  const BRIDGE_SOURCE = "chrome-hook-bridge";
  const EXTENSION_SOURCE = "chrome-hook-extension";
  const WRAPPED_MARK = Symbol("chromeHookWrapped");
  const ALL_HOOK_CATEGORIES = ["fetch", "xhr", "cookie", "storage", "json", "eval", "timer", "keyword"];
  const hookRegistry = [];
  const MAX_SERIALIZE_DEPTH = 4;
  let requestCounter = 0;

  if (window.__CHROME_HOOK__) {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: "HOOK_STATUS",
        payload: {
          kind: "bridge-ready",
          installed: window.__CHROME_HOOK__.state.hookCount > 0,
          hookCount: window.__CHROME_HOOK__.state.hookCount,
          installedCategories: window.__CHROME_HOOK__.state.installedCategories || [],
          pageUrl: location.href
        }
      },
      "*"
    );
    return;
  }

  const state = {
    hookCount: 0,
    installedCategories: [],
    captureStack: false,
    keywordRules: [],
    pageUrl: location.href
  };

  function syncHookState() {
    state.hookCount = hookRegistry.length;
    state.installedCategories = [...new Set(hookRegistry.map((entry) => entry.category))].sort();
    return {
      hookCount: state.hookCount,
      installedCategories: [...state.installedCategories]
    };
  }

  function isInstalled() {
    return syncHookState().hookCount > 0;
  }

  function sliceText(value, maxLength = 320) {
    if (typeof value !== "string") {
      return value;
    }
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
  }

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

  function stringifyKeywordSource(value) {
    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    try {
      return JSON.stringify(serialize(value));
    } catch (_error) {
      return String(value);
    }
  }

  function collectSearchParts(value, keyParts, valueParts, depth = 0) {
    if (value === null || value === undefined || depth > MAX_SERIALIZE_DEPTH) {
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

  function collectKeywordMatches(value) {
    if (!state.keywordRules.length) {
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

    return state.keywordRules
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

  function buildKeywordSearchPayload(label, details, category) {
    const summary = details?.summary || {};
    const request = details?.request || {};
    const response = details?.response || {};

    return {
      label,
      category,
      pageUrl: state.pageUrl,
      phase: details?.phase,
      summary,
      header: details?.header,
      request,
      requestHeaders: request.headers,
      scriptHeaders: request.scriptHeaders,
      requestBody: request.body,
      response,
      responseHeaders: response.headers,
      responseBody: response.bodyPreview,
      url: summary.url || request.url || response.url,
      method: summary.method || request.method
    };
  }

  function maybeEmitKeywordHit(label, details, category, stack) {
    if (category === "keyword" || !state.keywordRules.length || !state.installedCategories.includes("keyword")) {
      return;
    }

    const matchedKeywords = [...new Set(collectKeywordMatches(buildKeywordSearchPayload(label, details, category)))];
    if (!matchedKeywords.length) {
      return;
    }

    const serializedDetails = serialize(details);

    emit("HOOK_EVENT", {
      category: "keyword",
      level: "info",
      label: "keyword hit",
      details: {
        matchedKeywords,
        sourceCategory: category,
        sourceLabel: label,
        phase: serializedDetails.phase,
        summary: serializedDetails.summary,
        header: serializedDetails.header,
        request: serializedDetails.request,
        response: serializedDetails.response,
        sourceDetails: serializedDetails,
        preview: sliceText(stringifyKeywordSource(details), 600)
      },
      stack,
      pageUrl: state.pageUrl,
      ts: Date.now()
    });
  }

  function serializeHeaders(headers) {
    if (!headers) {
      return {};
    }

    if (headers instanceof Headers) {
      const output = {};
      headers.forEach((value, key) => {
        output[key] = value;
      });
      return output;
    }

    if (Array.isArray(headers)) {
      return Object.fromEntries(headers);
    }

    if (typeof headers === "object") {
      return Object.keys(headers).reduce((output, key) => {
        output[key] = headers[key];
        return output;
      }, {});
    }

    return { raw: String(headers) };
  }

  function parseRawHeaders(rawHeaders) {
    if (!rawHeaders) {
      return {};
    }

    return rawHeaders
      .trim()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .reduce((headers, line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) {
          return headers;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        if (!key) {
          return headers;
        }

        if (headers[key] === undefined) {
          headers[key] = value;
        } else if (Array.isArray(headers[key])) {
          headers[key].push(value);
        } else {
          headers[key] = [headers[key], value];
        }

        return headers;
      }, {});
  }

  function appendHeader(headers, key, value) {
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

  function serializeFormData(formData) {
    const output = {};
    formData.forEach((value, key) => {
      const serializedValue = value instanceof File
        ? { name: value.name, type: value.type, size: value.size }
        : String(value);
      appendHeader(output, key, serializedValue);
    });
    return output;
  }

  function serializeBinary(value) {
    if (value instanceof Blob) {
      return {
        type: "Blob",
        mimeType: value.type,
        size: value.size
      };
    }

    if (value instanceof ArrayBuffer) {
      return {
        type: "ArrayBuffer",
        byteLength: value.byteLength
      };
    }

    if (ArrayBuffer.isView(value)) {
      return {
        type: value.constructor.name,
        byteLength: value.byteLength,
        byteOffset: value.byteOffset
      };
    }

    return null;
  }

  function serializeBody(value) {
    if (value === undefined || value === null) {
      return value;
    }

    if (typeof value === "string") {
      return sliceText(value, 600);
    }

    if (value instanceof URLSearchParams) {
      return {
        type: "URLSearchParams",
        value: value.toString()
      };
    }

    if (value instanceof FormData) {
      return {
        type: "FormData",
        fields: serializeFormData(value)
      };
    }

    const binary = serializeBinary(value);
    if (binary) {
      return binary;
    }

    return serialize(value);
  }

  function buildSummary(meta, extra = {}) {
    return {
      requestId: meta.requestId,
      method: meta.method,
      url: meta.url,
      ...extra
    };
  }

  function buildRequestSnapshot(meta, body) {
    return {
      method: meta.method,
      url: meta.url,
      headers: serializeHeaders(meta.requestHeaders || {}),
      body: serializeBody(body)
    };
  }

  function getXhrResponsePreview(xhr) {
    try {
      if (xhr.responseType === "" || xhr.responseType === "text") {
        return sliceText(xhr.responseText || "", 600);
      }

      if (xhr.responseType === "json") {
        return serialize(xhr.response);
      }

      return serializeBody(xhr.response);
    } catch (_error) {
      return "[unavailable]";
    }
  }

  function getFetchRequestMeta(args) {
    const [resource, init = {}] = args;
    const request = resource instanceof Request ? resource : null;
    const method = init.method || request?.method || "GET";
    const url = request?.url || String(resource);
    const headers = init.headers || request?.headers || {};
    const body = init.body;

    return {
      method,
      url,
      requestHeaders: serializeHeaders(headers),
      body: serializeBody(body)
    };
  }

  function serialize(value, depth = 0) {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return sliceText(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "function") {
      return `[Function ${value.name || "anonymous"}]`;
    }

    if (depth > MAX_SERIALIZE_DEPTH) {
      return "[DepthLimited]";
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: sliceText(value.stack || "", 600)
      };
    }

    if (value instanceof Headers) {
      return serializeHeaders(value);
    }

    if (value instanceof Request) {
      return {
        type: "Request",
        method: value.method,
        url: value.url,
        headers: serializeHeaders(value.headers),
        mode: value.mode,
        credentials: value.credentials
      };
    }

    if (value instanceof Response) {
      return {
        type: "Response",
        url: value.url,
        status: value.status,
        redirected: value.redirected,
        ok: value.ok,
        typeName: value.type
      };
    }

    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => serialize(item, depth + 1));
    }

    if (value instanceof HTMLElement) {
      return `<${value.tagName.toLowerCase()} id=\"${value.id || ""}\" class=\"${value.className || ""}\">`;
    }

    if (value instanceof Storage) {
      return {
        type: value === localStorage ? "localStorage" : "sessionStorage",
        length: value.length
      };
    }

    if (typeof value === "object") {
      const output = {};
      Object.keys(value)
        .slice(0, 20)
        .forEach((key) => {
          output[key] = serialize(value[key], depth + 1);
        });
      return output;
    }

    return String(value);
  }

  function captureStack() {
    const rawStack = new Error().stack || "";
    const filteredStack = rawStack
      .split("\n")
      .map((line) => line.trim())
      .slice(1)
      .filter(Boolean)
      .filter((line) => !line.includes("chrome-extension://"))
      .filter((line) => !line.includes("inject/injected-hook.js"))
      .filter((line) => !line.includes("captureStack"))
      .filter((line) => !line.includes("xhrSendHook"))
      .join("\n");

    return filteredStack ? sliceText(filteredStack, 1000) : undefined;
  }

  function findPropertyDescriptor(target, key) {
    let current = target;

    while (current) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return { owner: current, descriptor };
      }
      current = Object.getPrototypeOf(current);
    }

    return null;
  }

  function emit(type, payload) {
    window.postMessage({ source: BRIDGE_SOURCE, type, payload }, "*");
  }

  function emitStatus(kind, extra = {}) {
    const snapshot = syncHookState();
    emit("HOOK_STATUS", {
      kind,
      installed: snapshot.hookCount > 0,
      hookCount: snapshot.hookCount,
      installedCategories: snapshot.installedCategories,
      captureStack: state.captureStack,
      pageUrl: state.pageUrl,
      updatedAt: Date.now(),
      ...extra
    });
  }

  function buildHookLogOptions(category, registryCategory, extra = {}) {
    const keywordMonitorMode = registryCategory === "keyword";
    return {
      category,
      internal: keywordMonitorMode,
      deferKeywordMatch: keywordMonitorMode,
      ...extra
    };
  }

  function log(level, label, details = {}, options = {}) {
    const category = options.category || "custom";
    const payload = {
      category,
      level,
      label,
      details: serialize(details),
      stack: options.stack || (state.captureStack ? captureStack() : undefined),
      internal: Boolean(options.internal),
      pageUrl: state.pageUrl,
      ts: Date.now()
    };
    emit("HOOK_EVENT", payload);
    if (!options.deferKeywordMatch) {
      maybeEmitKeywordHit(label, details, category, payload.stack);
    }
  }

  function patchMethod(target, key, wrapperName, category, createWrapper) {
    if (!target || typeof target[key] !== "function") {
      return false;
    }

    const original = target[key];
    if (original[WRAPPED_MARK]) {
      return false;
    }

    const wrapped = createWrapper(original);
    Object.defineProperty(wrapped, WRAPPED_MARK, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false
    });
    Object.defineProperty(wrapped, "__chromeHookName", {
      value: wrapperName,
      configurable: true
    });
    Object.defineProperty(wrapped, "__chromeHookOriginal", {
      value: original,
      configurable: true
    });

    target[key] = wrapped;
    hookRegistry.push({
      target,
      key,
      original,
      wrapperName,
      category,
      restore() {
        target[key] = original;
      }
    });
    syncHookState();
    return true;
  }

  function patchProperty(target, key, wrapperName, category, createDescriptor) {
    const located = findPropertyDescriptor(target, key);
    if (!located) {
      return false;
    }

    const { owner, descriptor: originalDescriptor } = located;
    if (originalDescriptor.get?.[WRAPPED_MARK] || originalDescriptor.set?.[WRAPPED_MARK]) {
      return false;
    }

    try {
      const nextDescriptor = createDescriptor(originalDescriptor);

      if (typeof nextDescriptor.get === "function") {
        Object.defineProperty(nextDescriptor.get, WRAPPED_MARK, {
          value: true,
          configurable: false,
          enumerable: false,
          writable: false
        });
      }

      if (typeof nextDescriptor.set === "function") {
        Object.defineProperty(nextDescriptor.set, WRAPPED_MARK, {
          value: true,
          configurable: false,
          enumerable: false,
          writable: false
        });
      }

      Object.defineProperty(owner, key, {
        configurable: originalDescriptor.configurable,
        enumerable: originalDescriptor.enumerable,
        ...nextDescriptor
      });
    } catch (_error) {
      return false;
    }

    hookRegistry.push({
      owner,
      key,
      wrapperName,
      category,
      restore() {
        Object.defineProperty(owner, key, originalDescriptor);
      }
    });
    syncHookState();
    return true;
  }

  function registerSyntheticHook(wrapperName, category) {
    if (hookRegistry.some((entry) => entry.wrapperName === wrapperName)) {
      return false;
    }

    hookRegistry.push({
      wrapperName,
      category,
      restore() {}
    });
    syncHookState();
    return true;
  }

  function unhookAll() {
    for (let index = hookRegistry.length - 1; index >= 0; index -= 1) {
      const entry = hookRegistry[index];
      entry.restore();
    }

    hookRegistry.length = 0;
    syncHookState();

    log("info", "all hooks removed", { url: state.pageUrl }, { category: "system" });
    emitStatus("hooks-cleared", { installed: false, installedCategories: [] });
  }

  function installFetchHook(registryCategory = "fetch") {
    patchMethod(window, "fetch", "fetch", registryCategory, (original) => async function fetchHook(...args) {
      const requestId = ++requestCounter;
      const requestMeta = getFetchRequestMeta(args);
      log(
        "info",
        "fetch request",
        {
          phase: "request",
          summary: {
            requestId,
            method: requestMeta.method,
            url: requestMeta.url
          },
          request: {
            method: requestMeta.method,
            url: requestMeta.url,
            headers: requestMeta.requestHeaders,
            body: requestMeta.body
          }
        },
        buildHookLogOptions("fetch", registryCategory)
      );
      try {
        const response = await original.apply(this, args);
        log(
          "info",
          "fetch response",
          {
            phase: "response",
            summary: {
              requestId,
              method: requestMeta.method,
              url: response.url || requestMeta.url,
              status: response.status
            },
            request: {
              method: requestMeta.method,
              url: requestMeta.url,
              headers: requestMeta.requestHeaders,
              body: requestMeta.body
            },
            response: {
              status: response.status,
              url: response.url,
              ok: response.ok,
              redirected: response.redirected,
              type: response.type,
              headers: serializeHeaders(response.headers)
            }
          },
          buildHookLogOptions("fetch", registryCategory)
        );
        return response;
      } catch (error) {
        log(
          "error",
          "fetch error",
          {
            phase: "error",
            summary: {
              requestId,
              method: requestMeta.method,
              url: requestMeta.url
            },
            request: {
              method: requestMeta.method,
              url: requestMeta.url,
              headers: requestMeta.requestHeaders,
              body: requestMeta.body
            },
            error: serialize(error)
          },
          buildHookLogOptions("fetch", registryCategory, { stack: captureStack() })
        );
        throw error;
      }
    });
  }

  function installXhrHook(registryCategory = "xhr") {
    patchMethod(XMLHttpRequest.prototype, "open", "xhr.open", registryCategory, (original) => function xhrOpenHook(method, url, ...rest) {
      this.__chromeHookMeta = {
        requestId: ++requestCounter,
        method,
        url,
        requestHeaders: {},
        openedAt: Date.now()
      };
      return original.call(this, method, url, ...rest);
    });

    patchMethod(
      XMLHttpRequest.prototype,
      "setRequestHeader",
      "xhr.setRequestHeader",
      registryCategory,
      (original) => function xhrSetRequestHeaderHook(name, value) {
        const meta = this.__chromeHookMeta || { requestHeaders: {} };
        meta.requestHeaders = meta.requestHeaders || {};
        appendHeader(meta.requestHeaders, name, value);
        this.__chromeHookMeta = meta;

        log(
          "info",
          "xhr setRequestHeader",
          {
            phase: "header",
            summary: buildSummary(meta),
            header: {
              key: name,
              value: serializeBody(value)
            }
          },
          buildHookLogOptions("xhr", registryCategory)
        );
        return original.call(this, name, value);
      }
    );

    patchMethod(XMLHttpRequest.prototype, "send", "xhr.send", registryCategory, (original) => function xhrSendHook(body) {
      const meta = this.__chromeHookMeta || {};
      meta.body = body;
      this.__chromeHookMeta = meta;
      log(
        "info",
        "xhr send",
        {
          phase: "request",
          summary: buildSummary(meta),
          request: buildRequestSnapshot(meta, body)
        },
        buildHookLogOptions("xhr", registryCategory)
      );

      this.addEventListener(
        "loadend",
        () => {
          const responseHeadersRaw = typeof this.getAllResponseHeaders === "function" ? this.getAllResponseHeaders() : "";
          log(
            "info",
            "xhr loadend",
            {
              phase: "response",
              summary: buildSummary(meta, { status: this.status }),
              request: buildRequestSnapshot(meta, meta.body),
              response: {
                status: this.status,
                url: this.responseURL || meta.url,
                type: this.responseType || "text",
                headers: parseRawHeaders(responseHeadersRaw),
                bodyPreview: getXhrResponsePreview(this)
              }
            },
            buildHookLogOptions("xhr", registryCategory)
          );
        },
        { once: true }
      );

      return original.call(this, body);
    });
  }

  function installStorageHook() {
    patchMethod(Storage.prototype, "getItem", "storage.getItem", "storage", (original) => function getItemHook(key) {
      const result = original.call(this, key);
      log(
        "info",
        "storage getItem",
        {
          storage: this === localStorage ? "localStorage" : "sessionStorage",
          key,
          result
        },
        { category: "storage" }
      );
      return result;
    });

    patchMethod(Storage.prototype, "setItem", "storage.setItem", "storage", (original) => function setItemHook(key, value) {
      log(
        "info",
        "storage setItem",
        {
          storage: this === localStorage ? "localStorage" : "sessionStorage",
          key,
          value
        },
        { category: "storage" }
      );
      return original.call(this, key, value);
    });
  }

  function installCookieHook(registryCategory = "cookie") {
    patchProperty(document, "cookie", "document.cookie", registryCategory, (originalDescriptor) => ({
      get() {
        const value = originalDescriptor.get ? originalDescriptor.get.call(this) : "";
        log("info", "document.cookie get", { action: "get", value }, buildHookLogOptions("cookie", registryCategory));
        return value;
      },
      set(value) {
        log("info", "document.cookie set", { action: "set", value }, buildHookLogOptions("cookie", registryCategory, { stack: captureStack() }));
        return originalDescriptor.set ? originalDescriptor.set.call(this, value) : value;
      }
    }));

    if (window.cookieStore) {
      patchMethod(window.cookieStore, "get", "cookieStore.get", registryCategory, (original) => async function cookieStoreGetHook(...args) {
        log("info", "cookieStore.get", { args }, buildHookLogOptions("cookie", registryCategory));
        const result = await original.apply(this, args);
        log("info", "cookieStore.get result", { result }, buildHookLogOptions("cookie", registryCategory));
        return result;
      });

      patchMethod(window.cookieStore, "set", "cookieStore.set", registryCategory, (original) => async function cookieStoreSetHook(...args) {
        log("info", "cookieStore.set", { args }, buildHookLogOptions("cookie", registryCategory, { stack: captureStack() }));
        return original.apply(this, args);
      });

      patchMethod(window.cookieStore, "delete", "cookieStore.delete", registryCategory, (original) => async function cookieStoreDeleteHook(...args) {
        log("info", "cookieStore.delete", { args }, buildHookLogOptions("cookie", registryCategory, { stack: captureStack() }));
        return original.apply(this, args);
      });
    }
  }

  function installJsonHook() {
    patchMethod(JSON, "parse", "json.parse", "json", (original) => function parseHook(text, reviver) {
      log("info", "JSON.parse", { text }, { category: "json" });
      const result = original.call(this, text, reviver);
      log("info", "JSON.parse result", { result }, { category: "json" });
      return result;
    });

    patchMethod(JSON, "stringify", "json.stringify", "json", (original) => function stringifyHook(value, replacer, space) {
      log("info", "JSON.stringify", { value }, { category: "json" });
      return original.call(this, value, replacer, space);
    });
  }

  function installEvalHook() {
    patchMethod(window, "eval", "window.eval", "eval", (original) => function evalHook(code) {
      log("warn", "window.eval", { code }, { category: "eval", stack: captureStack() });
      return original.call(this, code);
    });
  }

  function installTimerHook() {
    patchMethod(window, "setTimeout", "window.setTimeout", "timer", (original) => function setTimeoutHook(handler, timeout, ...rest) {
      log("info", "setTimeout", { handler, timeout }, { category: "timer" });
      return original.call(this, handler, timeout, ...rest);
    });

    patchMethod(window, "setInterval", "window.setInterval", "timer", (original) => function setIntervalHook(handler, timeout, ...rest) {
      log("info", "setInterval", { handler, timeout }, { category: "timer" });
      return original.call(this, handler, timeout, ...rest);
    });
  }

  function installKeywordHook() {
    installFetchHook("keyword");
    installXhrHook("keyword");
    installCookieHook("keyword");
    registerSyntheticHook("keyword.monitor", "keyword");
    log(
      "info",
      "keyword monitor ready",
      {
        keywords: state.keywordRules.map((rule) => rule.keyword),
        tips: state.keywordRules.length
          ? "Keyword 已独立挂载 fetch / xhr / cookie 监控。支持 key: / value: 子串匹配，也支持 exact: / exact-key: / exact-value: 精确命中。"
          : "当前未配置关键词，先在面板中填写后再注入。"
      },
      { category: "keyword" }
    );
  }

  const installers = {
    fetch: installFetchHook,
    xhr: installXhrHook,
    cookie: installCookieHook,
    storage: installStorageHook,
    json: installJsonHook,
    eval: installEvalHook,
    timer: installTimerHook,
    keyword: installKeywordHook
  };

  function installHookCategories(categories = [], options = {}) {
    const selectedCategories = [...new Set(categories)].filter((category) => Boolean(installers[category]));
    state.captureStack = Boolean(options.captureStack);
    state.keywordRules = normalizeKeywordRules(options.keywords);

    if (!selectedCategories.length) {
      emitStatus("hooks-skipped", {
        installed: isInstalled(),
        reason: "no-categories",
        keywordRules: state.keywordRules.map((rule) => rule.keyword)
      });
      return;
    }

    selectedCategories.forEach((category) => {
      installers[category]();
    });

    const snapshot = syncHookState();
    log(
      "info",
      "hook categories ready",
      {
        requestedCategories: selectedCategories,
        installedCategories: snapshot.installedCategories,
        hookCount: snapshot.hookCount,
        keywordRules: state.keywordRules.map((rule) => rule.keyword)
      },
      { category: "system" }
    );
    emitStatus("hooks-installed", {
      installed: snapshot.hookCount > 0,
      requestedCategories: selectedCategories,
      installedCategories: snapshot.installedCategories,
      keywordRules: state.keywordRules.map((rule) => rule.keyword)
    });
  }

  function installBaseHooks(options = {}) {
    installHookCategories(ALL_HOOK_CATEGORIES, options);
  }

  function resolvePath(path) {
    const parts = path.replace(/^window\./, "").split(".");
    let target = window;

    while (parts.length > 1 && target) {
      target = target[parts.shift()];
    }

    const key = parts[0];
    if (!target || !key) {
      return null;
    }

    return {
      target,
      key,
      value: target[key]
    };
  }

  function wrapMethod(target, key, wrapperName, createWrapper, category = "custom") {
    return patchMethod(target, key, wrapperName, category, createWrapper);
  }

  function runCustomHook(code) {
    try {
      const runner = new Function("hook", code);
      runner(window.__CHROME_HOOK__);
      log("info", "custom hook executed", { preview: sliceText(code, 180) }, { category: "custom" });
      emitStatus("custom-hook-executed", { installed: isInstalled(), installedCategories: state.installedCategories });
    } catch (error) {
      log("error", "custom hook failed", { error: serialize(error) }, { category: "custom", stack: captureStack() });
      emitStatus("custom-hook-failed", {
        installed: isInstalled(),
        installedCategories: state.installedCategories,
        error: serialize(error)
      });
    }
  }

  window.__CHROME_HOOK__ = {
    state,
    log,
    emit,
    serialize,
    captureStack,
    installBaseHooks,
    installHookCategories,
    unhookAll,
    resolvePath,
    wrapMethod,
    runCustomHook,
    categories: [...ALL_HOOK_CATEGORIES]
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || data.source !== EXTENSION_SOURCE) {
      return;
    }

    if (data.type === "INSTALL_BASE_HOOKS") {
      installBaseHooks(data.options || {});
      return;
    }

    if (data.type === "INSTALL_HOOK_CATEGORIES") {
      installHookCategories(data.categories || [], data.options || {});
      return;
    }

    if (data.type === "RUN_CUSTOM_HOOK") {
      runCustomHook(data.code || "");
      return;
    }

    if (data.type === "UNINSTALL_HOOKS") {
      unhookAll();
    }
  });

  emitStatus("bridge-ready", {
    installed: false,
    installedCategories: [],
    pageUrl: state.pageUrl
  });
})();
