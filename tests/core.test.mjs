import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_WEIGHTS,
  DEFAULT_PREFS,
  MAJOR_CITIES,
  hasPUA,
  stripDecorativePUA,
  locationMatchesCities,
  parseSalary,
  jobId,
  normalizeJob,
  profileFromCV,
  redactCV,
  validatePrefs,
  validateSelectedCities,
  validateWeights,
  ruleEvaluation,
  hardFilter,
  weightedScore,
  validateEvaluation,
  csv,
  cacheKey,
  metrics,
  formatScore,
  lowCoverage,
} from "../extension/core.js";
const raw = {
  job_id: "abc123",
  url: "https://www.zhipin.com/job_detail/abc123.html?securityId=secret",
  title: "Agent平台架构师",
  company: "示例公司",
  jd_raw:
    "岗位职责：Python / Go、Agent、RAG、MCP 平台架构与自动化集成。任职要求：8年以上后端经验。",
  salary_raw: "30-50K·13薪",
  location_raw: "上海",
  identity_verified: true,
  extraction_status: "success",
  quality_flags: [],
};
const profile = await profileFromCV(
  "# Example Candidate\n16+ 年后端工程经验，负责 Python / Go Agent MCP RAG 平台架构与自动化集成。\n" +
    "生产交付、数据平台、多租户和电商业务。".repeat(10),
);
const job = normalizeJob(raw);

test("preferences validate separate JD and company blacklists", () => {
  const prefs = {
    salary_min_k: null,
    excluded_terms: ["外包"],
    excluded_companies: ["Example Corp"],
  };
  assert.deepEqual(validatePrefs(prefs), prefs);
  assert.throws(
    () => validatePrefs({ ...prefs, excluded_companies: ["valid", 1] }),
    /排除词须为文本数组/,
  );
  assert.deepEqual(validatePrefs({ salary_min_k: null, excluded_terms: ["外包"] }), {
    salary_min_k: null,
    excluded_terms: ["外包"],
    excluded_companies: [],
  });
});
test("salary monthly K/万 with explicit months", () => {
  assert.deepEqual(parseSalary("30-50K·13薪"), {
    min_k: 30,
    max_k: 50,
    months: 13,
  });
  assert.deepEqual(parseSalary("60-90K.16薪"), {
    min_k: 60,
    max_k: 90,
    months: 16,
  });
  assert.deepEqual(parseSalary("3–5万/月"), {
    min_k: 30,
    max_k: 50,
    months: null,
  });
});
test("unknown salary and PUA are never guessed", () => {
  for (const s of [
    "面议",
    "-K",
    "30-20K",
    "50-100万/年",
    "30-50K/年",
    "300-500元/天",
    "",
  ])
    assert.equal(parseSalary(s).min_k, null);
  assert.equal(hasPUA(""), true);
});
test("decorative PUA bullets are stripped while obfuscated text stays partial", () => {
  // Liepin pastes Wingdings bullets (U+F0B7) between readable JD lines.
  const jd =
    "\uF0B7负责工业智能体的设计与开发；\n\uF0B7熟悉Harness工程、Skill开发；";
  const cleaned = stripDecorativePUA(jd);
  assert.equal(hasPUA(cleaned), false);
  assert.equal(
    cleaned,
    "负责工业智能体的设计与开发；\n熟悉Harness工程、Skill开发；",
  );
  // Dense private-font runs mean real words were replaced: keep them flagged.
  const obfuscated = "\uF0B7\uF0B7\uF0B7\uF0B7\uF0B7\uF0B7岗位职责";
  assert.equal(stripDecorativePUA(obfuscated), obfuscated);
  assert.equal(hasPUA(stripDecorativePUA(obfuscated)), true);
});
test("canonical URL strips securityId and ignores invalid href", () => {
  assert.equal(job.url, "https://www.zhipin.com/job_detail/abc123.html");
  assert.equal(jobId("javascript:void(0)"), null);
  assert.equal(jobId("/job_detail/abc123.html"), "abc123");
});
test("location is always unverified and never filters", () => {
  assert.equal(
    normalizeJob({ ...raw, location_verified: true }).location_verified,
    false,
  );
  assert.equal(hardFilter(job, DEFAULT_PREFS).status, "pass");
});
test("selected city allowlist matches card locations and skips others", () => {
  assert.deepEqual(validateSelectedCities(["上海", "深圳", "上海"]), [
    "上海",
    "深圳",
  ]);
  assert.throws(() => validateSelectedCities(["Atlantis"]), /不支持的城市/);
  assert.throws(() => validateSelectedCities("深圳"), /须为数组/);
  assert.equal(locationMatchesCities("深圳·南山区·科技园", ["深圳"]), true);
  assert.equal(locationMatchesCities("上海·长宁区", ["深圳"]), false);
  assert.equal(locationMatchesCities("北京·海淀区", ["深圳", "北京"]), true);
  assert.equal(locationMatchesCities("", ["深圳"]), false);
  assert.ok(MAJOR_CITIES.includes("深圳"));
});
test("explicit salary floor and missing information", () => {
  assert.equal(
    hardFilter(job, { salary_min_k: 60, excluded_terms: [] }).status,
    "reject",
  );
  assert.equal(
    hardFilter(
      { ...job, salary: { min_k: null, max_k: null } },
      { salary_min_k: 60, excluded_terms: [] },
    ).status,
    "unknown",
  );
});
test("explicit exclusion records exact term", () =>
  assert.match(
    hardFilter(job, { salary_min_k: null, excluded_terms: ["架构"] })
      .reasons[0],
    /架构/,
  ));
test("profile strips personal contact and imported markdown syntax", () => {
  const text = redactCV(
    "电话：13800138000 | 邮箱：someone@example.com\n`16+` 年后端\nhttps://linkedin.com/example",
  );
  assert.ok(!text.includes("13800138000"));
  assert.ok(!text.includes("someone@example.com"));
  assert.ok(text.includes("16+ 年后端"));
});
test("example profile is synthetic and contains no contacts", async () => {
  const p = JSON.parse(await readFile("extension/profile.example.json"));
  assert.equal(p.is_example, true);
  assert.ok(p.text.length > 100);
  assert.ok(!/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b1[3-9]\d{9}\b/i.test(p.text));
});
test("invalid weights and preferences rejected", () => {
  assert.throws(() => validateWeights({ ...DEFAULT_WEIGHTS, skill: 0 }));
  assert.throws(() => validateWeights({ ...DEFAULT_WEIGHTS, skill: NaN }));
  assert.throws(() => validatePrefs({ salary_min_k: -1, excluded_terms: [] }));
  assert.throws(() =>
    validatePrefs({ salary_min_k: null, excluded_terms: [""] }),
  );
});
test("unknown dimensions are omitted with coverage, not assigned zero", () => {
  const e = {
    dimension_scores: {
      skill: 90,
      role: 80,
      seniority: null,
      domain: null,
      salary: null,
      other: null,
    },
  };
  const s = weightedScore(e, DEFAULT_WEIGHTS, { status: "pass" });
  assert.equal(s.match_score, 86);
  assert.equal(s.coverage, 0.5);
  assert.equal(s.needs_review, true);
});
test("no evidence does not produce a number", () =>
  assert.equal(
    weightedScore({ dimension_scores: {} }, DEFAULT_WEIGHTS, { status: "pass" })
      .match_score,
    null,
  ));
test("rules compare minimum years without rejecting experienced candidate", () => {
  const e = ruleEvaluation(job, profile, DEFAULT_PREFS);
  assert.equal(e.engine, "rules");
  assert.equal(e.dimension_scores.seniority, 100);
  assert.equal(e.dimension_scores.salary, null);
});
test("keyword Go does not match Google", () => {
  const e = ruleEvaluation(
    { ...job, title: "Google", jd: "Google cloud" },
    profile,
    DEFAULT_PREFS,
  );
  assert.equal(e.dimension_scores.skill, null);
});
test("AI result requires correct types and real quotes", () => {
  const value = {
    dimension_scores: {
      skill: 90,
      role: null,
      seniority: null,
      domain: null,
      salary: null,
      other: null,
    },
    evidence: [
      {
        dimension: "skill",
        jd_quote: "Python",
        profile_quote: "Python",
        reason: "both mention",
      },
    ],
    gaps: [],
  };
  assert.equal(
    validateEvaluation(value, job, profile, DEFAULT_PREFS).engine,
    "llm",
  );
  assert.throws(() =>
    validateEvaluation(
      { ...value, evidence: [{ ...value.evidence[0], jd_quote: "made up" }] },
      job,
      profile,
      DEFAULT_PREFS,
    ),
  );
  assert.throws(() =>
    validateEvaluation(
      {
        ...value,
        dimension_scores: { ...value.dimension_scores, skill: "90" },
      },
      job,
      profile,
      DEFAULT_PREFS,
    ),
  );
});
test("cache invalidates on JD, profile, preferences or model, not weights", async () => {
  const a = await cacheKey(job, profile, DEFAULT_PREFS);
  assert.notEqual(
    a,
    await cacheKey({ ...job, jd: "other" }, profile, DEFAULT_PREFS),
  );
  assert.notEqual(
    a,
    await cacheKey(job, { ...profile, version: "v2" }, DEFAULT_PREFS),
  );
  assert.notEqual(
    a,
    await cacheKey(job, profile, { salary_min_k: 50, excluded_terms: [] }),
  );
  assert.notEqual(a, await cacheKey(job, profile, DEFAULT_PREFS, "model-b"));
});
test("CSV protects formulas and quoting", () => {
  const out = csv([
    { job_id: "abc", title: '=HYPERLINK("evil")', company: "a,b" },
  ]);
  assert.ok(out.includes("'=HYPERLINK"));
  assert.ok(out.includes('"a,b"'));
});
test("metrics stay N/A until all jobs are reviewed", () => {
  assert.equal(
    metrics([{ human_label: "possible" }, { human_label: "" }]).precision_at_10,
    null,
  );
  assert.equal(
    metrics([
      {
        human_label: "possible",
        match_score: 90,
        eligibility: { status: "pass" },
      },
    ]).precision_at_10,
    1,
  );
});
test("normalization refuses mismatched ID or missing JD", () => {
  assert.throws(() => normalizeJob({ ...raw, job_id: "wrong" }));
  assert.throws(() => normalizeJob({ ...raw, jd_raw: "" }));
});
test("cache keys survive Chrome storage object key reordering", async () => {
  assert.equal(
    await cacheKey(job, profile, { salary_min_k: null, excluded_terms: [] }),
    await cacheKey(job, profile, { excluded_terms: [], salary_min_k: null }),
  );
});

test("manual corrected title normalizes without rewriting a missing raw title", () => {
  const raw = {
    job_id: "corrected",
    url: "https://www.zhipin.com/job_detail/corrected.html",
    title: null,
    jd_raw: "Agent 平台",
    salary_raw: null,
    corrections: { title: "Agent 架构师" },
  };
  assert.equal(normalizeJob(raw).title, "Agent 架构师");
  assert.equal(raw.title, null);
  assert.throws(() => normalizeJob({ ...raw, jd_raw: "  " }));
});

test("low-coverage score shows its coverage so it cannot read as a full match", () => {
  // The reported bug: a perfect score renormalized over half the rubric.
  assert.equal(formatScore(100, 0.5), "100 (50%)");
  assert.equal(lowCoverage(0.5), true);
  // Full and near-full coverage stay a plain score.
  assert.equal(formatScore(100, 1), "100");
  assert.equal(formatScore(87.5, 0.8), "87.5");
  assert.equal(lowCoverage(0.8), false);
  assert.equal(lowCoverage(1), false);
});

test("missing score or coverage never fabricates a percentage", () => {
  assert.equal(formatScore(null, 0.5), "—");
  assert.equal(formatScore(null, null), "—");
  // Unknown coverage must not be guessed into a low-coverage hint.
  assert.equal(formatScore(100, undefined), "100");
  assert.equal(lowCoverage(undefined), false);
  assert.equal(lowCoverage(null), false);
});
