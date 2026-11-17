export function normalizeCloudBaseUrl(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

export function createCloudClient(storage, fetchImpl = fetch) {
  return async function request(baseUrl, path, body, signal) {
    const root = normalizeCloudBaseUrl(baseUrl);
    if (!root) throw new Error("未配置云端服务地址");
    const local = await storage.local.get(["pay_session_token"]);
    const token =
      typeof local.pay_session_token === "string"
        ? local.pay_session_token.trim()
        : "";
    if (!token) throw new Error("请先登录邮箱账号");
    const response = await fetchImpl(`${root}${path}`, {
      method: path === "/me" ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: path === "/me" ? undefined : JSON.stringify(body || {}),
      signal,
    });
    return response;
  };
}

export async function cloudAuthRequest(
  baseUrl,
  path,
  body = {},
  fetchImpl = fetch,
) {
  const root = normalizeCloudBaseUrl(baseUrl);
  if (!root) throw new Error("未配置云端服务地址");
  const response = await fetchImpl(`${root}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `云端服务 HTTP ${response.status}`);
  return data;
}
