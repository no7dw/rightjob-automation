import test from "node:test";
import assert from "node:assert/strict";
import {
  createCloudClient,
  normalizeCloudBaseUrl,
  cloudAuthRequest,
} from "../extension/cloud-client.js";

test("normalizeCloudBaseUrl trims trailing slash", () => {
  assert.equal(
    normalizeCloudBaseUrl(" https://pay.example.com/ "),
    "https://pay.example.com",
  );
});

test("createCloudClient sends bearer session token", async () => {
  const storage = {
    local: {
      async get() {
        return { pay_session_token: "sess-1" };
      },
    },
  };
  const client = createCloudClient(storage, async (url, options) => {
    assert.equal(url, "https://pay.example.com/evaluate");
    assert.equal(options.headers.Authorization, "Bearer sess-1");
    assert.equal(options.method, "POST");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const response = await client("https://pay.example.com/", "/evaluate", {
    a: 1,
  });
  assert.equal(response.status, 200);
});

test("cloudAuthRequest surfaces server errors", async () => {
  await assert.rejects(
    () =>
      cloudAuthRequest(
        "https://pay.example.com",
        "/auth/request-link",
        { email: "a@b.c" },
        async () =>
          new Response(JSON.stringify({ error: "请输入有效邮箱" }), {
            status: 400,
          }),
      ),
    /请输入有效邮箱/,
  );
});
