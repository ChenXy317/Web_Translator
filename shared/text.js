import { looksLikeTargetLanguage } from "./language.js";

export function splitWS(s) {
  const m = String(s).match(/^(\s*)([\s\S]*?)(\s*)$/);
  return { lead: m[1], body: m[2], trail: m[3] };
}

/** 术语表：每行「原文=译文」或「原文 => 译文」。 */
export function parseGlossary(raw) {
  const map = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.includes("=>") ? "=>" : "=";
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    const source = trimmed.slice(0, idx).trim();
    const target = trimmed.slice(idx + sep.length).trim();
    if (source && target) map.set(source, target);
  }
  return map;
}

export function glossaryPrompt(map) {
  if (!map || !map.size) return "";
  const lines = [...map.entries()].map(([k, v]) => `${k} → ${v}`);
  return `固定译法（必须遵守）：\n${lines.join("\n")}`;
}

export function applyExactGlossary(text, map) {
  if (!map || !map.size) return null;
  const hit = map.get(text);
  return typeof hit === "string" ? hit : null;
}

export function shouldSkipText(text, options = {}) {
  const body = String(text || "").trim();
  const minChars = Number(options.minChars) > 0 ? Number(options.minChars) : 2;
  if (body.length < minChars) return true;
  if (/^https?:\/\/\S+$/i.test(body)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(body)) return true;
  if (/^[\d\s.,:%+\-_/\\#]+$/.test(body)) return true;
  if (/^[\p{P}\p{S}\s]+$/u.test(body)) return true;
  if (options.skipIfTarget && looksLikeTargetLanguage(body, options.targetLang || "")) return true;
  return false;
}

/** 过长段落按句子切开，避免单次请求撑爆上下文。 */
export function chunkText(text, maxChars) {
  const value = String(text || "");
  const limit = Math.max(200, Number(maxChars) || 2400);
  if (value.length <= limit) return [value];

  const parts = [];
  const pieces = value.split(/((?<=[。！？.!?\n])\s*)/u);
  let buf = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (buf && buf.length + piece.length > limit) {
      parts.push(buf);
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf) parts.push(buf);

  const out = [];
  for (const part of parts) {
    if (part.length <= limit) {
      out.push(part);
      continue;
    }
    for (let i = 0; i < part.length; i += limit) out.push(part.slice(i, i + limit));
  }
  return out.filter(Boolean);
}

export async function fingerprint(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }
  let h = 2166136261;
  for (const b of data) {
    h ^= b;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function pruneCacheStore(store, limit) {
  const keys = Object.keys(store);
  if (keys.length <= limit) return store;
  keys
    .sort((a, b) => (store[a].at || 0) - (store[b].at || 0))
    .slice(0, keys.length - limit)
    .forEach((k) => {
      delete store[k];
    });
  return store;
}

export function emptyToOriginal(value, original) {
  const text = String(value ?? "").trim();
  return text ? String(value) : original;
}
