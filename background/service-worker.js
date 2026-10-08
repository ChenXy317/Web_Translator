import { parseGlossary, applyExactGlossary, emptyToOriginal } from "../shared/text.js";
import { cacheKey, getCacheStore, getSettings, putCacheEntries } from "../shared/storage.js";
import { listModels, testConnection, translateReliably, withRetries } from "../shared/openai.js";
import { isTranslatableUrl } from "../shared/site.js";

const tabState = new Map();
let inflight = 0;
const waiters = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_INFLIGHT = 1;

async function limit(fn) {
  while (inflight >= MAX_INFLIGHT) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
    waiters.shift()?.();
  }
}

async function translateWithCache(texts, settings) {
  const store = await getCacheStore();
  const glossary = parseGlossary(settings.glossary);
  const results = new Array(texts.length);
  const pending = [];

  await Promise.all(
    texts.map(async (text, index) => {
      const exact = applyExactGlossary(text, glossary);
      if (exact != null) {
        results[index] = exact;
        return;
      }
      const key = await cacheKey(text, settings);
      const hit = store.items[key]?.value;
      if (typeof hit === "string") {
        results[index] = hit;
      } else {
        pending.push({ text, index, key });
      }
    })
  );

  if (!pending.length) return results;

  const unique = [];
  const uniqueIndex = new Map();
  for (const item of pending) {
    if (!uniqueIndex.has(item.text)) {
      uniqueIndex.set(item.text, unique.length);
      unique.push(item.text);
    }
  }

  const translated = await limit(() =>
    withRetries(async (attempt) => {
      try {
        return await translateReliably(unique, settings);
      } catch (err) {
        if (attempt === 0 && /无法解析|JSON/.test(err.message || "")) {
          return translateReliably(unique, {
            ...settings,
            jsonMode: true,
            customPrompt: `${settings.customPrompt || ""}\n只输出 JSON 对象 {"translations":["译文1","译文2"]}。`.trim()
          });
        }
        throw err;
      }
    })
  );

  const fresh = [];
  pending.forEach((item) => {
    const value = emptyToOriginal(translated[uniqueIndex.get(item.text)], item.text);
    results[item.index] = value;
    fresh.push([item.key, value]);
  });
  await putCacheEntries(fresh);
  return results;
}

function setBadge(tabId, text, color = "#0f766e") {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: text || "" });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return Boolean(res?.ok);
  } catch {
    return false;
  }
}

async function ensureContent(tabId) {
  if (await pingTab(tabId)) return;
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content/page.css"]
  }).catch(() => {});
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/content.js"]
  });
  for (let i = 0; i < 25; i += 1) {
    if (await pingTab(tabId)) return;
    await sleep(50);
  }
  throw new Error("无法在此页面注入翻译脚本");
}

async function sendToTab(tabId, message) {
  await ensureContent(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "atp-page",
      title: "翻译整个页面",
      contexts: ["page"]
    });
    chrome.contextMenus.create({
      id: "atp-selection",
      title: "翻译选中文本",
      contexts: ["selection"]
    });
    chrome.contextMenus.create({
      id: "atp-input",
      title: "翻译输入框内容",
      contexts: ["editable"]
    });
    chrome.contextMenus.create({
      id: "atp-restore",
      title: "显示原文",
      contexts: ["page"]
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "atp-page") {
    await sendToTab(tab.id, { type: "START" });
  } else if (info.menuItemId === "atp-restore") {
    await sendToTab(tab.id, { type: "RESTORE" });
  } else if (info.menuItemId === "atp-selection") {
    await sendToTab(tab.id, { type: "TRANSLATE_SELECTION", text: info.selectionText || "" });
  } else if (info.menuItemId === "atp-input") {
    await sendToTab(tab.id, { type: "TRANSLATE_INPUT" });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id) return;
  if (command === "toggle-translate") {
    await sendToTab(tab.id, { type: "TOGGLE" });
  } else if (command === "translate-selection") {
    await sendToTab(tab.id, { type: "TRANSLATE_SELECTION" });
  } else if (command === "translate-input") {
    await sendToTab(tab.id, { type: "TRANSLATE_INPUT" });
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "atp") return;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "ping") {
      port.postMessage({ type: "pong" });
      return;
    }
    if (msg?.type !== "translate") return;
    try {
      const settings = await getSettings();
      if (!settings.baseUrl || !settings.model) {
        throw new Error("请先在设置中填写 Base URL 和模型名");
      }
      if (!settings.apiKey && !/127\.0\.0\.1|localhost/i.test(settings.baseUrl)) {
        throw new Error("请先在设置中填写 API Key");
      }
      const translations = await translateWithCache(msg.texts || [], settings);
      port.postMessage({ id: msg.id, ok: true, translations });
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: err?.message || String(err) });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  const reply = (fn) => {
    Promise.resolve()
      .then(fn)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  };

  if (message?.type === "GET_SETTINGS") {
    return reply(async () => ({ ok: true, settings: await getSettings() }));
  }

  if (message?.type === "STATUS") {
    if (tabId != null) {
      tabState.set(tabId, message.status || {});
      const st = message.status || {};
      if (st.enabled && st.phase === "error") setBadge(tabId, "!", "#b91c1c");
      else if (st.enabled && st.paused) setBadge(tabId, "||", "#b45309");
      else if (st.enabled && st.pending > 0) {
        const n = Math.min(st.pending, 99);
        setBadge(tabId, String(n), "#0f766e");
      } else if (st.enabled) setBadge(tabId, "ON", "#0f766e");
      else setBadge(tabId, "");
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "GET_TAB_STATUS") {
    return reply(async () => {
      const tab = message.tabId ? { id: message.tabId } : await activeTab();
      if (!tab?.id) return { ok: true, status: null };
      try {
        const status = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" });
        return { ok: true, status };
      } catch {
        return { ok: true, status: tabState.get(tab.id) || null };
      }
    });
  }

  if (message?.type === "RUN_ON_TAB") {
    return reply(async () => {
      const tab = await activeTab();
      if (!tab?.id) throw new Error("没有活动标签页");
      if (tab.url && !isTranslatableUrl(tab.url)) {
        throw new Error("当前页面无法翻译（仅支持 http/https/file）");
      }
      const result = await sendToTab(tab.id, message.payload);
      return { ok: true, result };
    });
  }

  if (message?.type === "TEST_CONNECTION") {
    return reply(async () => {
      const settings = { ...(await getSettings()), ...(message.settings || {}) };
      const result = await testConnection(settings);
      return { ok: true, ...result };
    });
  }

  if (message?.type === "LIST_MODELS") {
    return reply(async () => {
      const settings = { ...(await getSettings()), ...(message.settings || {}) };
      const models = await listModels(settings);
      return { ok: true, models };
    });
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  tabState.delete(tabId);
  setBadge(tabId, "");
});
