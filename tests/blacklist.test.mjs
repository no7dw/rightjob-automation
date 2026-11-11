import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRunBlacklist,
  companyBlacklistMatch,
  jobBlacklistMatch,
  parseBlacklist,
} from "../extension/blacklist.js";
import {
  failedJobs,
  processedCount,
  runCounts,
  validateCheckpoint,
} from "../extension/run-state.js";
import { initialRun } from "../extension/store.js";
import { canonicalURL } from "../extension/core.js";

test("blacklist accepts multiple separators and ignores empty or duplicate keywords", () => {
  assert.deepEqual(parseBlacklist(" aaa, BBB，aaa,\nccc,, bbb "), [
    "aaa",
    "BBB",
    "ccc",
  ]);
  assert.deepEqual(parseBlacklist(" ,，\n "), []);
  assert.throws(() => parseBlacklist(["valid", 3]), /须为文本/);
});

test("any literal keyword matches titles, JD, OCR and corrected text without case sensitivity", () => {
  assert.equal(
    jobBlacklistMatch({ title: "AI BBBB engineer", jd_raw: "clean" }, [
      "aaaa",
      "bbbb",
    ]),
    "bbbb",
  );
  assert.equal(
    jobBlacklistMatch({ jd_raw: "负责 C++ 和平台开发" }, ["C++"]),
    "C++",
  );
  assert.equal(
    jobBlacklistMatch({ jd_raw: "不相关", ocr_draft: "需要驻场" }, ["驻场"]),
    "驻场",
  );
  assert.equal(
    jobBlacklistMatch({ job_id: "a", jd_raw: "无关键词" }, ["外包"], {
      corrections: { a: { jd: "外包团队" } },
    }),
    "外包",
  );
  assert.equal(jobBlacklistMatch({ jd_raw: "aaa" }, ["aaaa", "bbbb"]), "");
  assert.equal(jobBlacklistMatch({ jd_raw: "anything" }, []), "");
});

test("blacklist decisions can be reapplied to existing jobs and cleared without losing evidence or scores", () => {
  const job = (id, jd) => ({
    job_id: id,
    url: canonicalURL(id),
    title: "架构师",
    jd_raw: jd,
    salary_raw: "30-50K",
    location_raw: "深圳",
    location_verified: false,
    identity_verified: true,
    extraction_status: "success",
    collected_at: new Date().toISOString(),
  });
  const run = initialRun({}, 1);
  run.jobs = [job("a", "外包开发"), job("b", "平台开发")];
  run.seen = ["a", "b"];
  run.attempts = [
    { job_id: "a", status: "failed", reason: "previous failure" },
  ];
  run.scores = { a: { match_score: 95 } };
  run.score_failures = { a: { reason: "previous model failure" } };
  applyRunBlacklist(run, ["外包"]);
  assert.equal(run.jobs[0].blacklist_keyword, "外包");
  assert.equal(processedCount(run), 1);
  assert.equal(runCounts(run).successful, 1);
  assert.deepEqual(failedJobs(run), []);
  assert.deepEqual(run.score_failures, {});
  assert.equal(validateCheckpoint(run), run);
  assert.equal(run.scores.a.match_score, 95);
  applyRunBlacklist(run, []);
  assert.equal(run.jobs[0].blacklist_keyword, undefined);
  assert.equal(processedCount(run), 2);
  assert.equal(run.jobs.length, 2);
});

test("company blacklist matches company names and applies to saved jobs", () => {
  const job = { job_id: "a", title: "架构师", company: "Example Corp" };
  assert.equal(companyBlacklistMatch(job, ["other", "example"]), "example");
  assert.equal(
    companyBlacklistMatch(job, ["example"], {
      corrections: { a: { company: "另一家" } },
    }),
    "",
  );
  assert.equal(
    companyBlacklistMatch({ job_id: "a", company: "另一家" }, ["example"], {
      corrections: { a: { company: "另一家" } },
    }),
    "",
  );
  assert.equal(
    companyBlacklistMatch({ job_id: "a" }, ["另一家"], {
      corrections: { a: { company: "另一家" } },
    }),
    "另一家",
  );
  assert.equal(companyBlacklistMatch({ company: "Example Corp" }, []), "");

  const run = initialRun({}, 1);
  run.jobs = [
    {
      job_id: "a",
      url: canonicalURL("a"),
      title: "架构师",
      company: "Example Corp",
      jd_raw: "平台开发",
      salary_raw: "30-50K",
      location_raw: "深圳",
      location_verified: false,
      identity_verified: true,
      extraction_status: "success",
      collected_at: new Date().toISOString(),
    },
  ];
  run.seen = ["a"];
  run.scores = { a: { match_score: 95 } };
  applyRunBlacklist(run, [], ["example"]);
  assert.equal(run.jobs[0].blacklist_keyword, "example");
  applyRunBlacklist(run, [], []);
  assert.equal(run.jobs[0].blacklist_keyword, undefined);
});
