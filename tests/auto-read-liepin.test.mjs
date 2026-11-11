import test from "node:test";
import assert from "node:assert/strict";
import {
  LiepinAutoRead,
  liepinUnreadRows,
} from "../extension/auto-read-liepin.js";

class ContactRow {
  constructor(id, unread) {
    this.state = { to_imid: id, unread };
    this.isConnected = true;
    this.clicks = 0;
    this.message = { innerText: "最新沟通内容" };
  }

  getAttribute(name) {
    return name === "data-tlg-ext"
      ? encodeURIComponent(JSON.stringify(this.state))
      : null;
  }

  matches() {
    return false;
  }
  querySelector(selector) {
    return selector === ".im-ui-contact-item-message" ? this.message : null;
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { width: 100, height: 50 };
  }
  click() {
    this.clicks++;
    this.state.unread = false;
  }
}

function page(rows) {
  return {
    hidden: false,
    querySelectorAll: (selector) =>
      selector.includes(".im-ui-contact-list-item") ? rows : [],
  };
}

test("Liepin scanner selects unread contact rows from live row metadata", () => {
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  const unread = new ContactRow("contact-1", true);
  const read = new ContactRow("contact-2", false);
  read.message.innerText = "[未读] 这是我发出的消息";

  assert.deepEqual(liepinUnreadRows(page([read, unread])), [unread]);
});

test("Liepin scanner scrolls to load older conversations when none are unread", async () => {
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  let distance = 0;
  const viewport = {
    scrollTop: 0,
    clientHeight: 500,
    scrollHeight: 2000,
    getBoundingClientRect: () => ({ width: 280, height: 500 }),
    scrollBy: (_x, y) => {
      distance = y;
    },
  };
  const runner = new LiepinAutoRead({
    doc: {
      hidden: false,
      querySelectorAll: (selector) =>
        selector.includes("data-overlayscrollbars-viewport") ? [viewport] : [],
    },
  });
  await runner.tick();
  assert.equal(distance, 400);
});

test("opening a Liepin unread row verifies the site's unread flag changed", async () => {
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  const unread = new ContactRow("contact-1", true);
  const reports = [];
  const runner = new LiepinAutoRead({
    doc: page([unread]),
    report: (message) => reports.push(message),
  });

  await runner.tick();

  assert.equal(unread.clicks, 1);
  assert.equal(runner.readCount, 1);
  assert.match(reports.at(-1), /已打开并标记 1 个未读会话/);
});
