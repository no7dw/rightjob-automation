import { stableJSON } from "./core.js";
import { validateBonusMatches } from "./bonus-message.js";

import { SCORING_PROMPT_VERSION } from "./scoring-prompt.js";
export const LLM_PROMPT_VERSION = SCORING_PROMPT_VERSION;
export const MAX_JD_CHARS = 5200;
export const MAX_CV_CHARS = 16000;

export function normalizeModelName(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeLLMStatus(value) {
  const status = value && typeof value === "object" ? value : {};
  return {
    configured: status.configured === true,
    model: normalizeModelName(status.model),
    model_version:
      typeof status.model_version === "string" ? status.model_version : "",
    base_url: typeof status.base_url === "string" ? status.base_url : "",
    api_key_configured: status.api_key_configured === true,
    api_key_override: status.api_key_override === true,
    ocr_ready: status.ocr_ready === true,
    error: typeof status.error === "string" ? status.error : "",
  };
}

// Older Helpers do not expose prompt_version. Their existing model-version
// hash still proves which prompt is running, even if the process was not
// restarted after the extension was rebuilt.
export async function scoringHelperError(meta) {
  if (!meta?.configured) return "";
  let current = meta.prompt_version === LLM_PROMPT_VERSION;
  if (!meta.prompt_version) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
      JSON.stringify({ base_url: meta.base_url, model: meta.model, prompt: LLM_PROMPT_VERSION }),
    ));
    const expected = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    current = meta.version === expected;
  }
  return current ? "" : "本地服务的评分提示版本过旧，请运行 ./restart.sh 重启服务，再刷新职位页重新评分";
}

export function parseModelJSON(text) {
  if (typeof text !== "string" || !text.trim())
    throw new Error("LLM 没有返回内容");
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("LLM 返回内容不是有效 JSON");
  }
}

function stringList(value) {
  return Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function validateLLMResult(value, { jd, profileText } = {}) {
  const score = value?.match_score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100
  )
    throw new Error("LLM 匹配分须为0到100");
  const inferred = score >= 75 ? "apply" : score >= 55 ? "review" : "reject";
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .filter(
          (item) =>
            item &&
            typeof item.jd_quote === "string" &&
            item.jd_quote.trim() &&
            typeof item.profile_quote === "string" &&
            item.profile_quote.trim(),
        )
        .map((item) => ({
          dimension:
            typeof item.dimension === "string" && item.dimension.trim()
              ? item.dimension.trim()
              : "other",
          jd_quote: item.jd_quote.trim(),
          profile_quote: item.profile_quote.trim(),
          reason: typeof item.reason === "string" ? item.reason.trim() : "",
        }))
    : [];
  // A requirement must be quoted from this JD, never copied from the CV or
  // invented by the model. Ignore punctuation/spacing differences in quotes.
  const quoteText = (text) =>
    String(text)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}]/gu, "");
  const source = typeof jd === "string" ? quoteText(jd) : null;
  const requirements = Array.isArray(value.requirements)
    ? value.requirements
        .filter(
          (item) =>
            item &&
            typeof item.requirement === "string" &&
            typeof item.jd_quote === "string" &&
            item.jd_quote.trim() &&
            ["met", "unknown", "unmet"].includes(item.status) &&
            (source === null ||
              (!!quoteText(item.jd_quote) &&
                source.includes(quoteText(item.jd_quote)))),
        )
        .map((item) => ({
          requirement: item.requirement.trim(),
          jd_quote: item.jd_quote.trim(),
          status: item.status,
          profile_quote:
            typeof item.profile_quote === "string"
              ? item.profile_quote.trim()
              : "",
          reason: typeof item.reason === "string" ? item.reason.trim() : "",
        }))
    : [];
  const requirementsStatus = requirements.some(
    (item) => item.status === "unmet",
  )
    ? "unmet"
    : requirements.some((item) => item.status === "unknown")
      ? "unknown"
      : "met";
  return {
    engine: "llm",
    version: LLM_PROMPT_VERSION,
    match_score: Math.round(score * 100) / 100,
    verdict:
      requirementsStatus === "unmet"
        ? "reject"
        : requirementsStatus === "unknown"
          ? "review"
          : inferred,
    requirements,
    requirements_status: requirementsStatus,
    bonus_matches: validateBonusMatches(value.bonus_matches, { jd, profileText }),
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    strengths: stringList(value.strengths),
    gaps: stringList(value.gaps),
    evidence,
  };
}

function compactText(value, maxChars) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[...]\n${text.slice(-tail)}`;
}

function relevanceTerms(text) {
  const ascii = text.match(/[A-Za-z][A-Za-z0-9+.#/-]{1,}/g) || [];
  const cjk = (text.match(/[\p{Script=Han}]{2,}/gu) || [])
    .flatMap((segment) => {
      const grams = [];
      for (let i = 0; i < segment.length - 1; i++)
        grams.push(segment.slice(i, i + 2));
      return grams;
    })
    .slice(0, 300);
  return [
    ...new Set([
      ...[
        "Agent",
        "AI",
        "LLM",
        "RAG",
        "MCP",
        "Python",
        "Go",
        "架构",
        "平台",
        "研发",
        "管理",
        "工作流",
        "数据",
      ],
      ...ascii,
      ...cjk,
    ]),
  ].map((term) => term.toLowerCase());
}

export function selectRelevantCV(
  profileText,
  jobText,
  maxChars = MAX_CV_CHARS,
) {
  const text = String(profileText || "").trim();
  if (text.length <= maxChars) return text;
  const terms = relevanceTerms(jobText);
  const blocks = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const scored = blocks.map((line, index) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += 1;
    return { line, index, score };
  });
  const selected = [];
  let used = 0;
  for (const item of scored
    .slice(0, 12)
    .concat(
      scored.slice(12).sort((a, b) => b.score - a.score || a.index - b.index),
    )) {
    if (selected.includes(item)) continue;
    if (used + item.line.length + 1 > maxChars) continue;
    selected.push(item);
    used += item.line.length + 1;
    if (used >= maxChars * 0.95) break;
  }
  return selected
    .sort((a, b) => a.index - b.index)
    .map((item) => item.line)
    .join("\n");
}

export function scoringInput(job, profile) {
  const jd = compactText(job.jd, MAX_JD_CHARS);
  return {
    job: {
      job_id: job.job_id,
      site: job.source || "boss",
      source_id: job.source_id || job.job_id,
      url: job.url,
      title: job.title,
      jd,
    },
    profile: {
      text: selectRelevantCV(profile.text, `${job.title}\n${jd}`),
    },
  };
}

export function scoringVersion(modelVersion, profileVersion) {
  return stableJSON({
    prompt: LLM_PROMPT_VERSION,
    model: String(modelVersion || ""),
    profile: String(profileVersion || ""),
  });
}
