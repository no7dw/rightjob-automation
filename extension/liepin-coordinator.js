import { initialRun } from "./store.js";
import { isListPage, liepinIdentity, siteForURL } from "./sites.js";
import { stableJSON, locationMatchesCities } from "./core.js";
import {
  validateCheckpoint,
  contactBlockers,
  isComplete,
} from "./run-state.js";
import { companyBlacklistMatch, jobBlacklistMatch } from "./blacklist.js";
import { contactRecord, jobFingerprint } from "./job-history.js";
import { bonusMessage, validateBonusMatches } from "./bonus-message.js";
import { PhaseTimer } from "./timing.js";

const criteriaKey = (state) =>
  stableJSON({
    profile: state.profile?.version,
    model: state.llm_model || "",
    reasoning_effort: state.llm_reasoning_effort || "auto",
    base_url: state.llm_base_url || "",
    prefs: state.prefs,
    cities: state.selected_cities,
    threshold: state.match_threshold,
  });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transientError = (error) =>
  [408, 429, 500, 502, 503, 504].includes(error.status) ||
  /超时|timeout|network|fetch|ECONN|temporarily unavailable|service unavailable|overloaded|HTTP (408|429|5\d\d)|JSON|返回内容为空|missing choices|LLM 匹配分|LLM 没有返回内容/i.test(
    error.message || "",
  );
const jobError = (error) => Object.assign(error, { jobLocal: true });
const terminal = new Set([
  "contact_opened",
  "already_contacted",
  "below_threshold",
  "blacklist",
  "rejected",
  "city_skipped",
  "title_skipped",
  "review_required",
  "failed",
]);
export const liepinJobFinished = (run, id) =>
  terminal.has(run?.applications?.[id]?.status);

export class LiepinCoordinator {
  constructor(browser, { serial, score, screen = null, log = () => {} }) {
    this.browser = browser;
    this.serial = serial;
    this.score = score;
    this.screen = screen;
    this.log = log;
    this.busy = false;
    this.screenAbort = null;
  }
  async change(fn, keys = null) {
    return this.serial(async () => {
      const state = await this.browser.storage.local.get(keys || [
        "run",
        "lease",
        "liepin_task",
        "prefs",
        "contacted_jobs",
        "job_index",
        "match_threshold",
        "selected_cities",
        "profile",
        "llm_model",
        "llm_reasoning_effort",
        "llm_base_url",
        "title_screen",
        "allow_bonus_message",
        "auto_send_bonus_message",
      ]);
      const writable = ["run", "lease", "liepin_task", "contacted_jobs", "job_index", "title_screen"]
        .filter(key => !keys || keys.includes(key));
      const before = Object.fromEntries(writable.map(key => [key, JSON.stringify(state[key])]));
      for (const key of writable)
        state[key] ??= ["run", "lease", "liepin_task"].includes(key) ? null : {};
      const result = await fn(state);
      const patch = Object.fromEntries(writable
        .filter(key => before[key] !== JSON.stringify(state[key]))
        .map(key => [key, state[key] ?? (["run", "lease", "liepin_task"].includes(key) ? null : {})]));
      if (Object.keys(patch).length) await this.browser.storage.local.set(patch);
      return result;
    });
  }
  async begin(sender, scope, target) {
    if (this.busy) throw new Error("猎聘任务仍在处理中");
    if (
      !isListPage(sender.url) ||
      siteForURL(sender.url) !== "liepin" ||
      scope.site !== "liepin"
    )
      throw new Error("请在猎聘列表页开始");
    return this.change(async (s) => {
      if (s.lease && s.lease.tab !== sender.tab.id) {
        const tab = await this.browser.tabs.get(s.lease.tab).catch(() => null);
        if (tab) throw new Error("另一职位标签页正在运行，请先暂停");
      }
      if (s.run && stableJSON(s.run.scope) !== stableJSON(scope))
        throw new Error("搜索范围或网站已改变，请新建批次");
      // Checkpoints are obsolete: stale reviews from older builds just clear.
      delete s.run?.bonus_review;
      s.run ||= initialRun(scope, target);
      s.run.status = "running";
      s.run.resume_on_reload = true;
      delete s.run.recovering;
      s.run.stop_reason = null;
      s.lease = { tab: sender.tab.id, run_id: s.run.id };
      return s.run;
    });
  }
  assertOwner(s, sender, runId) {
    if (
      s.run?.id !== runId ||
      s.run.scope?.site !== "liepin" ||
      s.lease?.tab !== sender.tab.id ||
      s.lease.run_id !== runId
    )
      throw new Error("猎聘批次或运行标签页已改变");
  }
  async assertTask(taskId, { loading = false } = {}) {
    const s = await this.browser.storage.local.get([
      "run",
      "lease",
      "liepin_task",
    ]);
    const task = s.liepin_task;
    if (
      !task ||
      task.id !== taskId ||
      task.cancelled ||
      s.run?.id !== task.run_id ||
      s.lease?.tab !== task.parent_tab
    )
      throw new Error("猎聘任务已暂停或失效");
    const tab = await this.browser.tabs.get(task.child_tab);
    if (
      liepinIdentity(tab.url)?.job_id !== task.job_id &&
      liepinIdentity(tab.pendingUrl)?.job_id !== task.job_id &&
      !(loading && (!tab.url || tab.url === "about:blank"))
    )
      throw new Error(`受控详情页已关闭或跳转（${tab.url || "尚未加载"}）`);
    const parent = await this.browser.tabs.get(task.parent_tab);
    if (!isListPage(parent.url) || siteForURL(parent.url) !== "liepin")
      throw new Error("猎聘列表页已关闭或跳转");
    return task;
  }
  async stage(taskId, stage) {
    await this.change((s) => {
      if (s.liepin_task?.id !== taskId || s.liepin_task.cancelled)
        throw new Error("猎聘任务已暂停或失效");
      s.liepin_task.stage = stage;
      s.liepin_task.updated_at = new Date().toISOString();
      s.run.current = { job_id: s.liepin_task.job_id, status: stage };
    }, ["run", "liepin_task"]);
    const { liepin_task: task } =
      await this.browser.storage.local.get("liepin_task");
    this.log("liepin:stage", {
      site: "liepin",
      run_id: task?.run_id || "",
      job_id: task?.job_id || "",
      task_id: taskId,
      stage,
    });
    if (task?.id === taskId)
      await this.browser.tabs
        .sendMessage(task.parent_tab, {
          type: "LIEPIN_PROGRESS",
          stage,
          job_id: task.job_id,
        })
        .catch(() => {});
  }
  async pause(sender, reason = "用户已暂停") {
    const paused = await this.change((s) => {
      if (
        s.lease?.tab !== sender.tab.id &&
        s.liepin_task?.parent_tab !== sender.tab.id
      )
        return false;
      if (s.liepin_task) s.liepin_task.cancelled = true;
      if (s.run?.scope?.site === "liepin") {
        s.run.status = "paused";
        s.run.resume_on_reload = false;
        delete s.run.recovering;
        s.run.stop_reason = reason;
      }
      return true;
    });
    if (paused) this.screenAbort?.abort();
    return paused;
  }
  async recover(sender) {
    return this.change((s) => {
      delete s.run?.bonus_review;
      if (
        (s.liepin_task && s.liepin_task.parent_tab !== sender.tab.id) ||
        (s.lease && s.lease.tab !== sender.tab.id)
      )
        return { resume: false };
      if (
        s.run?.scope?.site === "liepin" &&
        (s.run.status === "running" || s.liepin_task || s.run.recovering)
      ) {
        const resume =
          s.run.resume_on_reload === true && !s.liepin_task?.contact_clicked;
        s.run.status = "paused";
        s.run.recovering = resume;
        s.run.stop_reason = resume
          ? "页面刷新或扩展重启，正在恢复未完成职位"
          : "页面刷新或扩展重启，请手动恢复";
        if (s.liepin_task) {
          s.liepin_task.cancelled = true;
          s.liepin_task.recovering = resume;
        }
        if (!this.busy)
          s.lease = resume ? { tab: sender.tab.id, run_id: s.run.id } : null;
        return { resume, pending: this.busy };
      }
      return { resume: false };
    });
  }
  async authorize(sender, message) {
    const current = await this.assertTask(message.task_id);
    const owner = await this.browser.tabs.sendMessage(current.parent_tab, {
      type: "LIEPIN_VERIFY_SCOPE",
      run_id: current.run_id,
    });
    if (!owner?.ok) throw new Error("列表流程已暂停或搜索范围已改变");
    return this.change((s) => {
      const task = s.liepin_task;
      if (
        task?.id !== message.task_id ||
        task.child_tab !== sender.tab.id ||
        task.job_id !== message.job_id ||
        liepinIdentity(sender.url)?.job_id !== task.job_id ||
        task.cancelled ||
        task.stage !== "preparing_contact" ||
        task.contact_clicked
      )
        throw new Error("沟通授权已失效");
      if (task.criteria_key !== criteriaKey(s))
        throw new Error("简历、模型或筛选条件已改变，请恢复后重新评分");
      const raw = s.run.jobs.find((job) => job.job_id === task.job_id);
      const score = s.run.scores[task.job_id];
      if (
        !raw ||
        !score ||
        score.profile_version !== s.profile?.version ||
        score.match_score < (s.match_threshold ?? 75) ||
        score.eligibility?.status === "reject" ||
        jobBlacklistMatch(raw, s.prefs?.excluded_terms) ||
        companyBlacklistMatch(raw, s.prefs?.excluded_companies) ||
        !locationMatchesCities(raw.location_raw, s.selected_cities || []) ||
        contactBlockers({ ...raw, ...score }, s.run).length
      )
        throw new Error("职位评分或筛选条件已改变，已暂停沟通");
      task.contact_clicked = true;
      task.stage = "confirming_contact";
      const bonusText = s.allow_bonus_message === true
        ? bonusMessage(validateBonusMatches(score.bonus_matches, {
            jd: raw.jd_raw, profileText: s.profile?.text,
          }))
        : "";
      return { bonus_message: bonusText, bonus_auto_send: !!bonusText && s.auto_send_bonus_message === true };
    });
  }
  async authorizeBonusSend(sender, message) {
    return this.change((s) => {
      const task = s.liepin_task;
      if (!task || task.id !== message.task_id || task.job_id !== message.job_id ||
          task.child_tab !== sender.tab.id || liepinIdentity(sender.url)?.job_id !== task.job_id ||
          task.cancelled || task.stage !== "confirming_contact" || !task.contact_clicked || task.bonus_send_attempted ||
          task.criteria_key !== criteriaKey(s) || s.allow_bonus_message !== true || s.auto_send_bonus_message !== true)
        return false;
      task.bonus_send_attempted = true;
      return true;
    });
  }
  async confirmBonusReview(sender, message) {
    if (this.busy) throw new Error("请等待当前猎聘职位处理完成");
    return this.change(async (s) => {
      const review = s.run?.bonus_review;
      if (
        !isListPage(sender.url) || siteForURL(sender.url) !== "liepin" ||
        !review || s.run.id !== message.run_id || review.job_id !== message.job_id
      )
        throw new Error("待确认的加分项消息已变化，请刷新后检查");
      if (
        s.lease && s.lease.tab !== sender.tab.id &&
        await this.browser.tabs.get(s.lease.tab).catch(() => null)
      )
        throw new Error("请在原猎聘列表页确认发送");
      const at = new Date().toISOString();
      for (const record of [
        s.run.applications[review.job_id], s.contacted_jobs?.[review.job_id],
      ]) {
        if (record?.bonus_draft) {
          record.bonus_draft.review_status = "human_confirmed";
          record.bonus_draft.confirmed_at = at;
        }
      }
      delete s.run.bonus_review;
      s.run.stop_reason = null;
      s.lease = { tab: sender.tab.id, run_id: s.run.id };
      return s.run;
    });
  }
  async read(task) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.readOnce(task);
      } catch (error) {
        if (error.pause) throw error;
        await this.assertTask(task.id);
        if (attempt || !this.browser.tabs.reload) throw jobError(error);
        await this.stage(task.id, "reloading");
        this.log("liepin:retry", {
          job_id: task.job_id,
          stage: "loading",
          reason: error.message,
        });
        await this.browser.tabs.reload(task.child_tab);
      }
    }
  }
  async readOnce(task) {
    const deadline = Date.now() + 20000;
    let lastError;
    let injected = false;
    while (Date.now() < deadline) {
      await this.assertTask(task.id, { loading: true });
      try {
        const response = await this.browser.tabs.sendMessage(task.child_tab, {
          type: "LIEPIN_READ",
          job_id: task.job_id,
          task_id: task.id,
        });
        if (response?.ok && response.data?.status === "paused")
          throw Object.assign(new Error(response.data.reason), { pause: true });
        if (response?.ok && response.data?.job) return response.data;
        lastError = response?.error;
      } catch (error) {
        if (error.pause) throw error;
        lastError = error.message;
      }
      if (!injected && this.browser.scripting) {
        const tab = await this.browser.tabs.get(task.child_tab);
        if (
          tab.status === "complete" &&
          liepinIdentity(tab.url)?.job_id === task.job_id
        ) {
          // Reloading the extension invalidates old content-script contexts.
          await this.browser.scripting.executeScript({
            target: { tabId: task.child_tab },
            files: ["liepin-detail.js"],
          });
          injected = true;
        }
      }
      await wait(300);
    }
    throw new Error(lastError || "猎聘详情加载超时");
  }
  async finish(sender, status, reason = null) {
    if (this.busy) throw new Error("请等待当前猎聘职位处理完成");
    return this.change((s) => {
      this.assertOwner(s, sender, s.run?.id);
      if (!["completed", "exhausted", "paused"].includes(status))
        throw new Error("无效批次状态");
      s.run.status = status;
      s.run.resume_on_reload = false;
      delete s.run.recovering;
      s.run.stop_reason = reason;
      s.run.current = null;
      s.lease = null;
      return s.run;
    });
  }
  // LLM pre-screen on the card title: skip clearly mismatched jobs before
  // spending a detail-page visit and a full scoring request on them.
  async applyTitleScreen(sender, message, identity) {
    // Title pre-screen is opt-in; the default off opens every card directly.
    const { title_screen_enabled = false } =
      await this.browser.storage.local.get("title_screen_enabled");
    if (!title_screen_enabled) return true;
    const title =
      typeof message.title === "string"
        ? message.title.trim().slice(0, 80)
        : "";
    if (!title || !this.screen) return true;
    const snapshot = await this.change((s) => {
      this.assertOwner(s, sender, message.run_id);
      if (s.run.status !== "running") throw new Error("猎聘任务已暂停");
      if (s.liepin_task || liepinJobFinished(s.run, identity.job_id))
        return { open: true };
      const criteria = criteriaKey(s);
      const cached = s.title_screen?.[identity.job_id];
      if (cached && cached.criteria === criteria) {
        if (!cached.open)
          this.recordTitleSkip(s, identity.job_id, cached.reason);
        return { open: cached.open };
      }
      return { criteria };
    });
    if ("open" in snapshot) return snapshot.open;
    let open = true;
    let reason = "";
    let failed = false;
    const abort = new AbortController();
    this.screenAbort = abort;
    try {
      const results = await this.screen(
        [{ id: identity.job_id, title }],
        abort.signal,
        message.timing,
      );
      const entry = results.find((item) => item.id === identity.job_id);
      if (entry && typeof entry.open === "boolean") {
        open = entry.open;
        reason = entry.reason || "";
      }
    } catch (error) {
      failed = true;
      this.log("screen:error", {
        site: "liepin",
        run_id: message.run_id,
        job_id: identity.job_id,
        error: error.message,
      });
    } finally {
      if (this.screenAbort === abort) this.screenAbort = null;
    }
    return this.change((s) => {
      this.assertOwner(s, sender, message.run_id);
      if (s.run.status !== "running") throw new Error("猎聘任务已暂停");
      if (snapshot.criteria !== criteriaKey(s))
        throw new Error("预筛期间筛选条件已改变，请恢复后重试");
      if (failed) return true;
      const criteria = snapshot.criteria;
      s.title_screen ??= {};
      s.title_screen[identity.job_id] = {
        open,
        reason,
        criteria,
        at: new Date().toISOString(),
      };
      const ids = Object.keys(s.title_screen);
      if (ids.length > 800)
        for (const staleId of ids
          .sort((a, b) =>
            (s.title_screen[a].at || "").localeCompare(
              s.title_screen[b].at || "",
            ),
          )
          .slice(0, ids.length - 800))
          delete s.title_screen[staleId];
      if (!open) this.recordTitleSkip(s, identity.job_id, reason);
      return open;
    });
  }

  recordTitleSkip(s, jobId, reason) {
    // run.seen must stay equal to run.jobs ids (checkpoint invariant), and a
    // title-skipped job never gets a raw record; the applications entry alone
    // marks it finished (liepinJobFinished) for the list loop.
    s.run.applications[jobId] = {
      status: "title_skipped",
      reason: reason || "标题预筛与简历不匹配，已跳过详情页",
      at: new Date().toISOString(),
    };
    this.log("screen:skip", {
      site: "liepin",
      run_id: s.run?.id || "",
      job_id: jobId,
    });
  }

  async process(sender, message) {
    if (this.busy) throw new Error("已有猎聘职位正在处理");
    const identity = liepinIdentity(message.url);
    if (!identity || identity.job_id !== message.job_id)
      throw new Error("无效猎聘职位链接");
    this.busy = true;
    let task;
    message = { ...message, timing: { site: "liepin", run_id: message.run_id,
      job_id: message.job_id, trace_id: crypto.randomUUID() } };
    const timer = new PhaseTimer(message.timing, (event, details) => this.log(event, details));
    let timingStatus = "interrupted";
    // Extension API calls keep a long scoring request alive in MV3.
    const heartbeat = setInterval(
      () => this.browser.tabs.get(sender.tab.id).catch(() => {}),
      20000,
    );
    try {
      timer.phase("title_screen");
      if (!(await this.applyTitleScreen(sender, message, identity))) {
        timingStatus = "title_skipped";
        return { status: "skipped" };
      }
      timer.phase("task_setup");
      task = await this.change(async (s) => {
        this.assertOwner(s, sender, message.run_id);
        if (s.run.status !== "running") throw new Error("猎聘任务已暂停");
        const previous = s.liepin_task;
        if (previous && previous.job_id !== identity.job_id)
          throw new Error("请先恢复当前未完成的猎聘职位");
        if (liepinJobFinished(s.run, identity.job_id) && !previous) return null;
        const next = {
          ...identity,
          id: crypto.randomUUID(),
          run_id: s.run.id,
          parent_tab: sender.tab.id,
          child_tab: previous?.child_tab ?? null,
          contact_clicked: previous?.contact_clicked || false,
          criteria_key: criteriaKey(s),
          stage: "opening",
          cancelled: false,
          updated_at: new Date().toISOString(),
        };
        s.liepin_task = next;
        s.run.status = "running";
        return next;
      });
      if (!task) { timingStatus = "skipped"; return { status: "skipped" }; }
      message.timing.task_id = task.id;
      task.timing_trace_id = message.timing.trace_id;
      if (task.child_tab != null) {
        const tab = await this.browser.tabs
          .get(task.child_tab)
          .catch(() => null);
        if (
          !tab ||
          liepinIdentity(tab.pendingUrl || tab.url)?.job_id !== task.job_id
        )
          task.child_tab = null;
      }
      const saved = await this.browser.storage.local.get("run");
      if (liepinJobFinished(saved.run, task.job_id)) {
        await this.stage(task.id, "completed");
        await this.closeDetail(task);
        await this.change((s) => {
          if (s.liepin_task?.id === task.id) s.liepin_task = null;
        });
        return { status: "skipped" };
      }
      timer.phase("tab_open");
      if (task.child_tab == null) {
        // Create inert tab first and persist its ID before navigation: no orphan
        // navigated page can act if the worker is interrupted here.
        // The opener must live in the same window as the new tab; without an
        // explicit windowId Chrome uses the focused window, which breaks with
        // multiple browser windows.
        const tab = await this.browser.tabs.create({
          url: "about:blank",
          active: false,
          openerTabId: sender.tab.id,
          windowId: sender.tab.windowId,
        });
        task.child_tab = tab.id;
        await this.change((s) => {
          if (s.liepin_task?.id !== task.id || s.liepin_task.cancelled)
            throw new Error("猎聘任务已暂停");
          s.liepin_task.child_tab = tab.id;
        });
        await this.browser.tabs.update(tab.id, {
          url: identity.url,
          active: true,
        });
      } else await this.browser.tabs.update(task.child_tab, { active: true });
      timer.phase("detail_load");
      await this.stage(task.id, "loading");
      const detail = await this.read(task);
      timer.phase("collection");
      await this.assertTask(task.id);
      const raw = detail.job;
      if (
        raw.job_id !== task.job_id ||
        liepinIdentity(raw.url)?.job_id !== task.job_id
      )
        throw new Error("猎聘回传职位身份不一致");
      await this.change((s) => {
        if (s.liepin_task?.id !== task.id || s.liepin_task.cancelled)
          throw new Error("猎聘任务已暂停");
        raw.blacklist_keyword =
          companyBlacklistMatch(raw, s.prefs?.excluded_companies) ||
          jobBlacklistMatch(raw, s.prefs?.excluded_terms) ||
          undefined;
        if (!s.run.seen.includes(raw.job_id)) {
          s.run.jobs.push(raw);
          s.run.seen.push(raw.job_id);
          s.run.attempts.push({
            job_id: raw.job_id,
            status: raw.blacklist_keyword ? "skipped" : "success",
            at: new Date().toISOString(),
          });
        } else {
          const index = s.run.jobs.findIndex(
            (job) => job.job_id === raw.job_id,
          );
          if (
            index >= 0 &&
            !isComplete(s.run.jobs[index], s.run) &&
            isComplete(raw, s.run)
          ) {
            s.run.extraction_history ??= [];
            s.run.extraction_history.push(s.run.jobs[index]);
            s.run.jobs[index] = raw;
            delete s.run.scores[raw.job_id];
          }
        }
        // scoreOne expects collection to be paused while calling the model.
        s.run.status = "paused";
        validateCheckpoint(s.run);
      });
      await this.stage(task.id, "collected");
      const { run: collectedRun } = await this.browser.storage.local.get("run");
      if (!isComplete(raw, collectedRun))
        throw jobError(
          new Error(
            "猎聘标题或 JD 含私有字体或不完整，已跳过，可人工核实后重试",
          ),
        );
      let score;
      let status;
      let reviewReasons = [];
      let bonusDraft;
      if (raw.blacklist_keyword) status = "blacklist";
      else {
        const state = await this.browser.storage.local.get(["selected_cities"]);
        if (
          !locationMatchesCities(raw.location_raw, state.selected_cities || [])
        )
          status = "city_skipped";
        else {
          await this.stage(task.id, "scoring");
          timer.phase("scoring");
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              score = await this.score(raw.job_id, "llm", message.timing);
              break;
            } catch (error) {
              await this.assertTask(task.id);
              if (!transientError(error)) throw error;
              if (attempt) throw jobError(error);
              this.log("liepin:retry", {
                job_id: raw.job_id,
                stage: "scoring",
                reason: error.message,
              });
              await wait(1000);
              await this.assertTask(task.id);
            }
          }
          await this.assertTask(task.id);
          const s = await this.browser.storage.local.get([
            "match_threshold",
            "prefs",
            "run",
            "contacted_jobs",
          ]);
          const threshold = s.match_threshold ?? 75;
          if (score.match_score < threshold) status = "below_threshold";
          else if (
            score.eligibility?.status === "reject" ||
            score.requirements_status === "unmet"
          )
            status = "rejected";
          else if (
            (reviewReasons = contactBlockers({ ...raw, ...score }, s.run))
              .length
          )
            status = "review_required";
          else if (detail.already_contacted || s.contacted_jobs?.[raw.job_id])
            status = task.contact_clicked
              ? "contact_opened"
              : "already_contacted";
          else {
            if (task.contact_clicked)
              throw new Error("此前沟通结果未确认；请手动核实，避免重复发送");
            await this.stage(task.id, "preparing_contact");
            timer.phase("contact");
            const response = await this.browser.tabs.sendMessage(
              task.child_tab,
              { type: "LIEPIN_CONTACT", job_id: task.job_id, task_id: task.id },
            );
            if (
              !response?.ok ||
              !["contact_opened", "already_contacted"].includes(
                response.data?.status,
              )
            )
              throw new Error(
                response?.data?.reason ||
                  response?.error ||
                  "猎聘沟通结果未确认",
              );
            status = response.data.status;
            bonusDraft = response.data.bonus_draft;
          }
        }
      }
      await this.assertTask(task.id);
      timer.phase("persistence");
      await this.stage(task.id, "completed");
      await this.change(async (s) => {
        if (s.liepin_task?.id !== task.id || s.liepin_task.cancelled)
          throw new Error("猎聘任务已暂停");
        const threshold = s.match_threshold ?? 75;
        s.run.applications[raw.job_id] = {
          job_id: raw.job_id,
          status,
          score: score?.match_score ?? null,
          threshold,
          ...(bonusDraft ? { bonus_draft: bonusDraft } : {}),
          ...(reviewReasons.length
            ? {
                reason: `该职位需核实，已跳过并继续：${reviewReasons.join("、")}`,
                blockers: reviewReasons,
              }
            : {}),
          updated_at: new Date().toISOString(),
        };
        if (["contact_opened", "already_contacted"].includes(status)) {
          s.contacted_jobs ||= {};
          s.contacted_jobs[raw.job_id] = contactRecord({
            existing: s.contacted_jobs[raw.job_id],
            raw,
            fingerprint: await jobFingerprint(raw),
            score,
            threshold,
            runId: s.run.id,
            status,
          });
          if (bonusDraft) s.contacted_jobs[raw.job_id].bonus_draft = bonusDraft;
          if (s.job_index?.[raw.job_id])
            s.job_index[raw.job_id].contacted = true;
        }
        // The filled draft stays in its detail tab; the batch keeps going
        // without a manual checkpoint, mirroring the BOSS chat flow.
        s.run.status = "running";
        delete s.run.recovering;
        s.run.current = null;
      });
      // Verify ownership immediately before closing; never close a reused or
      // navigated user tab. Retain the checkpoint until the close completes.
      timer.phase("cleanup");
      await this.assertTask(task.id);
      // Confirmed sends no longer need a draft tab. Keep unsent/uncertain
      // results available for review while allowing the list to continue.
      if (!bonusDraft || bonusDraft.status === "sent") await this.closeDetail(task);
      else {
        // Retaining the active draft tab otherwise leaves the list blocked in
        // waitForVisible indefinitely, even though run.status is running.
        const child = await this.browser.tabs.get(task.child_tab).catch(() => null);
        if (child?.active)
          await this.browser.tabs.update(task.parent_tab, { active: true });
      }
      await this.change((s) => {
        if (s.liepin_task?.id === task.id) s.liepin_task = null;
      });
      this.log("liepin:done", { site: "liepin", job_id: raw.job_id, status });
      timingStatus = status;
      return { status, job_id: raw.job_id };
    } catch (error) {
      timer.phase("recovery");
      // A single unreadable JD or exhausted model retry must not stop the list.
      // Ownership/identity checks and uncertain contact results still pause.
      if (error.jobLocal && task && !task.contact_clicked) {
        try {
          await this.assertTask(task.id);
          await this.stage(task.id, "completed");
          await this.change((s) => {
            if (s.liepin_task?.id !== task.id || s.liepin_task.cancelled)
              throw new Error("猎聘任务已暂停");
            s.run.applications[task.job_id] = {
              job_id: task.job_id,
              status: "failed",
              reason: error.message,
              updated_at: new Date().toISOString(),
            };
            if (s.run.jobs.some((job) => job.job_id === task.job_id)) {
              s.run.score_failures ??= {};
              s.run.score_failures[task.job_id] = {
                reason: error.message,
                at: new Date().toISOString(),
              };
            }
            s.run.attempts.push({
              job_id: task.job_id,
              status: "failed",
              reason: error.message,
              at: new Date().toISOString(),
            });
            s.run.status = "running";
            s.run.current = null;
            s.run.stop_reason = null;
          });
          await this.assertTask(task.id);
          await this.closeDetail(task);
          await this.change((s) => {
            if (s.liepin_task?.id === task.id) s.liepin_task = null;
          });
          this.log("liepin:skip", {
            job_id: task.job_id,
            reason: error.message,
          });
          timingStatus = "failed";
          return {
            status: "failed",
            job_id: task.job_id,
            reason: error.message,
          };
        } catch (recoveryError) {
          error = recoveryError;
        }
      }
      await this.change((s) => {
        if (s.run?.id !== message.run_id) return;
        s.run.status = "paused";
        if (!s.run.recovering) s.run.resume_on_reload = false;
        s.run.stop_reason = error.message;
        if (task && s.liepin_task?.id === task.id) {
          s.liepin_task.cancelled = true;
          s.liepin_task.reason = error.message;
        }
        if (
          task &&
          s.liepin_task?.id === task.id &&
          ["collected", "scoring"].includes(s.liepin_task.stage)
        ) {
          s.run.score_failures ||= {};
          s.run.score_failures[identity.job_id] = {
            reason: error.message,
            at: new Date().toISOString(),
          };
        }
        s.run.attempts.push({
          job_id: identity.job_id,
          status: "failed",
          reason: error.message,
          at: new Date().toISOString(),
        });
      });
      timingStatus = "paused";
      return { status: "paused", reason: error.message };
    } finally {
      timer.finish(timingStatus);
      clearInterval(heartbeat);
      this.busy = false;
    }
  }
  async closeDetail(task) {
    const started = performance.now();
    const startedAt = new Date().toISOString();
    try {
    const child =
      task.child_tab == null
        ? null
        : await this.browser.tabs.get(task.child_tab).catch(() => null);
    // Closing an inactive detail must not steal focus from the user's new tab.
    if (child) await this.browser.tabs.remove(child.id);
    if (child?.active)
      await this.browser.tabs.update(task.parent_tab, { active: true });
    } finally {
      this.log("timing:operation", { site: "liepin", trace_id: task.timing_trace_id,
        run_id: task.run_id, job_id: task.job_id, phase: "tab_close", started_at: startedAt,
        ended_at: new Date().toISOString(), elapsed_ms: Math.round((performance.now() - started) * 100) / 100 });
    }
  }
  async onRemoved(tabId) {
    await this.change((s) => {
      const task = s.liepin_task;
      if (
        !task ||
        ![task.parent_tab, task.child_tab].includes(tabId) ||
        task.stage === "completed"
      )
        return;
      task.cancelled = true;
      if (s.run?.id === task.run_id) {
        s.run.status = "paused";
        s.run.resume_on_reload = false;
        delete s.run.recovering;
        s.run.stop_reason = "猎聘任务标签页已关闭，请手动恢复";
      }
    });
  }
}
