import { waitForVisible } from "./visibility.js";
import * as boss from "./boss-adapter.js";
import {
  hasPUA,
  locationMatchesCities,
  parseSalary,
  normalizeText,
  stableJSON,
} from "./core.js";
import {
  failedJobs,
  failureCount,
  mergeOCRPages,
  processedCount,
  validateCheckpoint,
} from "./run-state.js";
import { initialRun } from "./store.js";
import { companyBlacklistMatch, jobBlacklistMatch } from "./blacklist.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export class Scanner {
  constructor(send, onUpdate, onVisibility = () => {}) {
    this.send = send;
    this.onVisibility = onVisibility;
    this.onUpdate = onUpdate;
    this.running = false;
    this.stop = false;
    this.expected = null;
    this.scopeValue = null;
    this.onClick = (e) => {
      if (!this.running || !e.isTrusted || e.target.closest("#jseeker-root"))
        return;
      if (
        e.target.closest(
          'a[href*="/job_detail/"],.search-condition,.condition-filter-select,.filter-box,.expect-item,.job-search-form',
        )
      )
        this.stop = true;
    };
    document.addEventListener("click", this.onClick, true);
  }
  validate() {
    if (this.stop) throw new Error("已请求暂停或用户更改了选择");
    const reason = boss.blockedReason();
    if (reason) throw new Error(reason);
    if (stableJSON(boss.scope()) !== this.scopeValue)
      throw new Error("搜索范围已改变，请新建采集批次");
  }
  async guard() {
    try {
      await waitForVisible(document, () => this.validate(), {
        onWaiting: () => this.onVisibility(true),
      });
    } finally {
      this.onVisibility(false);
    }
  }
  trace(event, details = {}) {
    this.send({ type: "DEBUG_LOG", event, details }).catch(() => {});
  }
  async pause() {
    this.stop = true;
  }
  async start(existing, options = {}) {
    if (this.running) return;
    this.running = true;
    this.stop = false;
    const skipIds = new Set(options.skipIds || []);
    const selectedCities = [...(options.selectedCities || [])];
    const maxItems =
      Number.isInteger(options.maxItems) && options.maxItems > 0
        ? options.maxItems
        : null;
    let run = existing || initialRun(boss.scope(), options.target || 10);
    const invocationLimit = maxItems
      ? Math.min(run.target, processedCount(run) + maxItems)
      : run.target;
    let invocationItems = 0;
    let claimed = false;
    try {
      if (stableJSON(run.scope) !== stableJSON(boss.scope()))
        throw new Error("当前搜索范围与检查点不同，请新建批次");
      this.scopeValue = stableJSON(run.scope);
      this.trace("scanner:start", {
        run_id: run.id,
        target: run.target,
        processed: processedCount(run),
        cards: boss.cards().length,
        skip_ids: [...skipIds].join(","),
        selected_cities: selectedCities.join(","),
      });
      await this.guard();
      await this.send({ type: "CLAIM", run_id: run.id });
      claimed = true;
      run.status = "running";
      run.stop_reason = null;
      run.city_filter = selectedCities;
      const save = async () => {
        validateCheckpoint(run);
        await this.send({ type: "SAVE_RUN", run });
        await this.onUpdate(run);
      };
      await save();
      let emptyRounds = 0;
      while (
        (options.currentOnly && options.forceOCR) ||
        (options.matchTarget
          ? !maxItems || invocationItems < maxItems
          : (processedCount(run) < run.target || failedJobs(run).length > 0) &&
            (processedCount(run) < invocationLimit ||
              (maxItems &&
                processedCount(run) >= run.target &&
                failedJobs(run).length > 0)))
      ) {
        await this.guard();
        const all = boss.cards();
        run.discovered = all.length;
        const currentId = boss.detailId();
        if (
          options.currentOnly &&
          options.forceOCR &&
          run.seen.includes(currentId)
        ) {
          const current = all.find((c) => c.id === currentId);
          if (!current) throw new Error("当前卡片不在列表中");
          const captured = await boss.ocrCurrent(
            current,
            this.send,
            () => this.guard(),
            true,
            async (id) => {
              run.pending_evidence = [...(run.pending_evidence || []), id];
              await save();
            },
          );
          run.supplements ??= {};
          run.supplements[currentId] = {
            ocr_fields: Object.fromEntries(
              captured
                .filter((r) => r.kind !== "jd")
                .map((r) => [r.kind, r.text]),
            ),
            ocr_draft: mergeOCRPages(
              captured.filter((r) => r.kind === "jd").map((r) => r.text),
            ),
            ocr_capture_complete:
              captured.filter((r) => r.kind === "jd").at(-1)
                ?.capture_complete === true,
            evidence_ids: captured.map((r) => r.evidence_id),
          };
          run.status = "paused";
          run.stop_reason = "截图OCR草稿已保存，请在人工校正中核实全文和字段";
          break;
        }
        const retryOnly =
          !options.matchTarget &&
          processedCount(run) >= run.target &&
          failedJobs(run).length > 0;
        const retryIds = new Set(
          retryOnly ? failedJobs(run).map((attempt) => attempt.job_id) : [],
        );
        const card = all.find(
          (c) =>
            (!options.currentOnly || c.id === currentId) &&
            (!run.seen.includes(c.id) || run.jobs.some((job) =>
              job.job_id === c.id && job.capture_scope === "card" &&
              !jobBlacklistMatch(job, options.blacklistKeywords) &&
              !companyBlacklistMatch(job, options.companyBlacklistKeywords))) &&
            !skipIds.has(c.id) &&
            (!retryOnly || retryIds.has(c.id)) &&
            failureCount(run, c.id) < 2 &&
            locationMatchesCities(boss.cardLocation(c), selectedCities),
        );
        if (!card) {
          this.trace("scanner:no-card", {
            processed: processedCount(run),
            target: run.target,
            failures: failedJobs(run).length,
            empty_round: emptyRounds,
          });
          if (options.currentOnly) {
            run.status = "paused";
            run.stop_reason =
              "当前职位已采集或无法识别；请查看已有记录或选择另一职位";
            break;
          }
          if (emptyRounds++ >= 3) {
            run.status = "exhausted";
            const locationSkipped = all.some(
              (candidate) =>
                !locationMatchesCities(
                  boss.cardLocation(candidate),
                  selectedCities,
                ),
            );
            run.stop_reason = locationSkipped
              ? `当前结果未命中城市筛选（${selectedCities.join("、")}）；本轮已处理${processedCount(run)}/${run.target}条`
              : `当前结果滚动后无新增可采集职位；本轮已处理${processedCount(run)}/${run.target}条`;
            break;
          }
          if (await boss.nextPageWithinResults(() => this.guard()))
            emptyRounds = 0;
          continue;
        }
        emptyRounds = 0;
        const cardTitle = normalizeText(card.link.innerText);
        const titleKeyword = !hasPUA(cardTitle) && jobBlacklistMatch(
          { title: cardTitle }, options.blacklistKeywords,
        );
        if (titleKeyword && !options.forceOCR) {
          const skippedCard = boss.readBlacklistedCard(card, titleKeyword);
          const previous = run.jobs.findIndex((job) => job.job_id === card.id);
          if (previous < 0) run.jobs.push(skippedCard);
          else run.jobs[previous] = skippedCard;
          if (!run.seen.includes(card.id)) run.seen.push(card.id);
          run.attempts.push({ job_id: card.id, status: "skipped",
            reason: `标题命中黑名单：${titleKeyword}`, at: new Date().toISOString() });
          this.trace("scanner:blacklist-skip", {
            job_id: card.id, keyword: titleKeyword, stage: "card_title",
          });
          // No site request was made: persist the skip without the navigation
          // throttle or an extra scoring/application round for this card.
          await save();
          if (options.currentOnly) break;
          continue;
        }
        run.current = {
          job_id: card.id,
          title: card.link.innerText,
          status: "loading",
        };
        await save();
        try {
          await this.guard();
          card.el.scrollIntoView({ block: "nearest" });
          this.trace("scanner:click", {
            job_id: card.id,
            processed: processedCount(run),
          });
          boss.clickElement(card.link);
          await boss.waitForDetail(card.id, () => this.guard());
          this.trace("scanner:detail-ready", { job_id: card.id });
          let raw = boss.readJob(card);
          let blacklistKeyword = jobBlacklistMatch(
            raw,
            options.blacklistKeywords,
          );
          blacklistKeyword ||= companyBlacklistMatch(
            raw,
            options.companyBlacklistKeywords,
          );
          this.trace("scanner:collected", {
            job_id: raw.job_id,
            title_chars: (raw.title || "").length,
            jd_chars: (raw.jd_raw || "").length,
            salary_known: !!parseSalary(raw.salary_raw).min_k,
          });
          for (const field of ["title", "company", "location_raw"])
            if (hasPUA(raw[field]))
              raw.quality_flags.push(field + "_private_font");
          if (
            !blacklistKeyword &&
            (options.forceOCR ||
              hasPUA(raw.title) ||
              hasPUA(raw.company) ||
              hasPUA(raw.location_raw) ||
              !raw.jd_raw ||
              hasPUA(raw.jd_raw) ||
              hasPUA(raw.salary_raw) ||
              !parseSalary(raw.salary_raw).min_k)
          ) {
            if (options.ocr) {
              try {
                const ocr = await boss.ocrCurrent(
                  card,
                  this.send,
                  () => this.guard(),
                  options.forceOCR || !raw.jd_raw || hasPUA(raw.jd_raw),
                  async (id) => {
                    run.pending_evidence = [
                      ...(run.pending_evidence || []),
                      id,
                    ];
                    await save();
                  },
                );
                raw.evidence_ids = ocr.map((r) => r.evidence_id);
                raw.ocr_fields = Object.fromEntries(
                  ocr
                    .filter((r) => r.kind !== "jd")
                    .map((r) => [r.kind, r.text]),
                );
                if (ocr.some((r) => r.error)) {
                  raw.ocr_error = ocr.find((r) => r.error).error;
                  raw.quality_flags.push("ocr_unavailable");
                }
                const salary = ocr.find((r) => r.kind === "salary");
                if (
                  salary &&
                  salary.blocks.length &&
                  salary.blocks.every((b) => b.confidence >= 0.8) &&
                  parseSalary(salary.text).min_k
                ) {
                  raw.corrections = { salary: salary.text };
                  raw.field_sources.salary = "ocr";
                  raw.quality_flags.push("salary_ocr_review");
                }
                const jd = ocr.filter((r) => r.kind === "jd");
                if (jd.length) {
                  raw.ocr_draft = mergeOCRPages(jd.map((r) => r.text));
                  raw.ocr_capture_complete =
                    jd.at(-1).capture_complete === true;
                  if (!raw.ocr_capture_complete)
                    raw.quality_flags.push("ocr_capture_incomplete");
                  raw.quality_flags.push("ocr_fulltext_requires_review");
                }
              } catch (error) {
                await this.guard();
                raw.quality_flags.push("ocr_unavailable");
                raw.ocr_error = error.message;
              }
            } else raw.quality_flags.push("ocr_not_enabled");
          }
          await this.guard();
          if (boss.detailId() !== card.id)
            throw new Error("保存前职位ID发生变化");
          if (
            !normalizeText(raw.title) ||
            hasPUA(raw.title) ||
            !normalizeText(raw.jd_raw) ||
            hasPUA(raw.jd_raw)
          ) {
            raw.extraction_status = "partial";
            raw.quality_flags.push("jd_unreadable");
          }
          if (!parseSalary(raw.corrections?.salary || raw.salary_raw).min_k)
            raw.quality_flags.push("salary_unknown");
          blacklistKeyword ||= jobBlacklistMatch(
            raw,
            options.blacklistKeywords,
          );
          blacklistKeyword ||= companyBlacklistMatch(
            raw,
            options.companyBlacklistKeywords,
          );
          if (blacklistKeyword) {
            raw.blacklist_keyword = blacklistKeyword;
            this.trace("scanner:blacklist-skip", {
              job_id: card.id,
              keyword: blacklistKeyword,
            });
          }
          const existingIndex = run.jobs.findIndex((job) => job.job_id === card.id);
          if (existingIndex < 0) run.jobs.push(raw);
          else run.jobs[existingIndex] = raw;
          if (!run.seen.includes(card.id)) run.seen.push(card.id);
          run.attempts.push({
            job_id: card.id,
            status: blacklistKeyword ? "skipped" : raw.extraction_status,
            ...(blacklistKeyword
              ? { reason: `命中黑名单：${blacklistKeyword}` }
              : {}),
            at: new Date().toISOString(),
          });
        } catch (error) {
          // A user interruption or access restriction must not be swallowed as an ordinary item failure.
          await this.guard();
          run.attempts.push({
            job_id: card.id,
            status: "failed",
            title: card.link.innerText,
            retry_epoch: run.retry_epochs?.[card.id] || 0,
            reason: error.message,
            at: new Date().toISOString(),
          });
          this.trace("scanner:error", {
            job_id: card.id,
            reason: error.message,
          });
        }
        invocationItems++;
        await save();
        await delay(1200);
        if (options.currentOnly) break;
      }
      if (run.status === "running") {
        const complete =
          !options.matchTarget && processedCount(run) >= run.target;
        run.status = options.currentOnly
          ? "paused"
          : complete
            ? "completed"
            : "paused";
        run.stop_reason = options.currentOnly
          ? "单职位探查完成"
          : complete
            ? null
            : "逐项处理中";
      }
      run.current = null;
      await save();
      this.trace("scanner:finish", {
        run_id: run.id,
        status: run.status,
        jobs: run.jobs.length,
        failures: failedJobs(run).length,
      });
    } catch (error) {
      if (!claimed) throw error;
      run.status = /验证|访问|登录/.test(error.message) ? "blocked" : "paused";
      run.stop_reason = error.message;
      this.trace("scanner:fatal", {
        run_id: run.id,
        status: run.status,
        reason: error.message,
      });
      try {
        await this.send({ type: "SAVE_RUN", run });
        await this.onUpdate(run);
      } catch {
        await this.onUpdate({ ...run, stop_reason: error.message });
      }
    } finally {
      this.running = false;
      this.expected = null;
      try {
        await this.send({ type: "RELEASE", run_id: run.id });
      } catch {}
    }
    return run;
  }
}
