import * as liepin from "./liepin-adapter.js";

if (!globalThis.__jseekerLiepinDetail) {
  globalThis.__jseekerLiepinDetail = true;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      !["LIEPIN_READ", "LIEPIN_CONTACT"].includes(message.type)
    )
      return;
    const run = async () => {
      if (liepin.detailId() !== message.job_id)
        throw new Error("猎聘详情 ID 已变化");
      const reason = liepin.blockedReason({
        allowChat: message.type === "LIEPIN_READ",
      });
      if (reason) return { status: "paused", reason };
      if (message.type === "LIEPIN_READ")
        return {
          job: liepin.readJob(message.job_id),
          already_contacted:
            liepin.contactButton()?.innerText.trim() === "继续聊",
        };
      return liepin.contact(message.job_id, async () => {
        const result = await chrome.runtime.sendMessage({
          type: "LIEPIN_AUTHORIZE_CONTACT",
          task_id: message.task_id,
          job_id: message.job_id,
        });
        if (!result?.ok) throw new Error(result?.error || "沟通任务已失效");
        return result.data;
      }, async () => {
        const result = await chrome.runtime.sendMessage({
          type: "LIEPIN_AUTHORIZE_BONUS_SEND", task_id: message.task_id, job_id: message.job_id,
        });
        return result?.ok === true && result.data === true;
      });
    };
    run()
      .then((data) => respond({ ok: true, data }))
      .catch((error) => respond({ ok: false, error: error.message }));
    return true;
  });
}
