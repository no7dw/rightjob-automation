import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_TRIAL_QUOTA = 30;
const MAGIC_TTL_MS = 15 * 60 * 1000;
const EXCHANGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function emptyDb() {
  return {
    version: 1,
    users: [],
    magic_links: [],
    exchange_codes: [],
    sessions: [],
    usage_events: [],
  };
}

export function defaultPayDbPath() {
  return resolve(
    process.env.PAY_DB_PATH ||
      process.env.SQLITE_PATH ||
      fileURLToPath(new URL("../data/pay-store.json", import.meta.url)),
  );
}

export function createPayStore(dbPath = defaultPayDbPath()) {
  const path = resolve(dbPath);
  mkdirSync(dirname(path), { recursive: true });

  let db = emptyDb();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      db = {
        ...emptyDb(),
        ...parsed,
        users: Array.isArray(parsed.users) ? parsed.users : [],
        magic_links: Array.isArray(parsed.magic_links) ? parsed.magic_links : [],
        exchange_codes: Array.isArray(parsed.exchange_codes)
          ? parsed.exchange_codes
          : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        usage_events: Array.isArray(parsed.usage_events)
          ? parsed.usage_events
          : [],
      };
    } catch {
      db = emptyDb();
    }
  }

  function persist() {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      enabled: user.enabled !== false,
      plan: user.plan || "trial",
      quota_remaining: Number(user.quota_remaining) || 0,
      quota_total: Number(user.quota_total) || DEFAULT_TRIAL_QUOTA,
      created_at: user.created_at,
      last_login_at: user.last_login_at || null,
    };
  }

  function findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    return db.users.find((user) => user.email === normalized) || null;
  }

  function findUserById(id) {
    return db.users.find((user) => user.id === id) || null;
  }

  function ensureUser(email, { preProvision = false } = {}) {
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      const error = new Error("请输入有效邮箱");
      error.status = 400;
      throw error;
    }
    let user = findUserByEmail(normalized);
    if (user) return user;
    user = {
      id: randomToken(12),
      email: normalized,
      enabled: true,
      plan: "trial",
      quota_remaining: DEFAULT_TRIAL_QUOTA,
      quota_total: DEFAULT_TRIAL_QUOTA,
      created_at: nowIso(),
      last_login_at: null,
      notes: preProvision ? "admin_pre_provision" : "",
    };
    db.users.push(user);
    persist();
    return user;
  }

  function createMagicLink(email) {
    const user = ensureUser(email);
    const token = randomToken(32);
    const entry = {
      token_hash: hashToken(token),
      user_id: user.id,
      email: user.email,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + MAGIC_TTL_MS).toISOString(),
      consumed_at: null,
    };
    db.magic_links = db.magic_links.filter(
      (item) => item.email !== user.email || item.consumed_at,
    );
    db.magic_links.push(entry);
    persist();
    return { token, user, expires_at: entry.expires_at };
  }

  function consumeMagicLink(token) {
    const tokenHash = hashToken(token);
    const entry = db.magic_links.find((item) => item.token_hash === tokenHash);
    if (!entry || entry.consumed_at) {
      const error = new Error("登录链接无效或已使用");
      error.status = 400;
      throw error;
    }
    if (Date.parse(entry.expires_at) < Date.now()) {
      const error = new Error("登录链接已过期，请重新申请");
      error.status = 400;
      throw error;
    }
    entry.consumed_at = nowIso();
    const user = findUserById(entry.user_id) || ensureUser(entry.email);
    user.last_login_at = nowIso();
    const code = randomToken(18);
    db.exchange_codes.push({
      code_hash: hashToken(code),
      user_id: user.id,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + EXCHANGE_TTL_MS).toISOString(),
      consumed_at: null,
    });
    persist();
    return { code, user };
  }

  function exchangeSession(code) {
    const codeHash = hashToken(code);
    const entry = db.exchange_codes.find((item) => item.code_hash === codeHash);
    if (!entry || entry.consumed_at) {
      const error = new Error("兑换码无效或已使用");
      error.status = 400;
      throw error;
    }
    if (Date.parse(entry.expires_at) < Date.now()) {
      const error = new Error("兑换码已过期，请重新登录");
      error.status = 400;
      throw error;
    }
    entry.consumed_at = nowIso();
    const user = findUserById(entry.user_id);
    if (!user) {
      const error = new Error("用户不存在");
      error.status = 400;
      throw error;
    }
    const sessionToken = randomToken(32);
    db.sessions.push({
      token_hash: hashToken(sessionToken),
      user_id: user.id,
      created_at: nowIso(),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      revoked_at: null,
    });
    user.last_login_at = nowIso();
    persist();
    return { session_token: sessionToken, user: publicUser(user) };
  }

  function sessionUser(authorizationHeader) {
    const raw = String(authorizationHeader || "").replace(/^Bearer\s+/i, "").trim();
    if (!raw) return null;
    const tokenHash = hashToken(raw);
    const session = db.sessions.find(
      (item) => item.token_hash === tokenHash && !item.revoked_at,
    );
    if (!session) return null;
    if (Date.parse(session.expires_at) < Date.now()) return null;
    const user = findUserById(session.user_id);
    return user ? publicUser(user) : null;
  }

  function revokeSession(authorizationHeader) {
    const raw = String(authorizationHeader || "").replace(/^Bearer\s+/i, "").trim();
    if (!raw) return false;
    const tokenHash = hashToken(raw);
    const session = db.sessions.find((item) => item.token_hash === tokenHash);
    if (!session || session.revoked_at) return false;
    session.revoked_at = nowIso();
    persist();
    return true;
  }

  function assertHostedAccess(user) {
    if (!user) {
      const error = new Error("请先登录邮箱账号");
      error.status = 401;
      throw error;
    }
    if (user.enabled === false) {
      const error = new Error("账号已停用，请联系管理员开通");
      error.status = 403;
      throw error;
    }
    if ((Number(user.quota_remaining) || 0) <= 0) {
      const error = new Error(
        "试用额度已用尽（成功沟通 30 次）。云端评分与自动沟通已暂停，请联系管理员开通或增加额度",
      );
      error.status = 402;
      throw error;
    }
  }

  function consumeContact(userId, jobId, meta = {}) {
    const user = findUserById(userId);
    if (!user) {
      const error = new Error("用户不存在");
      error.status = 400;
      throw error;
    }
    if (user.enabled === false) {
      const error = new Error("账号已停用，请联系管理员开通");
      error.status = 403;
      throw error;
    }
    const normalizedJobId = String(jobId || "").trim();
    if (!normalizedJobId) {
      const error = new Error("缺少 job_id");
      error.status = 400;
      throw error;
    }
    const existing = db.usage_events.find(
      (event) =>
        event.user_id === userId &&
        event.job_id === normalizedJobId &&
        event.type === "contact",
    );
    if (existing) {
      return {
        deducted: false,
        remaining: Number(user.quota_remaining) || 0,
        user: publicUser(user),
      };
    }
    if ((Number(user.quota_remaining) || 0) <= 0) {
      const error = new Error(
        "试用额度已用尽。云端评分与自动沟通已暂停，请联系管理员开通或增加额度",
      );
      error.status = 402;
      throw error;
    }
    user.quota_remaining = Math.max(0, (Number(user.quota_remaining) || 0) - 1);
    db.usage_events.push({
      id: randomToken(10),
      type: "contact",
      user_id: userId,
      job_id: normalizedJobId,
      created_at: nowIso(),
      meta: {
        run_id: typeof meta.run_id === "string" ? meta.run_id : "",
        site: typeof meta.site === "string" ? meta.site : "",
      },
    });
    persist();
    return {
      deducted: true,
      remaining: Number(user.quota_remaining) || 0,
      user: publicUser(user),
    };
  }

  function listUsers() {
    return db.users
      .map(publicUser)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function updateUser(email, patch = {}) {
    const user = ensureUser(email, { preProvision: true });
    if (typeof patch.enabled === "boolean") user.enabled = patch.enabled;
    if (typeof patch.plan === "string" && patch.plan.trim())
      user.plan = patch.plan.trim();
    if (Number.isFinite(Number(patch.quota_remaining))) {
      user.quota_remaining = Math.max(0, Math.floor(Number(patch.quota_remaining)));
    }
    if (Number.isFinite(Number(patch.quota_total))) {
      user.quota_total = Math.max(0, Math.floor(Number(patch.quota_total)));
    }
    if (Number.isFinite(Number(patch.add_quota))) {
      const add = Math.floor(Number(patch.add_quota));
      user.quota_remaining = Math.max(0, (Number(user.quota_remaining) || 0) + add);
      user.quota_total = Math.max(
        Number(user.quota_total) || 0,
        (Number(user.quota_remaining) || 0),
      );
    }
    if (typeof patch.notes === "string") user.notes = patch.notes;
    persist();
    return publicUser(user);
  }

  function recentUsage(limit = 50) {
    return db.usage_events
      .slice()
      .reverse()
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((event) => ({
        ...event,
        email: findUserById(event.user_id)?.email || "",
      }));
  }

  function safeEqualSecret(provided, expected) {
    const a = Buffer.from(String(provided || ""));
    const b = Buffer.from(String(expected || ""));
    if (!expected || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  return {
    path,
    DEFAULT_TRIAL_QUOTA,
    publicUser,
    ensureUser,
    findUserByEmail,
    findUserById,
    createMagicLink,
    consumeMagicLink,
    exchangeSession,
    sessionUser,
    revokeSession,
    assertHostedAccess,
    consumeContact,
    listUsers,
    updateUser,
    recentUsage,
    safeEqualSecret,
  };
}

export const payConstants = {
  DEFAULT_TRIAL_QUOTA,
  MAGIC_TTL_MS,
  EXCHANGE_TTL_MS,
  SESSION_TTL_MS,
};
