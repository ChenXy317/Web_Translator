/** 内置服务预设，选择后仅填充 Base URL 与模型名。 */
export const PRESETS = [
  {
    id: "xai",
    name: "SpaceXAI (xAI)",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4.5"
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    extraHeaders: '{"HTTP-Referer":"https://localhost","X-Title":"即译"}'
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat"
  },
  {
    id: "aihubmix",
    name: "AIHubMix",
    baseUrl: "https://aihubmix.com/v1",
    model: "laguna-xs-2.1-free"
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.1"
  },
  {
    id: "custom",
    name: "自定义",
    baseUrl: "",
    model: ""
  }
];

/** 目标语言，值为发给模型的自然语言名称。 */
export const LANGUAGES = [
  { id: "简体中文", label: "简体中文" },
  { id: "繁體中文", label: "繁體中文" },
  { id: "English", label: "English" },
  { id: "日本語", label: "日本語" },
  { id: "한국어", label: "한국어" },
  { id: "Français", label: "Français" },
  { id: "Deutsch", label: "Deutsch" },
  { id: "Español", label: "Español" },
  { id: "Português", label: "Português" },
  { id: "Русский", label: "Русский" },
  { id: "Italiano", label: "Italiano" },
  { id: "Tiếng Việt", label: "Tiếng Việt" },
  { id: "ไทย", label: "ไทย" },
  { id: "العربية", label: "العربية" },
  { id: "हिन्दी", label: "हिन्दी" },
  { id: "Bahasa Indonesia", label: "Bahasa Indonesia" },
  { id: "Türkçe", label: "Türkçe" },
  { id: "Polski", label: "Polski" },
  { id: "Nederlands", label: "Nederlands" }
];

export const CHIP_POSITIONS = [
  { id: "bottom-right", label: "右下角" },
  { id: "bottom-left", label: "左下角" },
  { id: "top-right", label: "右上角" },
  { id: "top-left", label: "左上角" }
];

export const TRANSLATABLE_ATTRS = ["placeholder", "alt", "title", "aria-label"];

export const BUILTIN_SKIP_SELECTORS = [
  "pre",
  "code",
  "kbd",
  "samp",
  ".blob-code",
  ".highlight",
  ".chroma",
  ".syntax",
  "[data-code-text]",
  ".cm-editor",
  ".monaco-editor",
  ".ace_editor"
];

export const DEFAULT_SETTINGS = {
  preset: "xai",
  baseUrl: "https://api.x.ai/v1",
  apiKey: "",
  model: "grok-4.5",
  extraHeaders: "",
  extraBody: "",
  targetLang: "简体中文",
  bilingual: false,
  hoverOriginal: true,
  skipIfTarget: true,
  skipCode: true,
  autoOrigins: [],
  excludeOrigins: [],
  skipSelectors: "",
  glossary: "",
  batchSize: 12,
  maxChars: 2400,
  minChars: 2,
  maxNodes: 5000,
  temperature: 0.2,
  customPrompt: "",
  timeoutMs: 60000,
  translateTitle: true,
  translateAttrs: false,
  inputButton: true,
  pauseOnHidden: true,
  autoRetry: true,
  jsonMode: false,
  chipPosition: "bottom-right"
};

export const CACHE_LIMIT = 1200;
export const CACHE_VERSION = 2;
