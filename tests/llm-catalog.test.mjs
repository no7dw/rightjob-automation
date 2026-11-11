import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  catalogProviderById,
  matchCatalogProvider,
  openAICompatibleProviders,
  providerModels,
} from "../extension/llm-catalog.js";

const catalog = {
  providers: [
    {
      id: "provider-a",
      name: "Provider A",
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      endpointCandidates: ["https://api.example.com/v1/chat/completions"],
      models: [{ id: "model-a", name: "Model A" }],
    },
    {
      id: "responses-only",
      name: "Responses",
      protocol: "openai_responses",
      baseUrl: "https://responses.example.com/v1",
      models: [{ id: "model-b" }],
    },
  ],
};

test("catalog exposes supported API providers", () => {
  assert.deepEqual(
    openAICompatibleProviders(catalog).map((provider) => provider.id),
    ["provider-a", "responses-only"],
  );
});

test("bundled catalog includes OpenAI and Claude", () => {
  const bundled = JSON.parse(
    readFileSync(
      new URL("../extension/llm-provider-catalog.json", import.meta.url),
    ),
  );
  const providers = openAICompatibleProviders(bundled);
  assert.equal(
    providers.find((provider) => provider.id === "openai")?.protocol,
    "openai_responses",
  );
  assert.equal(
    providers.find((provider) => provider.id === "claude")?.protocol,
    "anthropic_messages",
  );
});

test("provider and model auto-link from a saved Base URL", () => {
  assert.equal(
    matchCatalogProvider(catalog, "https://api.example.com/v1").id,
    "provider-a",
  );
  assert.equal(catalogProviderById(catalog, "provider-a").name, "Provider A");
  assert.deepEqual(
    providerModels(catalogProviderById(catalog, "provider-a")).map(
      (model) => model.id,
    ),
    ["model-a"],
  );
});

test("unknown Bases remain custom instead of matching unrelated hosts", () => {
  assert.equal(
    matchCatalogProvider(catalog, "https://custom.example.com/v1"),
    null,
  );
});
