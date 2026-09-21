import { CACHE_LIMIT, CACHE_VERSION, DEFAULT_SETTINGS } from "./constants.js";
import { fingerprint, pruneCacheStore } from "./text.js";

export async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const settings = { ...current, ...patch };
  await chrome.storage.local.set({ settings });
  return settings;
}

function emptyCache() {
  return { v: CACHE_VERSION, items: {} };
}

export async function getCacheStore() {
  const { translationCache } = await chrome.storage.local.get("translationCache");
  if (!translationCache || typeof translationCache !== "object") return emptyCache();
  if (translationCache.v === CACHE_VERSION && translationCache.items && typeof translationCache.items === "object") {
    return translationCache;
  }
  return emptyCache();
}

export async function putCacheEntries(entries) {
  if (!entries.length) return;
  const cache = await getCacheStore();
  const now = Date.now();
  for (const [key, value] of entries) {
    cache.items[key] = { value, at: now };
  }
  pruneCacheStore(cache.items, CACHE_LIMIT);
  await chrome.storage.local.set({ translationCache: cache });
}

export async function clearCache() {
  await chrome.storage.local.remove("translationCache");
}

export async function cacheCount() {
  const cache = await getCacheStore();
  return Object.keys(cache.items).length;
}

export async function cacheKey(text, settings) {
  return fingerprint(
    [
      settings.model || "",
      settings.targetLang || "",
      settings.temperature ?? "",
      settings.customPrompt || "",
      settings.glossary || "",
      settings.jsonMode ? "json" : "plain",
      text
    ].join("\u0001")
  );
}
