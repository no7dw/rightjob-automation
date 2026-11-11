import { isListPage, isBossChatURL, liepinIdentity } from "./sites.js";
export const isJobsPage = (url) => isListPage(url) || isBossChatURL(url);

export function autoMessageOptions(url) {
  if (liepinIdentity(url))
    return {
      label: "自动已读消息",
      action: "自动已读",
      controlType: "LIEPIN_AUTO_READ_CONTROL",
      setType: "SET_LIEPIN_AUTO_READ",
      script: "liepin-auto-read.js",
    };
  if (isBossChatURL(url))
    return {
      label: "自动回复消息",
      action: "自动回复",
      controlType: "BOSS_AUTO_REPLY_CONTROL",
      setType: "SET_AUTO_REPLY_MESSAGES",
      script: "boss-auto-reply.js",
    };
  return null;
}

export async function startAutoMessages(browser, tab) {
  const options = autoMessageOptions(tab?.url);
  if (!options) throw new Error("请先打开 BOSS 聊天页，再启动自动回复消息");
  const start = () =>
    browser.tabs.sendMessage(tab.id, {
      type: options.controlType,
      action: "start",
    });
  let response;
  try {
    response = await start();
  } catch {
    /* A tab opened before extension reload needs the chat script. */
  }
  if (!response) {
    await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: [options.script],
    });
    response = await start();
  }
  if (!response?.ok)
    throw new Error(
      response?.error || `${options.action}未能启动，请刷新页面后重试`,
    );
  return response.data;
}

export const startBossAutoReply = startAutoMessages;

export async function openMatchPanel(browser, tab) {
  if (!isJobsPage(tab?.url))
    throw new Error(
      "请先打开 BOSS 聊天页、BOSS 或猎聘职位搜索列表页，再打开匹配侧栏",
    );
  const show = () => browser.tabs.sendMessage(tab.id, { type: "TOGGLE" });
  let response;
  try {
    response = await show();
  } catch {
    // Existing tabs do not acquire new content scripts after extension reload.
  }
  if (response?.ok) return;
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      document.getElementById("jseeker-root")?.remove();
      document.getElementById("jseeker-auto-reply")?.remove();
    },
  });
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: [isBossChatURL(tab.url) ? "boss-auto-reply.js" : "content.js"],
  });
  response = await show();
  if (!response?.ok) throw new Error("侧栏未能启动，请刷新职位列表页面后重试");
}
