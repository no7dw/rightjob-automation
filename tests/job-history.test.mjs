import test from "node:test";
import assert from "node:assert/strict";
import {
  contactRecord,
  indexScore,
  indexedScore,
  isContactedEntry,
  jobFingerprint,
  scoreIsCurrent,
} from "../extension/job-history.js";

const raw = {
  job_id: "job-a",
  title: "Agent 架构师",
  company: "Example",
  jd_raw: "Python Agent 平台",
};

test("job fingerprint changes when the JD changes", async () => {
  const first = await jobFingerprint(raw);
  assert.equal(first, await jobFingerprint(raw));
  assert.notEqual(
    first,
    await jobFingerprint({ ...raw, jd_raw: "Java backend" }),
  );
});

test("score reuse requires profile and model versions to match", async () => {
  const fingerprint = await jobFingerprint(raw);
  const index = indexScore({
    raw,
    fingerprint,
    score: {
      match_score: 91,
      verdict: "apply",
      summary: "fit",
      scored_at: "2026-10-22T00:00:00.000Z",
    },
    profileVersion: "profile-a",
    model: "model-a",
    modelVersion: "model-version-a",
    scoringVersion: "scoring-a",
  });
  assert.ok(
    scoreIsCurrent(index["job-a"], {
      profileVersion: "profile-a",
      modelVersion: "model-version-a",
    }),
  );
  assert.equal(
    scoreIsCurrent(index["job-a"], {
      profileVersion: "profile-b",
      modelVersion: "model-version-a",
    }),
    false,
  );
  assert.equal(
    indexedScore(index, "job-a", {
      profileVersion: "profile-a",
      modelVersion: "model-version-a",
    }).score,
    91,
  );
});

test("contact history is idempotent and rejects a changed JD", async () => {
  const fingerprint = await jobFingerprint(raw);
  const first = contactRecord({
    raw,
    fingerprint,
    score: { match_score: 88 },
    threshold: 75,
    runId: "run-a",
    status: "opening",
    at: "2026-10-22T00:00:00.000Z",
  });
  const second = contactRecord({
    existing: first,
    raw,
    fingerprint,
    score: { match_score: 88 },
    threshold: 75,
    runId: "run-b",
    status: "contact_opened",
    at: "2026-10-23T00:00:00.000Z",
  });
  assert.equal(second.contacted_at, first.contacted_at);
  assert.equal(second.status, "contact_opened");
  assert.ok(isContactedEntry(second, "job-a", fingerprint));
  assert.equal(isContactedEntry(second, "job-a", "different"), false);
});
