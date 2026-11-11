import {
  prepareBossBonusDraft,
  sendBossBonusMessage,
  isBossChatURL,
  isBossBonusDetailURL,
  bossBonusConversation,
} from "./bonus-message-boss.js";

export async function initBossBonusChat({ inline = false } = {}) {
  if (globalThis.__jseekerBossBonusChat) return;
  globalThis.__jseekerBossBonusChat = true;
  const completed = globalThis.__jseekerBossBonusCompleted ||= new Set();
  const api = async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw new Error(result?.error || "加分项草稿状态不可用");
    return result.data;
  };
  try {
    const readyType = inline ? "BOSS_BONUS_DETAIL_READY" : "BOSS_BONUS_CHAT_READY";
    let review = await api({ type: readyType });
    if (!review?.message) {
      return;
    }
    const taskKey = JSON.stringify([review.run_id, review.job_id]);
    if (completed.has(taskKey)) return;
    // In-place BOSS routing can leave the old list sidebar mounted. Its
    // controls belong to the list; use the chat's explicit return button here.
    document.getElementById("jseeker-root")?.remove();
    let result = review.send_attempted ? { status: "send_unconfirmed" } : null;
    let verifiedSince = 0;
    for (let attempt = 0; attempt < 60 && !review.send_attempted; attempt++) {
      if (document.hidden) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      if (!(inline ? isBossBonusDetailURL(location.href) : isBossChatURL(location.href))) break;
      const current = await api({ type: readyType });
      if (current?.run_id !== review.run_id || current.job_id !== review.job_id)
        return;
      review = current;
      // Read-only verification first: never fill a stale editor while BOSS is
      // still switching the selected contact's header and message panel.
      const probe = bossBonusConversation(review.job_id, document, review);
      if (probe.status === "ambiguous_chat") {
        result = probe;
        break;
      }
      if (probe.status !== "verified") {
        result = probe;
        verifiedSince = 0;
      } else if (!verifiedSince) verifiedSince = Date.now();
      if (!verifiedSince || Date.now() - verifiedSince < 400) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      try {
        result = await prepareBossBonusDraft(
          review.job_id,
          review.message,
          document,
          review,
        );
      } catch {
        result = { status: "editor_error" };
      }
      if (!["identity_unverified", "editor_missing"].includes(result.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (review.auto_send && ["prepared", "already_prepared"].includes(result?.status))
      result = await sendBossBonusMessage(review.job_id, review.message,
        () => api({ type: "BOSS_BONUS_AUTHORIZE_SEND", run_id: review.run_id, job_id: review.job_id }),
        document, review);
    const draft = {
      status:
        result?.status === "contact_selected"
          ? "identity_unverified"
          : result?.status || "editor_missing",
    };
    await api({
      type: "BOSS_BONUS_DRAFT_RESULT",
      run_id: review.run_id,
      job_id: review.job_id,
      status: draft.status,
    });
    completed.add(taskKey);
    document.getElementById("jseeker-bonus-chat")?.remove();
    // Shadow DOM keeps the notice out of the site's chat and message selectors.
    const host = document.createElement("div");
    host.id = "jseeker-bonus-chat";
    const shadow = host.attachShadow({ mode: "open" });
    const box = document.createElement("aside");
    box.style.cssText =
      "position:fixed;right:20px;top:80px;z-index:2147483647;max-width:340px;padding:16px;background:#102d30;color:#e8fffb;border:1px solid #2dd4bf;font:14px/1.6 system-ui;box-shadow:0 8px 30px #0004";
    const notice = document.createElement("p");
    const verified = ["prepared", "already_prepared"].includes(draft.status);
    notice.textContent = draft.status === "sent"
      ? "加分项消息已发送，正在返回职位列表继续批次。"
      : draft.status === "send_unconfirmed"
      ? "加分项消息已尝试发送，结果未确认，不重复发送；正在返回列表继续。"
      : draft.status === "send_button_missing"
      ? "草稿已填入，但未找到唯一可用发送按钮；草稿已保留。"
      : verified
      ? review.auto_send
        ? "自动发送未生效：后台没有批准这次发送；草稿已保留。"
        : "加分项消息已填入，正在返回职位列表继续批次。"
      : `本条加分项处理失败（${draft.status}），已记录并返回列表继续批次。未确认草稿已保存。`;
    const message = document.createElement("p");
    message.textContent = review.message;
    box.append(notice, message);
    shadow.append(box);
    document.documentElement.append(host);
  } catch {
    // No matching pending task means this is an ordinary chat. Never insert a
    // draft into it. The list bounds its wait and continues if this tab fails.
  } finally {
    globalThis.__jseekerBossBonusChat = false;
  }
}

