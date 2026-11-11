import { isBossChatURL } from "./sites.js";
import {
  classifyBossMessage,
  chooseChineseResume,
} from "./boss-message-rules.js";

const text = (node) =>
  (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
const visible = (node) =>
  !!node &&
  node.getBoundingClientRect().width > 0 &&
  node.getBoundingClientRect().height > 0 &&
  getComputedStyle(node).visibility !== "hidden";
const find = (root, selector) =>
  [...root.querySelectorAll(selector)].filter(visible);
const unique = (nodes) =>
  nodes.filter(
    (node) => !nodes.some((other) => other !== node && other.contains(node)),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROWS =
  ".user-list li,.user-list .user-item,.user-list .friend-item,.chat-user-list li,.chat-list li,.chat-list-item";
const PREVIEW = ".preview,.last-msg,.last-message,.msg-text,.gray,.text";
const HEADERS =
  ".top-info-content,.chat-header,.chat-info,.conversation-header";
const ROOTS = ".chat-conversation,.chat-window,.chat-dialog,.chat-container";

function contact(row) {
  const nameNode = row.querySelector(".name-text,.name,.boss-name,.user-name");
  const ownName = [...(nameNode?.childNodes || [])]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent.trim())
    .join("")
    .trim();
  const name = ownName || text(nameNode);
  const company = text(
    row.querySelector(".company-name,.company,.company-info") ||
      row.querySelector(".name-box > span:not(.name-text)"),
  )
    .split(/[|｜]/)[0]
    .trim();
  const id = ["data-id", "data-uid", "data-boss-id", "data-contact"]
    .map((attr) => row.getAttribute(attr))
    .find(Boolean);
  // A label alone is not a unique recipient (many recruiters share a surname).
  return {
    name,
    company,
    key: id ? `id:${id}` : name && company ? `fields:${name}|${company}` : "",
  };
}

export function bossUnreadContacts(doc = document) {
  return unique(find(doc, ROWS))
    .filter((row) => {
      const badge = find(
        row,
        ".notice-badge,.badge,.badge-count,.unread-count,.red-dot,[data-unread]",
      );
      return (
        badge.some(
          (node) =>
            node.getAttribute("data-unread") !== "0" && text(node) !== "0",
        ) || row.matches(".unread,[data-unread='true']")
      );
    })
    .map((row) => ({
      row,
      ...contact(row),
      // On BOSS, .text wraps the name, time AND preview. Prefer the actual
      // message leaf so recruiter/company words cannot affect classification.
      preview: text(
        row.querySelector(".last-msg-text") || row.querySelector(PREVIEW),
      ),
    }));
}

function selectedConversation(target, doc) {
  // The unread filter may remove the selected row; the independently rendered
  // conversation header must still agree with the recipient we clicked.
  const roots = find(doc, ROOTS);
  const candidates = roots.filter(
    (root) => !roots.some((other) => other !== root && root.contains(other)),
  );
  if (candidates.length !== 1) return null;
  const root = candidates[0];
  const fields = find(root, `${HEADERS}`)
    .flatMap((header) =>
      find(
        header,
        ".name,.boss-name,.user-name,.company-name,.company,.company-info,span,a,p",
      ).flatMap((node) => [
        text(node),
        ...[...node.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim()),
      ]),
    )
    .flatMap((value) => value.split(/[|｜]/).map((part) => part.trim()));
  if (!target.name || !fields.includes(target.name)) return null;
  const selected = unique(find(doc, ROWS)).filter(
    (row) =>
      row.matches(".active,.selected,.is-active") ||
      row.querySelector(".friend-content.active,.friend-content.selected"),
  );
  if (
    selected.length &&
    (selected.length !== 1 || contact(selected[0]).key !== target.key)
  )
    return null;
  if (target.company && !fields.includes(target.company)) {
    // Live BOSS headers display a recruiter name and role without a company.
    // In that layout require the independently selected name/company row.
    const companyFields = find(root, HEADERS).flatMap((header) =>
      find(header, ".company-name,.company,.company-info"),
    );
    if (companyFields.length || selected.length !== 1) return null;
  }
  // When there is no company field, require the selected stable row identity too.
  if (!target.company && selected.length !== 1) return null;
  return root;
}

function latestIncoming(root) {
  const incoming = find(
    root,
    ".item-friend,.message-item.received,.message-item.is-received,.message-item[data-direction='incoming'],.message-item:not(.item-myself):not(.sent):not(.is-self)[data-from='boss']",
  );
  const last = incoming.at(-1);
  return last
    ? text(
        last.querySelector(".text-content,.message-card-top-title") ||
          last.querySelector(
            ".text,.message-text,.text-content,.message-content",
          ) ||
          last,
      )
    : "";
}

function resumeAlreadyHandled(root) {
  return (
    /附件简历请求已发送|对方已同意.{0,12}简历|简历已发送给对方|对方已查看了?您?的?附件简历/.test(
      text(root),
    ) ||
    find(root, ".item-myself,.message-item.sent,.message-item.is-self").some(
      (node) => /\.pdf\b|附件简历/i.test(text(node)),
    )
  );
}

function enabledButton(node) {
  return (
    !node.disabled &&
    node.getAttribute("aria-disabled") !== "true" &&
    !node.matches(".disabled,.is-disabled")
  );
}

function buttonWithText(root, label) {
  const nodes = find(
    root,
    "button,a,[role='button'],.btn,.op-resume,.btn-resume,.toolbar-btn",
  ).filter((node) => text(node) === label && enabledButton(node));
  return nodes.length === 1 ? nodes[0] : null;
}

function resumeDialog(doc) {
  const dialogs = find(
    doc,
    "[role='dialog'],.dialog-wrap,.dialog-container,.boss-dialog,.resume-dialog,.dialog-resume",
  );
  const matches = dialogs.filter((node) =>
    text(node).includes("请选择要发送的简历"),
  );
  return (
    matches.filter(
      (node) =>
        !matches.some((other) => other !== node && node.contains(other)),
    )[0] || null
  );
}

function resumeChoice(dialog) {
  const nodes = find(
    dialog,
    ".resume-name,.file-name,.attachment-name,.name,[title]",
  );
  const files = nodes
    .map((node) => ({ node, name: node.getAttribute("title") || text(node) }))
    .filter(({ name }) => /\.(pdf|docx?)$/i.test(name));
  const name = chooseChineseResume([
    ...new Set(files.map((file) => file.name)),
  ]);
  const matches = files.filter((file) => file.name === name);
  return matches.length === 1 ? matches[0].node : null;
}

function resumeSelected(choice) {
  const row = choice.closest(
    ".resume-item,.attachment-item,.file-item,li,[role='option']",
  );
  return (
    !!row &&
    (row.matches(
      ".selected,.active,.checked,.is-active,[aria-selected='true']",
    ) ||
      !!row.querySelector(
        "input:checked,[aria-checked='true'],.radio-checked,.checkbox-checked",
      ))
  );
}

async function digest(value) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class BossAutoReply {
  constructor({ doc = document, api, report = () => {} }) {
    this.doc = doc;
    this.api = api;
    this.report = report;
    this.token = crypto.randomUUID();
    this.seen = new Set();
    this.retries = new Map();
    this.cancelled = false;
    this.filtered = false;
    this.readCount = 0;
    this.sentCount = 0;
    this.scanCount = 0;
    this.lastResult = "";
  }

  reportResult(message) {
    this.lastResult = message;
    this.report(message);
  }

  stop() {
    this.cancelled = true;
  }

  async guard() {
    if (
      this.cancelled ||
      this.doc.hidden ||
      !isBossChatURL(this.doc.location.href)
    )
      throw new Error("已暂停");
    if (!(await this.api({ type: "BOSS_AUTO_REPLY_CLAIM", token: this.token })))
      throw new Error("已关闭或其他聊天任务正在处理");
    if (
      this.cancelled ||
      this.doc.hidden ||
      !isBossChatURL(this.doc.location.href)
    )
      throw new Error("已暂停");
  }

  async waitFor(check, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
      await this.guard();
      const value = check();
      if (value) return value;
      await sleep(200);
    }
    return null;
  }

  async process(target) {
    const key = `${target.key}|${target.preview}`;
    const previous = this.retries.get(key);
    if (this.seen.has(key) || (previous && previous.nextAt > Date.now())) return;
    const attempt = (previous?.attempt || 0) + 1;
    try {
      if (await this.processContact(target)) this.seen.add(key);
    } finally {
      if (this.seen.has(key) || attempt >= 3 || this.cancelled) {
        this.retries.delete(key);
        this.seen.add(key);
      } else {
        this.retries.set(key, { target, attempt, nextAt: Date.now() + attempt * 2000 });
      }
    }
  }

  async processContact(target) {
    await this.guard();
    if (resumeDialog(this.doc)) return;
    // Reading a request may remove its unread row. A retry can resume the
    // independently verified open conversation, or resolve one exact live row.
    const rows = unique(find(this.doc, ROWS)).map((row) => ({
      row, ...contact(row), preview: text(
        row.querySelector(".last-msg-text") || row.querySelector(PREVIEW),
      ),
    }));
    const matches = rows.filter((entry) => entry.key === target.key);
    if (matches.length > 1) return true;
    const current = matches[0];
    const retrying = this.retries.has(`${target.key}|${target.preview}`);
    if (current) {
      if (current.preview !== target.preview || (!retrying && current.row !== target.row)) return true;
      (current.row.querySelector(".friend-content") || current.row).click();
    } else {
      if (!retrying) return true;
      const open = selectedConversation(target, this.doc);
      if (!open) return;
      if (latestIncoming(open) !== target.preview) return true;
    }
    if (classifyBossMessage(target.preview) === "rejection") {
      this.readCount++;
      this.reportResult(
        `已读拒绝消息 ${this.readCount} 条；简历发送 ${this.sentCount} 次`,
      );
      return true;
    }
    const ready = await this.waitFor(() => {
      const root = selectedConversation(target, this.doc);
      return root && latestIncoming(root) ? root : null;
    });
    if (!ready) {
      this.reportResult("会话身份或消息未能确认，已跳过");
      return;
    }
    // Let the independently loaded header and messages settle together.
    await sleep(400);
    await this.guard();
    let root = selectedConversation(target, this.doc);
    if (!root) return;
    if (classifyBossMessage(latestIncoming(root)) !== "resume_request" || resumeAlreadyHandled(root))
      return true;
    const request = latestIncoming(root);
    const sendResume = buttonWithText(root, "发简历");
    if (!sendResume) {
      this.reportResult("未找到唯一可用的“发简历”按钮，已跳过");
      return;
    }
    sendResume.click();
    const dialog = await this.waitFor(() => resumeDialog(this.doc));
    if (!dialog) {
      this.reportResult("简历选择窗口未出现，已跳过");
      return;
    }
    const choice = resumeChoice(dialog);
    if (!choice) {
      this.reportResult("未找到唯一中文简历（CN / 中文），请手动选择");
      return true;
    }
    await this.guard();
    choice.click();
    const send = await this.waitFor(
      () => resumeSelected(choice) && buttonWithText(dialog, "发送"),
    );
    if (!send) {
      this.reportResult("简历发送按钮不可用，已跳过");
      return;
    }
    await this.guard();
    root = selectedConversation(target, this.doc);
    if (
      !root ||
      latestIncoming(root) !== request ||
      resumeAlreadyHandled(root) ||
      resumeDialog(this.doc) !== dialog
    )
      return;
    const key = await digest(`${target.key}|${request}`);
    // An authorization request may persist even when its response is lost.
    // From this boundary onward, never retry this request in this document.
    this.seen.add(`${target.key}|${target.preview}`);
    if (
      !(await this.api({
        type: "BOSS_AUTO_REPLY_AUTHORIZE_SEND",
        token: this.token,
        key,
      }))
    ) {
      this.reportResult(
        "此请求已尝试发送或自动回复已关闭；不会重复发送。关闭简历窗口后可继续检查其他消息。",
      );
      return;
    }
    // Recheck synchronously after authorization: no await between final identity
    // validation and the actual click. An uncertain click is never retried.
    root = selectedConversation(target, this.doc);
    if (
      this.cancelled ||
      this.doc.hidden ||
      !isBossChatURL(this.doc.location.href) ||
      !root ||
      latestIncoming(root) !== request ||
      resumeAlreadyHandled(root) ||
      resumeDialog(this.doc) !== dialog ||
      resumeChoice(dialog) !== choice ||
      !resumeSelected(choice) ||
      !send.isConnected ||
      !enabledButton(send)
    )
      return;
    send.click();
    const confirmed = await this.waitFor(() => {
      const current = selectedConversation(target, this.doc);
      return current && resumeAlreadyHandled(current);
    }, 10);
    this.sentCount++;
    this.reportResult(
      confirmed
        ? `已读拒绝消息 ${this.readCount} 条；简历发送 ${this.sentCount} 次`
        : "已尝试发送中文简历，网站结果未确认；不会自动重发",
    );
  }

  async tick() {
    await this.guard();
    if (resumeDialog(this.doc)) {
      this.report(
        this.lastResult || "简历选择窗口已打开，请先完成或关闭窗口后继续",
      );
      return;
    }
    if (!this.filtered) {
      const tabs = find(
        this.doc,
        ".user-list-header button,.user-list-header a,.user-list-header span,.chat-list-header button,.chat-list-header span,[role='tab'],.label-list span,.label-list a,.chat-labels span",
      ).filter((node) => /^未读(?:\s*[（(]?\d+[)）]?)?$/.test(text(node)));
      const matches = tabs.filter(
        (node) => !tabs.some((other) => other !== node && node.contains(other)),
      );
      if (matches.length !== 1) {
        this.report("等待“未读”筛选入口");
        return;
      }
      matches[0].click();
      this.filtered = true;
      await sleep(300);
      await this.guard();
    }
    const contacts = bossUnreadContacts(this.doc);
    const retry = [...this.retries.values()].find((entry) => entry.nextAt <= Date.now());
    const candidate = retry?.target || contacts.find(
      (entry) =>
        entry.key &&
        classifyBossMessage(entry.preview) !== "unknown" &&
        !this.seen.has(`${entry.key}|${entry.preview}`) &&
        !this.retries.has(`${entry.key}|${entry.preview}`) &&
        contacts.filter((other) => other.key === entry.key).length === 1,
    );
    if (candidate) {
      this.report(
        `正在处理${classifyBossMessage(candidate.preview) === "rejection" ? "拒绝消息" : "索要简历的消息"}；已读 ${this.readCount} 条，简历发送 ${this.sentCount} 次`,
      );
      await this.process(candidate);
      return;
    }
    this.scanCount++;
    const counts = { rejection: 0, resume_request: 0, unknown: 0 };
    for (const entry of contacts) counts[classifyBossMessage(entry.preview)]++;
    const blocked = contacts.filter(
      (entry) =>
        classifyBossMessage(entry.preview) !== "unknown" &&
        (!entry.key ||
          contacts.filter((other) => other.key === entry.key).length !== 1),
    );
    const rows = unique(find(this.doc, ROWS));
    this.report(
      rows.length
        ? `第 ${this.scanCount} 轮：识别 ${contacts.length} 个未读会话（拒绝 ${counts.rejection}，索要简历 ${counts.resume_request}，其他 ${counts.unknown}）。已读 ${this.readCount} 条，简历发送 ${this.sentCount} 次。${blocked.length ? `其中 ${blocked.length} 条无法确认唯一联系人，已跳过。` : "等待新消息。"}${this.lastResult ? `\n上次结果：${this.lastResult}` : ""}`
        : "未识别到联系人列表，等待页面加载；若持续出现，请刷新聊天页后重试",
    );
    const list = find(this.doc, ".user-list,.chat-user-list,.chat-list")[0];
    let scroller = list;
    while (
      scroller &&
      scroller !== this.doc.body &&
      scroller.scrollHeight <= scroller.clientHeight + 1
    )
      scroller = scroller.parentElement;
    if (scroller && scroller !== this.doc.body) {
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
  }
}
