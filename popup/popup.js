import { DEFAULT_SETTINGS, LANGUAGES } from "../shared/constants.js";
import { hostMatches, hostnameOf, withoutRelatedHosts } from "../shared/site.js";
import { getSettings, saveSettings } from "../shared/storage.js";

const $ = (id) => document.getElementById(id);

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderStatus(status, fallback) {
  const el = $("status");
  const bar = $("progress");
  el.classList.remove("err");
  bar.classList.add("hidden");
  if (!status) {
    el.textContent = fallback || "就绪";
    return;
  }
  if (status.error) {
    el.classList.add("err");
    el.textContent = status.error;
    return;
  }
  if (status.enabled && status.paused) {
    el.textContent = "已暂停";
    return;
  }
  if (status.enabled && status.pending > 0) {
    const total = (status.done || 0) + status.pending;
    el.textContent = `翻译中：已完成 ${status.done}，剩余 ${status.pending}`;
    bar.classList.remove("hidden");
    bar.firstElementChild.style.width = `${Math.round((status.done / total) * 100)}%`;
    return;
  }
  if (status.enabled) {
    el.textContent = `本页已翻译 ${status.done} 段`;
    return;
  }
  el.textContent = fallback || "就绪";
}

async function refreshTabStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_TAB_STATUS" });
    renderStatus(res?.status);
    const paused = Boolean(res?.status?.paused);
    $("pause").textContent = paused ? "继续" : "暂停";
  } catch {
    /* 后台未就绪时保持当前文案 */
  }
}

async function persist(patch) {
  try {
    await saveSettings(patch);
  } catch (err) {
    $("status").classList.add("err");
    $("status").textContent = err?.message || "设置未能保存";
  }
}

async function run(payload) {
  $("status").classList.remove("err");
  $("status").textContent = "处理中…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "RUN_ON_TAB", payload });
    if (!res?.ok) {
      $("status").classList.add("err");
      $("status").textContent = res?.error || "无法在当前页面运行";
      return;
    }
    await refreshTabStatus();
  } catch (err) {
    $("status").classList.add("err");
    $("status").textContent = err?.message || "无法在当前页面运行";
  }
}

async function init() {
  let settings = { ...DEFAULT_SETTINGS };
  try {
    settings = await getSettings();
  } catch {
    /* 非扩展环境时用默认值渲染弹窗 */
  }
  let tab = null;
  try {
    tab = await currentTab();
  } catch {
    tab = null;
  }
  const host = hostnameOf(tab?.url || "");
  const configured = Boolean(settings.baseUrl && settings.model && (settings.apiKey || /127\.0\.0\.1|localhost/i.test(settings.baseUrl)));
  const preview = !globalThis.chrome?.storage;

  $("setup").classList.toggle("hidden", configured || preview);
  $("main").classList.toggle("hidden", !configured && !preview);

  const lang = $("lang");
  lang.innerHTML = LANGUAGES.map((item) => `<option value="${item.id}">${item.label}</option>`).join("");
  lang.value = settings.targetLang;
  $("bilingual").checked = Boolean(settings.bilingual);
  $("hover").checked = settings.hoverOriginal !== false;
  $("auto").checked = host ? hostMatches(host, settings.autoOrigins || []) : false;
  $("exclude").checked = host ? hostMatches(host, settings.excludeOrigins || []) : false;
  $("auto").disabled = !host;
  $("exclude").disabled = !host;

  $("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

  lang.addEventListener("change", async () => {
    await persist({ targetLang: lang.value });
  });

  $("bilingual").addEventListener("change", async () => {
    await persist({ bilingual: $("bilingual").checked });
  });
  $("hover").addEventListener("change", async () => {
    await persist({ hoverOriginal: $("hover").checked });
  });
  $("auto").addEventListener("change", async () => {
    if (!host) return;
    if ($("auto").checked) {
      $("exclude").checked = false;
      settings.excludeOrigins = withoutRelatedHosts(settings.excludeOrigins, host);
      settings.autoOrigins = [...withoutRelatedHosts(settings.autoOrigins, host), host];
    } else {
      settings.autoOrigins = withoutRelatedHosts(settings.autoOrigins, host);
    }
    await persist({ autoOrigins: settings.autoOrigins, excludeOrigins: settings.excludeOrigins });
  });
  $("exclude").addEventListener("change", async () => {
    if (!host) return;
    if ($("exclude").checked) {
      $("auto").checked = false;
      settings.autoOrigins = withoutRelatedHosts(settings.autoOrigins, host);
      settings.excludeOrigins = [...withoutRelatedHosts(settings.excludeOrigins, host), host];
    } else {
      settings.excludeOrigins = withoutRelatedHosts(settings.excludeOrigins, host);
    }
    await persist({ autoOrigins: settings.autoOrigins, excludeOrigins: settings.excludeOrigins });
  });

  $("translate").addEventListener("click", () => run({ type: "START" }));
  $("restore").addEventListener("click", () => run({ type: "RESTORE" }));
  $("pause").addEventListener("click", () => run({ type: "PAUSE" }));
  $("retry").addEventListener("click", () => run({ type: "RETRY" }));
  $("selection").addEventListener("click", () => run({ type: "TRANSLATE_SELECTION" }));
  $("input").addEventListener("click", () => run({ type: "TRANSLATE_INPUT" }));

  if (configured) {
    await refreshTabStatus();
    setInterval(refreshTabStatus, 800);
  }
}

init();
