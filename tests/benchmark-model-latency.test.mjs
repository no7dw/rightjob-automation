import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("speed CLI measures both response modes, validates output and excludes private input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jseeker-speed-"));
  const requests = [];
  let mode = "normal";
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body);
    if (mode === "timeout") return;
    if (mode === "http") {
      res.writeHead(503);
      res.end("SECRET_KEY");
      return;
    }
    const content = JSON.stringify({
      match_score: 88,
      requirements: [],
      bonus_matches: [],
    });
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [{ message: { content }, finish_reason: "stop" }],
        }),
      );
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    const event = JSON.stringify({
      model: body.model,
      choices: [{ delta: { content }, finish_reason: "stop" }],
    });
    // Deliberately split an event across chunks and omit the final newline.
    res.write("data: " + event.slice(0, 20));
    setTimeout(() => res.end(event.slice(20)), 10);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = join(dir, "config.json"),
    profile = join(dir, "profile.json"),
    jobs = join(dir, "jobs.jsonl"),
    out = join(dir, "report.json");
  writeFileSync(
    config,
    JSON.stringify({
      llm_base_url: `http://127.0.0.1:${server.address().port}/v1`,
      llm_model: "glm-5.3-flash",
      llm_api_key_override: "SECRET_KEY",
    }),
  );
  writeFileSync(profile, JSON.stringify({ text: "CONFIDENTIAL_CV" }));
  writeFileSync(
    jobs,
    ["old", "new"]
      .map((id) =>
        JSON.stringify({
          job_id: id,
          job: { job_id: id, title: "Engineer", jd: "PRIVATE_JD" },
        }),
      )
      .join("\n"),
  );
  const run = (extra) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "scripts/benchmark-model-latency.mjs",
        "--config",
        config,
        "--profile",
        profile,
        "--jobs",
        jobs,
        "--out",
        out,
        ...extra,
      ]);
      let output = "";
      child.stdout.on("data", (data) => (output += data));
      child.stderr.on("data", (data) => (output += data));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
    });
  try {
    const result = await run([
      "--cases",
      "production_stream_low,production_nonstream_low",
      "--repeats",
      "2",
    ]);
    assert.equal(result.code, 0, result.output);
    const report = JSON.parse(readFileSync(out));
    assert.equal(report.job_id, "new");
    assert.equal(report.results.length, 4);
    assert.ok(
      report.results.every(
        (r) =>
          r.result_valid &&
          r.score === 88 &&
          r.returned_model === "glm-5.3-flash",
      ),
    );
    assert.ok(
      report.results
        .filter((r) => r.streaming)
        .every((r) => r.first_content_ms !== null),
    );
    assert.ok(
      report.results
        .filter((r) => !r.streaming)
        .every((r) => r.first_content_ms === null),
    );
    assert.ok(
      requests.every(
        (r) =>
          r.reasoning_effort === "low" &&
          r.max_tokens === 3000 &&
          r.temperature === 0,
      ),
    );
    const markdown = readFileSync(out.replace(".json", ".md"), "utf8");
    assert.match(markdown, /2\/2/);
    assert.doesNotMatch(
      readFileSync(out, "utf8") + markdown + result.output,
      /SECRET_KEY|CONFIDENTIAL_CV|PRIVATE_JD/,
    );
    const before = requests.length;
    assert.notEqual((await run(["--repeats", "0"])).code, 0);
    assert.notEqual((await run(["--cases", "typo"])).code, 0);
    assert.notEqual((await run(["--job-id", "absent"])).code, 0);
    assert.equal(
      requests.length,
      before,
      "invalid inputs must fail before sending requests",
    );
    mode = "http";
    await run(["--cases", "production_nonstream_low", "--repeats", "1"]);
    assert.equal(requests.length, before + 1, "HTTP errors must not retry");
    assert.equal(JSON.parse(readFileSync(out)).results[0].error, "HTTP 503");
    mode = "timeout";
    await run([
      "--cases",
      "production_stream_low",
      "--repeats",
      "1",
      "--timeout-ms",
      "100",
    ]);
    assert.match(
      JSON.parse(readFileSync(out)).results[0].error,
      /100ms timeout/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
