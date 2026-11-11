import { jobId, canonicalURL, normalizeText, parseSalary } from "./core.js";
export const SELECTORS = {
  list: [".rec-job-list", ".job-list-box", ".job-list-container", ".job-list"],
  card: [".job-card-box", ".job-card-wrapper", "li.job-card", ".job-card"],
  detail: [
    ".job-detail-box",
    ".job-detail-container",
    ".job-detail",
    ".job-detail-content",
  ],
  title: [".job-name", ".job-title", ".name"],
  company: [
    ".company-name",
    ".company-info a",
    ".company-name a",
    ".boss-name",
  ],
  salary: [".job-salary", ".salary"],
  jd: [
    ".job-detail-body .desc",
    ".job-sec-text",
    ".job-description",
    ".job-detail-section .text",
    ".job-detail-body .text",
  ],
  location: [
    ".company-location",
    ".job-area",
    ".job-area-wrapper",
    ".job-location",
    ".area-district",
  ],
  tags: [".tag-list", ".job-tag-list", ".job-labels"],
};
export const pick = (root, selectors) =>
  selectors.map((s) => root.querySelector(s)).find(Boolean) || null;
export const visible = (el) =>
  !!(
    el &&
    el.getBoundingClientRect().width &&
    el.getBoundingClientRect().height &&
    getComputedStyle(el).visibility !== "hidden"
  );
export function clickElement(node) {
  if (!node || typeof node.click !== "function") return false;
  const preventJavaScriptURL = (event) => event.preventDefault();
  node.addEventListener("click", preventJavaScriptURL, true);
  try {
    node.click();
    return true;
  } finally {
    node.removeEventListener("click", preventJavaScriptURL, true);
  }
}
export async function ensureCityFilter(city = "深圳", timeout = 8000) {
  const cityId = city === "深圳" ? "101280600" : "";
  const selected = () =>
    !!cityId && new URL(location.href).searchParams.get("city") === cityId;
  if (selected()) return { selected: true, clicked: false, popup_seen: false };

  const exactCityText = (node) =>
    visible(node) &&
    !node.closest("#jseeker-root") &&
    ["城市", city].includes(normalizeText(node.innerText));
  const trigger =
    [
      ...document.querySelectorAll(".condition-filter-select,.filter-select"),
    ].find(exactCityText) ||
    [...document.querySelectorAll("div,span,button,a,[role=button],[tabindex]")]
      .filter(exactCityText)
      .sort((a, b) => a.children.length - b.children.length)[0];
  if (!trigger) return { selected: false, clicked: false, popup_seen: false };
  if (normalizeText(trigger.innerText) === city)
    return { selected: true, clicked: false, popup_seen: false };

  clickElement(trigger);
  const started = Date.now();
  let popupSeen = false;
  while (Date.now() - started < timeout) {
    const popup = [...document.querySelectorAll("div,section,[role=dialog]")]
      .filter(
        (node) =>
          visible(node) &&
          normalizeText(node.innerText).includes("请选择城市") &&
          normalizeText(node.innerText).includes(city),
      )
      .sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
    popupSeen ||= !!popup;
    const option = !popup
      ? null
      : [
          ...popup.querySelectorAll(
            "li,a,button,[role=option],[role=button],span,div",
          ),
        ]
          .filter(
            (node) =>
              visible(node) &&
              !node.closest("#jseeker-root") &&
              normalizeText(node.innerText) === city,
          )
          .sort((a, b) => a.children.length - b.children.length)[0];
    if (option) {
      popupSeen = true;
      clickElement(option);
      for (let i = 0; i < 30; i++) {
        await wait(100);
        if (selected() || normalizeText(trigger.innerText) === city)
          return { selected: true, clicked: true, popup_seen: popupSeen };
      }
      break;
    }
    await wait(150);
  }

  return { selected: false, clicked: true, popup_seen: popupSeen };
}
export function cards() {
  const list = pick(document, SELECTORS.list) || document;
  const seen = new Set(),
    result = [];
  for (const a of list.querySelectorAll('a[href*="/job_detail/"]')) {
    if (a.closest("#jseeker-root")) continue;
    const id = jobId(a.href);
    if (!id || seen.has(id)) continue;
    const card = a.closest(SELECTORS.card.join(","));
    if (!card || card.closest(SELECTORS.detail.join(","))) continue;
    seen.add(id);
    result.push({ id, el: card, link: a });
  }
  return result;
}
export function cardLocation(card) {
  return normalizeText(pick(card?.el, SELECTORS.location)?.innerText);
}
export function detail() {
  return (
    SELECTORS.detail
      .map((s) => [...document.querySelectorAll(s)].find(visible))
      .find(Boolean) || null
  );
}
export function detailId(root = detail()) {
  if (!root) return null;
  const ids = [...root.querySelectorAll('a[href*="/job_detail/"]')]
    .map((a) => jobId(a.href))
    .filter(Boolean);
  const dataId = root.getAttribute("data-job-id");
  if (dataId) ids.push(dataId);
  const unique = [...new Set(ids)];
  return unique.length === 1 ? unique[0] : null;
}

export function contactButton(root = detail()) {
  if (!root) return null;
  return (
    [...root.querySelectorAll("button,a,[role=button]")].find(
      (node) =>
        visible(node) &&
        /^(立即沟通|立即联系|聊一聊)$/.test(
          normalizeText(
            node.innerText || node.getAttribute("aria-label") || "",
          ),
        ),
    ) || null
  );
}
export function existingContactButton(root = detail()) {
  if (!root) return null;
  return [...root.querySelectorAll("button,a,[role=button]")].find(
    (node) => visible(node) && normalizeText(
      node.innerText || node.getAttribute("aria-label") || "",
    ) === "继续沟通",
  ) || null;
}
// Reuse the site's job-to-conversation route, including the first-contact
// confirmation dialog. Do not guess a recruiter from the general inbox.
export async function openBonusConversation(expectedId, {
  waitFor = wait, attempts = 20,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (detailId() !== expectedId || contactLimitReason()) return false;
    const continuations = [...document.querySelectorAll("button,a,[role=button]")]
      .filter((node) => visible(node) && normalizeText(
        node.innerText || node.getAttribute("aria-label") || "",
      ) === "继续沟通");
    const button = existingContactButton() ||
      (continuations.length === 1 ? continuations[0] : null);
    if (button) return clickElement(button);
    await waitFor(200);
  }
  // Some pages retain the original label after creating the conversation.
  if (detailId() !== expectedId) return false;
  const button = contactButton();
  return button ? clickElement(button) : false;
}

export function contactLimitReason() {
  const text = document.body?.innerText || "";
  return /(?:您|你)?已达到沟通上限|今天已与\s*\d+\s*位\s*BOSS\s*沟通/i.test(
    text,
  )
    ? "已达到今日沟通上限，请明天再继续"
    : null;
}

export async function dismissContactPopup(
  timeout = 5000,
  { keepOpen = false } = {},
) {
  const started = Date.now();
  let appeared = false;

  while (Date.now() - started < timeout) {
    const reason = contactLimitReason();
    if (reason) return { appeared: true, dismissed: false, reason };
    const confirmationVisible = [
      ...document.querySelectorAll("div,section,[role=dialog]"),
    ].some(
      (node) =>
        visible(node) &&
        normalizeText(node.innerText).includes("已向BOSS发送消息"),
    );
    if (confirmationVisible) appeared = true;
    if (confirmationVisible && keepOpen)
      return { appeared: true, dismissed: false };

    const leave = [...document.querySelectorAll("button,a,[role=button]")].find(
      (node) =>
        visible(node) &&
        normalizeText(
          node.innerText || node.getAttribute("aria-label") || "",
        ) === "留在此页",
    );
    if (leave) {
      appeared = true;
      clickElement(leave);

      for (let i = 0; i < 20; i++) {
        await wait(100);
        if (!leave.isConnected || !visible(leave))
          return { appeared: true, dismissed: true };
      }
      return { appeared: true, dismissed: false };
    }

    await wait(150);
  }

  return { appeared, dismissed: false };
}
// Capture before opening communication: the general chat list does not carry
// the job in its URL, and several recruiters can work at the same company.
export function bonusContactIdentity(card) {
  const root = detail();
  const text = (node) => normalizeText(node?.innerText || "");
  const recruiter = [root, card?.el].filter(Boolean).map((node) => {
    const name = pick(node, [".job-boss-info h2.name", ".boss-info-attr .name", ".boss-info .boss-name", ".boss-info .name", ".boss-name"]);
    // Live BOSS puts active-time and VIP decorations inside the name heading.
    return normalizeText([...name?.childNodes || []]
      .filter((child) => child.nodeType === 3).map((child) => child.textContent).join("")) || text(name);
  }).find(Boolean) || "";
  return {
    recruiter,
    company: text(pick(card?.el || root, [".company-name", ".company-info a"])) || "",
  };
}
export function scope() {
  const active = [
    ...document.querySelectorAll(
      ".search-condition,.job-search-form,.filter-box,.current-select,.expect-item.active,.expect-item.is-active",
    ),
  ]
    .map((e) => e.innerText)
    .join("\n");
  return {
    url: location.origin + location.pathname + location.search,
    filters: normalizeText(active),
    query: document.querySelector(".job-search-form input")?.value || "",
    location_policy: "unverified-ignore",
  };
}
export function blockedReason() {
  const contactLimit = contactLimitReason();
  if (contactLimit) return contactLimit;
  if (/\/login|\/verify|\/captcha/.test(location.pathname))
    return "登录或验证页面";
  const selectors = [
    ".captcha-container",
    ".geetest_panel",
    ".verify-dialog",
    ".login-dialog",
    ".login-register-container",
  ];
  if (selectors.some((s) => [...document.querySelectorAll(s)].some(visible)))
    return "登录/验证码/访问限制，请手动处理后恢复";
  const text = document.body.innerText.slice(0, 1000);
  if (/访问过于频繁|安全验证|账号异常|请完成验证/.test(text))
    return "检测到访问限制";
  return null;
}
// A title-only rejection needs no detail navigation or JD/OCR capture.
export function readBlacklistedCard(card, keyword) {
  if (jobId(card.link.href) !== card.id) throw new Error("卡片 ID 无法验证");
  return {
    source: "boss", job_id: card.id, url: canonicalURL(card.id),
    title: normalizeText(card.link.innerText),
    company: normalizeText(pick(card.el, SELECTORS.company)?.innerText || ""),
    location_raw: cardLocation(card) || null, location_verified: false,
    jd_raw: null, identity_verified: true, extraction_status: "partial",
    capture_scope: "card", blacklist_keyword: keyword,
    field_sources: { title: "card", company: "card", location: "card", jd: "unknown" },
    quality_flags: ["title_blacklist_before_detail"],
    collected_at: new Date().toISOString(),
  };
}

export function readJob(card) {
  const d = detail();
  if (!d || detailId(d) !== card.id) throw new Error("详情 ID 无法与卡片关联");
  const text = (node) => node?.innerText?.trim() || null;
  const jd = pick(d, SELECTORS.jd);
  const tags = text(pick(card.el, SELECTORS.tags)) || "";
  const titleNode =
    pick(d, [".job-name", ".job-title h1", ".job-title", ".name h1", "h1"]) ||
    pick(card.el, SELECTORS.title) ||
    card.link;
  const salaryNode =
    pick(d, SELECTORS.salary) || pick(card.el, SELECTORS.salary);
  const companyNode = pick(card.el, SELECTORS.company);
  return {
    source: "boss",
    job_id: card.id,
    url: canonicalURL(card.id),
    title: text(titleNode),
    company: text(companyNode),
    salary_raw: text(salaryNode),
    salary: parseSalary(text(salaryNode)),
    location_raw: cardLocation(card) || null,
    location_verified: false,
    experience_raw:
      tags.match(/\d+\s*[-–]\s*\d+年|\d+年以上|经验不限|应届生/)?.[0] || null,
    education_raw: tags.match(/博士|硕士|本科|大专|学历不限/)?.[0] || null,
    jd_raw: text(jd),
    identity_verified: true,
    extraction_status: "success",
    field_sources: {
      title: text(titleNode) ? "dom" : "unknown",
      company: text(companyNode) ? "dom" : "unknown",
      salary: text(salaryNode) ? "dom" : "unknown",
      location: text(pick(card.el, SELECTORS.location)) ? "dom" : "unknown",
      jd: text(jd) ? "dom" : "unknown",
    },
    quality_flags: [],
    collected_at: new Date().toISOString(),
  };
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitForDetail(id, guard, timeout = 12000) {
  let last = "",
    stable = 0;
  let start = Date.now();
  while (Date.now() - start < timeout) {
    const beforeGuard = Date.now();
    await guard();
    start += Date.now() - beforeGuard;
    const d = detail();
    if (detailId(d) === id) {
      const signature = d.innerText;
      if (signature === last && signature.trim().length > 20) stable++;
      else stable = 0;
      last = signature;
      if (stable >= 2) return d;
    }
    await wait(250);
  }
  throw new Error("详情加载超时或无法验证职位 ID");
}
export function scrollable(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement)
    if (
      el.scrollHeight > el.clientHeight + 20 &&
      /auto|scroll/.test(getComputedStyle(el).overflowY)
    )
      return el;
  return document.scrollingElement;
}
export async function nextPageWithinResults(
  guard = () => {},
  { timeoutMs = 5000, pollMs = 200 } = {},
) {
  await guard();
  const list = pick(document, SELECTORS.list);
  if (!list) return false;
  const knownIds = new Set(cards().map((card) => card.id));
  const last = cards().at(-1);
  if (last) last.el.scrollIntoView({ block: "end" });
  const scroller = scrollable(list);
  scroller.scrollTop += Math.max(300, scroller.clientHeight * 0.7);
  // Lazy loading may finish well after the scroll event. Compare IDs rather
  // than counts so virtualized lists that replace their cards also work.
  let deadline = Date.now() + timeoutMs;
  do {
    const beforeGuard = Date.now();
    await guard();
    deadline += Date.now() - beforeGuard;
    if (cards().some((card) => !knownIds.has(card.id))) return true;
    await wait(pollMs);
  } while (Date.now() < deadline);
  await guard();
  return cards().some((card) => !knownIds.has(card.id));
}
export function clipRect(element) {
  const r = element.getBoundingClientRect();
  let x = Math.max(0, r.x),
    y = Math.max(0, r.y),
    right = Math.min(innerWidth, r.right),
    bottom = Math.min(innerHeight, r.bottom);
  // The JD can extend far below a nested scrolling panel. Pixels outside that
  // panel belong to other content, even when they are inside the window.
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    const left = bounds.left + parent.clientLeft;
    const top = bounds.top + parent.clientTop;
    if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
      x = Math.max(x, left);
      right = Math.min(right, left + parent.clientWidth);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
      y = Math.max(y, top);
      bottom = Math.min(bottom, top + parent.clientHeight);
    }
  }
  if (right - x < 8 || bottom - y < 8) throw new Error("截图目标不在可视区域");
  return {
    x,
    y,
    width: right - x,
    height: bottom - y,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  };
}
// Passive collection never scrolls the user's page. The screenshot is tied to
// the verified detail before OCR starts; the user may navigate while Vision runs.
export async function ocrVisibleSalary(card, send) {
  const d = detail();
  if (detailId(d) !== card.id) throw new Error("薪资截图前职位 ID 已改变");
  const node = pick(d, SELECTORS.salary) || pick(card.el, SELECTORS.salary);
  if (!node) throw new Error("当前职位没有可见薪资区域");
  const rect = clipRect(node);
  return send({ type: "OCR", job_id: card.id, rect, kind: "salary", page: 0 });
}
export async function ocrCurrent(
  card,
  send,
  guard,
  fullJD = false,
  onEvidence = () => {},
) {
  const d = detail();
  if (detailId(d) !== card.id) throw new Error("OCR 前身份校验失败");
  const results = [];
  const capture = async (element, kind, page = 0, reveal = true) => {
    await guard();
    if (detailId() !== card.id) throw new Error("OCR 时职位发生变化");
    if (reveal) element.scrollIntoView({ block: "nearest" });
    await wait(150);
    await guard();
    if (detailId() !== card.id) throw new Error("OCR 前职位发生变化");
    const result = await send({
      type: "OCR",
      job_id: card.id,
      rect: clipRect(element),
      kind,
      page,
    });
    await guard();
    if (detailId() !== card.id) throw new Error("OCR 后职位发生变化");
    const captured = { ...result, kind, page };
    results.push(captured);
    await onEvidence(result.evidence_id);
    return captured;
  };
  const titleNode =
    pick(d, [".job-detail-info .job-name", ".job-title h1", "h1"]) || card.link;
  await capture(titleNode, "title");
  const companyNode = pick(card.el, SELECTORS.company);
  if (companyNode) await capture(companyNode, "company");
  const locationNode = pick(card.el, SELECTORS.location);
  if (locationNode) await capture(locationNode, "location");
  const salaryNode =
    pick(d, SELECTORS.salary) || pick(card.el, SELECTORS.salary);
  if (salaryNode) await capture(salaryNode, "salary");
  if (fullJD) {
    const jd = pick(d, SELECTORS.jd) || d;
    const scroller = scrollable(jd),
      before = scroller.scrollTop;
    jd.scrollIntoView({ block: "start" });
    await wait(100);
    try {
      for (let page = 0; page < 20; page++) {
        await guard();
        const r = jd.getBoundingClientRect();
        const clip = clipRect(jd);
        const result = await capture(jd, "jd", page, false);
        result.capture_complete = r.bottom <= clip.y + clip.height + 1;
        if (result.capture_complete) break;
        const last = scroller.scrollTop;
        scroller.scrollTop += Math.max(50, clip.height * 0.7);
        await wait(150);
        if (scroller.scrollTop === last) break;
      }
    } finally {
      scroller.scrollTop = before;
    }
  }
  return results;
}
