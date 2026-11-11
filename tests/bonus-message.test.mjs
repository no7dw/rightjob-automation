import test from "node:test";
import assert from "node:assert/strict";
import {
  bonusMessage,
  validateBonusMatches,
  MAX_BONUS_MATCHES,
} from "../extension/bonus-message.js";

import { fillBonusDraft, sendBonusMessage } from "../extension/bonus-editor.js";

const profileText =
  "使用 Langfuse 和 Ragas 进行评测。AI agent 真实落地&上线&评测。技术博客、演讲。";
const matches = [
  {
    label: "Langfuse",
    jd_quote: "用过 Langfuse、Promptfoo、Ragas 等评测或观测工具",
    profile_quote: "使用 Langfuse 和 Ragas 进行评测",
  },
  {
    label: "技术博客、演讲",
    jd_quote: "技术博客、演讲、GitHub项目",
    profile_quote: "技术博客、演讲",
  },
];

test("bonus messages use only grounded bonus sections from both example formats", () => {
  const first = validateBonusMatches(matches, {
    profileText,
    jd: "要求：\n加分项用过 Langfuse、Promptfoo、Ragas 等评测或观测工具。有内容安全或 AI安全测试经验。有医疗健康类产品经验。",
  });
  assert.deepEqual(first, [matches[0]]);
  assert.equal(bonusMessage(first), "加分项也涉及，包括Langfuse等。");
  const second = {
    label: "AI agent 真实落地&上线&评测",
    jd_quote: "有AI平台、智能体(Agent)、RPA、自动化系统等中台建设经验",
    profile_quote: "AI agent 真实落地&上线&评测",
  };
  const valid = validateBonusMatches([second, matches[1]], {
    profileText,
    jd: "加分项\n有AI平台、智能体(Agent)、RPA、自动化系统等中台建设经验;有开源项目贡献或技术社区影响力(如技术博客、演讲、GitHub项目)。",
  });
  assert.equal(valid.length, 2);
  assert.equal(
    bonusMessage(valid),
    "加分项多项也涉及，包括AI agent 真实落地&上线&评测、技术博客、演讲等。",
  );
});

test("reject invented CV evidence, unrelated sections, and unsupported labels", () => {
  for (const jd of [
    "岗位要求：用过 Langfuse、Promptfoo、Ragas 等评测或观测工具",
    "加分项\n医疗经验\n岗位职责\n用过 Langfuse、Promptfoo、Ragas 等评测或观测工具",
  ]) {
    assert.deepEqual(validateBonusMatches(matches, { jd, profileText }), []);
  }
  const jd =
    "加分项：用过 Langfuse、Promptfoo、Ragas 等评测或观测工具。有医疗健康类产品经验。T9。";
  for (const item of [
    { ...matches[0], label: "医疗健康", profile_quote: "有医疗健康类产品经验" },
    { ...matches[0], label: "T9" },
    { ...matches[0], label: "Promptfoo" },
    { ...matches[0], jd_quote: "不存在的原文" },
  ])
    assert.deepEqual(validateBonusMatches([item], { jd, profileText }), []);
  assert.deepEqual(validateBonusMatches(matches, { jd }), []);
  assert.equal(bonusMessage([]), "");
  assert.equal(
    validateBonusMatches([matches[0], matches[0]], { jd, profileText }).length,
    1,
  );
});

test("draft input never overwrites text, sends keys or clicks Send", (t) => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  t.after(() => {
    globalThis.getComputedStyle = original;
  });
  const events = [];
  class TextArea {
    set value(v) {
      this.text = v;
    }
    get value() {
      return this.text || "";
    }
  }
  const view = { HTMLTextAreaElement: TextArea, InputEvent: Event, Event };
  const editor = Object.assign(new TextArea(), {
    tagName: "TEXTAREA",
    ownerDocument: { defaultView: view },
    getBoundingClientRect: () => ({ width: 100, height: 50 }),
    getAttribute: () => "",
    dispatchEvent: (e) => events.push(e.type),
    click: () => assert.fail("must not click"),
  });
  const root = { querySelectorAll: () => [editor] };
  assert.equal(
    fillBonusDraft(root, "加分项也涉及，包括评测等。").status,
    "prepared",
  );
  assert.equal(editor.value, "加分项也涉及，包括评测等。");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(fillBonusDraft(root, editor.value).status, "already_prepared");
  assert.equal(fillBonusDraft(root, "另一个消息").status, "existing_draft");
  assert.equal(
    fillBonusDraft({ querySelectorAll: () => [editor, editor] }, "消息").status,
    "ambiguous_editor",
  );
  assert.equal(fillBonusDraft(null, "消息").status, "editor_missing");
  const rich = { ...editor, textContent: "" };
  assert.equal(
    fillBonusDraft({ querySelectorAll: () => [rich] }, "评测").status,
    "prepared",
  );
  assert.equal(rich.textContent, "评测");
});


test("JD-led summaries combine separate CV evidence for management, languages, and platform reuse", () => {
  const jd = "5.加分项：\n(3)有AI应用平台化、组件化或多业务线复用经验。\n(4)有技术团队指导、项目管理或跨部门技术负责人经验。\n(6)具备良好英文读写能力，会粤语为加分项。\n软素质：逻辑清晰";
  const cv = "带领 25 人工程团队。英语：商务沟通，CET-6。粤语：日常沟通。统一工具接入与跨产品复用。负责生产部署和持续优化。";
  const candidates = [
    { label: "带领25人工程团队", jd_quote: "有技术团队指导、项目管理或跨部门技术负责人经验", profile_quotes: ["带领 25 人工程团队"] },
    { label: "英文／粤语沟通", jd_quote: "具备良好英文读写能力，会粤语为加分项", profile_quotes: ["英语：商务沟通，CET-6", "粤语：日常沟通"] },
    { label: "AI应用平台化与上线优化", jd_quote: "有AI应用平台化、组件化或多业务线复用经验", profile_quotes: ["统一工具接入与跨产品复用", "负责生产部署和持续优化"] },
  ];
  const valid = validateBonusMatches(candidates, { jd, profileText: cv });
  assert.equal(valid.length, 3);
  assert.equal(bonusMessage(valid), "加分项多项也涉及，包括带领25人工程团队、英文／粤语沟通、AI应用平台化与上线优化等。");
  assert.deepEqual(validateBonusMatches(valid, { jd, profileText: cv }), valid, "revalidating persisted matches retains all evidence");
  assert.equal(validateBonusMatches(candidates, { jd, profileText: cv.replace("粤语：日常沟通。", "") }).length, 2);
  assert.equal(validateBonusMatches([{ ...candidates[1], profile_quotes: ["英语：商务沟通，CET-6"] }], { jd, profileText: cv }).length, 0);
});

test("Agent bonus capabilities retain workflow, sandbox, MCP scale and evaluation separately", () => {
  const jd = "加分项\n有分布式系统、任务编排、沙箱执行、容器平台或开发者工具经验。\n有团队级AI Coding工作流、质量评测或研发效能体系落地经验。申请时请提供开源项目";
  const cv = "负责工作流分发及执行状态管理；集成沙箱执行；覆盖 100+ 个 MCP Server；落地团队AI Coding流程；建立自动评分及失败案例回归评测。";
  const candidates = [
    ["任务编排", "任务编排", "负责工作流分发及执行状态管理"],
    ["sandbox执行", "沙箱执行", "集成沙箱执行"],
    ["100+ MCP Server集成", "开发者工具经验", "覆盖 100+ 个 MCP Server"],
    ["AI Coding工作流", "团队级AI Coding工作流", "落地团队AI Coding流程"],
    ["质量评测", "质量评测", "建立自动评分及失败案例回归评测"],
  ].map(([label, jd_quote, profile_quote]) => ({ label, jd_quote, profile_quote }));
  const valid = validateBonusMatches(candidates, { jd, profileText: cv });
  assert.equal(valid.length, 5);
  assert.match(bonusMessage(valid), /任务编排、sandbox执行、100\+ MCP Server集成、AI Coding工作流、质量评测/);
  for (const label of ["1000+ MCP Server集成", "Pinecone", "高质量开源PR", "粤语", "sandbox执行", "模型网关式路由"]) {
    assert.deepEqual(validateBonusMatches([{ label, jd_quote: "开发者工具经验", profile_quote: "负责工作流分发及执行状态管理" }], { jd, profileText: cv }), []);
  }
  assert.deepEqual(validateBonusMatches([{ label: "开源项目", jd_quote: "申请时请提供开源项目", profile_quote: "负责工作流分发及执行状态管理" }], { jd, profileText: cv }), []);
});

test("up to seven grounded items survive validation and draft formatting", () => {
  const candidates = Array.from({ length: 9 }, (_, i) => ({ label: `能力${i + 1}`, jd_quote: `能力${i + 1}`, profile_quote: `能力${i + 1}` }));
  const text = candidates.map((item) => item.label).join("、");
  const valid = validateBonusMatches([candidates[0], ...candidates], { jd: "加分项：" + text, profileText: text });
  assert.equal(MAX_BONUS_MATCHES, 7);
  assert.equal(valid.length, 7);
  assert.match(bonusMessage(candidates), /能力7等。$/);
  assert.doesNotMatch(bonusMessage(valid), /能力8/);
});

function sendFixture(t) {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  t.after(() => { globalThis.getComputedStyle = original; });
  const editor = { value: "加分项消息", getBoundingClientRect: () => ({ width: 100, height: 40 }), getAttribute: () => null };
  let clicks = 0;
  const button = { innerText: "发送", getBoundingClientRect: () => ({ width: 50, height: 30 }), getAttribute: () => null,
    click: () => { clicks++; editor.value = ""; } };
  const root = { querySelectorAll: (selector) => selector.startsWith("textarea") ? [editor] : [button] };
  return { root, editor, button, clicks: () => clicks };
}

test("bonus sending requires explicit authorization and submits the exact draft only once", async (t) => {
  const f = sendFixture(t);
  assert.equal((await sendBonusMessage(f.root, "加分项消息")).status, "prepared");
  assert.equal(f.clicks(), 0);
  assert.equal((await sendBonusMessage(f.root, "加分项消息", { authorize: async () => true, wait: async () => {} })).status, "sent");
  assert.equal(f.clicks(), 1);
  assert.equal((await sendBonusMessage(f.root, "加分项消息", { authorize: async () => true })).status, "existing_draft");
  assert.equal(f.clicks(), 1);
});

test("changed text or conversation during authorization prevents sending", async (t) => {
  for (const change of ["text", "conversation"]) {
    const f = sendFixture(t);
    let verified = true;
    const result = await sendBonusMessage(f.root, "加分项消息", { verify: () => verified,
      authorize: async () => { if (change === "text") f.editor.value = "人工编辑"; else verified = false; return true; } });
    assert.equal(result.status, "send_unconfirmed");
    assert.equal(f.clicks(), 0);
  }
});

test("a disabled send control or unconfirmed click leaves the batch free to continue without retrying", async (t) => {
  const f = sendFixture(t);
  f.button.disabled = true;
  assert.equal((await sendBonusMessage(f.root, "加分项消息", { authorize: async () => true })).status, "send_button_missing");
  assert.equal(f.clicks(), 0);
  f.button.disabled = false;
  let clicks = 0;
  f.button.click = () => { clicks++; };
  assert.equal((await sendBonusMessage(f.root, "加分项消息", { authorize: async () => true, wait: async () => {} })).status, "send_unconfirmed");
  assert.equal(clicks, 1);
});


test("an invalid supplementary quote does not suppress independently supported capabilities", () => {
  const jd = "加分项：AI平台化与跨产品复用";
  const profileText = "维护覆盖100+个MCP Server的生产级目录，支持跨产品复用";
  const item = { label: "AI平台化与跨产品复用（100+ MCP Server）", jd_quote: "AI平台化与跨产品复用",
    profile_quotes: [profileText, "模型改写过的不实引文"] };
  const valid = validateBonusMatches([item], { jd, profileText });
  assert.equal(valid.length, 1);
  assert.deepEqual(valid[0].profile_quotes, [profileText]);
  assert.deepEqual(validateBonusMatches([{ ...item, label: "200+ MCP Server" }], { jd, profileText }), []);
  assert.deepEqual(validateBonusMatches([{ ...item, profile_quotes: ["模型改写过的不实引文"] }], { jd, profileText }), []);
});

test("authorization-time editor or send-control changes prevent a click", async (t) => {
  for (const change of ["extra_editor", "extra_button", "replaced_button", "detached_editor", "detached_button", "hidden_button", "disabled_class"]) {
    const f = sendFixture(t);
    const originalQuery = f.root.querySelectorAll;
    const result = await sendBonusMessage(f.root, "加分项消息", {
      wait: async () => {},
      authorize: async () => {
        if (change === "extra_editor") f.root.querySelectorAll = (selector) => selector.startsWith("textarea") ? [f.editor, { ...f.editor }] : [f.button];
        if (change === "extra_button") f.root.querySelectorAll = (selector) => selector.startsWith("textarea") ? [f.editor] : [f.button, { ...f.button }];
        if (change === "replaced_button") f.root.querySelectorAll = (selector) => selector.startsWith("textarea") ? [f.editor] : [{ ...f.button }];
        if (change === "detached_editor") f.editor.isConnected = false;
        if (change === "detached_button") f.button.isConnected = false;
        if (change === "hidden_button") f.button.getBoundingClientRect = () => ({ width: 0, height: 0 });
        if (change === "disabled_class") f.button.className = "is-disabled";
        return true;
      },
    });
    assert.equal(result.status, "send_unconfirmed", change);
    assert.equal(f.clicks(), 0, change);
    f.root.querySelectorAll = originalQuery;
  }
});
