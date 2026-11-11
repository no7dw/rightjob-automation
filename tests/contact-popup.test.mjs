import test from "node:test";
import assert from "node:assert/strict";
import {
  contactLimitReason,
  contactButton,
  existingContactButton,
  dismissContactPopup,
} from "../extension/boss-adapter.js";

test("communication limit popup stops processing without clicking confirmation", async (t) => {
  const originalDocument = globalThis.document;
  t.after(() => {
    globalThis.document = originalDocument;
  });
  globalThis.document = {
    body: {
      innerText:
        "您已达到沟通上限\n您今天已与150位BOSS沟通，休息一下，明天再来吧～\n确定",
    },
    querySelectorAll: () => {
      throw new Error("Must stop before interacting with the popup");
    },
  };
  assert.ok(contactLimitReason());
  const popup = await dismissContactPopup();
  assert.equal(popup.appeared, true);
  assert.equal(popup.dismissed, false);
  assert.match(popup.reason, /沟通上限/);
  globalThis.document.body.innerText = "已向BOSS发送消息";
  assert.equal(contactLimitReason(), null);
});


test("existing BOSS conversations are detected separately from new contact buttons", (t) => {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  t.after(() => { globalThis.getComputedStyle = original; });
  const next = { innerText: "继续沟通", getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  const root = { querySelectorAll: () => [next] };
  assert.equal(contactButton(root), null);
  assert.equal(existingContactButton(root), next);
  next.innerText = "立即沟通";
  assert.equal(contactButton(root), next);
  assert.equal(existingContactButton(root), null);
});
