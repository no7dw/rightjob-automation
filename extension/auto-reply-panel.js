import css from "./ui.css";

export function initAutoReplyPanel({
  createRunner,
  isChatURL,
  stateType = "GET_BOSS_AUTO_REPLY_STATE",
  setType = "SET_AUTO_REPLY_MESSAGES",
  labelText = "自动回复消息",
  helpText = "",
  controlType = "BOSS_AUTO_REPLY_CONTROL",
  shouldPauseOnUserAction = () => true,
}) {
  if (globalThis.__jseekerBossAutoReply) return;
  globalThis.__jseekerBossAutoReply = true;
  const api = async (message) => {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok)
      throw new Error(response?.error || "扩展连接已失效，请刷新页面");
    return response.data;
  };
  let runner,
    host,
    checkbox,
    status,
    resume,
    listHost,
    listDisplay,
    running = false;
  let manuallyPaused = false;
  let enabled = false;
  // Stop immediately on human interaction with the site's chat controls. The
  // extension's own synthetic clicks are untrusted and do not trip this guard.
  const onUserAction = (event) => {
    if (!event.isTrusted || (host && event.composedPath().includes(host)))
      return;
    if (!isChatURL(location.href) || !runner || !shouldPauseOnUserAction(event))
      return;
    manuallyPaused = true;
    runner.stop();
    status.textContent = "正在手动操作聊天，自动处理已暂停。";
    resume.hidden = false;
  };
  document.addEventListener("pointerdown", onUserAction, true);
  document.addEventListener("keydown", onUserAction, true);
  async function update() {
    if (running) return;
    running = true;
    try {
      if (!isChatURL(location.href)) {
        runner?.stop();
        runner = null;
        host?.remove();
        host = null;
        if (listHost?.isConnected) listHost.style.display = listDisplay;
        listHost = null;
        return;
      }
      if (!listHost) {
        listHost = document.getElementById("jseeker-root");
        if (listHost) {
          listDisplay = listHost.style.display;
          listHost.style.display = "none";
        }
      }
      const state = await api({ type: stateType });
      enabled = state.enabled;
      if (host) host.hidden = state.busy;
      if (state.busy) {
        runner?.stop();
        runner = null;
        return;
      }
      if (!host?.isConnected) {
        host = document.createElement("div");
        host.id = "jseeker-auto-reply";
        const shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = css;
        const panel = document.createElement("section");
        panel.className = "panel";
        const body = document.createElement("div");
        body.className = "body";
        const heading = document.createElement("pre");
        heading.textContent = "+ JSEEKER · CHAT +";
        const label = document.createElement("label");
        label.className = "bonus-message-option";
        checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.setAttribute("aria-label", labelText);
        label.append(checkbox, document.createTextNode(labelText));
        const help = document.createElement("p");
        help.className = "notice";
        help.textContent = helpText;
        status = document.createElement("p");
        status.className = "notice";
        status.setAttribute("role", "status");
        resume = document.createElement("button");
        resume.textContent = "继续自动处理";
        resume.hidden = true;
        resume.onclick = () => {
          runner?.stop();
          runner = null;
          manuallyPaused = false;
          resume.hidden = true;
          update();
        };
        const hide = document.createElement("button");
        hide.textContent = "×";
        hide.className = "panel-hide";
        hide.setAttribute("aria-label", "隐藏聊天侧栏");
        const restore = document.createElement("button");
        restore.textContent = "J";
        restore.className = "restore-panel";
        restore.hidden = true;
        restore.setAttribute("aria-label", "显示聊天侧栏");
        hide.onclick = () => {
          panel.hidden = true;
          restore.hidden = false;
        };
        restore.onclick = () => {
          panel.hidden = false;
          restore.hidden = true;
        };
        checkbox.onchange = async () => {
          runner?.stop();
          runner = null;
          manuallyPaused = false;
          resume.hidden = true;
          try {
            await api({
              type: setType,
              enabled: checkbox.checked,
            });
          } catch (error) {
            status.textContent = error.message;
          }
        };
        body.append(heading, label, help, status, resume);
        panel.append(hide, body);
        shadow.append(style, panel, restore);
        document.documentElement.append(host);
      }
      checkbox.checked = state.enabled;
      if (!state.enabled) {
        runner?.stop();
        runner = null;
        manuallyPaused = false;
        resume.hidden = true;
        status.textContent = "已关闭";
        return;
      }
      if (manuallyPaused) return;
      if (document.hidden) {
        status.textContent = "等待聊天页回到前台";
        return;
      }
      if (!runner) {
        runner = createRunner({
          api,
          report: (message) => {
            status.textContent = message;
          },
        });
        status.textContent = "正在检查未读消息";
      }
      await runner.tick();
    } catch (error) {
      if (status) status.textContent = error.message;
    } finally {
      running = false;
    }
  }
  setInterval(update, 1000);
  update();
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isChatURL(location.href)) return;
    if (message.type === controlType) {
      if (message.action === "status") {
        api({ type: stateType })
          .then((state) =>
            respond({
              ok: true,
              data: { enabled: state.enabled, paused: manuallyPaused },
            }),
          )
          .catch((error) => respond({ ok: false, error: error.message }));
        return true;
      }
      if (!["start", "stop"].includes(message.action)) {
        respond({ ok: false, error: "无效的自动回复操作" });
        return;
      }
      const start = message.action === "start";
      runner?.stop();
      runner = null;
      manuallyPaused = false;
      if (resume) resume.hidden = true;
      (async () => {
        const state = await api({ type: stateType });
        if (start && state.busy)
          throw new Error("加分项消息正在处理，请结束后再启动自动回复");
        enabled = await api({
          type: setType,
          enabled: start,
        });
        if (host) {
          host.hidden = false;
          host.shadowRoot.querySelector(".panel").hidden = false;
          host.shadowRoot.querySelector(".restore-panel").hidden = true;
        }
        // Acknowledge the command independently of panel mounting and the
        // potentially slow first conversation. Polling continues processing.
        respond({ ok: true, data: { enabled } });
        update();
      })().catch((error) => respond({ ok: false, error: error.message }));
      return true;
    }
    if (message.type === "TOGGLE") {
      if (host) {
        host.shadowRoot.querySelector(".panel").hidden = false;
        host.shadowRoot.querySelector(".restore-panel").hidden = true;
      } else update();
      respond({ ok: true });
    }
  });
}
