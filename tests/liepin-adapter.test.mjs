import test from "node:test";
import assert from "node:assert/strict";
import { blockedReason, cardSalary, readJob } from "../extension/liepin-adapter.js";

function stubCard(elText, salaryText) {
  return {
    el: {
      innerText: elText,
      querySelector: (selector) =>
        selector.includes("salary") && salaryText != null
          ? { innerText: salaryText }
          : null,
    },
  };
}

test("cardSalary reads the dedicated salary element", () => {
  assert.deepEqual(cardSalary(stubCard("任意", "15-16k")), {
    min_k: 15,
    max_k: 16,
    months: null,
  });
  assert.deepEqual(cardSalary(stubCard("任意", "18-35k·14薪")), {
    min_k: 18,
    max_k: 35,
    months: 14,
  });
});

test("cardSalary falls back to card text and never reads company size", () => {
  assert.equal(cardSalary(stubCard("500-999人 3-5年", null)).max_k, null);
  assert.equal(
    cardSalary(
      stubCard("AI应用开发工程师【深圳-南油】15-16k 3-5年 统招本科", null),
    ).max_k,
    16,
  );
});

const baseStyle = {
  visibility: "visible",
  opacity: "1",
  backgroundColor: "rgba(0, 0, 0, 0)",
};

function node({
  width = 1469,
  height = 834,
  style = {},
  children = [],
  innerText = "",
  tagName = "DIV",
} = {}) {
  return {
    tagName,
    innerText,
    __style: { ...baseStyle, ...style },
    getBoundingClientRect: () => ({ width, height }),
    checkVisibility: () => true,
    querySelectorAll: () => children,
    querySelector: () => null,
    matches: () => false,
    closest: () => null,
  };
}

test("empty transparent ad wrapper is not treated as a popup", async (t) => {
  const original = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.getComputedStyle = original.getComputedStyle;
  });
  globalThis.location = { pathname: "/" };
  globalThis.getComputedStyle = (n) => n.__style;
  const adWrapper = node({
    style: { position: "fixed" },
    // Liepin keeps an always-present fixed ad wrapper with "Modal" in its
    // class list; with no ad loaded it paints nothing and must not pause.
  });
  globalThis.document = {
    body: { innerText: "推荐职位 资深AI工程师 深圳 50-80k" },
    querySelectorAll: () => [adWrapper],
  };
  assert.equal(blockedReason(), null);
});

test("ad wrapper with visible content still pauses", async (t) => {
  const original = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.getComputedStyle = original.getComputedStyle;
  });
  globalThis.location = { pathname: "/" };
  globalThis.getComputedStyle = (n) => n.__style;
  const adWrapper = node({
    children: [node({ tagName: "IMG", width: 640, height: 360 })],
  });
  globalThis.document = {
    body: { innerText: "推荐职位 资深AI工程师 深圳 50-80k" },
    querySelectorAll: () => [adWrapper],
  };
  assert.match(blockedReason(), /弹窗/);
});

test("non-transparent modal mask still pauses", async (t) => {
  const original = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => {
    globalThis.document = original.document;
    globalThis.location = original.location;
    globalThis.getComputedStyle = original.getComputedStyle;
  });
  globalThis.location = { pathname: "/" };
  globalThis.getComputedStyle = (n) => n.__style;
  const mask = node({ style: { backgroundColor: "rgba(0, 0, 0, 0.45)" } });
  globalThis.document = {
    body: { innerText: "推荐职位 资深AI工程师 深圳 50-80k" },
    querySelectorAll: () => [mask],
  };
  assert.match(blockedReason(), /弹窗/);
});

function restrictionPage(t, { page = "", dialogs = [], notices = [] } = {}) {
  const original = { document: globalThis.document, location: globalThis.location, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => Object.assign(globalThis, original));
  globalThis.location = { pathname: "/job/123.shtml" };
  globalThis.getComputedStyle = (n) => n.__style;
  globalThis.document = {
    body: { innerText: page },
    querySelectorAll: (selector) => selector.startsWith('[role="dialog"]') ? dialogs : notices,
  };
}

test("ordinary JD and page text mentioning verification or limits never reports a restriction", (t) => {
  restrictionPage(t, { page: "负责安全验证系统研发，优化沟通次数上限和访问过于频繁告警。" });
  assert.equal(blockedReason(), null);
});

test("a visible plain-text quota dialog reports the exact website evidence", (t) => {
  restrictionPage(t, { dialogs: [node({ innerText: "您已达到今日沟通上限，请明天再来" })] });
  assert.match(blockedReason(), /网站提示沟通上限/);
  assert.match(blockedReason(), /您已达到今日沟通上限，请明天再来/);
});

test("hidden stale limit notices never pause the workflow", (t) => {
  const stale = node({ innerText: "访问过于频繁", style: { visibility: "hidden" } });
  restrictionPage(t, { page: "访问过于频繁", notices: [stale] });
  assert.equal(blockedReason(), null);
});

test("visible rate-limit and verification notices have distinct reasons", (t) => {
  const notice = node({ innerText: "操作过于频繁，请稍后重试" });
  restrictionPage(t, { notices: [notice] });
  assert.match(blockedReason(), /网站提示操作频繁/);
  assert.doesNotMatch(blockedReason(), /沟通上限/);
  notice.innerText = "请完成验证后继续";
  assert.match(blockedReason(), /网站提示需要验证/);
});

test("informational membership text about communication limits is not an exhausted quota", (t) => {
  restrictionPage(t, { notices: [node({ innerText: "会员权益：每日沟通次数上限提升，沟通无上限" })] });
  assert.equal(blockedReason(), null);
});

test("old quota messages inside an allowed chat dialog are not current restriction evidence", (t) => {
  const chat = node({ innerText: "历史消息：您已达到沟通上限" });
  chat.matches = (selector) => selector === ".im-ui-basic-chat-modal";
  chat.querySelector = () => ({});
  restrictionPage(t, { dialogs: [chat] });
  assert.equal(blockedReason({ allowChat: true }), null);
  assert.match(blockedReason(), /出现弹窗/);
});

test("restriction-looking alert text within the JD is not a platform warning", (t) => {
  const content = node({ innerText: "安全验证" });
  content.closest = () => ({});
  restrictionPage(t, { notices: [content] });
  assert.equal(blockedReason(), null);
});


test("detail records company and explicit recruiter hunter evidence without guessing", (t) => {
  const original = { document: globalThis.document, location: globalThis.location };
  t.after(() => Object.assign(globalThis, original));
  globalThis.location = { href: "https://www.liepin.com/job/123.shtml" };
  let recruiter = "沈女士\n优选猎头\n行业经理 · 成都壹蓓特人力资源管理有限公司";
  globalThis.document = {
    querySelector(selector) {
      let value = selector.includes("job-intro-content") ? "负责猎头系统开发，完整长 JD" :
        selector.includes("job-title") ? "信息数字化总监" :
        selector.includes("company-name") ? "招聘企业" :
        selector === ".recruiter-container" ? recruiter :
        selector.includes("salary") ? "30-55k·16薪" : "";
      return value ? { innerText: value } : null;
    },
    querySelectorAll: () => [],
  };
  const job = readJob("liepin:job:123");
  assert.equal(job.company, "招聘企业");
  assert.equal(job.field_sources.company, "dom");
  assert.equal(job.is_headhunter, true);
  assert.equal(job.headhunter_evidence, "优选猎头");
  assert.match(job.recruiter_raw, /成都壹蓓特/);
  recruiter = "招聘经理";
  const unknown = readJob("liepin:job:123");
  assert.equal(unknown.is_headhunter, null);
  assert.equal(unknown.headhunter_evidence, null);
});
