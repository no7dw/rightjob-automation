import { hash, normalizeText } from "./core.js";

export async function jobFingerprint(job) {
  return hash({
    title: normalizeText(job.title),
    jd: normalizeText(job.jd_raw || job.jd),
  });
}

export function scoreIsCurrent(entry, { profileVersion, modelVersion }) {
  return !!(
    entry &&
    entry.score_status === "valid" &&
    typeof entry.score === "number" &&
    entry.profile_version === profileVersion &&
    entry.model_version === modelVersion
  );
}

export function isContactedEntry(entry, jobId, fingerprint = "") {
  if (!entry || entry.job_id !== jobId) return false;
  if (!fingerprint) return true;
  return !entry.jd_fingerprint || entry.jd_fingerprint === fingerprint;
}

export function indexedScore(index, jobId, context) {
  const entry = index?.[jobId];
  return scoreIsCurrent(entry, context) ? entry : null;
}

export function indexScore({
  index = {},
  raw,
  score,
  fingerprint,
  profileVersion,
  model,
  modelVersion,
  scoringVersion,
  contacted = false,
}) {
  return {
    ...index,
    [raw.job_id]: {
      job_id: raw.job_id,
      jd_fingerprint: fingerprint,
      title: normalizeText(raw.title),
      company: normalizeText(raw.company),
      is_headhunter: raw.is_headhunter ?? null,
      headhunter_evidence: raw.headhunter_evidence || null,
      recruiter_raw: raw.recruiter_raw || null,
      profile_version: profileVersion,
      model,
      model_version: modelVersion,
      scoring_version: scoringVersion,
      score: score.match_score,
      verdict: score.verdict || "",
      summary: score.summary || "",
      strengths: score.strengths || [],
      gaps: score.gaps || [],
      evidence: score.evidence || [],
      requirements: score.requirements || [],
      requirements_status: score.requirements_status,
      bonus_matches: score.bonus_matches || [],
      scored_at: score.scored_at,
      score_status: "valid",
      contacted: contacted || !!index?.[raw.job_id]?.contacted,
    },
  };
}

export function contactRecord({
  existing = {},
  raw,
  fingerprint,
  score,
  threshold,
  runId,
  status,
  at = new Date().toISOString(),
}) {
  return {
    ...existing,
    job_id: raw.job_id,
    jd_fingerprint: fingerprint,
    title: normalizeText(raw.title),
    company: normalizeText(raw.company),
    score: score.match_score,
    threshold,
    run_id: runId,
    status,
    contacted_at: existing.contacted_at || at,
    updated_at: at,
  };
}
