import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyBossMessage,
  chooseChineseResume,
} from "../extension/boss-message-rules.js";
import { autoReplyState } from "../extension/auto-reply-state.js";

test("BOSS rejection templates are read without asking a model", () => {
  for (const value of [
    "[祈祷] 不好意思，不太合适哦",
    "对不起，看了你的简历以后觉得不太合适",
    "感谢您的申请，但是我们需要的技能不符合",
    "您的经验与岗位要求有差距",
    "很遗憾，我们无法继续推进",
    "Sorry, not a good fit for this role",
    "不合适，不用发简历了",
    "感谢您的申请，但目前我们需要的技能组合与您的不完全符合。祝您在BOSS直聘找到理想的工作！",
    "很高兴收到您的应聘，但您的技能组合和我们目前项目的需求不完全吻合。祝您找到更好的机会！",
    "经过认真考虑，我们认为您的经验与我们的职位需求并不完全一致。祝您找到理想的工作！",
    "非常感谢您的投递，但是我们目前的职位需要一些其他经验和技能。祝您找到更好的工作机会！",
  ])
    assert.equal(classifyBossMessage(value), "rejection", value);
});

test("BOSS only treats requests for a resume as auto-send candidates", () => {
  for (const value of [
    "我想要一份您的附件简历，您是否同意",
    "可以发一份简历吗？",
    "方便给我您的简历看看吗",
    "你好，可以看看您的简历吗",
    "Please send your CV",
    "麻烦提供附件简历",
  ])
    assert.equal(classifyBossMessage(value), "resume_request", value);
  for (const value of [
    "您好，在看机会吗",
    "您正在与Boss沟通",
    "您能介绍一下项目经验吗",
    "简历已收到，谢谢",
    "不用发简历",
    "我们已查看您的简历",
    "不好意思，刚刚在开会",
    "这份简历写得很好",
    "附件简历请求已发送",
    "对方已同意，您的附件简历已发送给对方",
  ])
    assert.equal(classifyBossMessage(value), "unknown", value);
});

test("choose exactly one explicitly Chinese resume, never fallback to English or first file", () => {
  assert.equal(
    chooseChineseResume(["Candidate-CV.pdf", "Candidate-CV-cn.pdf"]),
    "Candidate-CV-cn.pdf",
  );
  assert.equal(
    chooseChineseResume(["resume-en.pdf", "简历-中文.pdf"]),
    "简历-中文.pdf",
  );
  assert.equal(chooseChineseResume(["resume-zh-CN.pdf"]), "resume-zh-CN.pdf");
  assert.equal(chooseChineseResume(["resume.pdf", "resume-en.pdf"]), null);
  assert.equal(chooseChineseResume(["old-cn.pdf", "new-cn.pdf"]), null);
  assert.equal(chooseChineseResume(["cncompany.pdf"]), null);
});

function fixture(initial = {}) {
  const data = structuredClone(initial);
  const storage = {
    get: async () => structuredClone(data),
    set: async (update) => Object.assign(data, structuredClone(update)),
  };
  const call = (type, values = {}, tab = 1, now = 1000) =>
    autoReplyState(
      storage,
      { type, token: "document-1", ...values },
      { tab: { id: tab } },
      now,
    );
  return { data, call };
}

test("default off and disabling immediately revokes the active lease", async () => {
  const { data, call } = fixture();
  assert.deepEqual(await call("GET_BOSS_AUTO_REPLY_STATE"), {
    enabled: false,
    busy: false,
  });
  assert.equal(await call("BOSS_AUTO_REPLY_CLAIM"), false);
  await call("SET_AUTO_REPLY_MESSAGES", { enabled: true });
  assert.equal(await call("BOSS_AUTO_REPLY_CLAIM"), true);
  await call("SET_AUTO_REPLY_MESSAGES", { enabled: false });
  assert.equal(data.boss_auto_reply_lease, null);
  assert.equal(
    await call("BOSS_AUTO_REPLY_AUTHORIZE_SEND", { key: "a".repeat(64) }),
    false,
  );
  await assert.rejects(
    call("SET_AUTO_REPLY_MESSAGES", { enabled: "yes" }),
    /布尔值/,
  );
});

test("one tab and document may send; durable attempt ledger prevents retries", async () => {
  const { data, call } = fixture({ auto_reply_messages: true });
  assert.equal(await call("BOSS_AUTO_REPLY_CLAIM"), true);
  assert.equal(await call("BOSS_AUTO_REPLY_CLAIM", {}, 2), false);
  assert.equal(
    await call("BOSS_AUTO_REPLY_CLAIM", { token: "document-2" }),
    false,
  );
  assert.equal(
    await call("BOSS_AUTO_REPLY_AUTHORIZE_SEND", { key: "a".repeat(64) }, 2),
    false,
  );
  assert.equal(
    await call("BOSS_AUTO_REPLY_AUTHORIZE_SEND", { key: "a".repeat(64) }),
    true,
  );
  const afterRestart = fixture(data);
  assert.equal(
    await afterRestart.call("BOSS_AUTO_REPLY_AUTHORIZE_SEND", {
      key: "a".repeat(64),
    }),
    false,
  );
  assert.equal(
    await call("BOSS_AUTO_REPLY_AUTHORIZE_SEND", { key: "bad-key" }),
    false,
  );
  assert.equal(
    await call(
      "BOSS_AUTO_REPLY_AUTHORIZE_SEND",
      { key: "b".repeat(64) },
      1,
      17000,
    ),
    false,
  );
  assert.equal(
    await call("BOSS_AUTO_REPLY_CLAIM", { token: "document-2" }, 2, 17000),
    true,
  );
});

test("bonus draft handoffs block both reading and CV sends", async () => {
  const { call } = fixture({
    auto_reply_messages: true,
    run: { bonus_review: { job_id: "job1" } },
  });
  assert.deepEqual(await call("GET_BOSS_AUTO_REPLY_STATE"), {
    enabled: true,
    busy: true,
  });
  assert.equal(await call("BOSS_AUTO_REPLY_CLAIM"), false);
});

test("transient failures retry with backoff at most three times", async () => {
  const { BossAutoReply } = await import("../extension/auto-reply-boss.js");
  const runner = new BossAutoReply({ doc: {}, api: async () => true });
  const target = { key: "id:123", preview: "请发简历" };
  let calls = 0;
  runner.processContact = async () => { calls++; };
  await runner.process(target);
  assert.equal(calls, 1);
  await runner.process(target);
  assert.equal(calls, 1, "backoff suppresses immediate retries");
  for (let i = 0; i < 2; i++) {
    runner.retries.get("id:123|请发简历").nextAt = 0;
    await runner.process(target);
  }
  assert.equal(calls, 3);
  assert.equal(runner.retries.size, 0);
  await runner.process(target);
  assert.equal(calls, 3, "exhausted request cannot loop indefinitely");
});

test("completed or authorization-attempted requests are never retried", async () => {
  const { BossAutoReply } = await import("../extension/auto-reply-boss.js");
  for (const uncertain of [false, true]) {
    const runner = new BossAutoReply({ doc: {}, api: async () => true });
    const target = { key: "id:123", preview: "请发简历" };
    let calls = 0;
    runner.processContact = async () => {
      calls++;
      if (uncertain) {
        runner.seen.add("id:123|请发简历");
        throw new Error("authorization response lost");
      }
      return true;
    };
    await runner.process(target).catch(() => {});
    await runner.process(target);
    assert.equal(calls, 1);
    assert.equal(runner.retries.size, 0);
  }
});
