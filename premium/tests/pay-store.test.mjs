import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPayStore, isValidEmail, normalizeEmail } from "../helper/pay-store.mjs";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "jseeker-pay-"));
  const db = createPayStore(join(dir, "db.json"));
  return {
    db,
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("normalize and validate email", () => {
  assert.equal(normalizeEmail("  Foo@Bar.COM "), "foo@bar.com");
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("nope"), false);
});

test("new user gets trial quota 30", () => {
  const { db, cleanup } = store();
  try {
    const user = db.ensureUser("trial@example.com");
    assert.equal(user.quota_remaining, 30);
    assert.equal(user.enabled, true);
    assert.equal(user.plan, "trial");
  } finally {
    cleanup();
  }
});

test("magic link -> exchange session -> me", () => {
  const { db, cleanup } = store();
  try {
    const { token } = db.createMagicLink("user@example.com");
    const { code, user } = db.consumeMagicLink(token);
    assert.equal(user.email, "user@example.com");
    const session = db.exchangeSession(code);
    assert.ok(session.session_token);
    const me = db.sessionUser(`Bearer ${session.session_token}`);
    assert.equal(me.email, "user@example.com");
    assert.equal(me.quota_remaining, 30);
  } finally {
    cleanup();
  }
});

test("contact usage is idempotent per job", () => {
  const { db, cleanup } = store();
  try {
    const user = db.ensureUser("quota@example.com");
    const first = db.consumeContact(user.id, "boss:1");
    assert.equal(first.deducted, true);
    assert.equal(first.remaining, 29);
    const second = db.consumeContact(user.id, "boss:1");
    assert.equal(second.deducted, false);
    assert.equal(second.remaining, 29);
    const third = db.consumeContact(user.id, "boss:2");
    assert.equal(third.remaining, 28);
  } finally {
    cleanup();
  }
});

test("assertHostedAccess blocks empty quota and disabled users", () => {
  const { db, cleanup } = store();
  try {
    const user = db.ensureUser("empty@example.com");
    db.updateUser(user.email, { quota_remaining: 0 });
    assert.throws(
      () => db.assertHostedAccess(db.publicUser(db.findUserByEmail(user.email))),
      /额度已用尽/,
    );
    db.updateUser(user.email, { quota_remaining: 5, enabled: false });
    assert.throws(
      () => db.assertHostedAccess(db.publicUser(db.findUserByEmail(user.email))),
      /停用/,
    );
  } finally {
    cleanup();
  }
});

test("admin upsert can add quota and enable", () => {
  const { db, cleanup } = store();
  try {
    const user = db.updateUser("admin@example.com", {
      enabled: true,
      plan: "manual_paid",
      add_quota: 100,
    });
    assert.equal(user.plan, "manual_paid");
    assert.ok(user.quota_remaining >= 100);
  } finally {
    cleanup();
  }
});
