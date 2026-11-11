import { siteForURL, isBossChatURL } from "./sites.js";
import { BossAutoReply } from "./auto-reply-boss.js";
import { initAutoReplyPanel } from "./auto-reply-panel.js";
import { LiepinAutoRead, isLiepinChatInteraction } from "./auto-read-liepin.js";

export const AUTO_REPLY_CAPABILITIES = Object.freeze({
  boss: true,
  liepin: true,
});

export function initAutoReply() {
  const site = siteForURL(location.href);
  if (!AUTO_REPLY_CAPABILITIES[site]) return;
  if (site === "liepin") {
    initAutoReplyPanel({
      isChatURL: (value) => siteForURL(value) === "liepin",
      createRunner: (options) => new LiepinAutoRead(options),
      stateType: "GET_LIEPIN_AUTO_READ_STATE",
      setType: "SET_LIEPIN_AUTO_READ",
      controlType: "LIEPIN_AUTO_READ_CONTROL",
      shouldPauseOnUserAction: isLiepinChatInteraction,
      labelText: "自动已读消息",
      helpText: "自动打开“我的沟通”中的未读会话以标记已读；不会发送消息。",
    });
    return;
  }
  initAutoReplyPanel({
    isChatURL: isBossChatURL,
    createRunner: (options) => new BossAutoReply(options),
    labelText: "自动回复消息",
    helpText:
      "规则识别：拒绝消息自动已读；索要简历时发送中文附件（CN / 中文）。其他消息保留未读。",
  });
}
