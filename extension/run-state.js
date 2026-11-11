import { hasPUA, normalizeText, jobId } from "./core.js";

export function validateCheckpoint(run) {
  if (
    !run ||
    typeof run.id !== "string" ||
    !run.id ||
    !Number.isInteger(run.target) ||
    run.target < 1 ||
    ![
      "idle",
      "running",
      "paused",
      "completed",
      "exhausted",
      "blocked",
    ].includes(run.status) ||
    !Array.isArray(run.jobs) ||
    !Array.isArray(run.attempts) ||
    !Array.isArray(run.seen)
  )
    throw new Error("无效采集检查点");
  const finite = (value) => {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("检查点包含非有限数值");
    if (value && typeof value === "object")
      for (const item of Object.values(value)) finite(item);
  };
  finite(run);
  const ids = new Set();
  for (const job of run.jobs) {
    if (
      !job ||
      typeof job.job_id !== "string" ||
      ids.has(job.job_id) ||
      jobId(job.url) !== job.job_id ||
      job.identity_verified !== true ||
      job.location_verified !== false ||
      !["success", "partial"].includes(job.extraction_status) ||
      !["title", "company", "jd_raw", "salary_raw", "location_raw"].every(
        (key) => job[key] == null || typeof job[key] === "string",
      ) ||
      !Number.isFinite(Date.parse(job.collected_at))
    )
      throw new Error("原始职位字段或唯一ID无效");
    if (
      job.extraction_status === "success" &&
      !isComplete(job, { corrections: {} })
    )
      throw new Error("完整职位缺少可读标题或JD");
    if (job.salary) {
      const { min_k, max_k, months } = job.salary;
      if (
        [min_k, max_k, months].some(
          (n) =>
            n !== null &&
            (typeof n !== "number" || !Number.isFinite(n) || n <= 0),
        ) ||
        (min_k !== null && max_k !== null && min_k > max_k)
      )
        throw new Error("薪资字段或区间无效");
    }
    ids.add(job.job_id);
  }
  if (
    new Set(run.seen).size !== run.seen.length ||
    run.seen.length !== ids.size ||
    run.seen.some((id) => !ids.has(id))
  )
    throw new Error("检查点去重索引与原始职位不一致");
  return run;
}

// Corrections are separate from immutable raw records. A human-confirmed full
// JD counts as complete without rewriting the original OCR/partial snapshot.
export function isComplete(job, run) {
  const correction = run?.corrections?.[job.job_id];
  const jd = correction?.jd || job.jd_raw;
  const title = correction?.title || job.title;
  return (
    job.identity_verified === true &&
    !!normalizeText(title) &&
    !hasPUA(title) &&
    !!normalizeText(jd) &&
    !hasPUA(jd) &&
    (job.extraction_status === "success" || !!correction?.jd)
  );
}

export function scoringFailures(run) {
  const jobs = new Map((run?.jobs || []).map((job) => [job.job_id, job]));
  return Object.entries(run?.score_failures || {})
    .filter(([jobId, failure]) => jobs.has(jobId) && !!failure?.reason)
    .map(([jobId, failure]) => ({
      job_id: jobId,
      title: jobs.get(jobId).title || jobId,
      reason: failure.reason,
    }));
}

export function scoringFailureText(run) {
  return scoringFailures(run)
    .map((failure) => `AI 评分失败：${failure.title}：${failure.reason}`)
    .join("\n");
}

export function failedJobs(run) {
  const captured = new Set((run?.jobs || []).map((job) => job.job_id));
  const last = new Map();
  for (const attempt of run?.attempts || []) {
    if (attempt.status === "failed" && !captured.has(attempt.job_id))
      last.set(attempt.job_id, attempt);
  }
  return [...last.values()];
}

export function processedCount(run) {
  const skipped = new Set(
    (run?.jobs || [])
      .filter((job) => job.blacklist_keyword)
      .map((job) => job.job_id),
  );
  const ids = new Set([
    ...(run?.jobs || [])
      .filter((job) => !skipped.has(job.job_id))
      .map((job) => job.job_id),
    ...(run?.attempts || [])
      .filter(
        (attempt) =>
          attempt.status === "failed" && !skipped.has(attempt.job_id),
      )
      .map((attempt) => attempt.job_id),
  ]);
  return ids.size;
}

export function failureCount(run, id) {
  const epoch = run.retry_epochs?.[id] || 0;
  return run.attempts.filter(
    (attempt) =>
      attempt.job_id === id &&
      attempt.status === "failed" &&
      (attempt.retry_epoch || 0) === epoch,
  ).length;
}

export function retryFailures(run) {
  if (!run || run.status === "running") throw new Error("请先暂停采集再重试");
  const failures = failedJobs(run);
  const ids = new Set([
    ...failures.map((attempt) => attempt.job_id),
    ...Object.keys(run.score_failures || {}),
  ]);
  if (!ids.size) throw new Error("没有需要重试的失败职位");
  run.retry_epochs ??= {};
  for (const id of ids) {
    run.retry_epochs[id] = (run.retry_epochs[id] || 0) + 1;
    if (run.applications?.[id]?.status === "failed") delete run.applications[id];
    if (run.score_failures) delete run.score_failures[id];
  }
  run.status = "paused";
  run.stop_reason = `已为 ${ids.size} 个失败职位开启重试；保留此前失败记录`;
  return run;
}

export function runCounts(run) {
  const jobs = (run?.jobs || []).filter((job) => !job.blacklist_keyword);
  const successful = jobs.filter((job) => isComplete(job, run)).length;
  return {
    successful,
    partial: jobs.length - successful,
    failed: failedJobs(run).length,
    failure_attempts: (run?.attempts || []).filter((a) => a.status === "failed")
      .length,
  };
}

export function mergeOCRPages(pages) {
  const result = [];
  for (const page of pages) {
    const lines = page.split("\n").map(normalizeText).filter(Boolean);
    let overlap = Math.min(result.length, lines.length);
    while (
      overlap &&
      !lines
        .slice(0, overlap)
        .every(
          (line, index) => line === result[result.length - overlap + index],
        )
    )
      overlap--;
    result.push(...lines.slice(overlap));
  }
  return result.join("\n");
}

// A human confirmation resolves the matching flags: raw flags stay on the
// record for provenance, but they stop counting against the score once the
// field they describe has been verified by a person.
const SALARY_FLAGS = new Set(["salary_unknown", "salary_ocr_review"]);
const JD_FLAGS = new Set([
  "jd_private_font",
  "jd_unreadable",
  "ocr_unavailable",
  "ocr_not_enabled",
  "ocr_fulltext_requires_review",
  "ocr_capture_incomplete",
]);

export function unresolvedFlags(row, run) {
  const fix = run?.corrections?.[row.job_id] || {};
  return (row.quality_flags || []).filter((flag) => {
    if (flag === "human_corrected_jd") return false;
    if (SALARY_FLAGS.has(flag)) return !fix.salary;
    if (JD_FLAGS.has(flag)) return !fix.jd;
    return true;
  });
}

export function needsReview(row, run) {
  return (
    row.needs_review ||
    !isComplete(row, run) ||
    !!unresolvedFlags(row, run).length ||
    row.match_score == null
  );
}

// Blocking integrity issues only. A thin evidence coverage is a confidence
// signal, not a data defect, so it never stops a job from being contacted.
export function contactBlockers(row, run) {
  const blockers = unresolvedFlags(row, run);
  if (row.eligibility?.status === "unknown")
    blockers.push("eligibility_unknown");
  if (row.requirements_status === "unknown")
    blockers.push("requirements_unknown");
  if (row.requirements_status === "unmet") blockers.push("requirements_unmet");
  if (!isComplete(row, run)) blockers.push("jd_incomplete");
  return blockers;
}

// The contact queue needs trustworthy data, not high confidence: a job is
// clickable when it is scored, complete, not hard-rejected and free of
// unresolved review signals. Blocked rows are bucketed with their cause so an
// empty queue explains itself instead of reporting a generic failure.
export function contactCandidates(rows, run, attempted, limit) {
  const used = new Set(attempted || []);
  const blocked = {
    unscored: 0,
    incomplete: 0,
    rejected: 0,
    attempted: 0,
    review: 0,
    low_coverage: 0,
  };
  const reasons = new Map();
  const note = (reason) => reasons.set(reason, (reasons.get(reason) || 0) + 1);
  const candidates = [];
  for (const row of rows) {
    if (row.match_score == null) {
      blocked.unscored++;
      continue;
    }
    if (row.eligibility?.status === "reject") {
      blocked.rejected++;
      continue;
    }
    if (used.has(row.job_id)) {
      blocked.attempted++;
      continue;
    }
    const blockers = contactBlockers(row, run);
    if (blockers.length) {
      blocked.review++;
      for (const reason of blockers) note(reason);
      continue;
    }
    if ((row.coverage ?? 0) < 0.8) blocked.low_coverage++;
    candidates.push(row);
  }
  candidates.sort((a, b) => b.match_score - a.match_score);
  return {
    candidates: candidates.slice(0, Math.max(0, limit - used.size)),
    blocked,
    reasons: [...reasons],
  };
}

// Count only scored matches in this batch, including matches already contacted.
export function matchProgress(run, rows, threshold, isBlacklisted) {
  const ids = new Set((run?.jobs || []).map((job) => job.job_id));
  const counts = { matched: 0, skipped: 0, title: 0, blacklist: 0 };
  for (const [jobId, application] of Object.entries(run?.applications || {}))
    if (application?.status === "title_skipped" && !ids.has(jobId))
      counts.title++;
  for (const row of rows) {
    if (!ids.delete(row.job_id)) continue;
    const application = run?.applications?.[row.job_id];
    if (
      ["already_contacted", "city_skipped", "review_required", "failed", "rejected"].includes(
        run?.applications?.[row.job_id]?.status,
      )
    )
      continue;
    if (isBlacklisted(row)) counts.blacklist++;
    else if (
      run.scope?.site === "liepin" &&
      application?.status === "contact_opened" &&
      Number.isFinite(application.score) && application.score >= threshold
    ) counts.matched++;
    else if (row.engine === "llm" && Number.isFinite(row.match_score)) {
      if (row.match_score < threshold) counts.skipped++;
      else if (row.eligibility?.status !== "reject") counts.matched++;
    }
  }
  return counts;
}
