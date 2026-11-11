// All calls run inside the background's serial queue. Persist the send attempt
// before clicking so refreshes, concurrent tabs and worker restarts cannot resend.
export const AUTO_REPLY_MESSAGES = new Set([
  "GET_BOSS_AUTO_REPLY_STATE",
  "SET_AUTO_REPLY_MESSAGES",
  "BOSS_AUTO_REPLY_CLAIM",
  "BOSS_AUTO_REPLY_AUTHORIZE_SEND",
]);

export async function autoReplyState(
  storage,
  message,
  sender,
  now = Date.now(),
) {
  const state = await storage.get([
    "auto_reply_messages",
    "boss_auto_reply_lease",
    "boss_resume_attempts",
    "run",
  ]);
  if (message.type === "SET_AUTO_REPLY_MESSAGES") {
    if (typeof message.enabled !== "boolean")
      throw new Error("自动回复消息开关须为布尔值");
    await storage.set({
      auto_reply_messages: message.enabled,
      boss_auto_reply_lease: null,
    });
    return message.enabled;
  }
  const enabled = state.auto_reply_messages === true;
  const busy = !!state.run?.bonus_review;
  if (message.type === "GET_BOSS_AUTO_REPLY_STATE") return { enabled, busy };
  if (!enabled || busy || sender.tab?.id == null) return false;
  const lease = state.boss_auto_reply_lease;
  if (message.type === "BOSS_AUTO_REPLY_CLAIM") {
    if (typeof message.token !== "string" || message.token.length > 100)
      return false;
    if (
      lease?.expires_at > now &&
      (lease.tab !== sender.tab.id || lease.token !== message.token)
    )
      return false;
    await storage.set({
      boss_auto_reply_lease: {
        tab: sender.tab.id,
        token: message.token,
        expires_at: now + 15000,
      },
    });
    return true;
  }
  if (message.type === "BOSS_AUTO_REPLY_AUTHORIZE_SEND") {
    if (
      lease?.tab !== sender.tab.id ||
      lease.token !== message.token ||
      lease.expires_at <= now
    )
      return false;
    if (!/^[a-f0-9]{64}$/.test(message.key || "")) return false;
    const attempts = state.boss_resume_attempts || {};
    if (attempts[message.key]) return false;
    attempts[message.key] = { attempted_at: now };
    await storage.set({ boss_resume_attempts: attempts });
    return true;
  }
  return false;
}
