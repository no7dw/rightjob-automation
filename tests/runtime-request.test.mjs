import test from "node:test";
import assert from "node:assert/strict";
import { scoringRequest } from "../extension/runtime-request.js";

test("a missing background response cannot leave scoring pending forever", async () => {
  let calls = 0;
  await assert.rejects(scoringRequest(() => { calls++; return new Promise(() => {}); }, 10), /评分响应超时/);
  assert.equal(calls, 1, "do not silently issue another score or contact action");
});
test("scoring responses and failures are preserved and timers are cleared", async () => {
  assert.deepEqual(await scoringRequest(async () => ({ ok: true, data: 88 }), 100), { ok: true, data: 88 });
  const error = new Error("Model HTTP 503");
  await assert.rejects(scoringRequest(async () => { throw error; }, 100), (value) => value === error);
});
