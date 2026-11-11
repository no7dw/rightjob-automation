import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createLangSmithTracing } from "../helper/langsmith-tracing.mjs";

test("LangSmith tracing exports a scoring span with project and API headers", async () => {
  let received;
  const collector = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    res.writeHead(200, { "Content-Type": "application/x-protobuf" });
    res.end();
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  try {
    const tracing = createLangSmithTracing({
      LANGSMITH_TRACING: "true",
      LANGSMITH_API_KEY: "test-key",
      LANGSMITH_PROJECT: "jseeker-test",
      LANGSMITH_ENDPOINT: `http://127.0.0.1:${collector.address().port}`,
    });
    const span = tracing.start({ "gen_ai.request.model": "test-model" });
    span.set("langsmith.metadata.match_score", 88);
    span.end();
    await tracing.flush();
    assert.equal(received.path, "/otel/v1/traces");
    assert.equal(received.headers["x-api-key"], "test-key");
    assert.equal(received.headers["langsmith-project"], "jseeker-test");
    assert.ok(received.body.length > 0);
    assert.ok(received.body.includes(Buffer.from("job_match_score")));
    assert.ok(received.body.includes(Buffer.from("test-model")));
  } finally {
    collector.close();
    await once(collector, "close");
  }
});
