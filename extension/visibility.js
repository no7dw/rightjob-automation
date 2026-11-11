// Hidden tabs may be throttled or wait on a detail-tab handoff. Visibility
// alone is not a workflow failure; keep checking cancellation while waiting.
export async function waitForVisible(
  doc,
  guard,
  {
    wait = (ms) =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          doc.removeEventListener?.("visibilitychange", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        doc.addEventListener?.("visibilitychange", done, { once: true });
      }),
    onWaiting = () => {},
  } = {},
) {
  guard();
  if (doc.hidden) onWaiting();
  while (doc.hidden) {
    await wait(250);
    guard();
  }
  guard();
}
