// ==UserScript==
// @name         OpenAI Log Image Renderer
// @namespace    https://platform.openai.com/
// @version      0.1.8
// @description  Render conversation images inline in OpenAI platform conversation logs.
// @match        https://platform.openai.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const CONFIG = {
    TARGET_URL_PATTERNS: ["https://platform.openai.com/*"],
    UI: {
      maxImageWidthPx: 420,
      borderRadiusPx: 10,
      showCaption: true,
    },
    OBSERVATION: {
      mutationDebounceMs: 150,
      maxScanPerCycle: 200,
    },
    FEATURE_FLAGS: {
      renderMarkdownImages: true,
      renderInputImageByFileId: true,
      renderAnnotatedImagePlaceholder: true,
    },
    DEBUG: {
      enabled: false,
    },
    API: {
      dashboardItemsPathRegex: /\/v1\/dashboard\/conversations\/(conv_[^/?#]+)\/items/i,
      internalDownloadLinkTemplate:
        "https://api.openai.com/v1/internal/files/{file_id}/download_link",
    },
  };

  const SELECTORS = [
    "pre",
    "code",
    "[data-testid]",
    "article",
    "section",
    "div",
  ];

  const state = {
    scheduled: false,
    pendingRoots: new Set(),
    renderedSourceKeys: new Set(),
    fileIdToResolvedSrc: new Map(),
    fileIdToObjectUrl: new Map(),
    fileIdToError: new Map(),
    fileIdInFlight: new Map(),
    fileIdRetryAfterMs: new Map(),
    convIdToMessages: new Map(),
    convIdToRequestHeaders: new Map(),
    seenPayloadSignatures: new Set(),
    authBearerToken: null,
    openaiOrganization: null,
    openaiProject: null,
    lastKnownHref: "",
    apiPatched: false,
    styled: false,
  };

  function log(...args) {
    if (CONFIG.DEBUG.enabled) {
      console.log("[OCI]", ...args);
    }
  }

  function debounce(fn, waitMs) {
    let timer = null;
    return (...args) => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => fn(...args), waitMs);
    };
  }

  function ensureStyles() {
    if (state.styled) {
      return;
    }
    const style = document.createElement("style");
    style.textContent = `
      .oci-images {
        margin-top: 10px;
        display: grid;
        gap: 8px;
      }

      .oci-image-card {
        width: fit-content;
        max-width: min(100%, ${CONFIG.UI.maxImageWidthPx}px);
        border: 1px solid rgba(0, 0, 0, 0.12);
        background: rgba(250, 252, 255, 0.95);
        border-radius: ${CONFIG.UI.borderRadiusPx}px;
        padding: 8px;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.06);
      }

      .oci-image-card img {
        display: block;
        width: 100%;
        max-width: ${CONFIG.UI.maxImageWidthPx}px;
        height: auto;
        border-radius: ${CONFIG.UI.borderRadiusPx}px;
      }

      .oci-caption {
        margin-top: 6px;
        font-size: 12px;
        line-height: 1.3;
        color: rgba(20, 26, 34, 0.8);
        word-break: break-all;
      }

      .oci-error {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border: 1px solid #d47373;
        color: #8b2f2f;
        background: #fff2f2;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
      }

      .oci-retry {
        color: #214baf;
        text-decoration: underline;
        cursor: pointer;
        border: 0;
        background: transparent;
        padding: 0;
        font-size: 12px;
      }

      .oci-note {
        display: inline-flex;
        padding: 4px 8px;
        border: 1px dashed rgba(0, 0, 0, 0.25);
        border-radius: 6px;
        font-size: 12px;
        color: rgba(25, 29, 36, 0.7);
      }

      .oci-global-gallery {
        margin: 14px 0;
        padding: 10px;
        border: 1px solid rgba(0, 0, 0, 0.12);
        border-radius: 10px;
        background: rgba(248, 251, 255, 0.92);
      }

      .oci-global-title {
        margin: 0 0 8px 0;
        font-size: 13px;
        font-weight: 600;
        color: rgba(16, 21, 29, 0.85);
      }
    `;
    document.head.appendChild(style);
    state.styled = true;
  }

  function getNodeText(node) {
    if (!node || !(node instanceof Element)) {
      return "";
    }
    if (node.tagName === "PRE" || node.tagName === "CODE") {
      return node.textContent || "";
    }
    return node.innerText || node.textContent || "";
  }

  function maybeParseListPayload(text) {
    if (!text || !text.includes('"object"') || !text.includes('"data"')) {
      return null;
    }

    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        parsed.object === "list" &&
        Array.isArray(parsed.data)
      ) {
        return parsed;
      }
    } catch (error) {
      log("JSON parse skipped", error);
    }
    return null;
  }

  function normalizeRows(rows, containerElement, conversationId) {
    const out = [];
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const item = row?.item;
      if (!item) {
        continue;
      }
      if (item.type === "message") {
        const messageId = item.id || row.id || crypto.randomUUID();
        const role = item.role || "unknown";
        const contentItems = Array.isArray(item.content) ? item.content : [];
        out.push({
          messageId,
          role,
          contentItems,
          responseId: row?.response_info?.response_id || null,
          containerElement,
          conversationId: conversationId || null,
        });
        continue;
      }

      if (item.type === "computer_call_output") {
        const outputImageUrl = item?.output?.image_url;
        if (typeof outputImageUrl === "string" && /^https?:\/\//i.test(outputImageUrl)) {
          out.push({
            messageId: item.id || row.id || crypto.randomUUID(),
            role: "tool",
            contentItems: [
              {
                type: "output_image_url",
                image_url: outputImageUrl,
              },
            ],
            responseId: row?.response_info?.response_id || null,
            containerElement,
            conversationId: conversationId || null,
          });
        }
      }
    }
    return out;
  }

  function normalizeMessages(payload, containerElement, conversationId) {
    return normalizeRows(payload?.data, containerElement, conversationId);
  }

  function extractConversationIdFromUrl(urlLike) {
    try {
      const url = new URL(urlLike, window.location.origin);
      const match = url.pathname.match(CONFIG.API.dashboardItemsPathRegex);
      return match?.[1] || null;
    } catch (_error) {
      return null;
    }
  }

  function extractMarkdownImages(text) {
    const urls = [];
    const regex = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gim;
    let match;
    while ((match = regex.exec(text)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  }

  function sourceKey(messageId, sourceType, sourceValue) {
    return `${messageId}::${sourceType}::${sourceValue}`;
  }

  function safeFileEndpoint(template, fileId) {
    return template.replace("{file_id}", encodeURIComponent(fileId));
  }

  function extractBearerToken(headerValue) {
    if (!headerValue || typeof headerValue !== "string") {
      return null;
    }
    const match = headerValue.match(/^Bearer\s+(.+)$/i);
    if (!match || !match[1]) {
      return null;
    }
    return match[1].trim();
  }

  function rememberBearerToken(headerValue) {
    const token = extractBearerToken(headerValue);
    if (!token) {
      return;
    }
    if (state.authBearerToken !== token) {
      state.authBearerToken = token;
      log("Captured bearer token from platform request headers.");
    }
  }

  function rememberOpenAiHeaders(orgHeaderValue, projectHeaderValue) {
    const org = typeof orgHeaderValue === "string" ? orgHeaderValue.trim() : "";
    const project = typeof projectHeaderValue === "string" ? projectHeaderValue.trim() : "";

    if (org && state.openaiOrganization !== org) {
      state.openaiOrganization = org;
      log("Captured OpenAI-Organization header from platform request headers.");
    }
    if (project && state.openaiProject !== project) {
      state.openaiProject = project;
      log("Captured OpenAI-Project header from platform request headers.");
    }
  }

  function resetScopedHeadersForRouteChange() {
    if (state.openaiOrganization || state.openaiProject) {
      log("Route changed; resetting OpenAI-Organization/OpenAI-Project for recapture.");
    }
    state.openaiOrganization = null;
    state.openaiProject = null;
  }

  function refreshRouteScopedState() {
    const href = window.location.href;
    if (!state.lastKnownHref) {
      state.lastKnownHref = href;
      return;
    }
    if (href !== state.lastKnownHref) {
      state.lastKnownHref = href;
      resetScopedHeadersForRouteChange();
    }
  }

  function getHeaderValue(headersLike, headerName) {
    if (!headersLike) {
      return null;
    }
    const target = String(headerName || "").toLowerCase();
    if (!target) {
      return null;
    }
    if (headersLike instanceof Headers) {
      return headersLike.get(headerName);
    }
    if (Array.isArray(headersLike)) {
      for (const pair of headersLike) {
        if (!Array.isArray(pair) || pair.length < 2) {
          continue;
        }
        if (String(pair[0] || "").toLowerCase() === target) {
          return String(pair[1] || "");
        }
      }
      return null;
    }
    if (typeof headersLike === "object") {
      for (const [key, value] of Object.entries(headersLike)) {
        if (String(key || "").toLowerCase() === target) {
          return typeof value === "string" ? value : String(value);
        }
      }
    }
    return null;
  }

  function captureBearerFromFetchArgs(args) {
    const input = args[0];
    const init = args[1];
    let org = null;
    let project = null;
    if (input instanceof Request) {
      rememberBearerToken(input.headers.get("authorization"));
      org = input.headers.get("openai-organization");
      project = input.headers.get("openai-project");
    }
    if (init && typeof init === "object") {
      rememberBearerToken(getHeaderValue(init.headers, "authorization"));
      org = org || getHeaderValue(init.headers, "openai-organization");
      project = project || getHeaderValue(init.headers, "openai-project");
    }
    rememberOpenAiHeaders(org, project);
  }

  function captureItemsRequestHeaders(requestUrl, headersLike) {
    if (!requestUrl || !isDashboardItemsRequest(requestUrl)) {
      return;
    }
    const conversationId =
      extractConversationIdFromUrl(requestUrl) ||
      extractConversationIdFromUrl(window.location.href) ||
      "unknown";

    const authorization =
      getHeaderValue(headersLike, "authorization") || null;
    const organization =
      getHeaderValue(headersLike, "openai-organization") || null;
    const project =
      getHeaderValue(headersLike, "openai-project") || null;

    const previous = state.convIdToRequestHeaders.get(conversationId) || {};
    const next = {
      authorization: authorization || previous.authorization || null,
      openaiOrganization: organization || previous.openaiOrganization || null,
      openaiProject: project || previous.openaiProject || null,
    };

    state.convIdToRequestHeaders.set(conversationId, next);

    if (next.authorization) {
      rememberBearerToken(next.authorization);
    }
    rememberOpenAiHeaders(next.openaiOrganization, next.openaiProject);
  }

  function resolveAuthHeadersForConversation(conversationId) {
    const convId =
      conversationId ||
      extractConversationIdFromUrl(window.location.href) ||
      "unknown";
    const scoped = state.convIdToRequestHeaders.get(convId) || null;

    const headers = {};
    const scopedAuth = scoped?.authorization || null;
    const scopedOrg = scoped?.openaiOrganization || null;
    const scopedProject = scoped?.openaiProject || null;

    if (scopedAuth) {
      headers.Authorization = scopedAuth;
    } else if (state.authBearerToken) {
      headers.Authorization = `Bearer ${state.authBearerToken}`;
    }

    if (scopedOrg) {
      headers["OpenAI-Organization"] = scopedOrg;
    } else if (state.openaiOrganization) {
      headers["OpenAI-Organization"] = state.openaiOrganization;
    }

    if (scopedProject) {
      headers["OpenAI-Project"] = scopedProject;
    } else if (state.openaiProject) {
      headers["OpenAI-Project"] = state.openaiProject;
    }

    return headers;
  }

  function escapeAttrValue(value) {
    const v = String(value);
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(v);
    }
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  async function resolveFileImage(fileId, conversationId) {
    if (!fileId) {
      throw new Error("Missing file_id");
    }

    if (state.fileIdToResolvedSrc.has(fileId)) {
      return state.fileIdToResolvedSrc.get(fileId);
    }

    if (state.fileIdToObjectUrl.has(fileId)) {
      return state.fileIdToObjectUrl.get(fileId);
    }

    const now = Date.now();
    const retryAfter = state.fileIdRetryAfterMs.get(fileId) || 0;
    if (retryAfter > now) {
      throw new Error(
        `Temporarily cooling down retries for ${fileId} until ${new Date(retryAfter).toISOString()}`
      );
    }

    if (state.fileIdInFlight.has(fileId)) {
      return state.fileIdInFlight.get(fileId);
    }

    const request = (async () => {
      const endpoint = safeFileEndpoint(
        CONFIG.API.internalDownloadLinkTemplate,
        fileId
      );
      const headers = resolveAuthHeadersForConversation(conversationId);

      let signedUrl = null;
      try {
        const linkResponse = await fetch(endpoint, {
          credentials: "omit",
          headers,
        });
        if (!linkResponse.ok) {
          throw new Error(`Download link request failed with status ${linkResponse.status}`);
        }
        const payload = await linkResponse.json();
        if (!payload || typeof payload.url !== "string" || !/^https?:\/\//i.test(payload.url)) {
          throw new Error("Download link response missing a valid signed URL.");
        }
        signedUrl = payload.url;
      } catch (error) {
        log("Download link fetch failed", endpoint, error);
        const err = new Error(`No download link endpoint succeeded for ${fileId}`);
        state.fileIdToError.set(fileId, err.message);
        state.fileIdRetryAfterMs.set(fileId, Date.now() + 30_000);
        throw err;
      }

      // Do not fetch the signed URL via JS fetch: platform CSP blocks connect-src
      // to Azure blob hosts. Let the browser load it directly through <img src>.
      state.fileIdToResolvedSrc.set(fileId, signedUrl);
      state.fileIdToError.delete(fileId);
      state.fileIdRetryAfterMs.delete(fileId);
      return signedUrl;

      const err = new Error(`Failed to resolve image content for ${fileId}`);
      state.fileIdToError.set(fileId, err.message);
      state.fileIdRetryAfterMs.set(fileId, Date.now() + 30_000);
      throw err;
    })();

    state.fileIdInFlight.set(fileId, request);
    try {
      return await request;
    } finally {
      state.fileIdInFlight.delete(fileId);
    }
  }

  function ensureMessageMount(containerElement, messageId, allowGlobalFallback = true) {
    const host = containerElement || (allowGlobalFallback ? ensureGlobalGallery() : null);
    if (!host) {
      return null;
    }
    let root = host.querySelector(
      `[data-oci-root="${escapeAttrValue(messageId)}"]`
    );
    if (!root) {
      root = document.createElement("div");
      root.className = "oci-images";
      root.setAttribute("data-oci-root", messageId);
      host.appendChild(root);
    }
    return root;
  }

  function ensureGlobalGallery() {
    let box = document.querySelector("#oci-global-gallery");
    if (!box) {
      box = document.createElement("section");
      box.id = "oci-global-gallery";
      box.className = "oci-global-gallery";
      const title = document.createElement("h3");
      title.className = "oci-global-title";
      title.textContent = "Conversation Images";
      box.appendChild(title);
      const main = document.querySelector("main");
      if (main) {
        main.prepend(box);
      } else {
        document.body.prepend(box);
      }
    }
    return box;
  }

  function appendImageCard(mount, sourceKeyValue, src, caption) {
    if (
      mount.querySelector(`[data-oci-card="${escapeAttrValue(sourceKeyValue)}"]`)
    ) {
      return;
    }
    const card = document.createElement("div");
    card.className = "oci-image-card";
    card.setAttribute("data-oci-card", sourceKeyValue);

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.alt = caption || "Conversation image";
    card.appendChild(img);

    if (CONFIG.UI.showCaption) {
      const cap = document.createElement("div");
      cap.className = "oci-caption";
      cap.textContent = caption || src;
      card.appendChild(cap);
    }

    mount.appendChild(card);
  }

  function appendErrorBadge(mount, sourceKeyValue, label, onRetry) {
    let box = mount.querySelector(
      `[data-oci-error="${escapeAttrValue(sourceKeyValue)}"]`
    );
    if (!box) {
      box = document.createElement("div");
      box.className = "oci-error";
      box.setAttribute("data-oci-error", sourceKeyValue);
      mount.appendChild(box);
    } else {
      box.innerHTML = "";
    }

    const text = document.createElement("span");
    text.textContent = label;
    box.appendChild(text);

    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "oci-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", onRetry);
    box.appendChild(retry);
  }

  function appendNote(mount, sourceKeyValue, noteText) {
    if (
      mount.querySelector(`[data-oci-note="${escapeAttrValue(sourceKeyValue)}"]`)
    ) {
      return;
    }
    const note = document.createElement("div");
    note.className = "oci-note";
    note.setAttribute("data-oci-note", sourceKeyValue);
    note.textContent = noteText;
    mount.appendChild(note);
  }

  function collectCandidatesFromMessages(messages) {
    const candidates = [];
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      for (const content of msg.contentItems) {
        if (content?.type === "input_image") {
          if (content.image_url && /^https?:\/\//i.test(content.image_url)) {
            candidates.push({
              message: msg,
              sourceType: "input_image_url",
              sourceValue: content.image_url,
              caption: content.image_url,
              resolver: async () => content.image_url,
            });
          } else if (
            CONFIG.FEATURE_FLAGS.renderInputImageByFileId &&
            content.file_id
          ) {
            const fileId = content.file_id;
            candidates.push({
              message: msg,
              sourceType: "input_image_file",
              sourceValue: fileId,
              caption: fileId,
              resolver: async () => resolveFileImage(fileId, msg.conversationId),
            });
          }
          continue;
        }

        if (
          CONFIG.FEATURE_FLAGS.renderMarkdownImages &&
          content?.type === "output_text" &&
          typeof content.text === "string"
        ) {
          const urls = extractMarkdownImages(content.text);
          for (const url of urls) {
            candidates.push({
              message: msg,
              sourceType: "markdown",
              sourceValue: url,
              caption: url,
              resolver: async () => url,
            });
          }
          continue;
        }

        if (
          CONFIG.FEATURE_FLAGS.renderAnnotatedImagePlaceholder &&
          content?.type === "input_text" &&
          typeof content.text === "string" &&
          content.text.includes("[ANNOTATED_IMAGE]")
        ) {
          const linked = findNearbyInputImage(messages, i);
          const markerValue = linked?.file_id || linked?.image_url || "missing";
          candidates.push({
            message: msg,
            sourceType: "annotated_note",
            sourceValue: markerValue,
            caption: "Annotated image reference",
            resolver: async () => {
              if (linked?.image_url && /^https?:\/\//i.test(linked.image_url)) {
                return linked.image_url;
              }
              if (linked?.file_id) {
                return resolveFileImage(linked.file_id, msg.conversationId);
              }
              return null;
            },
            fallbackNote: linked
              ? "Annotated image placeholder matched to nearby input_image."
              : "Annotated image placeholder detected but no nearby input_image found.",
          });
        }
      }
    }
    return candidates;
  }

  function findNearbyInputImage(messages, idx) {
    const maxDistance = 3;
    for (let dist = 0; dist <= maxDistance; dist += 1) {
      const before = messages[idx - dist];
      const after = messages[idx + dist];
      const beforeHit = before?.contentItems?.find((c) => c?.type === "input_image");
      if (beforeHit) {
        return beforeHit;
      }
      const afterHit = after?.contentItems?.find((c) => c?.type === "input_image");
      if (afterHit) {
        return afterHit;
      }
    }
    return null;
  }

  function signatureForPayload(payload, conversationId) {
    const first = payload?.first_id || "";
    const last = payload?.last_id || "";
    const len = Array.isArray(payload?.data) ? payload.data.length : 0;
    return `${conversationId || "unknown"}::${first}::${last}::${len}`;
  }

  function captureItemsPayload(payload, requestUrl) {
    if (!payload || payload.object !== "list" || !Array.isArray(payload.data)) {
      return;
    }
    const conversationId = extractConversationIdFromUrl(requestUrl) || extractConversationIdFromUrl(window.location.href);
    const signature = signatureForPayload(payload, conversationId);
    if (state.seenPayloadSignatures.has(signature)) {
      return;
    }
    state.seenPayloadSignatures.add(signature);
    const messages = normalizeMessages(payload, null, conversationId);
    if (messages.length === 0) {
      return;
    }
    const existing = state.convIdToMessages.get(conversationId || "unknown") || [];
    const byMessageId = new Map(existing.map((m) => [m.messageId, m]));
    for (const msg of messages) {
      byMessageId.set(msg.messageId, msg);
    }
    state.convIdToMessages.set(conversationId || "unknown", Array.from(byMessageId.values()));
    enqueueRoot(document);
  }

  function isDashboardItemsRequest(urlLike) {
    try {
      const url = new URL(urlLike, window.location.origin);
      return CONFIG.API.dashboardItemsPathRegex.test(url.pathname);
    } catch (_error) {
      return false;
    }
  }

  function patchNetworkCapture() {
    if (state.apiPatched) {
      return;
    }
    state.apiPatched = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      captureBearerFromFetchArgs(args);
      const response = await originalFetch(...args);
      try {
        const input = args[0];
        const requestUrl =
          typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : "";
        const requestHeaders = {};
        if (input instanceof Request) {
          requestHeaders.authorization = input.headers.get("authorization");
          requestHeaders["openai-organization"] = input.headers.get("openai-organization");
          requestHeaders["openai-project"] = input.headers.get("openai-project");
        }
        const init = args[1];
        if (init && typeof init === "object" && init.headers) {
          const initAuth = getHeaderValue(init.headers, "authorization");
          const initOrg = getHeaderValue(init.headers, "openai-organization");
          const initProject = getHeaderValue(init.headers, "openai-project");
          if (initAuth) {
            requestHeaders.authorization = initAuth;
          }
          if (initOrg) {
            requestHeaders["openai-organization"] = initOrg;
          }
          if (initProject) {
            requestHeaders["openai-project"] = initProject;
          }
        }
        captureItemsRequestHeaders(requestUrl, requestHeaders);
        if (requestUrl && isDashboardItemsRequest(requestUrl)) {
          const clone = response.clone();
          clone
            .json()
            .then((payload) => captureItemsPayload(payload, requestUrl))
            .catch((error) => log("Fetch JSON clone parse failed", error));
        }
      } catch (error) {
        log("Fetch interception failed", error);
      }
      return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__ociRequestUrl = typeof url === "string" ? url : "";
      this.__ociRequestHeaders = {};
      return originalOpen.call(this, method, url, ...rest);
    };

    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
      try {
        const key = String(name || "").toLowerCase();
        if (key) {
          this.__ociRequestHeaders = this.__ociRequestHeaders || {};
          this.__ociRequestHeaders[key] = String(value || "");
          if (key === "authorization") {
            rememberBearerToken(String(value || ""));
          } else if (key === "openai-organization") {
            rememberOpenAiHeaders(String(value || ""), null);
          } else if (key === "openai-project") {
            rememberOpenAiHeaders(null, String(value || ""));
          }
        }
      } catch (_error) {
        // ignore capture errors and keep request flow untouched
      }
      return originalSetRequestHeader.call(this, name, value);
    };

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      this.addEventListener("load", function onLoad() {
        try {
          const requestUrl = this.__ociRequestUrl || "";
          captureItemsRequestHeaders(requestUrl, this.__ociRequestHeaders || {});
          if (!requestUrl || !isDashboardItemsRequest(requestUrl)) {
            return;
          }
          const body = this.responseType === "" || this.responseType === "text"
            ? this.responseText
            : "";
          if (!body) {
            return;
          }
          const payload = JSON.parse(body);
          captureItemsPayload(payload, requestUrl);
        } catch (error) {
          log("XHR interception failed", error);
        }
      });
      return originalSend.apply(this, args);
    };

    const originalPushState = history.pushState.bind(history);
    history.pushState = function patchedPushState(...args) {
      const result = originalPushState(...args);
      refreshRouteScopedState();
      enqueueRoot(document);
      return result;
    };

    const originalReplaceState = history.replaceState.bind(history);
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState(...args);
      refreshRouteScopedState();
      enqueueRoot(document);
      return result;
    };

    window.addEventListener("popstate", () => {
      refreshRouteScopedState();
      enqueueRoot(document);
    });

    window.addEventListener("hashchange", () => {
      refreshRouteScopedState();
      enqueueRoot(document);
    });
  }

  function findContainerForMessage(messageId) {
    if (!messageId) {
      return null;
    }
    const selectors = [
      `[data-message-id="${escapeAttrValue(messageId)}"]`,
      `[data-message-id*="${escapeAttrValue(messageId)}"]`,
      `[data-id="${escapeAttrValue(messageId)}"]`,
      `[data-id*="${escapeAttrValue(messageId)}"]`,
      `[id*="${escapeAttrValue(messageId)}"]`,
    ];
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found instanceof Element) {
        return found;
      }
    }
    return null;
  }

  function normalizeMatchText(text) {
    return String(text || "")
      .replace(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gim, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function messageTextForMatching(message) {
    if (!message || !Array.isArray(message.contentItems)) {
      return "";
    }
    const parts = [];
    for (const content of message.contentItems) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      } else if (content?.type === "input_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
    return normalizeMatchText(parts.join(" "));
  }

  function isInputImageOnlyMessage(message) {
    if (!message || !Array.isArray(message.contentItems) || message.contentItems.length === 0) {
      return false;
    }
    return message.contentItems.every((content) => content?.type === "input_image");
  }

  function findResponseCardByResponseId(responseId) {
    if (!responseId) {
      return null;
    }
    const id = String(responseId).trim();
    if (!id) {
      return null;
    }
    const tokens = document.querySelectorAll("span.zxtJj");
    for (const token of tokens) {
      if (!(token instanceof Element)) {
        continue;
      }
      const text = (token.textContent || "").trim();
      if (text === id) {
        const card = token.closest("div._7ho-7");
        if (card instanceof Element) {
          return card;
        }
      }
    }
    return null;
  }

  function readResponseBlocks(card) {
    const blocks = [];
    if (!(card instanceof Element)) {
      return blocks;
    }
    const nodes = card.querySelectorAll(".nyCLx .zl9Lq");
    let idx = 0;
    for (const node of nodes) {
      if (!(node instanceof Element)) {
        continue;
      }
      const roleText = node.querySelector(".Ykd-p")?.textContent || "";
      const role = roleText.trim().toLowerCase();
      const bodyEl = node.querySelector(".EWWAC");
      const bodyText = normalizeMatchText(bodyEl?.textContent || "");
      blocks.push({
        idx,
        role,
        bodyText,
        hasBody: Boolean(bodyEl && bodyText),
        el: node,
      });
      idx += 1;
    }
    return blocks;
  }

  function findContainerInResponseBlocks(message, blocks, usedIndices) {
    if (!message || !Array.isArray(blocks) || blocks.length === 0) {
      return null;
    }
    const role = String(message.role || "").toLowerCase();
    const roleMatches = blocks.filter(
      (block) =>
        block.role === role &&
        !usedIndices.has(block.idx) &&
        block.el instanceof Element
    );
    if (roleMatches.length === 0) {
      return null;
    }

    if (isInputImageOnlyMessage(message)) {
      const emptyBodyMatch = roleMatches.find((block) => !block.hasBody);
      if (emptyBodyMatch) {
        usedIndices.add(emptyBodyMatch.idx);
        return emptyBodyMatch.el;
      }
    }

    const textToMatch = messageTextForMatching(message);
    if (textToMatch) {
      const snippet = textToMatch.slice(0, 140);
      const exactBodyMatch = roleMatches.find(
        (block) => block.bodyText && block.bodyText.includes(snippet)
      );
      if (exactBodyMatch) {
        usedIndices.add(exactBodyMatch.idx);
        return exactBodyMatch.el;
      }

      const fuzzyBodyMatch = roleMatches.find((block) => {
        if (!block.bodyText) {
          return false;
        }
        const bodySnippet = block.bodyText.slice(0, 120);
        return bodySnippet && textToMatch.includes(bodySnippet);
      });
      if (fuzzyBodyMatch) {
        usedIndices.add(fuzzyBodyMatch.idx);
        return fuzzyBodyMatch.el;
      }
    }

    usedIndices.add(roleMatches[0].idx);
    return roleMatches[0].el;
  }

  async function renderCandidate(candidate) {
    const key = sourceKey(
      candidate.message.messageId,
      candidate.sourceType,
      candidate.sourceValue
    );

    const mount = ensureMessageMount(
      candidate.message.containerElement,
      candidate.message.messageId,
      !candidate.requireMessageContainer
    );
    if (!mount) {
      return;
    }

    if (state.renderedSourceKeys.has(key)) {
      return;
    }

    const render = async () => {
      try {
        const resolvedSrc = await candidate.resolver();
        if (resolvedSrc) {
          appendImageCard(mount, key, resolvedSrc, candidate.caption);
        } else if (candidate.fallbackNote) {
          appendNote(mount, key, candidate.fallbackNote);
        }
        state.renderedSourceKeys.add(key);
      } catch (error) {
        const label = `Image unavailable (${candidate.sourceValue})`;
        state.renderedSourceKeys.add(key);
        appendErrorBadge(mount, key, label, async () => {
          const errorEl = mount.querySelector(
            `[data-oci-error="${escapeAttrValue(key)}"]`
          );
          if (errorEl) {
            errorEl.remove();
          }
          state.renderedSourceKeys.delete(key);
          await renderCandidate(candidate);
        });
        log("Render failed", key, error);
      }
    };

    await render();
  }

  function findJsonContainerElements(root) {
    const out = [];
    const selector = SELECTORS.join(",");
    const list = root.querySelectorAll(selector);
    let count = 0;

    if (root instanceof Element && root.matches(selector)) {
      if (count < CONFIG.OBSERVATION.maxScanPerCycle) {
        const rootText = getNodeText(root);
        if (
          root.dataset.ociProcessed !== "1" &&
          rootText.includes('"object"') &&
          rootText.includes('"data"') &&
          rootText.includes('"type"') &&
          rootText.includes('"message"')
        ) {
          out.push(root);
          count += 1;
        }
      }
    }

    for (const el of list) {
      if (count >= CONFIG.OBSERVATION.maxScanPerCycle) {
        break;
      }
      if (!(el instanceof Element)) {
        continue;
      }
      if (el.dataset.ociProcessed === "1") {
        continue;
      }
      const text = getNodeText(el);
      if (
        text.includes('"object"') &&
        text.includes('"data"') &&
        text.includes('"type"') &&
        text.includes('"message"')
      ) {
        out.push(el);
        count += 1;
      }
    }
    return out;
  }

  async function processContainerElement(el) {
    if (!(el instanceof Element) || el.dataset.ociProcessed === "1") {
      return;
    }

    const text = getNodeText(el);
    const payload = maybeParseListPayload(text);
    if (!payload) {
      return;
    }

    const messages = normalizeMessages(payload, el);
    if (messages.length === 0) {
      el.dataset.ociProcessed = "1";
      return;
    }

    const candidates = collectCandidatesFromMessages(messages);
    for (const candidate of candidates) {
      // Intentional sequential rendering to keep placement stable.
      // eslint-disable-next-line no-await-in-loop
      await renderCandidate(candidate);
    }

    el.dataset.ociProcessed = "1";
  }

  async function processCapturedMessages() {
    for (const messages of state.convIdToMessages.values()) {
      const responseContextById = new Map();
      const patchedMessages = messages.map((msg) => ({
        ...msg,
        containerElement: null,
      }));

      for (const msg of patchedMessages) {
        let container = findContainerForMessage(msg.messageId);
        if (!container && msg.responseId) {
          let ctx = responseContextById.get(msg.responseId);
          if (!ctx) {
            const card = findResponseCardByResponseId(msg.responseId);
            const blocks = readResponseBlocks(card);
            ctx = { blocks, usedIndices: new Set() };
            responseContextById.set(msg.responseId, ctx);
          }
          container = findContainerInResponseBlocks(msg, ctx.blocks, ctx.usedIndices);
        }
        msg.containerElement = container;
      }

      const candidates = collectCandidatesFromMessages(patchedMessages);
      for (const candidate of candidates) {
        if (!candidate.message.containerElement) {
          continue;
        }
        candidate.requireMessageContainer = true;
        // eslint-disable-next-line no-await-in-loop
        await renderCandidate(candidate);
      }
    }
  }

  async function scanRoot(root) {
    if (!root || !(root instanceof Element || root instanceof Document)) {
      return;
    }

    const candidateElements = findJsonContainerElements(root);
    for (const element of candidateElements) {
      // eslint-disable-next-line no-await-in-loop
      await processContainerElement(element);
    }

    await processCapturedMessages();
  }

  const scheduleScan = debounce(async () => {
    state.scheduled = false;
    refreshRouteScopedState();
    const roots = Array.from(state.pendingRoots);
    state.pendingRoots.clear();
    for (const root of roots) {
      // eslint-disable-next-line no-await-in-loop
      await scanRoot(root);
    }
  }, CONFIG.OBSERVATION.mutationDebounceMs);

  function enqueueRoot(root) {
    state.pendingRoots.add(root || document);
    if (!state.scheduled) {
      state.scheduled = true;
      scheduleScan();
    }
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target && mutation.target instanceof Node) {
          enqueueRoot(mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : document);
        }
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            enqueueRoot(node);
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    enqueueRoot(document);
  }

  function revokeObjectUrls() {
    for (const url of state.fileIdToObjectUrl.values()) {
      URL.revokeObjectURL(url);
    }
    state.fileIdToResolvedSrc.clear();
    state.fileIdToObjectUrl.clear();
    state.fileIdInFlight.clear();
    state.fileIdRetryAfterMs.clear();
    state.convIdToRequestHeaders.clear();
  }

  function start() {
    state.lastKnownHref = window.location.href;
    ensureStyles();
    patchNetworkCapture();
    startObserver();
    window.addEventListener("beforeunload", revokeObjectUrls);
    log("OpenAI Conversation Image renderer initialized.");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
