import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("fresh extension gets the catalog model without OPENAI_MODEL; custom endpoints still need a model", async () => {
  for (const [baseUrl, expectedModel] of [
    ["https://api.deepseek.com/v1", "deepseek-flash"],
    ["http://127.0.0.1:9/v1", ""],
  ]) {
    const helper = spawn(process.execPath, ["helper/server.mjs"], {
      env: {
        ...process.env,
        JSEEKER_PORT: "0",
        JSEEKER_TOKEN: "default-model-test-token",
        // Prevent the user's .env from supplying a model for this regression.
        OPENAI_MODEL: " ",
        JSEEKER_MODEL: "",
        OPENAI_BASE_URL: baseUrl,
        OPENAI_API_KEY: "default-model-fixture",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Helper startup timeout")),
          8000,
        );
        helper.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        helper.stdout.on("data", (chunk) => {
          const match = chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
      });
      const post = async (path, body = {}) => {
        const response = await fetch(url + path, {
          method: "POST",
          headers: {
            Authorization: "Bearer default-model-test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200);
        return response.json();
      };
      assert.equal((await post("/health")).llm.model, expectedModel);
      const resolved = await post("/model");
      assert.equal(resolved.configured, !!expectedModel);
      assert.equal(resolved.model, expectedModel);
      assert.equal(
        (await post("/model", { model: "explicit-model" })).model,
        "explicit-model",
      );
    } finally {
      helper.kill("SIGTERM");
      await once(helper, "exit");
    }
  }
});
