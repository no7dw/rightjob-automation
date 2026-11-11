import test from "node:test";
import assert from "node:assert/strict";
import { readBlacklistedCard } from "../extension/boss-adapter.js";
import { isComplete, processedCount, validateCheckpoint } from "../extension/run-state.js";
import { initialRun } from "../extension/store.js";

test("title blacklist records only card evidence without opening or claiming a complete JD", () => {
  const card = {
    id: "job1", link: { href: "https://www.zhipin.com/job_detail/job1.html", innerText: " AI 工程师 " },
    el: { querySelector: () => null },
  };
  const raw = readBlacklistedCard(card, "工程师");
  assert.equal(raw.title, "AI 工程师");
  assert.equal(raw.jd_raw, null);
  assert.equal(raw.capture_scope, "card");
  assert.equal(isComplete(raw, {}), false);
  const run = initialRun({}, 1);
  run.jobs.push(raw);
  run.seen.push(raw.job_id);
  assert.equal(validateCheckpoint(run), run);
  assert.equal(processedCount(run), 0);
});

test("card rejection requires the hyperlink job identity to match", () => {
  assert.throws(() => readBlacklistedCard({ id: "job1", link: {
    href: "https://www.zhipin.com/job_detail/job2.html", innerText: "工程师",
  } }, "工程师"), /ID/);
});
