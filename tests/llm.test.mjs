import test from "node:test";
import assert from "node:assert/strict";
import {
  LLM_PROMPT_VERSION,
  normalizeLLMStatus,
  parseModelJSON,
  scoringInput,
  scoringHelperError,
  scoringVersion,
  selectRelevantCV,
  validateLLMResult,
} from "../extension/llm.js";

test("LLM JSON is parsed and valid scores are normalized", () => {
  const parsed = parseModelJSON(
    '```json\n{"match_score":88.126,"verdict":"apply","summary":"fit","strengths":["Agent"],"gaps":[],"evidence":[{"dimension":"skill","jd_quote":"Agent","profile_quote":"Agent","reason":"both"}]}\n```',
  );
  const result = validateLLMResult(parsed);
  assert.equal(result.engine, "llm");
  assert.equal(result.version, LLM_PROMPT_VERSION);
  assert.equal(result.match_score, 88.13);
  assert.equal(result.verdict, "apply");
  assert.deepEqual(result.strengths, ["Agent"]);
  assert.equal(result.evidence.length, 1);
});

test("invalid LLM output never becomes a score", () => {
  assert.throws(() => parseModelJSON(""), /没有返回内容/);
  assert.throws(() => parseModelJSON("not json"), /不是有效 JSON/);
  assert.throws(() => validateLLMResult({ match_score: 101 }), /0到100/);
  assert.throws(() => validateLLMResult({ match_score: "88" }), /0到100/);
});

test("LLM status exposes only safe configuration metadata", () => {
  const status = normalizeLLMStatus({
    configured: true,
    model: "fixture",
    model_version: "v1",
    base_url: "http://localhost/v1",
    api_key_configured: true,
    api_key_override: true,
    api_key: "must-not-leak",
    ocr_ready: true,
  });
  assert.deepEqual(Object.keys(status).sort(), [
    "api_key_configured",
    "api_key_override",
    "base_url",
    "configured",
    "error",
    "model",
    "model_version",
    "ocr_ready",
  ]);
  assert.ok(!JSON.stringify(status).includes("must-not-leak"));
  assert.equal(status.api_key_override, true);
});

test("scoring input and version are deterministic", () => {
  const input = scoringInput(
    {
      job_id: "abc",
      title: "Agent",
      company: "Example",
      location_raw: "上海",
      salary_raw: "30-50K",
      jd: "Build agents",
    },
    { text: "Agent builder" },
    { excluded_terms: [] },
  );
  assert.equal(input.job.jd, "Build agents");
  assert.equal(input.preferences, undefined);
  assert.equal(
    scoringVersion("model-v1", "profile-v1"),
    scoringVersion("model-v1", "profile-v1"),
  );
  assert.notEqual(
    scoringVersion("model-v1", "profile-v1"),
    scoringVersion("model-v2", "profile-v1"),
  );
});

test("compact scoring input keeps relevant CV lines and bounded JD", () => {
  const cv = [
    "# Candidate",
    "Unrelated education history",
    "Built production Agent Runtime with MCP and RAG",
    "Managed platform engineering teams",
    ...Array.from({ length: 80 }, (_, index) =>
      `Filler line ${index} `.repeat(8),
    ),
  ].join("\n");
  const excerpt = selectRelevantCV(cv, "Agent Runtime MCP RAG platform", 500);
  assert.ok(excerpt.length <= 500);
  assert.match(excerpt, /Agent Runtime/);
  assert.ok(!excerpt.includes("Filler line 79"));
  const input = scoringInput(
    {
      job_id: "long",
      title: "Agent",
      jd: "A".repeat(9000),
    },
    { text: cv },
  );
  assert.ok(input.job.jd.length <= 5210);
  assert.ok(input.profile.text.length <= 16000);
});

test("full CV preserves project context and unknown requirements do not lower capability score", () => {
  const cv = "项目、角色及成果\n".repeat(600);
  assert.equal(
    scoringInput({ title: "AI", jd: "Agents" }, { text: cv }).profile.text,
    cv.trim(),
  );
  const result = validateLLMResult({
    match_score: 88,
    verdict: "apply",
    summary: "Agent经验匹配",
    requirements: [
      {
        requirement: "粤语",
        jd_quote: "粤语为工作语言",
        status: "unknown",
        reason: "未见证据",
      },
    ],
  });
  assert.equal(result.match_score, 88);
  assert.equal(result.requirements_status, "unknown");
  assert.equal(result.verdict, "review");
  assert.equal(
    validateLLMResult({
      match_score: 90,
      requirements: [
        { requirement: "学历", jd_quote: "本科", status: "unmet" },
      ],
    }).verdict,
    "reject",
  );
});

test("requirements quoted from the CV or invented outside the current JD cannot block contact", () => {
  const result = validateLLMResult(
    {
      match_score: 88,
      requirements: [
        {
          requirement: "学历",
          jd_quote: "本科及以上学历,计算机相关专业",
          status: "met",
        },
        {
          requirement: "英语",
          jd_quote: "英文可以作为工作语言(CET6)",
          status: "unknown",
          reason: "JD无明确语言要求",
        },
      ],
    },
    {
      jd: "岗位要求：本科及以上学历，计算机相关专业。开发 Skills 和 MCP 平台。",
    },
  );
  assert.equal(result.match_score, 88);
  assert.equal(result.requirements.length, 1);
  assert.equal(result.requirements_status, "met");
  assert.equal(result.verdict, "apply");
});

test("genuine unknown and unmet JD requirements still block automatic contact", () => {
  for (const status of ["unknown", "unmet"]) {
    const result = validateLLMResult(
      {
        match_score: 90,
        requirements: [
          {
            requirement: "英语",
            jd_quote: "英文可以作为工作语言（CET6）",
            status,
          },
        ],
      },
      { jd: "要求：英文可以作为工作语言(CET6)。" },
    );
    assert.equal(result.requirements_status, status);
    assert.equal(result.verdict, status === "unknown" ? "review" : "reject");
  }
});


test("old Helper prompt versions cannot silently produce scores without bonus fields", async () => {
  const { createHash } = await import("node:crypto");
  const meta = { configured: true, base_url: "https://example.test/v1", model: "fixture" };
  const version = (prompt) => createHash("sha256").update(JSON.stringify({ base_url: meta.base_url, model: meta.model, prompt })).digest("hex");
  assert.match(await scoringHelperError({ ...meta, version: version("job-match-v8") }), /restart.sh/);
  assert.equal(await scoringHelperError({ ...meta, version: version(LLM_PROMPT_VERSION) }), "");
  assert.match(await scoringHelperError({ ...meta, prompt_version: "job-match-v8" }), /版本过旧/);
  assert.equal(await scoringHelperError({ ...meta, prompt_version: LLM_PROMPT_VERSION }), "");
  assert.equal(await scoringHelperError({ configured: false }), "");
});
