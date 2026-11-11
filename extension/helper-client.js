// Runs only in the extension service worker. Tokens stay in trusted storage.
export function createHelperClient(
  storage,
  fetchImpl = fetch,
  loadPairingKey = async () => {
    const response = await fetchImpl(
      chrome.runtime.getURL("helper-pairing.json"),
      { cache: "no-store" },
    );
    if (!response.ok)
      throw new Error("缺少本机配对凭据，请运行 npm run build 后重新加载扩展");
    return (await response.json()).key;
  },
) {
  const pairing = new Map();
  async function pair(port) {
    if (!pairing.has(port)) {
      const pending = (async () => {
        const key = await loadPairingKey();
        if (typeof key !== "string" || !key.trim())
          throw new Error(
            "本机配对凭据无效，请运行 npm run build 后重新加载扩展",
          );
        const response = await fetchImpl(`http://127.0.0.1:${port}/pair`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: "{}",
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
          throw new Error(
            "Helper 自动配对失败，请重启新版 Helper；非本项目目录加载的扩展可在高级设置填写连接 Token",
          );
        const data = await response.json();
        if (typeof data.token !== "string" || !data.token.trim())
          throw new Error("Helper 自动配对响应无效");
        const token = data.token.trim();
        await storage.local.set({ helper_token_persisted: token });
        await storage.session.set({ helper_token: token });
        return token;
      })();
      pairing.set(port, pending);
      pending.finally(() => pairing.delete(port)).catch(() => {});
    }
    return pairing.get(port);
  }

  return async function request(port, path, body, signal) {
    try {
      const session = await storage.session.get("helper_token");
      const local = await storage.local.get("helper_token_persisted");
      let token = session.helper_token || local.helper_token_persisted;
      if (!token) token = await pair(port);
      const send = () =>
        fetchImpl(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      let response = await send();
      if (response.status === 401) {
        token = await pair(port);
        response = await send();
      }
      return response;
    } catch (error) {
      if (error instanceof TypeError)
        throw new Error(
          `无法连接本地 Helper（127.0.0.1:${port}），请在项目目录运行 npm run helper`,
        );
      throw error;
    }
  };
}
