import { CHIP_POSITIONS, DEFAULT_SETTINGS, LANGUAGES, PRESETS } from "../shared/constants.js";
import { cacheCount, clearCache, getSettings, saveSettings } from "../shared/storage.js";
import { parseJsonObject } from "../shared/openai.js";
import { parseHostList } from "../shared/site.js";

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = [
  "preset", "baseUrl", "apiKey", "model", "extraHeaders", "extraBody",
  "targetLang", "customPrompt", "chipPosition", "skipSelectors", "glossary"
];
const NUM_FIELDS = ["batchSize", "maxChars", "minChars", "maxNodes", "temperature", "timeoutMs"];
const CHECK_FIELDS = [
  "bilingual", "hoverOriginal", "skipIfTarget", "skipCode",
  "translateTitle", "translateAttrs", "inputButton", "pauseOnHidden", "autoRetry", "jsonMode"
];

function formValues() {
  const values = {};
  for (const id of TEXT_FIELDS) values[id] = $(id).value;
  values.baseUrl = values.baseUrl.trim();
  values.apiKey = values.apiKey.trim();
  values.model = values.model.trim();
  values.extraHeaders = values.extraHeaders.trim();
  values.extraBody = values.extraBody.trim();
  for (const id of NUM_FIELDS) values[id] = Number($(id).value);
  for (const id of CHECK_FIELDS) values[id] = $(id).checked;
  values.autoOrigins = parseHostList($("autoOrigins").value);
  values.excludeOrigins = parseHostList($("excludeOrigins").value);
  values.batchSize = values.batchSize || 12;
  values.maxChars = values.maxChars || 2400;
  values.minChars = values.minChars || 2;
  values.maxNodes = values.maxNodes || 5000;
  values.timeoutMs = values.timeoutMs || 60000;
  return values;
}

function fill(settings) {
  for (const id of TEXT_FIELDS) $(id).value = settings[id] ?? "";
  for (const id of NUM_FIELDS) $(id).value = settings[id];
  for (const id of CHECK_FIELDS) $(id).checked = Boolean(settings[id]);
  $("hoverOriginal").checked = settings.hoverOriginal !== false;
  $("skipIfTarget").checked = settings.skipIfTarget !== false;
  $("skipCode").checked = settings.skipCode !== false;
  $("translateTitle").checked = settings.translateTitle !== false;
  $("inputButton").checked = settings.inputButton !== false;
  $("pauseOnHidden").checked = settings.pauseOnHidden !== false;
  $("autoRetry").checked = settings.autoRetry !== false;
  $("autoOrigins").value = (settings.autoOrigins || []).join("\n");
  $("excludeOrigins").value = (settings.excludeOrigins || []).join("\n");
}

function setMsg(id, text, cls) {
  const el = $(id);
  el.className = `hint ${cls || ""}`;
  el.textContent = text;
}

function validateExtras(values) {
  try {
    parseJsonObject(values.extraHeaders, {});
  } catch {
    throw new Error("额外请求头必须是 JSON 对象");
  }
  try {
    parseJsonObject(values.extraBody, {});
  } catch {
    throw new Error("额外请求体必须是 JSON 对象");
  }
}

async function refreshCacheInfo() {
  const n = await cacheCount();
  $("cache-info").textContent = `本机译文缓存 ${n} 条（上限 1200，仅保存哈希与译文）。`;
}

async function init() {
  $("preset").innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  $("targetLang").innerHTML = LANGUAGES.map((l) => `<option value="${l.id}">${l.label}</option>`).join("");
  $("chipPosition").innerHTML = CHIP_POSITIONS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("");
  let settings = { ...DEFAULT_SETTINGS };
  try {
    settings = await getSettings();
  } catch {
    /* 非扩展环境时用默认值渲染表单 */
  }
  fill(settings);
  try {
    await refreshCacheInfo();
  } catch {
    $("cache-info").textContent = "";
  }

  $("preset").addEventListener("change", () => {
    const preset = PRESETS.find((p) => p.id === $("preset").value);
    if (!preset || preset.id === "custom") return;
    $("baseUrl").value = preset.baseUrl;
    $("model").value = preset.model;
    if (preset.extraHeaders) $("extraHeaders").value = preset.extraHeaders;
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = formValues();
    try {
      validateExtras(values);
      await saveSettings(values);
      setMsg("save-msg", "已保存，仅存放在本机浏览器。", "ok");
    } catch (err) {
      setMsg("save-msg", err.message || "保存失败", "err");
    }
  });

  $("test").addEventListener("click", async () => {
    const values = formValues();
    setMsg("test-result", "正在请求…");
    try {
      validateExtras(values);
      await saveSettings(values);
      const res = await chrome.runtime.sendMessage({ type: "TEST_CONNECTION", settings: values });
      if (!res?.ok) throw new Error(res?.error || "测试失败");
      setMsg("test-result", `成功 · ${res.ms}ms · 模型 ${res.model} · 返回 ${res.sample || "(空)"}`, "ok");
    } catch (err) {
      setMsg("test-result", err.message || "测试失败", "err");
    }
  });

  $("load-models").addEventListener("click", async () => {
    const values = formValues();
    setMsg("test-result", "正在拉取模型列表…");
    try {
      validateExtras(values);
      const res = await chrome.runtime.sendMessage({ type: "LIST_MODELS", settings: values });
      if (!res?.ok) throw new Error(res?.error || "拉取失败");
      const list = $("model-list");
      list.replaceChildren(
        ...(res.models || []).map((id) => {
          const opt = document.createElement("option");
          opt.value = String(id);
          return opt;
        })
      );
      setMsg("test-result", `已写入 ${res.models?.length || 0} 个模型到下拉建议`, "ok");
    } catch (err) {
      setMsg("test-result", err.message || "该接口可能不支持 /models", "err");
    }
  });

  $("clear-cache").addEventListener("click", async () => {
    await clearCache();
    await refreshCacheInfo();
    setMsg("save-msg", "译文缓存已清空。", "ok");
  });

  $("export").addEventListener("click", async () => {
    const settings = await getSettings();
    const blob = new Blob([JSON.stringify({ app: "即译", version: 1, settings }, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "jiyi-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    setMsg("save-msg", "已导出当前设置（含 API Key）。", "ok");
  });

  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = data.settings || data;
      if (!incoming || typeof incoming !== "object") throw new Error("文件格式不正确");
      const merged = await saveSettings(incoming);
      fill(merged);
      setMsg("save-msg", "已导入并保存。", "ok");
    } catch (err) {
      setMsg("save-msg", err.message || "导入失败", "err");
    }
  });
}

init();
