import { parseGlossary, glossaryPrompt } from "./text.js";

/** 规范化 OpenAI 兼容接口的根路径。 */
export function normalizeBaseUrl(url) {
  let u = String(url || "").trim();
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/(chat\/)?completions$/i, "");
  return u;
}

export function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function modelsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function parseJsonObject(raw, fallback = {}) {
  const text = String(raw || "").trim();
  if (!text) return fallback;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    throw new Error("JSON 格式不正确");
  }
  throw new Error("必须是 JSON 对象");
}

export function defaultSystemPrompt(targetLang) {
  return [
    `你是网页翻译引擎，把用户给出的内容译为「${targetLang}」。`,
    "只返回译文数据，长度和顺序必须与输入完全一致。",
    "保留 URL、邮箱、文件路径、代码、HTML 实体、%s / {name} / {{var}} 等占位符、数字与常见品牌名。",
    "保留原有换行。专有名词可保留原文。已是目标语言的条目原样返回。",
    "不要解释，不要 Markdown，不要包代码围栏。"
  ].join("\n");
}

export function buildSystemPrompt(settings) {
  const base = settings.customPrompt?.trim() || defaultSystemPrompt(settings.targetLang);
  const extra = glossaryPrompt(parseGlossary(settings.glossary));
  const jsonHint = settings.jsonMode
    ? '返回 JSON 对象：{"translations":["译文1","译文2"]}。'
    : "优先返回 JSON 数组，例如 [\"译文1\",\"译文2\"]。";
  return extra ? `${base}\n${jsonHint}\n${extra}` : `${base}\n${jsonHint}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function stripReasoning(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

export function repairJsonLike(text) {
  let s = stripReasoning(text);
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/[“”]/g, '"');
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s.trim();
}

function extractMessageText(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (typeof msg?.content === "string" && msg.content.trim()) return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "thinking" || part?.type === "reasoning") return "";
        return part?.text || part?.content || "";
      })
      .join("");
  }
  if (typeof choice?.text === "string") return choice.text;
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof msg?.reasoning_content === "string") return "";
  return "";
}

function extractJsonArray(text) {
  const raw = repairJsonLike(text);
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : raw;

  const tryParse = (s) => {
    const value = JSON.parse(s);
    if (Array.isArray(value)) return value.map((item) => String(item ?? ""));
    if (value && typeof value === "object") {
      const list = value.translations || value.items || value.data || value.result || value.t;
      if (Array.isArray(list)) return list.map((item) => String(item ?? ""));
    }
    throw new Error("not-array");
  };

  try {
    return tryParse(body);
  } catch {
    const start = body.indexOf("[");
    const end = body.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return tryParse(body.slice(start, end + 1));
      } catch {
        /* 继续尝试对象 */
      }
    }
    const oStart = body.indexOf("{");
    const oEnd = body.lastIndexOf("}");
    if (oStart >= 0 && oEnd > oStart) {
      return tryParse(body.slice(oStart, oEnd + 1));
    }
  }
  throw new Error("模型未返回 JSON 数组");
}

function parseNumbered(text, expected) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[\.\)、]\s*/, "").trim())
    .filter(Boolean);
  if (lines.length === expected) return lines;
  return null;
}

function parseDelimited(text, expected) {
  const re = /<<<(\d+)>>>\s*([\s\S]*?)(?=<<<\d+>>>|$)/g;
  const found = new Map();
  let m;
  while ((m = re.exec(String(text || ""))) !== null) {
    found.set(Number(m[1]), m[2].replace(/\s+$/, ""));
  }
  if (found.size !== expected) return null;
  const out = [];
  for (let i = 0; i < expected; i += 1) {
    if (!found.has(i)) return null;
    out.push(found.get(i));
  }
  return out;
}

export function parseTranslations(content, expected) {
  const cleaned = stripReasoning(content);
  try {
    const arr = extractJsonArray(cleaned);
    if (arr.length === expected) return arr;
    if (arr.length > expected) return arr.slice(0, expected);
  } catch {
    const numbered = parseNumbered(cleaned, expected);
    if (numbered) return numbered;
    const delimited = parseDelimited(cleaned, expected);
    if (delimited) return delimited;
  }
  if (expected === 1 && cleaned.trim()) {
    return [cleaned.trim()];
  }
  throw new Error("无法解析模型返回的译文");
}

export async function requestChatCompletions({
  baseUrl,
  apiKey,
  model,
  messages,
  temperature,
  extraHeaders,
  extraBody,
  timeoutMs,
  maxTokens,
  jsonMode
}) {
  const headers = {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...parseJsonObject(extraHeaders, {})
  };
  const extra = parseJsonObject(extraBody, {});
  delete extra.max_tokens;
  delete extra.stream;
  const body = {
    model,
    messages,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
    ...extra,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    stream: false
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 60000);
  let res;
  try {
    res = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("请求超时");
    throw new Error(err?.message || "网络请求失败");
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!res.ok) {
    const retryAfter = res.headers?.get?.("retry-after") || "";
    if (res.status === 429) {
      const error = new Error("请求过于频繁，请稍后再试");
      error.status = 429;
      error.retryAfter = retryAfter;
      throw error;
    }
    const msg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      raw.slice(0, 240) ||
      `HTTP ${res.status}`;
    const error = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    error.status = res.status;
    error.retryAfter = retryAfter;
    throw error;
  }

  return { data, text: extractMessageText(data), raw };
}

export async function translateTexts(texts, settings) {
  const prompt = buildSystemPrompt(settings);
  const inputChars = texts.reduce((n, t) => n + t.length, 0);
  let maxTokens = Math.min(8192, Math.max(4096, Math.ceil(inputChars * 3) + 512));
  const payload = settings.jsonMode
    ? JSON.stringify({ translations: texts })
    : JSON.stringify(texts);
  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: payload }
  ];
  let { text, data } = await requestChatCompletions({
    ...settings,
    messages,
    maxTokens
  });
  if (!String(text || "").trim() && data?.choices?.[0]?.finish_reason === "length") {
    maxTokens = Math.min(8192, Math.max(maxTokens * 2, 8192));
    ({ text } = await requestChatCompletions({
      ...settings,
      messages,
      maxTokens
    }));
  }
  return parseTranslations(text, texts.length);
}

function retryWaitMs(err, attempt) {
  const raw = Number(err?.retryAfter);
  if (Number.isFinite(raw) && raw >= 0) {
    return Math.min(20000, raw * 1000);
  }
  if (err?.status === 429) return Math.min(15000, 2000 * 2 ** attempt);
  return 800 * (attempt + 1);
}

export async function withRetries(fn, { times = 4 } = {}) {
  let last;
  for (let i = 0; i < times; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      last = err;
      const status = err?.status;
      const retryable =
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 500 ||
        /超时|断开|network|Failed to fetch/i.test(err?.message || "");
      if (!retryable || i === times - 1) throw err;
      await sleep(retryWaitMs(err, i));
    }
  }
  throw last;
}

export async function listModels(settings) {
  const headers = {
    ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
    ...parseJsonObject(settings.extraHeaders, {})
  };
  const res = await fetch(modelsUrl(settings.baseUrl), { headers });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("模型列表不是 JSON");
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${res.status}`);
  }
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
  return list
    .map((item) => (typeof item === "string" ? item : item?.id))
    .filter(Boolean);
}

export async function testConnection(settings) {
  const started = Date.now();
  const messages = [
    { role: "system", content: "Reply with the single word pong." },
    { role: "user", content: "ping" }
  ];
  const timeoutMs = Math.min(settings.timeoutMs || 60000, 30000);
  let maxTokens = 256;
  let text = "";
  let data = {};
  for (let i = 0; i < 2; i += 1) {
    ({ text, data } = await requestChatCompletions({
      ...settings,
      jsonMode: false,
      messages,
      maxTokens,
      timeoutMs
    }));
    if (String(text || "").trim()) break;
    if (data?.choices?.[0]?.finish_reason === "length" && maxTokens < 4096) {
      maxTokens = 4096;
      continue;
    }
    break;
  }
  const sample = String(text || "").trim().slice(0, 80);
  if (!sample) {
    throw new Error("模型没有返回内容，请更换模型或提高输出长度后再试");
  }
  return {
    ms: Date.now() - started,
    model: data?.model || settings.model,
    sample
  };
}
