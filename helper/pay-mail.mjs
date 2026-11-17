export async function sendResendEmail({
  apiKey,
  from,
  to,
  subject,
  html,
  text,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    const error = new Error("未配置 RESEND_API_KEY");
    error.status = 500;
    throw error;
  }
  if (!from) {
    const error = new Error("未配置 RESEND_FROM");
    error.status = 500;
    throw error;
  }
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || `Resend HTTP ${response.status}`,
    );
    error.status = 502;
    throw error;
  }
  return data;
}

export function magicLinkEmailContent({ appName, loginUrl, code }) {
  const subject = `${appName} 登录链接`;
  const text = [
    `点击链接登录 ${appName}：`,
    loginUrl,
    "",
    `若扩展无法自动打开，请复制此兑换码到设置页：`,
    code ? `(完成网页确认后显示)` : "",
    "",
    "链接 15 分钟内有效，且只能使用一次。",
  ]
    .filter(Boolean)
    .join("\n");
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;line-height:1.5;color:#111">
  <p>点击下方按钮登录 <strong>${appName}</strong>：</p>
  <p><a href="${loginUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">登录 JSeeker</a></p>
  <p style="color:#555;font-size:14px">或打开此链接：<br><a href="${loginUrl}">${loginUrl}</a></p>
  <p style="color:#777;font-size:13px">链接 15 分钟内有效，且只能使用一次。若不是你本人操作，请忽略本邮件。</p>
</body></html>`;
  return { subject, html, text };
}
