import { isListPage, liepinIdentity, siteForURL, isBossChatURL, isBossBonusDetailURL } from "./sites.js";
import { LiepinCoordinator } from "./liepin-coordinator.js";
import {
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_PREFS,
  DEFAULT_WEIGHTS,
  cacheKey,
  jobId,
  hardFilter,
  normalizeJob,
  profileFromCV,
  ruleEvaluation,
  stableJSON,
  validateMatchThreshold,
  validatePrefs,
  validateSelectedCities,
  validateWeights,
  weightedScore,
} from "./core.js";
import { evidenceGet, evidencePut } from "./store.js";
import {
  failedJobs,
  isComplete,
  retryFailures,
  runCounts,
  unresolvedFlags,
  validateCheckpoint,
} from "./run-state.js";
import {
  normalizeLLMStatus,
  normalizeModelName,
  scoringInput,
  scoringHelperError,
  scoringVersion,
  validateLLMResult,
} from "./llm.js";
import { contactRecord, indexScore, jobFingerprint } from "./job-history.js";
import { createHelperClient } from "./helper-client.js";
import { bonusMessage, validateBonusMatches } from "./bonus-message.js";
import { AUTO_REPLY_MESSAGES, autoReplyState } from "./auto-reply-state.js";
import {
  applyRunBlacklist,
  companyBlacklistMatch,
  jobBlacklistMatch,
  parseBlacklist,
} from "./blacklist.js";

const HELPER_TIMEOUT_MS = 125000;
const isBoss = (url) => siteForURL(url) === "boss";
function logEvent(event, details = {}) {
  console.info(`[JSeeker][${event}]`, details);
  if (event.startsWith("timing:") || event.startsWith("content:timing:"))
    enqueueTiming({ event: event.replace(/^content:/, ""), ...details });
}
let timingEvents = [];
let timingFlush;
function enqueueTiming(event) {
  timingEvents.push(event);
  if (timingFlush) return;
  timingFlush = setTimeout(async () => {
    timingFlush = null;
    const events = timingEvents.splice(0, 100);
    try {
      const s = await chrome.storage.local.get(["helper_port", "timing_instance_id"]);
      const port = Number.isInteger(s.helper_port) ? s.helper_port : 17373;
      const response = await helperRequest(port, "/timing", { events: events.map((e) => ({ ...e, instance_id: s.timing_instance_id })) }, AbortSignal.timeout(5000));
      await response.body?.cancel().catch(() => {});
    } catch { /* Telemetry must never interrupt a job. */ }
    if (timingEvents.length) { const next = timingEvents.shift(); enqueueTiming(next); }
  }, 100);
}
function safeLogDetails(details) {
  if (!details || typeof details !== "object") return {};
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) =>
        ["string", "number", "boolean"].includes(typeof value),
      )
      .map(([key, value]) => [
        key,
        typeof value === "string" ? value.slice(0, 500) : value,
      ]),
  );
}

let ready;
function initialSelectedCities(value) {
  try {
    return validateSelectedCities(value);
  } catch {
    return ["深圳"];
  }
}
async function initialize() {
  if (typeof chrome.storage.local.setAccessLevel === "function")
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  const s = await chrome.storage.local.get([
    "profile",
    "weights",
    "prefs",
    "run_target",
    "match_threshold",
    "selected_cities",
    "job_index",
    "contacted_jobs",
    "llm_model",
    "llm_reasoning_effort",
    "llm_base_url",
    "llm_provider_id",
    "llm_api_key_override",
    "allow_bonus_message",
    "auto_send_bonus_message",
    "timing_instance_id",
  ]);
  if (!s.profile) {
    // A real CV is machine-local (profile.local.json, gitignored and copied
    // into dist only when present). Committed builds fall back to a
    // synthetic example that contains no personal data.
    const loadProfile = async (path) => {
      try {
        const response = await fetch(chrome.runtime.getURL(path));
        return response.ok ? await response.json() : null;
      } catch {
        return null;
      }
    };
    const seed =
      (await loadProfile("profile.local.json")) ||
      (await loadProfile("profile.example.json"));
    if (seed) await chrome.storage.local.set({ profile: seed });
  }
  await chrome.storage.local.set({
    weights: s.weights || DEFAULT_WEIGHTS,
    prefs: validatePrefs(s.prefs || DEFAULT_PREFS),
    run_target:
      Number.isSafeInteger(s.run_target) && s.run_target >= 1
        ? s.run_target
        : 10,
    match_threshold: Number.isFinite(s.match_threshold)
      ? validateMatchThreshold(s.match_threshold)
      : DEFAULT_MATCH_THRESHOLD,
    selected_cities: initialSelectedCities(s.selected_cities),
    job_index: s.job_index || {},
    contacted_jobs: s.contacted_jobs || {},
    allow_bonus_message: s.allow_bonus_message === true,
    auto_send_bonus_message: s.auto_send_bonus_message === true,
    timing_instance_id: s.timing_instance_id || crypto.randomUUID(),
    llm_model: normalizeModelName(s.llm_model),
    llm_reasoning_effort: ["auto", "default", "low"].includes(s.llm_reasoning_effort) ? s.llm_reasoning_effort : "auto",
    llm_base_url:
      typeof s.llm_base_url === "string"
        ? s.llm_base_url.trim().replace(/\/+$/, "")
        : "",
    llm_provider_id:
      typeof s.llm_provider_id === "string" ? s.llm_provider_id : "",
    llm_api_key_override:
      typeof s.llm_api_key_override === "string" ? s.llm_api_key_override : "",
  });
}
ready = initialize();

let mutations = Promise.resolve();
const helperRequest = createHelperClient(chrome.storage);
function serial(fn) {
  const next = mutations.then(fn);
  mutations = next.catch(() => {});
  return next;
}

async function localRequest(path, body = {}, signal = null) {
  const { helper_port, timing_instance_id } = await chrome.storage.local.get(["helper_port", "timing_instance_id"]);
  const port =
    Number.isInteger(helper_port) && helper_port > 0 && helper_port <= 65535
      ? helper_port
      : 17373;
  const started = Date.now();
  const timing = { ...body.timing, instance_id: timing_instance_id, request_id: crypto.randomUUID() };
  body = { ...body, timing };
  const timed = ["/screen", "/evaluate", "/model", "/ocr"].includes(path);
  const record = (status) => {
    if (timed) logEvent("timing:request", { ...timing, path, phase: path.slice(1), status,
      started_at: new Date(started).toISOString(), ended_at: new Date().toISOString(), elapsed_ms: Date.now() - started });
  };
  const details = {
    path,
    model: typeof body.model === "string" ? body.model : "",
    job_id: typeof body.job?.job_id === "string" ? body.job.job_id : "",
    prompt_chars:
      typeof body.job?.jd === "string" && typeof body.profile?.text === "string"
        ? body.job.jd.length + body.profile.text.length
        : undefined,
  };
  logEvent("helper:start", { ...details, elapsed_s: 0 });
  const heartbeat = setInterval(() => {
    // Console output alone does not keep an MV3 worker alive while inference
    // is waiting. Use an extension API until the request finishes.
    chrome.runtime.getPlatformInfo().catch(() => {});
    logEvent("helper:waiting", { ...details, elapsed_ms: Date.now() - started,
      elapsed_s: Math.round((Date.now() - started) / 100) / 10 });
  }, 10000);
  let response;
  try {
    response = await helperRequest(
      port,
      path,
      body,
      signal
        ? AbortSignal.any([signal, AbortSignal.timeout(HELPER_TIMEOUT_MS)])
        : AbortSignal.timeout(HELPER_TIMEOUT_MS),
    );
  } catch (error) {
    record("transport_error");
    clearInterval(heartbeat);
    logEvent("helper:error", {
      ...details,
      elapsed_ms: Date.now() - started,
      elapsed_s: Math.round((Date.now() - started) / 100) / 10,
      error: error.message,
    });
    if (error.name === "TimeoutError" || error.name === "AbortError")
      throw new Error("本地服务请求超时，请确认服务仍在运行，并检查模型网络。");
    throw error;
  }
  clearInterval(heartbeat);
  const data = await response.json().catch(() => ({}));
  record(response.status);
  logEvent(response.ok ? "helper:done" : "helper:error", {
    ...details,
    elapsed_ms: Date.now() - started,
    elapsed_s: Math.round((Date.now() - started) / 100) / 10,
    status: response.status,
    error: response.ok ? undefined : data.error,
  });
  if (!response.ok)
    throw Object.assign(new Error(data.error || `本地服务 HTTP ${response.status}`), { status: response.status });
  return data;
}

async function safeLLMStatus(
  model = "",
  baseUrl = "",
  apiKeyOverride = "",
  verify = false,
  reasoningEffort = "auto",
) {
  const requested = normalizeModelName(model);
  try {
    const health = await localRequest("/health");
    const resolved = await localRequest("/model", {
      model: requested,
      reasoning_effort: reasoningEffort,
      base_url: baseUrl,
      ...(verify
        ? { verify: true, api_key: String(apiKeyOverride || "") }
        : {}),
    });
    const promptError = await scoringHelperError(resolved);
    return normalizeLLMStatus({
      configured: resolved.configured && !promptError,
      model: resolved.model || health.llm?.model || "",
      model_version: resolved.version || "",
      base_url: resolved.base_url || health.llm?.base_url || "",
      api_key_configured:
        health.llm?.api_key_configured === true || !!apiKeyOverride,
      api_key_override: !!apiKeyOverride,
      ocr_ready: health.ocr_ready === true,
      error: promptError || resolved.error,
    });
  } catch (error) {
    return normalizeLLMStatus({ error: error.message });
  }
}

async function notifyJobTabs(message) {
  const tabs = await chrome.tabs.query({
    url: [
      "https://www.zhipin.com/web/geek/jobs*",
      "https://zhipin.com/web/geek/jobs*",
      "https://c.liepin.com/*",
    ],
  });
  await Promise.allSettled(
    tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message)),
  );
}

async function screenshot(sender, message) {
  const tab = sender.tab;
  if (!tab || !isBoss(sender.url))
    throw new Error("截图只允许当前 BOSS 职位页面");
  const [active] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  const win = await chrome.windows.get(tab.windowId);
  if (active?.id !== tab.id || !win.focused)
    throw new Error("请将 BOSS 标签页保持在前台");
  const r = message.rect;
  if (
    !r ||
    ["x", "y", "width", "height", "viewportWidth", "viewportHeight"].some(
      (k) => !Number.isFinite(r[k]),
    ) ||
    r.x < 0 ||
    r.y < 0 ||
    r.width < 1 ||
    r.height < 1 ||
    r.viewportWidth > 20000 ||
    r.viewportHeight > 20000 ||
    r.x + r.width > r.viewportWidth + 1 ||
    r.y + r.height > r.viewportHeight + 1
  )
    throw new Error("无效截图区域");
  const { capture_at = 0 } = await chrome.storage.session.get("capture_at");
  const wait = Math.max(0, 750 - (Date.now() - capture_at));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  await chrome.storage.session.set({ capture_at: Date.now() });
  const info = await chrome.tabs.sendMessage(tab.id, {
    type: "VERIFY_ID",
    job_id: message.job_id,
  });
  if (!info?.ok) throw new Error("截图时职位关联已改变");
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  const [after] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  if (after?.id !== tab.id) throw new Error("截图期间标签页已改变");
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  const sx = bitmap.width / r.viewportWidth,
    sy = bitmap.height / r.viewportHeight;
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(r.width * sx)),
    Math.max(1, Math.round(r.height * sy)),
  );
  canvas
    .getContext("2d")
    .drawImage(
      bitmap,
      r.x * sx,
      r.y * sy,
      r.width * sx,
      r.height * sy,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/png" }),
    bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const png = btoa(binary),
    id = crypto.randomUUID();
  await evidencePut(id, {
    job_id: message.job_id,
    kind: message.kind,
    page: message.page,
    created_at: new Date().toISOString(),
    image: `data:image/png;base64,${png}`,
    rect: r,
  });
  return { evidence_id: id };
}

async function processOCR(message) {
  if (
    !message ||
    typeof message.evidence_id !== "string" ||
    !message.evidence_id
  )
    throw new Error("无效 OCR 证据");
  const evidence = await evidenceGet(message.evidence_id);
  if (!evidence?.image?.startsWith("data:image/png;base64,"))
    throw new Error("OCR 截图不存在");
  const image = evidence.image.split(",", 2)[1];
  let result;
  try {
    result = await localRequest("/ocr", { image });
  } catch (error) {
    return {
      evidence_id: message.evidence_id,
      text: "",
      blocks: [],
      error: error.message,
    };
  }
  await evidencePut(message.evidence_id, { ...evidence, ocr: result });
  return { ...result, evidence_id: message.evidence_id };
}

function effectiveJob(raw, run) {
  const fix = run.corrections?.[raw.job_id];
  return normalizeJob(
    fix
      ? {
          ...raw,
          jd_raw: fix.jd || raw.jd_raw,
          field_sources: {
            ...raw.field_sources,
            ...Object.fromEntries(
              ["title", "company", "salary", "location", "jd"]
                .filter((key) => fix[key])
                .map((key) => [key, "human"]),
            ),
          },
          corrections: {
            ...raw.corrections,
            ...(fix.salary ? { salary: fix.salary } : {}),
            ...(fix.title ? { title: fix.title } : {}),
            ...(fix.company ? { company: fix.company } : {}),
            ...(fix.location ? { location: fix.location } : {}),
          },
          quality_flags: [
            ...(raw.quality_flags || []),
            ...(fix.jd ? ["human_corrected_jd"] : []),
          ],
          extraction_status: fix.jd ? "success" : raw.extraction_status,
        }
      : raw,
  );
}

// These maps grow one entry per scored job; without a cap they eventually
// exceed chrome.storage quota and every write starts failing.
function pruneIndexed(map, cap = 2000) {
  const entries = Object.entries(map || {});
  if (entries.length <= cap) return map || {};
  entries.sort((a, b) =>
    (a[1]?.scored_at || "").localeCompare(b[1]?.scored_at || ""),
  );
  return Object.fromEntries(entries.slice(entries.length - cap));
}

async function screenTitles(titles, signal, timing = {}) {
  const s = await chrome.storage.local.get([
    "profile",
    "llm_model",
    "llm_reasoning_effort",
    "llm_base_url",
    "llm_provider_id",
    "llm_api_key_override",
    "llm_model_version",
    "job_index",
    "match_threshold",
  ]);
  if (!s.profile) throw new Error("请先导入简历");
  const threshold = s.match_threshold ?? 75;
  const valid = Object.values(s.job_index || {}).filter(
    (entry) =>
      entry?.score_status === "valid" &&
      typeof entry.score === "number" &&
      entry.title,
  );
  const good = valid
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((entry) => entry.title);
  const bad = valid
    .filter((entry) => entry.score < threshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((entry) => entry.title);
  const data = await localRequest(
    "/screen",
    {
      titles,
      profile_text: s.profile.text || "",
      good,
      bad,
      model: s.llm_model || "",
      reasoning_effort: s.llm_reasoning_effort || "auto",
      base_url: s.llm_base_url || "",
      api_key: s.llm_api_key_override || "",
      timing: { ...timing, site: "liepin", job_id: titles[0]?.id || "" },
    },
    signal,
  );
  logEvent("screen:done", {
    requested: titles.length,
    open: data.results.filter((entry) => entry.open).length,
  });
  return data.results;
}

async function scoreOne(id, engine = "llm", timing = {}) {
  const scoringStarted = Date.now();
  logEvent("score:start", { job_id: id, engine });
  const s = await chrome.storage.local.get([
    "run",
    "profile",
    "prefs",
    "weights",
    "llm_model",
    "llm_reasoning_effort",
    "llm_base_url",
    "llm_provider_id",
    "llm_api_key_override",
    "evaluation_cache",
    "job_index",
    "contacted_jobs",
  ]);
  if (!s.run || !s.profile) throw new Error("请先采集职位并导入简历");
  if (s.run.status === "running") throw new Error("请先暂停采集后评分");
  const raw = s.run.jobs.find((job) => job.job_id === id);
  if (!raw) throw new Error("职位不存在");
  timing = { ...timing, trace_id: timing.trace_id || crypto.randomUUID(), site: raw.source || "boss", run_id: s.run.id, job_id: id };
  const blacklistKeyword = jobBlacklistMatch(
    raw,
    s.prefs?.excluded_terms,
    s.run,
  );
  const companyBlacklistKeyword = companyBlacklistMatch(
    raw,
    s.prefs?.excluded_companies,
    s.run,
  );
  if (blacklistKeyword || companyBlacklistKeyword)
    return { skipped: true, keyword: companyBlacklistKeyword || blacklistKeyword };
  if (!isComplete(raw, s.run)) throw new Error("JD 不完整，无法评分");
  const job = effectiveJob(raw, s.run);
  let model = "rules-v1",
    modelVersion = "";
  if (engine === "llm") {
    const meta = await localRequest("/model", {
      model: normalizeModelName(s.llm_model),
      reasoning_effort: s.llm_reasoning_effort || "auto",
      base_url: s.llm_base_url || "",
      timing,
    });
    if (!meta.configured) throw new Error("LLM 未配置模型");
    const promptError = await scoringHelperError(meta);
    if (promptError) throw new Error(promptError);
    model = meta.model;
    modelVersion = meta.version;
    logEvent("score:model", { job_id: id, model });
  }
  const fingerprint = await jobFingerprint(job);
  const version = scoringVersion(modelVersion || model, s.profile.version);
  const key = await cacheKey(job, s.profile, s.prefs, version);
  const cache = s.evaluation_cache || {};
  let evaluation = cache[key];
  logEvent("score:cache", { job_id: id, hit: !!evaluation });
  logEvent("timing:cache", { ...timing, phase: "score_cache", cache_hit: !!evaluation, elapsed_ms: 0 });
  if (!evaluation) {
    if (engine === "llm") {
      const value = await localRequest("/evaluate", {
        ...scoringInput(job, s.profile, s.prefs),
        model,
        reasoning_effort: s.llm_reasoning_effort || "auto",
        base_url: s.llm_base_url || "",
        api_key: s.llm_api_key_override || "",
        timing,
      });
      evaluation = validateLLMResult(value, { jd: job.jd, profileText: s.profile.text });
      evaluation.model = model;
      evaluation.model_version = modelVersion;
    } else {
      evaluation = ruleEvaluation(job, s.profile, s.prefs);
    }
    cache[key] = evaluation;
  }
  const flags = unresolvedFlags(job, s.run);
  const scored =
    engine === "llm"
      ? {
          ...evaluation,
          job_id: id,
          profile_version: s.profile.version,
          evaluation_key: key,
          scored_at: new Date().toISOString(),
          coverage: 1,
          eligibility: hardFilter(job, s.prefs),
          needs_review:
            flags.length > 0 || evaluation.requirements_status === "unknown",
          model,
          model_version: modelVersion,
        }
      : {
          ...weightedScore(
            evaluation,
            s.weights,
            hardFilter(job, s.prefs),
            flags,
          ),
          job_id: id,
          profile_version: s.profile.version,
          evaluation_key: key,
          scored_at: new Date().toISOString(),
        };
  return serial(async () => {
    const latest = await chrome.storage.local.get([
      "run",
      "profile",
      "prefs",
      "weights",
      "job_index",
      "contacted_jobs",
    ]);
    if (
      latest.run?.id !== s.run.id ||
      latest.profile?.version !== s.profile.version ||
      stableJSON(latest.prefs) !== stableJSON(s.prefs) ||
      JSON.stringify(latest.run.corrections?.[id]) !==
        JSON.stringify(s.run.corrections?.[id])
    )
      throw new Error("评分期间数据发生变化，请重新运行");
    latest.run.scores[id] = scored;
    if (latest.run.score_failures) delete latest.run.score_failures[id];
    latest.run.profile_snapshot = s.profile;
    latest.run.weights_snapshot = s.weights;
    latest.run.preferences_snapshot = s.prefs;
    const jobIndex =
      engine === "llm"
        ? indexScore({
            index: latest.job_index || {},
            raw: job,
            score: scored,
            fingerprint,
            profileVersion: s.profile.version,
            model,
            modelVersion,
            scoringVersion: version,
            contacted: !!latest.contacted_jobs?.[id],
          })
        : latest.job_index || {};
    await chrome.storage.local.set({
      run: latest.run,
      evaluation_cache: pruneIndexed(cache),
      job_index: pruneIndexed(jobIndex),
    });
    logEvent("score:done", {
      job_id: id,
      engine,
      match_score: scored.match_score,
      elapsed_ms: Date.now() - scoringStarted,
      elapsed_s: Math.round((Date.now() - scoringStarted) / 100) / 10,
    });
    return scored;
  });
}

function bossReviewOwner(review, sender) {
  if (review?.site !== "boss" || !sender.tab) return false;
  return sender.tab.id === review.parent_tab || sender.tab.id === review.detail_tab ||
    sender.tab.id === review.chat_tab ||
    (review.chat_tab == null && review.detail_tab != null && sender.tab.openerTabId === review.detail_tab);
}

async function bossParentScopeOK(review, run) {
  const answer = await chrome.tabs.sendMessage(review.parent_tab, {
    type: "BOSS_VERIFY_BONUS_SCOPE", run_id: run.id, job_id: review.job_id,
  }).catch(() => null);
  return answer?.ok === true;
}

async function handle(message, sender) {
  await ready;
  const own = sender.url?.startsWith(chrome.runtime.getURL("")) === true;
  const liepinDetail = !!liepinIdentity(sender.url);
  let bossChat = isBossChatURL(sender.url);
  const bossChatMessage = AUTO_REPLY_MESSAGES.has(message?.type) || ["BOSS_BONUS_CHAT_READY", "BOSS_BONUS_DRAFT_RESULT", "BOSS_RETURN_BONUS_LIST", "BOSS_BONUS_AUTHORIZE_SEND"].includes(message?.type);
  const liepinAutoReadMessage = ["GET_LIEPIN_AUTO_READ_STATE", "SET_LIEPIN_AUTO_READ"].includes(message?.type);
  const bossDetail = isBossBonusDetailURL(sender.url);
  const bossDetailMessage = bossChatMessage || ["BOSS_BONUS_DETAIL_READY", "BOSS_BONUS_AUTHORIZE_CONTACT", "BOSS_BONUS_CONTACTED"].includes(message?.type);
  if (bossDetail && !bossDetailMessage) throw new Error("职位详情页无权执行此操作");
  // BOSS can route a list document into chat without loading a new document.
  // Verify the current browser URL as well as the original message sender URL.
  if (!bossChat && bossChatMessage && sender.tab && isBoss(sender.url)) {
    const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
    bossChat = isBossChatURL(tab?.url);
  }
  if (bossChat && !bossChatMessage)
    throw new Error("聊天页无权执行此操作");
  if (liepinDetail && !["LIEPIN_AUTHORIZE_CONTACT", "LIEPIN_AUTHORIZE_BONUS_SEND"].includes(message?.type) && !liepinAutoReadMessage)
    throw new Error("详情页无权执行此操作");
  if (!own && (!sender.tab || (!isListPage(sender.url) && !liepinDetail && !bossChat && !bossDetail)))
    throw new Error("消息来源不受信任");
  if (!message || typeof message.type !== "string") throw new Error("无效消息");

  switch (message.type) {
    case "GET_BOSS_AUTO_REPLY_STATE":
    case "BOSS_AUTO_REPLY_CLAIM":
    case "BOSS_AUTO_REPLY_AUTHORIZE_SEND":
      if (!own && !isBoss(sender.url)) throw new Error("仅限 BOSS 页面");
      if (["BOSS_AUTO_REPLY_CLAIM", "BOSS_AUTO_REPLY_AUTHORIZE_SEND"].includes(message.type) && !bossChat)
        throw new Error("仅限 BOSS 聊天页");
      return serial(() => autoReplyState(chrome.storage.local, message, sender));
    case "SET_AUTO_REPLY_MESSAGES": {
      if (!own && !isBoss(sender.url)) throw new Error("仅限 BOSS 页面");
      const enabled = await serial(() => autoReplyState(chrome.storage.local, message, sender));
      const tabs = await chrome.tabs.query({ url: ["https://www.zhipin.com/web/geek/*", "https://zhipin.com/web/geek/*"] });
      await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "AUTO_REPLY_MESSAGES_CHANGED", enabled }).catch(() => {})));
      return enabled;
    }
    case "GET_LIEPIN_AUTO_READ_STATE":
      return { enabled: (await chrome.storage.local.get("liepin_auto_read_enabled")).liepin_auto_read_enabled === true, busy: false };
    case "SET_LIEPIN_AUTO_READ": {
      if (!liepinAutoReadMessage || typeof message.enabled !== "boolean") throw new Error("无效的猎聘自动已读开关");
      await chrome.storage.local.set({ liepin_auto_read_enabled: message.enabled });
      return message.enabled;
    }
    case "LIEPIN_BEGIN":
      return liepin.begin(sender, message.scope, message.target);
    case "LIEPIN_PROCESS":
      return liepin.process(sender, message);
    case "LIEPIN_PAUSE":
      return liepin.pause(sender, message.reason);
    case "LIEPIN_FINISH":
      return liepin.finish(sender, message.status, message.reason);
    case "LIEPIN_AUTHORIZE_CONTACT":
      return liepin.authorize(sender, message);
    case "LIEPIN_AUTHORIZE_BONUS_SEND":
      return liepin.authorizeBonusSend(sender, message);
    case "LIEPIN_CONFIRM_BONUS_REVIEW":
      return liepin.confirmBonusReview(sender, message);
    case "BOSS_OPEN_BONUS_CHAT":
      return serial(async () => {
        const { run, profile } = await chrome.storage.local.get(["run", "profile"]);
        const review = run?.bonus_review;
        if (!sender.tab || !isBoss(sender.url) || !isListPage(sender.url) ||
            review?.site !== "boss" || review.parent_tab !== sender.tab.id ||
            run.id !== message.run_id || review.job_id !== message.job_id ||
            review.profile_version !== profile?.version)
          throw new Error("加分项草稿任务已失效");
        if (!isBossBonusDetailURL(review.detail_url) || jobId(review.detail_url) !== review.job_id)
          throw new Error("加分项职位链接无效");
        let tab = review.chat_tab ?? review.detail_tab;
        tab = tab == null ? null : await chrome.tabs.get(tab).catch(() => null);
        if (tab && (isBossChatURL(tab.url) || isBossBonusDetailURL(tab.url))) {
          await chrome.tabs.update(tab.id, { active: true });
          return true;
        }
        // Ownership is durable before the site's detail script starts. Neither
        // the initial greeting nor Continue Chat is clicked in the result list.
        const detail = await chrome.tabs.create({ url: "about:blank", active: false,
          openerTabId: sender.tab.id, windowId: sender.tab.windowId });
        review.detail_tab = detail.id;
        review.direct_entry = true;
        await chrome.storage.local.set({ run });
        await chrome.tabs.update(detail.id, { url: review.detail_url, active: true });
        return true;
      });
    case "BOSS_BONUS_DETAIL_READY":
      return serial(async () => {
        const { run, profile, auto_send_bonus_message } = await chrome.storage.local.get(["run", "profile", "auto_send_bonus_message"]);
        const review = run?.bonus_review;
        if (!bossDetail || review?.detail_tab !== sender.tab?.id ||
            jobId(sender.url) !== review.job_id || review.profile_version !== profile?.version) return null;
        return { run_id: run.id, job_id: review.job_id, message: review.message,
          existing_contact: review.existing_contact === true,
          contact_attempted: review.contact_attempted === true,
          continue_attempted: review.continue_attempted === true,
          send_attempted: review.send_attempted === true,
          direct_entry: true, auto_send: auto_send_bonus_message === true };
      });
    case "BOSS_BONUS_AUTHORIZE_CONTACT":
    case "BOSS_BONUS_CONTACTED":
      return serial(async () => {
        const { run, profile, allow_bonus_message, contacted_jobs = {}, job_index = {} } = await chrome.storage.local.get(["run", "profile", "allow_bonus_message", "contacted_jobs", "job_index"]);
        const review = run?.bonus_review;
        if (!bossDetail || review?.detail_tab !== sender.tab?.id ||
            jobId(sender.url) !== review.job_id || run.id !== message.run_id ||
            review.job_id !== message.job_id || review.profile_version !== profile?.version ||
            allow_bonus_message !== true) return false;
        if (message.type === "BOSS_BONUS_CONTACTED") {
          if (!review.contact_attempted) return false;
          for (const record of [run.applications[review.job_id], contacted_jobs[review.job_id]])
            if (record) record.status = "contact_opened";
          await chrome.storage.local.set({ run, contacted_jobs });
          return true;
        }
        if (review.send_attempted || !await bossParentScopeOK(review, run)) return false;
        if (message.intent === "initial") {
          if (review.contact_attempted || review.existing_contact) return false;
          review.contact_attempted = true;
        } else if (message.intent === "continue") {
          if (review.continue_attempted) return false;
          review.continue_attempted = true;
        } else return false;
        if (!contacted_jobs[review.job_id] && review.contact_record) {
          const status = message.intent === "initial" ? "opening" : "already_contacted";
          contacted_jobs[review.job_id] = { ...review.contact_record, status,
            bonus_draft: run.applications[review.job_id].bonus_draft };
          run.applications[review.job_id].status = status;
          if (job_index[review.job_id]) job_index[review.job_id].contacted = true;
        }
        await chrome.storage.local.set({ run, contacted_jobs, job_index });
        return true;
      });
    case "BOSS_BONUS_CHAT_READY":
      return serial(async () => {
        const { run, profile, auto_send_bonus_message } =
          await chrome.storage.local.get(["run", "profile", "auto_send_bonus_message"]);
        const review = run?.bonus_review;
        if (!bossChat || !bossReviewOwner(review, sender) || sender.tab.id === review.parent_tab ||
            review.detail_tab == null || review.profile_version !== profile?.version) return null;
        review.chat_tab = sender.tab.id;
        await chrome.storage.local.set({ run });
        return { run_id: run.id, job_id: review.job_id, message: review.message,
          contact: review.contact, title: review.title,
          direct_entry: review.direct_entry === true,
          auto_send: auto_send_bonus_message === true,
          send_attempted: review.send_attempted === true };
      });
    case "BOSS_BONUS_AUTHORIZE_SEND":
      return serial(async () => {
        const { run, profile, allow_bonus_message, auto_send_bonus_message, contacted_jobs = {} } =
          await chrome.storage.local.get(["run", "profile", "allow_bonus_message", "auto_send_bonus_message", "contacted_jobs"]);
        const review = run?.bonus_review;
        if (!bossReviewOwner(review, sender) || sender.tab.id === review.parent_tab || run.id !== message.run_id || review.job_id !== message.job_id ||
            review.profile_version !== profile?.version || review.send_attempted ||
            allow_bonus_message !== true || auto_send_bonus_message !== true) return false;
        if (!await bossParentScopeOK(review, run)) return false;
        review.send_attempted = true;
        for (const record of [run.applications[review.job_id], contacted_jobs[review.job_id]])
          if (record?.bonus_draft) record.bonus_draft.status = "sending";
        await chrome.storage.local.set({ run, contacted_jobs });
        return true;
      });
    case "BOSS_BONUS_PENDING": {
      const { run } = await chrome.storage.local.get("run");
      if (!sender.tab || !isBoss(sender.url) || !isListPage(sender.url) || run?.id !== message.run_id)
        throw new Error("加分项草稿批次已变化");
      return run.bonus_review?.job_id === message.job_id;
    }
    case "BOSS_BONUS_DRAFT_RESULT":
      return serial(async () => {
        const { run, contacted_jobs = {} } = await chrome.storage.local.get(["run", "contacted_jobs"]);
        if (!bossReviewOwner(run?.bonus_review, sender) || run.id !== message.run_id ||
            run.bonus_review.job_id !== message.job_id)
          throw new Error("加分项草稿任务已失效");
        const statuses = ["prepared", "already_prepared", "existing_draft", "editor_missing", "ambiguous_editor", "ambiguous_chat", "identity_unverified", "editor_error", "editor_timeout", "editor_interrupted", "sent", "send_unconfirmed", "send_button_missing", "send_error"];
        if (!statuses.includes(message.status)) throw new Error("无效草稿状态");
        if (["sent", "send_unconfirmed"].includes(message.status) && !run.bonus_review.send_attempted)
          throw new Error("加分项消息未获发送授权");
        const status = run.bonus_review.send_attempted && message.status !== "sent" ? "send_unconfirmed" : message.status;
        for (const record of [run.applications[message.job_id], contacted_jobs[message.job_id]])
          if (record?.bonus_draft) record.bonus_draft.status = status;
        // Bonus preparation is optional. Keep its result for review, but never
        // require a manual checkpoint or block the next job on a draft failure.
        const review = run.bonus_review;
        delete run.bonus_review;
        run.stop_reason = null;
        await chrome.storage.local.set({ run, contacted_jobs });
        const parent = await chrome.tabs.get(review.parent_tab).catch(() => null);
        if (parent && isListPage(parent.url) && isBoss(parent.url)) {
          await chrome.tabs.update(parent.id, { active: true });
          if (parent.windowId != null)
            await chrome.windows.update(parent.windowId, { focused: true }).catch(() => {});
        }
        const close = status === "sent" ? [review.chat_tab, review.detail_tab]
          : review.chat_tab != null && review.chat_tab !== review.detail_tab ? [review.detail_tab] : [];
        for (const id of new Set(close)) {
          if (id == null || id === review.parent_tab) continue;
          await chrome.tabs.remove(id).catch(() => {});
        }
        return true;
      });
    case "BOSS_RETURN_BONUS_LIST":
      return serial(async () => {
        const { run } = await chrome.storage.local.get("run");
        const review = run?.bonus_review;
        if (!bossChat || !bossReviewOwner(review, sender) || run.id !== message.run_id || review.job_id !== message.job_id)
          throw new Error("加分项草稿任务已失效");
        const parent = await chrome.tabs.get(review.parent_tab).catch(() => null);
        if (parent && isListPage(parent.url) && isBoss(parent.url))
          await chrome.tabs.update(parent.id, { active: true });
        else return false;
        return true;
      });
    case "BOSS_CONFIRM_BONUS_REVIEW":
      return serial(async () => {
        const { run, contacted_jobs = {} } = await chrome.storage.local.get(["run", "contacted_jobs"]);
        const review = run?.bonus_review;
        if (!sender.tab || !isBoss(sender.url) || !isListPage(sender.url) || review?.site !== "boss" ||
            run.id !== message.run_id || review.job_id !== message.job_id)
          throw new Error("待确认的加分项消息已变化，请刷新后检查");
        if (review.parent_tab !== sender.tab.id && await chrome.tabs.get(review.parent_tab).catch(() => null))
          throw new Error("请在原 BOSS 列表页确认发送");
        const at = new Date().toISOString();
        for (const record of [run.applications[review.job_id], contacted_jobs[review.job_id]])
          if (record?.bonus_draft) Object.assign(record.bonus_draft, { review_status: "human_confirmed", confirmed_at: at });
        delete run.bonus_review;
        run.stop_reason = null;
        await chrome.storage.local.set({ run, contacted_jobs });
        return true;
      });
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return true;
    case "DEBUG_LOG":
      logEvent(
        `content:${String(message.event || "event").slice(0, 80)}`,
        safeLogDetails(message.details),
      );
      return true;
    case "GET_STATE": {
      const state = await chrome.storage.local.get([
        "profile",
        "weights",
        "prefs",
        "run",
        "run_target",
        "match_threshold",
        "selected_cities",
        "job_index",
        "contacted_jobs",
        "liepin_task",
        "allow_bonus_message",
        "auto_send_bonus_message",
        "auto_reply_messages",
        "llm_model",
        "llm_reasoning_effort",
        "llm_base_url",
        "llm_provider_id",
      ]);
      const { llm_api_key_override = "" } = await chrome.storage.local.get(
        "llm_api_key_override",
      );
      logEvent("state", {
        run_id: state.run?.id || "",
        status: state.run?.status || "idle",
        jobs: state.run?.jobs?.length || 0,
        attempts: state.run?.attempts?.length || 0,
        scores: Object.keys(state.run?.scores || {}).length,
        score_failures: Object.keys(state.run?.score_failures || {}).length,
        indexed: Object.keys(state.job_index || {}).length,
        current_job: state.run?.current?.job_id || "",
      });
      return {
        ...state,
        llm: await safeLLMStatus(
          state.llm_model,
          state.llm_base_url,
          llm_api_key_override,
          false,
          state.llm_reasoning_effort,
        ),
      };
    }
    case "GET_SESSION":
      if (!own) throw new Error("仅限设置页");
      {
        const session = await chrome.storage.session.get("helper_token");
        if (session.helper_token) return session;
        return {
          helper_token: (
            await chrome.storage.local.get("helper_token_persisted")
          ).helper_token_persisted,
        };
      }
    case "SET_TOKEN":
      if (!own) throw new Error("仅限设置页");
      {
        const token = String(message.token || "").trim();
        await chrome.storage.session.set({ helper_token: token });
        await chrome.storage.local.set({ helper_token_persisted: token });
      }
      return true;
    case "GET_LLM_CONFIG":
      if (!own) throw new Error("仅限设置页");
      {
        const config = await chrome.storage.local.get([
          "llm_model",
          "llm_reasoning_effort",
          "llm_base_url",
          "llm_provider_id",
          "llm_api_key_override",
        ]);
        return {
          model: config.llm_model || "",
          reasoning_effort: config.llm_reasoning_effort || "auto",
          base_url: config.llm_base_url || "",
          provider_id: config.llm_provider_id || "",
          api_key_override: !!config.llm_api_key_override,
          status: await safeLLMStatus(
            config.llm_model,
            config.llm_base_url,
            config.llm_api_key_override,
            false,
            config.llm_reasoning_effort,
          ),
        };
      }
    case "CONFIG_LLM": {
      if (!own) throw new Error("仅限设置页");
      const model = normalizeModelName(message.model);
      const reasoningEffort = String(message.reasoning_effort || "auto");
      if (!["auto", "default", "low"].includes(reasoningEffort))
        throw new Error("REASONING 只支持 Auto、Provider default 或 Low");
      let baseUrl = "";
      if (message.base_url) {
        let parsed;
        try {
          parsed = new URL(String(message.base_url));
        } catch {
          throw new Error("LLM Base URL 格式无效");
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("LLM Base URL 只支持 HTTP 或 HTTPS");
        baseUrl = String(message.base_url).trim().replace(/\/+$/, "");
      }
      const providerId = String(message.provider_id || "").trim();
      return serial(async () => {
        const previous = await chrome.storage.local.get([
          "llm_model",
          "llm_reasoning_effort",
          "llm_base_url",
          "llm_provider_id",
          "llm_api_key_override",
          "job_index",
          "run",
        ]);
        const changed =
          previous.llm_model !== model ||
          (previous.llm_reasoning_effort || "auto") !== reasoningEffort ||
          previous.llm_base_url !== baseUrl ||
          previous.llm_provider_id !== providerId;
        const nextApiKey =
          message.clear_api_key === true
            ? ""
            : String(message.api_key || "").trim() ||
              (previous.llm_base_url === baseUrl &&
              previous.llm_provider_id === providerId
                ? previous.llm_api_key_override || ""
                : "");
        await chrome.storage.local.set({
          llm_model: model,
          llm_reasoning_effort: reasoningEffort,
          llm_base_url: baseUrl,
          llm_provider_id: providerId,
          llm_api_key_override: nextApiKey,
        });
        if (changed) {
          for (const entry of Object.values(previous.job_index || {}))
            if (entry?.score_status === "valid") entry.score_status = "stale";
          if (previous.run)
            for (const score of Object.values(previous.run.scores || {}))
              if (score.engine === "llm") score.stale = true;
          await chrome.storage.local.set({
            job_index: previous.job_index || {},
            run: previous.run,
          });
        }
        const status = await safeLLMStatus(model, baseUrl, nextApiKey, true, reasoningEffort);
        await notifyJobTabs({ type: "LLM_CONFIG_CHANGED", status });
        return status;
      });
    }
    case "CONFIG_MODEL": {
      if (!own) throw new Error("仅限设置页");
      const model = normalizeModelName(message.model);
      const config = await chrome.storage.local.get([
        "llm_base_url",
        "llm_reasoning_effort",
        "llm_provider_id",
        "llm_api_key_override",
      ]);
      return handle(
        {
          type: "CONFIG_LLM",
          model,
          reasoning_effort: config.llm_reasoning_effort || "auto",
          base_url: config.llm_base_url || "",
          provider_id: config.llm_provider_id || "",
        },
        sender,
      );
    }
    case "SET_ALLOW_BONUS_MESSAGE":
      return serial(async () => {
        if (typeof message.enabled !== "boolean") throw new Error("追加加分项消息开关须为布尔值");
        const { run, liepin_task } = await chrome.storage.local.get(["run", "liepin_task"]);
        if (run?.status === "running" || (liepin_task && !liepin_task.cancelled))
          throw new Error("请先暂停，再修改加分项消息开关");
        await chrome.storage.local.set({ allow_bonus_message: message.enabled });
        return message.enabled;
      });
    case "SET_AUTO_SEND_BONUS_MESSAGE":
      return serial(async () => {
        if (typeof message.enabled !== "boolean") throw new Error("自动发送开关须为布尔值");
        const { run, liepin_task, allow_bonus_message } = await chrome.storage.local.get(["run", "liepin_task", "allow_bonus_message"]);
        if (run?.status === "running" || (liepin_task && !liepin_task.cancelled))
          throw new Error("请先暂停，再修改自动发送开关");
        if (message.enabled && allow_bonus_message !== true) throw new Error("请先开启追加加分项消息");
        // A pending BOSS review is already paused. Let the opt-in apply to this
        // draft too, while retaining the one-shot authorization before clicking.
        if (run?.bonus_review) run.bonus_review.auto_send = message.enabled;
        await chrome.storage.local.set({
          auto_send_bonus_message: message.enabled,
          ...(run?.bonus_review ? { run } : {}),
        });
        return message.enabled;
      });
    case "SET_RUN_TARGET":
      return serial(async () => {
        const target = Number(message.target);
        if (!Number.isSafeInteger(target) || target < 1)
          throw new Error("运行数量须为不小于1的整数");
        const { run } = await chrome.storage.local.get("run");
        if (run?.status === "running") throw new Error("运行中不能修改数量");
        if (run) run.target = target;
        await chrome.storage.local.set({ run_target: target, run });
        return target;
      });
    case "SET_MATCH_THRESHOLD":
      return serial(async () => {
        const value = validateMatchThreshold(Number(message.threshold));
        await chrome.storage.local.set({ match_threshold: value });
        return value;
      });
    case "SET_SELECTED_CITIES":
      return serial(async () => {
        const cities = validateSelectedCities(message.cities);
        await chrome.storage.local.set({ selected_cities: cities });
        return cities;
      });
    case "SET_SALARY_MIN":
      return serial(async () => {
        const raw = message.salary_min_k;
        const min = raw == null || raw === "" ? null : Number(raw);
        if (min !== null && (!Number.isFinite(min) || min < 0 || min > 1000))
          throw new Error("薪资底线须为0到1000K");
        const { prefs = DEFAULT_PREFS, run } = await chrome.storage.local.get([
          "prefs",
          "run",
        ]);
        if (run?.status === "running")
          throw new Error("请先暂停，再修改薪资底线");
        const nextPrefs = validatePrefs({ ...prefs, salary_min_k: min });
        await chrome.storage.local.set({ prefs: nextPrefs });
        return nextPrefs.salary_min_k;
      });
    case "SET_BLACKLIST":
      return serial(async () => {
        const keywords = parseBlacklist(message.keywords);
        const { prefs = DEFAULT_PREFS, run } = await chrome.storage.local.get([
          "prefs",
          "run",
        ]);
        if (run?.status === "running")
          throw new Error("请先暂停，再修改黑名单");
        const nextPrefs = validatePrefs({ ...prefs, excluded_terms: keywords });
        applyRunBlacklist(run, keywords, prefs?.excluded_companies || []);
        await chrome.storage.local.set({
          prefs: nextPrefs,
          ...(run ? { run } : {}),
        });
        await notifyJobTabs({ type: "BLACKLIST_CHANGED", prefs: nextPrefs });
        return { prefs: nextPrefs, run: run || null };
      });
    case "SET_COMPANY_BLACKLIST":
      return serial(async () => {
        const keywords = parseBlacklist(message.keywords);
        const { prefs = DEFAULT_PREFS, run } = await chrome.storage.local.get([
          "prefs",
          "run",
        ]);
        if (run?.status === "running")
          throw new Error("请先暂停，再修改黑名单");
        const nextPrefs = validatePrefs({
          ...prefs,
          excluded_companies: keywords,
        });
        applyRunBlacklist(run, prefs?.excluded_terms || [], keywords);
        await chrome.storage.local.set({
          prefs: nextPrefs,
          ...(run ? { run } : {}),
        });
        await notifyJobTabs({ type: "BLACKLIST_CHANGED", prefs: nextPrefs });
        return { prefs: nextPrefs, run: run || null };
      });
    case "SET_TITLE_SCREEN":
      return serial(async () => {
        const enabled = Boolean(message.enabled);
        await chrome.storage.local.set({ title_screen_enabled: enabled });
        return enabled;
      });
    case "CONFIG":
      return serial(async () => {
        if (!own) throw new Error("仅限设置页");
        const patch = {};
        if (message.cv)
          patch.profile = await profileFromCV(message.cv, message.name);
        if (message.weights) patch.weights = validateWeights(message.weights);
        if (message.prefs) patch.prefs = validatePrefs(message.prefs);
        const {
          run,
          profile,
          prefs,
          job_index = {},
        } = await chrome.storage.local.get([
          "run",
          "profile",
          "prefs",
          "job_index",
        ]);
        if (run?.status === "running") throw new Error("请先暂停后再修改配置");
        if (
          (patch.profile && patch.profile.version !== profile?.version) ||
          (patch.prefs && stableJSON(patch.prefs) !== stableJSON(prefs))
        ) {
          if (run) {
            run.scores = {};
            delete run.profile_snapshot;
            delete run.weights_snapshot;
            delete run.preferences_snapshot;
            await chrome.storage.local.set({ run });
          }
          if (patch.profile)
            for (const entry of Object.values(job_index))
              if (entry?.score_status === "valid") entry.score_status = "stale";
          await chrome.storage.local.set({ job_index });
        }
        await chrome.storage.local.set(patch);
        return true;
      });
    case "CLAIM":
      return serial(async () => {
        const { lease, run } = await chrome.storage.local.get(["lease", "run"]);
        if (run?.bonus_review) throw new Error("请先处理聊天页的加分项草稿");
        if (lease && lease.tab !== sender.tab.id) {
          try {
            await chrome.tabs.get(lease.tab);
            throw new Error("另一职位标签页正在运行，请先暂停");
          } catch (error) {
            if (error.message.includes("正在运行")) throw error;
          }
        }
        await chrome.storage.local.set({
          lease: { tab: sender.tab.id, run_id: message.run_id },
        });
        return true;
      });
    case "RELEASE":
      return serial(async () => {
        const { lease } = await chrome.storage.local.get("lease");
        if (lease?.tab === sender.tab?.id && lease.run_id === message.run_id)
          await chrome.storage.local.remove("lease");
        return true;
      });
    case "SAVE_RUN":
      return serial(async () => {
        validateCheckpoint(message.run);
        const { lease, run, prefs } = await chrome.storage.local.get([
          "lease",
          "run",
          "prefs",
        ]);
        if (lease?.tab !== sender.tab?.id || lease.run_id !== message.run?.id)
          throw new Error("当前标签页没有运行租约");
        if (run?.status === "running" && run.id !== message.run.id)
          throw new Error("另一个批次正在运行");
        if (run?.bonus_review) throw new Error("请先处理聊天页的加分项草稿");
        await chrome.storage.local.set({
          run: applyRunBlacklist(message.run, prefs?.excluded_terms || [], prefs?.excluded_companies || []),
        });
        return true;
      });
    case "RECOVER":
      if (new URL(sender.url).hostname === "c.liepin.com")
        return liepin.recover(sender);
      return serial(async () => {
        const { run, lease, contacted_jobs = {} } = await chrome.storage.local.get(["run", "lease", "contacted_jobs"]);
        if (lease && lease.tab !== sender.tab?.id) return true;
        if (run?.bonus_review?.site === "boss" && run.bonus_review.parent_tab === sender.tab?.id) {
          const id = run.bonus_review.job_id;
          for (const record of [run.applications?.[id], contacted_jobs[id]])
            if (["awaiting_editor", "sending"].includes(record?.bonus_draft?.status))
              record.bonus_draft.status = run.bonus_review.send_attempted ? "send_unconfirmed" : "editor_interrupted";
          delete run.bonus_review;
          run.stop_reason = null;
          await chrome.storage.local.set({ run, contacted_jobs });
        }
        if (run?.bonus_resume_tab != null) {
          delete run.bonus_resume_tab;
          run.status = "paused";
          run.stop_reason = "旧版聊天返回任务已停止，请确认职位筛选后手动继续";
          await chrome.storage.local.set({ run });
        }
        if (run?.status === "running") {
          run.status = "paused";
          run.stop_reason = "页面刷新或扩展重启，请手动恢复";
          await chrome.storage.local.set({ run });
        }
        await chrome.storage.local.remove("lease");
        return true;
      });
    case "NEW_SCOPE_RUN":
    case "NEW_RUN":
      if (liepin.busy) throw new Error("请先暂停并等待猎聘当前职位处理完成");
      return serial(async () => {
        const { run, lease, archives = [] } = await chrome.storage.local.get([
          "run",
          "lease",
          "archives",
        ]);
        if (message.type === "NEW_SCOPE_RUN") {
          if (isBoss(sender.url)) throw new Error("BOSS 筛选范围已变化，请恢复原筛选或手动新建批次");
          if (!sender.tab?.id || !isListPage(sender.url) ||
              !message.scope || !isListPage(message.scope.url) ||
              siteForURL(message.scope.url) !== siteForURL(sender.url))
            throw new Error("只能从当前职位列表切换搜索批次");
          if (!run || stableJSON(run.scope) === stableJSON(message.scope)) return false;
          if (run.id !== message.run_id) throw new Error("批次已改变，请刷新页面");
          if (lease && lease.tab !== sender.tab.id &&
              await chrome.tabs.get(lease.tab).catch(() => null))
            throw new Error("另一职位标签页正在运行，请先暂停");
          run.status = "paused";
          run.resume_on_reload = false;
          run.stop_reason = "搜索范围已改变，已自动开启新批次";
          logEvent("timing:scope_rollover", { site: siteForURL(sender.url), run_id: run.id });
        } else {
          if (run?.status === "running") throw new Error("请先暂停");
          if (run?.bonus_review) throw new Error("请先处理聊天页的加分项草稿");
        }
        const { liepin_task } = await chrome.storage.local.get("liepin_task");
        // A scope switch must not turn an uncertain contact into a fresh send.
        if (message.type === "NEW_SCOPE_RUN" && liepin_task?.contact_clicked) {
          const { contacted_jobs = {} } = await chrome.storage.local.get("contacted_jobs");
          contacted_jobs[liepin_task.job_id] ||= {
            job_id: liepin_task.job_id, run_id: run.id, status: "contact_unconfirmed",
            updated_at: new Date().toISOString(),
          };
          await chrome.storage.local.set({ contacted_jobs });
        }
        if (run)
          archives.push({
            ...run,
            ...(liepin_task
              ? { liepin_task: { ...liepin_task, cancelled: true } }
              : {}),
          });
        await chrome.storage.local.set({
          run: null,
          archives,
          liepin_task: null,
        });
        await chrome.storage.local.remove("lease");
        if (message.type === "NEW_SCOPE_RUN")
          await chrome.tabs.update(sender.tab.id, { active: true });
        return true;
      });
    case "RETRY_FAILED":
      return serial(async () => {
        const { run } = await chrome.storage.local.get("run");
        if (failedJobs(run).length || Object.keys(run?.score_failures || {}).length)
          await chrome.storage.local.set({ run: retryFailures(run) });
        return true;
      });
    case "OCR_CAPTURE":
      return serial(() => screenshot(sender, message));
    case "OCR_PROCESS":
      return serial(() => processOCR(message));
    case "SCORE":
      try {
        return await scoreOne(
          message.job_id,
          message.engine === "rules" ? "rules" : "llm",
          message.timing,
        );
      } catch (error) {
        if (message.engine !== "rules") {
          await serial(async () => {
            const { run } = await chrome.storage.local.get("run");
            if (!run) return;
            run.score_failures ??= {};
            run.score_failures[message.job_id] = {
              reason: error.message,
              at: new Date().toISOString(),
            };
            await chrome.storage.local.set({ run });
          });
        }
        throw error;
      }
    case "APPLICATION_RECORD":
      return serial(async () => {
        const {
          run,
          job_index = {},
          contacted_jobs = {},
          prefs,
          profile,
          allow_bonus_message,
          auto_send_bonus_message,
        } = await chrome.storage.local.get([
          "run",
          "job_index",
          "contacted_jobs",
          "prefs",
          "profile",
          "allow_bonus_message",
          "auto_send_bonus_message",
        ]);
        if (!run || run.id !== message.run_id)
          throw new Error("申请批次已改变");
        if (run.bonus_review && ["qualified", "opening", "already_contacted"].includes(message.outcome))
          throw new Error("请先处理聊天页的加分项草稿");
        const indexed = job_index[message.job_id] || null;
        const raw =
          run.jobs.find((job) => job.job_id === message.job_id) || indexed;
        if (!raw) throw new Error("职位不在当前批次或历史索引中");
        const blacklistKeyword = jobBlacklistMatch(
          raw,
          prefs?.excluded_terms,
          run,
        );
        const companyBlacklistKeyword = companyBlacklistMatch(
          raw,
          prefs?.excluded_companies,
          run,
        );
        if (
          ["qualified", "opening"].includes(message.outcome) &&
          (blacklistKeyword || companyBlacklistKeyword)
        )
          throw new Error(
            `命中黑名单，已跳过：${companyBlacklistKeyword || blacklistKeyword}`,
          );
        if (
          ![
            "qualified",
            "opening",
            "contact_opened",
            "already_contacted",
            "missing_card",
            "button_missing",
            "failed",
            "paused",
          ].includes(message.outcome)
        )
          throw new Error("无效申请结果");
        const score =
          run.scores[raw.job_id] ||
          (indexed
            ? {
                match_score: indexed.score,
                verdict: indexed.verdict,
                summary: indexed.summary,
                requirements: indexed.requirements,
                requirements_status: indexed.requirements_status,
                engine: "llm",
                profile_version: indexed.profile_version,
                bonus_matches: indexed.bonus_matches || [],
              }
            : null);
        if (!score) throw new Error("职位尚未评分");
        const fingerprint =
          indexed?.jd_fingerprint ||
          (await jobFingerprint(
            run.jobs.some((job) => job.job_id === message.job_id)
              ? effectiveJob(raw, run)
              : raw,
          ));
        const threshold = validateMatchThreshold(Number(message.threshold));
        const at = new Date().toISOString();
        run.applications ??= {};
        run.applications[raw.job_id] = {
          ...(run.applications[raw.job_id] || {}),
          job_id: raw.job_id,
          status: message.outcome,
          score: score.match_score,
          threshold,
          reason: String(message.reason || ""),
          updated_at: at,
        };
        let pendingContact = null;
        if (
          message.outcome === "opening" ||
          message.outcome === "contact_opened" ||
          message.outcome === "already_contacted"
        ) {
          const record = contactRecord({
            existing: contacted_jobs[raw.job_id] || {},
            raw,
            fingerprint,
            score,
            threshold,
            runId: run.id,
            status: message.outcome,
            at,
          });
          if (message.outcome === "opening" && message.prepare_bonus === true)
            pendingContact = record;
          else {
            contacted_jobs[raw.job_id] = record;
            if (job_index[raw.job_id]) job_index[raw.job_id].contacted = true;
          }
        }
        let bonusText = "";
        if (["opening", "already_contacted"].includes(message.outcome) && message.prepare_bonus === true &&
            allow_bonus_message === true && isBoss(sender.url) && isListPage(sender.url) &&
            score.profile_version === profile?.version && score.match_score >= threshold &&
            !blacklistKeyword && !companyBlacklistKeyword && !contacted_jobs[raw.job_id]?.bonus_draft &&
            isBossBonusDetailURL(message.bonus_url) && jobId(message.bonus_url) === raw.job_id) {
          const job = effectiveJob(raw, run);
          bonusText = bonusMessage(validateBonusMatches(score.bonus_matches, { jd: job.jd, profileText: profile.text }));
          if (bonusText) {
            const draft = { status: "awaiting_editor", message: bonusText };
            run.applications[raw.job_id].bonus_draft = draft;
            if (contacted_jobs[raw.job_id]) contacted_jobs[raw.job_id].bonus_draft = draft;
            run.bonus_review = { site: "boss", job_id: raw.job_id, parent_tab: sender.tab.id,
              detail_url: message.bonus_url, existing_contact: message.existing_contact === true,
              contact_record: pendingContact,
              profile_version: profile.version, message: bonusText,
              auto_send: auto_send_bonus_message === true,
              title: raw.title, contact: {
                recruiter: String(message.bonus_contact?.recruiter || "").slice(0, 100),
                company: String(message.bonus_contact?.company || raw.company || "").slice(0, 200),
              } };
            run.status = "paused";
            run.resume_on_reload = false;
            run.stop_reason = "正在聊天页填入加分项草稿；成功后自动返回列表继续，无法填入则记录并跳过，不中断批次";
          }
        }
        await chrome.storage.local.set({
          run,
          contacted_jobs,
          job_index,
        });
        return {
          application: run.applications[raw.job_id],
          contacted: contacted_jobs[raw.job_id] || null,
          bonus_message: bonusText,
          bonus_auto_send: run.bonus_review?.auto_send === true,
        };
      });
    case "REWEIGHT":
      return serial(async () => {
        const { run, weights, prefs, profile } = await chrome.storage.local.get(
          ["run", "weights", "prefs", "profile"],
        );
        if (!run) return true;
        if (run.status === "running") throw new Error("请先暂停");
        for (const [id, score] of Object.entries(run.scores)) {
          if (score.engine === "llm") continue;
          if (score.profile_version !== profile.version) {
            delete run.scores[id];
            continue;
          }
          const job = effectiveJob(
            run.jobs.find((item) => item.job_id === id),
            run,
          );
          run.scores[id] = {
            ...score,
            ...weightedScore(
              score,
              weights,
              hardFilter(job, prefs),
              unresolvedFlags(job, run),
            ),
          };
        }
        run.weights_snapshot = weights;
        await chrome.storage.local.set({ run });
        return true;
      });
    case "CORRECT":
      return serial(async () => {
        const { run, job_index = {} } = await chrome.storage.local.get([
          "run",
          "job_index",
        ]);
        if (!run || run.status === "running") throw new Error("请暂停后再校正");
        if (
          !run.jobs.some((job) => job.job_id === message.job_id) ||
          !String(message.jd || "").trim()
        )
          throw new Error("请提供经人工核实的完整 JD");
        const correction = {
          jd: String(message.jd).trim(),
          salary: String(message.salary || "").trim(),
          title: String(message.fields?.title || "").trim(),
          company: String(message.fields?.company || "").trim(),
          location: String(message.fields?.location || "").trim(),
          at: new Date().toISOString(),
        };
        run.corrections ??= {};
        run.corrections[message.job_id] = correction;
        delete run.scores[message.job_id];
        if (job_index[message.job_id])
          job_index[message.job_id].score_status = "stale";
        await chrome.storage.local.set({ run, job_index });
        return true;
      });
    case "EXPORT": {
      const {
        run,
        profile,
        weights,
        prefs,
        archives = [],
        job_index = {},
        contacted_jobs = {},
        match_threshold,
      } = await chrome.storage.local.get([
        "run",
        "profile",
        "weights",
        "prefs",
        "archives",
        "job_index",
        "contacted_jobs",
        "match_threshold",
      ]);
      if (!run) throw new Error("尚无采集数据");
      const ids = [
        ...new Set([
          ...run.jobs.flatMap((job) => job.evidence_ids || []),
          ...(run.pending_evidence || []),
        ]),
      ];
      const evidence = message.images
        ? await Promise.all(
            ids.map(async (id) => ({ id, ...(await evidenceGet(id)) })),
          )
        : ids;
      return {
        format: "jseeker-run-v2",
        run_id: run.id,
        "jobs.raw.json": run.jobs,
        "jobs.normalized.json": run.jobs
          .filter(
            (job) =>
              (job.jd_raw || run.corrections?.[job.job_id]?.jd) &&
              (job.title || run.corrections?.[job.job_id]?.title),
          )
          .map((job) => effectiveJob(job, run)),
        "jobs.scored.json": Object.values(run.scores),
        "applications.json": run.applications || {},
        "contacted-jobs.json": contacted_jobs,
        "job-index.json": job_index,
        "profile.snapshot.json": run.profile_snapshot || profile,
        "weights.json": run.weights_snapshot || weights,
        "preferences.json": run.preferences_snapshot || prefs,
        "review.json": run.review,
        "corrections.json": run.corrections,
        "review-history.json": run.review_history || [],
        "correction-history.json": run.correction_history || [],
        "supplements.json": run.supplements,
        "run-summary.json": {
          ...run,
          jobs: undefined,
          scores: undefined,
          review: undefined,
          corrections: undefined,
          match_threshold,
          ...runCounts(run),
        },
        evidence,
        archived_run_count: archives.length,
        archived_runs: archives,
      };
    }
    case "HEALTH":
      return localRequest("/health");
    case "LLM_STATUS": {
      const { llm_api_key_override = "" } = await chrome.storage.local.get(
        "llm_api_key_override",
      );
      return safeLLMStatus(
        message.model,
        message.base_url,
        String(message.api_key || "").trim() || llm_api_key_override,
      );
    }
    default:
      throw new Error("不支持的操作");
  }
}

const liepin = new LiepinCoordinator(chrome, {
  serial,
  score: scoreOne,
  screen: screenTitles,
  log: logEvent,
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender)
    .then((data) => respond({ ok: true, data }))
    .catch((error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tab) => {
  liepin.onRemoved(tab).catch(console.error);
  serial(async () => {
    const { lease, run } = await chrome.storage.local.get(["lease", "run"]);
    if (lease?.tab === tab) {
      if (run?.status === "running") {
        run.status = "paused";
        run.stop_reason = "采集标签页已关闭";
        await chrome.storage.local.set({ run });
      }
      await chrome.storage.local.remove("lease");
    }
  });
});
