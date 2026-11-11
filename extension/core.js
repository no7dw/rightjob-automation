import { liepinIdentity, siteForURL } from "./sites.js";
export const DIMENSIONS = [
  "skill",
  "role",
  "seniority",
  "domain",
  "salary",
  "other",
];
export const DEFAULT_WEIGHTS = {
  skill: 30,
  role: 20,
  seniority: 15,
  domain: 15,
  salary: 15,
  other: 5,
};
export const DEFAULT_PREFS = {
  salary_min_k: null,
  excluded_terms: [],
  excluded_companies: [],
};
export const DEFAULT_MATCH_THRESHOLD = 75;
export const MAJOR_CITIES = Object.freeze([
  "北京",
  "上海",
  "广州",
  "深圳",
  "杭州",
  "南京",
  "苏州",
  "成都",
  "重庆",
  "武汉",
  "西安",
  "天津",
  "长沙",
  "郑州",
  "青岛",
  "宁波",
  "厦门",
  "福州",
  "合肥",
  "济南",
  "东莞",
  "佛山",
  "珠海",
  "无锡",
  "昆明",
  "大连",
  "沈阳",
  "哈尔滨",
  "长春",
  "石家庄",
  "太原",
  "南昌",
  "南宁",
  "贵阳",
  "海口",
  "兰州",
  "乌鲁木齐",
  "呼和浩特",
  "银川",
  "西宁",
  "拉萨",
  "香港",
  "澳门",
]);
export function validateMatchThreshold(value) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  )
    throw new Error("匹配阈值须为0到100");
  return value;
}
export function validateSelectedCities(value) {
  if (!Array.isArray(value)) throw new Error("城市筛选须为数组");
  const selected = [...new Set(value.map(normalizeText).filter(Boolean))];
  const unsupported = selected.filter((city) => !MAJOR_CITIES.includes(city));
  if (unsupported.length)
    throw new Error(`不支持的城市筛选：${unsupported.join("、")}`);
  return MAJOR_CITIES.filter((city) => selected.includes(city));
}
export function locationMatchesCities(location, selectedCities) {
  const text = normalizeText(location);
  if (!text || !Array.isArray(selectedCities) || !selectedCities.length)
    return false;
  return selectedCities.some((city) => text.includes(normalizeText(city)));
}
const PUA_SOURCE =
  "[\\uE000-\\uF8FF\\u{F0000}-\\u{FFFFD}\\u{100000}-\\u{10FFFD}]";
const PUA_GLOBAL = new RegExp(PUA_SOURCE, "gu");
export const hasPUA = (value) => new RegExp(PUA_SOURCE, "u").test(value || "");
// Sites paste Wingdings-style bullets (e.g. U+F0B7) as decoration; that is not
// private-font obfuscation. Isolated PUA glyphs are stripped, while consecutive
// PUA runs (an icon font replacing real words) stay flagged as "partial".
export function stripDecorativePUA(value) {
  const raw = String(value || "");
  if (new RegExp(PUA_SOURCE + "{2}", "u").test(raw)) return raw;
  return raw.replace(PUA_GLOBAL, "");
}
export const normalizeText = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
export const jobId = (url) => {
  try {
    const absolute = new URL(url, "https://www.zhipin.com");
    const liepin = liepinIdentity(absolute.href);
    if (liepin) return liepin.job_id;
    if (siteForURL(absolute.href) !== "boss") return null;
    return (
      absolute.pathname.match(/^\/job_detail\/([\w~-]+)\.html$/)?.[1] || null
    );
  } catch {
    return null;
  }
};
export const canonicalURL = (id) => {
  const liepin = /^liepin:(a|job):(\d+)$/.exec(id);
  return liepin
    ? `https://www.liepin.com/${liepin[1]}/${liepin[2]}.shtml`
    : `https://www.zhipin.com/job_detail/${id}.html`;
};
export function stableJSON(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((k) => [k, item[k]]),
        )
      : item,
  );
}
export async function hash(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          typeof value === "string" ? value : stableJSON(value),
        ),
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function parseSalary(raw) {
  const empty = { min_k: null, max_k: null, months: null };
  if (!raw || hasPUA(raw)) return empty;
  const text = normalizeText(raw).replace(/[，,]/g, "");
  if (/面议|年薪|[\/每]\s*年|日|天|时/.test(text)) return empty;
  let m = text.match(
    /(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*([kK]|千|万)(?:\s*[\/每]月)?/,
  );
  if (!m) return empty;
  const multiplier = m[3] === "万" ? 10 : 1;
  const min_k = Number(m[1]) * multiplier,
    max_k = Number(m[2]) * multiplier;
  if (!(min_k > 0 && max_k >= min_k)) return empty;
  const monthsMatch = text.match(/[·•.\s](\d{1,2})\s*薪/);
  const months =
    monthsMatch && Number(monthsMatch[1]) >= 12 && Number(monthsMatch[1]) <= 24
      ? Number(monthsMatch[1])
      : null;
  return { min_k, max_k, months };
}
export function redactCV(raw) {
  return raw
    .split("\n")
    .filter((line) => !/电话|邮箱|LinkedIn|领英|手机|微信/.test(line))
    .join("\n")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[已移除邮箱]")
    .replace(/(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)/g, "[已移除电话]")
    .replace(/`/g, "")
    .replace(/https?:\/\/\S+/gi, "[已移除链接]")
    .trim();
}
export async function profileFromCV(raw, name = "imported.md") {
  const text = redactCV(raw);
  if (text.length < 100)
    throw new Error("简历内容过短，请导入完整 Markdown 简历");
  return {
    name,
    text,
    version: await hash(text),
    imported_at: new Date().toISOString(),
    source: "local-markdown",
    preferences: { ...DEFAULT_PREFS },
  };
}
export function validateWeights(weights) {
  if (
    !weights ||
    DIMENSIONS.some(
      (k) =>
        typeof weights[k] !== "number" ||
        !Number.isFinite(weights[k]) ||
        weights[k] < 0,
    ) ||
    Math.abs(DIMENSIONS.reduce((n, k) => n + weights[k], 0) - 100) > 0.001
  )
    throw new Error("六项权重必须为非负数且总和为 100");
  return weights;
}
export function validatePrefs(prefs) {
  const excluded_terms = prefs?.excluded_terms ?? [];
  const excluded_companies = prefs?.excluded_companies ?? [];
  if (
    !prefs ||
    (prefs.salary_min_k !== null &&
      !(Number.isFinite(prefs.salary_min_k) && prefs.salary_min_k > 0)) ||
    !Array.isArray(excluded_terms) ||
    excluded_terms.some((s) => typeof s !== "string" || !s.trim()) ||
    !Array.isArray(excluded_companies) ||
    excluded_companies.some((s) => typeof s !== "string" || !s.trim())
  )
    throw new Error("薪资底线须为正数或空值；排除词须为文本数组");
  return {
    salary_min_k: prefs.salary_min_k,
    excluded_terms,
    excluded_companies,
  };
}
export function normalizeJob(raw) {
  const title = raw.corrections?.title || raw.title;
  if (
    !raw.job_id ||
    jobId(raw.url) !== raw.job_id ||
    typeof title !== "string" ||
    !normalizeText(title) ||
    typeof raw.jd_raw !== "string" ||
    !normalizeText(raw.jd_raw)
  )
    throw new Error("职位缺少 ID、标题或 JD");
  const text = normalizeText(raw.jd_raw);
  return {
    ...raw,
    url: canonicalURL(raw.job_id),
    jd: text,
    title: normalizeText(title),
    company:
      raw.corrections?.company ||
      (raw.company ? normalizeText(raw.company) : null),
    location_raw: raw.corrections?.location || raw.location_raw,
    location_verified: false,
    salary: parseSalary(raw.corrections?.salary || raw.salary_raw),
    quality_flags: [
      ...new Set([
        ...(raw.quality_flags || []),
        ...(hasPUA(text) ? ["jd_private_font"] : []),
      ]),
    ],
  };
}
export function hardFilter(job, prefs = DEFAULT_PREFS) {
  const reasons = [],
    unknowns = [];
  for (const term of prefs.excluded_terms || [])
    if (`${job.title}\n${job.jd}`.toLowerCase().includes(term.toLowerCase()))
      reasons.push(`命中用户排除词：${term}`);
  if (prefs.salary_min_k !== null) {
    if (job.salary?.max_k == null) unknowns.push("岗位薪资无法可靠读取");
    else if (job.salary.max_k < prefs.salary_min_k)
      reasons.push(
        `薪资上限 ${job.salary.max_k}K 低于用户底线 ${prefs.salary_min_k}K`,
      );
  }
  return {
    status: reasons.length ? "reject" : unknowns.length ? "unknown" : "pass",
    reasons,
    unknowns,
  };
}
const GROUPS = {
  skill: [
    "Python",
    "TypeScript",
    "Go",
    "Java",
    "MCP",
    "RAG",
    "Agent",
    "Tool Calling",
    "Function Calling",
    "AutoGen",
    "LangChain",
    "Kubernetes",
    "K8s",
    "Kafka",
    "Flink",
    "Spark",
    "OAuth",
    "SQL",
  ],
  role: [
    "架构",
    "平台",
    "后端",
    "工程化",
    "生产",
    "工作流",
    "编排",
    "评测",
    "交付",
    "管理",
    "负责人",
    "CTO",
  ],
  domain: ["电商", "金融", "数据", "Web3", "工具", "集成", "多租户", "自动化"],
};
function excerpt(text, term) {
  const pos = text.toLowerCase().indexOf(term.toLowerCase());
  return pos < 0
    ? null
    : text
        .slice(
          Math.max(0, pos - 30),
          Math.min(text.length, pos + term.length + 70),
        )
        .trim();
}
function containsTerm(text, term) {
  if (/^[a-z]+$/i.test(term))
    return new RegExp(`(?<![a-z])${term}(?![a-z])`, "i").test(text);
  return text.toLowerCase().includes(term.toLowerCase());
}
export function ruleEvaluation(job, profile, prefs) {
  const scores = Object.fromEntries(DIMENSIONS.map((k) => [k, null])),
    evidence = [],
    gaps = [];
  for (const [key, terms] of Object.entries(GROUPS)) {
    const requested = terms.filter((t) =>
      containsTerm(`${job.title}\n${job.jd}`, t),
    );
    const matched = requested.filter((t) => containsTerm(profile.text, t));
    if (requested.length)
      scores[key] = Math.round((100 * matched.length) / requested.length);
    for (const term of matched.slice(0, 5))
      evidence.push({
        dimension: key,
        jd_quote: excerpt(
          containsTerm(job.jd, term) ? job.jd : job.title,
          term,
        ),
        profile_quote: excerpt(profile.text, term),
        reason: `两侧出现「${term}」；仅为词项基线`,
      });
    for (const term of requested.filter((t) => !matched.includes(t)))
      gaps.push(`简历未见「${term}」的明确证据`);
  }
  // Numeric years are not an upper age/experience limit. Only assess explicit minimum years.
  const minYears = job.jd.match(
    /(\d+)\s*年(?:以上)?(?:的)?(?:后端|开发|研发|架构|工作|相关|工程)/,
  );
  const cvYears = profile.text.match(/(\d+)\+?\s*年(?:后端|工程|工作)/);
  if (minYears && cvYears) {
    scores.seniority =
      Number(cvYears[1]) >= Number(minYears[1])
        ? 100
        : Math.round((100 * Number(cvYears[1])) / Number(minYears[1]));
    evidence.push({
      dimension: "seniority",
      jd_quote: excerpt(job.jd, minYears[0]),
      profile_quote: excerpt(profile.text, cvYears[0]),
      reason: "仅比较明确最低工作年限；不判断实际职级",
    });
  }
  scores.salary = salaryScore(job, prefs);
  return {
    engine: "rules",
    version: "rules-v1",
    dimension_scores: scores,
    evidence,
    gaps,
    notes: ["本地关键词基线，不代表 AI 语义评价", "地点未核实，不参与评分"],
  };
}
function salaryScore(job, prefs) {
  if (prefs.salary_min_k == null || job.salary.min_k == null) return null;
  return job.salary.min_k >= prefs.salary_min_k
    ? 100
    : job.salary.max_k >= prefs.salary_min_k
      ? 60
      : 0;
}
export function validateEvaluation(value, job, profile, prefs) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.gaps) ||
    value.gaps.some((s) => typeof s !== "string")
  )
    throw new Error("模型结果格式错误");
  for (const k of DIMENSIONS) {
    const n = value.dimension_scores?.[k];
    if (
      n !== null &&
      (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 100)
    )
      throw new Error(`无效维度：${k}`);
    if (["salary", "other"].includes(k)) continue;
    if (n !== null && !value.evidence.some((e) => e.dimension === k))
      throw new Error(`${k} 缺少两侧证据`);
  }
  for (const e of value.evidence) {
    if (
      !DIMENSIONS.includes(e.dimension) ||
      typeof e.reason !== "string" ||
      !e.jd_quote ||
      !e.profile_quote ||
      !normalizeText(`${job.title}\n${job.jd}`).includes(
        normalizeText(e.jd_quote),
      ) ||
      !normalizeText(profile.text).includes(normalizeText(e.profile_quote))
    )
      throw new Error("模型引文无法在原文中定位");
  }
  return {
    ...value,
    engine: "llm",
    version: "llm-v1",
    dimension_scores: {
      ...value.dimension_scores,
      salary: salaryScore(job, prefs),
      other: null,
    },
  };
}
// A low-coverage score is renormalized over the dimensions that were actually
// scored, so "100" can mean "perfect on half the rubric". Surface the coverage
// next to the score so a partial-coverage match is never read as a full one.
export const MIN_TRUST_COVERAGE = 0.8;
export function formatScore(score, coverage) {
  if (score == null) return "—";
  const text = String(score);
  if (!Number.isFinite(coverage)) return text;
  if (coverage >= MIN_TRUST_COVERAGE) return text;
  return `${text} (${Math.round(coverage * 100)}%)`;
}
export function lowCoverage(coverage) {
  return Number.isFinite(coverage) && coverage < MIN_TRUST_COVERAGE;
}

export function weightedScore(evaluation, weights, eligibility, flags = []) {
  validateWeights(weights);
  let known = 0,
    total = 0;
  for (const k of DIMENSIONS) {
    const n = evaluation.dimension_scores[k];
    if (n !== null && n !== undefined && weights[k] > 0) {
      if (!Number.isFinite(n) || n < 0 || n > 100)
        throw new Error("维度分数超界");
      known += weights[k];
      total += weights[k] * n;
    }
  }
  return {
    ...evaluation,
    match_score: known ? Math.round((total / known) * 100) / 100 : null,
    coverage: known / 100,
    eligibility,
    needs_review:
      known < 80 || eligibility.status === "unknown" || flags.length > 0,
    weights_version: JSON.stringify(weights),
  };
}
export function csv(rows) {
  const keys = [
    "job_id",
    "title",
    "company",
    "is_headhunter",
    "headhunter_evidence",
    "recruiter_raw",
    "location_raw",
    "jd_raw",
    "jd_confirmed",
    "jd_ocr_draft",
    "salary_raw",
    "salary_confirmed",
    "salary_min_k",
    "salary_max_k",
    "salary_months",
    "salary_ocr_draft",
    "salary_source",
    "location_verified",
    "jd_fingerprint",
    "engine",
    "match_score",
    "coverage",
    "verdict",
    "llm_summary",
    "strengths",
    "gaps",
    "evidence",
    "requirements",
    "requirements_status",
    "eligibility",
    "match_threshold",
    "qualification_status",
    "application_status",
    "contacted_at",
    "model",
    "profile_version",
    "collected_at",
    "scored_at",
    "quality_flags",
    "human_label",
    "human_priority",
    "human_reason",
  ];
  const cell = (value) => {
    let s = String(value ?? "");
    if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [
      keys,
      ...rows.map((r) =>
        keys.map((k) =>
          typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k],
        ),
      ),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
export function metrics(rows) {
  const reviewed = rows.filter((r) =>
    ["strong_fit", "possible", "reject"].includes(r.human_label),
  );
  if (reviewed.length !== rows.length || !rows.length)
    return { precision_at_10: null, recall_at_10: null };
  const accepted = (r) => ["strong_fit", "possible"].includes(r.human_label);
  const ranked = [...rows]
    .filter((r) => r.match_score != null && r.eligibility?.status !== "reject")
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, 10);
  const n = ranked.filter(accepted).length,
    all = reviewed.filter(accepted).length;
  return {
    precision_at_10: ranked.length ? n / ranked.length : null,
    recall_at_10: all ? n / all : null,
  };
}
export async function cacheKey(job, profile, prefs, model = "rules-v1") {
  return hash({
    job: job.jd,
    title: job.title,
    salary: job.salary,
    profile: profile.version,
    prefs,
    model,
    prompt: "v2",
  });
}
