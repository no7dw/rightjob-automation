import {
  catalogProviderById,
  defaultProviderModel,
  matchCatalogProvider,
  openAICompatibleProviders,
  providerModels,
} from "./llm-catalog.js";
import { parseBlacklist } from "./blacklist.js";
import { createPaySettings, isPayEdition } from "@jseeker/premium/options-pay.js";

const $ = (selector) => document.querySelector(selector);
const api = async (message) => {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展连接失败");
  return response.data;
};
const action = (fn) => async () => {
  try {
    $("#message").textContent = "处理中...";
    const message = await fn();
    $("#message").textContent =
      typeof message === "string" ? message : "已完成";
  } catch (error) {
    $("#message").textContent = error.message;
  }
};

let filename = "Wanted-CV.md";
let catalog = { providers: [] };
let compatibleProviders = [];
let currentConfig = {};
let blacklistSaveTimer;
let blacklistSavePromise = Promise.resolve();

const pay = createPaySettings({
  api,
  action,
  $,
  getModelContext: () => ({
    model: modelValue(),
    base_url: $("#api-base")?.value || "",
    api_key: $("#api-key")?.value.trim() || "",
  }),
  setMessage: (text) => {
    if ($("#message")) $("#message").textContent = text;
  },
});

const blacklistConfig = (kind) =>
  kind === "company"
    ? {
        input: $("#company-blacklist"),
        status: $("#company-blacklist-status"),
        tags: $("#company-blacklist-tags"),
        terms: (prefs) => prefs?.excluded_companies || [],
        parse: parseBlacklist,
        type: "SET_COMPANY_BLACKLIST",
        noun: "公司黑名单",
      }
    : {
        input: $("#blacklist"),
        status: $("#blacklist-status"),
        tags: $("#blacklist-tags"),
        terms: (prefs) => prefs?.excluded_terms || [],
        parse: parseBlacklist,
        type: "SET_BLACKLIST",
        noun: "JD 黑名单",
      };

function renderBlacklistTags(kind, terms = []) {
  const { tags, noun } = blacklistConfig(kind);
  tags.replaceChildren();
  if (!terms.length) {
    const empty = document.createElement("span");
    empty.className = "tag-empty";
    empty.textContent = "无黑名单";
    tags.append(empty);
    return;
  }
  for (const term of terms) {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.setAttribute("role", "listitem");
    tag.append(term);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tag-remove";
    remove.textContent = "×";
    remove.dataset.kind = kind;
    remove.dataset.term = term;
    remove.setAttribute("aria-label", `移除${noun}：${term}`);
    tag.append(remove);
    tags.append(tag);
  }
}

function setBlacklistRemoveDisabled(kind, disabled) {
  const { tags } = blacklistConfig(kind);
  for (const button of tags.querySelectorAll(".tag-remove"))
    button.disabled = disabled;
}

async function saveBlacklist(kind, overrideTerms = null) {
  const { input, status, tags, terms, parse, type } = blacklistConfig(kind);
  clearTimeout(blacklistSaveTimer);
  const draft = input.value;
  const keywords = overrideTerms || parse(draft);
  const pending = blacklistSavePromise
    .catch(() => {})
    .then(() => api({ type, keywords }));
  blacklistSavePromise = pending;
  setBlacklistRemoveDisabled(kind, true);
  try {
    const result = await pending;
    const saved = terms(result?.prefs || {});
    if (input.value === draft || overrideTerms) {
      input.value = saved.join(",");
      renderBlacklistTags(kind, saved);
      status.textContent = "已保存";
    }
    return result;
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
    throw error;
  } finally {
    setBlacklistRemoveDisabled(kind, false);
  }
}

function scheduleBlacklistSave(kind) {
  const { status } = blacklistConfig(kind);
  status.textContent = "保存中…";
  clearTimeout(blacklistSaveTimer);
  blacklistSaveTimer = setTimeout(() => {
    saveBlacklist(kind).catch(() => {});
  }, 400);
}

function modelValue() {
  const custom = $("#model-custom");
  if (custom && custom.style.display !== "none") return custom.value.trim();
  return ($("#model")?.value || "").trim();
}

function populateProviders() {
  const select = $("#provider");
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "选择 Provider";
  select.append(empty);
  for (const provider of compatibleProviders) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    select.append(option);
  }
}

function populateModels({
  selectedProvider,
  preferredModel = "",
  fallbackBaseUrl = "",
}) {
  const select = $("#model");
  const custom = $("#model-custom");
  select.replaceChildren();
  const provider =
    selectedProvider ||
    catalogProviderById(catalog, $("#provider").value) ||
    matchCatalogProvider(catalog, fallbackBaseUrl);
  const models = providerModels(provider);
  if (!models.length) {
    select.style.display = "none";
    custom.style.display = "";
    if (preferredModel) custom.value = preferredModel;
    return;
  }
  select.style.display = "";
  custom.style.display = "none";
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.append(option);
  }
  const pick =
    preferredModel && models.includes(preferredModel)
      ? preferredModel
      : defaultProviderModel(provider) || models[0];
  select.value = pick;
}

function renderLLM(status = {}, apiKeyOverride = false) {
  if (apiKeyOverride) $("#api-key").placeholder = "已保存覆盖 Key（留空保留）";
  else $("#api-key").placeholder = "输入 API Key，留空则使用 .env";
  const lines = [
    `SERVICE  ${status.error && !status.configured ? "异常" : status.configured || status.ocr_ready ? "已连接" : "未连接"}`,
    `LLM      ${status.configured ? "已配置" : "未配置"}`,
    `OCR      ${status.ocr_ready ? "本地可用" : "本地未就绪"}`,
    `MODEL    ${status.model || "未设置"}`,
  ];
  if (status.mode) lines.push(`MODE     ${status.mode}`);
  if (status.error) lines.push(`提示     ${status.error}`);
  $("#llm-status").textContent = lines.join("\n");
  $("#llm-status").classList.toggle("ok", !!status.configured);
  if (!$("#api-base").value) $("#api-base").value = status.base_url || "";
}

async function loadCatalog() {
  try {
    const response = await fetch(
      chrome.runtime.getURL("llm-provider-catalog.json"),
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = await response.json();
  } catch (error) {
    $("#message").textContent = `BYOK 目录读取失败：${error.message}`;
  }
  compatibleProviders = openAICompatibleProviders(catalog);
  populateProviders();
}

function applyConfiguration(config) {
  currentConfig = config;
  pay.apply(config);
  $("#reasoning-effort").value = config.reasoning_effort || "auto";
  const savedProvider = catalogProviderById(catalog, config.provider_id);
  const matched = matchCatalogProvider(
    catalog,
    config.base_url || config.status?.base_url || "",
  );
  const provider = savedProvider || matched || null;
  $("#provider").value = provider?.id || "";
  populateModels({
    selectedProvider: provider,
    preferredModel: config.model || config.status?.model || "",
    fallbackBaseUrl: config.base_url || config.status?.base_url || "",
  });
  renderLLM(config.status, config.api_key_override);
}

async function refresh({ refreshPay = false } = {}) {
  const state = await api({ type: "GET_STATE" });
  const config = await api({
    type: "GET_LLM_CONFIG",
    refresh_pay: refreshPay === true && isPayEdition(),
  });
  $("#cv").value = state.profile?.text || "";
  $("#blacklist").value = (state.prefs?.excluded_terms || []).join(",");
  $("#blacklist").disabled = false;
  renderBlacklistTags("jd", state.prefs?.excluded_terms);
  $("#blacklist-status").textContent = "已保存";
  $("#company-blacklist").value = (state.prefs?.excluded_companies || []).join(
    ",",
  );
  $("#company-blacklist").disabled = false;
  renderBlacklistTags("company", state.prefs?.excluded_companies);
  $("#company-blacklist-status").textContent = "已保存";
  $("#profile-meta").textContent = state.profile?.is_example
    ? "示例简历（请在下方导入你的简历）"
    : `${state.profile?.name || ""} · ${
        state.profile?.version
          ? `v${state.profile.version.slice(0, 12)}`
          : "未导入"
      }`;
  applyConfiguration(config);
}

function setupNav() {
  const links = [...document.querySelectorAll("#settings-nav a[data-sec]")];
  const items = links
    .map((link) => ({
      link,
      id: link.dataset.sec,
      section: document.getElementById(link.dataset.sec),
    }))
    .filter((item) => item.section && !item.section.hasAttribute("hidden"));

  // Scroll-spy must follow document Y order, not left-nav label order.
  function orderedItems() {
    return items
      .filter((item) => {
        const style = getComputedStyle(item.section);
        const linkStyle = getComputedStyle(item.link);
        return style.display !== "none" && linkStyle.display !== "none";
      })
      .sort(
        (a, b) =>
          a.section.getBoundingClientRect().top + window.scrollY -
          (b.section.getBoundingClientRect().top + window.scrollY),
      );
  }

  let activeId = "";
  let lockedId = "";
  let lockTimer = 0;

  function setActive(id, { force = false } = {}) {
    if (!id) return;
    if (!force && lockedId && id !== lockedId) return;
    if (id === activeId) return;
    activeId = id;
    for (const item of items)
      item.link.classList.toggle("active", item.id === id);
  }

  function topOffset() {
    const topbar = document.querySelector(".topbar");
    return (topbar?.getBoundingClientRect().height || 56) + 12;
  }

  function syncFromScroll() {
    const list = orderedItems();
    if (!list.length) return;
    const line = topOffset();
    let current = list[0].id;
    for (const item of list) {
      const top = item.section.getBoundingClientRect().top;
      if (top - line <= 2) current = item.id;
    }
    const scrollRoot = document.scrollingElement || document.documentElement;
    const atBottom =
      scrollRoot.scrollTop + window.innerHeight >= scrollRoot.scrollHeight - 8;
    if (atBottom) current = list[list.length - 1].id;
    setActive(current);
  }

  function scrollToSection(section) {
    const y =
      section.getBoundingClientRect().top + window.scrollY - topOffset() + 1;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  for (const item of items) {
    item.link.addEventListener("click", (event) => {
      event.preventDefault();
      lockedId = item.id;
      clearTimeout(lockTimer);
      setActive(item.id, { force: true });
      scrollToSection(item.section);
      history.replaceState(null, "", `#${item.id}`);
      // Keep highlight locked until smooth scroll finishes.
      lockTimer = window.setTimeout(() => {
        lockedId = "";
        syncFromScroll();
      }, 800);
    });
  }

  window.addEventListener("scroll", syncFromScroll, { passive: true });
  window.addEventListener("resize", syncFromScroll);
  const hashId = location.hash.replace(/^#/, "");
  if (hashId && items.some((item) => item.id === hashId)) {
    const target = items.find((item) => item.id === hashId);
    setActive(hashId, { force: true });
    requestAnimationFrame(() => scrollToSection(target.section));
  } else {
    syncFromScroll();
  }
}

$("#provider").onchange = () => {
  const provider = catalogProviderById(catalog, $("#provider").value);
  populateModels({
    selectedProvider: provider,
    preferredModel: "",
    fallbackBaseUrl:
      currentConfig.base_url || currentConfig.status?.base_url || "",
  });
};

$("#cv-file").onchange = action(async () => {
  const file = $("#cv-file").files[0];
  if (!file) return;
  if (file.size > 500_000) throw new Error("简历文件超过 500KB");
  filename = file.name;
  $("#cv").value = await file.text();
});

$("#save-cv").onclick = action(async () => {
  await api({ type: "CONFIG", cv: $("#cv").value, name: filename });
  await refresh();
});

$("#save-llm").onclick = action(async () => {
  $("#llm-status").textContent = "正在保存并验证模型配置…";
  $("#llm-status").classList.remove("ok");
  let status;
  try {
    status = await api({
      type: "CONFIG_LLM",
      provider_id: $("#provider").value,
      base_url: $("#api-base").value,
      model: modelValue(),
      reasoning_effort: $("#reasoning-effort").value,
      api_key: $("#api-key").value.trim(),
    });
  } catch (error) {
    renderLLM({ error: error.message });
    throw error;
  }
  currentConfig = {
    ...currentConfig,
    provider_id: $("#provider").value,
    base_url: $("#api-base").value,
    model: modelValue(),
    reasoning_effort: $("#reasoning-effort").value,
    api_key_override: status.api_key_override,
    status,
  };
  $("#api-key").value = "";
  renderLLM(status, status.api_key_override);
  return status.error
    ? `设置已保存，检查失败：${status.error}`
    : status.configured
      ? "设置已保存，本地服务与模型配置可用"
      : "设置已保存，LLM 尚未配置，请选择模型并检查 Base URL";
});

$("#save-token").onclick = action(async () => {
  await api({ type: "SET_TOKEN", token: $("#token").value.trim() });
  const status = await api({
    type: "LLM_STATUS",
    model: modelValue(),
    base_url: $("#api-base").value,
    api_key: $("#api-key").value.trim(),
  });
  currentConfig.status = status;
  applyConfiguration(currentConfig);
});

$("#refresh-status").onclick = action(async () => {
  await refresh({ refreshPay: isPayEdition() });
  return "状态已刷新";
});

$("#blacklist").addEventListener("input", () => scheduleBlacklistSave("jd"));
$("#company-blacklist").addEventListener("input", () =>
  scheduleBlacklistSave("company"),
);
document.addEventListener("click", (event) => {
  const button = event.target.closest(".tag-remove");
  if (!button) return;
  const kind = button.dataset.kind === "company" ? "company" : "jd";
  const { input, parse } = blacklistConfig(kind);
  const next = parse(input.value).filter((term) => term !== button.dataset.term);
  input.value = next.join(",");
  saveBlacklist(kind, next).catch(() => {});
});

function renderTitleScreen(enabled) {
  const box = $("#title-screen");
  const status = $("#title-screen-status");
  if (!box || !status) return;
  box.checked = !!enabled;
  box.disabled = false;
  status.textContent = enabled ? "已开启" : "已关闭";
}

$("#title-screen").onchange = action(async () => {
  const enabled = await api({
    type: "SET_TITLE_SCREEN",
    enabled: $("#title-screen").checked,
  });
  renderTitleScreen(enabled);
  return "标题预筛已更新";
});

try {
  await loadCatalog();
  await refresh({ refreshPay: false });
  $("#token").value = (await api({ type: "GET_SESSION" })).helper_token || "";
  const { title_screen_enabled = false } = await chrome.storage.local.get(
    "title_screen_enabled",
  );
  renderTitleScreen(!!title_screen_enabled);
  if (pay.enabled) await pay.boot();
  setupNav();
} catch (error) {
  $("#message").textContent = error.message;
  setupNav();
}
