import test from "node:test";
import assert from "node:assert/strict";
import { initBossBonusChat } from "../extension/bonus-chat-boss.js";

test("bonus chat recovers after errors, deduplicates completed tasks and accepts a new task", async (t) => {
  const names = ["chrome", "document", "__jseekerBossBonusChat", "__jseekerBossBonusCompleted"];
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, index) => {
    if (originals[index]) Object.defineProperty(globalThis, name, originals[index]);
    else delete globalThis[name];
  }));
  let fail = true;
  let job = "job1";
  const results = [];
  globalThis.chrome = { runtime: { sendMessage: async (message) => {
    if (fail) throw new Error("worker restarting");
    if (message.type === "BOSS_BONUS_CHAT_READY") return { ok: true, data: { run_id: "run1", job_id: job, message: "bonus", send_attempted: true } };
    results.push(message);
    return { ok: true, data: true };
  } } };
  const element = () => ({ append() {}, attachShadow: element });
  globalThis.document = { getElementById: () => null, createElement: element, documentElement: element() };
  globalThis.__jseekerBossBonusChat = false;
  globalThis.__jseekerBossBonusCompleted = new Set();
  await initBossBonusChat();
  assert.equal(globalThis.__jseekerBossBonusChat, false);
  fail = false;
  await initBossBonusChat();
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "send_unconfirmed");
  assert.equal(globalThis.__jseekerBossBonusChat, false);
  await initBossBonusChat();
  assert.equal(results.length, 1, "same completed task does not repeat");
  job = "job2";
  await initBossBonusChat();
  assert.equal(results.length, 2, "new task can run in same document");
});
