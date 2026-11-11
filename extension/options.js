import {
  catalogProviderById,
  defaultProviderModel,
  matchCatalogProvider,
  openAICompatibleProviders,
  providerModels,
} from "./llm-catalog.js";
import { parseBlacklist } from "./blacklist.js";

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
    if (input.value === draft) {
      input.value = saved.join(",");
      renderBlacklistTags(kind, saved);
      status.textContent = "已保存";
    }
  } catch (error) {
    status.textContent = `保存失败：${error.message}`;
  } finally {
    setBlacklistRemoveDisabled(kind, false);
  }
}

async function removeBlacklist(kind, term) {
  const { input, status, parse } = blacklistConfig(kind);
  const saved = parse(input.value).filter(
    (item) => item.toLowerCase() !== term.toLowerCase(),
  );
  status.textContent = "保存中…";
  await saveBlacklist(kind, saved);
}

const titleScreenBox = $("#title-screen");
const titleScreenStatus = $("#title-screen-status");
const renderTitleScreen = (enabled) => {
  titleScreenBox.checked = enabled;
  titleScreenBox.disabled = false;
  titleScreenStatus.textContent = enabled
    ? "已开启：标题不符的卡片会被跳过"
    : "已关闭：所有卡片直接采集评分";
};
chrome.storage.local
  .get("title_screen_enabled")
  .then(({ title_screen_enabled = false }) => renderTitleScreen(!!title_screen_enabled))
  .catch(() => {
    titleScreenStatus.textContent = "读取失败，可重新打开设置页";
  });
titleScreenBox.onchange = action(async () => {
  const enabled = await api({
    type: "SET_TITLE_SCREEN",
    enabled: titleScreenBox.checked,
  });
  renderTitleScreen(enabled);
  return enabled ? "标题预筛已开启" : "标题预筛已关闭";
});

$("#blacklist").oninput = () => {
  $("#blacklist-status").textContent = "保存中…";
  clearTimeout(blacklistSaveTimer);
  renderBlacklistTags("jd", parseBlacklist($("#blacklist").value));
  blacklistSaveTimer = setTimeout(() => saveBlacklist("jd"), 350);
};
$("#blacklist").onchange = () => saveBlacklist("jd");
$("#blacklist-tags").onclick = (event) => {
  const button = event.target.closest(".tag-remove");
  if (button) removeBlacklist("jd", button.dataset.term);
};
$("#company-blacklist").oninput = () => {
  $("#company-blacklist-status").textContent = "保存中…";
  clearTimeout(blacklistSaveTimer);
  renderBlacklistTags(
    "company",
    parseBlacklist($("#company-blacklist").value),
  );
  blacklistSaveTimer = setTimeout(() => saveBlacklist("company"), 350);
};
$("#company-blacklist").onchange = () => saveBlacklist("company");
$("#company-blacklist-tags").onclick = (event) => {
  const button = event.target.closest(".tag-remove");
  if (button) removeBlacklist("company", button.dataset.term);
};

function addOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function populateProviders() {
  const select = $("#provider");
  select.replaceChildren();
  addOption(select, "", "Custom");
  for (const provider of compatibleProviders)
    addOption(select, provider.id, provider.name);
}

function populateModels({
  selectedProvider,
  preferredModel = "",
  fallbackBaseUrl = "",
}) {
  const provider =
    selectedProvider || catalogProviderById(catalog, $("#provider").value);
  const models = providerModels(provider);
  const isCustom = !provider;
  $("#model").style.display = isCustom ? "none" : "";
  $("#model-custom").style.display = isCustom ? "" : "none";
  $("#model-custom").value = isCustom ? preferredModel || "" : "";
  const select = $("#model");
  select.replaceChildren();
  const values = new Set();
  for (const model of models) {
    if (values.has(model.id)) continue;
    values.add(model.id);
    addOption(
      select,
      model.id,
      model.name && model.name !== model.id
        ? `${model.name} · ${model.id}`
        : model.id,
    );
  }
  if (preferredModel && !values.has(preferredModel)) {
    const option = document.createElement("option");
    option.value = preferredModel;
    option.textContent = `${preferredModel} · current`;
    select.prepend(option);
    values.add(preferredModel);
  }
  if (!values.size) {
    addOption(select, "", "请选择 Provider 或配置 OPENAI_MODEL");
  } else {
    select.value = preferredModel || defaultProviderModel(provider);
  }
  // Catalog providers manage their own endpoint; Custom lets the user type one.
  $("#api-base").readOnly = !!provider;
  $("#api-base").value =
    provider?.baseUrl ||
    fallbackBaseUrl ||
    currentConfig.status?.base_url ||
    "";
}

const modelValue = () =>
  ($("#model").style.display === "none"
    ? $("#model-custom").value
    : $("#model").value
  ).trim();

function renderLLM(status = {}, apiKeyOverride = false) {
  const apiKey = $("#api-key");
  if (document.activeElement !== apiKey) apiKey.value = "";
  apiKey.placeholder = apiKeyOverride
    ? "已保存自定义 Key；输入新 Key 可覆盖"
    : status.api_key_configured
      ? ".env Key 已配置；输入可覆盖"
      : "输入 API Key，留空则使用 .env";
  const lines = [
    `HELPER  ${status.error ? "ERROR" : "READY"}`,
    `LLM     ${status.configured ? "READY" : "NOT CONFIGURED"}`,
    `OCR     ${status.ocr_ready ? "LOCAL / READY" : "LOCAL / NOT READY"}`,
    `MODEL   ${status.model || "未设置"}`,
  ];
  if (status.error) lines.push(`MESSAGE ${status.error}`);
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

async function refresh() {
  const state = await api({ type: "GET_STATE" });
  const config = await api({ type: "GET_LLM_CONFIG" });
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
    : `${state.profile?.name || ""} · ${state.profile?.version ? `v${state.profile.version.slice(0, 12)}` : "未导入"}`;
  applyConfiguration(config);
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
  $("#llm-status").textContent = "正在保存并向模型发送验证请求...";
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
      ? "设置已保存，Helper 与 LLM 配置可用"
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

try {
  await loadCatalog();
  await refresh();
  $("#token").value = (await api({ type: "GET_SESSION" })).helper_token || "";
} catch (error) {
  $("#message").textContent = error.message;
}
