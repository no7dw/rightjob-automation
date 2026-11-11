import { initBossBonusChat } from "./bonus-chat-boss.js";
import { initAutoReply } from "./auto-reply.js";
import { isBossChatURL } from "./sites.js";

export { initBossBonusChat } from "./bonus-chat-boss.js";
if (isBossChatURL(location.href)) initBossBonusChat();
initAutoReply();
