import {
  canonicalURL,
  jobId,
  normalizeText,
  parseSalary,
  MAJOR_CITIES,
  hasPUA,
  stripDecorativePUA,
} from "./core.js";
import { liepinIdentity } from "./sites.js";
import { prepareLiepinBonusDraft } from "./bonus-message-liepin.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (node) => node?.innerText?.trim() || "";
const visible = (node) =>
  !!node &&
  node.getBoundingClientRect().width > 0 &&
  node.getBoundingClientRect().height > 0 &&
  getComputedStyle(node).visibility !== "hidden";
const jobLinks = (root) =>
  [...root.querySelectorAll('a[href*=".shtml"]')].filter((a) =>
    liepinIdentity(a.href),
  );
export function cards() {
  const seen = new Set();
  return jobLinks(document.querySelector(".job-list-box") || document).flatMap(
    (link) => {
      const id = jobId(link.href);
      if (seen.has(id) || link.closest("#jseeker-root")) return [];
      seen.add(id);
      let el = link.closest(".job-list-item") || link;
      // A card may contain nested title/company nodes, but never multiple jobs.
      while (
        !el.classList.contains("job-list-item") &&
        el.parentElement &&
        el.parentElement !== document.body
      ) {
        const parent = el.parentElement;
        if (new Set(jobLinks(parent).map((a) => jobId(a.href))).size !== 1)
          break;
        el = parent;
      }
      return [{ id, el, link }];
    },
  );
}
// Card salary is plain text (e.g. "15-16k", "18-35k·14薪"); the dedicated
// element avoids full-card text where "11小时前在线" defeats parseSalary.
export function cardSalary(card) {
  const dedicated = card.el.querySelector('[class*="salary"]');
  return parseSalary(text(dedicated) || text(card.el));
}
export function cardLocation(card) {
  const title = text(card.link);
  const explicit = title.match(/[【\[]\s*([^】\]]+)\s*[】\]]/)?.[1];
  if (explicit) return explicit;
  return MAJOR_CITIES.find((city) => text(card.el).includes(city)) || "";
}
export function scope() {
  const url = new URL(location.href);
  // Home page timestamps and tracking parameters change on refresh.
  return {
    site: "liepin",
    url: url.origin + url.pathname,
    filters: [
      ...document.querySelectorAll(
        '[role="tab"][aria-selected="true"], .ant-tabs-tab-active, [class*="expect"][class*="active"], [class*="switch-title-item-active"], [class*="switch-sort-active"], [class*="first-sorted-item-active"]',
      ),
    ]
      .map(text)
      .join("\n"),
    query:
      document.querySelector('input[placeholder*="搜索职位"]')?.value || "",
    location_policy: "local-allowlist",
  };
}
function knownChatDialog(node) {
  return (
    (node.matches(".im-ui-basic-chat-modal") &&
      !!node.querySelector(".im-ui-chat-container")) ||
    node.matches("#im-basic-contact.ant-im-drawer-content") ||
    !!node.querySelector(".im-ui-chat-container,#im-basic-contact.ant-im-drawer-content")
  );
}
function painted(node) {
  if (!visible(node)) return false;
  if (
    typeof node.checkVisibility === "function" &&
    !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
    return false;
  // A transparent container with no painted child is an unused ad wrapper,
  // not a popup the user can see or interact with.
  if (text(node) || getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)") return true;
  return [...node.querySelectorAll("*")].some(
    (child) =>
      visible(child) &&
      (typeof child.checkVisibility !== "function" ||
        child.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) &&
      (child.innerText?.trim() ||
        /^(img|canvas|video|svg|iframe)$/i.test(child.tagName)),
  );
}
export function blockedReason({ allowChat = false } = {}) {
  if (/login|captcha|verify/.test(location.pathname))
    return "猎聘登录或验证页面，请手动处理后继续";
  const dialogs = [
    ...document.querySelectorAll(
      '[role="dialog"],.ant-modal,.ant-modal-content,.layui-layer,.dialog,.login-container,.captcha-container,.ant-modal-mask,.adslots[class*="Modal"]',
    ),
  ].filter(painted);
  // JD text, recommendation cards and old chat messages are not platform
  // restrictions. Require a currently painted dialog, alert or toast instead
  // of matching arbitrary text anywhere in document.body.
  const notices = [
    ...dialogs.filter((node) => !knownChatDialog(node)),
    ...document.querySelectorAll(
      '[role="alert"],[role="alertdialog"],.ant-message-notice-content,.ant-notification-notice,.ant-alert,.layui-layer-msg,.error-page,.error-container,.captcha-container',
    ),
  ].filter((node) =>
    painted(node) && !node.closest("#jseeker-root,.job-intro-container,.job-description,.im-ui-chat-container"),
  );
  for (const node of notices) {
    const evidence = text(node).replace(/\s+/g, " ").trim();
    const kind = /(?:已达(?:到)?|达到|超过|超出).{0,16}沟通.{0,8}上限|沟通.{0,16}(?:已达(?:到)?|达到|超过|超出).{0,8}上限|沟通.{0,8}(?:次数|额度).{0,8}(?:用完|不足|已满)/.test(evidence)
      ? "沟通上限"
      : /操作过于频繁|访问过于频繁/.test(evidence)
        ? "操作频繁"
        : /安全验证|请完成验证/.test(evidence)
          ? "需要验证"
          : null;
    if (kind) return `猎聘网站提示${kind}，已暂停：“${evidence.slice(0, 120)}”`;
  }
  if (dialogs.some((node) => !(allowChat && knownChatDialog(node))))
    return "猎聘出现弹窗，已暂停，请手动处理后继续";
  return null;
}
export function detailId() {
  return jobId(location.href);
}
export function readJob(expectedId) {
  if (detailId() !== expectedId) throw new Error("猎聘详情 ID 与目标不一致");
  const title = stripDecorativePUA(
    text(document.querySelector(".job-apply-content .name,.job-title h1,h1")),
  );
  const jd = stripDecorativePUA(
    text(
      document.querySelector(
        '[data-selector="job-intro-content"],.job-intro-container .paragraph dd,.job-description',
      ),
    ),
  );
  if (!title || !jd) throw new Error("猎聘详情尚未就绪或缺少标题/JD");
  const salary = text(
    document.querySelector(".job-apply-content .salary,.job-salary"),
  );
  const properties = [
    ...document.querySelectorAll(".job-apply-content .job-properties span"),
  ]
    .map(text)
    .filter(Boolean);
  const company = text(
    document.querySelector(
      ".company-info .company-name,.company-name,.company-logo-container .name",
    ),
  ) || null;
  const recruiter = document.querySelector(".recruiter-container");
  // Restrict evidence to this job's header/recruiter, not JD or recommendations.
  const hunterEvidence = [
    text(recruiter),
    text(document.querySelector(".job-apply-content")),
    company || "",
  ].flatMap((value) => value.split(/\n/).map((line) => line.trim()))
    .filter((line) => line.includes("猎头"));
  return {
    source: "liepin",
    source_id: liepinIdentity(location.href).source_id,
    job_id: expectedId,
    url: canonicalURL(expectedId),
    title,
    company,
    recruiter_raw: text(recruiter) || null,
    is_headhunter: hunterEvidence.length ? true : null,
    headhunter_evidence: [...new Set(hunterEvidence)].join("\n") || null,
    location_raw: properties[0] || null,
    location_verified: false,
    salary_raw: salary || null,
    salary: parseSalary(salary),
    experience_raw: properties.find((value) => /年|经验/.test(value)) || null,
    education_raw:
      properties.find((value) => /本科|硕士|博士|大专/.test(value)) || null,
    jd_raw: jd,
    identity_verified: true,
    extraction_status: hasPUA(title) || hasPUA(jd) ? "partial" : "success",
    field_sources: {
      title: "dom",
      jd: "dom",
      company: company ? "dom" : "unknown",
      salary: salary ? "dom" : "unknown",
      location: properties[0] ? "dom" : "unknown",
    },
    quality_flags: [
      ...(hasPUA(title) ? ["title_private_font"] : []),
      ...(hasPUA(jd) ? ["jd_private_font"] : []),
    ],
    collected_at: new Date().toISOString(),
  };
}
export function contactButton() {
  return (
    [
      ...document.querySelectorAll(
        ".recruiter-container .btn-chat,.job-apply-operate .btn-main",
      ),
    ].find(
      (node) =>
        visible(node) && /^(聊一聊|继续聊)$/.test(normalizeText(text(node))),
    ) || null
  );
}
export async function contact(expectedId, authorize, authorizeBonusSend) {
  const reason = blockedReason();
  if (reason) return { status: "paused", reason };
  if (document.hidden || detailId() !== expectedId)
    return { status: "paused", reason: "猎聘详情已变化或不在前台" };
  const button = contactButton();
  if (!button) return { status: "paused", reason: "未找到主职位的聊一聊按钮" };
  if (normalizeText(text(button)) === "继续聊")
    return { status: "already_contacted" };
  const permission = await authorize();
  if (document.hidden || detailId() !== expectedId || blockedReason())
    return { status: "paused", reason: "点击前页面状态发生变化" };
  button.click();
  for (let i = 0; i < 50; i++) {
    await wait(200);
    const blocked = blockedReason({ allowChat: true });
    if (blocked) return { status: "paused", reason: blocked };
    if (detailId() !== expectedId)
      return { status: "paused", reason: "沟通后详情页发生跳转，请核实结果" };
    if (normalizeText(text(contactButton())) === "继续聊") {
      const result = { status: "contact_opened" };
      if (permission?.bonus_message) {
        // Drafting is optional: a composer error must not turn a confirmed
        // contact into a failed contact or cause another click on retry.
        try {
          result.bonus_draft = await prepareLiepinBonusDraft(expectedId, permission.bonus_message,
            permission.bonus_auto_send === true ? authorizeBonusSend : null, { detailId, blockedReason });
        } catch {
          result.bonus_draft = { status: "editor_error", message: permission.bonus_message };
        }
      }
      return result;
    }
  }
  return { status: "paused", reason: "未确认沟通结果，已暂停，请核实后继续" };
}
export async function nextPageWithinResults(guard) {
  const before = cards()
    .map((card) => card.id)
    .join(",");
  const roots = new Set([document.scrollingElement]);
  for (const card of cards().slice(-2)) {
    card.el.scrollIntoView({ block: "end" });
    for (let node = card.el.parentElement; node; node = node.parentElement)
      if (node.scrollHeight > node.clientHeight + 50) roots.add(node);
  }
  for (const root of roots) if (root) root.scrollTop = root.scrollHeight;
  const more = [...document.querySelectorAll('button,a,[role="button"]')].find(
    (node) =>
      visible(node) &&
      /^(加载更多|查看更多职位|下一页)$/.test(normalizeText(text(node))) &&
      !node.matches('[disabled],.disabled,[aria-disabled="true"]'),
  );
  if (more) more.click();
  for (let i = 0; i < 12; i++) {
    await wait(250);
    guard();
    if (
      cards()
        .map((card) => card.id)
        .join(",") !== before
    )
      return true;
  }
  return false;
}
