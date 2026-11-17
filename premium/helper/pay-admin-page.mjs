export function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JSeeker Pay Admin</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #0b0d10; color: #e8eaed; }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 16px; }
    .card { background: #151a21; border: 1px solid #2a3340; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    label { display: grid; gap: 6px; margin-bottom: 10px; font-size: 13px; color: #9aa3af; }
    input, select, button, textarea { font: inherit; border-radius: 8px; border: 1px solid #3a4556; background: #0f1318; color: #e8eaed; padding: 8px 10px; }
    button { cursor: pointer; background: #3b82f6; border-color: #3b82f6; color: white; }
    button.secondary { background: transparent; color: #e8eaed; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #2a3340; vertical-align: top; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
    .row > * { flex: 1; min-width: 140px; }
    .msg { min-height: 1.2em; color: #93c5fd; font-size: 13px; margin-top: 8px; }
    .err { color: #fca5a5; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
<main>
  <h1>JSeeker Pay Admin</h1>
  <section class="card" id="login-card">
    <label>Admin 密码<input id="password" type="password" autocomplete="current-password" /></label>
    <button id="login" type="button">进入管理</button>
    <div class="msg" id="login-msg"></div>
  </section>
  <section class="card" id="panel" hidden>
    <div class="row">
      <label>邮箱<input id="email" type="email" placeholder="user@example.com" /></label>
      <label>额度<input id="quota" type="number" min="0" step="1" placeholder="30" /></label>
      <label>状态
        <select id="enabled">
          <option value="true">enabled</option>
          <option value="false">disabled</option>
        </select>
      </label>
      <label>计划
        <select id="plan">
          <option value="trial">trial</option>
          <option value="manual_paid">manual_paid</option>
        </select>
      </label>
    </div>
    <div class="row">
      <button id="upsert" type="button">创建/更新用户</button>
      <button id="add30" class="secondary" type="button">+30 额度</button>
      <button id="refresh" class="secondary" type="button">刷新列表</button>
    </div>
    <div class="msg" id="msg"></div>
    <h2 style="font-size:15px;margin:18px 0 8px">用户</h2>
    <div style="overflow:auto"><table>
      <thead><tr><th>邮箱</th><th>状态</th><th>计划</th><th>剩余</th><th>总量</th><th>最近登录</th></tr></thead>
      <tbody id="users"></tbody>
    </table></div>
    <h2 style="font-size:15px;margin:18px 0 8px">最近扣费</h2>
    <div style="overflow:auto"><table>
      <thead><tr><th>时间</th><th>邮箱</th><th>job_id</th><th>扣减</th></tr></thead>
      <tbody id="usage"></tbody>
    </table></div>
  </section>
</main>
<script>
const state = { password: "" };
const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Password": state.password,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
  return data;
}
function render(data) {
  $("users").innerHTML = (data.users || []).map((u) =>
    "<tr><td>" + u.email + "</td><td>" + (u.enabled ? "on" : "off") + "</td><td>" + u.plan +
    "</td><td>" + u.quota_remaining + "</td><td>" + u.quota_total + "</td><td>" + (u.last_login_at || "-") + "</td></tr>"
  ).join("");
  $("usage").innerHTML = (data.usage || []).map((e) =>
    "<tr><td>" + e.created_at + "</td><td>" + (e.email || "") + "</td><td><code>" + e.job_id +
    "</code></td><td>1</td></tr>"
  ).join("");
}
async function refresh() {
  const data = await api("/admin/api/list", {});
  render(data);
}
$("login").onclick = async () => {
  state.password = $("password").value;
  $("login-msg").textContent = "验证中…";
  $("login-msg").className = "msg";
  try {
    await refresh();
    $("login-card").hidden = true;
    $("panel").hidden = false;
  } catch (error) {
    $("login-msg").textContent = error.message;
    $("login-msg").className = "msg err";
  }
};
$("refresh").onclick = async () => {
  try { await refresh(); $("msg").textContent = "已刷新"; $("msg").className = "msg"; }
  catch (error) { $("msg").textContent = error.message; $("msg").className = "msg err"; }
};
$("upsert").onclick = async () => {
  try {
    await api("/admin/api/upsert", {
      email: $("email").value,
      enabled: $("enabled").value === "true",
      plan: $("plan").value,
      quota_remaining: $("quota").value === "" ? undefined : Number($("quota").value),
    });
    await refresh();
    $("msg").textContent = "已保存";
    $("msg").className = "msg";
  } catch (error) {
    $("msg").textContent = error.message;
    $("msg").className = "msg err";
  }
};
$("add30").onclick = async () => {
  try {
    await api("/admin/api/upsert", { email: $("email").value, add_quota: 30, enabled: true });
    await refresh();
    $("msg").textContent = "已增加 30 额度";
    $("msg").className = "msg";
  } catch (error) {
    $("msg").textContent = error.message;
    $("msg").className = "msg err";
  }
};
</script>
</body>
</html>`;
}

export function authCallbackHtml({ appName, code, error }) {
  if (error) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>登录失败</title>
<style>body{font-family:system-ui;padding:40px;background:#0b0d10;color:#e8eaed}code{user-select:all}</style></head>
<body><h1>登录失败</h1><p>${error}</p><p>请回到扩展设置页重新发送登录邮件。</p></body></html>`;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${appName} 登录成功</title>
<style>
body{font-family:system-ui;padding:40px;background:#0b0d10;color:#e8eaed;line-height:1.5}
code,textarea{display:block;width:min(560px,100%);margin:12px 0;padding:12px;border-radius:8px;border:1px solid #333;background:#151a21;color:#fff;font:14px ui-monospace,monospace}
button{padding:10px 14px;border-radius:8px;border:0;background:#3b82f6;color:#fff;cursor:pointer}
.ok{color:#86efac}
</style></head>
<body>
<h1>登录成功</h1>
<p class="ok">请复制下面的兑换码，粘贴回 JSeeker 扩展设置页完成绑定。</p>
<textarea id="code" readonly rows="3">${code}</textarea>
<button type="button" id="copy">复制兑换码</button>
<p id="msg"></p>
<script>
const code = ${JSON.stringify(code)};
document.getElementById("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(code);
    document.getElementById("msg").textContent = "已复制";
  } catch {
    document.getElementById("code").select();
    document.getElementById("msg").textContent = "请手动全选复制";
  }
};
</script>
</body></html>`;
}
