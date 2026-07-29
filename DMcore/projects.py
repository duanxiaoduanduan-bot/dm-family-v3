"""
DMcore · 项目管理引擎
负责 DM 家族项目(如 DMpageo / DMchat)的：
  - 自动发现(discover)：扫描 projects_root 与已记录路径下的 dm-manifest.json
  - 一键安装(install)：从 git 克隆或本地脚手架复制
  - 一键管理(manage)：基于 supervisord 的 start/stop/restart/status/logs
  - 一键移植(migrate)：本机换目录重托管 / 导出成可迁移包

依赖 supervisord 托管，因此进程在沙箱休眠/恢复后可自动拉起。
"""

import os
import re
import json
import time
import shutil
import tarfile
import subprocess
from datetime import datetime

# ---- supervisord 路径 ----
# 重要: DMcore 使用「自己独立的 supervisord 实例」来托管 DM 家族项目,
# 而不是复用宿主(sandbox)的 supervisord。宿主 supervisord 是沙盒自身编排器
# (docker/agent/api 等均由它托管), 且其定制版不支持 reread/update, 只能通过
# reload 全量重启 —— 一旦误用会连 docker/agent 一起搞垮。独立实例的 reload 只
# 影响 DM 项目, 安全且自包含。
# 从 PATH 探测 supervisord，不再硬编码 webtop 容器专用路径 /lsiopy/bin/supervisord
SUP_BIN = shutil.which("supervisord") or "/usr/bin/supervisord"
# 标准 supervisor 用独立 supervisorctl 控制；若环境是定制版(支持 `supervisord ctl`)则回退
SUP_CTL = shutil.which("supervisorctl") or "/usr/local/bin/supervisorctl"
HERE = os.path.dirname(os.path.abspath(__file__))
SUP_DIR = os.path.join(HERE, "supervisor")          # DMcore 独立实例根
SUP_CONF = os.path.join(SUP_DIR, "supervisord.conf")
SUP_PROGRAMS = os.path.join(SUP_DIR, "programs")
SUP_LOGDIR = os.path.join(SUP_DIR, "logs")
SUP_SOCK = os.path.join(SUP_DIR, "supervisor.sock")
SUP_PID = os.path.join(SUP_DIR, "supervisord.pid")
# 从 PATH 探测解释器，去掉 webtop 容器专用硬路径(/lsiopy/bin/python3、/usr/bin/node)，
# 在原生 Ubuntu 上自动落到 /usr/bin/python3、/usr/bin/node。
PY = shutil.which("python3") or "python3"
NODE = shutil.which("node") or "node"

# 本模块根(DMcore 目录)
REGISTRY_PATH = os.path.join(HERE, "registry.json")
INSTALLED_PATH = os.path.join(HERE, ".installed.json")
EXPORTS_DIR = os.path.join(HERE, "exports")
DEFAULT_ROOT = "/config/Desktop/dm-family"
LOG_TMPL = os.path.join(SUP_LOGDIR, "dm-{name}.log")

# 端口避让(避免与 DMcore 8080 / sandbox-proxy 9090 等冲突由调用方保证)

# ── 端口自动分配 ──
PORT_RANGE_START = 8081
PORT_RANGE_END   = 8099
RESERVED_PORTS   = {8080, 8088}  # proxy 入口 + DMcore 自身，永不分配
ROUTES_PATH = os.path.join(HERE, "routes.json")


def _used_ports():
    """返回所有已占用的端口：清单声明的 + ss 实际监听的 + 保留端口。"""
    used = set(RESERVED_PORTS)

    # 从已安装清单收集
    for name, path in _load_installed().items():
        m = read_manifest(path)
        if m and m.get("port"):
            try:
                used.add(int(m["port"]))
            except Exception:
                pass

    # 从 ss 实际监听收集
    try:
        out = subprocess.run(
            ["ss", "-tlnpH"], capture_output=True, text=True, timeout=5,
        )
        for line in out.stdout.splitlines():
            m = re.search(r":(\d{2,5})\s", line)
            if m:
                used.add(int(m.group(1)))
    except Exception:
        pass

    return used


def _find_free_port(start=PORT_RANGE_START, end=PORT_RANGE_END):
    """在范围内找第一个未被占用的端口。找不到返回 0。"""
    used = _used_ports()
    for p in range(start, end + 1):
        if p not in used:
            return p
    return 0


def _proxy_prefix(name):
    """从项目名推导 routes.json 中的路径前缀。
    DMxxx → /xxx (去 DM 前缀并小写)；其他 → /小写全名；
    manifest 中若有 proxy_path 字段则直接使用。
    """
    if name.upper().startswith("DM") and len(name) > 2:
        return "/" + name[2:].lower()
    return "/" + name.lower()


def sync_routes_json():
    """根据已安装项目自动生成 routes.json。手动路由从 _manual 合并，不会被自动覆盖。"""
    existing = {}
    try:
        if os.path.isfile(ROUTES_PATH):
            with open(ROUTES_PATH) as f:
                existing = json.load(f)
    except Exception:
        pass

    manual = existing.get("_manual", {})

    # 自动生成路由（仅 web 类型、端口 ≥ 1024、非 DMcore）
    auto_routes = {}
    for proj in discover():
        pname = proj["name"]
        m = proj.get("manifest") or {}
        port = m.get("port") or proj.get("port", 0)
        ptype = m.get("type", "web")
        if pname == "DMcore" or not port or ptype != "web":
            continue
        if port < 1024:          # 排除系统端口(5432 等)
            continue
        prefix = m.get("proxy_path") or _proxy_prefix(pname)
        auto_routes[prefix] = f"http://127.0.0.1:{port}"

    # 合并：自动路由打底，手动路由覆盖（保证能随时修正自动路由错误）
    merged = {}
    merged.update(auto_routes)
    merged.update(manual)

    config = {
        "port": existing.get("port", 8080),
        "default": existing.get("default", "http://127.0.0.1:8088"),
        "routes": merged,
        "_manual": manual,
    }

    try:
        with open(ROUTES_PATH, "w") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


# ------------------------- supervisord 封装 -------------------------
def _sup(args):
    """执行 supervisorctl 命令，返回 (returncode, output)。"""
    try:
        r = subprocess.run(
            [SUP_CTL, "-c", SUP_CONF] + args,
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode, (r.stdout + r.stderr).strip()
    except Exception as e:
        return 1, str(e)


def _prog(name):
    return f"dm-{name}"


def _conf_path(name):
    return os.path.join(SUP_PROGRAMS, f"{_prog(name)}.conf")


def _reload():
    # 标准 supervisor 用 reread+update 加载新配置，不会重启守护进程、不杀运行中的程序。
    # （作者定制版 supervisord 不支持 reread/update，曾用 reload 全量重启；本环境为标准版。）
    _sup(["reread"])
    rc, out = _sup(["update"])
    return rc == 0, out


# ------------------------- 注册表 / 状态 -------------------------
def load_registry():
    try:
        with open(REGISTRY_PATH) as f:
            return json.load(f)
    except Exception:
        return {"projects_root": DEFAULT_ROOT, "known": []}


def _load_installed():
    try:
        with open(INSTALLED_PATH) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_installed(data):
    with open(INSTALLED_PATH, "w") as f:
        json.dump(data, f, indent=2)


def projects_root():
    # 基于 DMcore 所在目录推导安装根(os.path.dirname(HERE) 即安装目录),
    # 不依赖 registry.json 中可能被写死的绝对路径, 换目录/换机器后仍可正确发现模块。
    return os.path.dirname(HERE)


# ------------------------- 清单读写 -------------------------
def read_manifest(projdir):
    mp = os.path.join(projdir, "dm-manifest.json")
    if not os.path.isfile(mp):
        return None
    try:
        with open(mp) as f:
            return json.load(f)
    except Exception:
        return None


def _write_manifest(projdir, manifest):
    with open(os.path.join(projdir, "dm-manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)


# ------------------------- 自动发现 -------------------------
def discover():
    """返回已安装项目列表(含 supervisord 状态)。

    注意: 这里【不】主动拉起 supervisord。只在用户真正点击 启动/停止/重启
    (start/stop/restart) 时才由 ensure_supervisor() 按需拉起, 从而保持
    “默认只运行 DMcore、服务按需启动” 的行为, 避免打开界面就自动拉起全部服务。
    """
    root = projects_root()
    installed = _load_installed()  # name -> path
    found = {}

    # 1) 扫描 projects_root 一级子目录
    if os.path.isdir(root):
        for entry in os.listdir(root):
            d = os.path.join(root, entry)
            if os.path.isdir(d):
                m = read_manifest(d)
                if m:
                    found[m.get("name", entry)] = d

    # 2) 已记录(可能已被移植到非 root 路径)的项目
    for name, path in installed.items():
        if os.path.isdir(path):
            m = read_manifest(path)
            if m:
                found[name] = path

    result = []
    for name, path in found.items():
        m = read_manifest(path)
        status = _status(name)
        result.append({
            "name": name,
            "path": path,
            "manifest": m,
            "installed": True,
            "managed": status.get("managed", False),
            "state": status.get("state", "UNKNOWN"),
            "port": m.get("port"),
            "pid": status.get("pid"),
        })
    return result


def known_projects():
    """返回注册表中可安装(尚未安装)的项目源。"""
    reg = load_registry()
    installed_names = {p["name"] for p in discover()}
    out = []
    for k in reg.get("known", []):
        out.append({
            "name": k["name"],
            "display": k.get("display", k["name"]),
            "type": k.get("type", "web"),
            "port": k.get("port"),
            "description": k.get("description", ""),
            "source": k.get("source", {}),
            "installed": k["name"] in installed_names,
        })
    return out


# ------------------------- 自动识别(零配置) -------------------------
def _guess_port(d):
    """在常见入口文件里推断监听端口(启发式)。找不到返回 0。"""
    candidates = []
    for fn in ("server.js", "app.js", "main.js", "index.js", "app.py", "main.py"):
        fp = os.path.join(d, fn)
        if not os.path.isfile(fp):
            continue
        try:
            txt = open(fp, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for pat in (
            r"process\.env\.PORT\s*\|\|\s*(\d+)",
            r"PORT\s*=\s*process\.env\.PORT\s*\|\|\s*(\d+)",
            r"\.listen\(\s*(\d+)",
            r"app\.run\([^)]*?(\d{2,5})",
        ):
            m = re.search(pat, txt)
            if m:
                candidates.append(int(m.group(1)))
                break
    # 取出现频率最高的端口，避免误抓测试端口
    if candidates:
        from collections import Counter
        return Counter(candidates).most_common(1)[0][0]
    return 0


def _detect_candidate(name, d):
    """若目录像可托管应用(无 manifest)，返回推断出的清单；否则 None。"""
    if read_manifest(d):
        return None                       # 已有清单，不算候选
    if os.path.abspath(d) == HERE:
        return None                       # 跳过 DMcore 自身
    if name.startswith("."):
        return None
    try:
        files = set(os.listdir(d))
    except Exception:
        return None
    has_server_js = ("server.js" in files) or ("app.js" in files)
    has_pkg = "package.json" in files
    has_py = ("app.py" in files) or ("main.py" in files)
    has_req = ("requirements.txt" in files) or ("pyproject.toml" in files)
    if not (has_server_js or has_pkg or has_py or has_req):
        return None

    # 推断启动命令
    if has_server_js:
        main = "server.js" if "server.js" in files else "app.js"
        cmd = f"node {main}"
    elif has_pkg:
        cmd = "npm start"
    elif has_py:
        main = "app.py" if "app.py" in files else "main.py"
        cmd = f"python3 {main}"
    else:
        return None

    port = _guess_port(d)
    return {
        "name": name,
        "display": name,
        "type": "web",
        "port": port,
        "command": cmd,
        "description": f"自动识别的 {name}（推断命令: {cmd}）",
        "env": {},
        "auto_detected": True,
    }


def detect():
    """扫描 projects_root，返回「无清单但像应用」的候选(待一键接管)。"""
    root = projects_root()
    installed = set(_load_installed().keys())
    out = []
    if os.path.isdir(root):
        for entry in sorted(os.listdir(root)):
            d = os.path.join(root, entry)
            if not os.path.isdir(d) or entry in installed:
                continue
            m = _detect_candidate(entry, d)
            if m:
                out.append({
                    "name": m["name"],
                    "path": d,
                    "manifest": m,
                    "installed": False,
                    "managed": False,
                    "state": "DETECTED",
                    "port": m["port"],
                    "pid": None,
                    "auto_detected": True,
                })
    return out


def adopt(name, command=None, port=None):
    """把自动识别的候选接管为正式托管项目：写清单 + 注册 + 启动。"""
    root = projects_root()
    d = os.path.join(root, name)
    if not os.path.isdir(d):
        return {"ok": False, "message": f"未找到目录 /workspace/{name}"}
    if read_manifest(d):
        return {"ok": False, "message": f"{name} 已有 dm-manifest.json，无需接管。"}
    m = _detect_candidate(name, d)
    if not m:
        return {"ok": False, "message": f"无法将 {name} 识别为可托管应用。"}
    if command:
        m["command"] = command
    if port is not None:
        try:
            m["port"] = int(port)
        except Exception:
            pass
    m["name"] = name
    try:
        _write_manifest(d, m)
    except Exception as e:
        return {"ok": False, "message": f"写入清单失败: {e}"}
    inst = _load_installed()
    inst[name] = d
    _save_installed(inst)
    reg = _register(name, d, m)
    sync_routes_json()
    if not reg["ok"]:
        return {"ok": False, "message": "已写入清单但托管失败: " + reg["message"]}
    return {"ok": True, "message": f"{name} 已自动接管并启动。", "path": d}


def add_by_path(path, name=None, command=None, port=None):
    """手动添加一个位于【任意路径】的项目(不限于 projects_root 扫描)。

    把目录登记进 .installed.json(绝对路径), 并写/复用 dm-manifest.json + 注册 supervisord 托管。
    - 目录已有 dm-manifest.json: 直接采用
    - 否则尝试自动识别(像 adopt 那样推断命令并写清单); 若仍失败但用户给了 command, 用 command 构造最小清单
    """
    if not path or not str(path).strip():
        return {"ok": False, "message": "缺少 path 参数。"}
    path = os.path.abspath(os.path.expanduser(str(path).strip()))
    if not os.path.isdir(path):
        return {"ok": False, "message": f"目录不存在: {path}"}

    # 1) 清单
    m = read_manifest(path)
    if not m:
        bn = os.path.basename(path.rstrip("/")) or (name or "app")
        inferred = _detect_candidate(bn, path)
        if inferred:
            if command:
                inferred["command"] = command
            if port is not None:
                try:
                    inferred["port"] = int(port)
                except Exception:
                    pass
            inferred["name"] = name or bn
            try:
                _write_manifest(path, inferred)
                m = inferred
            except Exception as e:
                return {"ok": False, "message": f"写入清单失败: {e}"}
        elif command:
            try:
                port_i = int(port) if (port is not None and str(port).isdigit()) else 0
            except Exception:
                port_i = 0
            m = {
                "name": name or bn,
                "display": name or bn,
                "type": "web",
                "port": port_i,
                "command": command,
                "description": f"手动添加: {path}",
                "env": {},
            }
            try:
                _write_manifest(path, m)
            except Exception as e:
                return {"ok": False, "message": f"写入清单失败: {e}"}
        else:
            return {"ok": False, "message": "该目录既无 dm-manifest.json, 也无法自动识别；请手动指定启动命令。"}

    # 2) 名称
    proj_name = (name or m.get("name") or os.path.basename(path.rstrip("/"))).strip()
    if not proj_name:
        return {"ok": False, "message": "无法确定项目名称。"}
    m["name"] = proj_name

    # 3) 冲突检查(同名不同路径则拒绝)
    inst = _load_installed()
    if proj_name in inst:
        if os.path.abspath(inst[proj_name]) == path:
            return {"ok": True, "message": f"{proj_name} 已添加(位置: {path})。", "path": path}
        return {"ok": False, "message": f"名称 {proj_name} 已被占用(指向 {inst[proj_name]})，请先卸载或换名。"}

    # 4) 登记 + 注册(写 supervisord 配置并启动一次)
    inst[proj_name] = path
    _save_installed(inst)
    reg = _register(proj_name, path, m)
    sync_routes_json()
    if not reg["ok"]:
        inst.pop(proj_name, None)
        _save_installed(inst)
        return {"ok": False, "message": "已登记但托管失败: " + reg["message"]}
    return {"ok": True, "message": f"{proj_name} 已添加并托管(位置: {path})。", "path": path}


def uninstall(name, remove_files=False):
    """卸载: 停止托管并移除 DMcore 的管理配置(默认保留项目目录)。

    - 停止并删除该项目的 supervisord 程序配置
    - 从 .installed.json 除名
    - 删除项目内的 dm-manifest.json(使其退出 DMcore 管理视图)
    - remove_files=True 时连项目目录一起删除
    """
    # 1) 停止并注销 supervisord 托管
    _sup(["stop", _prog(name)])
    conf = _conf_path(name)
    if os.path.isfile(conf):
        try:
            os.remove(conf)
        except Exception:
            pass
    # 2) 取得实际安装路径(手动添加的项目可能在 projects_root 之外)
    inst = _load_installed()
    real_path = inst.get(name) or os.path.join(projects_root(), name)
    inst.pop(name, None)
    _save_installed(inst)
    # 3) 删除项目内清单(退出 DMcore 管理视图; 若仍是可运行应用会回到「待托管」)
    mp = os.path.join(real_path, "dm-manifest.json")
    if os.path.isfile(mp):
        try:
            os.remove(mp)
        except Exception:
            pass
    # 4) reload 让 DMcore 独立 supervisord 重新加载(去掉该程序)
    _reload()
    # 5) 同步路由表
    sync_routes_json()
    # 6) 可选: 删除整个项目目录
    if remove_files:
        if os.path.isdir(real_path):
            try:
                shutil.rmtree(real_path)
                return {"ok": True, "message": f"{name} 已卸载并删除目录。"}
            except Exception as e:
                return {"ok": True, "message": f"{name} 已卸载(配置已移除), 但删除目录失败: {e}"}
        return {"ok": True, "message": f"{name} 已卸载(配置已移除), 目录不存在: {real_path}"}
    return {"ok": True, "message": f"{name} 已卸载(停止托管, 项目目录保留)。"}


# ------------------------- 安装 -------------------------
def install(name):
    reg = load_registry()
    entry = next((k for k in reg.get("known", []) if k["name"] == name), None)
    if not entry:
        return {"ok": False, "message": f"注册表中没有 {name} 的安装源。"}
    if any(p["name"] == name for p in discover()):
        return {"ok": False, "message": f"{name} 已安装，无需重复安装。"}

    root = projects_root()
    projdir = os.path.join(root, name)
    src = entry.get("source", {})
    stype = src.get("type", "scaffold")

    try:
        if stype == "git":
            url = src.get("url")
            ref = src.get("ref", "main")
            if not url:
                return {"ok": False, "message": "git 源缺少 url。"}
            refarg = ["--branch", ref] if ref else []
            r = subprocess.run(
                ["git", "clone", *refarg, url, projdir],
                capture_output=True, text=True, timeout=120,
            )
            if r.returncode != 0:
                return {"ok": False, "message": "克隆失败: " + (r.stderr.strip() or r.stdout.strip())}
        elif stype == "scaffold":
            origin = os.path.join(HERE, src.get("origin", f"scaffolds/{name}"))
            if not os.path.isdir(origin):
                return {"ok": False, "message": f"脚手架源不存在: {origin}"}
            shutil.copytree(origin, projdir)
        else:
            return {"ok": False, "message": f"不支持的来源类型: {stype}"}
    except Exception as e:
        return {"ok": False, "message": f"安装异常: {e}"}

    # 确保清单存在并补全
    m = read_manifest(projdir) or {}
    m.setdefault("name", name)
    m.setdefault("port", entry.get("port", 0))
    m.setdefault("command", "python3 app.py")
    m.setdefault("type", entry.get("type", "web"))
    m.setdefault("display", entry.get("display", name))
    m["installed_from"] = stype
    _write_manifest(projdir, m)

    # 记录安装位置 + 注册托管
    inst = _load_installed()
    inst[name] = projdir
    _save_installed(inst)

    reg_res = _register(name, projdir, m)
    sync_routes_json()
    if not reg_res["ok"]:
        return {"ok": False, "message": "安装完成但托管注册失败: " + reg_res["message"]}

    return {"ok": True, "message": f"{name} 已安装并启动托管于 {projdir}", "path": projdir}


# ------------------------- supervisord 注册 / 管理 -------------------------
def _resolve_command(cmd):
    """把命令中的解释器替换为绝对路径，避免 PATH 问题。"""
    if not cmd:
        return cmd
    repl = [
        ("python3.11", PY),
        ("python3", PY),
        ("node", NODE),
        ("npm", os.path.dirname(NODE) + "/npm"),
    ]
    stripped = cmd.strip()
    for token, abs_path in repl:
        if stripped == token or stripped.startswith(token + " "):
            return abs_path + stripped[len(token):]
    return cmd


def _supervisor_truly_up():
    """真正判断 DMcore 独立 supervisord 是否存活(依据 pidfile 指向的进程)。

    注意: 本环境定制版 supervisord 的 `supervisorctl status` 在守护进程已死、
    仅残留 sock 文件时仍返回 rc=0(空输出), 因此不能仅用 status 的 rc 判断。
    这里直接读 pidfile 并探测该 PID 是否真实存活, 避免被残留 sock/pid 误导。
    """
    try:
        with open(SUP_PID) as f:
            pid = int(f.read().strip())
    except Exception:
        return False
    try:
        os.kill(pid, 0)  # 进程存活则无异常
        return True
    except OSError:
        return False


def _write_supervisord_conf():
    """根据运行时 SUP_DIR 动态生成 supervisord.conf，避免硬编码路径导致换目录/换机器后无法启动。"""
    os.makedirs(SUP_DIR, exist_ok=True)
    content = f"""[unix_http_server]
file={SUP_DIR}/supervisor.sock

[supervisord]
logfile={SUP_DIR}/supervisord.log
pidfile={SUP_DIR}/supervisord.pid
nodaemon=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://{SUP_DIR}/supervisor.sock

[include]
files = {SUP_DIR}/programs/*.conf
"""
    try:
        with open(SUP_CONF, "w") as f:
            f.write(content)
    except Exception:
        pass


def ensure_supervisor():
    """确保 DMcore 独立 supervisord 实例已运行(未运行则拉起)。返回是否就绪。"""
    try:
        _write_supervisord_conf()
        os.makedirs(SUP_PROGRAMS, exist_ok=True)
        os.makedirs(SUP_LOGDIR, exist_ok=True)
    except Exception:
        pass
    if _supervisor_truly_up():
        return True
    # 未就绪 → 先清理可能指向已死进程的残留 sock/pid, 再启动独立实例
    # (脱离会话, 避免随父进程退出; 由持久运行的 DMcore 进程托管, 不会被回收)
    for f in (SUP_SOCK, SUP_PID):
        try:
            os.remove(f)
        except OSError:
            pass
    try:
        subprocess.Popen(
            [SUP_BIN, "-c", SUP_CONF],
            stdout=open(os.path.join(SUP_LOGDIR, "supervisord.out"), "a"),
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except Exception:
        return False
    for _ in range(40):  # 最多等 20s 让实例就绪
        if _supervisor_truly_up():
            return True
        time.sleep(0.5)
    return False


def _register(name, projdir, manifest):
    ensure_supervisor()
    port = manifest.get("port", 0)

    # ── 端口自动分配 ──
    if not port or port in _used_ports():
        new_port = _find_free_port()
        if new_port:
            old = f"（原 {port} 被占用" if port else "（未指定端口"
            port = new_port
            manifest["port"] = port
            try:
                _write_manifest(projdir, manifest)
            except Exception:
                pass
        elif not port:
            return {"ok": False, "message": "无法自动分配端口（8081-8099 已满），请手动指定。"}

    cmd = _resolve_command(manifest.get("command", "python3 app.py"))
    env_extra = manifest.get("env", {})
    # 注入 PATH, 保证 node / python 等解释器可被找到
    env_path = ":".join([
        os.path.dirname(NODE),
        os.path.dirname(PY),
        "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
    ])
    env_pairs = [f'PATH="{env_path}"', f'NODE_BIN="{NODE}"', f'DM_PORT="{port}"', 'DMCORE_HOST="0.0.0.0"']
    for k, v in env_extra.items():
        env_pairs.append(f'{k}="{v}"')
    conf = f"""[program:{_prog(name)}]
command={cmd}
directory={projdir}
autostart=false
autorestart=true
startsecs=2
startretries=3
stopsignal=INT
stopwaitsecs=10
stopasgroup=true
killasgroup=true
stdout_logfile={LOG_TMPL.format(name=name)}
stderr_logfile={LOG_TMPL.format(name=name)}
redirect_stderr=true
environment={",".join(env_pairs)}
"""
    try:
        os.makedirs(SUP_PROGRAMS, exist_ok=True)
        with open(_conf_path(name), "w") as f:
            f.write(conf)
        _reload()
        rc, _ = _sup(["start", _prog(name)])
        # 等待进入 RUNNING
        for _ in range(10):
            s = _status(name)
            if s.get("state") == "RUNNING":
                break
            time.sleep(1)
        return {"ok": True, "message": "已注册并启动。"}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def _status(name):
    rc, out = _sup(["status", _prog(name)])
    # 该定制版 supervisord 的 status 输出带 ANSI 颜色码, 且状态词为首字母大写
    # (如 "Running"/"Stopped"), 标准 supervisor 则为全大写. 这里统一去掉 ANSI 并
    # 规范为大写, 以保证前端与其他 == "RUNNING" 判断一致.
    out = re.sub(r"\x1b\[[0-9;]*m", "", out or "")
    if rc != 0 or "No such process" in out:
        return {"managed": False, "state": "STOPPED", "pid": None}
    # 输出形如: dm-DMpageo   RUNNING   pid 1234, uptime 0:00:05
    parts = out.split()
    state = (parts[1] if len(parts) > 1 else "UNKNOWN").upper()
    pid = None
    if "pid" in out:
        try:
            pid = int(out.split("pid")[1].split(",")[0].strip())
        except Exception:
            pid = None
    return {"managed": True, "state": state, "pid": pid}


def start(name):
    ensure_supervisor()
    s = _status(name)
    if not s["managed"]:
        # 可能清单在但托管配置丢失，尝试重新注册
        d = next((p for p in discover() if p["name"] == name), None)
        if d and d.get("manifest"):
            _register(name, d["path"], d["manifest"])
    rc, out = _sup(["start", _prog(name)])
    if rc != 0 and "already started" not in out:
        # 重试一次 reload 后 start
        _reload()
        rc, out = _sup(["start", _prog(name)])
    return {"ok": rc == 0 or "already started" in out, "message": out}


def stop(name):
    ensure_supervisor()
    rc, out = _sup(["stop", _prog(name)])
    return {"ok": rc == 0 or "not running" in out, "message": out}


def restart(name):
    ensure_supervisor()
    d = next((p for p in discover() if p["name"] == name), None)
    if d and d.get("manifest"):
        _register(name, d["path"], d["manifest"])  # 重读清单并 reload
    rc, out = _sup(["restart", _prog(name)])
    return {"ok": rc == 0, "message": out}


def logs(name, lines=200):
    path = LOG_TMPL.format(name=name)
    if not os.path.isfile(path):
        return {"ok": True, "log": "(暂无日志)"}
    try:
        with open(path) as f:
            content = f.read().splitlines()[-lines:]
        return {"ok": True, "log": "\n".join(content)}
    except Exception as e:
        return {"ok": False, "log": str(e)}


# ------------------------- 移植 -------------------------
def migrate(name, target, mode="relocate"):
    d = next((p for p in discover() if p["name"] == name), None)
    if not d:
        return {"ok": False, "message": f"未找到已安装项目 {name}。"}
    projdir = d["path"]

    if mode == "relocate":
        # target 可以是父目录或完整新路径
        if target.endswith(name):
            newdir = target
        else:
            newdir = os.path.join(target, name)
        if os.path.abspath(newdir) == os.path.abspath(projdir):
            return {"ok": False, "message": "目标路径与当前路径相同。"}
        if os.path.exists(newdir):
            return {"ok": False, "message": f"目标已存在: {newdir}"}
        try:
            # 先停掉旧托管
            stop(name)
            os.makedirs(os.path.dirname(newdir) or ".", exist_ok=True)
            shutil.move(projdir, newdir)
        except Exception as e:
            return {"ok": False, "message": f"移动失败: {e}"}
        # 更新安装记录 + 重新注册托管
        inst = _load_installed()
        inst[name] = newdir
        _save_installed(inst)
        reg = _register(name, newdir, d["manifest"])
        if not reg["ok"]:
            return {"ok": False, "message": "已移动但重新托管失败: " + reg["message"]}
        return {"ok": True, "message": f"{name} 已移植到 {newdir} 并重新托管。", "path": newdir}

    elif mode == "export":
        os.makedirs(EXPORTS_DIR, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        arcname = f"{name}-{ts}.tar.gz"
        out_path = os.path.join(EXPORTS_DIR, arcname)
        try:
            with tarfile.open(out_path, "w:gz") as tar:
                tar.add(projdir, arcname=name)
            size = os.path.getsize(out_path)
            return {
                "ok": True,
                "message": f"已导出 {name} 迁移包 ({size} 字节)。",
                "package": arcname,
                "download": f"/api/projects/{name}/download?f={arcname}",
            }
        except Exception as e:
            return {"ok": False, "message": f"导出失败: {e}"}

    return {"ok": False, "message": f"未知移植模式: {mode}"}


def list_exports(name):
    if not os.path.isdir(EXPORTS_DIR):
        return []
    return sorted(
        f for f in os.listdir(EXPORTS_DIR)
        if f.startswith(name + "-") and f.endswith(".tar.gz")
    )
