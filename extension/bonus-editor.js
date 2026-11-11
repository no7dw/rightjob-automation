export function bonusEditors(root) {
  if (!root) return [];
  return [
    ...root.querySelectorAll(
      'textarea,[contenteditable="true"],[role="textbox"]',
    ),
  ].filter((node) => {
    const rect = node.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      !node.disabled &&
      !node.readOnly &&
      getComputedStyle(node).visibility !== "hidden" &&
      !/搜索|search/i.test(node.getAttribute("placeholder") || "")
    );
  });
}

// Plain input events only: never click Send or synthesize Enter, and never
// replace an existing user draft. The caller must identify the current chat.
export function fillBonusDraft(root, message, { commitOnBlur = false } = {}) {
  if (!root || !message) return { status: "editor_missing" };
  const editors = bonusEditors(root);
  if (editors.length !== 1)
    return { status: editors.length ? "ambiguous_editor" : "editor_missing" };
  const editor = editors[0];
  const isValue = "value" in editor;
  const current = isValue ? editor.value : editor.textContent;
  const view = editor.ownerDocument.defaultView;
  // Platform callers opt into blur persistence, including for unfocused editors.
  const commit = () => {
    if (commitOnBlur) editor.dispatchEvent(new (view.FocusEvent || view.Event)("blur"));
  };
  if (current?.trim()) {
    const same = current.trim() === message;
    if (same) commit();
    return { status: same ? "already_prepared" : "existing_draft" };
  }
  // A freshly mounted rich editor can drop text assigned before its input
  // controller attaches. Focus first and prefer the browser insertion path.
  editor.focus?.();
  let inserted = false;
  if (!isValue && view?.document?.execCommand) {
    // Focus alone can leave a stale selection in a previously mounted editor.
    const selection = view.getSelection?.();
    if (selection && view.document.createRange) {
      const range = view.document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try { inserted = view.document.execCommand("insertText", false, message); }
    catch { /* Fall back to plain text insertion below. */ }
  }
  if (isValue) {
    const prototype =
      editor.tagName === "TEXTAREA"
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      editor,
      message,
    );
  } else if (!inserted) editor.textContent = message;
  editor.dispatchEvent(
    new view.InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: message,
    }),
  );
  editor.dispatchEvent(new view.Event("change", { bubbles: true }));
  commit();
  return {
    status:
      ("value" in editor ? editor.value : editor.textContent)?.trim() === message.trim()
        ? "prepared"
        : "editor_error",
  };
}

// Explicit opt-in only. The background persists a one-shot send authorization
// before the click so reloads and uncertain outcomes cannot submit twice.
export async function sendBonusMessage(root, message, {
  authorize = async () => false,
  verify = () => true,
  sendSelector = 'button,[role="button"],input[type="submit"]',
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let clicked = false;
  try {
    const editors = bonusEditors(root);
    if (editors.length !== 1) return { status: "ambiguous_editor" };
    const editor = editors[0];
    const text = () => ("value" in editor ? editor.value : editor.textContent)?.trim() || "";
    if (!message || text() !== message.trim() || !verify()) return { status: "existing_draft" };
    const sendButtonFilter = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
        !node.disabled && node.getAttribute("aria-disabled") !== "true" &&
        !/(?:^|[\s-])disabled(?:$|[\s-])/.test(node.className || "") &&
        /^(发送|send)$/i.test(String(node.innerText || node.textContent || node.value || node.getAttribute("aria-label") || "").trim());
    };
    const findButtons = () => [...root.querySelectorAll(sendSelector)].filter(sendButtonFilter);
    let buttons = findButtons();
    for (let attempt = 0; buttons.length !== 1 && attempt < 5; attempt++) {
      await wait(200);
      buttons = findButtons();
    }
    if (buttons.length !== 1) return { status: "send_button_missing" };
    if (!await authorize()) return { status: "prepared" };
    // Authorization is asynchronous: verify the exact editor and target again.
    const currentEditors = bonusEditors(root);
    const currentButtons = findButtons();
    if (!verify() || text() !== message.trim() || currentEditors.length !== 1 ||
        currentEditors[0] !== editor || editor.isConnected === false ||
        currentButtons.length !== 1 || currentButtons[0] !== buttons[0] ||
        buttons[0].isConnected === false)
      return { status: "send_unconfirmed" };
    clicked = true;
    buttons[0].click();
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(200);
      if (!verify()) return { status: "send_unconfirmed" };
      if (!text()) return { status: "sent" };
    }
    return { status: "send_unconfirmed" };
  } catch {
    return { status: clicked ? "send_unconfirmed" : "send_error" };
  }
}
