/** 各拉丁语种的高频功能词，用于区分「已经是目标语言」与「同为拉丁字母的其他语言」。 */
const STOPWORDS = {
  English: ["the", "and", "of", "to", "in", "is", "for", "that", "with", "on", "this", "are", "as", "be", "was", "by", "at", "from", "or", "an", "it", "not"],
  Français: ["les", "des", "une", "est", "que", "pas", "pour", "dans", "qui", "sur", "par", "plus", "avec", "cette", "sont"],
  Deutsch: ["und", "der", "die", "das", "nicht", "ein", "ist", "von", "zu", "mit", "den", "auf", "für", "im", "dem", "ich"],
  Español: ["que", "los", "las", "del", "una", "por", "con", "para", "está", "como", "más", "pero", "sus", "este"],
  Português: ["que", "não", "uma", "para", "com", "os", "as", "do", "da", "em", "por", "como", "mais", "está", "não"],
  Italiano: ["che", "non", "una", "per", "con", "come", "del", "della", "sono", "più", "questo", "nella", "anche"],
  Nederlands: ["dat", "niet", "een", "van", "voor", "met", "het", "als", "zijn", "er", "op", "aan", "om", "bij"],
  Polski: ["nie", "się", "jest", "to", "na", "jak", "że", "do", "za", "od", "po", "czy", "ale", "jak"],
  "Tiếng Việt": ["không", "của", "là", "và", "một", "các", "có", "được", "trong", "cho", "với", "này", "đã"],
  "Bahasa Indonesia": ["yang", "dan", "tidak", "dengan", "untuk", "dari", "pada", "adalah", "ini", "akan", "di"],
  "Türkçe": ["bir", "bu", "ve", "için", "ile", "olan", "daha", "gibi", "değil", "ama", "çok", "var"]
};

const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ]+/g;

/** 简繁差异常用字，避免把繁体当成已经是简体（或相反）。 */
const SIMP_HINTS = new Set(
  "这国对为会学发经门问开关时语无电从众长见条点体广后处声实医产爱儿云历办务参双变台启园图场备奖导岁并庆应弃张总战扩拥择据敌断显术杀杂标样楼欢汉满灵灾热疗码种积称竞笔类约织续网职胜脚脸药装观视计订认让议记讲许论设证评识译试读调谈谢财质卖货赛转轮轻边达运还进远连选邮钟钢钱闪闭闲间队阶阳阴险随难页顶顺预领题风飞饭验"
);
const TRAD_HINTS = new Set(
  "這國對為會學發經門問開關時語無電從眾長見條點體廣後處聲實醫產愛兒雲歷辦務參雙變臺啟園圖場備獎導歲並慶應棄張總戰擴擁擇據敵斷顯術殺雜標樣樓歡漢滿靈災熱療碼種積稱競筆類約織續網職勝腳臉藥裝觀視計訂認讓議記講許論設證評識譯試讀調談謝財質賣貨賽轉輪輕邊達運還進遠連選郵鐘鋼錢閃閉閒間隊階陽陰險隨難頁頂順預領題風飛飯驗"
);

function countHints(text, bag) {
  let n = 0;
  for (const ch of text) {
    if (bag.has(ch)) n += 1;
  }
  return n;
}

export function analyzeScripts(text) {
  const stats = {
    han: 0,
    hira: 0,
    kata: 0,
    hangul: 0,
    cyrillic: 0,
    arabic: 0,
    thai: 0,
    devanagari: 0,
    latin: 0,
    other: 0
  };
  for (const ch of String(text || "")) {
    const c = ch.codePointAt(0);
    if (!c) continue;
    if (c >= 0x4e00 && c <= 0x9fff) stats.han += 1;
    else if (c >= 0x3400 && c <= 0x4dbf) stats.han += 1;
    else if (c >= 0x3040 && c <= 0x309f) stats.hira += 1;
    else if (c >= 0x30a0 && c <= 0x30ff) stats.kata += 1;
    else if (c >= 0xac00 && c <= 0xd7af) stats.hangul += 1;
    else if (c >= 0x0400 && c <= 0x04ff) stats.cyrillic += 1;
    else if (c >= 0x0600 && c <= 0x06ff) stats.arabic += 1;
    else if (c >= 0x0e00 && c <= 0x0e7f) stats.thai += 1;
    else if (c >= 0x0900 && c <= 0x097f) stats.devanagari += 1;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)) stats.latin += 1;
    else if (/\s/u.test(ch) || /\p{P}|\p{S}|\p{N}/u.test(ch)) continue;
    else stats.other += 1;
  }
  return stats;
}

function lettersTotal(stats) {
  return (
    stats.han +
    stats.hira +
    stats.kata +
    stats.hangul +
    stats.cyrillic +
    stats.arabic +
    stats.thai +
    stats.devanagari +
    stats.latin
  );
}

function stopwordScore(text, lang) {
  const list = STOPWORDS[lang];
  if (!list) return 0;
  const words = String(text || "").toLowerCase().match(WORD_RE) || [];
  if (words.length < 4) return 0;
  const set = new Set(list);
  let hit = 0;
  for (const w of words) {
    if (set.has(w)) hit += 1;
  }
  return hit / words.length;
}

/** 文本是否已经很像目标语言，用于跳过无意义的二次翻译。 */
export function looksLikeTargetLanguage(text, targetLang) {
  const body = String(text || "").trim();
  if (body.length < 8) return false;
  const stats = analyzeScripts(body);
  const total = lettersTotal(stats);
  if (total < 8) return false;

  const ratio = (n) => n / total;

  const hanLike =
    ratio(stats.han) > 0.82 && stats.hira + stats.kata + stats.hangul === 0;
  if (targetLang === "简体中文") {
    return hanLike && countHints(body, TRAD_HINTS) <= countHints(body, SIMP_HINTS);
  }
  if (targetLang === "繁體中文") {
    return hanLike && countHints(body, SIMP_HINTS) <= countHints(body, TRAD_HINTS);
  }
  if (targetLang === "日本語") {
    const kana = stats.hira + stats.kata;
    return kana >= 2 && ratio(stats.han + kana) > 0.72;
  }
  if (targetLang === "한국어") return ratio(stats.hangul) > 0.72;
  if (targetLang === "Русский") return ratio(stats.cyrillic) > 0.72;
  if (targetLang === "العربية") return ratio(stats.arabic) > 0.72;
  if (targetLang === "ไทย") return ratio(stats.thai) > 0.72;
  if (targetLang === "हिन्दी") return ratio(stats.devanagari) > 0.72;

  if (STOPWORDS[targetLang]) {
    return stopwordScore(body, targetLang) >= 0.1;
  }
  return false;
}
