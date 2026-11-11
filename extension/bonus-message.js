export const MAX_BONUS_MATCHES = 7;

const quoted = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");

export function bonusSections(jd) {
  const text = String(jd || "").replace(/\r\n?/g, "\n")
    .replace(/([^\n])(\d+[.、)]\s*加分(?:项|条件|要求))/g, "$1\n$2");
  const heading =
    /(?:^|\n)\s*(?:\d+[.、)]\s*)?[【\[]?(?:加分项|加分条件|加分要求|优先条件|优先项|nice[- ]to[- ]have|bonus qualifications|bonus points)[】\]]?\s*[:：]?/gim;
  return [...text.matchAll(heading)].map((match) => {
    const section = text.slice(match.index);
    const next =
      /\n[ \t]*(?:\d+[.、)][ \t]*)?[【\[]?(?:岗位职责|工作职责|任职要求|岗位要求|职位要求|工作内容|福利待遇|薪资福利|工作地点|公司介绍|其他信息|关于我们|软素质|软性素质|申请时请提供|申请材料)[】\]]?[ \t]*(?:[:：]|\n|$)/.exec(
        section,
      );
    const end = section.search(/(?:申请时请提供|投递时请提供|申请材料[:：])/);
    const stop = Math.min(next?.index ?? section.length, end < 0 ? section.length : end);
    return section.slice(0, stop);
  });
}

// The model checks the semantic relationship. These checks independently keep
// source quotations and concrete claims grounded while permitting JD-led labels.
function supportedLabel(label, evidence) {
  const cv = quoted(evidence);
  const protectedClaims = [
    [/英文|英语|\benglish\b/i, /英文|英语|\benglish\b|CET[- ]?[46]|IELTS|TOEFL/i],
    [/粤语|广东话|\bcantonese\b/i, /粤语|广东话|\bcantonese\b/i],
    [/沙箱|\bsandbox\b/i, /沙箱|\bsandbox\b/i],
    [/医疗|医药|临床|医疗健康/, /医疗|医药|临床/],
    [/证券/, /证券|securities/i],
    [/资管/, /资管|资产管理|asset management/i],
    [/模型网关/, /模型网关|model gateway/i],
    [/开源.*(?:贡献|PR)|高质量\s*PR|维护.*开源/i, /开源|open[- ]source|贡献.*PR|PR.*贡献/i],
  ];
  if (protectedClaims.some(([claim, source]) => claim.test(label) && !source.test(evidence))) return false;
  // Do not turn 25 people into 125, or add a tool, certification, or rank.
  const numbers = label.match(/\d+(?:\.\d+)?/g) || [];
  const sourceNumbers = evidence.match(/\d+(?:\.\d+)?/g) || [];
  if (numbers.some((number) => !sourceNumbers.includes(number))) return false;
  const generic = new Set(["ai", "llm", "agent", "agents", "coding", "workflow", "workflows", "server", "servers", "sandbox", "english", "cantonese"]);
  return (label.match(/[a-z][a-z0-9+.#-]*/gi) || []).every((word) =>
    generic.has(word.toLowerCase()) || cv.includes(quoted(word)));
}

export function validateBonusMatches(value, { jd, profileText } = {}) {
  if (typeof jd !== "string" || typeof profileText !== "string") return [];
  const sections = bonusSections(jd).map(quoted);
  const profile = quoted(profileText);
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .flatMap((item) => {
      if (!item || typeof item.label !== "string" || typeof item.jd_quote !== "string") return [];
      // Accept old cached single-quote records as well as combined evidence.
      const supplied = item.profile_quotes ?? [item.profile_quote];
      if (!Array.isArray(supplied) || !supplied.length || supplied.length > 3 ||
          supplied.some((quote) => typeof quote !== "string")) return [];
      // A model may append a paraphrased supplementary quote. Keep genuine
      // excerpts, then recheck concrete label claims against those alone.
      const quotes = supplied.filter((quote) => quoted(quote) && profile.includes(quoted(quote)));
      if (!quotes.length) return [];
      const label = item.label.trim();
      const jdQuote = quoted(item.jd_quote);
      const key = quoted(label);
      if (!key || label.length > 32 || !jdQuote || seen.has(key) ||
          !sections.some((section) => section.includes(jdQuote)) ||
          !supportedLabel(label, quotes.join("\n"))) return [];
      seen.add(key);
      return [{ label, jd_quote: item.jd_quote.trim(),
        profile_quote: quotes[0].trim(),
        ...(item.profile_quotes ? { profile_quotes: quotes.map((quote) => quote.trim()) } : {}),
      }];
    })
    .slice(0, MAX_BONUS_MATCHES);
}

export function bonusMessage(matches) {
  if (!Array.isArray(matches) || !matches.length) return "";
  const labels = [
    ...new Set(matches.map((item) => item.label).filter(Boolean)),
  ].slice(0, MAX_BONUS_MATCHES);
  if (!labels.length) return "";
  return `加分项${labels.length > 1 ? "多项也" : "也"}涉及，包括${labels.join("、")}等。`;
}
