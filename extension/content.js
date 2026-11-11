import css from "./ui.css";
import * as bossAdapter from "./boss-adapter.js";
import * as liepinAdapter from "./liepin-adapter.js";
import { siteForURL, isListPage, isBossChatURL } from "./sites.js";
import { liepinJobFinished } from "./liepin-coordinator.js";
import {
  MAJOR_CITIES,
  stableJSON,
  locationMatchesCities,
  canonicalURL,
  csv,
  normalizeText,
  parseSalary,
} from "./core.js";
import {
  failedJobs,
  isComplete,
  processedCount,
  matchProgress,
  scoringFailureText,
  scoringFailures,
} from "./run-state.js";
import {
  isContactedEntry,
  jobFingerprint,
  scoreIsCurrent,
} from "./job-history.js";
import { Scanner } from "./scanner.js";
import { waitForVisible } from "./visibility.js";
import {
  applyRunBlacklist,
  companyBlacklistMatch,
  jobBlacklistMatch,
} from "./blacklist.js";
import { bonusMessage, validateBonusMatches } from "./bonus-message.js";
import { PhaseTimer } from "./timing.js";
import { scoringRequest } from "./runtime-request.js";

const isLiepin = siteForURL(location.href) === "liepin";
const adapter = isLiepin ? liepinAdapter : bossAdapter;

if (isListPage(location.href) && !document.getElementById("jseeker-root"))
  boot();

async function boot() {
  const host = document.createElement("div");
  host.id = "jseeker-root";
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  shadow.append(style);
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const panel = el("section", undefined, "panel");
  panel.hidden = false;
  const hidePanel = el("button", "×", "panel-hide");
  hidePanel.type = "button";
  hidePanel.title = "隐藏 JSeeker";
  hidePanel.setAttribute("aria-label", "隐藏 JSeeker 侧栏");
  const restorePanel = el("button", "J", "restore-panel");
  restorePanel.type = "button";
  restorePanel.title = "显示 JSeeker";
  restorePanel.setAttribute("aria-label", "显示 JSeeker 侧栏");
  restorePanel.hidden = true;
  hidePanel.onclick = () => {
    panel.hidden = true;
    restorePanel.hidden = false;
  };
  restorePanel.onclick = () => {
    restorePanel.hidden = true;
    panel.hidden = false;
  };
  shadow.append(panel, restorePanel);
  const body = el("div", undefined, "body");
  panel.append(hidePanel, body);

  const api = async (message) => {
    const send = () => chrome.runtime.sendMessage(message);
    const response = await (message.type === "SCORE" ? scoringRequest(send) : send());
    if (!response?.ok)
      throw new Error(response?.error || "扩展连接已失效，请刷新页面");
    return response.data;
  };
  const debug = (event, details = {}) => {
    console.info(`[JSeeker][${event}]`, details);
    chrome.runtime
      .sendMessage({ type: "DEBUG_LOG", event, details })
      .catch(() => {});
  };
  const scanApi = async (message) => {
    if (message.type !== "OCR") return api(message);
    const panelRect = panel.getBoundingClientRect();
    const target = message.rect;
    const overlaps =
      !panel.hidden &&
      target.x < panelRect.right &&
      target.x + target.width > panelRect.left &&
      target.y < panelRect.bottom &&
      target.y + target.height > panelRect.top;
    if (overlaps) {
      host.style.visibility = "hidden";
      await new Promise(requestAnimationFrame);
    }
    let captured;
    try {
      captured = await api({ ...message, type: "OCR_CAPTURE" });
    } finally {
      if (overlaps) host.style.visibility = "";
    }
    return api({ type: "OCR_PROCESS", evidence_id: captured.evidence_id });
  };

  let state = {};
  let stateRevision = 0;
  let workflowActive = false;
  let workflowStarting = false;
  let stopWorkflow = false;
  let phase = "idle";
  let error = "";
  let configurationError = "";
  let notice = "";
  let targetSaveTimer;
  let targetRevision = 0;
  let targetSavePromise = Promise.resolve();
  const targetInput = el("input");
  let visibilityWaitStarted = null;
  let visibilityWaitTimer;
  let bossTimer = null;
  function onVisibility(waiting) {
    if (waiting === (visibilityWaitStarted !== null)) return;
    if (!waiting) debug("timing:wait", {
      ...(bossTimer?.context || { site: isLiepin ? "liepin" : "boss", run_id: state.run?.id || "" }),
      phase: "foreground_wait", started_at: new Date(visibilityWaitStarted).toISOString(),
      ended_at: new Date().toISOString(), elapsed_ms: Date.now() - visibilityWaitStarted,
    });
    visibilityWaitStarted = waiting ? Date.now() : null;
    clearInterval(visibilityWaitTimer);
    if (waiting) visibilityWaitTimer = setInterval(render, 1000);
    debug(waiting ? "workflow:waiting-visible" : "workflow:visible", {
      run_id: state.run?.id || "",
    });
    render();
  }
  async function saveTarget() {
    clearTimeout(targetSaveTimer);
    const value = Number(targetInput.value);
    if (
      !targetInput.value.trim() ||
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      targetSaveState = "invalid";
      render();
      throw new Error("运行数量须为不小于1的整数");
    }
    const revision = targetRevision;
    targetSaveState = "saving";
    const save = targetSavePromise
      .catch(() => {})
      .then(async () => {
        const saved = await api({ type: "SET_RUN_TARGET", target: value });
        if (revision === targetRevision) {
          state.run_target = saved;
          if (state.run) state.run.target = saved;
          targetSaveState = "saved";
        }
      });
    targetSavePromise = save;
    try {
      await save;
    } catch (cause) {
      if (revision === targetRevision) targetSaveState = "error";
      throw cause;
    } finally {
      render();
    }
  }
  let targetSaveState = "saved";
  let currentTitle = "";
  let salarySkipped = new Set();
  let currentScore = null;
  let currentApplications = 0;
  const scoringAttempts = new Set();
  let scoringDone = 0;
  let scoringTotal = 0;
  const scanner = new Scanner(
    scanApi,
    async (run) => {
      state.run = run;
      render();
    },
    onVisibility,
  );

  function button(text, onClick, { disabled = false, primary = false } = {}) {
    const node = el("button", text, primary ? "primary" : "");
    node.type = "button";
    node.disabled = disabled;
    node.onclick = async () => {
      error = "";
      try {
        await onClick();
      } catch (cause) {
        error = cause.message;
      }
      render();
    };
    return node;
  }

  function runTarget() {
    const value = Number(state.run_target);
    return Number.isSafeInteger(value) && value >= 1 ? value : 10;
  }

  function matchThreshold() {
    const value = Number(state.match_threshold);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 75;
  }

  function selectedCities() {
    return Array.isArray(state.selected_cities)
      ? state.selected_cities.filter((city) => MAJOR_CITIES.includes(city))
      : ["深圳"];
  }

  function blacklistMatch(job) {
    return (
      companyBlacklistMatch(
        job,
        state.prefs?.excluded_companies,
        state.run,
      ) || jobBlacklistMatch(job, state.prefs?.excluded_terms, state.run)
    );
  }

  function scoreContext() {
    return {
      profileVersion: state.profile?.version || "",
      modelVersion: state.llm?.model_version || "",
    };
  }

  function validIndexedScore(jobId) {
    const entry = state.job_index?.[jobId];
    return scoreIsCurrent(entry, scoreContext()) ? entry : null;
  }

  function contacted(jobId) {
    return isContactedEntry(state.contacted_jobs?.[jobId], jobId);
  }

  function mergeRunScore(raw) {
    const direct = state.run?.scores?.[raw.job_id];
    if (
      direct &&
      direct.engine === "llm" &&
      direct.profile_version === state.profile?.version &&
      (!state.llm?.model_version ||
        direct.model_version === state.llm.model_version)
    )
      return direct;
    const indexed = validIndexedScore(raw.job_id);
    return indexed
      ? {
          engine: "llm",
          match_score: indexed.score,
          verdict: indexed.verdict,
          summary: indexed.summary,
          strengths: indexed.strengths,
          gaps: indexed.gaps,
          evidence: indexed.evidence,
          requirements: indexed.requirements,
          requirements_status: indexed.requirements_status,
          bonus_matches: indexed.bonus_matches || [],
          model: indexed.model,
          model_version: indexed.model_version,
          profile_version: indexed.profile_version,
          scored_at: indexed.scored_at,
          coverage: 1,
          eligibility: { status: "pass", reasons: [], unknowns: [] },
          indexed: true,
        }
      : null;
  }

  function rows() {
    const result = (state.run?.jobs || []).map((raw) => {
      const fix = state.run.corrections?.[raw.job_id];
      const score = mergeRunScore(raw);
      return {
        ...raw,
        title: fix?.title || raw.title,
        company: fix?.company || raw.company,
        location_raw: fix?.location || raw.location_raw,
        jd_confirmed: fix?.jd || "",
        ...(score || {}),
        application: state.run.applications?.[raw.job_id] || null,
        contact: state.contacted_jobs?.[raw.job_id] || null,
      };
    });
    const present = new Set(result.map((row) => row.job_id));
    for (const [jobId, entry] of Object.entries(state.job_index || {})) {
      if (present.has(jobId) || !scoreIsCurrent(entry, scoreContext()))
        continue;
      result.push({
        job_id: jobId,
        url: canonicalURL(jobId),
        title: entry.title,
        company: entry.company,
        is_headhunter: entry.is_headhunter ?? null,
        headhunter_evidence: entry.headhunter_evidence || null,
        recruiter_raw: entry.recruiter_raw || null,
        location_raw: null,
        salary_raw: null,
        jd_raw: "",
        engine: "llm",
        match_score: entry.score,
        verdict: entry.verdict,
        summary: entry.summary,
        strengths: entry.strengths,
        gaps: entry.gaps,
        evidence: entry.evidence,
        requirements: entry.requirements,
        requirements_status: entry.requirements_status,
        bonus_matches: entry.bonus_matches || [],
        model: entry.model,
        model_version: entry.model_version,
        profile_version: entry.profile_version,
        scored_at: entry.scored_at,
        coverage: 1,
        eligibility: { status: "pass", reasons: [], unknowns: [] },
        indexed_only: true,
        application: null,
        contact: state.contacted_jobs?.[jobId] || null,
      });
    }
    return result;
  }

  function download(name, text, type) {
    const anchor = el("a");
    anchor.href = URL.createObjectURL(new Blob([text], { type }));
    anchor.download = name;
    shadow.append(anchor);
    anchor.click();
    setTimeout(() => {
      URL.revokeObjectURL(anchor.href);
      anchor.remove();
    }, 2000);
  }

  async function refresh() {
    const revision = ++stateRevision;
    const nextState = await api({ type: "GET_STATE" });
    if (revision !== stateRevision) return;
    state = nextState;
    clearResolvedConfigurationError();
    render();
  }

  function clearResolvedConfigurationError() {
    if (state.llm?.configured && error === configurationError) {
      error = "";
      configurationError = "";
    }
  }

  async function exportCSV() {
    const threshold = matchThreshold();
    const exportRows = [];
    for (const row of rows()) {
      const salary = parseSalary(
        state.run?.corrections?.[row.job_id]?.salary || row.salary_raw,
      );
      const fingerprint =
        row.contact?.jd_fingerprint ||
        state.job_index?.[row.job_id]?.jd_fingerprint ||
        (row.jd_raw
          ? await jobFingerprint({ title: row.title, jd_raw: row.jd_raw })
          : "");
      const score = Number(row.match_score);
      exportRows.push({
        ...row,
        jd_fingerprint: fingerprint,
        salary_min_k: salary.min_k,
        salary_max_k: salary.max_k,
        salary_months: salary.months,
        match_threshold: threshold,
        qualification_status: Number.isFinite(score)
          ? score >= threshold
            ? "qualified"
            : "below_threshold"
          : "unscored",
        application_status: row.application?.status || "",
        contacted_at: row.contact?.contacted_at || "",
        llm_summary: row.summary || "",
      });
    }
    download(
      `jseeker-${state.run?.id || "jobs"}-match.csv`,
      csv(exportRows),
      "text/csv;charset=utf-8",
    );
  }

  function skipIds() {
    return adapter
      .cards()
      .map((card) => card.id)
      .filter((jobId) => contacted(jobId) || !!validIndexedScore(jobId));
  }

  async function scoreCollected() {
    const jobs = state.run?.jobs || [];
    const failures = [];
    const pending = jobs.filter(
      (raw) =>
        !blacklistMatch(raw) && !scoringAttempts.has(raw.job_id) && !state.run?.score_failures?.[raw.job_id] &&
        isComplete(raw, state.run) &&
        mergeRunScore(raw)?.engine !== "llm",
    );
    scoringDone = 0;
    scoringTotal = pending.length;
    debug("score:batch", {
      total_jobs: jobs.length,
      pending: pending.length,
      run_status: state.run?.status || "",
    });
    for (const raw of jobs) {
      if (stopWorkflow || scopeChanged()) break;
      if (blacklistMatch(raw) || scoringAttempts.has(raw.job_id) || state.run?.score_failures?.[raw.job_id]) continue;
      if (!isComplete(raw, state.run)) {
        debug("score:skip", {
          job_id: raw.job_id,
          reason: "incomplete",
        });
        continue;
      }
      if (mergeRunScore(raw)?.engine === "llm") {
        debug("score:skip", {
          job_id: raw.job_id,
          reason: "cached",
        });
        continue;
      }
      phase = "scoring";
      currentTitle = raw.title || raw.job_id;
      debug("score:start", {
        job_id: raw.job_id,
        position: scoringDone + 1,
        total: scoringTotal,
      });
      render();
      const scoreStarted = Date.now();
      scoringAttempts.add(raw.job_id);
      try {
        await api({ type: "SCORE", job_id: raw.job_id, engine: "llm", timing: bossTimer?.context });
      } catch (cause) {
        failures.push(`${raw.title || raw.job_id}: ${cause.message}`);
      }
      const scoreElapsedMs = Date.now() - scoreStarted;
      scoringDone++;
      debug("score:finished", {
        job_id: raw.job_id,
        done: scoringDone,
        total: scoringTotal,
        elapsed_ms: scoreElapsedMs,
        elapsed_s: Math.round(scoreElapsedMs / 100) / 10,
        errors: failures.length,
      });
      await refresh();
    }
    error = failures.join("\n");
  }

  function progress() {
    return matchProgress(state.run, rows(), matchThreshold(), blacklistMatch);
  }

  function groundedBonusText(row) {
    return bonusMessage(validateBonusMatches(row.bonus_matches, {
      jd: row.jd_confirmed || row.jd_raw, profileText: state.profile?.text,
    }));
  }

  function needsBonusDraft(row) {
    return state.allow_bonus_message === true && !!groundedBonusText(row) &&
      !row.contact?.bonus_draft && !row.application?.bonus_draft;
  }

  function qualifiedRows() {
    const threshold = matchThreshold();
    const currentBatch = new Set(
      (state.run?.jobs || []).map((job) => job.job_id),
    );
    return rows()
      .filter(
        (row) =>
          currentBatch.has(row.job_id) &&
          !blacklistMatch(row) &&
          row.engine === "llm" &&
          Number.isFinite(Number(row.match_score)) &&
          Number(row.match_score) >= threshold &&
          row.eligibility?.status !== "reject" &&
          (!contacted(row.job_id) || needsBonusDraft(row)),
      )
      .sort((a, b) => b.match_score - a.match_score);
  }

  async function applyQualified() {
    bossTimer?.phase("contact");
    const threshold = matchThreshold();
    const candidates = qualifiedRows();
    const scope = stableJSON(state.run?.scope || adapter.scope());
    const waitReady = async (expectedId = null) => {
      try {
        await waitForVisible(
          document,
          () => {
            if (stopWorkflow) throw new Error("用户已暂停");
            if (stableJSON(adapter.scope()) !== scope)
              throw new Error("搜索范围已改变，请新建批次");
            const reason = adapter.blockedReason();
            if (reason) throw new Error(reason);
            if (expectedId && adapter.detailId() !== expectedId)
              throw new Error("职位详情已变化，未进入申请");
          },
          { onWaiting: () => onVisibility(true) },
        );
      } finally {
        onVisibility(false);
      }
    };
    for (const row of candidates) {
      if (stopWorkflow) break;
      phase = "applying";
      currentTitle = row.title || row.job_id;
      currentApplications++;
      render();
      await api({
        type: "APPLICATION_RECORD",
        run_id: state.run.id,
        job_id: row.job_id,
        outcome: "qualified",
        threshold,
      });
      const card = adapter.cards().find((item) => item.id === row.job_id);
      if (!card) {
        await api({
          type: "APPLICATION_RECORD",
          run_id: state.run.id,
          job_id: row.job_id,
          outcome: "missing_card",
          threshold,
          reason: "当前 BOSS 列表中没有该职位卡片",
        });
        continue;
      }
      if (stopWorkflow) break;
      await waitReady();
      card.el.scrollIntoView({ block: "nearest" });
      adapter.clickElement(card.link);
      await adapter.waitForDetail(row.job_id, () => waitReady());
      await waitReady(row.job_id);
      const existing = contacted(row.job_id) || !!adapter.existingContactButton();
      const wantsBonus = needsBonusDraft(row);
      const contact = existing ? null : adapter.contactButton();
      if (!existing && !contact) {
        await api({
          type: "APPLICATION_RECORD",
          run_id: state.run.id,
          job_id: row.job_id,
          outcome: "button_missing",
          threshold,
          reason: "未找到可见的立即沟通按钮",
        });
        continue;
      }
      if (adapter.detailId() !== row.job_id || stopWorkflow)
        throw new Error("职位详情已变化，未进入申请");
      const bonusContact = adapter.bonusContactIdentity(card);
      if (wantsBonus) {
        const recorded = await api({ type: "APPLICATION_RECORD", run_id: state.run.id,
          job_id: row.job_id, outcome: existing ? "already_contacted" : "opening",
          prepare_bonus: true, existing_contact: existing,
          bonus_url: adapter.detail()?.querySelector('a[href*="/job_detail/"]')?.href || card.link.href,
          bonus_contact: bonusContact, threshold });
        await refresh();
        if (recorded.bonus_message) {
          const runId = state.run.id;
          const report = (status) => api({ type: "BOSS_BONUS_DRAFT_RESULT",
            run_id: runId, job_id: row.job_id, status });
          phase = "bonus";
          render();
          try {
            await waitReady(row.job_id);
            await api({ type: "BOSS_OPEN_BONUS_CHAT", run_id: runId, job_id: row.job_id });
            const deadline = Date.now() + 30000;
            while (await api({ type: "BOSS_BONUS_PENDING", run_id: runId, job_id: row.job_id })) {
              if (stopWorkflow || scopeChanged() || Date.now() >= deadline) {
                await report(stopWorkflow || scopeChanged() ? "editor_interrupted" : "editor_timeout");
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
          } catch (cause) {
            debug("application:bonus_error", { job_id: row.job_id, reason: cause.message });
            if (await api({ type: "BOSS_BONUS_PENDING", run_id: runId, job_id: row.job_id }))
              await report("editor_error");
          }
          await refresh();
          if (stopWorkflow || scopeChanged()) break;
          phase = "applying";
          continue;
        }
      }
      let popup = { appeared: false, dismissed: true };
      if (!existing) {
        await api({
          type: "APPLICATION_RECORD", run_id: state.run.id,
          job_id: row.job_id, outcome: "opening", threshold,
        });
        await waitReady(row.job_id);
        adapter.clickElement(contact);
        popup = await adapter.dismissContactPopup(5000);
      }
      debug("application:bonus", {
        job_id: row.job_id, existing_contact: existing,
        enabled: state.allow_bonus_message === true,
        grounded_matches: validateBonusMatches(row.bonus_matches, {
          jd: row.jd_confirmed || row.jd_raw, profileText: state.profile?.text,
        }).length,
        prepare: wantsBonus,
      });
      debug("application:contact_popup", {
        job_id: row.job_id,
        appeared: popup.appeared,
        dismissed: popup.dismissed,
      });
      await api({
        type: "APPLICATION_RECORD",
        run_id: state.run.id,
        job_id: row.job_id,
        outcome: popup.reason ? "paused" : existing ? "already_contacted" : "contact_opened",
        prepare_bonus: false,
        bonus_contact: bonusContact,
        threshold,
        reason:
          popup.reason ||
          (popup.appeared && !popup.dismissed
            ? "沟通已触发，但结果弹窗无法关闭"
            : ""),
      });
      await refresh();
      if (popup.appeared && !popup.dismissed) {
        stopWorkflow = true;
        error =
          popup.reason || "沟通结果弹窗无法关闭，已暂停处理，请手动处理弹窗";
        state.run.status = "paused";
        state.run.stop_reason = error;
        await api({ type: "CLAIM", run_id: state.run.id });
        try {
          await api({ type: "SAVE_RUN", run: state.run });
        } finally {
          await api({ type: "RELEASE", run_id: state.run.id });
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  function scopeChanged() {
    return !!state.run && stableJSON(state.run.scope) !== stableJSON(adapter.scope());
  }

  async function prepareWorkflow() {
    await refresh();
    if (state.run?.bonus_review)
      throw new Error("请先处理聊天页的加分项草稿，再点击开始");
    if (!state.profile?.version) throw new Error("请先在“设置简历”中导入简历");
    if (!state.llm?.configured) {
      configurationError =
        state.llm?.error || "LLM 尚未配置，请在设置简历中选择模型并保存设置";
      throw new Error(configurationError);
    }
    const cities = selectedCities();
    if (!cities.length) throw new Error("请至少选择一个城市");
    let cityFilter = {
      selected: true,
      clicked: false,
      popup_seen: false,
      policy: "local-allowlist",
    };
    if (!isLiepin && cities.length === 1 && cities[0] === "深圳")
      cityFilter = {
        ...(await adapter.ensureCityFilter("深圳")),
        policy: "boss-city+local-allowlist",
      };
    debug("workflow:city_filter", cityFilter);
    if (!cityFilter.selected)
      throw new Error("请打开“技术经理(深圳)”预设，并在城市弹窗中选择深圳");
    const blocked = adapter.blockedReason();
    if (blocked) throw new Error(blocked);
    if (scopeChanged() && !stopWorkflow) {
      if (!isLiepin) throw new Error("BOSS 筛选范围与当前批次不同，请恢复原筛选或手动新建批次");
      await api({ type: "NEW_SCOPE_RUN", run_id: state.run.id, scope: adapter.scope() });
      currentApplications = 0;
      error = "";
      notice = "搜索范围已改变，已自动开启新批次；历史评分和已沟通记录保留";
      await refresh();
    }
    return cities;
  }

  async function startLiepinWorkflow(cities) {
    error = "";
    notice = "";
    phase = "collecting";
    const scope = adapter.scope();
    const guard = () => {
      if (stopWorkflow) throw new Error("用户已暂停");
      if (stableJSON(scope) !== stableJSON(adapter.scope()))
        throw new Error("搜索范围已改变，请新建批次");
      const reason = adapter.blockedReason();
      if (reason) throw new Error(reason);
    };
    const waitVisible = async () => {
      try {
        await waitForVisible(document, guard, {
          onWaiting: () => onVisibility(true),
        });
      } finally {
        onVisibility(false);
      }
    };
    try {
      guard();
      await waitVisible();
      const run = await api({
        type: "LIEPIN_BEGIN",
        scope,
        target: runTarget(),
      });
      // Refresh can replace state while begin is pending. Assign only after
      // awaiting, and discard stale refresh responses.
      ++stateRevision;
      state.run = run;
      let emptyRounds = 0;
      salarySkipped = new Set();
      const salaryFloor = () => {
        const floor = Number(state.prefs?.salary_min_k);
        return Number.isFinite(floor) && floor > 0 ? floor : null;
      };
      const meetsCardSalary = (item) => {
        const floor = salaryFloor();
        if (!floor || !adapter.cardSalary) return true;
        const salary = adapter.cardSalary(item);
        // Unknown card salary defers to the detail-stage check.
        return !salary?.max_k || salary.max_k >= floor;
      };
      while (
        !stopWorkflow &&
        (state.liepin_task || progress().matched < runTarget())
      ) {
        guard();
        await waitVisible();
        const task = state.liepin_task;
        const pending = (state.run.jobs || []).find(
          (job) => !liepinJobFinished(state.run, job.job_id),
        );
        const skipped = new Set(skipIds());
        let card = null;
        for (const item of adapter.cards()) {
          if (
            state.run.seen.includes(item.id) ||
            skipped.has(item.id) ||
            liepinJobFinished(state.run, item.id)
          )
            continue;
          const location = adapter.cardLocation(item);
          if (location && !locationMatchesCities(location, cities)) continue;
          if (!meetsCardSalary(item)) {
            salarySkipped.add(item.id);
            continue;
          }
          card = item;
          break;
        }
        const next = task
          ? { id: task.job_id, url: task.url }
          : pending
            ? { id: pending.job_id, url: pending.url }
            : card
              ? { id: card.id, url: card.link.href }
              : null;
        if (!next) {
          if (emptyRounds++ >= 3) {
            await api({
              type: "LIEPIN_FINISH",
              status: "exhausted",
              reason: "当前猎聘列表已耗尽，请刷新加载新职位后继续",
            });
            break;
          }
          await adapter.nextPageWithinResults(guard);
          continue;
        }
        emptyRounds = 0;
        currentTitle = card?.link.innerText || next.id;
        phase = "collecting";
        render();
        const result = await api({
          type: "LIEPIN_PROCESS",
          run_id: state.run.id,
          job_id: next.id,
          url: next.url,
          // Fresh cards carry the card title for LLM pre-screening; resumed
          // tasks and pending details already have (or need no) screening.
          title: task || pending ? "" : card?.link.innerText || "",
        });
        await refresh();
        if (result.status === "paused") {
          error = result.reason;
          if (!scopeChanged()) stopWorkflow = true;
          break;
        }
      }
      if (!stopWorkflow && !scopeChanged() && progress().matched >= runTarget())
        await api({ type: "LIEPIN_FINISH", status: "completed" });
      if (!state.run?.bonus_review)
        notice = `本批次已找到 ${progress().matched} 个达标职位`;
    } catch (cause) {
      error = cause.message;
      await api({ type: "LIEPIN_PAUSE", reason: error }).catch(() => {});
    }
  }

  async function startWorkflow() {
    if (workflowStarting || workflowActive) return;
    workflowActive = true;
    stopWorkflow = false;
    try {
      do {
        workflowStarting = true;
        render();
        let cities;
        try {
          if (targetSaveState !== "saved") await saveTarget();
          await targetSavePromise;
          cities = await prepareWorkflow();
        } finally {
          workflowStarting = false;
          render();
        }
        if (stopWorkflow) break;
        try {
          if (isLiepin) await startLiepinWorkflow(cities);
          else await startBossWorkflow(cities);
        } catch (cause) {
          if (!isLiepin || stopWorkflow || !scopeChanged() || adapter.blockedReason()) throw cause;
        }
        if (isBossChatURL(location.href)) return;
        await refresh();
        if (!isLiepin && !stopWorkflow && scopeChanged())
          throw new Error("BOSS 筛选范围已变化，已停止；请恢复原筛选或手动新建批次");
      } while (isLiepin && !stopWorkflow && scopeChanged() && !adapter.blockedReason());
    } finally {
      workflowStarting = false;
      workflowActive = false;
      phase = "idle";
      currentTitle = "";
      stopWorkflow = false;
      if (!isBossChatURL(location.href)) await refresh();
    }
  }

  async function startBossWorkflow(cities) {
    scoringAttempts.clear();
    error = "";
    notice = "";
    currentApplications = 0;
    phase = "collecting";
    currentTitle = "";
    debug("workflow:start", {
      run_id: state.run?.id || "",
      target: runTarget(),
      threshold: matchThreshold(),
      selected_cities: cities.join(","),
      skip_ids: skipIds().join(","),
    });
    render();
    try {
      if (!stopWorkflow) await scoreCollected();
      if (!stopWorkflow) await applyQualified();
      while (
        !stopWorkflow && !scopeChanged() &&
        (state.liepin_task || progress().matched < runTarget())
      ) {
        const before = processedCount(state.run);
        const beforeJobs = state.run?.jobs?.length || 0;
        const beforeAttempts = state.run?.attempts?.length || 0;
        phase = "collecting";
        currentTitle = "";
        render();
        bossTimer = new PhaseTimer({ site: "boss", run_id: state.run?.id || "",
          trace_id: crypto.randomUUID() }, (event, details) => debug(event, details));
        bossTimer.phase("collection");
        const run = await scanner.start(state.run, {
          ocr: true,
          target: runTarget(),
          selectedCities: cities,
          blacklistKeywords: state.prefs?.excluded_terms || [],
          companyBlacklistKeywords: state.prefs?.excluded_companies || [],
          skipIds: skipIds(),
          maxItems: 1,
          matchTarget: true,
        });
        state.run = run;
        if (scopeChanged()) break;
        Object.assign(bossTimer.context, { run_id: run.id, job_id: run.jobs.length > beforeJobs ? run.jobs.at(-1)?.job_id || "" : "" });
        bossTimer.phase("scoring");
        const after = processedCount(state.run);
        if (!stopWorkflow) {
          await scoreCollected();
          if (!stopWorkflow && !scopeChanged()) await applyQualified();
        }
        const madeProgress =
          (state.run?.jobs?.length || 0) > beforeJobs ||
          (state.run?.attempts?.length || 0) > beforeAttempts;
        bossTimer.finish(state.run.bonus_review ? "awaiting_bonus_review" : state.run.status);
        bossTimer = null;
        if (
          state.run.status === "exhausted" ||
          state.run.status === "blocked" ||
          (!madeProgress && after <= before)
        )
          break;
      }
      if (!stopWorkflow && state.run && !scopeChanged() && progress().matched >= runTarget()) {
        state.run.status = "completed";
        state.run.stop_reason = null;
        await api({ type: "CLAIM", run_id: state.run.id });
        try {
          await api({ type: "SAVE_RUN", run: state.run });
        } finally {
          await api({ type: "RELEASE", run_id: state.run.id });
        }
      }
      if (!stopWorkflow) {
        notice =
          currentApplications > 0
            ? `本轮已处理 ${currentApplications} 个达标职位`
            : "本轮没有新的达标职位";
      }
    } finally {
      bossTimer?.finish("interrupted");
      bossTimer = null;
    }
  }

  async function toggleWorkflow() {
    if (workflowActive) {
      stopWorkflow = true;
      phase = "pausing";
      debug("workflow:pause", { run_id: state.run?.id || "" });
      if (isLiepin) await api({ type: "LIEPIN_PAUSE" });
      else await scanner.pause();
      render();
      return;
    }
    if (state.run?.bonus_review) {
      await api({
        type: isLiepin ? "LIEPIN_CONFIRM_BONUS_REVIEW" : "BOSS_CONFIRM_BONUS_REVIEW",
        run_id: state.run.id,
        job_id: state.run.bonus_review.job_id,
      });
      await refresh();
    }
    await startWorkflow();
  }

  async function retryFailed() {
    const captureFailures = failedJobs(state.run).length;
    const scoringFailures = Object.keys(state.run?.score_failures || {}).length;
    if (!captureFailures && !scoringFailures)
      throw new Error("当前没有失败职位");
    await api({ type: "RETRY_FAILED" });
    await refresh();
    await startWorkflow();
  }

  async function newBatch() {
    if (workflowActive) throw new Error("请先暂停");
    await api({ type: "NEW_RUN" });
    currentApplications = 0;
    notice = "新批次已创建；历史分数和已沟通记录会继续复用";
    await refresh();
  }

  function bar(done, total, width = 20) {
    const ratio = total ? Math.min(1, Math.max(0, done / total)) : 0;
    const filled = Math.round(ratio * width);
    return `[${"#".repeat(filled)}${".".repeat(width - filled)}]`;
  }

  function statusLine() {
    if (phase === "pausing") return "PAUSING";
    if (state.run?.bonus_review) return "PREPARING / 填入加分项草稿";
    if (phase === "recovering") return "RECOVERING / 自动恢复";
    if (visibilityWaitStarted !== null)
      return `WAITING / 等待前台 ${Math.floor((Date.now() - visibilityWaitStarted) / 1000)}s`;
    if (phase === "collecting") return "COLLECTING";
    if (phase === "scoring") return `AI SCORING ${scoringDone}/${scoringTotal}`;
    if (phase === "applying") return "APPLYING";
    if (phase === "bonus") return "PREPARING / 填入加分项草稿";
    if (state.run?.status === "completed" && progress().matched < runTarget())
      return "PAUSED";
    const labels = {
      idle: "IDLE",
      running: "RUNNING",
      paused: "PAUSED",
      completed: "COMPLETED",
      exhausted: "EXHAUSTED",
      blocked: "BLOCKED",
    };
    return labels[state.run?.status] || "IDLE";
  }

  function failedCount(run) {
    return (
      failedJobs(run).length + Object.keys(run?.score_failures || {}).length
    );
  }

  function pre(text, cls = "ascii") {
    return el("pre", text, cls);
  }

  function render() {
    // Retain the actual input node across progress/configuration renders.
    const targetFocused = shadow.activeElement === targetInput;
    body.replaceChildren();
    const run = state.run;
    const target = run?.target || runTarget();
    const {
      matched: done,
      skipped,
      title: titleSkipped,
      blacklist,
    } = progress();
    body.append(
      pre(
        [
          `+-- JSEEKER // ${isLiepin ? "LIEPIN" : "BOSS"} MATCH PIPELINE --+`,
          "| SCORE FILTER                         |",
        ].join("\n"),
      ),
    );
    const thresholdLine = el("div", undefined, "ascii-control");
    thresholdLine.append(el("span", "| >=", "ascii-prefix"));
    const threshold = el("input");
    threshold.type = "number";
    threshold.min = "0";
    threshold.max = "100";
    threshold.step = "1";
    threshold.value = String(matchThreshold());
    threshold.setAttribute("aria-label", "匹配阈值");
    threshold.disabled = workflowActive;
    threshold.onchange = async () => {
      const value = Number(threshold.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        error = "匹配阈值须为0到100";
        render();
        return;
      }
      state.match_threshold = await api({
        type: "SET_MATCH_THRESHOLD",
        threshold: value,
      });
      render();
    };
    thresholdLine.append(threshold, el("span", " |", "ascii-prefix"));
    body.append(thresholdLine);
    const salaryLine = el("div", undefined, "ascii-control");
    salaryLine.append(el("span", "| SAL>=", "ascii-prefix"));
    const salaryInput = el("input");
    salaryInput.type = "number";
    salaryInput.min = "0";
    salaryInput.max = "1000";
    salaryInput.step = "1";
    salaryInput.placeholder = "off";
    salaryInput.value =
      state.prefs?.salary_min_k == null ? "" : String(state.prefs.salary_min_k);
    salaryInput.setAttribute("aria-label", "薪资底线（K）");
    salaryInput.disabled = workflowActive;
    salaryInput.onchange = async () => {
      const raw = salaryInput.value.trim();
      const value = raw === "" ? null : Number(raw);
      if (
        value !== null &&
        (!Number.isFinite(value) || value < 0 || value > 1000)
      ) {
        error = "薪资底线须为0到1000K";
        render();
        return;
      }
      try {
        state.prefs ??= {};
        state.prefs.salary_min_k = await api({
          type: "SET_SALARY_MIN",
          salary_min_k: value,
        });
      } catch (cause) {
        error = cause.message;
      }
      render();
    };
    salaryLine.append(salaryInput, el("span", " K |", "ascii-prefix"));
    body.append(salaryLine);
    {
      const options = el("div", undefined, "bonus-message-options");
      const option = el("label", undefined, "bonus-message-option");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.allow_bonus_message === true;
      checkbox.disabled = workflowActive;
      checkbox.setAttribute("aria-label", "允许追加加分项消息");
      checkbox.onchange = async () => {
        try {
          state.allow_bonus_message = await api({ type: "SET_ALLOW_BONUS_MESSAGE", enabled: checkbox.checked });
        } catch (cause) { error = cause.message; }
        render();
      };
      option.append(checkbox, el("span", "允许追加加分项消息"));
      option.title = "填入草稿后自动返回列表继续；无法填入时保留原文、记录原因并继续";
      const autoOption = el("label", undefined, "bonus-message-option");
      const autoSend = el("input");
      autoSend.type = "checkbox";
      autoSend.checked = state.auto_send_bonus_message === true;
      autoSend.disabled = workflowActive || state.allow_bonus_message !== true;
      autoSend.setAttribute("aria-label", "自动发送加分项消息");
      autoSend.onchange = async () => {
        try {
          state.auto_send_bonus_message = await api({ type: "SET_AUTO_SEND_BONUS_MESSAGE", enabled: autoSend.checked });
        } catch (cause) { error = cause.message; }
        render();
      };
      autoOption.append(autoSend, el("span", "自动发送"));
      autoOption.title = "开启后自动发送已核实的加分项消息；关闭时仅留草稿，均继续批次";
      options.append(option, autoOption);
      if (!isLiepin) {
        const replyOption = el("label", undefined, "bonus-message-option");
        const reply = el("input");
        reply.type = "checkbox";
        reply.checked = state.auto_reply_messages === true;
        reply.setAttribute("aria-label", "自动回复消息");
        reply.onchange = async () => {
          try {
            state.auto_reply_messages = await api({ type: "SET_AUTO_REPLY_MESSAGES", enabled: reply.checked });
          } catch (cause) { error = cause.message; }
          render();
        };
        replyOption.append(reply, el("span", "自动回复消息"));
        replyOption.title = "在 BOSS 聊天页筛选未读：拒绝消息自动已读；索要简历时发送中文附件，不调用 LLM";
        options.append(replyOption);
      }
      body.append(options);
    }
    const selected = selectedCities();
    const cityFilter = el("details", undefined, "city-filter");
    cityFilter.setAttribute("aria-label", "城市筛选");
    const citySummary = el(
      "summary",
      `| CITY FILTER [${selected.join(", ") || "none"}]`,
    );
    const cityOptions = el("div", undefined, "city-options");
    for (const city of MAJOR_CITIES) {
      const option = el("label");
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.value = city;
      checkbox.checked = selected.includes(city);
      checkbox.disabled = workflowActive;
      checkbox.setAttribute("aria-label", city);
      checkbox.onchange = async () => {
        const next = new Set(selectedCities());
        if (checkbox.checked) next.add(city);
        else next.delete(city);
        try {
          state.selected_cities = await api({
            type: "SET_SELECTED_CITIES",
            cities: [...next],
          });
          citySummary.textContent = `| CITY FILTER [${state.selected_cities.join(", ") || "none"}]`;
        } catch (cause) {
          checkbox.checked = !checkbox.checked;
          error = cause.message;
        }
      };
      option.append(checkbox, el("span", city));
      cityOptions.append(option);
    }
    cityFilter.append(citySummary, cityOptions);
    body.append(cityFilter);

    body.append(
      pre(
        [
          "+--------------------------------------+",
          `| CHECKED ${processedCount(run)} / MATCHED ${done}`,
          `| RUN     ${done}/${target} (SKIP:${skipped}, TITLE:${titleSkipped}, SAL:${salarySkipped?.size || 0}, BLACKLIST:${blacklist})`,
          `| STATE   ${statusLine()}`,
          `| PROGRESS ${bar(done, target)} ${String(Math.round((target ? done / target : 0) * 100)).padStart(3)}%`,
          "+--------------------------------------+",
        ].join("\n"),
      ),
    );
    if (currentTitle || state.run?.current?.title) {
      const title = currentTitle || state.run.current.title;
      body.append(pre(`| NOW     ${String(title).slice(0, 27)}`));
    }
    const controls = el("div", undefined, "controls");
    controls.append(
      button(
        workflowStarting ? "检查配置…" : workflowActive ? "暂停" : "开始",
        toggleWorkflow,
        {
          primary: true,
          disabled: workflowStarting,
        },
      ),
      button("重试失败", retryFailed, {
        disabled: workflowStarting || workflowActive || !!run?.bonus_review || !failedCount(state.run),
      }),
      button("新批次", newBatch, {
        disabled: workflowStarting || workflowActive || !!run?.bonus_review,
      }),
    );
    body.append(controls);
    body.append(pre("+--------------------------------------+"));
    const countLine = el("div", undefined, "ascii-control count-control");
    countLine.append(el("span", "| RUN COUNT", "ascii-prefix"));
    targetInput.type = "number";
    targetInput.min = "1";
    targetInput.removeAttribute("max");
    targetInput.step = "1";
    if (!targetFocused && targetSaveState === "saved")
      targetInput.value = String(runTarget());
    targetInput.setAttribute("aria-label", "运行数量");
    targetInput.disabled = workflowActive;
    targetInput.oninput = () => {
      clearTimeout(targetSaveTimer);
      targetRevision++;
      const value = Number(targetInput.value);
      if (
        !targetInput.value.trim() ||
        !Number.isSafeInteger(value) ||
        value < 1
      ) {
        targetSaveState = "invalid";
        targetStatus.textContent = " invalid";
        return;
      }
      targetSaveState = "saving";
      targetStatus.textContent = " saving";
      targetSaveTimer = setTimeout(() => {
        saveTarget().catch((cause) => {
          error = cause.message;
          render();
        });
      }, 300);
    };
    const targetStatus = el("span", ` ${targetSaveState}`, "ascii-prefix");
    countLine.append(targetInput, targetStatus);
    body.append(countLine);
    const exportLine = el("div", undefined, "export-row");
    exportLine.append(
      button("导出 CSV", exportCSV, {
        disabled:
          workflowActive ||
          (!run?.jobs?.length && !Object.keys(state.job_index || {}).length),
      }),
    );
    body.append(exportLine);
    if (visibilityWaitStarted !== null)
      body.append(el("p", "等待列表页回到前台，返回后自动继续", "notice"));
    if (run?.bonus_review) {
      body.append(el("p", run.stop_reason || "正在填入加分项草稿，随后自动继续", "notice"));
      if (run.bonus_review.site === "boss") {
        body.append(button("打开加分项草稿", async () => {
          await api({ type: "BOSS_OPEN_BONUS_CHAT", run_id: run.id,
            job_id: run.bonus_review.job_id });
        }));
      }
    } else if (notice) body.append(el("p", notice, "notice"));
    if (!isLiepin && state.allow_bonus_message === true && !run?.bonus_review) {
      const selected = rows().find((row) => row.job_id === adapter.detailId());
      if (selected?.engine === "llm" && !groundedBonusText(selected))
        body.append(el("p", "未追加消息：评分结果没有可由简历原文核实的加分项匹配。职位总分达标不会单独触发追加消息。", "notice"));
    }
    const scoreFailures = scoringFailures(run);
    if (scoreFailures.length)
      body.append(el("p", scoringFailureText(run), "error"));
    if (error && !scoreFailures.some((failure) => error.includes(failure.reason)))
      body.append(el("p", error, "error"));
    if (targetFocused && !targetInput.disabled)
      targetInput.focus({ preventScroll: true });
    paintBadges();
  }

  const badgeStyle = document.createElement("style");
  badgeStyle.textContent = `
    .jseeker-card{position:relative!important}
    .jseeker-badge{
      position:absolute!important;left:0!important;top:6px!important;
      transform:translateX(-104%);min-width:38px;padding:4px 5px!important;
      text-align:center;background:#0b2f33!important;color:#e8fffb!important;
      font:700 13px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace!important;
      border:1px solid #6fa8a2!important;border-radius:5px!important;
      z-index:10;cursor:pointer;box-shadow:none!important;
    }
    @media(max-width:950px){
      .jseeker-badge{
        left:auto!important;right:5px!important;top:auto!important;
        bottom:5px!important;transform:none!important;
      }
    }
  `;
  document.head.append(badgeStyle);

  function paintBadges() {
    for (const card of adapter.cards()) {
      card.el.classList.add("jseeker-card");
      let badge = card.el.querySelector(".jseeker-badge");
      if (!badge) {
        badge = el("button", undefined, "jseeker-badge");
        badge.type = "button";
        badge.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          panel.hidden = false;
        };
        card.el.append(badge);
      }
      const raw = state.run?.jobs?.find((job) => job.job_id === card.id);
      const score = raw ? mergeRunScore(raw) : validIndexedScore(card.id);
      const captureFailure = failedJobs(state.run).find(
        (attempt) => attempt.job_id === card.id,
      );
      const scoreFailure = state.run?.score_failures?.[card.id];
      let text = "--";
      const blacklistKeyword = raw ? blacklistMatch(raw) : "";
      if (blacklistKeyword) text = "跳过";
      else if (score?.match_score != null || score?.score != null)
        text = String(Math.round(Number(score.match_score ?? score.score)));
      else if (workflowActive && state.run?.current?.job_id === card.id)
        text = "...";
      else if (captureFailure || scoreFailure) text = "!";
      if (badge.textContent !== text) badge.textContent = text;
      badge.title = blacklistKeyword
        ? `命中黑名单：${blacklistKeyword}`
        : score
          ? `LLM 匹配分 ${text}`
          : contacted(card.id)
            ? "已沟通，后续批次将跳过"
            : captureFailure
              ? `采集失败：${captureFailure.reason}`
              : scoreFailure
                ? `AI 评分失败：${scoreFailure.reason}`
                : "尚未评分";
    }
  }

  let badgeTimer;
  new MutationObserver((mutations) => {
    if (
      mutations.every((mutation) =>
        mutation.target.closest?.("#jseeker-root,.jseeker-badge"),
      )
    )
      return;
    if (isLiepin && workflowActive && !stopWorkflow) {
      const reason = adapter.blockedReason();
      if (reason) {
        stopWorkflow = true;
        phase = "pausing";
        error = reason;
        api({ type: "LIEPIN_PAUSE", reason }).catch(() => {});
        render();
      }
    }
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(paintBadges, 150);
  }).observe(document.body, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === "AUTO_REPLY_MESSAGES_CHANGED" && !isLiepin) {
      state.auto_reply_messages = message.enabled === true;
      render();
      respond({ ok: true });
    }
    if (message.type === "BLACKLIST_CHANGED") {
      state.prefs = message.prefs;
      applyRunBlacklist(
        state.run,
        state.prefs?.excluded_terms || [],
        state.prefs?.excluded_companies || [],
      );
      render();
      respond({ ok: true });
    }
    if (message.type === "LLM_CONFIG_CHANGED") {
      state.llm = message.status;
      clearResolvedConfigurationError();
      render();
      respond({ ok: true });
    }
    if (message.type === "TOGGLE") {
      restorePanel.hidden = true;
      panel.hidden = false;
      refresh().catch((cause) => {
        error = cause.message;
        render();
      });
      respond({ ok: true });
    }
    if (message.type === "LIEPIN_PROGRESS" && isLiepin && workflowActive) {
      phase =
        message.stage === "scoring"
          ? "scoring"
          : ["preparing_contact", "confirming_contact"].includes(message.stage)
            ? "applying"
            : "collecting";
      scoringDone = 0;
      scoringTotal = 1;
      render();
      respond({ ok: true });
    }
    if (message.type === "LIEPIN_VERIFY_SCOPE")
      respond({
        ok:
          workflowActive &&
          !stopWorkflow &&
          !adapter.blockedReason() &&
          state.run?.id === message.run_id &&
          stableJSON(adapter.scope()) === stableJSON(state.run?.scope),
      });
    if (message.type === "BOSS_VERIFY_BONUS_SCOPE")
      respond({ ok: !isLiepin && workflowActive && !stopWorkflow && !scopeChanged() &&
        state.run?.id === message.run_id && state.run?.bonus_review?.job_id === message.job_id });
    if (message.type === "VERIFY_ID")
      respond({
        ok: adapter.detailId() === message.job_id && !document.hidden,
      });
  });

  render();
  try {
    let recovery = await api({ type: "RECOVER" });
    await refresh();
    if (isLiepin && recovery?.resume) {
      // A page reload may leave the old worker request finishing. Wait for its
      // cancellation before resuming; manual pause always cancels this intent.
      workflowActive = true;
      stopWorkflow = false;
      phase = "recovering";
      notice = "正在恢复未完成的猎聘任务；可点击暂停取消";
      render();
      try {
        while (recovery.pending && !stopWorkflow) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!stopWorkflow) recovery = await api({ type: "RECOVER" });
        }
      } finally {
        workflowActive = false;
        phase = "idle";
        render();
      }
      if (recovery.resume && !stopWorkflow) await startWorkflow();
    }
  } catch (cause) {
    if (isLiepin && state.run?.recovering)
      await api({ type: "LIEPIN_PAUSE", reason: cause.message }).catch(() => {});
    error = cause.message;
    render();
  }
}
