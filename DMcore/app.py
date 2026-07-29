#!/usr/bin/env python3
"""
DMcore —— 轻量级 Linux 运维 Web 控制台
后端: Flask + 标准系统工具(ps/free/df/uptime/systemctl)
进程管理为核心功能(真实可用)，systemd 服务视图在不可用环境下优雅降级。
"""

import os
import re
import json
import time
import signal
import subprocess
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request, send_file

import projects as proj

app = Flask(__name__)

# 允许的 kill 信号，避免任意信号注入
ALLOWED_SIGNALS = {
    "TERM": signal.SIGTERM,   # 15 优雅终止
    "KILL": signal.SIGKILL,   # 9  强制终止
    "INT": signal.SIGINT,     # 2  中断
    "HUP": signal.SIGHUP,     # 1  挂起/重载
}

# systemd 是否真正可用(由启动探测决定)
_SYSTEMD_ACTIVE = None


def systemd_active():
    """探测 systemd 是否真正接管系统(容器里常是 supervisord 而非 systemd)。"""
    global _SYSTEMD_ACTIVE
    if _SYSTEMD_ACTIVE is not None:
        return _SYSTEMD_ACTIVE
    try:
        out = subprocess.run(
            ["systemctl", "is-system-running"],
            capture_output=True, text=True, timeout=5,
        )
        # 返回 running/degraded 视为可用；其他(如 "System has not been booted")则降级
        _SYSTEMD_ACTIVE = out.returncode == 0 and out.stdout.strip() in (
            "running", "degraded"
        )
    except Exception:
        _SYSTEMD_ACTIVE = False
    return _SYSTEMD_ACTIVE


# ------------------------- 系统指标 -------------------------
def _cpu_percent():
    """基于 /proc/stat 两次采样计算整体 CPU 使用率。"""
    def _read():
        with open("/proc/stat") as f:
            parts = list(map(int, f.readline().split()[1:]))
        idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
        total = sum(parts)
        return total, idle
    try:
        t1, i1 = _read()
        time.sleep(0.2)
        t2, i2 = _read()
        if t2 - t1 == 0:
            return 0.0
        return round(100.0 * (1 - (i2 - i1) / (t2 - t1)), 1)
    except Exception:
        return 0.0


def _load_avg():
    try:
        with open("/proc/loadavg") as f:
            return f.read().split()[:3]
    except Exception:
        return ["-", "-", "-"]


def _memory():
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k.strip()] = int(v.strip().split()[0]) * 1024  # 字节
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", info.get("MemFree", 0))
        used = total - avail
        return {
            "total": total,
            "used": used,
            "available": avail,
            "percent": round(used / total * 100, 1) if total else 0.0,
        }
    except Exception:
        return {"total": 0, "used": 0, "available": 0, "percent": 0.0}


def _disk():
    try:
        out = subprocess.run(
            ["df", "-B1", "/"], capture_output=True, text=True, timeout=5
        )
        lines = out.stdout.strip().splitlines()
        if len(lines) >= 2:
            _, total, used, avail, percent, _ = lines[1].split()
            return {
                "total": int(total),
                "used": int(used),
                "available": int(avail),
                "percent": int(percent.rstrip("%")),
            }
    except Exception:
        pass
    return {"total": 0, "used": 0, "available": 0, "percent": 0}


def _uptime_seconds():
    try:
        with open("/proc/uptime") as f:
            return float(f.read().split()[0])
    except Exception:
        return 0.0


def _hostname():
    return os.uname().nodename


def _boot_time():
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime"):
                    return int(line.split()[1])
    except Exception:
        return 0
    return 0


# ------------------------- 进程管理 -------------------------
def _parse_ps():
    """解析 `ps aux` 输出为结构化列表。"""
    try:
        out = subprocess.run(
            ["ps", "aux", "--sort=-%cpu"],
            capture_output=True, text=True, timeout=8,
        )
        lines = out.stdout.strip().splitlines()
        if not lines:
            return []
        header = lines[0].split()
        procs = []
        for line in lines[1:]:
            # 用户名可能含空格，按固定列切分更稳妥
            parts = line.split(None, 10)
            if len(parts) < 11:
                continue
            user, pid, cpu, mem, vsz, rss, tty, stat, start, time_, cmd = parts
            procs.append({
                "user": user,
                "pid": int(pid),
                "cpu": float(cpu),
                "mem": float(mem),
                "vsz": int(vsz) * 1024,        # KB -> 字节
                "rss": int(rss) * 1024,
                "tty": tty,
                "stat": stat,
                "start": start,
                "time": time_,
                "command": cmd,
            })
        return procs
    except Exception as e:
        return [{"error": str(e)}]


def _sort_procs(procs, sort="cpu", order="desc"):
    if not procs or "error" in procs[0]:
        return procs
    reverse = order != "asc"
    try:
        procs.sort(key=lambda p: p.get(sort, 0), reverse=reverse)
    except Exception:
        pass
    return procs


# ------------------------- 服务管理(systemd) -------------------------
def _list_services():
    if not systemd_active():
        return {
            "active": False,
            "message": "systemd 未接管本系统(容器/非 systemd 环境)，服务管理不可用。请使用「进程管理」标签页。",
            "services": [],
        }
    try:
        out = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--no-legend", "--no-pager"],
            capture_output=True, text=True, timeout=10,
        )
        services = []
        for line in out.stdout.strip().splitlines():
            cols = line.split()
            if len(cols) < 4:
                continue
            name = cols[0]
            loaded = cols[1]
            active = cols[2]
            sub = cols[3]
            desc = " ".join(cols[4:]) if len(cols) > 4 else ""
            services.append({
                "name": name,
                "loaded": loaded,
                "active": active,
                "sub": sub,
                "description": desc,
                "running": active == "active" and sub == "running",
            })
        return {"active": True, "message": "", "services": services}
    except Exception as e:
        return {"active": False, "message": f"读取服务失败: {e}", "services": []}


def _service_action(name, action):
    if not systemd_active():
        return {"ok": False, "message": "systemd 不可用，无法执行服务操作。"}
    if action not in ("start", "stop", "restart"):
        return {"ok": False, "message": "不支持的操作。"}
    try:
        out = subprocess.run(
            ["systemctl", action, name],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode == 0:
            return {"ok": True, "message": f"{name} 已执行 {action}。"}
        return {"ok": False, "message": out.stderr.strip() or "操作失败。"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# ------------------------- 路由 -------------------------
@app.route("/")
def index():
    return render_template("index.html", systemd=systemd_active())


@app.route("/api/system")
def api_system():
    procs = _parse_ps()
    proc_count = len(procs) if "error" not in (procs[0] if procs else {} ) else 0
    return jsonify({
        "hostname": _hostname(),
        "kernel": os.uname().release,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "uptime_seconds": _uptime_seconds(),
        "boot_time": _boot_time(),
        "loadavg": _load_avg(),
        "cpu_percent": _cpu_percent(),
        "memory": _memory(),
        "disk": _disk(),
        "process_count": proc_count,
        "cpu_count": os.cpu_count() or 1,
    })


@app.route("/api/processes")
def api_processes():
    procs = _parse_ps()
    if procs and "error" in procs[0]:
        return jsonify({"ok": False, "message": procs[0]["error"], "processes": []})

    sort = request.args.get("sort", "cpu")
    order = request.args.get("order", "desc")
    q = (request.args.get("q") or "").strip().lower()
    user = (request.args.get("user") or "").strip()

    # 仅允许已知排序字段，防注入
    allowed = {"cpu", "mem", "pid", "rss", "vsz", "time", "user", "start"}
    if sort not in allowed:
        sort = "cpu"

    if q:
        procs = [p for p in procs if q in p["command"].lower() or q in p["user"].lower()
                 or str(p["pid"]) == q]
    if user:
        procs = [p for p in procs if p["user"] == user]

    procs = _sort_procs(procs, sort=sort, order=order)
    return jsonify({"ok": True, "count": len(procs), "processes": procs})


@app.route("/api/processes/<int:pid>/kill", methods=["POST"])
def api_kill(pid):
    data = request.get_json(silent=True) or {}
    sig_name = str(data.get("signal", "TERM")).upper()
    sig = ALLOWED_SIGNALS.get(sig_name)
    if sig is None:
        return jsonify({"ok": False, "message": "非法的信号类型。"}), 400
    try:
        os.kill(pid, sig)
        return jsonify({"ok": True, "message": f"已向 PID {pid} 发送 {sig_name} 信号。"})
    except ProcessLookupError:
        return jsonify({"ok": False, "message": f"PID {pid} 不存在。"})
    except PermissionError:
        return jsonify({"ok": False, "message": f"无权限终止 PID {pid}。"})
    except Exception as e:
        return jsonify({"ok": False, "message": str(e)})


@app.route("/api/services")
def api_services():
    return jsonify(_list_services())


@app.route("/api/services/<path:name>/<action>", methods=["POST"])
def api_service_action(name, action):
    result = _service_action(name, action)
    status = 200 if result.get("ok") else 400
    return jsonify(result), status


# ------------------------- 项目管理(DM 家族) -------------------------
@app.route("/api/projects")
def api_projects():
    # DMcore 自身不参与项目管理列表(避免在管控页出现一张「DMcore 已停止」的无用卡片)
    def _exclude_dmcore(lst):
        return [p for p in lst if p.get("name") != "DMcore"]
    return jsonify({
        "installed": _exclude_dmcore(proj.discover()),
        "available": _exclude_dmcore(proj.known_projects()),
        "detected": _exclude_dmcore(proj.detect()),
        "projects_root": proj.projects_root(),
    })


@app.route("/api/projects/<name>/install", methods=["POST"])
def api_project_install(name):
    return jsonify(proj.install(name))


@app.route("/api/projects/<name>/adopt", methods=["POST"])
def api_project_adopt(name):
    data = request.get_json(silent=True) or {}
    return jsonify(proj.adopt(name, data.get("command"), data.get("port")))


@app.route("/api/projects/add", methods=["POST"])
def api_project_add():
    """手动添加一个位于任意路径的项目(不限于 projects_root 扫描)。"""
    data = request.get_json(silent=True) or {}
    path = (data.get("path") or "").strip()
    if not path:
        return jsonify({"ok": False, "message": "缺少 path 参数(项目目录绝对路径)。"})
    return jsonify(proj.add_by_path(path, data.get("name"), data.get("command"), data.get("port")))


@app.route("/api/projects/<name>/uninstall", methods=["POST"])
def api_project_uninstall(name):
    data = request.get_json(silent=True) or {}
    return jsonify(proj.uninstall(name, bool(data.get("remove_files", False))))


@app.route("/api/projects/<name>/start", methods=["POST"])
def api_project_start(name):
    return jsonify(proj.start(name))


@app.route("/api/projects/<name>/stop", methods=["POST"])
def api_project_stop(name):
    return jsonify(proj.stop(name))


@app.route("/api/projects/<name>/restart", methods=["POST"])
def api_project_restart(name):
    return jsonify(proj.restart(name))


@app.route("/api/projects/<name>/logs")
def api_project_logs(name):
    return jsonify(proj.logs(name))


@app.route("/api/projects/<name>/migrate", methods=["POST"])
def api_project_migrate(name):
    data = request.get_json(silent=True) or {}
    target = data.get("target", "")
    mode = data.get("mode", "relocate")
    if mode not in ("relocate", "export"):
        return jsonify({"ok": False, "message": "未知移植模式。"})
    if mode == "relocate" and not target:
        return jsonify({"ok": False, "message": "换目录移植需要 target 路径。"})
    return jsonify(proj.migrate(name, target, mode))


@app.route("/api/projects/<name>/download")
def api_project_download(name):
    import os
    f = request.args.get("f", "")
    # 防目录穿越
    if not f or "/" in f or not f.startswith(name + "-") or not f.endswith(".tar.gz"):
        return jsonify({"ok": False, "message": "非法文件名。"}), 400
    path = os.path.join(proj.EXPORTS_DIR, f)
    if not os.path.isfile(path):
        return jsonify({"ok": False, "message": "文件不存在。"}), 404
    return send_file(path, as_attachment=True, download_name=f)


@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok", "name": "DMcore", "systemd": systemd_active()})


if __name__ == "__main__":
    port = int(os.environ.get("DMCORE_PORT", "8088"))
    host = os.environ.get("DMCORE_HOST", "0.0.0.0")

    # ── 获取本机 IP ──
    import socket
    ips = set()
    try:
        # 方法1: socket (最可靠)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        # 方法2: hostname -I
        import subprocess
        out = subprocess.check_output(["hostname", "-I"], timeout=2).decode().strip()
        for ip in out.split():
            if ip != "127.0.0.1" and not ip.startswith("docker") and not ip.startswith("br-"):
                ips.add(ip)
    except Exception:
        pass
    ips.add("127.0.0.1")

    # ── 服务端口表 ──
    SERVICES = [
        ("8080", "统一入口(反向代理)"),
        ("8081", "DMmedia 媒体网盘"),
        ("8083", "DMChat 聊天·一起看"),
        ("8084", "DMgeo 地图·地理"),
        ("8085", "DMpageo 合并门户"),
        ("8086", "DMshow 个人主页·幻灯刷"),
        ("8087", "文件管理器"),
        ("8088", "DMcore 运维控制台"),
    ]

    print("")
    print("  ╔══════════════════════════════════════════╗")
    print("  ║        DM 家族 已启动                    ║")
    print("  ╠══════════════════════════════════════════╣")
    for ip in sorted(ips):
        print(f"  ║  🌐 http://{ip}:8080  统一入口".ljust(47) + "║")
        for svc_port, svc_name in SERVICES:
            if svc_port == "8080":
                continue
            print(f"  ║    └ http://{ip}:{svc_port}  {svc_name}".ljust(47) + "║")
    print("  ╠══════════════════════════════════════════╣")
    print("  ║  各服务默认不启动，进入控制台点击启动     ║")
    print("  ╚══════════════════════════════════════════╝")
    print("")

    # ── 启动统一入口反向代理(8080) ──
    proxy_js = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy.js")
    proxy_proc = None
    if os.path.isfile(proxy_js):
        try:
            proxy_proc = subprocess.Popen(
                ["node", proxy_js],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            print(f"  🔄 统一入口代理已启动: http://0.0.0.0:8080")
        except Exception as e:
            print(f"  ⚠️ 统一入口代理启动失败: {e}")

    # ── 尝试自动打开浏览器 ──
    try:
        import webbrowser
        webbrowser.open(f"http://127.0.0.1:8080")
    except Exception:
        pass

    try:
        app.run(host=host, port=port, debug=False)
    finally:
        if proxy_proc and proxy_proc.poll() is None:
            proxy_proc.terminate()
            try:
                proxy_proc.wait(timeout=5)
            except Exception:
                proxy_proc.kill()
