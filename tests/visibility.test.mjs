import test from "node:test";
import assert from "node:assert/strict";
import { waitForVisible } from "../extension/visibility.js";
import { Scanner } from "../extension/scanner.js";

test("visibility events wake the wait without waiting for a throttled timer", async () => {
  const doc = new EventTarget();
  doc.hidden = true;
  let wake;
  const waiting = new Promise((resolve) => {
    wake = resolve;
  });
  const result = waitForVisible(doc, () => {}, { onWaiting: wake });
  await waiting;
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  await result;
});

test("BOSS can pause while waiting for a hidden page", async (t) => {
  const original = globalThis.document;
  globalThis.document = { hidden: true, addEventListener: () => {} };
  t.after(() => {
    globalThis.document = original;
  });
  let scanner;
  const states = [];
  scanner = new Scanner(
    () => {},
    () => {},
    (waiting) => {
      states.push(waiting);
      if (waiting) scanner.pause();
    },
  );
  // Isolate the visibility/cancellation behavior from DOM adapter selectors.
  scanner.validate = () => {
    if (scanner.stop) throw new Error("用户已暂停");
  };
  await assert.rejects(scanner.guard(), /用户已暂停/);
  assert.deepEqual(states, [true, false]);
});

test("list handoff can take longer than two seconds and resumes automatically", async () => {
  const doc = { hidden: true };
  let ticks = 0;
  let notices = 0;
  await waitForVisible(doc, () => {}, {
    wait: async () => {
      if (++ticks === 20) doc.hidden = false;
    },
    onWaiting: () => notices++,
  });
  assert.equal(ticks, 20);
  assert.equal(notices, 1);
});

test("manual pause or invalid scope interrupts a hidden list", async () => {
  for (const reason of ["用户已暂停", "搜索范围已改变"]) {
    let cancelled = false;
    await assert.rejects(
      waitForVisible(
        { hidden: true },
        () => {
          if (cancelled) throw new Error(reason);
        },
        {
          wait: async () => {
            cancelled = true;
          },
        },
      ),
      { message: reason },
    );
  }
});

test("visible list continues immediately but still validates its guard", async () => {
  await waitForVisible({ hidden: false }, () => {}, {
    wait: async () => assert.fail("should not wait"),
    onWaiting: () => assert.fail("should not show waiting"),
  });
  await assert.rejects(
    waitForVisible({ hidden: false }, () => {
      throw new Error("用户已暂停");
    }),
    /用户已暂停/,
  );
});
