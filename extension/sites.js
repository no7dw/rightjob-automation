// Keep legacy BOSS IDs unchanged; namespace other sites to avoid collisions.
export function siteForURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (["zhipin.com", "www.zhipin.com"].includes(url.hostname)) return "boss";
    if (["liepin.com", "www.liepin.com", "c.liepin.com"].includes(url.hostname))
      return "liepin";
  } catch {}
  return null;
}
export function liepinIdentity(value) {
  if (siteForURL(value) !== "liepin") return null;
  const url = new URL(value);
  if (url.hostname === "c.liepin.com") return null;
  const match = url.pathname.match(/^\/(a|job)\/(\d+)\.shtml$/);
  if (!match) return null;
  return {
    site: "liepin",
    source_id: match[2],
    job_id: `liepin:${match[1]}:${match[2]}`,
    url: `https://www.liepin.com/${match[1]}/${match[2]}.shtml`,
  };
}
export function isListPage(value) {
  try {
    const url = new URL(value);
    const site = siteForURL(value);
    return (
      (site === "boss" && url.pathname === "/web/geek/jobs") ||
      (site === "liepin" &&
        url.hostname === "c.liepin.com" &&
        ["/", "/home/", "/home"].includes(url.pathname))
    );
  } catch {
    return false;
  }
}

export function isBossChatURL(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["www.zhipin.com", "zhipin.com"].includes(url.hostname) &&
      url.pathname === "/web/geek/chat"
    );
  } catch {
    return false;
  }
}

export function isBossBonusDetailURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.zhipin.com", "zhipin.com"].includes(url.hostname) &&
      /^\/job_detail\/[\w~-]+\.html$/.test(url.pathname);
  } catch { return false; }
}
