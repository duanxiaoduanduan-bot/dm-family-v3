# dm-family

本地多服务家族：**DMcore 控制台** 统一发现、托管、代理各子服务（媒体、地图、聊天、作品集、网盘等）。

## 文档入口

| 文档 | 内容 |
|------|------|
| **[CHANGELOG.md](CHANGELOG.md)** | **近期全部改动总览**（DMshow / 网盘 / 安装 / 代理） |
| [install/README.md](install/README.md) | 分阶段安装（**先装 DM**） |
| [DMcore/README.md](DMcore/README.md) | 运维控制台 |
| [DMshow/README.md](DMshow/README.md) | 作品集主页 |
| [DMshow/library/README.md](DMshow/library/README.md) | 素材库目录约定 |
| [DMmedia/FILE-MANAGER.md](DMmedia/FILE-MANAGER.md) | 网盘：传输、乱码、**新增存储介质**、API |

## 快速安装（Ubuntu / Linux）

**方式一：从 GitHub 克隆（推荐）**

```bash
git clone <仓库地址> dm-family
cd dm-family
chmod +x install.sh uninstall.sh sync-github.sh install/*.sh
./install.sh          # 一键全装：dm → postgis → apps → geodata → start
```

**方式二：本地目录直接装**

```bash
chmod +x install.sh install/*.sh
./install.sh dm      # 只装核心（推荐先跑）
./install.sh         # 全装（含地图底图数据，装完大屏不黑屏）
./install.sh status
```

> 地图底图默认从**阿里 DataV.GeoAtlas + Natural Earth** 在线下载（脚本自动重试+缓存）。
> 离线/内网环境：`./install.sh geodata --local <目录>` 从 U 盘或旧机缓存导入；
> 暂不装：`SKIP_GEODATA=1 ./install.sh`，之后 `./install.sh geodata` 再补。

**卸载 / 同步**

```bash
./install.sh uninstall        # 停服务+清标记（数据全保留）
./uninstall.sh --purge        # 连构建产物一起清，回到刚 clone 状态
./uninstall.sh --all          # 彻底卸载（含数据库，需确认）

./sync-github.sh init <仓库地址>   # 首次关联 GitHub 并推送
./sync-github.sh "更新说明"        # 日常提交+推送（数据目录已 gitignore）
```

> 数据说明：媒体文件、`DMgeo/geodata` 地图数据、`DMshow/library` 素材**不进 Git 仓库**。
> clone 后 `./install.sh` 的 **geodata 阶段**会自动下载/导入底图数据，其余数据随使用自然积累。

## 主要端口（默认）

| 服务 | 端口 | 代理路径 |
|------|------|----------|
| 统一入口 proxy | 8080 | — |
| DMmedia 媒体 | 8081 | `/media` |
| DMChat | 8083 | `/chat` |
| DMgeo | 8084 | `/geo` |
| DMpageo | 8085 | `/pageo` |
| DMshow | 8086 | `/show` |
| 网盘 files | 8087 | `/files` |
| DMcore 控制台 | 8088 | — |

集中改端口：根目录 `config.json`；代理路由：`DMcore/routes.json`。

## 子服务一览

- **DMcore** — 进程/项目管理 + 统一反向代理  
- **DMmedia** — 媒体播放 + **网盘**（`:8087`）  
- **DMgeo** — 地图 / PostGIS  
- **DMpageo** — 合并门户  
- **DMChat** — WebSocket 聊天  
- **DMshow** — **作品集**（`library/` 自动排版）  
- **dm-postgis** — 原生 PostgreSQL/PostGIS  

更细的改动说明请看 **[CHANGELOG.md](CHANGELOG.md)**。
