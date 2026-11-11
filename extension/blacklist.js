import { normalizeText } from "./core.js";

export function parseBlacklist(value) {
  if (Array.isArray(value)) {
    if (value.some((term) => typeof term !== "string"))
      throw new Error("黑名单关键词须为文本");
    value = value.join(",");
  }
  if (typeof value !== "string") throw new Error("黑名单关键词须为文本");
  const seen = new Set();
  return value
    .split(/[,，\n\r]+/)
    .map(normalizeText)
    .filter((term) => {
      const key = term.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function jobBlacklistMatch(job, keywords = [], run) {
  const correction = run?.corrections?.[job?.job_id];
  const text = normalizeText(
    [
      job?.title,
      job?.jd_raw,
      job?.jd,
      job?.ocr_draft,
      correction?.title,
      correction?.jd,
    ]
      .filter(Boolean)
      .join("\n"),
  ).toLowerCase();
  return (
    parseBlacklist(keywords).find((term) =>
      text.includes(term.toLowerCase()),
    ) || ""
  );
}

export function companyBlacklistMatch(job, keywords = [], run) {
  const correction = run?.corrections?.[job?.job_id];
  const company = normalizeText(
    correction?.company || job?.corrections?.company || job?.company,
  ).toLowerCase();
  return (
    parseBlacklist(keywords).find((term) =>
      company.includes(term.toLowerCase()),
    ) || ""
  );
}

export function applyRunBlacklist(run, keywords, companyKeywords = []) {
  for (const job of run?.jobs || []) {
    const companyMatch = companyBlacklistMatch(job, companyKeywords, run);
    const match = companyMatch || jobBlacklistMatch(job, keywords, run);
    if (match) {
      job.blacklist_keyword = match;
      if (run.score_failures) delete run.score_failures[job.job_id];
    } else delete job.blacklist_keyword;
  }
  return run;
}
