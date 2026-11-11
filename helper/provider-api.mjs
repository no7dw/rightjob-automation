import { matchCatalogProvider } from "../extension/llm-catalog.js";
import { createModelTransport } from "./model-transport.mjs";

export function modelProtocol(catalog, baseUrl) {
  return matchCatalogProvider(catalog, baseUrl)?.protocol || "openai_chat";
}

function endpoint(baseUrl, protocol) {
  const path =
    protocol === "anthropic_messages"
      ? "/v1/messages"
      : protocol === "openai_responses"
        ? "/responses"
        : "/chat/completions";
  return baseUrl.endsWith(path) ? baseUrl : `${baseUrl}${path}`;
}

function nativePayload(request, protocol) {
  if (protocol === "openai_chat") return request;
  const system =
    request.messages.find((message) => message.role === "system")?.content ||
    "";
  const user = request.messages.filter((message) => message.role !== "system");
  if (protocol === "anthropic_messages")
    return {
      model: request.model,
      max_tokens: request.max_tokens,
      ...(request.reasoning_effort ? { output_config: { effort: request.reasoning_effort } } : {}),
      system,
      messages: user,
    };
  return {
    model: request.model,
    max_output_tokens: request.max_tokens,
    ...(request.reasoning_effort ? { reasoning: { effort: request.reasoning_effort } } : {}),
    instructions: system,
    input: user,
  };
}

function normalizeResponse(value, protocol) {
  if (protocol === "openai_chat") return value;
  const text =
    protocol === "anthropic_messages"
      ? value.content
          ?.filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("")
      : value.output_text ||
        value.output
          ?.flatMap((item) => item.content || [])
          .filter((item) => item.type === "output_text")
          .map((item) => item.text)
          .join("");
  return {
    choices: [
      {
        message: { content: text },
        finish_reason: value.stop_reason || value.status || "",
      },
    ],
    usage: value.usage,
  };
}

export function createProviderSender(catalog, baseUrl, apiKey, options) {
  const protocol = modelProtocol(catalog, baseUrl);
  const send = createModelTransport(endpoint(baseUrl, protocol), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Connection: "close",
      ...(protocol === "anthropic_messages"
        ? {
            "anthropic-version": "2023-06-01",
            ...(apiKey ? { "x-api-key": apiKey } : {}),
          }
        : apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {}),
    },
  });
  return async (request) => {
    const response = await send(nativePayload(request, protocol));
    if (!response.ok || protocol === "openai_chat") return response;
    const value = await response.json();
    return new Response(JSON.stringify(normalizeResponse(value, protocol)), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}
