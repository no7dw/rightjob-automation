
import {
  CLOUD_BASE_URL,
  DEFAULT_LLM_MODE,
  PAY_MODE,
} from "./pay-config.js";
import {
  cloudAuthRequest,
  createCloudClient,
  normalizeCloudBaseUrl,
} from "./cloud-client.js";

const PAY_ACCOUNT_TTL_MS = 60_000;
const HELPER_TIMEOUT_MS = 125000;

/**
 * Premium service-worker pay runtime.
 * Host background.js stays thin and community-safe.
 */
export function createBackgroundPay({
  chrome,
  helperRequest,
  logEvent,
  normalizeModelName,
  localHelperRequest,
}) {
  if (!PAY_MODE) {
    return {
      enabled: false,
      PAY_MODE: false,
      async resolvedLlmMode() {
        return "byok";
      },
      async enhanceLocalRequest(path, body, signal, runLocal) {
        return runLocal(path, body, signal);
      },
      async afterContactOpened() {
        return null;
      },
      async safeHostedStatus() {
        return null;
      },
      messageHandlers: {},
      async getPayForConfig() {
        return null;
      },
    };
  }

  const cloudRequest = createCloudClient(chrome.storage);

  async function resolvedCloudBaseUrl() {
    const stored = await chrome.storage.local.get(["cloud_base_url"]);
    return (
      normalizeCloudBaseUrl(stored.cloud_base_url) ||
      normalizeCloudBaseUrl(CLOUD_BASE_URL)
    );
  }

  async function resolvedLlmMode() {
    const stored = await chrome.storage.local.get(["llm_mode"]);
    return stored.llm_mode === "byok" ? "byok" : DEFAULT_LLM_MODE || "hosted";
  }

  async function cachePayAccount(user, meta = {}) {
    const fetched_at = Date.now();
    await chrome.storage.local.set({
      pay_user: user || null,
      pay_account_meta: {
        llm_configured: meta.llm_configured === true,
        hosted_model: meta.hosted_model || "",
      },
      pay_account_fetched_at: fetched_at,
    });
    return fetched_at;
  }

  async function payAccount({ force = false } = {}) {
    const baseUrl = await resolvedCloudBaseUrl();
    const local = await chrome.storage.local.get([
      "pay_session_token",
      "pay_user",
      "pay_account_meta",
      "pay_account_fetched_at",
    ]);
    if (!local.pay_session_token) {
      return {
        logged_in: false,
        base_url: baseUrl,
        user: null,
        cached: false,
        fetched_at: 0,
      };
    }
    const fetchedAt = Number(local.pay_account_fetched_at) || 0;
    const age = Date.now() - fetchedAt;
    const cacheFresh =
      !force &&
      local.pay_user &&
      fetchedAt > 0 &&
      age >= 0 &&
      age < PAY_ACCOUNT_TTL_MS;
    if (cacheFresh) {
      return {
        logged_in: true,
        base_url: baseUrl,
        user: local.pay_user,
        llm_configured: local.pay_account_meta?.llm_configured !== false,
        hosted_model: local.pay_account_meta?.hosted_model || "",
        cached: true,
        fetched_at: fetchedAt,
        stale_in_ms: Math.max(0, PAY_ACCOUNT_TTL_MS - age),
      };
    }
    try {
      const response = await cloudRequest(
        baseUrl,
        "/me",
        {},
        AbortSignal.timeout(8000),
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const fetched_at = await cachePayAccount(data.user || null, {
        llm_configured: data.llm_configured === true,
        hosted_model: data.hosted_model || "",
      });
      return {
        logged_in: true,
        base_url: baseUrl,
        user: data.user || null,
        llm_configured: data.llm_configured === true,
        hosted_model: data.hosted_model || "",
        cached: false,
        fetched_at,
        stale_in_ms: PAY_ACCOUNT_TTL_MS,
      };
    } catch (error) {
      return {
        logged_in: !!local.pay_session_token,
        base_url: baseUrl,
        user: local.pay_user || null,
        llm_configured: local.pay_account_meta?.llm_configured !== false,
        hosted_model: local.pay_account_meta?.hosted_model || "",
        error: error.message,
        cached: true,
        fetched_at: fetchedAt,
      };
    }
  }

  async function cloudInferenceRequest(path, body = {}, signal = null) {
    const baseUrl = await resolvedCloudBaseUrl();
    if (!baseUrl) throw new Error("未配置云端服务地址（CLOUD_BASE_URL）");
    const account = await payAccount();
    if (!account.logged_in) throw new Error("请先在设置页登录邮箱账号");
    if (account.user && account.user.enabled === false)
      throw new Error("账号已停用，请联系管理员开通");
    if (
      ["/evaluate", "/screen", "/model"].includes(path) &&
      account.user &&
      (Number(account.user.quota_remaining) || 0) <= 0
    )
      throw new Error(
        "试用额度已用尽。云端评分与自动沟通已暂停，请联系管理员开通或增加额度",
      );
    const started = Date.now();
    const timing = { ...body.timing, request_id: crypto.randomUUID() };
    const payload = { ...body, timing, api_key: "" };
    const details = {
      path,
      transport: "cloud",
      model: typeof payload.model === "string" ? payload.model : "",
      job_id: typeof payload.job?.job_id === "string" ? payload.job.job_id : "",
    };
    logEvent("helper:start", { ...details, elapsed_s: 0 });
    const heartbeat = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
      logEvent("helper:waiting", {
        ...details,
        elapsed_ms: Date.now() - started,
        elapsed_s: Math.round((Date.now() - started) / 100) / 10,
      });
    }, 10000);
    let response;
    try {
      response = await cloudRequest(
        baseUrl,
        path,
        payload,
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(HELPER_TIMEOUT_MS)])
          : AbortSignal.timeout(HELPER_TIMEOUT_MS),
      );
    } catch (error) {
      clearInterval(heartbeat);
      logEvent("helper:error", {
        ...details,
        elapsed_ms: Date.now() - started,
        error: error.message,
      });
      if (error.name === "TimeoutError" || error.name === "AbortError")
        throw new Error("云端服务请求超时，请稍后重试或检查网络。");
      throw error;
    }
    clearInterval(heartbeat);
    const data = await response.json().catch(() => ({}));
    logEvent(response.ok ? "helper:done" : "helper:error", {
      ...details,
      elapsed_ms: Date.now() - started,
      status: response.status,
      error: response.ok ? undefined : data.error,
    });
    if (!response.ok)
      throw Object.assign(
        new Error(data.error || `云端服务 HTTP ${response.status}`),
        { status: response.status },
      );
    return data;
  }

  async function reportContactUsage(jobId, meta = {}) {
    if ((await resolvedLlmMode()) !== "hosted") return null;
    if (!jobId) return null;
    const baseUrl = await resolvedCloudBaseUrl();
    if (!baseUrl) return null;
    const local = await chrome.storage.local.get(["pay_session_token"]);
    if (!local.pay_session_token) return null;
    try {
      const response = await cloudRequest(
        baseUrl,
        "/usage/contact",
        { job_id: jobId, ...meta },
        AbortSignal.timeout(8000),
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        logEvent("pay:usage_error", {
          job_id: jobId,
          status: response.status,
          error: data.error,
        });
        return null;
      }
      if (data.user) {
        const metaStore = await chrome.storage.local.get("pay_account_meta");
        await cachePayAccount(data.user, {
          llm_configured: true,
          hosted_model: metaStore.pay_account_meta?.hosted_model || "",
        });
      }
      return data;
    } catch (error) {
      logEvent("pay:usage_error", { job_id: jobId, error: error.message });
      return null;
    }
  }

  async function safeHostedStatus(
    model = "",
    reasoningEffort = "auto",
    verify = false,
    runLocalRequest,
  ) {
    if ((await resolvedLlmMode()) !== "hosted") return null;
    const account = await payAccount();
    const requested = normalizeModelName(model);
    const hostedConfigured =
      account.logged_in &&
      account.user?.enabled !== false &&
      (Number(account.user?.quota_remaining) || 0) > 0 &&
      account.llm_configured !== false;
    let verified = false;
    let error = account.error || "";
    if (!account.logged_in) error = error || "请先登录邮箱账号";
    else if (account.user?.enabled === false) error = "账号已停用";
    else if ((Number(account.user?.quota_remaining) || 0) <= 0)
      error = "试用额度已用尽";
    if (verify && hostedConfigured) {
      try {
        const result = await runLocalRequest("/model", {
          model: requested || account.hosted_model || "",
          base_url: "",
          api_key: "",
          reasoning_effort: reasoningEffort,
          verify: true,
        });
        verified = result.verified === true;
        if (!verified) error = result.error || "托管模型验证失败";
      } catch (err) {
        error = err.message;
      }
    }
    let ocr_ready = false;
    try {
      const health = await localHelperRequest("/health");
      ocr_ready = health.ocr_ready === true;
    } catch {
      ocr_ready = false;
    }
    return {
      configured: hostedConfigured && !error,
      ocr_ready,
      model: requested || account.hosted_model || "",
      base_url: account.base_url || "",
      version: "",
      prompt_version: "",
      verified: verify ? verified : undefined,
      error: error || undefined,
      pay: account,
      mode: "hosted",
    };
  }

  const messageHandlers = {
    async PAY_REQUEST_LINK(message, { own }) {
      if (!own) throw new Error("仅限设置页");
      const email = String(message.email || "").trim();
      const baseUrl =
        normalizeCloudBaseUrl(message.base_url) ||
        (await resolvedCloudBaseUrl());
      if (!baseUrl) throw new Error("未配置云端服务地址");
      if (message.base_url)
        await chrome.storage.local.set({
          cloud_base_url: normalizeCloudBaseUrl(message.base_url),
        });
      return cloudAuthRequest(baseUrl, "/auth/request-link", { email });
    },
    async PAY_EXCHANGE(message, { own }) {
      if (!own) throw new Error("仅限设置页");
      const code = String(message.code || "").trim();
      const baseUrl =
        normalizeCloudBaseUrl(message.base_url) ||
        (await resolvedCloudBaseUrl());
      if (!baseUrl) throw new Error("未配置云端服务地址");
      const data = await cloudAuthRequest(baseUrl, "/auth/session", { code });
      await chrome.storage.local.set({
        cloud_base_url: baseUrl,
        pay_session_token: data.session_token,
        llm_mode: "hosted",
      });
      await cachePayAccount(data.user || null, { llm_configured: true });
      return { user: data.user, pay: await payAccount({ force: true }) };
    },
    async PAY_LOGOUT(_message, { own }) {
      if (!own) throw new Error("仅限设置页");
      const baseUrl = await resolvedCloudBaseUrl();
      const local = await chrome.storage.local.get(["pay_session_token"]);
      if (baseUrl && local.pay_session_token) {
        try {
          await cloudRequest(
            baseUrl,
            "/auth/logout",
            {},
            AbortSignal.timeout(5000),
          );
        } catch {
          /* ignore */
        }
      }
      await chrome.storage.local.remove([
        "pay_session_token",
        "pay_user",
        "pay_account_meta",
        "pay_account_fetched_at",
      ]);
      return true;
    },
    async PAY_SET_MODE(message, { own, safeLLMStatus }) {
      if (!own) throw new Error("仅限设置页");
      const mode = message.mode === "byok" ? "byok" : "hosted";
      await chrome.storage.local.set({ llm_mode: mode });
      if (
        typeof message.cloud_base_url === "string" &&
        message.cloud_base_url.trim()
      )
        await chrome.storage.local.set({
          cloud_base_url: normalizeCloudBaseUrl(message.cloud_base_url),
        });
      return {
        mode,
        pay: await payAccount({ force: message.refresh_pay === true }),
        status: await safeLLMStatus(
          message.model,
          message.base_url,
          String(message.api_key || "").trim(),
        ),
      };
    },
    async PAY_STATUS(message, { own }) {
      if (!own) throw new Error("仅限设置页");
      return {
        pay_mode: true,
        mode: await resolvedLlmMode(),
        cloud_base_url: await resolvedCloudBaseUrl(),
        pay: await payAccount({ force: message.refresh_pay === true }),
      };
    },
    async PAY_REFRESH(_message, { own }) {
      if (!own) throw new Error("仅限设置页");
      return {
        pay_mode: true,
        mode: await resolvedLlmMode(),
        cloud_base_url: await resolvedCloudBaseUrl(),
        pay: await payAccount({ force: true }),
      };
    },
    async PAY_REPORT_CONTACT(message) {
      return reportContactUsage(message.job_id, {
        run_id: message.run_id || "",
        site: message.site || "",
      });
    },
  };

  return {
    enabled: true,
    PAY_MODE: true,
    resolvedLlmMode,
    payAccount,
    async enhanceLocalRequest(path, body, signal, runLocal) {
      if (path === "/ocr") return runLocal(path, body, signal);
      if (
        (await resolvedLlmMode()) === "hosted" &&
        ["/evaluate", "/screen", "/model"].includes(path)
      )
        return cloudInferenceRequest(path, body, signal);
      return runLocal(path, body, signal);
    },
    afterContactOpened: reportContactUsage,
    safeHostedStatus,
    messageHandlers,
    async getPayForConfig({ force = false } = {}) {
      return payAccount({ force });
    },
    CLOUD_BASE_URL,
  };
}
