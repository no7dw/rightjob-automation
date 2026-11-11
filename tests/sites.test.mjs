import test from "node:test";
import assert from "node:assert/strict";
import { siteForURL, liepinIdentity, isListPage } from "../extension/sites.js";
import { jobId, canonicalURL } from "../extension/core.js";
import { validateCheckpoint } from "../extension/run-state.js";
import { initialRun } from "../extension/store.js";

test("site and job identity distinguish hosts, job kinds, and tracking URLs", () => {
  assert.equal(siteForURL("https://c.liepin.com/"), "liepin");
  assert.equal(siteForURL("https://liepin.com.evil.test/a/123.shtml"), null);
  assert.equal(siteForURL("http://www.liepin.com/a/123.shtml"), null);
  assert.equal(isListPage("https://c.liepin.com/?time=123"), true);
  assert.equal(isListPage("https://www.liepin.com/a/123.shtml"), false);
  assert.equal(
    jobId("https://www.liepin.com/a/123.shtml?job_id=999"),
    "liepin:a:123",
  );
  assert.equal(jobId("https://www.liepin.com/job/123.shtml"), "liepin:job:123");
  assert.equal(jobId("https://evil.test/job_detail/123.html"), null);
  assert.equal(liepinIdentity("https://c.liepin.com/a/123.shtml"), null);
  assert.equal(
    canonicalURL("liepin:a:123"),
    "https://www.liepin.com/a/123.shtml",
  );
  assert.equal(
    canonicalURL("legacy"),
    "https://www.zhipin.com/job_detail/legacy.html",
  );
});
test("checkpoints accept Liepin identities while preserving legacy BOSS records", () => {
  const run = initialRun({ site: "liepin" });
  run.jobs.push({
    job_id: "liepin:a:123",
    url: canonicalURL("liepin:a:123"),
    title: "CTO",
    jd_raw: "Build agents",
    identity_verified: true,
    location_verified: false,
    extraction_status: "success",
    collected_at: new Date().toISOString(),
  });
  run.seen.push("liepin:a:123");
  assert.equal(validateCheckpoint(run), run);
});
