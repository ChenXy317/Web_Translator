/** 把用户填写的站点列表整理成 hostname。 */
export function parseHostList(raw) {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const hosts = [];
  for (const line of text.split(/[\s,;]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const host = trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .replace(/^\*\./, "")
      .toLowerCase();
    if (host) hosts.push(host);
  }
  return [...new Set(hosts)];
}

export function hostMatches(host, patterns) {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  return (patterns || []).some((p) => {
    const pat = String(p || "").toLowerCase();
    return pat && (h === pat || h.endsWith(`.${pat}`));
  });
}

/** 去掉与当前主机相同、为其父域或子域的条目。 */
export function withoutRelatedHosts(list, host) {
  const h0 = String(host || "").toLowerCase();
  if (!h0) return [...(list || [])];
  return (list || []).filter((item) => {
    const p = String(item || "").toLowerCase();
    if (!p) return true;
    if (p === h0) return false;
    if (hostMatches(h0, [p]) || hostMatches(p, [h0])) return false;
    return true;
  });
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isTranslatableUrl(url) {
  return /^(https?|file):/i.test(String(url || ""));
}

export function parseSelectorList(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}
