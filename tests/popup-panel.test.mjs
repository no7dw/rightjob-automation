import test from "node:test";
import assert from "node:assert/strict";
import {
  isJobsPage,
  openMatchPanel,
  startBossAutoReply,
  startAutoMessages,
  autoMessageOptions,
} from "../extension/popup-panel.js";

test("Liepin popup restores the auto-read script after extension reload", async () => {
  const calls = [],
    injections = [];
  const tab = { id: 7, url: "https://www.liepin.com/a/81154821.shtml" };
  assert.equal(autoMessageOptions(tab.url).label, "自动已读消息");
  const result = await startAutoMessages(
    {
      tabs: {
        sendMessage: async (_id, message) => {
          calls.push(message);
          if (calls.length === 1)
            throw new Error("Receiving end does not exist");
          return { ok: true, data: { enabled: true } };
        },
      },
      scripting: { executeScript: async (options) => injections.push(options) },
    },
    tab,
  );
  assert.equal(result.enabled, true);
  assert.deepEqual(calls, [
    { type: "LIEPIN_AUTO_READ_CONTROL", action: "start" },
    { type: "LIEPIN_AUTO_READ_CONTROL", action: "start" },
  ]);
  assert.deepEqual(injections, [
    { target: { tabId: 7 }, files: ["liepin-auto-read.js"] },
  ]);
  assert.equal(
    autoMessageOptions("https://example.com/a/81154821.shtml"),
    null,
  );
});

test("only BOSS HTTPS search page supports pipeline", () => {
  assert.equal(
    isJobsPage("https://www.zhipin.com/web/geek/jobs?city=101280600"),
    true,
  );
  assert.equal(
    isJobsPage("https://zhipin.com/web/geek/jobs?city=101280600"),
    true,
  );
  for (const url of [
    "https://www.zhipin.com/job_detail/123.html",
    "https://evil.example/web/geek/jobs",
    "http://www.zhipin.com/web/geek/jobs",
    undefined,
  ])
    assert.equal(isJobsPage(url), false);
});

test("existing sidebar is restored without duplicate injection", async () => {
  const browser = {
    tabs: {
      sendMessage: async (id, message) => {
        assert.equal(id, 7);
        assert.equal(message.type, "TOGGLE");
        return { ok: true };
      },
    },
    scripting: {
      executeScript: async () => assert.fail("unnecessary injection"),
    },
  };
  await openMatchPanel(browser, {
    id: 7,
    url: "https://www.zhipin.com/web/geek/jobs",
  });
});

test("already open tab without content listener receives script and show message", async () => {
  let messages = 0;
  const injections = [];
  const browser = {
    tabs: {
      sendMessage: async () => {
        if (++messages === 1) throw new Error("Receiving end does not exist");
        return { ok: true };
      },
    },
    scripting: { executeScript: async (options) => injections.push(options) },
  };
  await openMatchPanel(browser, {
    id: 7,
    url: "https://www.zhipin.com/web/geek/jobs",
  });
  assert.equal(messages, 2);
  assert.equal(injections.length, 2);
  assert.deepEqual(injections[1], {
    target: { tabId: 7 },
    files: ["content.js"],
  });
});

test("unsupported pages never receive injected code", async () => {
  await assert.rejects(
    openMatchPanel({}, { id: 7, url: "https://example.com" }),
    /职位搜索列表页/,
  );
});

test("BOSS chat toolbar recovery injects the chat sidebar", async () => {
  const injections = [];
  let messages = 0;
  await openMatchPanel(
    {
      tabs: {
        sendMessage: async () => (++messages === 1 ? null : { ok: true }),
      },
      scripting: { executeScript: async (options) => injections.push(options) },
    },
    { id: 7, url: "https://www.zhipin.com/web/geek/chat" },
  );
  assert.equal(isJobsPage("https://www.zhipin.com/web/geek/chat"), true);
  assert.deepEqual(injections[1].files, ["boss-auto-reply.js"]);
});

test("popup starts auto reply without depending on a mounted sidebar", async () => {
  const commands = [];
  const result = await startBossAutoReply(
    {
      tabs: {
        sendMessage: async (id, message) => {
          commands.push({ id, ...message });
          return { ok: true, data: { enabled: true } };
        },
      },
      scripting: {
        executeScript: async () => assert.fail("chat listener already exists"),
      },
    },
    { id: 7, url: "https://www.zhipin.com/web/geek/chat" },
  );
  assert.deepEqual(result, { enabled: true });
  assert.deepEqual(commands, [
    { id: 7, type: "BOSS_AUTO_REPLY_CONTROL", action: "start" },
  ]);
});

test("popup injects a missing chat listener once and retries the start command", async () => {
  const injections = [];
  let commands = 0;
  await startBossAutoReply(
    {
      tabs: {
        sendMessage: async () => {
          if (++commands === 1) throw new Error("Receiving end does not exist");
          return { ok: true, data: { enabled: true } };
        },
      },
      scripting: { executeScript: async (options) => injections.push(options) },
    },
    { id: 7, url: "https://zhipin.com/web/geek/chat" },
  );
  assert.equal(commands, 2);
  assert.deepEqual(injections, [
    { target: { tabId: 7 }, files: ["boss-auto-reply.js"] },
  ]);
});

test("popup surfaces chat task errors without reinjection or a false success", async () => {
  await assert.rejects(
    startBossAutoReply(
      {
        tabs: {
          sendMessage: async () => ({ ok: false, error: "加分项消息正在处理" }),
        },
        scripting: {
          executeScript: async () =>
            assert.fail("do not retry a rejected start"),
        },
      },
      { id: 7, url: "https://www.zhipin.com/web/geek/chat" },
    ),
    /加分项消息正在处理/,
  );
  await assert.rejects(
    startBossAutoReply(
      {},
      { id: 7, url: "https://www.zhipin.com/web/geek/jobs" },
    ),
    /请先打开 BOSS 聊天页/,
  );
});
