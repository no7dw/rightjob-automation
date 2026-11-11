import test from "node:test";
import assert from "node:assert/strict";
import { initialRun } from "../extension/store.js";
import { canonicalURL } from "../extension/core.js";
import {
  validateCheckpoint,
  isComplete,
  runCounts,
  failedJobs,
  failureCount,
  retryFailures,
  scoringFailures,
  scoringFailureText,
  mergeOCRPages,
  needsReview,
  contactCandidates,
  contactBlockers,
  unresolvedFlags,
} from "../extension/run-state.js";
const job = (id = "a") => ({
  job_id: id,
  url: canonicalURL(id),
  title: "架构师",
  company: null,
  jd_raw: "Python Agent 平台工作流",
  salary_raw: "30-50K",
  salary: { min_k: 30, max_k: 50, months: null },
  location_raw: "上海",
  location_verified: false,
  identity_verified: true,
  extraction_status: "success",
  collected_at: new Date().toISOString(),
  quality_flags: [],
});
function runWith(jobs = []) {
  return {
    ...initialRun({}),
    status: "paused",
    jobs,
    seen: jobs.map((j) => j.job_id),
  };
}
test("checkpoint rejects duplicates, wrong identity, empty complete JD and invalid salary", () => {
  for (const jobs of [
    [job(), job()],
    [{ ...job(), identity_verified: false }],
    [{ ...job(), jd_raw: "  " }],
    [{ ...job(), salary: { min_k: 50, max_k: 30, months: null } }],
    [{ ...job(), salary: { min_k: NaN, max_k: 50, months: null } }],
  ])
    assert.throws(() => validateCheckpoint(runWith(jobs)));
  assert.equal(validateCheckpoint(runWith([job()])).jobs.length, 1);
  assert.throws(() => validateCheckpoint({ ...runWith([job()]), seen: [] }));
});
test("manual full-JD correction completes a partial without changing raw snapshot", () => {
  const partial = { ...job(), jd_raw: null, extraction_status: "partial" },
    run = runWith([partial]);
  const snapshot = JSON.stringify(partial);
  assert.equal(runCounts(run).successful, 0);
  run.corrections.a = { jd: "经人工核实的完整 Agent 需求" };
  assert.equal(isComplete(partial, run), true);
  assert.deepEqual(runCounts(run), {
    successful: 1,
    partial: 0,
    failed: 0,
    failure_attempts: 0,
  });
  assert.equal(JSON.stringify(partial), snapshot);
  assert.equal(
    isComplete({ ...partial, identity_verified: false }, run),
    false,
  );
});
test("scoring failures name the job and retry clears the pending failure", () => {
  const run = runWith([job("scored-job")]);
  run.score_failures = {
    scored_job: { reason: "ignored unknown job" },
    "scored-job": { reason: "model unavailable" },
  };
  assert.deepEqual(scoringFailures(run), [
    {
      job_id: "scored-job",
      title: "架构师",
      reason: "model unavailable",
    },
  ]);
  assert.equal(
    scoringFailureText(run),
    "AI 评分失败：架构师：model unavailable",
  );
  retryFailures(run);
  assert.deepEqual(scoringFailures(run), []);
});

test("explicit retry resets bounded retry budget while retaining all historical attempts", () => {
  const run = runWith();
  run.attempts = [
    { job_id: "a", status: "failed", reason: "timeout" },
    { job_id: "a", status: "failed", reason: "timeout" },
  ];
  run.score_failures = { a: { reason: "model unavailable" } };
  assert.equal(failedJobs(run).length, 1);
  assert.equal(failureCount(run, "a"), 2);
  retryFailures(run);
  assert.equal(failureCount(run, "a"), 0);
  assert.equal(run.score_failures.a, undefined);
  assert.equal(run.attempts.length, 2);
  run.attempts.push({ job_id: "a", status: "failed", retry_epoch: 1 });
  assert.equal(failureCount(run, "a"), 1);
  run.jobs.push(job());
  run.seen.push("a");
  assert.equal(failedJobs(run).length, 0);
  assert.equal(runCounts(run).failure_attempts, 3);
  assert.throws(() => retryFailures({ ...run, status: "running" }));
});
test("OCR merging removes only adjacent page overlap, preserving repeated text elsewhere", () => {
  assert.equal(
    mergeOCRPages(["简介\n职责\nPython", "职责\nPython\n要求\n简介"]),
    "简介\n职责\nPython\n要求\n简介",
  );
  assert.equal(mergeOCRPages(["A\nB", "A\nB"]), "A\nB");
});
test("review filter includes unreadable, low-confidence and unscored records", () => {
  const j = job(),
    run = runWith([j]);
  assert.equal(
    needsReview(
      { ...j, match_score: 90, coverage: 1, needs_review: false },
      run,
    ),
    false,
  );
  assert.ok(needsReview({ ...j, match_score: 90, needs_review: true }, run));
  assert.ok(needsReview(j, run));
});
test("contact queue ranks by score, honours remaining quota and never returns rejected jobs", () => {
  const jobs = [job("a"), job("b"), job("c"), job("d")],
    run = runWith(jobs);
  const scored = (id, score, extra = {}) => ({
    ...jobs.find((j) => j.job_id === id),
    match_score: score,
    coverage: 1,
    needs_review: false,
    ...extra,
  });
  const result = contactCandidates(
    [
      scored("a", 70),
      scored("b", 95, { eligibility: { status: "pass" } }),
      scored("c", 90, {
        eligibility: { status: "reject", reasons: ["命中排除词"] },
      }),
      scored("d", 60),
    ],
    run,
    ["d"],
    5,
  );
  assert.deepEqual(
    result.candidates.map((r) => r.job_id),
    ["b", "a"],
  );
  assert.equal(result.blocked.rejected, 1);
  assert.equal(result.blocked.attempted, 1);
});
test("contact queue reports why every job was blocked", () => {
  const jobs = [job("a"), job("b"), job("c")],
    run = runWith(jobs);
  const result = contactCandidates(
    [
      { ...jobs[0] },
      {
        ...jobs[1],
        match_score: 88,
        coverage: 0.5,
        needs_review: true,
        quality_flags: ["salary_unknown"],
        eligibility: { status: "pass" },
      },
      {
        ...jobs[2],
        match_score: 91,
        coverage: 1,
        needs_review: true,
        quality_flags: ["jd_private_font"],
        eligibility: { status: "unknown" },
      },
    ],
    run,
    [],
    5,
  );
  assert.equal(result.candidates.length, 0);
  assert.equal(result.blocked.unscored, 1);
  assert.equal(result.blocked.review, 2);
  assert.equal(result.blocked.low_coverage, 0);
  const counts = new Map(result.reasons);
  assert.deepEqual(
    [...counts.keys()].sort(),
    ["eligibility_unknown", "jd_private_font", "salary_unknown"].sort(),
  );
});
test("coverage below 80% warns but no longer blocks the contact queue", () => {
  const j = job("a"),
    run = runWith([j]);
  const thin = {
    ...j,
    match_score: 88,
    coverage: 0.5,
    needs_review: true,
    quality_flags: [],
    eligibility: { status: "pass" },
  };
  assert.equal(contactCandidates([thin], run, [], 5).candidates.length, 1);
  assert.equal(contactCandidates([thin], run, [], 5).blocked.low_coverage, 1);
  assert.ok(needsReview(thin, run));
  const covered = { ...thin, coverage: 1, needs_review: false };
  assert.equal(
    contactCandidates([covered], run, [], 5).blocked.low_coverage,
    0,
  );
});
test("human correction resolves the flags it verifies and unblocks the job", () => {
  const j = job("a"),
    run = runWith([j]);
  const flagged = {
    ...j,
    match_score: 88,
    coverage: 1,
    needs_review: true,
    quality_flags: [
      "salary_unknown",
      "salary_ocr_review",
      "human_corrected_jd",
    ],
    eligibility: { status: "pass" },
  };
  assert.equal(contactCandidates([flagged], run, [], 5).candidates.length, 0);
  const corrected = {
    ...run,
    corrections: { a: { jd: "Python Agent 平台工作流", salary: "30-50K" } },
  };
  assert.deepEqual(unresolvedFlags(flagged, corrected), []);
  assert.equal(
    contactCandidates([flagged], corrected, [], 5).candidates.length,
    1,
  );
  assert.equal(
    needsReview({ ...flagged, needs_review: false }, corrected),
    false,
  );
  assert.ok(needsReview(flagged, run));
  const jdOnly = { ...corrected, corrections: { a: { jd: "确认后的 JD" } } };
  assert.deepEqual(unresolvedFlags(flagged, jdOnly), [
    "salary_unknown",
    "salary_ocr_review",
  ]);
});

test("match target excludes low scores, blacklist, and unscored jobs", async () => {
  const { matchProgress } = await import("../extension/run-state.js");
  const rows = [
    { job_id: "a", engine: "llm", match_score: 80 },
    { job_id: "b", engine: "llm", match_score: 79 },
    { job_id: "c", engine: "llm", match_score: 99, blacklist_keyword: "x" },
    { job_id: "d", engine: "llm", match_score: null },
    {
      job_id: "e",
      engine: "llm",
      match_score: 90,
      eligibility: { status: "reject" },
    },
    { job_id: "outside", engine: "llm", match_score: 90 },
  ];
  const run = { jobs: rows.slice(0, 5) };
  assert.deepEqual(
    matchProgress(run, rows, 80, (row) => !!row.blacklist_keyword),
    {
      matched: 1,
      skipped: 1,
      title: 0,
      blacklist: 1,
    },
  );
});
test("title-skipped applications add a TITLE count", async () => {
  const { matchProgress } = await import("../extension/run-state.js");
  const run = {
    jobs: [],
    applications: {
      t1: { status: "title_skipped" },
      t2: { status: "title_skipped" },
      t3: { status: "below_threshold" },
    },
  };
  assert.deepEqual(
    matchProgress(run, [], 80, () => false),
    {
      matched: 0,
      skipped: 0,
      title: 2,
      blacklist: 0,
    },
  );
});

test("separate hard requirements block contact without changing capability score", () => {
  const raw = job();
  const run = initialRun({});
  assert.ok(
    contactBlockers(
      { ...raw, match_score: 90, requirements_status: "unknown" },
      run,
    ).includes("requirements_unknown"),
  );
  assert.ok(
    contactBlockers(
      { ...raw, match_score: 90, requirements_status: "unmet" },
      run,
    ).includes("requirements_unmet"),
  );
});

test("review-required, rejected, and failed jobs never consume the match target", async () => {
  const { matchProgress } = await import("../extension/run-state.js");
  const rows = ["review_required", "rejected", "failed", "contact_opened"].map((status) => ({ job_id: status, engine: "llm", match_score: 90 }));
  const run = { jobs: rows, applications: Object.fromEntries(rows.map((row) => [row.job_id, { status: row.job_id }])) };
  assert.equal(matchProgress(run, rows, 80, () => false).matched, 1);
});

test("confirmed contacts keep their batch progress when a prompt update expires cached scores", async () => {
  const { matchProgress } = await import("../extension/run-state.js");
  const run = { scope: { site: "liepin" }, jobs: [job("a"),job("b")], applications: {
    a: { status: "contact_opened", score: 88 }, b: { status: "already_contacted", score: 95 },
  } };
  assert.equal(matchProgress(run, run.jobs, 80, () => false).matched, 1);
  assert.equal(matchProgress(run, run.jobs, 90, () => false).matched, 0);
});
