import test from "node:test";
import assert from "node:assert/strict";
import { openBonusConversation } from "../extension/boss-adapter.js";

function fixture(t) {
  const original = { document: globalThis.document, style: globalThis.getComputedStyle };
  t.after(() => {
    globalThis.document = original.document;
    globalThis.getComputedStyle = original.style;
  });
  let job = "job1";
  let label = "立即沟通";
  let clicks = 0;
  let modal = false;
  const visible = () => ({ width: 100, height: 40 });
  const button = {
    get innerText() { return label; },
    getBoundingClientRect: visible,
    getAttribute: () => "",
    addEventListener() {}, removeEventListener() {},
    click() { clicks++; },
  };
  const continuation = { ...button, innerText: "继续沟通" };
  const detail = {
    getBoundingClientRect: visible,
    getAttribute: () => job,
    querySelectorAll: (selector) => selector.startsWith("a[href") ? [] : [button],
  };
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  globalThis.document = {
    body: { innerText: "" },
    querySelectorAll: (selector) => selector.startsWith(".job-detail")
      ? [detail] : modal ? [button, continuation] : [button],
  };
  return {
    setJob: (value) => { job = value; },
    setLabel: (value) => { label = value; },
    showModal: () => { modal = true; },
    clicks: () => clicks,
  };
}

test("BOSS waits for the JD button to change to Continue Chat and clicks once", async (t) => {
  const f = fixture(t);
  assert.equal(await openBonusConversation("job1", {
    waitFor: async () => f.setLabel("继续沟通"),
  }), true);
  assert.equal(f.clicks(), 1);
});

test("BOSS follows the first-contact confirmation dialog into its conversation", async (t) => {
  const f = fixture(t);
  f.showModal();
  assert.equal(await openBonusConversation("job1"), true);
  assert.equal(f.clicks(), 1);
});

test("BOSS never retries communication after the selected JD changes", async (t) => {
  const f = fixture(t);
  assert.equal(await openBonusConversation("job1", {
    waitFor: async () => f.setJob("job2"),
  }), false);
  assert.equal(f.clicks(), 0);
});

test("BOSS reopens through the original label when the site never relabels it", async (t) => {
  const f = fixture(t);
  assert.equal(await openBonusConversation("job1", {
    waitFor: async () => {}, attempts: 2,
  }), true);
  assert.equal(f.clicks(), 1);
});
