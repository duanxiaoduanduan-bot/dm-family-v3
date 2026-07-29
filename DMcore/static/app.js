const API = {
  system: "/api/system",
  processes: "/api/processes",
  kill: (pid) => `/api/processes/${pid}/kill`,
  services: "/api/services",
  serviceAction: (name, action) => `/api/services/${encodeURIComponent(name)}/${action}`,
  projects: "/api/projects",
  projectInstall: (name) => `/api/projects/${encodeURIComponent(name)}/install`,
  projectStart: (name) => `/api/projects/${encodeURIComponent(name)}/start`,
  projectStop: (name) => `/api/projects/${encodeURIComponent(name)}/stop`,
  projectRestart: (name) => `/api/projects/${encodeURIComponent(name)}/restart`,
  projectLogs: (name) => `/api/projects/${encodeURIComponent(name)}/logs`,
  projectMigrate: (name) => `/api/projects/${encodeURIComponent(name)}/migrate`,
  projectAdopt: (name) => `/api/projects/${encodeURIComponent(name)}/adopt`,
  projectUninstall: (name) => `/api/projects/${encodeURIComponent(name)}/uninstall`,
  projectAdd: () => `/api/projects/add`,
};

const state = {
  sort: "cpu",
  order: "desc",
  q: "",
  user: "",
  refreshTimer: null,
};

const $ = (sel) => document.querySelector(sel);

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
function fmtUptime(s) {
  s = Math.floor(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (d ? d + "天 " : "") + `${h}时${m}分`;
}
function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + type;
  setTimeout(() => t.classList.add("hidden"), 2600);
}

// ------------------- 系统概览 -------------------
async function loadSystem() {
  try {
    const r = await fetch(API.system);
    const d = await r.json();
    $("#hostline").textContent = `${d.hostname} · ${d.kernel} · ${d.cpu_count} 核`;
    $("#cpuVal").textContent = d.cpu_percent + "%";
    $("#cpuBar").style.width = d.cpu_percent + "%";
    $("#cpuSub").textContent = `${d.cpu_count} 逻辑核`;
    $("#memVal").textContent = d.memory.percent + "%";
    $("#memBar").style.width = d.memory.percent + "%";
    $("#memSub").textContent = `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`;
    $("#diskVal").textContent = d.disk.percent + "%";
    $("#diskBar").style.width = d.disk.percent + "%";
    $("#diskSub").textContent = `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)}`;
    $("#loadVal").textContent = d.loadavg.join(" / ");
    $("#loadSub").textContent = `${d.process_count} 个进程`;
    $("#upVal").textContent = fmtUptime(d.uptime_seconds);
    $("#upSub").textContent = "自 " + new Date(d.boot_time * 1000).toLocaleString();
    $("#lastUpdate").textContent = "更新于 " + new Date().toLocaleTimeString();
    $("#liveDot").style.background = "var(--ok)";
  } catch (e) {
    $("#liveDot").style.background = "var(--danger)";
  }
}

// ------------------- 进程管理 -------------------
async function loadProcesses() {
  const params = new URLSearchParams({
    sort: state.sort,
    order: state.order,
    q: state.q,
    user: state.user,
  });
  const r = await fetch(`${API.processes}?${params}`);
  const d = await r.json();
  if (!d.ok) {
    toast(d.message || "进程读取失败", "err");
    return;
  }
  const body = $("#procBody");
  body.innerHTML = "";
  for (const p of d.processes) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${p.pid}</td>
      <td>${p.user}</td>
      <td>${p.cpu.toFixed(1)}</td>
      <td>${p.mem.toFixed(1)}</td>
      <td>${fmtBytes(p.rss)}</td>
      <td>${p.tty}</td>
      <td>${p.stat}</td>
      <td>${p.start}</td>
      <td class="cmd" title="${p.command.replace(/"/g, "&quot;")}">${p.command}</td>
      <td>
        <button class="btn danger sm" data-kill="${p.pid}" data-cmd="${p.command.replace(/"/g, "&quot;").slice(0,40)}">终止</button>
      </td>`;
    body.appendChild(tr);
  }
  $("#procCount").textContent = `${d.count} 个进程`;
  fillUserFilter(d.processes);
}

let userOptions = new Set();
function fillUserFilter(procs) {
  procs.forEach((p) => userOptions.add(p.user));
  const sel = $("#procUser");
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部用户</option>';
  [...userOptions].sort().forEach((u) => {
    const o = document.createElement("option");
    o.value = u; o.textContent = u;
    sel.appendChild(o);
  });
  sel.value = cur;
}

// ------------------- 服务管理 -------------------
async function loadServices() {
  const r = await fetch(API.services);
  const d = await r.json();
  const notice = $("#svcNotice");
  if (!d.active) {
    notice.textContent = d.message || "服务管理不可用。";
    notice.classList.remove("hidden");
    $("#svcTable").classList.add("hidden");
    return;
  }
  notice.classList.add("hidden");
  $("#svcTable").classList.remove("hidden");
  const body = $("#svcBody");
  body.innerHTML = "";
  for (const s of d.services) {
    const cls = s.running ? "ok" : (s.active === "failed" ? "danger" : "muted");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.name}</td>
      <td><span class="badge ${cls}">${s.active}</span></td>
      <td>${s.sub}</td>
      <td class="cmd" title="${s.description.replace(/"/g,'&quot;')}">${s.description}</td>
      <td>
        <button class="btn sm" data-svc="${s.name}" data-act="start" ${s.running ? "disabled" : ""}>启动</button>
        <button class="btn danger sm" data-svc="${s.name}" data-act="stop" ${s.running ? "" : "disabled"}>停止</button>
        <button class="btn ghost sm" data-svc="${s.name}" data-act="restart">重启</button>
      </td>`;
    body.appendChild(tr);
  }
}

// ------------------- 项目管理 (DM 家族) -------------------
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

async function loadProjects() {
  try {
    const r = await fetch(API.projects);
    const d = await r.json();
    $("#projRoot").textContent = "根目录: " + d.projects_root;
    renderInstalled(d.installed || []);
    renderAvailable(d.available || []);
    renderDetected(d.detected || []);
  } catch (e) {
    toast("项目列表加载失败", "err");
  }
}

function stateBadge(state) {
  const map = {
    RUNNING: ["ok", "运行中"], STARTING: ["warn", "启动中"], STOPPED: ["muted", "已停止"],
    FATAL: ["danger", "异常"], BACKOFF: ["danger", "异常"], EXITED: ["warn", "已退出"],
  };
  const [cls, txt] = map[state] || ["muted", state];
  return `<span class="badge ${cls}">${txt}</span>`;
}

function renderInstalled(list) {
  const box = $("#projInstalled");
  if (!list.length) {
    box.innerHTML = '<div class="empty">尚未安装任何 DM 项目。可点右上角「＋ 添加项目」手动指定任意路径，或从下方「可安装」一键安装。</div>';
    return;
  }
  box.innerHTML = "";
  list.forEach((p) => {
    const card = document.createElement("div");
    card.className = "proj-card";
    const running = p.state === "RUNNING";
    const desc = (p.manifest && p.manifest.description) || "";
    card.innerHTML = `
      <div class="proj-head">
        <h4>${p.name} ${stateBadge(p.state)}</h4>
        <span class="port-badge">🔌 ${p.port || "—"}</span>
      </div>
      <div class="desc">${desc}</div>
      <div class="meta">${p.path}</div>
      <div class="proj-actions">
        <button class="btn sm" data-pstart="${p.name}" ${running ? "disabled" : ""}>启动</button>
        <button class="btn danger sm" data-pstop="${p.name}" ${running ? "" : "disabled"}>停止</button>
        <button class="btn ghost sm" data-prestart="${p.name}">重启</button>
        <button class="btn ghost sm" data-plog="${p.name}">日志</button>
        <button class="btn ghost sm" data-pmove="${p.name}">换目录</button>
        <button class="btn ghost sm" data-pexport="${p.name}">导出包</button>
        <button class="btn danger sm" data-puninstall="${p.name}">卸载</button>
      </div>`;
    box.appendChild(card);
  });
}

function renderDetected(list) {
  const box = $("#projDetected");
  if (!list.length) {
    box.innerHTML = '<div class="empty">没有自动识别到新应用。可点右上角「＋ 添加项目」手动指定任意路径，或把带 package.json / server.js / app.py 的目录放到 projects_root 下刷新。</div>';
    return;
  }
  box.innerHTML = "";
  list.forEach((p) => {
    const m = p.manifest || {};
    const cmd = m.command || "-";
    const card = document.createElement("div");
    card.className = "proj-card detected";
    card.innerHTML = `
      <div class="proj-head">
        <h4>${p.name} <span class="badge warn">待托管</span></h4>
        <span class="port-badge">🔌 ${p.port || "未知"}</span>
      </div>
      <div class="desc">${m.description || "自动识别的可托管应用"}</div>
      <div class="meta">推断命令 <code>${cmd}</code></div>
      <div class="meta">${p.path}</div>
      <div class="proj-actions">
        <button class="btn sm" data-padopt="${p.name}">一键接管</button>
        <button class="btn ghost sm" data-pedit="${p.name}">自定义命令</button>
      </div>`;
    box.appendChild(card);
  });
}

function renderAvailable(list) {
  const box = $("#projAvailable");
  if (!list.length) {
    box.innerHTML = '<div class="empty">注册表中没有可安装项目。</div>';
    return;
  }
  box.innerHTML = "";
  list.forEach((k) => {
    const card = document.createElement("div");
    card.className = "proj-card";
    card.innerHTML = `
      <div class="proj-head">
        <h4>${k.display}</h4>
        <span class="port-badge">🔌 ${k.port || "—"}</span>
      </div>
      <div class="desc">${k.description || ""}</div>
      <div class="meta">类型 ${k.type} · 来源 ${k.source?.type || "-"} ${k.installed ? "· 已安装" : ""}</div>
      <div class="proj-actions">
        ${k.installed
          ? `<button class="btn ghost sm" disabled>已安装</button>`
          : `<button class="btn sm" data-pinstall="${k.name}">一键安装</button>`}
      </div>`;
    box.appendChild(card);
  });
}

async function showLogs(name) {
  const r = await fetch(API.projectLogs(name));
  const d = await r.json();
  $("#logTitle").textContent = name + " · 日志";
  $("#logBody").textContent = d.log || "(无)";
  $("#logModal").classList.remove("hidden");
}

async function doMigrate(name, mode) {
  let target = "";
  if (mode === "relocate") {
    target = window.prompt("输入目标目录(父目录，如 /workspace 或 /opt/dm):", "/workspace");
    if (!target) return;
  }
  const d = await apiPost(API.projectMigrate(name), { mode, target });
  toast(d.message, d.ok ? "ok" : "err");
  if (d.ok) loadProjects();
}

async function adoptProject(name, custom) {
  let body = {};
  if (custom) {
    const cmd = window.prompt("启动命令(留空用推断值):", "");
    if (cmd === null) return;
    const port = window.prompt("端口(留空用推断值, 0=未知):", "");
    if (port === null) return;
    if (cmd.trim()) body.command = cmd.trim();
    if (port.trim()) body.port = port.trim();
  }
  const d = await apiPost(API.projectAdopt(name), body);
  toast(d.message, d.ok ? "ok" : "err");
  if (d.ok) loadProjects();
}

async function addProjectByPath() {
  const path = window.prompt("项目目录的绝对路径(需含 dm-manifest.json, 或 server.js/app.py 等可识别文件):", "");
  if (!path) return;
  const name = window.prompt("项目名称(留空用目录名):", "");
  if (name === null) return;
  const command = window.prompt("启动命令(留空自动推断; 若目录无 manifest 且无法识别则必填):", "");
  if (command === null) return;
  const port = window.prompt("端口(留空自动推断, 0=未知):", "");
  if (port === null) return;
  const body = { path: path.trim() };
  if (name.trim()) body.name = name.trim();
  if (command.trim()) body.command = command.trim();
  if (port.trim()) body.port = port.trim();
  const d = await apiPost(API.projectAdd(), body);
  toast(d.message, d.ok ? "ok" : "err");
  if (d.ok) loadProjects();
}

// ------------------- 弹窗确认 -------------------
let pending = null;
function confirmDialog(title, text, onOk) {
  pending = onOk;
  $("#modalTitle").textContent = title;
  $("#modalText").textContent = text;
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); pending = null; }

// ------------------- 事件绑定 -------------------
function bindEvents() {
  // 标签页
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $("#" + t.dataset.tab).classList.add("active");
      if (t.dataset.tab === "svc") loadServices();
      if (t.dataset.tab === "proj") loadProjects();
    });
  });

  // 搜索 / 过滤
  let searchTimer;
  $("#procSearch").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadProcesses(); }, 250);
  });
  $("#procUser").addEventListener("change", (e) => { state.user = e.target.value; loadProcesses(); });

  // 排序表头
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort === key) state.order = state.order === "desc" ? "asc" : "desc";
      else { state.sort = key; state.order = "desc"; }
      loadProcesses();
    });
  });

  // 终止进程 (事件委托)
  $("#procBody").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kill]");
    if (!btn) return;
    const pid = btn.dataset.kill;
    confirmDialog("终止进程", `确认向 PID ${pid} (${btn.dataset.cmd}) 发送 TERM 信号?`, async () => {
      const r = await fetch(API.kill(pid), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signal: "TERM" }),
      });
      const d = await r.json();
      toast(d.message, d.ok ? "ok" : "err");
      if (d.ok) loadProcesses();
    });
  });

  // 服务操作 (事件委托)
  $("#svcBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-svc]");
    if (!btn) return;
    const name = btn.dataset.svc, act = btn.dataset.act;
    confirmDialog("服务操作", `确认对 ${name} 执行 ${act}?`, async () => {
      const r = await fetch(API.serviceAction(name, act), { method: "POST" });
      const d = await r.json();
      toast(d.message, d.ok ? "ok" : "err");
      if (d.ok) loadServices();
    });
  });

  // 弹窗按钮
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalOk").addEventListener("click", () => { if (pending) pending(); closeModal(); });

  // 手动刷新
  $("#refreshBtn").addEventListener("click", () => { loadSystem(); loadProcesses(); });

  // 项目管理：刷新 + 卡片操作委托
  $("#projRefresh").addEventListener("click", loadProjects);
  $("#projAdd").addEventListener("click", addProjectByPath);
  $("#projInstalled").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pstart],[data-pstop],[data-prestart],[data-plog],[data-pmove],[data-pexport],[data-puninstall]");
    if (!b) return;
    const name = b.dataset.pstart || b.dataset.pstop || b.dataset.prestart ||
                 b.dataset.plog || b.dataset.pmove || b.dataset.pexport || b.dataset.puninstall;
    if (b.dataset.pstart) { const d = await apiPost(API.projectStart(name), {}); toast(d.message, d.ok ? "ok" : "err"); loadProjects(); }
    else if (b.dataset.pstop) { const d = await apiPost(API.projectStop(name), {}); toast(d.message, d.ok ? "ok" : "err"); loadProjects(); }
    else if (b.dataset.prestart) { const d = await apiPost(API.projectRestart(name), {}); toast(d.message, d.ok ? "ok" : "err"); loadProjects(); }
    else if (b.dataset.plog) { showLogs(name); }
    else if (b.dataset.pmove) { doMigrate(name, "relocate"); }
    else if (b.dataset.pexport) { doMigrate(name, "export"); }
    else if (b.dataset.puninstall) {
      confirmDialog("卸载项目", `确认卸载 ${name}？将停止托管并移除 DMcore 管理配置，项目目录默认保留(可重新接管)。`, async () => {
        const d = await apiPost(API.projectUninstall(name), {});
        toast(d.message, d.ok ? "ok" : "err");
        if (d.ok) loadProjects();
      });
    }
  });
  $("#projAvailable").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pinstall]");
    if (!b) return;
    const name = b.dataset.pinstall;
    const d = await apiPost(API.projectInstall(name), {});
    toast(d.message, d.ok ? "ok" : "err");
    if (d.ok) loadProjects();
  });
  $("#projDetected").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-padopt],[data-pedit]");
    if (!b) return;
    const name = b.dataset.padopt || b.dataset.pedit;
    if (b.dataset.padopt) {
      await adoptProject(name, false);
    } else if (b.dataset.pedit) {
      await adoptProject(name, true);
    }
  });
  $("#logClose").addEventListener("click", () => $("#logModal").classList.add("hidden"));
}

function startPolling() {
  loadSystem();
  loadProcesses();
  loadProjects();
  state.refreshTimer = setInterval(() => { loadSystem(); loadProcesses(); loadProjects(); }, 5000);
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  startPolling();
});
