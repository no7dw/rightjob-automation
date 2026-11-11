export { isBossChatURL, isBossBonusDetailURL } from "./sites.js";
import { jobId, normalizeText } from "./core.js";
import { bonusEditors, fillBonusDraft, sendBonusMessage } from "./bonus-editor.js";

const visible = (node) => {
  const rect = node.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    getComputedStyle(node).visibility !== "hidden"
  );
};

function linkedJobs(root) {
  const ids = new Set(
    [...root.querySelectorAll('a[href*="/job_detail/"]')]
      .map((link) => jobId(link.href))
      .filter(Boolean),
  );
  const ownId = root.getAttribute("data-job-id");
  if (ownId) ids.add(ownId);
  return ids;
}

// Match individual rendered fields, never a partial name or company substring.
function hasField(root, value) {
  const expected = normalizeText(value);
  return (
    !!expected &&
    [
      ...root.querySelectorAll(
        ".name,.text,.boss-name,.company-name,.company,.company-info,.job-name,.job-title,.position-name,span,a,p,h2,h3,div",
      ),
    ].some(
      (node) => {
        if (!visible(node)) return false;
        // Names can be direct text beside nested company/role decorations.
        // Compare whole fields, never a substring of the row or preview.
        const ownText = [...(node.childNodes || [])]
          .filter((child) => child.nodeType === 3)
          .map((child) => child.textContent).join("");
        return [node.innerText, ownText].some((text) =>
          normalizeText(text || "").split(/[|｜]/)
            .some((part) => part.trim() === expected));
      },
    )
  );
}

export function selectBossBonusContact(review, doc = document) {
  const rows = [
    ...doc.querySelectorAll(
      ".user-list li,.user-list .user-item,.user-list .friend-item,.chat-user-list li,.chat-list li,.chat-list-item,.user-list .friend-content",
    ),
  ].filter(visible);
  // A row and its nested click target represent one recipient.
  const contacts = rows.filter((row) =>
    !rows.some((other) => other !== row && other.contains?.(row)));
  const matches = contacts.filter((row) => {
    const ids = linkedJobs(row);
    if (ids.size) return ids.size === 1 && ids.has(review.job_id);
    return (
      hasField(row, review.contact?.recruiter) &&
      hasField(row, review.contact?.company)
    );
  });
  if (matches.length !== 1)
    return {
      status: matches.length ? "ambiguous_chat" : "identity_unverified",
    };
  (matches[0].querySelector?.(".friend-content") || matches[0]).click();
  return { status: "contact_selected" };
}

// Verify the opened conversation independently of the list row. Some BOSS
// headers render View Job as a button, so require all three exact fields when
// there is no job link. A conflicting job link always rejects the conversation.
export function bossBonusConversation(
  expectedId,
  doc = document,
  review = null,
) {
  const roots = [
    ...doc.querySelectorAll(
      ".chat-conversation,.chat-window,.chat-dialog,.chat-container",
    ),
  ].filter(visible);
  const verified = roots.filter((root) => {
    const ids = linkedJobs(root);
    if (ids.size) return ids.size === 1 && ids.has(expectedId);
    // The background binds this tab to the exact JD button click through its
    // opener. A unique mounted conversation can establish readiness without
    // searching contacts or relying on masked company/recruiter labels.
    if (review?.direct_entry === true) {
      const conflict = roots.some((outer) => {
        if (outer === root || !outer.contains(root)) return false;
        const outerIds = linkedJobs(outer);
        return outerIds.size && (outerIds.size !== 1 || !outerIds.has(expectedId));
      });
      return !conflict && bonusEditors(root).length > 0;
    }
    const headers = [
      ...root.querySelectorAll(
        ".top-info-content,.chat-header,.chat-info,.conversation-header,.chat-position,.position-content",
      ),
    ].filter(visible);
    return (
      review &&
      [review.contact?.recruiter, review.contact?.company, review.title].every(
        (field) => headers.some((header) => hasField(header, field)),
      )
    );
  });
  // Nested roots describe one conversation; independent matching roots are
  // ambiguous, even if they display the same job.
  const candidates = verified.filter(
    (root) => !verified.some((other) => other !== root && root.contains(other)),
  );
  if (candidates.length !== 1)
    return {
      status: candidates.length ? "ambiguous_chat" : "identity_unverified",
    };
  return { status: "verified", root: candidates[0] };
}

export function fillBossBonusDraft(
  expectedId,
  message,
  doc = document,
  review = null,
) {
  const result = bossBonusConversation(expectedId, doc, review);
  return result.status === "verified"
    ? fillBonusDraft(result.root, message, { commitOnBlur: true })
    : result;
}

export async function prepareBossBonusDraft(expectedId, message, doc = document, review = null, {
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let result = { status: "editor_missing" };
  for (let attempt = 0; attempt < 5; attempt++) {
    const conversation = bossBonusConversation(expectedId, doc, review);
    if (conversation.status !== "verified") return conversation;
    const editors = bonusEditors(conversation.root);
    if (editors.length > 1) return { status: "ambiguous_editor" };
    const editor = editors[0];
    if (!editor) {
      result = { status: "editor_missing" };
      await wait(300);
      continue;
    }
    // Give the focused composer time to attach its controller before writing.
    editor.focus?.();
    await wait(300);
    const current = bossBonusConversation(expectedId, doc, review);
    if (current.status !== "verified") return current;
    if (bonusEditors(current.root)[0] !== editor) continue;
    if (editor.focus && editor.ownerDocument.activeElement !== editor) {
      result = { status: "editor_error" };
      continue;
    }
    result = fillBossBonusDraft(expectedId, message, doc, review);
    if (!["prepared", "already_prepared", "editor_error"].includes(result.status)) return result;
    // Require the same editor and exact text to survive two render cycles.
    let stable = true;
    for (let sample = 0; sample < 2; sample++) {
      await wait(500);
      const verified = bossBonusConversation(expectedId, doc, review);
      if (verified.status !== "verified") return verified;
      const activeEditors = bonusEditors(verified.root);
      const text = ("value" in editor ? editor.value : editor.textContent)?.trim() || "";
      if (activeEditors.length !== 1 || activeEditors[0] !== editor || text !== message.trim()) {
        stable = false;
        break;
      }
    }
    if (stable) return { status: result.status === "already_prepared" ? "already_prepared" : "prepared" };
    result = { status: "editor_error" };
  }
  return result;
}

export async function sendBossBonusMessage(expectedId, message, authorize, doc = document, review = null) {
  const result = bossBonusConversation(expectedId, doc, review);
  if (result.status !== "verified") return result;
  return sendBonusMessage(result.root, message, { authorize,
    sendSelector: 'button,[role="button"],input[type="submit"],.btn-send,.send-btn',
    verify: () => !doc.hidden && bossBonusConversation(expectedId, doc, review).root === result.root,
  });
}
