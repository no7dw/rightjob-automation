import test from "node:test";
import assert from "node:assert/strict";
import { PhaseTimer } from "../extension/timing.js";
import { safeTiming, timingWriter } from "../helper/timing-log.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pipeline phases add up without counting a model request twice", () => {
  let now = 0;
  const rows = [];
  const timer = new PhaseTimer({ trace_id: "trace", job_id: "job" }, (event, data) => rows.push({event, ...data}), () => now, () => new Date(now).toISOString());
  timer.phase("title_screen"); now = 20000;
  timer.phase("tab_open"); now = 20100;
  timer.phase("detail_load"); now = 23000;
  timer.phase("scoring"); now = 31000;
  timer.phase("cleanup"); now = 31100;
  timer.finish("contact_opened"); timer.finish("duplicate");
  const phases = rows.filter(r => r.event === "timing:phase");
  assert.equal(phases.reduce((sum, row) => sum + row.elapsed_ms, 0), 31100);
  assert.equal(rows.at(-1).elapsed_ms, 31100);
  assert.equal(rows.filter(r => r.event === "timing:total").length, 1);
  assert.deepEqual(phases.map(r => r.elapsed_ms), [20000,100,2900,8000,100]);
});
test("timing failures never fail a job", () => {
  const timer = new PhaseTimer({}, () => { throw new Error("disk full"); });
  timer.phase("contact");
  assert.doesNotThrow(() => timer.finish("completed"));
});
test("timing log stores only allowed metadata and appends valid JSON lines", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jseeker-timing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "timing.jsonl");
  const write = timingWriter(path);
  const event = { event: "timing:helper", phase: "evaluate", elapsed_ms: 8000, request_id: "r1",
    profile: { text: "private CV" }, api_key: "secret", input: "private CV", error: "private secret", title: "private title" };
  write([event]); write([{...event, request_id:"r2"}]);
  const text = readFileSync(path, "utf8");
  assert.equal(text.includes("private"), false);
  assert.equal(text.includes("secret"), false);
  assert.deepEqual(text.trim().split("\n").map(JSON.parse).map(r => r.request_id), ["r1","r2"]);
  assert.equal(safeTiming(null), null);
  assert.equal(safeTiming({elapsed_ms:NaN}), null);
});
