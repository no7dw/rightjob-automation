import test from "node:test";
import assert from "node:assert/strict";
import { createHelperClient as client } from "../extension/helper-client.js";
const createHelperClient = (storage, fetcher) =>
  client(storage, fetcher, async () => "test-pairing-key");

function storageWith(token) {
  const area = (values) => ({
    get: async (key) => ({ [key]: values[key] }),
    set: async (next) => Object.assign(values, next),
  });
  return {
    local: area({ helper_token_persisted: token }),
    session: area({}),
  };
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });

test("fresh installation pairs once for concurrent requests and persists token", async () => {
  const storage = storageWith();
  let pairs = 0;
  const request = createHelperClient(storage, async (url, options) => {
    if (url.endsWith("/pair")) {
      assert.equal(options.headers.Authorization, "Bearer test-pairing-key");
      pairs++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ token: "paired-token" });
    }
    assert.equal(options.headers.Authorization, "Bearer paired-token");
    return json({ ok: true });
  });
  const results = await Promise.all([
    request(17373, "/health", {}),
    request(17373, "/model", {}),
  ]);
  assert.equal(pairs, 1);
  assert.ok(results.every((response) => response.ok));
  assert.equal(
    (await storage.local.get("helper_token_persisted")).helper_token_persisted,
    "paired-token",
  );
  assert.equal(
    (await storage.session.get("helper_token")).helper_token,
    "paired-token",
  );
});

test("rotated token pairs and retries an unauthorized request only once", async () => {
  const calls = [];
  const request = createHelperClient(
    storageWith("old-token"),
    async (url, options) => {
      calls.push([url, options.headers.Authorization]);
      if (url.endsWith("/pair")) return json({ token: "new-token" });
      return json(
        {},
        options.headers.Authorization === "Bearer new-token" ? 200 : 401,
      );
    },
  );
  assert.equal((await request(17373, "/health", {})).status, 200);
  assert.deepEqual(
    calls.map(([url]) => new URL(url).pathname),
    ["/health", "/pair", "/health"],
  );
});

test("valid manual token remains compatible with older Helper", async () => {
  const request = createHelperClient(storageWith("manual"), async (url) => {
    assert.ok(url.endsWith("/health"));
    return json({});
  });
  assert.ok((await request(17373, "/health", {})).ok);
});

test("pairing rejection gives actionable error and never sends workload", async () => {
  const request = createHelperClient(storageWith(), async (url) => {
    assert.ok(url.endsWith("/pair"));
    return json({}, 403);
  });
  await assert.rejects(request(17373, "/evaluate", {}), /无法自动连接本地服务/);
});

test("offline Helper reports startup instructions", async () => {
  const request = createHelperClient(storageWith(), async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(request(17373, "/health", {}), /npm run helper/);
});
