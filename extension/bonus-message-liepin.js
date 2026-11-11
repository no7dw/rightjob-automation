import { fillBonusDraft, sendBonusMessage } from "./bonus-editor.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => {
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
};

export async function prepareLiepinBonusDraft(expectedId, message, authorizeSend, { detailId, blockedReason }) {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (document.hidden || detailId() !== expectedId || blockedReason({ allowChat: true }))
      return { status: "page_changed", message };
    const roots = [...document.querySelectorAll(".im-ui-chat-container")].filter(visible);
    if (roots.length > 1) return { status: "ambiguous_chat", message };
    const draft = fillBonusDraft(roots[0], message, { commitOnBlur: true });
    if (authorizeSend && ["prepared", "already_prepared"].includes(draft.status)) {
      const sent = await sendBonusMessage(roots[0], message, { authorize: authorizeSend,
        sendSelector: 'button,[role="button"],input[type="submit"],.im-ui-send-btn',
        verify: () => !document.hidden && detailId() === expectedId &&
          !blockedReason({ allowChat: true }) && roots[0].isConnected,
      });
      return { ...sent, message };
    }
    if (draft.status !== "editor_missing") return { ...draft, message };
    await wait(200);
  }
  return { status: "editor_missing", message };
}
