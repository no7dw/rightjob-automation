import test from "node:test";
import assert from "node:assert/strict";
import { nextPageWithinResults, scrollable } from "../extension/boss-adapter.js";

test("result scrolling waits for delayed and virtualized job cards", async (t) => {
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalStyle;
  });
  const page = { scrollTop: 0 };
  const list = {
    scrollHeight: 1200,
    clientHeight: 200,
    scrollTop: 0,
    parentElement: null,
    querySelectorAll: () => links,
  };
  const makeLink = (id) => {
    const card = {
      closest: () => null,
      scrollIntoView: () => {},
    };
    return {
      href: `https://www.zhipin.com/job_detail/${id}.html`,
      closest: (selector) => (selector === "#jseeker-root" ? null : card),
    };
  };
  let links = [makeLink("first")];
  globalThis.document = {
    body: {},
    scrollingElement: page,
    querySelector: (selector) => (selector === ".rec-job-list" ? list : null),
  };
  globalThis.getComputedStyle = () => ({ overflowY: "auto" });
  assert.equal(scrollable(list), list);

  // Same card count, new job ID, arriving after the previous 1.2s wait.
  const timer = setTimeout(() => {
    links = [makeLink("second")];
  }, 1400);
  t.after(() => clearTimeout(timer));
  assert.equal(await nextPageWithinResults(), true);
  assert.ok(list.scrollTop > 0);
  assert.equal(page.scrollTop, 0);
  assert.equal(
    await nextPageWithinResults(() => {}, { timeoutMs: 30, pollMs: 10 }),
    false,
  );
  await assert.rejects(
    nextPageWithinResults(() => {
      throw new Error("paused");
    }),
    /paused/,
  );
});
