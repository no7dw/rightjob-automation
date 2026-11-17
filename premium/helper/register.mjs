import { createPayStore, isValidEmail, normalizeEmail } from "./pay-store.mjs";
import { magicLinkEmailContent, sendResendEmail } from "./pay-mail.mjs";
import { adminPageHtml, authCallbackHtml } from "./pay-admin-page.mjs";

export function isPayModeEnv(env = process.env) {
  return (
    env.PAY_MODE === "1" ||
    env.PAY_MODE === "true" ||
    env.JSEEKER_PAY_MODE === "1"
  );
}

/**
 * Optional premium runtime for helper/server.mjs.
 * Community builds never load this module.
 */
export function createPayRuntime({
  env = process.env,
  defaultModel = "",
  openAiBaseUrl = "",
  openAiApiKey = "",
} = {}) {
  if (!isPayModeEnv(env)) return null;

  const APP_PUBLIC_URL = (env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
  const RESEND_API_KEY = env.RESEND_API_KEY || "";
  const RESEND_FROM = env.RESEND_FROM || "";
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "";
  const APP_NAME = env.APP_NAME || "JSeeker";
  const payStore = createPayStore();
  const linkRate = new Map();

  function rateLimitLink(email) {
    const key = normalizeEmail(email);
    const now = Date.now();
    const prev = linkRate.get(key) || 0;
    if (now - prev < 30_000) {
      const error = new Error("发送过于频繁，请稍后再试");
      error.status = 429;
      throw error;
    }
    linkRate.set(key, now);
  }

  function originOK(origin, communityOriginOK) {
    if (communityOriginOK(origin)) return true;
    if (!origin || !APP_PUBLIC_URL) return false;
    try {
      return new URL(origin).origin === new URL(APP_PUBLIC_URL).origin;
    } catch {
      return false;
    }
  }

  function sessionUser(authorizationHeader) {
    return payStore.sessionUser(authorizationHeader);
  }

  function allowHostedInference(req, body, { localAuthorized }) {
    const hasClientKey =
      typeof body.api_key === "string" && body.api_key.trim().length > 0;
    if (hasClientKey && localAuthorized(req)) return { mode: "byok_local" };
    if (hasClientKey) return { mode: "byok_session", user: sessionUser(req.headers.authorization) };
    return { mode: "hosted", user: sessionUser(req.headers.authorization) };
  }

  function decorateProviderError(message, accessMode) {
    const text = String(message || "");
    if (
      accessMode === "hosted" &&
      /401|invalid api key|unauthorized|authentication/i.test(text)
    ) {
      return (
        "托管公共 API Key 无效或与 Base URL 不匹配（检查服务器 .env 的 OPENAI_API_KEY / OPENAI_BASE_URL 后执行 ./restart.sh pay）。原始错误：" +
        text
      );
    }
    return text;
  }

  function prepareHostedBody(body) {
    payStore.assertHostedAccess(
      body.__pay_user || null,
    );
  }

  async function handlePublicRoute({
    req,
    res,
    pathname,
    method,
    readBody,
    respond,
    htmlRespond,
  }) {
    if (pathname === "/auth/callback" && method === "GET") {
      try {
        const url = new URL(req.url || "/", APP_PUBLIC_URL || "http://127.0.0.1");
        const token = url.searchParams.get("token") || "";
        const { code } = payStore.consumeMagicLink(token);
        htmlRespond(res, 200, authCallbackHtml({ appName: APP_NAME, code }));
      } catch (error) {
        htmlRespond(
          res,
          400,
          authCallbackHtml({
            appName: APP_NAME,
            error: error.message || "登录失败",
          }),
        );
      }
      return true;
    }

    if (pathname === "/admin" && method === "GET") {
      htmlRespond(res, 200, adminPageHtml());
      return true;
    }

    if (pathname === "/auth/request-link" && method === "POST") {
      try {
        const body = await readBody(req);
        const email = normalizeEmail(body.email);
        if (!isValidEmail(email)) {
          respond(400, { error: "请输入有效邮箱" });
          return true;
        }
        rateLimitLink(email);
        if (!APP_PUBLIC_URL) {
          respond(500, { error: "未配置 APP_PUBLIC_URL" });
          return true;
        }
        const { token, user } = payStore.createMagicLink(email);
        const loginUrl = `${APP_PUBLIC_URL}/auth/callback?token=${encodeURIComponent(token)}`;
        const content = magicLinkEmailContent({
          appName: APP_NAME,
          loginUrl,
          code: "",
        });
        if (env.PAY_MAIL_STUB === "1") {
          console.log("[JSeeker][pay:mail-stub]", { email, loginUrl });
        } else {
          await sendResendEmail({
            apiKey: RESEND_API_KEY,
            from: RESEND_FROM,
            to: email,
            subject: content.subject,
            html: content.html,
            text: content.text,
          });
        }
        respond(200, {
          ok: true,
          email: user.email,
          message: "登录邮件已发送，请查收并完成确认",
          ...(env.PAY_MAIL_STUB === "1" ? { login_url: loginUrl } : {}),
        });
      } catch (error) {
        const status =
          Number.isInteger(error.status) && error.status >= 400
            ? error.status
            : 400;
        respond(status, { error: error.message });
      }
      return true;
    }

    if (pathname === "/auth/session" && method === "POST") {
      try {
        const body = await readBody(req);
        const result = payStore.exchangeSession(String(body.code || "").trim());
        respond(200, result);
      } catch (error) {
        const status =
          Number.isInteger(error.status) && error.status >= 400
            ? error.status
            : 400;
        respond(status, { error: error.message });
      }
      return true;
    }

    if (pathname === "/auth/logout" && method === "POST") {
      payStore.revokeSession(req.headers.authorization);
      respond(200, { ok: true });
      return true;
    }

    if (pathname === "/me" && (method === "GET" || method === "POST")) {
      const user = sessionUser(req.headers.authorization);
      if (!user) {
        respond(401, { error: "未登录" });
        return true;
      }
      respond(200, {
        pay_mode: true,
        user,
        hosted_model: defaultModel,
        hosted_base_url: openAiBaseUrl,
        llm_configured: !!(openAiBaseUrl && openAiApiKey),
      });
      return true;
    }

    if (pathname.startsWith("/admin/api/") && method === "POST") {
      const password = req.headers["x-admin-password"] || "";
      if (!ADMIN_PASSWORD || !payStore.safeEqualSecret(password, ADMIN_PASSWORD)) {
        respond(401, { error: "Admin 密码错误" });
        return true;
      }
      try {
        const body = await readBody(req);
        if (pathname === "/admin/api/list") {
          respond(200, {
            users: payStore.listUsers(),
            usage: payStore.recentUsage(50),
          });
          return true;
        }
        if (pathname === "/admin/api/upsert") {
          const user = payStore.updateUser(body.email, body);
          respond(200, { user });
          return true;
        }
        respond(404, { error: "Unknown admin route" });
      } catch (error) {
        const status =
          Number.isInteger(error.status) && error.status >= 400
            ? error.status
            : 400;
        respond(status, { error: error.message });
      }
      return true;
    }

    if (pathname === "/usage/contact" && method === "POST") {
      try {
        const user = sessionUser(req.headers.authorization);
        if (!user) {
          respond(401, { error: "未登录" });
          return true;
        }
        const body = await readBody(req);
        const result = payStore.consumeContact(user.id, body.job_id, body);
        respond(200, result);
      } catch (error) {
        const status =
          Number.isInteger(error.status) && error.status >= 400
            ? error.status
            : 400;
        respond(status, { error: error.message });
      }
      return true;
    }

    return false;
  }

  function gateInference({ pathname, access, body }) {
    if (!["/evaluate", "/screen", "/model"].includes(pathname)) return body;
    if (access.mode === "hosted") {
      payStore.assertHostedAccess(access.user);
      body.api_key = "";
      if (!body.base_url) body.base_url = openAiBaseUrl;
      if (!body.model) body.model = defaultModel;
      if (!openAiApiKey) {
        const error = new Error(
          "未配置托管公共 OPENAI_API_KEY，请在服务器 .env 填写后执行 ./restart.sh pay",
        );
        error.status = 500;
        throw error;
      }
    }
    if (access.mode === "byok_session" && access.user?.enabled === false) {
      const error = new Error("账号已停用");
      error.status = 403;
      throw error;
    }
    return body;
  }

  return {
    enabled: true,
    payStore,
    APP_PUBLIC_URL,
    originOK,
    sessionUser,
    allowHostedInference,
    decorateProviderError,
    handlePublicRoute,
    gateInference,
    authorizeRequest(req, { localAuthorized }) {
      const payUser = sessionUser(req.headers.authorization);
      const isLocal = localAuthorized(req);
      return { payUser, isLocal, ok: isLocal || !!payUser };
    },
    listenHost: env.JSEEKER_HOST || "0.0.0.0",
    banner() {
      return `PAY_MODE: on; pay db: ${payStore.path}${
        APP_PUBLIC_URL ? `; public: ${APP_PUBLIC_URL}` : ""
      }`;
    },
  };
}

export async function tryCreatePayRuntime(options) {
  if (!isPayModeEnv(options?.env || process.env)) return null;
  try {
    return createPayRuntime(options);
  } catch (error) {
    error.message = `Failed to load premium pay runtime: ${error.message}`;
    throw error;
  }
}
