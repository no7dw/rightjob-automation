import test from "node:test";
import assert from "node:assert/strict";
import {
  fillBossBonusDraft,
  prepareBossBonusDraft,
  isBossChatURL,
  selectBossBonusContact,
} from "../extension/bonus-message-boss.js";

function fixture(t, ids = ["job1"], draft = "") {
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  t.after(() => {
    globalThis.getComputedStyle = original;
  });
  const events = [];
  const editor = {
    textContent: draft,
    ownerDocument: { defaultView: { InputEvent: Event, Event } },
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    getAttribute: () => null,
    dispatchEvent: (event) => events.push(event.type),
  };
  const root = {
    getBoundingClientRect: () => ({ width: 500, height: 600 }),
    getAttribute: () => null,
    contains: () => false,
    querySelectorAll: (selector) =>
      selector.startsWith("a[")
        ? ids.map((id) => ({
            href: `https://www.zhipin.com/job_detail/${id}.html`,
          }))
        : [editor],
  };
  return { root, editor, events, doc: { querySelectorAll: () => [root] } };
}

test("BOSS chat URLs are limited to the supported HTTPS chat page", () => {
  assert.ok(isBossChatURL("https://www.zhipin.com/web/geek/chat?bossId=123"));
  assert.ok(isBossChatURL("https://zhipin.com/web/geek/chat"));
  for (const value of [
    "http://www.zhipin.com/web/geek/chat",
    "https://evil.example/web/geek/chat",
    "https://www.zhipin.com/web/geek/jobs",
    "invalid",
  ])
    assert.equal(isBossChatURL(value), false);
});

test("BOSS fills the verified job conversation using input events only", (t) => {
  const f = fixture(t);
  assert.equal(
    fillBossBonusDraft("job1", "加分项也涉及，包括评测等。", f.doc).status,
    "prepared",
  );
  assert.equal(f.editor.textContent, "加分项也涉及，包括评测等。");
  assert.deepEqual(f.events, ["input", "change", "blur"]);
});

test("BOSS never fills a different job, an unverified chat, or multiple conversations", (t) => {
  const f = fixture(t, ["job2"]);
  assert.equal(
    fillBossBonusDraft("job1", "消息", f.doc).status,
    "identity_unverified",
  );
  f.doc.querySelectorAll = () => [];
  assert.equal(
    fillBossBonusDraft("job1", "消息", f.doc).status,
    "identity_unverified",
  );
  const g = fixture(t);
  g.doc.querySelectorAll = () => [g.root, { ...g.root }];
  assert.equal(
    fillBossBonusDraft("job1", "消息", g.doc).status,
    "ambiguous_chat",
  );
  assert.equal(g.editor.textContent, "");
  assert.deepEqual(f.events, []);
});

test("BOSS confirms the draft remains after a newly mounted editor settles", async (t) => {
  const f = fixture(t);
  let waits = 0;
  const result = await prepareBossBonusDraft("job1", "加分项消息", f.doc, null, {
    wait: async () => {
      if (waits++ === 0) f.editor.textContent = "";
    },
  });
  assert.equal(result.status, "prepared");
  assert.equal(f.editor.textContent, "加分项消息");
  assert.equal(waits > 1, true);
});

test("BOSS reports editor error when a freshly mounted editor keeps clearing", async (t) => {
  const f = fixture(t);
  const result = await prepareBossBonusDraft("job1", "加分项消息", f.doc, null, {
    wait: async () => {
      f.editor.textContent = "";
    },
  });
  assert.equal(result.status, "editor_error");
  assert.equal(f.editor.textContent, "");
});

test("BOSS preserves a user's existing draft in a verified conversation", (t) => {
  const f = fixture(t, ["job1"], "我自己写的消息");
  assert.equal(
    fillBossBonusDraft("job1", "加分项消息", f.doc).status,
    "existing_draft",
  );
  assert.equal(f.editor.textContent, "我自己写的消息");
  assert.deepEqual(f.events, []);
});

const review = {
  job_id: "job1",
  title: "Agent Harness 研发工程师",
  contact: { recruiter: "张女士", company: "目标公司" },
};

function contactRow(name, company, id = "") {
  const fields = [name, company].map((innerText) => ({
    innerText,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  }));
  return {
    clicks: 0,
    getBoundingClientRect: () => ({ width: 300, height: 60 }),
    getAttribute: () => id || null,
    querySelectorAll: (selector) => (selector.startsWith("a[") ? [] : fields),
    click() {
      this.clicks++;
    },
  };
}

test("BOSS selects the unique recruiter and company, ignoring either name alone", (t) => {
  fixture(t);
  const rows = [
    contactRow("张女士", "别的公司"),
    contactRow("张女士", "目标公司 | 招聘顾问"),
    contactRow("李女士", "目标公司"),
  ];
  assert.equal(
    selectBossBonusContact(review, { querySelectorAll: () => rows }).status,
    "contact_selected",
  );
  assert.deepEqual(
    rows.map((row) => row.clicks),
    [0, 1, 0],
  );
});

test("BOSS never guesses among duplicate contacts or accepts a conflicting job ID", (t) => {
  fixture(t);
  const rows = [
    contactRow("张女士", "目标公司"),
    contactRow("张女士", "目标公司"),
  ];
  assert.equal(
    selectBossBonusContact(review, { querySelectorAll: () => rows }).status,
    "ambiguous_chat",
  );
  assert.deepEqual(
    rows.map((row) => row.clicks),
    [0, 0],
  );
  const wrong = contactRow("张女士", "目标公司", "job2");
  assert.equal(
    selectBossBonusContact(review, { querySelectorAll: () => [wrong] }).status,
    "identity_unverified",
  );
  assert.equal(wrong.clicks, 0);
});

test("BOSS missing or partial contact identity cannot select a recipient", (t) => {
  fixture(t);
  const row = contactRow("张女士", "目标公司子公司");
  assert.equal(
    selectBossBonusContact(review, { querySelectorAll: () => [row] }).status,
    "identity_unverified",
  );
  assert.equal(
    selectBossBonusContact(
      { ...review, contact: {} },
      { querySelectorAll: () => [row] },
    ).status,
    "identity_unverified",
  );
  assert.equal(row.clicks, 0);
});

test("BOSS without a job link verifies all three header fields before writing", (t) => {
  const f = fixture(t, []);
  let fields = [review.contact.recruiter, review.contact.company, review.title];
  const header = {
    getBoundingClientRect: () => ({ width: 500, height: 100 }),
    querySelectorAll: () =>
      fields.map((innerText) => ({
        innerText,
        getBoundingClientRect: () => ({ width: 100, height: 20 }),
      })),
  };
  f.root.querySelectorAll = (selector) =>
    selector.startsWith("a[")
      ? []
      : selector.startsWith(".top-info-content")
        ? [header]
        : [f.editor];
  assert.equal(
    fillBossBonusDraft("job1", "加分项消息", f.doc, review).status,
    "prepared",
  );
  for (const index of [0, 1, 2]) {
    f.editor.textContent = "";
    fields = [review.contact.recruiter, review.contact.company, review.title];
    fields[index] = "不匹配";
    assert.equal(
      fillBossBonusDraft("job1", "加分项消息", f.doc, review).status,
      "identity_unverified",
    );
    assert.equal(f.editor.textContent, "");
  }
  // Text in the message history must not establish the header identity.
  f.root.querySelectorAll = (selector) =>
    selector.startsWith("a[") || selector.startsWith(".top-info-content")
      ? []
      : header.querySelectorAll();
  assert.equal(
    fillBossBonusDraft("job1", "加分项消息", f.doc, review).status,
    "identity_unverified",
  );
});


test("BOSS activates the inner friend-content control on the live contact row", (t) => {
  fixture(t);
  const row = contactRow(review.contact.recruiter, review.contact.company);
  let opened = 0;
  row.querySelector = (selector) => selector === ".friend-content" ? { click() { opened++; } } : null;
  assert.equal(selectBossBonusContact(review, { querySelectorAll: () => [row] }).status, "contact_selected");
  assert.equal(opened, 1);
  assert.equal(row.clicks, 0);
});


test("BOSS commits an identical unsaved draft on blur without replacing its text", (t) => {
  const f = fixture(t, ["job1"], "加分项消息");
  assert.equal(fillBossBonusDraft("job1", "加分项消息", f.doc).status, "already_prepared");
  assert.deepEqual(f.events, ["blur"]);
  assert.equal(f.editor.textContent, "加分项消息");
});


test("BOSS retries an editor mounted after its conversation header", async (t) => {
  const f = fixture(t);
  const query = f.root.querySelectorAll;
  let mounted = false;
  f.root.querySelectorAll = (selector) => selector.startsWith("textarea") && !mounted ? [] : query(selector);
  const result = await prepareBossBonusDraft("job1", "加分项消息", f.doc, null, {
    wait: async () => { mounted = true; },
  });
  assert.equal(result.status, "prepared");
  assert.equal(f.editor.textContent, "加分项消息");
});

test("BOSS refuses to write when the editor cannot acquire focus", async (t) => {
  const f = fixture(t);
  f.editor.focus = () => {};
  f.editor.ownerDocument.activeElement = null;
  const result = await prepareBossBonusDraft("job1", "加分项消息", f.doc, null, { wait: async () => {} });
  assert.equal(result.status, "editor_error");
  assert.equal(f.editor.textContent, "");
});

test("BOSS does not report a prepared draft after conversation identity changes", async (t) => {
  const f = fixture(t);
  const result = await prepareBossBonusDraft("job1", "加分项消息", f.doc, null, {
    wait: async () => { if (f.editor.textContent) f.doc.querySelectorAll = () => []; },
  });
  assert.equal(result.status, "identity_unverified");
});

test("BOSS matches direct name text beside nested company and role decorations", (t) => {
  fixture(t);
  const row = contactRow("", "");
  row.querySelectorAll = (selector) => selector.startsWith("a[") ? [] : [{
    innerText: "张女士 目标公司 | 招聘顾问",
    childNodes: [{ nodeType: 3, textContent: "张女士" }],
    getBoundingClientRect: () => ({ width: 200, height: 20 }),
  }, {
    innerText: "目标公司 | 招聘顾问",
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
  }];
  assert.equal(selectBossBonusContact(review, { querySelectorAll: () => [row] }).status, "contact_selected");
  assert.equal(row.clicks, 1);
  assert.equal(selectBossBonusContact({ ...review, contact: { ...review.contact, recruiter: "张女" } }, { querySelectorAll: () => [row] }).status, "identity_unverified");
});

test("BOSS counts a nested contact click target only once", (t) => {
  fixture(t);
  const row = contactRow(review.contact.recruiter, review.contact.company);
  const inner = contactRow(review.contact.recruiter, review.contact.company);
  row.contains = (node) => node === inner;
  row.querySelector = () => inner;
  assert.equal(selectBossBonusContact(review, { querySelectorAll: () => [row, inner] }).status, "contact_selected");
  assert.equal(inner.clicks, 1);
});

test("BOSS uses a JD-bound conversation without recruiter/company fields or contact selection", (t) => {
  const f = fixture(t, []);
  assert.equal(fillBossBonusDraft("job1", "加分项消息", f.doc, { ...review, direct_entry: true }).status, "prepared");
  assert.equal(f.editor.textContent, "加分项消息");
});

test("BOSS direct entry still rejects conflicting jobs and multiple conversations", (t) => {
  const f = fixture(t, ["job2"]);
  const direct = { ...review, direct_entry: true };
  assert.equal(fillBossBonusDraft("job1", "消息", f.doc, direct).status, "identity_unverified");
  assert.equal(f.editor.textContent, "");
  const g = fixture(t, []);
  g.doc.querySelectorAll = () => [g.root, { ...g.root }];
  assert.equal(fillBossBonusDraft("job1", "消息", g.doc, direct).status, "ambiguous_chat");
  assert.equal(g.editor.textContent, "");
});

test("BOSS direct entry cannot hide a conflicting job in an enclosing chat root", (t) => {
  const f = fixture(t, []);
  const outer = {
    ...f.root,
    contains: (node) => node === f.root,
    querySelectorAll: (selector) => selector.startsWith("a[")
      ? [{ href: "https://www.zhipin.com/job_detail/job2.html" }] : [],
  };
  f.doc.querySelectorAll = () => [outer, f.root];
  assert.equal(fillBossBonusDraft("job1", "消息", f.doc, { ...review, direct_entry: true }).status, "identity_unverified");
  assert.equal(f.editor.textContent, "");
});

test("BOSS isolated detail entry accepts only supported HTTPS job URLs", async () => {
  const { isBossBonusDetailURL } = await import("../extension/bonus-message-boss.js");
  assert.equal(isBossBonusDetailURL("https://www.zhipin.com/job_detail/job1.html?securityId=fixture"), true);
  assert.equal(isBossBonusDetailURL("https://zhipin.com/job_detail/job1.html"), true);
  for (const url of ["http://www.zhipin.com/job_detail/job1.html", "https://evil.example/job_detail/job1.html",
    "https://www.zhipin.com/web/geek/jobs", "https://www.zhipin.com/web/geek/chat", "invalid"])
    assert.equal(isBossBonusDetailURL(url), false, url);
});
