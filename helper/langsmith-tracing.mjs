import { trace, SpanStatusCode } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

export function createLangSmithTracing(env = process.env) {
  if (env.LANGSMITH_TRACING !== "true" || !env.LANGSMITH_API_KEY) {
    return { start: () => null, flush: async () => {} };
  }
  const base = (env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com").replace(/\/+$/, "");
  const endpoint = new URL(`${base}/otel/v1/traces`);
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(endpoint.hostname))
    throw new Error("LangSmith tracing endpoint must use HTTPS");
  const exporter = new OTLPTraceExporter({
    url: endpoint.href,
    headers: {
      "x-api-key": env.LANGSMITH_API_KEY,
      "Langsmith-Project": env.LANGSMITH_PROJECT || "jseeker",
    },
    timeoutMillis: 5000,
  });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": "jseeker-helper" }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("jseeker-helper");
  return {
    start(attributes) {
      const span = tracer.startSpan("job_match_score", { attributes: {
        "langsmith.span.kind": "llm",
        "gen_ai.operation.name": "chat",
        ...attributes,
      } });
      return {
        set(key, value) {
          if (value !== undefined && value !== null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
            span.setAttribute(key, value);
        },
        error(error) {
          span.recordException(error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        },
        end() { span.end(); },
      };
    },
    flush: () => provider.forceFlush(),
  };
}
