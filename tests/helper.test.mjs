import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { unpackedExtensionId } from "../helper/pairing.mjs";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("local helper: auth, origin restriction, request validation and optional model transport", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "jseeker-jd-log-"));
  const jdLog = join(logDir, "nested", "jobs.jsonl");
  let observed;
  let observedAuthorization;
  let helperOutput = "";
  let truncatedCalls = 0;
  let flakyCalls = 0;
  let screenFlakyCalls = 0;
  let emptyCalls = 0;
  let brokenCalls = 0;
  let percentScoreCalls = 0;
  let invalidScoreCalls = 0;
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    observed = JSON.parse(Buffer.concat(chunks));
    observedAuthorization = req.headers.authorization;
    if (observed.messages?.[0]?.content?.includes("预筛")) {
      if (
        observed.messages[1].content.includes("screen-flaky") &&
        screenFlakyCalls++ === 0
      ) {
        res.statusCode = 503;
        res.end('{"error":{"message":"temporarily unavailable"}}');
        return;
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"results":[{"id":"t1","open":false},{"id":"bad","open":"yes"}]}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    let userInput = {};
    try {
      // The model-verify ping posts plain text, not a JD/profile payload.
      userInput = JSON.parse(
        observed.messages?.find((message) => message.role === "user")
          ?.content || "{}",
      );
    } catch {}
    if (userInput.job?.title === "slow")
      await new Promise((resolve) => setTimeout(resolve, 1300));
    res.setHeader("Content-Type", "application/json");
    if (userInput.job?.title === "truncated" && truncatedCalls++ === 0) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"match_score":88,"verdict":"apply"' },
              finish_reason: "length",
            },
          ],
        }),
      );
      return;
    }
    if (userInput.job?.title === "percent-score") {
      percentScoreCalls++;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"match_score":"88%","verdict":"apply"}' },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    if (
      userInput.job?.title === "invalid-score" &&
      invalidScoreCalls++ === 0
    ) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"match_score":101,"verdict":"apply"}' },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    if (userInput.job?.title === "empty" && emptyCalls++ === 0) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: "  " },
              finish_reason: "stop",
            },
          ],
        }),
      );
      return;
    }
    if (userInput.job?.title === "flaky" && flakyCalls++ === 0) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          error: { message: "Upstream service temporarily unavailable" },
        }),
      );
      return;
    }
    if (userInput.job?.title === "unavailable") {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { message: "Upstream service temporarily unavailable" } }));
      return;
    }
    if (userInput.job?.title === "broken") {
      brokenCalls++;
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { content: '{"match_score":88' },
              finish_reason: "length",
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                match_score: 88,
                verdict: "apply",

                strengths: ["Python"],
                gaps: [],
                evidence: [
                  {
                    dimension: "skill",
                    jd_quote: "Python",
                    profile_quote: "Python",
                    reason: "both",
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const token = randomBytes(24).toString("hex");
  const helper = spawn(process.execPath, ["helper/server.mjs"], {
    env: {
      ...process.env,
      JSEEKER_PORT: "0",
      JSEEKER_JD_LOG_PATH: jdLog,
      JSEEKER_TOKEN: token,
      OPENAI_MODEL: "fixture-model",
      OPENAI_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      OPENAI_API_KEY: "fixture-key",
      OPENAI_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error("helper startup timeout")),
        8000,
      );
      helper.stdout.on("data", (d) => {
        out += d;
        helperOutput += d;
        const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
      helper.on("error", reject);
      helper.on("exit", (code) => {
        if (code !== null && code !== 0)
          reject(new Error("helper exited " + code));
      });
    });
    const post = (path, body = {}, extra = {}) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...extra,
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await fetch(url + "/health", { method: "POST" })).status,
      401,
    );
    assert.equal(
      (await post("/health", {}, { Origin: "https://untrusted.example" }))
        .status,
      403,
    );
    assert.equal((await post("/health")).status, 200);
    const pairingKey = readFileSync(".helper-pairing-key", "utf8").trim();
    const pair = (origin, contentType = "application/json", key = pairingKey) =>
      fetch(url + "/pair", {
        method: "POST",
        headers: {
          ...(origin ? { Origin: origin } : {}),
          "Content-Type": contentType,
          Authorization: `Bearer ${key}`,
        },
        body: "{}",
      });
    for (const origin of [
      undefined,
      "https://untrusted.example",
      `chrome-extension://${"a".repeat(32)}`,
    ])
      assert.equal((await pair(origin)).status, 403);
    const trustedOrigin = `chrome-extension://${unpackedExtensionId("dist")}`;
    assert.equal(
      (await pair(trustedOrigin, "application/json", "wrong-key")).status,
      403,
    );
    assert.equal((await pair(trustedOrigin, "text/plain")).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        url + "/pair",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pairingKey}`,
            Host: "attacker.example",
            Origin: trustedOrigin,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(badHostStatus, 403);
    const paired = await pair(trustedOrigin);
    assert.equal(paired.status, 200);
    assert.equal(
      paired.headers.get("access-control-allow-origin"),
      trustedOrigin,
    );
    assert.equal((await paired.json()).token, token);
    assert.equal((await post("/ocr", { image: "not png" })).status, 400);
    assert.equal(
      (await post("/evaluate", { job: {}, profile: {} })).status,
      400,
    );
    const result = await (
      await post("/evaluate", {
        job: { title: "engineer", jd: "Python" },
        profile: { text: "Python" },
        timing: { request_id: "timing-fixture", trace_id: "trace-fixture", site: "boss", job_id: "j1" },
      })
    ).json();
    assert.equal(result.match_score, 88);
    // Timing is queued after the response; wait for the writer, not CPU timing.
    let measured;
    for (let attempt = 0; attempt < 100 && !measured; attempt++) {
      const timings = readFileSync(join(logDir, "nested", "pipeline-timing.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      measured = timings.find(r => r.request_id === "timing-fixture");
      if (!measured) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(measured, "helper timing record was persisted");
    assert.equal(measured.phase, "evaluate");
    assert.equal(measured.trace_id, "trace-fixture");
    assert.equal(measured.site, "boss");
    assert.ok(measured.elapsed_ms >= 0);
    assert.equal((await post("/timing", { events: [{event:"timing:phase", phase:"tab_open", elapsed_ms:12, profile:"PRIVATE_CV"}] })).status, 200);
    assert.equal(readFileSync(join(logDir, "nested", "pipeline-timing.jsonl"), "utf8").includes("PRIVATE_CV"), false);
    const logged = readFileSync(jdLog, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].job, { title: "engineer", jd: "Python" });
    assert.equal(logged[0].event, "jd_received");
    assert.ok(Number.isFinite(Date.parse(logged[0].timestamp)));
    assert.ok(!readFileSync(jdLog, "utf8").includes("fixture-key"));
    assert.equal(observed.model, "fixture-model");
    assert.equal(observedAuthorization, "Bearer fixture-key");
    assert.equal(observed.response_format.type, "json_schema");
    assert.equal(observed.response_format.json_schema.strict, true);
    assert.equal(
      observed.response_format.json_schema.schema.required.includes("match_score"),
      true,
    );
    assert.match(observed.messages[0].content, /不可信数据/);
    assert.match(observed.messages[0].content, /硬性条件单独列入 requirements/);
    assert.ok(observed.messages[0].content.includes('"summary":'));
    assert.ok(observed.messages[0].content.includes('"bonus_matches":[]'));
    assert.match(
      helperOutput,
      /\[JSeeker\]\[llm:request\][\s\S]*fixture-model/,
    );
    assert.match(helperOutput, /\[JSeeker\]\[llm:request\][\s\S]*\n\s+input:/);
    assert.match(helperOutput, /\[JSeeker\]\[llm:done\][\s\S]*\n\s+elapsed_s:/);
    assert.ok(!helperOutput.includes("fixture-key"));
    assert.ok(!helperOutput.includes(token));
    assert.ok(!helperOutput.includes(pairingKey));
    assert.equal(observed.reasoning_effort, undefined);
    const luna = await post("/evaluate", {
      model: "gpt-5.6-luna",
      job: { title: "engineer", jd: "Python" },
      profile: { text: "Python engineer" },
    });
    assert.equal(luna.status, 200);
    assert.equal(observed.model, "gpt-5.6-luna");
    assert.equal(observed.reasoning_effort, undefined);
    const lowLuna = await post("/evaluate", {
      model: "gpt-5.6-luna",
      reasoning_effort: "low",
      job: { title: "engineer", jd: "Python" },
      profile: { text: "Python engineer" },
    });
    assert.equal(lowLuna.status, 200);
    assert.equal(observed.reasoning_effort, "low");
    const fastGLM = await post("/evaluate", {
      model: "glm-5.3-flash",
      job: { title: "engineer", jd: "Python" },
      profile: { text: "Python engineer" },
    });
    assert.equal(fastGLM.status, 200);
    assert.equal(observed.reasoning_effort, "low");
    assert.equal(observed.thinking, undefined);
    const defaultGLM = await post("/evaluate", {
      model: "glm-5.3-flash",
      reasoning_effort: "default",
      job: { title: "engineer", jd: "Python" },
      profile: { text: "Python engineer" },
    });
    assert.equal(defaultGLM.status, 200);
    assert.equal(observed.reasoning_effort, undefined);
    const modelInfo = await (await post("/model")).json();
    assert.ok(modelInfo.version);
    const lowModelInfo = await (await post("/model", { model: "gpt-5.6-luna", reasoning_effort: "low" })).json();
    const defaultModelInfo = await (await post("/model", { model: "gpt-5.6-luna", reasoning_effort: "default" })).json();
    assert.notEqual(lowModelInfo.version, defaultModelInfo.version);
    const screened = await (
      await post("/screen", {
        titles: [
          { id: "t1", title: "电话销售专员" },
          { id: "t2", title: "资深AI工程师" },
        ],
        profile_text: "I build production AI agents.",
        good: ["资深AI工程师"],
        bad: ["电话销售专员"],
      })
    ).json();
    assert.deepEqual(screened.results, [{ id: "t1", open: false }]);
    assert.equal(observed.reasoning_effort, undefined);
    assert.equal(observed.temperature, 0);
    const screenLuna = await post("/screen", {
      titles: [{ id: "t1", title: "资深AI工程师" }],
      profile_text: "Python",
      model: "gpt-5.6-luna",
    });
    assert.equal(screenLuna.status, 200);
    assert.equal(observed.model, "gpt-5.6-luna");
    assert.equal(observed.reasoning_effort, undefined);
    const lowScreenLuna = await post("/screen", {
      titles: [{ id: "t1", title: "资深AI工程师" }],
      profile_text: "Python",
      model: "gpt-5.6-luna",
      reasoning_effort: "low",
    });
    assert.equal(lowScreenLuna.status, 200);
    assert.equal(observed.reasoning_effort, "low");
    const screenGLM = await (
      await post("/screen", {
        titles: [{ id: "t1", title: "资深AI工程师" }],
        profile_text: "Python",
        model: "glm-5.3-flash",
      })
    ).json();
    assert.deepEqual(screenGLM.results, [{ id: "t1", open: false }]);
    assert.equal(observed.reasoning_effort, "low");
    const screenRecovered = await (
      await post("/screen", {
        titles: [{ id: "t1", title: "screen-flaky" }],
        profile_text: "Python",
      })
    ).json();
    assert.deepEqual(screenRecovered.results, [{ id: "t1", open: false }]);
    assert.equal(screenFlakyCalls, 2);
    const screenedRejected = await post("/screen", { titles: [] });
    assert.equal(screenedRejected.status, 400);
    const verified = await (
      await post("/model", {
        verify: true,
        model: "fixture-model",
        base_url: `http://127.0.0.1:${model.address().port}/v1`,
      })
    ).json();
    assert.equal(verified.configured, true);
    assert.equal(verified.verified, true);
    const rejected = await (
      await post("/model", {
        verify: true,
        model: "fixture-model",
        base_url: "http://127.0.0.1:9/v1",
      })
    ).json();
    assert.equal(rejected.configured, false);
    assert.equal(rejected.verified, false);
    assert.match(rejected.error, /模型验证失败/);
    assert.ok(modelInfo.version);
    assert.equal(modelInfo.model, "fixture-model");
    const retried = await (
      await post("/evaluate", {
        job: { title: "truncated", jd: "Python" },
        profile: { text: "Python" },
      })
    ).json();
    assert.equal(retried.match_score, 88);
    assert.equal(truncatedCalls, 2);
    assert.match(helperOutput, /\[JSeeker\]\[llm:retry\]/);
    const flakyRecovered = await (
      await post("/evaluate", {
        job: { title: "flaky", jd: "Python" },
        profile: { text: "Python" },
      })
    ).json();
    assert.equal(flakyRecovered.match_score, 88);
    assert.equal(flakyCalls, 2);
    const emptied = await (
      await post("/evaluate", {
        job: { title: "empty", jd: "Python" },
        profile: { text: "Python" },
      })
    ).json();
    assert.equal(emptied.match_score, 88);
    assert.equal(emptyCalls, 2);
    const percentageScore = await (
      await post("/evaluate", {
        job: { title: "percent-score", jd: "Python" },
        profile: { text: "Python" },
      })
    ).json();
    assert.equal(percentageScore.match_score, 88);
    assert.equal(percentScoreCalls, 1);
    const invalidScoreRecovered = await (
      await post("/evaluate", {
        job: { title: "invalid-score", jd: "Python" },
        profile: { text: "Python" },
      })
    ).json();
    assert.equal(invalidScoreRecovered.match_score, 88);
    assert.equal(invalidScoreCalls, 2);
    const unavailable = await post("/evaluate", {
      job: { title: "unavailable", jd: "Python" }, profile: { text: "Python" },
    });
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error, /Model HTTP 503: Upstream service temporarily unavailable/);
    const broken = await post("/evaluate", {
      job: { title: "broken", jd: "Python" },
      profile: { text: "Python" },
    });
    assert.equal(broken.status, 400);
    assert.match((await broken.json()).error, /连续返回不完整 JSON/);
    assert.equal(brokenCalls, 2);
    await post("/evaluate", {
      job: { title: "engineer", jd: "Python" },
      profile: { text: "Python" },
      api_key: "override-key",
    });
    assert.equal(observedAuthorization, "Bearer override-key");
    const timedOut = await post("/evaluate", {
      job: { title: "slow", jd: "Python" },
      profile: { text: "Python" },
    });
    assert.equal(timedOut.status, 504);
    assert.match((await timedOut.json()).error, /LLM 请求超时/);
    // Status requests must stay responsive while both inference slots are busy.
    const inFlight = [post("/evaluate", { job: { title: "slow", jd: "Python" }, profile: { text: "Python" } }),
      post("/evaluate", { job: { title: "slow", jd: "Python" }, profile: { text: "Python" } })];
    let active = 0;
    for (let attempt = 0; attempt < 40 && active < 2; attempt++) {
      const status = await post("/health");
      assert.equal(status.status, 200);
      active = (await status.json()).active_requests;
      if (active < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(active, 2);
    assert.equal((await post("/model")).status, 200);
    for (const response of await Promise.all(inFlight)) {
      assert.equal(response.status, 504);
      await response.json();
    }
    const health = await (await post("/health")).json();
    assert.equal(health.llm.api_key_configured, true);
    assert.ok(!JSON.stringify(health).includes("fixture-key"));
    assert.equal(observed.model, "fixture-model");
  } finally {
    helper.kill("SIGTERM");
    rmSync(logDir, { recursive: true, force: true });
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  }
});
