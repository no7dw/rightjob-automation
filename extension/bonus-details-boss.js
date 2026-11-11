import * as boss from "./boss-adapter.js";
import { jobId } from "./core.js";
import { bossBonusConversation, isBossChatURL, isBossBonusDetailURL } from "./bonus-message-boss.js";
import { initBossBonusChat } from "./bonus-chat-boss.js";

// Only the background's exact owned JD tab gets a task. Ordinary detail tabs
// neither contact recruiters nor write drafts.
export async function initBossBonusDetail() {
  if (globalThis.__jseekerBossBonusDetail) return;
  globalThis.__jseekerBossBonusDetail = true;
  const api = async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "加分项任务不可用");
    return result.data;
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 200));
  try {
    let review = await api({ type: "BOSS_BONUS_DETAIL_READY" });
    if (!review?.message) return;
    if (review.send_attempted) { await initBossBonusChat({ inline: true }); return; }
    const task = { run_id: review.run_id, job_id: review.job_id };
    const report = (status) => api({ type: "BOSS_BONUS_DRAFT_RESULT", ...task, status });
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      if (isBossChatURL(location.href)) {
        await initBossBonusChat();
        return;
      }
      if (!isBossBonusDetailURL(location.href) || jobId(location.href) !== task.job_id) {
        await report("identity_unverified");
        return;
      }
      const current = await api({ type: "BOSS_BONUS_DETAIL_READY" });
      if (current?.run_id !== task.run_id || current.job_id !== task.job_id) return;
      review = current;
      if (document.hidden) { await wait(); continue; }
      if (boss.blockedReason()) { await report("editor_error"); return; }
      if (bossBonusConversation(task.job_id, document, review).status === "verified") {
        await initBossBonusChat({ inline: true });
        return;
      }
      const continuation = boss.existingContactButton(document);
      const initial = boss.contactButton(document);
      const intent = continuation && !review.continue_attempted ? "continue"
        : initial && !review.existing_contact && !review.contact_attempted ? "initial" : null;
      if (intent) {
        const button = intent === "continue" ? continuation : initial;
        const allowed = await api({ type: "BOSS_BONUS_AUTHORIZE_CONTACT", ...task, intent });
        if (!allowed) { await report("editor_interrupted"); return; }
        // Authorization may yield while the site rerenders. Re-read both the
        // current URL and the live control before allowing a single click.
        if (jobId(location.href) !== task.job_id || !button.isConnected || !boss.visible(button)) {
          await report("identity_unverified");
          return;
        }
        boss.clickElement(button);
        if (intent === "initial")
          await api({ type: "BOSS_BONUS_CONTACTED", ...task });
      }
      await wait();
    }
    await report("editor_timeout");
  } catch {
    // The original list has its own timeout; navigation or a cancelled task
    // must never trigger a second initial greeting.
  }
}

if (isBossBonusDetailURL(location.href)) initBossBonusDetail();
