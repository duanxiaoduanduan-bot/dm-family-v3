# DMcore · Linux 运维控制台

一个轻量、零依赖构建的 **Web 运维控制台**，聚焦于 **服务 / 进程管理**。

> 家族近期改动（作品集 / 网盘 / 分阶段安装）见仓库根目录 **[CHANGELOG.md](../CHANGELOG.md)**。  
> 一键安装请用 **`../install.sh`**（默认先装 DM 核心），说明见 **[install/README.md](../install/README.md)**。

- 纯 Flask 后端 + 原生 HTML/JS 前端，**无需任何前端构建步骤**
- 系统指标（CPU / 内存 / 磁盘 / 负载 / 运行时长）实时刷新
- 进程管理：列表、搜索、按用户过滤、排序、**一键终止**
- 服务管理：systemd 服务视图，**支持启动 / 停止 / 重启**
- 在 systemd 不可用的环境（容器等）下**自动优雅降级**，仅保留进程管理能力

## 运行

```bash
cd DMcore
chmod +x run.sh
./run.sh
```

或使用环境变量自定义端口 / 监听地址：

```bash
DMCORE_PORT=9000 DMCORE_HOST=127.0.0.1 ./run.sh
```

启动后浏览器打开 `http://127.0.0.1:8080`（或自定义端口）。

## 目录结构

```
DMcore/
├── app.py              # Flask 后端 + 系统/进程/服务接口
├── run.sh              # 启动脚本
├── requirements.txt
├── templates/
│   └── index.html      # 控制台页面
├── static/
│   ├── styles.css      # 暗色主题样式
│   └── app.js          # 前端逻辑(轮询/排序/kill/服务操作)
└── README.md
```

## 项目管理（DM 家族）

DMcore 不仅能管本机进程，还能**自动发现并统一管理整个 DM 家族的项目**（如 DMpageo、DMchat）。

- **自动发现**：扫描 `projects_root`（默认 `/workspace`）下所有带 `dm-manifest.json` 的目录，自动识别为已安装项目。
- **自动识别（零配置）**：对 `/workspace` 下没有清单、但有 `package.json`/`server.js`/`app.py` 等信号的应用，自动推断启动命令与端口，列为「待托管」，可一键接管。
- **一键安装**：根据 `registry.json` 中登记的来源安装。支持 `scaffold`（复制本地脚手架）与 `git`（克隆仓库）两种方式。
- **一键接管**：把自动识别的候选写清单、注册并启动（`/api/projects/<name>/adopt`，可覆盖命令/端口）。
- **一键管理**：基于 **DMcore 自己独立的 supervisord 实例**（`supervisor/` 目录）的启动 / 停止 / 重启 / 状态 / 日志。`run.sh` 启动时会自动拉起该实例，项目进程崩溃时由 `autorestart` 自动拉起。
- **一键卸载**：停止托管并移除 DMcore 管理配置（`/api/projects/<name>/uninstall`，默认保留目录；`remove_files:true` 连目录一起删）。
- **一键移植**：
  - `换目录` —— 把项目移动到新路径并自动重建托管、`dm-manifest.json` 路径跟随。
  - `导出包` —— 打包成 `.tar.gz` 迁移包，可下载带走、换机器部署。

控制台「项目管理」标签页实时展示各项目状态与一键操作。

> **重要架构说明（避坑）**：DMcore **不复用宿主（沙盒）的 supervisord**。
> 宿主 supervisord 由沙盒自身编排（docker / agent / api 等均由它托管），且其定制版
> 不支持 `reread` / `update`，只能通过 `reload` 全量重启 —— 一旦误用会连 docker / agent
> 一起搞垮。因此 DMcore 用 `supervisor/supervisord.conf` 启动一个**独立实例**，`reload`
> 只影响 DM 家族项目，安全且自包含。要在新机器上部署，只需把 `DMcore/` 整目录带走，
> `./run.sh` 即可重建整套托管。

### 项目清单 `dm-manifest.json`

每个被管理的项目根目录放一份清单，DMcore 据此识别与托管：

```json
{
  "name": "DMpageo",
  "display": "DMpageo 页面服务",
  "type": "web",
  "port": 8091,
  "command": "python3 app.py",
  "description": "DM 家族的页面 / 前端展示服务示例。",
  "env": {}
}
```

### 注册表 `registry.json`

登记「可安装」项目及其来源。把 `source.type` 改为 `git` 并填 `url`，即可让 DMcore 从仓库一键安装真实项目：

```json
{
  "projects_root": "/workspace",
  "known": [
    {
      "name": "DMpageo",
      "display": "DMpageo 页面服务",
      "type": "web",
      "port": 8091,
      "description": "…",
      "source": { "type": "git", "url": "https://你的仓库/DMpageo.git", "ref": "main" }
    }
  ]
}
```

> 当前 `registry.json` 中 DMpageo / DMchat 的来源为 `scaffold`（内置最小可运行示例），用于立即演示整条链路。等 devtop 上的真实项目就绪后，把 `source` 改为 `git` 地址即可无缝切换为真实代码。

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/system` | 主机名、CPU、内存、磁盘、负载、进程数 |
| GET | `/api/processes` | 进程列表（支持 `sort`/`order`/`q`/`user` 参数） |
| POST | `/api/processes/<pid>/kill` | 终止进程（body: `{"signal":"TERM"}`，可选 `KILL`/`INT`/`HUP`） |
| GET | `/api/services` | systemd 服务列表（不可用环境返回降级提示） |
| POST | `/api/services/<name>/<action>` | 服务操作，`action` ∈ `start`/`stop`/`restart` |
| GET | `/api/projects` | 已安装项目 + 可安装项目 + **自动识别的候选** + 根目录 |
| POST | `/api/projects/<name>/install` | 一键安装 |
| POST | `/api/projects/<name>/adopt` | 一键接管自动识别的候选（body 可选 `command`/`port` 覆盖推断值） |
| POST | `/api/projects/<name>/{start,stop,restart}` | 生命周期管理 |
| POST | `/api/projects/<name>/uninstall` | 卸载（停止托管并移除 DMcore 管理配置；body 可选 `remove_files:true` 连目录一起删） |
| GET | `/api/projects/<name>/logs` | 查看托管日志 |
| POST | `/api/projects/<name>/migrate` | 移植（body: `{"mode":"relocate","target":"/new/parent"}` 或 `{"mode":"export"}`） |
| GET | `/api/projects/<name>/download?f=...` | 下载导出的迁移包 |
| GET | `/api/health` | 健康检查 |

## 说明

- 终止进程使用 `os.kill`，只对**当前用户有权限**的进程生效；以 root 运行可管理全部进程。
- 本环境 PID 1 为 `supervisord`（非 systemd），因此服务管理标签页会自动显示降级提示，进程管理始终可用。
