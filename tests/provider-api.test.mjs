import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProviderSender } from "../helper/provider-api.mjs";

const catalog = JSON.parse(
  readFileSync(
    new URL("../extension/llm-provider-catalog.json", import.meta.url),
  ),
);

for (const [baseUrl, expectedPath, expectedAuth, reply, expectedText] of [
  [
    "https://api.openai.com/v1",
    "/v1/responses",
    "Bearer test-key",
    { output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }] },
    '{"ok":true}',
  ],
  [
    "https://api.anthropic.com",
    "/v1/messages",
    "test-key",
    { content: [{ type: "text", text: '{"ok":true}' }] },
    '{"ok":true}',
  ],
]) {
  test(`sends and reads native model API at ${baseUrl}`, async () => {
    let actual;
    const send = createProviderSender(catalog, baseUrl, "test-key", {
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        actual = { url, headers: init.headers, body: JSON.parse(init.body) };
        return Response.json(reply);
      },
    });
    const response = await send({
      model: "fixture",
      max_tokens: 100,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "Return JSON" },
        { role: "user", content: "hello" },
      ],
    });
    assert.equal(new URL(actual.url).pathname, expectedPath);
    assert.equal(
      actual.headers[
        expectedPath.includes("messages") ? "x-api-key" : "Authorization"
      ],
      expectedAuth,
    );
    assert.equal(actual.body.model, "fixture");
    assert.equal(actual.body.max_tokens || actual.body.max_output_tokens, 100);
    assert.deepEqual(
      expectedPath.includes("messages") ? actual.body.output_config : actual.body.reasoning,
      { effort: "low" },
    );
    assert.equal(
      (await response.json()).choices[0].message.content,
      expectedText,
    );
  });
}
