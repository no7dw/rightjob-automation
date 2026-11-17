import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../..", import.meta.url));

async function startPayServer() {
  const dir = mkdtempSync(join(tmpdir(), "jseeker-pay-srv-"));
  const dbPath = join(dir, "pay.json");
  const port = 18000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    PAY_MODE: "1",
    PAY_MAIL_STUB: "1",
    PAY_DB_PATH: dbPath,
    APP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    ADMIN_PASSWORD: "test-admin",
    JSEEKER_PORT: String(port),
    JSEEKER_HOST: "127.0.0.1",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://example.invalid/v1",
    OPENAI_MODEL: "test-model",
  };
  let boot = "";
  const child = spawn("node", ["helper/server.mjs"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (boot += d.toString()));
  child.stderr.on("data", (d) => (boot += d.toString()));
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin`);
      if (res.ok) break;
    } catch {
      await sleep(50);
    }
  }
  return {
    port,
    dir,
    child,
    get boot() {
      return boot;
    },
    async stop() {
      child.kill("SIGTERM");
      await sleep(80);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

test("pay server magic link login, quota gate, admin", async (t) => {
  const srv = await startPayServer();
  t.after(() => srv.stop());
  const base = `http://127.0.0.1:${srv.port}`;

  const linkRes = await fetch(`${base}/auth/request-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "pay@example.com" }),
  });
  const linkBody = await linkRes.json();
  assert.equal(linkRes.status, 200, JSON.stringify(linkBody));
  assert.ok(linkBody.login_url, "stub mode should return login_url");
  const token = new URL(linkBody.login_url).searchParams.get("token");
  assert.ok(token);

  const callback = await fetch(
    `${base}/auth/callback?token=${encodeURIComponent(token)}`,
  );
  const html = await callback.text();
  assert.equal(callback.status, 200, html);
  const codeMatch = html.match(/const code = ("([^"]+)")/);
  assert.ok(codeMatch, "exchange code missing in callback html");
  const code = JSON.parse(codeMatch[1]);

  const sessionRes = await fetch(`${base}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(sessionRes.status, 200);
  const session = await sessionRes.json();
  assert.ok(session.session_token);
  assert.equal(session.user.quota_remaining, 30);

  const me = await fetch(`${base}/me`, {
    headers: { Authorization: `Bearer ${session.session_token}` },
  });
  assert.equal(me.status, 200);
  const meData = await me.json();
  assert.equal(meData.user.email, "pay@example.com");

  const usage1 = await fetch(`${base}/usage/contact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session_token}`,
    },
    body: JSON.stringify({ job_id: "boss:1" }),
  });
  assert.equal(usage1.status, 200);
  assert.equal((await usage1.json()).remaining, 29);

  const usage2 = await fetch(`${base}/usage/contact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session_token}`,
    },
    body: JSON.stringify({ job_id: "boss:1" }),
  });
  assert.equal((await usage2.json()).deducted, false);

  // Drain quota then ensure evaluate is blocked.
  for (let i = 2; i <= 30; i++) {
    const res = await fetch(`${base}/usage/contact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.session_token}`,
      },
      body: JSON.stringify({ job_id: `boss:${i}` }),
    });
    assert.equal(res.status, 200);
  }
  const blocked = await fetch(`${base}/evaluate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.session_token}`,
    },
    body: JSON.stringify({
      job: { job_id: "x", title: "t", company: "c", jd: "j" },
      profile: { text: "p", version: "v" },
    }),
  });
  assert.equal(blocked.status, 402);

  const admin = await fetch(`${base}/admin/api/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Password": "test-admin",
    },
    body: JSON.stringify({
      email: "pay@example.com",
      add_quota: 5,
      enabled: true,
    }),
  });
  assert.equal(admin.status, 200);
  const restored = await admin.json();
  assert.equal(restored.user.quota_remaining, 5);
});
