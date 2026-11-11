// One deadline covers the initial request, backoff, and format retries.
// This transport is only for model inference, never for contact actions.
export function createModelTransport(
  url,
  {
    timeoutMs,
    headers,
    fetchImpl = fetch,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry = () => {},
  },
) {
  const deadline = now() + timeoutMs;
  const timeoutError = () => Object.assign(new Error(
    `LLM 请求超时（${Math.round(timeoutMs / 1000)}秒），可重新运行评分`,
  ), { status: 504 });
  return async (payload) => {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw timeoutError();
      let response;
      let reason;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(Math.ceil(remaining)),
        });
      } catch (error) {
        if (error.name === "TimeoutError" || error.name === "AbortError")
          throw timeoutError();
        if (!(error instanceof TypeError)) throw error;
        if (attempt > 0) {
          const code = error.cause?.code;
          const detail = typeof code === "string" && /^[A-Z_]+$/.test(code)
            ? code : "网络连接失败";
          throw Object.assign(new Error(
            `AI 请求无法连接模型服务（${new URL(url).host}）：${detail}；请检查模型地址及对应服务`,
            { cause: error },
          ), { status: 502 });
        }
        reason = "network_error";
      }
      if (response) {
        if (attempt > 0 || ![429, 500, 502, 503, 504].includes(response.status))
          return response;
        reason = `http_${response.status}`;
      }
      const retryAfter = response?.headers.get("retry-after");
      const seconds = Number(retryAfter);
      const requestedDelay =
        retryAfter == null
          ? Math.min(1500, timeoutMs / 4)
          : Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(retryAfter) - now();
      const delay = Math.min(
        5000,
        Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : 1500),
      );
      if (deadline - now() <= delay) {
        if (response) return response;
        throw timeoutError();
      }
      // Release the failed response before retrying the pooled connection.
      await response?.body?.cancel().catch(() => {});
      onRetry(reason);
      await wait(delay);
    }
  };
}
