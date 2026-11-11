import {
  isJobsPage,
  openMatchPanel,
  startAutoMessages,
  autoMessageOptions,
} from "./popup-panel.js";

document.querySelector("#settings").onclick = async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
};

const panelButton = document.querySelector("#open-panel");
const replyButton = document.querySelector("#auto-reply");
const status = document.querySelector("#status");
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const messageOptions = autoMessageOptions(tab?.url);
// Source modules cannot run as classic manifest content scripts.
const source = await (await fetch(chrome.runtime.getURL("content.js"))).text();
const sourceLoaded = /^import\s/m.test(source);
if (sourceLoaded) {
  panelButton.disabled = true;
  status.textContent = "";
} else if (messageOptions) {
  status.textContent = `点击“${messageOptions.label}”开始处理未读；再次打开弹窗可停止。`;
} else if (!isJobsPage(tab?.url)) {
  status.textContent = "请在 BOSS 聊天页或 BOSS / 猎聘职位列表页使用侧栏。";
} else {
  status.textContent = "侧栏提供城市筛选、分数阈值和开始 / 暂停。";
}

let replying = false;
if (!sourceLoaded && messageOptions) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: messageOptions.controlType,
      action: "status",
    });
    replying =
      response?.ok === true &&
      response.data?.enabled === true &&
      !response.data.paused;
  } catch {
    /* Starting below will inject a missing chat script. */
  }
  replyButton.textContent = replying
    ? `停止${messageOptions.action}`
    : messageOptions.label;
  replyButton.disabled = false;
}

replyButton.onclick = async () => {
  replyButton.disabled = true;
  status.textContent = `正在${replying ? "停止" : "启动"}${messageOptions.action}…`;
  try {
    if (replying) {
      const result = await chrome.runtime.sendMessage({
        type: messageOptions.setType,
        enabled: false,
      });
      if (!result?.ok) throw new Error(result?.error || "停止自动回复失败");
      await chrome.tabs
        .sendMessage(tab.id, {
          type: messageOptions.controlType,
          action: "stop",
        })
        .catch(() => {});
    } else {
      await startAutoMessages(chrome, tab);
    }
    window.close();
  } catch (error) {
    status.textContent = error.message;
    replyButton.disabled = false;
  }
};

panelButton.onclick = async () => {
  panelButton.disabled = true;
  status.textContent = "正在打开侧栏…";
  try {
    await openMatchPanel(chrome, tab);
    window.close();
  } catch (error) {
    status.textContent = error.message;
    panelButton.disabled = false;
  }
};
panelButton.disabled = sourceLoaded;
