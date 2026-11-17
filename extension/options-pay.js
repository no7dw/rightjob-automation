// Premium (prod-pay) account UX. Community/main builds keep PAY_MODE=false and
// never mount this module's chrome; safe no-op helpers remain callable.
import { PAY_MODE } from "./pay-config.js";

export function isPayEdition() {
  return PAY_MODE === true;
}

export function createPaySettings({ api, action, $, getModelContext, setMessage }) {
  if (!isPayEdition()) {
    return {
      enabled: false,
      async boot() {},
      apply() {},
      dispose() {},
    };
  }

  let menuOpen = false;

  function setOpen(open) {
    menuOpen = open;
    const menu = $("#account-menu");
    const btn = $("#account-btn");
    if (!menu || !btn) return;
    menu.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function renderChip(config = {}) {
    const pay = config.pay || {};
    const user = pay.user || null;
    const loggedIn = pay.logged_in === true && !!user?.email;
    const emailEl = $("#account-email");
    const quotaEl = $("#account-quota");
    const avatar = $("#account-avatar");
    const out = $("#account-logged-out");
    const inn = $("#account-logged-in");
    const detail = $("#account-detail");
    const menuStatus = $("#account-menu-status");
    if (!emailEl) return;

    if ($("#cloud-base") && config.cloud_base_url)
      $("#cloud-base").value = config.cloud_base_url || pay.base_url || "";
    if ($("#llm-mode"))
      $("#llm-mode").value = config.mode === "byok" ? "byok" : "hosted";

    const refreshBtn = $("#pay-refresh");
    if (loggedIn) {
      emailEl.textContent = user.email;
      quotaEl.textContent = `额度 ${user.quota_remaining}/${user.quota_total} · ${user.plan || "trial"}`;
      avatar.textContent = (user.email[0] || "U").toUpperCase();
      out.hidden = true;
      inn.hidden = false;
      detail.textContent = [
        user.enabled === false ? "已停用" : "可用",
        pay.cached ? "缓存中" : "已同步",
      ].join(" · ");
      if (refreshBtn) refreshBtn.hidden = false;
    } else {
      emailEl.textContent = "登录";
      quotaEl.textContent = "托管评分";
      avatar.textContent = "?";
      out.hidden = false;
      inn.hidden = true;
      if (refreshBtn) refreshBtn.hidden = true;
    }

    const ageSec =
      pay.fetched_at > 0
        ? Math.max(0, Math.round((Date.now() - pay.fetched_at) / 1000))
        : null;
    const lines = [
      `模式  ${config.mode || "hosted"}`,
      loggedIn
        ? `额度  ${user.quota_remaining}/${user.quota_total}`
        : "状态  未登录",
      ageSec == null
        ? ""
        : pay.cached
          ? `同步  ${ageSec}s 前`
          : "同步  刚刚",
      pay.error ? `提示  ${pay.error}` : "",
    ].filter(Boolean);
    if (menuStatus) menuStatus.textContent = lines.join("\n");

    const hosted = (config.mode || "hosted") === "hosted";
    if ($("#byok-hint")) {
      $("#byok-hint").textContent = hosted
        ? "当前托管模式使用云端公共 Key。仅在需要自备 Key 时切换到「高级 BYOK」并保存下方模型设置。"
        : "高级 BYOK：使用你自己的模型服务。Provider / Model / API Key 保存在本机。";
    }
  }

  async function refreshPay() {
    const result = await api({ type: "PAY_REFRESH" });
    return result;
  }

  function bind() {
    document.body.classList.add("pay-on");
    if ($("#edition-label"))
      $("#edition-label").textContent = "高级版 · 托管评分";

    $("#account-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      setOpen(!menuOpen);
    });
    document.addEventListener("click", (event) => {
      const chip = $("#account-chip");
      if (!chip || chip.contains(event.target)) return;
      setOpen(false);
    });

    $("#pay-request-link")?.addEventListener(
      "click",
      action(async () => {
        const result = await api({
          type: "PAY_REQUEST_LINK",
          email: $("#pay-email").value.trim(),
          base_url: $("#cloud-base")?.value.trim() || "",
        });
        if (result.login_url) {
          // Local stub: open callback so user can copy code immediately.
          window.open(result.login_url, "_blank", "noopener,noreferrer");
        }
        return result.message || "登录邮件已发送；请粘贴兑换码";
      }),
    );

    $("#pay-exchange")?.addEventListener(
      "click",
      action(async () => {
        await api({
          type: "PAY_EXCHANGE",
          code: $("#pay-code").value.trim(),
          base_url: $("#cloud-base")?.value.trim() || "",
        });
        $("#pay-code").value = "";
        const result = await refreshPay();
        renderChip({
          mode: result.mode,
          cloud_base_url: result.cloud_base_url,
          pay: result.pay,
        });
        setOpen(false);
        return "已登录";
      }),
    );

    $("#pay-logout")?.addEventListener(
      "click",
      action(async () => {
        await api({ type: "PAY_LOGOUT" });
        renderChip({ mode: "hosted", pay: { logged_in: false } });
        setOpen(false);
        return "已退出";
      }),
    );

    $("#pay-refresh")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const btn = $("#pay-refresh");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("spinning");
      try {
        const result = await refreshPay();
        renderChip({
          mode: result.mode,
          cloud_base_url: result.cloud_base_url,
          pay: result.pay,
        });
        setMessage?.("额度已同步");
      } catch (error) {
        setMessage?.(error.message || "同步失败");
      } finally {
        btn.classList.remove("spinning");
        btn.disabled = false;
      }
    });

    $("#pay-save-mode")?.addEventListener(
      "click",
      action(async () => {
        const ctx = getModelContext();
        await api({
          type: "PAY_SET_MODE",
          mode: $("#llm-mode").value,
          cloud_base_url: $("#cloud-base").value.trim(),
          model: ctx.model,
          base_url: ctx.base_url,
          api_key: ctx.api_key,
        });
        const result = await refreshPay();
        renderChip({
          mode: result.mode,
          cloud_base_url: result.cloud_base_url,
          pay: result.pay,
        });
        return "托管设置已保存";
      }),
    );
  }

  return {
    enabled: true,
    bind,
    apply(config) {
      renderChip(config);
    },
    async boot() {
      bind();
      try {
        const result = await refreshPay();
        renderChip({
          mode: result.mode,
          cloud_base_url: result.cloud_base_url,
          pay: result.pay,
        });
      } catch (error) {
        setMessage?.(error.message);
        renderChip({ pay: { logged_in: false, error: error.message } });
      }
    },
    dispose() {},
  };
}
