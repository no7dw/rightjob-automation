// A lost service-worker response must not leave the list scoring forever.
// This deadline is used for scoring only, never for contact/send actions.
export async function scoringRequest(send, timeoutMs = 130000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(send),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("评分响应超时，已跳过当前职位；可稍后重新开始评分")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
