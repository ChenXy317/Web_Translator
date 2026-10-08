import { BUILTIN_SKIP_SELECTORS, TRANSLATABLE_ATTRS } from "../shared/constants.js";
import { hostMatches, parseSelectorList } from "../shared/site.js";
import { getSettings } from "../shared/storage.js";
import { chunkText, shouldSkipText, splitWS } from "../shared/text.js";
import {
  createUi,
  hideTooltip,
  placeBubble,
  renderChip,
  showInputButton,
  showTooltip
} from "./ui.js";

if (window.__ATP_LOADED__) {
  /* already running */
} else {
  window.__ATP_LOADED__ = true;
  boot();
}

function shouldRunInFrame() {
  if (window === window.top) return true;
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  if (w < 48 || h < 48) return false;
  try {
    if (/ads?|doubleclick|googlesyndication|taboola|outbrain|facebook\.com\/tr/i.test(location.href)) return false;
  } catch {
    return false;
  }
  return true;
}

function boot() {
  if (!shouldRunInFrame()) return;

  const ALWAYS_SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "TEMPLATE",
    "SVG", "MATH", "IFRAME", "OBJECT", "VIDEO", "AUDIO", "CANVAS",
    "INPUT", "SELECT", "OPTION"
  ]);
  const CODE_SKIP = new Set(["CODE", "PRE", "KBD", "SAMP"]);

  const state = {
    enabled: false,
    bilingual: false,
    hoverOriginal: true,
    skipIfTarget: true,
    skipCode: true,
    targetLang: "简体中文",
    batchSize: 12,
    maxChars: 2400,
    minChars: 2,
    maxNodes: 5000,
    translateTitle: true,
    translateAttrs: false,
    inputButton: true,
    pauseOnHidden: true,
    autoRetry: true,
    chipPosition: "bottom-right",
    skipSelectors: [],
    model: "",
    glossary: "",
    customPrompt: "",
    jsonMode: false,
    phase: "idle",
    error: "",
    done: 0,
    pending: 0,
    paused: false,
    pausedByUser: false,
    chipHidden: false
  };

  const records = new WeakMap();
  const tracked = new Set();
  const queued = new Set();
  const inflight = new Set();
  const localCache = new Map();
  const pendingReqs = new Map();
  const attrRecords = [];
  let seenAttrs = new WeakMap();
  let titleOriginal = "";
  let reqId = 1;
  let port = null;
  let heartbeat = 0;
  let observer = null;
  let observedRoots = new WeakSet();
  let boxMemo = new WeakMap();
  let attrObserver = null;
  let visibleTimer = 0;
  let scanTimer = 0;
  let mutationBuffer = [];
  let pendingAttrs = [];
  let ui = null;
  let mutating = false;
  let activePumps = 0;
  let failCount = 0;
  let queuedTotal = 0;
  let lastRange = null;
  let lastBubbleText = "";
  let focusedInput = null;
  let settingsCache = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getPort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "atp" });
    port.onMessage.addListener((msg) => {
      if (msg?.type === "pong") return;
      const pending = pendingReqs.get(msg.id);
      if (!pending) return;
      pendingReqs.delete(msg.id);
      if (msg.ok) pending.resolve(msg.translations);
      else pending.reject(new Error(msg.error || "翻译失败"));
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const [, p] of pendingReqs) p.reject(new Error("与扩展后台断开，请重试"));
      pendingReqs.clear();
    });
    return port;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      try {
        getPort().postMessage({ type: "ping" });
      } catch {
        port = null;
      }
    }, 20000);
  }

  function stopHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = 0;
  }

  async function requestTranslate(texts) {
    if (!chrome.runtime?.id) {
      throw new Error("扩展已更新，请刷新页面");
    }
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = reqId;
      reqId += 1;
      try {
        return await new Promise((resolve, reject) => {
          pendingReqs.set(id, { resolve, reject });
          try {
            getPort().postMessage({ type: "translate", id, texts });
          } catch (err) {
            pendingReqs.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        lastErr = err;
        const msg = err?.message || "";
        if (/断开|Extension context invalidated|message port/i.test(msg) && attempt < 2) {
          port = null;
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  function snapshotStatus() {
    return {
      enabled: state.enabled,
      phase: state.phase,
      error: state.error,
      done: state.done,
      pending: queued.size + inflight.size,
      paused: state.paused,
      bilingual: state.bilingual,
      targetLang: state.targetLang
    };
  }

  function reportStatus() {
    state.pending = queued.size + inflight.size;
    chrome.runtime.sendMessage({ type: "STATUS", status: snapshotStatus() }).catch(() => {});
    if (ui) renderChip(ui, state);
  }

  function ensureUI() {
    if (ui) return ui;
    ui = createUi({
      restore: () => restoreAll(),
      togglePause: () => togglePause(),
      retry: () => retryTranslate(),
      hide: () => {
        state.chipHidden = true;
        renderChip(ui, state);
      },
      copyBubble: async () => {
        if (!lastBubbleText) return;
        try {
          await navigator.clipboard.writeText(lastBubbleText);
        } catch {
          /* 忽略无剪贴板权限 */
        }
      },
      replaceSelection: () => replaceSelection(),
      translateInput: () => translateFocusedInput()
    });
    return ui;
  }

  function isExtensionUi(node) {
    if (!node) return false;
    const root = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    if (root?.host?.id === "atp-root") return true;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(el?.id === "atp-root" || el?.closest?.("#atp-root"));
  }

  function isTitleText(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return el?.tagName === "TITLE";
  }

  // 浮层在 Shadow DOM 里，closest 穿不过去；标题由单独请求处理。两者再入队会反复翻译。
  function shouldIgnoreNode(node) {
    return isExtensionUi(node) || isTitleText(node);
  }

  function isSkippable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (isExtensionUi(el)) return true;
    if (ALWAYS_SKIP.has(el.tagName)) return true;
    if (state.skipCode && CODE_SKIP.has(el.tagName)) return true;
    if (el.isContentEditable || el.closest("[contenteditable]:not([contenteditable='false'])")) return true;
    if (el.classList?.contains("notranslate") || el.translate === false) return true;
    if (el.closest(".notranslate, [translate='no'], .atp-bi, [data-atp='1'], #atp-root")) return true;
    const role = el.getAttribute?.("role");
    if (role === "textbox" || role === "code") return true;
    const extra = state.skipSelectors;
    if (extra.length) {
      try {
        if (extra.some((sel) => el.matches(sel) || el.closest(sel))) return true;
      } catch {
        /* 非法选择器忽略 */
      }
    }
    return false;
  }

  function ancestorElement(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode?.();
    return root?.host || null;
  }

  function clipsOverflow(st) {
    return /hidden|clip|scroll|auto/.test(`${st.overflow}${st.overflowX}${st.overflowY}`);
  }

  // 只认真正画出来的区域。裁切、透明、收起、挪到屏幕左右外侧的文字不翻译。
  function visibleBox(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    if (boxMemo.has(el)) return boxMemo.get(el);
    const reject = () => {
      boxMemo.set(el, null);
      return null;
    };
    const st = window.getComputedStyle(el);
    if (
      el.hidden ||
      el.hasAttribute("inert") ||
      st.display === "none" ||
      st.visibility === "hidden" ||
      st.visibility === "collapse" ||
      st.contentVisibility === "hidden" ||
      Number(st.opacity) === 0
    ) {
      return reject();
    }
    const raw = el.getBoundingClientRect();
    let rect = { left: raw.left, right: raw.right, top: raw.top, bottom: raw.bottom, width: raw.width, height: raw.height };
    if (rect.width < 2 || rect.height < 2) return reject();
    const viewW = window.innerWidth || 800;
    if (rect.right <= 0 || rect.left >= viewW) return reject();
    let cur = ancestorElement(el);
    while (cur && cur !== document.documentElement) {
      if (cur.hidden || cur.hasAttribute("inert")) return reject();
      const cs = window.getComputedStyle(cur);
      if (
        Number(cs.opacity) === 0 ||
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        cs.contentVisibility === "hidden"
      ) {
        return reject();
      }
      if (clipsOverflow(cs)) {
        const c = cur.getBoundingClientRect();
        const left = Math.max(rect.left, c.left);
        const right = Math.min(rect.right, c.right);
        const top = Math.max(rect.top, c.top);
        const bottom = Math.min(rect.bottom, c.bottom);
        if (right - left < 2 || bottom - top < 2) return reject();
        rect = { left, right, top, bottom, width: right - left, height: bottom - top };
      }
      cur = ancestorElement(cur);
    }
    boxMemo.set(el, rect);
    return rect;
  }

  function inViewBand(box) {
    const h = window.innerHeight || 800;
    const w = window.innerWidth || 800;
    return box.bottom > -h * 0.15 && box.top < h * 1.6 && box.right > 0 && box.left < w;
  }

  function rankOf(node) {
    if (node._kind === "attr") return -8000;
    const el = node.parentElement;
    if (!el?.getBoundingClientRect) return -1e9;
    const rect = el.getBoundingClientRect();
    const len = String(node.nodeValue || "").trim().length;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const corner = ((cx - w / 2) / w) ** 2 + ((cy - h / 2) / h) ** 2;
    let score = Math.min(len, 480) * 10;
    if (el.closest("main, article, [role='main']")) score += 8000;
    if (el.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, td, figcaption, dd")) score += 3000;
    if (el.closest("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], [role='complementary']")) {
      score -= 9000;
    }
    if (rect.top > h || rect.bottom < 0) score -= 5000;
    score -= corner * 5000;
    return score;
  }

  function queryAllDeep(root, sel, out = []) {
    root.querySelectorAll?.(sel)?.forEach((el) => out.push(el));
    root.querySelectorAll?.("*")?.forEach((el) => {
      if (el.shadowRoot) queryAllDeep(el.shadowRoot, sel, out);
    });
    return out;
  }

  function skipSel() {
    const extra = state.skipCode ? BUILTIN_SKIP_SELECTORS.join(",") : "script, style, textarea, svg, math";
    return `${extra}, .atp-bi, [data-atp='1'], #atp-root`;
  }

  function skipOptions() {
    return {
      minChars: state.minChars,
      skipIfTarget: state.skipIfTarget,
      targetLang: state.targetLang
    };
  }

  function collectTextNodes(root, nearbyOnly) {
    const nodes = [];
    const visit = (base) => {
      const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || shouldSkipText(node.nodeValue, skipOptions())) return NodeFilter.FILTER_REJECT;
          if (shouldIgnoreNode(node)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || isSkippable(parent)) return NodeFilter.FILTER_REJECT;
          const box = visibleBox(parent);
          if (!box) return NodeFilter.FILTER_REJECT;
          if (nearbyOnly && !inViewBand(box)) return NodeFilter.FILTER_REJECT;
          try {
            if (parent.closest(skipSel())) return NodeFilter.FILTER_REJECT;
          } catch {
            /* ignore */
          }
          const rec = records.get(node);
          if (rec?.status === "done" && node.nodeValue === rec.translated) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let current = walker.nextNode();
      while (current) {
        nodes.push(current);
        current = walker.nextNode();
      }
      const els = base.querySelectorAll ? base.querySelectorAll("*") : [];
      for (const el of els) {
        if (el.id === "atp-root" || !el.shadowRoot) continue;
        visit(el.shadowRoot);
      }
    };
    visit(root);
    return nodes;
  }

  function collectAttrTargets(root) {
    if (!state.translateAttrs || !root.querySelectorAll) return [];
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      if (el.id === "atp-root" || isExtensionUi(el) || isSkippable(el) || !visibleBox(el)) continue;
      for (const attr of TRANSLATABLE_ATTRS) {
        const value = el.getAttribute(attr);
        if (!value || shouldSkipText(value, skipOptions())) continue;
        out.push({ el, attr, original: value });
      }
    }
    return out;
  }

  function enqueue(nodes) {
    let added = 0;
    for (const node of nodes) {
      if (shouldIgnoreNode(node)) continue;
      if (queued.has(node) || inflight.has(node)) continue;
      if (!node.parentNode) continue;
      const host = node.parentElement;
      const box = host ? visibleBox(host) : null;
      if (!box) continue;
      if (!inViewBand(box) && queuedTotal >= state.maxNodes) continue;
      const rec = records.get(node);
      if (rec?.status === "done" && rec.translated === node.nodeValue) continue;
      queued.add(node);
      tracked.add(node);
      added += 1;
      queuedTotal += 1;
    }
    if (added) {
      state.pending = queued.size + inflight.size;
      schedulePump();
      reportStatus();
    }
  }

  function enqueueAttrs(items) {
    let added = 0;
    for (const item of items) {
      if (queuedTotal >= state.maxNodes) break;
      if (shouldIgnoreNode(item.el)) continue;
      let seen = seenAttrs.get(item.el);
      if (!seen) {
        seen = new Set();
        seenAttrs.set(item.el, seen);
      }
      if (seen.has(item.attr)) continue;
      seen.add(item.attr);
      item._kind = "attr";
      queued.add(item);
      queuedTotal += 1;
      added += 1;
    }
    if (added) schedulePump();
  }

  function schedulePump() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      pump();
    }, 40);
  }

  function takeBatch() {
    const ordered = [...queued].sort((a, b) => rankOf(b) - rankOf(a));
    const batch = [];
    let chars = 0;
    for (const node of ordered) {
      const body = node._kind === "attr" ? node.original : splitWS(node.nodeValue || "").body;
      if (!body) {
        queued.delete(node);
        continue;
      }
      if (batch.length && (batch.length >= state.batchSize || chars + body.length > state.maxChars)) break;
      batch.push(node);
      chars += body.length;
      queued.delete(node);
      inflight.add(node);
    }
    return batch;
  }

  function cacheToken(body) {
    return [
      state.model,
      state.targetLang,
      state.glossary,
      state.customPrompt,
      state.jsonMode ? "json" : "plain",
      body
    ].join("\u0001");
  }

  async function pump() {
    if (!state.enabled || state.paused) return;
    if (activePumps >= 2) return;
    const batch = takeBatch();
    if (!batch.length) {
      if (!inflight.size && !activePumps) {
        state.phase = state.error ? "error" : "done";
        reportStatus();
      }
      return;
    }
    activePumps += 1;
    state.phase = "running";
    reportStatus();

    const jobs = [];
    for (const item of batch) {
      if (item._kind === "attr") {
        jobs.push({ item, body: item.original, lead: "", trail: "" });
      } else {
        const original = records.get(item)?.original ?? item.nodeValue;
        if (!records.has(item)) records.set(item, { original, status: "run" });
        const parts = splitWS(original);
        jobs.push({ item, ...parts });
      }
    }

    const toSend = [];
    const mapIndex = [];
    jobs.forEach((job, i) => {
      const cached = localCache.get(cacheToken(job.body));
      if (cached) {
        applyJob(job, cached);
        inflight.delete(job.item);
      } else {
        const chunks = chunkText(job.body, state.maxChars);
        job.chunks = chunks;
        job.sendAt = toSend.length;
        toSend.push(...chunks);
        mapIndex.push(i);
      }
    });

    try {
      if (toSend.length) {
        const translations = await requestTranslate(toSend);
        mapIndex.forEach((i) => {
          const job = jobs[i];
          const slice = translations.slice(job.sendAt, job.sendAt + job.chunks.length);
          const joined = slice.join("") || job.body;
          localCache.set(cacheToken(job.body), joined);
          applyJob(job, joined);
        });
      }
      state.error = "";
      failCount = 0;
    } catch (err) {
      failCount += 1;
      state.error = err?.message || "翻译失败";
      batch.forEach((node) => {
        inflight.delete(node);
        const done = node._kind === "attr" ? node.status === "done" : records.get(node)?.status === "done";
        if (!done) queued.add(node);
      });
      if (state.autoRetry && failCount < 3) {
        state.phase = "running";
        reportStatus();
        setTimeout(() => pump(), 700 * failCount);
        return;
      }
      state.phase = "error";
      reportStatus();
      return;
    } finally {
      batch.forEach((node) => inflight.delete(node));
      activePumps -= 1;
    }

    reportStatus();
    if (queued.size) schedulePump();
    else if (!activePumps) {
      state.phase = "done";
      reportStatus();
    }
  }

  function applyJob(job, translated) {
    if (job.item._kind === "attr") {
      applyAttr(job.item, translated);
      return;
    }
    applyNode(job.item, job, translated);
  }

  function applyNode(node, parts, translated) {
    if (!node.parentNode) return;
    const next = `${parts.lead}${translated}${parts.trail}`;
    const rec = records.get(node) || { original: node.nodeValue };
    rec.translated = next;
    rec.status = "done";
    records.set(node, rec);
    mutating = true;
    try {
      if (state.bilingual && node.parentElement && !node.parentElement.closest(".atp-bi")) {
        const wrap = document.createElement("span");
        wrap.className = "atp-bi";
        wrap.setAttribute("data-atp", "1");
        const src = document.createElement("span");
        src.className = "atp-src";
        src.textContent = rec.original;
        const dst = document.createElement("span");
        dst.className = "atp-dst";
        dst.textContent = next;
        wrap.append(src, dst);
        node.parentNode.replaceChild(wrap, node);
        tracked.delete(node);
      } else {
        node.nodeValue = next;
      }
      state.done += 1;
    } finally {
      mutating = false;
    }
  }

  function applyAttr(item, translated) {
    const el = item.el;
    if (!el?.isConnected) return;
    mutating = true;
    try {
      if (!el.getAttribute("data-atp-attr")) el.setAttribute("data-atp-attr", "1");
      attrRecords.push({ el, attr: item.attr, original: item.original });
      el.setAttribute(item.attr, translated);
      item.status = "done";
      state.done += 1;
    } finally {
      mutating = false;
    }
  }

  function restoreAll() {
    stopObserver();
    stopHeartbeat();
    state.enabled = false;
    state.paused = false;
    state.pausedByUser = false;
    state.phase = "idle";
    state.error = "";
    mutating = true;
    try {
      for (const node of tracked) {
        const rec = records.get(node);
        if (rec && node.parentNode && node.nodeType === Node.TEXT_NODE) {
          node.nodeValue = rec.original;
        }
      }
      queryAllDeep(document.documentElement, "[data-atp='1']").forEach((el) => {
        const src = el.querySelector(".atp-src");
        if (src) el.replaceWith(document.createTextNode(src.textContent || ""));
        else el.remove();
      });
      attrRecords.forEach((item) => {
        if (item.el?.isConnected) item.el.setAttribute(item.attr, item.original);
      });
      document.querySelectorAll("[data-atp-attr]").forEach((el) => el.removeAttribute("data-atp-attr"));
      if (titleOriginal) document.title = titleOriginal;
    } finally {
      mutating = false;
    }
    tracked.clear();
    queued.clear();
    inflight.clear();
    attrRecords.length = 0;
    seenAttrs = new WeakMap();
    queuedTotal = 0;
    failCount = 0;
    localCache.clear();
    state.done = 0;
    state.pending = 0;
    ui?.bubble.classList.remove("show");
    reportStatus();
  }

  function togglePause() {
    if (!state.enabled) return;
    state.pausedByUser = !state.pausedByUser;
    state.paused = state.pausedByUser || (state.pauseOnHidden && document.hidden);
    if (!state.paused) schedulePump();
    reportStatus();
  }

  function retryTranslate() {
    state.error = "";
    failCount = 0;
    if (!state.enabled) {
      startTranslate();
      return;
    }
    state.paused = state.pausedByUser;
    state.phase = "running";
    schedulePump();
    reportStatus();
  }

  function scheduleVisibleScan() {
    if (!state.enabled || state.paused) return;
    clearTimeout(visibleTimer);
    visibleTimer = setTimeout(() => {
      visibleTimer = 0;
      boxMemo = new WeakMap();
      scanAndQueue(true);
    }, 180);
  }

  function scanAndQueue(nearbyOnly) {
    if (!state.enabled || state.paused) return;
    boxMemo = new WeakMap();
    const root = document.body || document.documentElement;
    if (!root) return;
    enqueue(collectTextNodes(root, nearbyOnly));
    if (state.translateAttrs) enqueueAttrs(collectAttrTargets(root));
  }

  function observeRoot(root) {
    if (!observer || !root || observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true
    });
  }

  function watchShadows(root) {
    if (!root) return;
    if (root.id !== "atp-root" && root.shadowRoot) {
      observeRoot(root.shadowRoot);
      watchShadows(root.shadowRoot);
    }
    root.querySelectorAll?.("*")?.forEach((el) => {
      if (el.id === "atp-root" || !el.shadowRoot) return;
      observeRoot(el.shadowRoot);
      watchShadows(el.shadowRoot);
    });
  }

  function startObserver() {
    stopObserver();
    observedRoots = new WeakSet();
    observer = new MutationObserver((mutations) => {
      if (mutating || !state.enabled || state.paused) return;
      const found = [];
      const attrs = [];
      for (const m of mutations) {
        if (shouldIgnoreNode(m.target)) continue;
        if (m.type === "characterData") {
          const node = m.target;
          if (node.nodeType !== Node.TEXT_NODE) continue;
          if (!visibleBox(node.parentElement)) continue;
          const rec = records.get(node);
          if (rec && node.nodeValue !== rec.original && node.nodeValue !== rec.translated) {
            rec.original = node.nodeValue;
            rec.status = "idle";
            records.set(node, rec);
            found.push(node);
          } else if (!rec) {
            found.push(node);
          }
        } else if (m.addedNodes && m.addedNodes.length) {
          m.addedNodes.forEach((n) => {
            if (shouldIgnoreNode(n)) return;
            if (n.nodeType === Node.TEXT_NODE) found.push(n);
            else if (n.nodeType === Node.ELEMENT_NODE) {
              watchShadows(n);
              found.push(...collectTextNodes(n));
              if (state.translateAttrs) attrs.push(...collectAttrTargets(n));
            }
          });
        }
      }
      if (found.length || attrs.length) {
        mutationBuffer.push(...found);
        pendingAttrs.push(...attrs);
        clearTimeout(startObserver._t);
        startObserver._t = setTimeout(() => {
          const nodes = mutationBuffer;
          const attrItems = pendingAttrs;
          mutationBuffer = [];
          pendingAttrs = [];
          enqueue(nodes);
          if (attrItems.length) enqueueAttrs(attrItems);
        }, 280);
      }
    });
    observeRoot(document.documentElement);
    watchShadows(document.documentElement);
    attrObserver?.disconnect();
    attrObserver = new MutationObserver(() => scheduleVisibleScan());
    attrObserver.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open", "aria-hidden", "inert"]
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    attrObserver?.disconnect();
    attrObserver = null;
    clearTimeout(visibleTimer);
    visibleTimer = 0;
    observedRoots = new WeakSet();
    mutationBuffer = [];
    pendingAttrs = [];
    clearTimeout(startObserver._t);
  }

  function applySettings(s) {
    settingsCache = s;
    state.bilingual = Boolean(s.bilingual);
    state.hoverOriginal = s.hoverOriginal !== false;
    state.skipIfTarget = s.skipIfTarget !== false;
    state.skipCode = s.skipCode !== false;
    state.targetLang = s.targetLang || "简体中文";
    state.batchSize = Number(s.batchSize) || 12;
    state.maxChars = Number(s.maxChars) || 2400;
    state.minChars = Number(s.minChars) || 2;
    state.maxNodes = Number(s.maxNodes) || 5000;
    state.translateTitle = s.translateTitle !== false;
    state.translateAttrs = Boolean(s.translateAttrs);
    state.inputButton = s.inputButton !== false;
    state.pauseOnHidden = s.pauseOnHidden !== false;
    state.autoRetry = s.autoRetry !== false;
    state.chipPosition = s.chipPosition || "bottom-right";
    state.model = s.model || "";
    state.glossary = s.glossary || "";
    state.customPrompt = s.customPrompt || "";
    state.jsonMode = Boolean(s.jsonMode);
    state.skipSelectors = parseSelectorList(s.skipSelectors);
    if (ui) renderChip(ui, state);
    return s;
  }

  async function loadSettings() {
    return applySettings(await getSettings());
  }

  function currentHost() {
    try {
      return location.hostname;
    } catch {
      return "";
    }
  }

  function isExcluded(s) {
    return hostMatches(currentHost(), s?.excludeOrigins || []);
  }

  async function startTranslate() {
    const s = await loadSettings();
    if (isExcluded(s)) {
      state.error = "当前网站已加入永不翻译列表";
      state.phase = "error";
      state.enabled = false;
      ensureUI();
      reportStatus();
      return;
    }
    if (state.enabled) {
      state.paused = state.pausedByUser || (state.pauseOnHidden && document.hidden);
      state.chipHidden = false;
      scanAndQueue(true);
      schedulePump();
      reportStatus();
      return;
    }
    state.enabled = true;
    state.paused = state.pauseOnHidden && document.hidden;
    state.pausedByUser = false;
    state.phase = "running";
    state.error = "";
    state.chipHidden = false;
    queuedTotal = 0;
    failCount = 0;
    ensureUI();
    startHeartbeat();
    startObserver();
    scanAndQueue(true);
    schedulePump();
    if (state.translateTitle && document.title && !shouldSkipText(document.title, skipOptions())) {
      titleOriginal = titleOriginal || document.title;
      requestTranslate([document.title])
        .then((arr) => {
          if (arr[0] && state.enabled) document.title = arr[0];
        })
        .catch(() => {});
    }
    reportStatus();
    setTimeout(() => {
      if (state.enabled) scanAndQueue(true);
    }, 400);
    setTimeout(() => {
      if (state.enabled) scanAndQueue(false);
    }, 900);
  }

  function selectionPoint() {
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) return { x: r.left, y: r.bottom + 8, range: sel.getRangeAt(0).cloneRange() };
    }
    return { x: 24, y: 24, range: null };
  }

  function showSelectionBubble(text) {
    ensureUI();
    const pos = selectionPoint();
    lastRange = pos.range;
    lastBubbleText = "";
    placeBubble(ui, pos.x, pos.y);
    ui.btext.textContent = "翻译中…";
    requestTranslate([text])
      .then((arr) => {
        lastBubbleText = arr[0] || "";
        ui.btext.textContent = lastBubbleText;
      })
      .catch((err) => {
        ui.btext.textContent = err.message || "翻译失败";
      });
  }

  function replaceSelection() {
    if (!lastRange || !lastBubbleText) return;
    try {
      lastRange.deleteContents();
      lastRange.insertNode(document.createTextNode(lastBubbleText));
    } catch {
      /* 选区已失效 */
    }
  }

  function isEditable(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest?.("#atp-root")) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      return ["text", "search", "url", "email", ""].includes(t) && !el.readOnly && !el.disabled;
    }
    return el.isContentEditable;
  }

  function editableText(el) {
    if (!el) return "";
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el.value || "";
    return el.innerText || el.textContent || "";
  }

  function setEditableText(el, text) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function translateFocusedInput() {
    const el = focusedInput || document.activeElement;
    if (!isEditable(el)) return { ok: false, error: "当前没有可翻译的输入框" };
    const text = editableText(el).trim();
    if (!text) return { ok: false, error: "输入框是空的" };
    await loadSettings();
    const [translated] = await requestTranslate([text]);
    if (translated) setEditableText(el, translated);
    return { ok: true };
  }

  function onSettingsChanged(next) {
    const prev = {
      lang: state.targetLang,
      bilingual: state.bilingual,
      skipCode: state.skipCode,
      attrs: state.translateAttrs,
      model: state.model,
      glossary: state.glossary,
      prompt: state.customPrompt,
      jsonMode: state.jsonMode
    };
    applySettings({ ...settingsCache, ...next });
    if (isExcluded({ ...settingsCache, ...next }) && state.enabled) {
      restoreAll();
      return;
    }
    const needRestart =
      state.enabled &&
      (prev.lang !== state.targetLang ||
        prev.bilingual !== state.bilingual ||
        prev.skipCode !== state.skipCode ||
        prev.attrs !== state.translateAttrs ||
        prev.model !== state.model ||
        prev.glossary !== state.glossary ||
        prev.prompt !== state.customPrompt ||
        prev.jsonMode !== state.jsonMode);
    if (needRestart) {
      restoreAll();
      startTranslate();
    }
  }

  document.addEventListener("mousemove", (e) => {
    if (!state.enabled || !state.hoverOriginal || state.bilingual) {
      hideTooltip(ui);
      return;
    }
    ensureUI();
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = range?.startContainer;
    const rec = node && records.get(node);
    if (rec?.original && rec.translated && rec.original.trim() !== rec.translated.trim()) {
      showTooltip(ui, rec.original.trim(), e.clientX + 12, e.clientY + 16);
    } else {
      hideTooltip(ui);
    }
  }, { passive: true });

  document.addEventListener("scroll", () => {
    if (!state.enabled || state.paused) return;
    scheduleVisibleScan();
  }, { passive: true, capture: true });
  window.addEventListener("resize", () => {
    if (state.enabled) scheduleVisibleScan();
  }, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (!state.enabled || !state.pauseOnHidden) return;
    state.paused = state.pausedByUser || document.hidden;
    if (!state.paused) schedulePump();
    reportStatus();
  });

  document.addEventListener("focusin", (e) => {
    if (!state.inputButton) {
      if (ui) showInputButton(ui, null);
      return;
    }
    const el = e.target;
    if (!isEditable(el)) {
      focusedInput = null;
      if (ui) showInputButton(ui, null);
      return;
    }
    focusedInput = el;
    ensureUI();
    showInputButton(ui, el.getBoundingClientRect());
  });

  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!isEditable(document.activeElement)) {
        focusedInput = null;
        if (ui) showInputButton(ui, null);
      }
    }, 200);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "GET_STATUS") {
      sendResponse(snapshotStatus());
      return false;
    }
    if (message?.type === "START") {
      startTranslate().then(() => sendResponse({ ok: true })).catch((err) => {
        sendResponse({ ok: false, error: err.message });
      });
      return true;
    }
    if (message?.type === "RESTORE") {
      restoreAll();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "PAUSE") {
      togglePause();
      sendResponse({ ok: true, paused: state.paused });
      return false;
    }
    if (message?.type === "RETRY") {
      retryTranslate();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "TOGGLE") {
      if (state.enabled) {
        restoreAll();
        sendResponse({ ok: true, enabled: false });
      } else {
        startTranslate().then(() => sendResponse({ ok: true, enabled: true })).catch((err) => {
          sendResponse({ ok: false, error: err.message });
        });
        return true;
      }
      return false;
    }
    if (message?.type === "TRANSLATE_SELECTION") {
      const text = (message.text || window.getSelection()?.toString() || "").trim();
      if (!text) {
        sendResponse({ ok: false, error: "没有选中文本" });
        return false;
      }
      loadSettings().then(() => {
        showSelectionBubble(text);
        sendResponse({ ok: true });
      });
      return true;
    }
    if (message?.type === "TRANSLATE_INPUT") {
      translateFocusedInput()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (message?.type === "SETTINGS_UPDATED") {
      loadSettings().then((s) => {
        onSettingsChanged(s);
        sendResponse({ ok: true });
      });
      return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const next = changes.settings.newValue;
    if (!next) return;
    onSettingsChanged(next);
  });

  loadSettings().then((s) => {
    if (isExcluded(s)) return;
    const host = currentHost();
    if (Array.isArray(s.autoOrigins) && hostMatches(host, s.autoOrigins)) {
      startTranslate();
    }
  }).catch(() => {});
}
