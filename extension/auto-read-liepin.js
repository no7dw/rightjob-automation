const TEXT = (node) =>
  (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
const visible = (node) =>
  !!node &&
  node.getBoundingClientRect().width > 0 &&
  node.getBoundingClientRect().height > 0 &&
  getComputedStyle(node).visibility !== "hidden";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ROWS =
  ".im-ui-contact-list-item,.chat-user .user-list li,.user-list li,.chat-list li,.chat-list-item,.chat-user-list li";

export function isLiepinChatInteraction(event) {
  return !!event.target?.closest?.(
    ".im-ui-contact-list-item,.im-ui-chat-container",
  );
}

function rowState(row) {
  const encoded = row.getAttribute("data-tlg-ext");
  if (encoded) {
    try {
      const state = JSON.parse(decodeURIComponent(encoded));
      return {
        unread: state.unread === true,
        key: state.to_imid ? `imid:${state.to_imid}` : "",
        preview: TEXT(row.querySelector(".im-ui-contact-item-message") || row),
      };
    } catch {}
  }
  return {
    unread: null,
    key: "",
    preview: TEXT(row.querySelector(".im-ui-contact-item-message") || row),
  };
}

function unread(row) {
  const state = rowState(row);
  if (state.unread !== null) return state.unread;
  if (row.matches(".unread,[data-unread='true']")) return true;
  // The preview's [未读] is the recruiter's receipt for our outgoing message.
  // It does not mean that this inbox has an unread incoming message.
  return [
    ...row.querySelectorAll(
      ".badge,.notice-badge,.red-dot,.unread-count,[data-unread]",
    ),
  ].some(
    (node) =>
      visible(node) &&
      node.getAttribute("data-unread") !== "0" &&
      TEXT(node) !== "0",
  );
}

export function liepinUnreadRows(doc = document) {
  return [...doc.querySelectorAll(ROWS)].filter(
    (row) => visible(row) && unread(row),
  );
}

export class LiepinAutoRead {
  constructor({ doc = document, report = () => {} }) {
    this.doc = doc;
    this.report = report;
    this.seen = new Set();
    this.retryAt = new Map();
    this.readCount = 0;
    this.cancelled = false;
  }

  stop() {
    this.cancelled = true;
  }

  async tick() {
    if (this.cancelled || this.doc.hidden) return;
    const rows = liepinUnreadRows(this.doc);
    const next = rows
      .map((row) => ({ row, ...rowState(row) }))
      .find(({ row, key, preview }) => {
        const id = key ? `${key}|${preview}` : row;
        return !this.seen.has(id) && (this.retryAt.get(id) || 0) <= Date.now();
      });
    if (!next) {
      const scroller = [
        ...this.doc.querySelectorAll(
          ".im-ui-contacts-wrap [data-overlayscrollbars-viewport],.im-ui-contacts-wrap",
        ),
      ].find(
        (node) => visible(node) && node.scrollHeight > node.clientHeight + 1,
      );
      this.report(
        !scroller && ![...this.doc.querySelectorAll(ROWS)].some(visible)
          ? "请打开猎聘右下角“我的沟通”，打开列表后将自动处理未读消息。"
          : `正在检查未读会话；已标记 ${this.readCount} 个已读。`,
      );
      if (scroller) {
        if (
          scroller.scrollTop + scroller.clientHeight <
          scroller.scrollHeight - 2
        )
          scroller.scrollBy(0, Math.max(150, scroller.clientHeight * 0.8));
        else if (!this.lastReset || Date.now() - this.lastReset > 20000) {
          scroller.scrollTop = 0;
          this.lastReset = Date.now();
        }
      }
      return;
    }
    const id = next.key ? `${next.key}|${next.preview}` : next.row;
    this.seen.add(id);
    next.row.click();
    await sleep(350);
    if (this.cancelled) return;
    // Liepin updates unread in data-tlg-ext after the selected conversation opens.
    if (!next.row.isConnected || !unread(next.row)) {
      this.readCount++;
      this.report(`已打开并标记 ${this.readCount} 个未读会话；不会发送消息。`);
    } else {
      this.retryAt.set(id, Date.now() + 5000);
      this.seen.delete(id);
      this.report("已打开会话，等待猎聘更新未读状态；不会发送消息。");
    }
  }
}
