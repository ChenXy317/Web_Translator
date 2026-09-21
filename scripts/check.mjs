import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSystemPrompt,
  chatCompletionsUrl,
  normalizeBaseUrl,
  parseJsonObject,
  parseTranslations,
  repairJsonLike,
  stripReasoning
} from "../shared/openai.js";
import { looksLikeTargetLanguage } from "../shared/language.js";
import {
  applyExactGlossary,
  chunkText,
  parseGlossary,
  pruneCacheStore,
  shouldSkipText,
  splitWS
} from "../shared/text.js";
import { hostMatches, isTranslatableUrl, parseHostList, withoutRelatedHosts } from "../shared/site.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(cond, message) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", message);
  }
}

JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

assert(normalizeBaseUrl("https://api.x.ai/v1/") === "https://api.x.ai/v1", "trim slash");
assert(normalizeBaseUrl("https://api.x.ai/v1/chat/completions") === "https://api.x.ai/v1", "strip path");
assert(
  chatCompletionsUrl("https://api.openai.com/v1") === "https://api.openai.com/v1/chat/completions",
  "chat url"
);
assert(JSON.stringify(parseTranslations('["a","b"]', 2)) === JSON.stringify(["a", "b"]), "json");
let shortThrew = false;
try {
  parseTranslations('["a"]', 2);
} catch {
  shortThrew = true;
}
assert(shortThrew, "short json array");
assert(JSON.stringify(parseTranslations("```json\n[\"x\"]\n```", 1)) === JSON.stringify(["x"]), "fence");
assert(
  JSON.stringify(parseTranslations('here: {"items":["一","二"]}', 2)) === JSON.stringify(["一", "二"]),
  "obj"
);
assert(
  JSON.stringify(parseTranslations('{"translations":["甲","乙"]}', 2)) === JSON.stringify(["甲", "乙"]),
  "translations key"
);
assert(parseJsonObject("", { ok: 1 }).ok === 1, "empty json");
assert(parseTranslations("hello world", 1)[0] === "hello world", "single");
assert(parseTranslations("<think>x</think>[\"ok\"]", 1)[0] === "ok", "think tag");
assert(parseTranslations('["a",]', 1)[0] === "a", "trailing comma");
assert(parseTranslations("<<<0>>>\n甲\n<<<1>>>\n乙", 2)[1] === "乙", "delimited");
assert(stripReasoning("<think>abc</think>hi") === "hi", "strip think");
assert(repairJsonLike("[1,]").includes("]"), "repair");

assert(looksLikeTargetLanguage("这是一段已经足够长的中文说明文字", "简体中文"), "skip chinese");
assert(!looksLikeTargetLanguage("這是一段已經足夠長的繁體中文說明文字", "简体中文"), "keep traditional for simplified");
assert(looksLikeTargetLanguage("這是一段已經足夠長的繁體中文說明文字", "繁體中文"), "skip traditional");
assert(!looksLikeTargetLanguage("这是一段已经足够长的简体中文说明文字", "繁體中文"), "keep simplified for traditional");
assert(!looksLikeTargetLanguage("This is already a reasonably long English sentence.", "简体中文"), "keep english for zh");
assert(looksLikeTargetLanguage("The cat sat on the mat and looked at the other cat in the house", "English"), "skip english");
assert(!looksLikeTargetLanguage("Ceci est une phrase française assez longue pour le test du détecteur", "English"), "keep french for en");
assert(looksLikeTargetLanguage("이것은 충분히 긴 한국어 문장입니다 테스트", "한국어"), "skip korean");

assert(shouldSkipText("1"), "short");
assert(shouldSkipText("https://example.com"), "url");
assert(shouldSkipText("100%"), "num");
assert(!shouldSkipText("Hello world"), "keep hello");
assert(shouldSkipText("这是一段已经足够长的中文说明文字", { skipIfTarget: true, targetLang: "简体中文" }), "skip target");

const g = parseGlossary("OpenAI=OpenAI\nattention => 注意力\n# comment");
assert(g.get("attention") === "注意力", "glossary");
assert(applyExactGlossary("attention", g) === "注意力", "exact glossary");
assert(splitWS("  hi\n").body === "hi", "split ws");
assert(chunkText("a".repeat(500), 200).length >= 2, "chunk");
assert(chunkText("Hello world. ".repeat(40), 200).length >= 2, "chunk sentences");
assert(hostMatches("www.example.com", ["example.com"]), "suffix host");
assert(!hostMatches("example.com.evil.com", ["example.com"]), "no suffix spoof");
assert(
  !withoutRelatedHosts(["example.com", "other.com"], "www.example.com").includes("example.com"),
  "drop parent host"
);
assert(
  !withoutRelatedHosts(["www.example.com"], "example.com").includes("www.example.com"),
  "drop child host"
);
assert(withoutRelatedHosts(["other.com"], "www.example.com").includes("other.com"), "keep unrelated host");
assert(parseHostList("https://WWW.Example.com/path\n#x\nfoo.com").includes("www.example.com"), "parse host");
assert(isTranslatableUrl("https://a.com"), "https ok");
assert(!isTranslatableUrl("chrome://extensions"), "chrome blocked");

const store = { a: { at: 1 }, b: { at: 3 }, c: { at: 2 } };
pruneCacheStore(store, 2);
assert(!store.a && store.b && store.c, "prune oldest");

const prompt = buildSystemPrompt({ targetLang: "日本語", glossary: "GPU=GPU" });
assert(prompt.includes("日本語") && prompt.includes("GPU"), "system prompt");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("ok");
