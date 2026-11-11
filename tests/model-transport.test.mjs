import test from "node:test";
import assert from "node:assert/strict";
import { createModelTransport } from "../helper/model-transport.mjs";

test("transient HTTP failures release the response and honor Retry-After", async () => {
  let calls = 0,
    time = 0,
    cancelled = false;
  const send = createModelTransport("https://fixture.invalid", {
    timeoutMs: 10000,
    now: () => time,
    wait: async (ms) => {
      assert.equal(ms, 2000);
      time += ms;
    },
    fetchImpl: async () =>
      ++calls === 1
        ? {
            status: 429,
            headers: new Headers({ "Retry-After": "2" }),
            body: {
              cancel: async () => {
                cancelled = true;
              },
            },
          }
        : new Response("{}"),
  });
  assert.equal((await send({})).ok, true);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});

test("network failures retry once but persistent failures terminate", async () => {
  let calls = 0;
  const send = createModelTransport("https://fixture.invalid", {
    timeoutMs: 10000,
    wait: async () => {},
    fetchImpl: async () => {
      calls++;
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(send({}), /无法连接模型服务（fixture.invalid）/);
  assert.equal(calls, 2);
});

test("model connection errors name the destination without exposing credentials", async () => {
  const send = createModelTransport("http://user:secret@localhost:8321/v1/chat/completions?key=private", {
    timeoutMs: 10000,
    wait: async () => {},
    fetchImpl: async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) });
    },
  });
  await assert.rejects(send({}), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /localhost:8321.*ECONNREFUSED/);
    assert.doesNotMatch(error.message, /user|secret|private/);
    return true;
  });
});

test("authentication errors are never retried", async () => {
  let calls = 0;
  const send = createModelTransport("https://fixture.invalid", {
    timeoutMs: 10000,
    fetchImpl: async () => {
      calls++;
      return new Response("denied", { status: 401 });
    },
  });
  assert.equal((await send({})).status, 401);
  assert.equal(calls, 1);
});

test("format retries share the total inference deadline", async () => {
  let time = 0,
    calls = 0;
  const send = createModelTransport("https://fixture.invalid", {
    timeoutMs: 1000,
    now: () => time,
    fetchImpl: async () => {
      calls++;
      time += 1000;
      return new Response("{}");
    },
  });
  await send({});
  await assert.rejects(send({}), /LLM 请求超时/);
  assert.equal(calls, 1);
});

test("backoff cannot extend the total deadline", async () => {
  let calls = 0;
  const send = createModelTransport("https://fixture.invalid", {
    timeoutMs: 1000,
    wait: async () => assert.fail("no time for backoff"),
    fetchImpl: async () => {
      calls++;
      return new Response("busy", {
        status: 503,
        headers: { "Retry-After": "3" },
      });
    },
  });
  assert.equal((await send({})).status, 503);
  assert.equal(calls, 1);
});
