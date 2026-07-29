# dm-family 分阶段安装

一键安装时**永远先装 DM 核心**，再装数据库、业务依赖、**地图数据**，最后启动。

完整改动总览见仓库根目录 **[CHANGELOG.md](../CHANGELOG.md)**。

## 快速用

```bash
# 全装（dm → postgis → apps → geodata → start）
./install.sh

# 只装 DM 控制台 + 统一代理（推荐先跑这一步）
./install.sh dm

# 再分步
./install.sh postgis
./install.sh apps
./install.sh apps DMmedia DMChat   # 只装指定依赖
./install.sh geodata               # 地图底图数据（在线下载，装完不黑屏）
./install.sh geodata --local /mnt/usb/geodata   # 从本地目录导入（U盘/旧机缓存）
./install.sh start
./install.sh start DMmedia         # 只启某个
```

## 阶段说明

| 命令 | 脚本 | 内容 |
|------|------|------|
| `dm` | `01-dm.sh` | Python/Flask、Node、supervisor、config、**启动 DMcore + proxy** |
| `postgis` | `02-postgis.sh` | PostgreSQL、PostGIS、trip/Basemap |
| `apps` | `03-apps.sh` | 各服务 `npm install` |
| `geodata` | `05-geodata.sh` | **底图数据**：行政区划(阿里 DataV)+世界国界(Natural Earth) → Basemap 库 + `map-boundaries/` |
| `start` | `04-start.sh` | 确保 DM 在跑 + `supervisorctl start` |

> **为什么 geodata 独立成阶段**：import 脚本依赖 DMgeo 的 `pg` 包，必须排在 apps 之后。
> 跳过它也能跑，但大屏/地图没有底图（黑屏）；随时 `./install.sh geodata` 补。

## geodata 数据源（三选一）

| 方式 | 命令 | 说明 |
|------|------|------|
| 在线（默认） | `./install.sh geodata` | 阿里 DataV.GeoAtlas + Natural Earth，自动重试+本地缓存 |
| 本地导入 | `./install.sh geodata --local <目录>` | 支持完整缓存布局（`china/provinces...`）或散装 geojson/json/gpx |
| 跳过 | `SKIP_GEODATA=1 ./install.sh` | 不装底图（会黑屏，可后补） |

此外 DMgeo 自带「数据库管理」页支持上传 GeoJSON/CSV 到任意表（`POST /api/pg/tables/:name/upload`），
日常导入自己的数据用它即可。

```bash
./install.sh list      # 看阶段
./install.sh status    # 看进度与端口
./install.sh help
```

## 设计原则

1. **先 DM**：装完即可打开 `http://127.0.0.1:8088` 控制台、`:8080` 统一入口。
2. **可拆可合**：阶段可单独重跑，尽量幂等。
3. **标记目录**：`.dm-install/*.done` 记录完成状态。
4. **环境**：面向 Linux / DevTop（bash）；需 root 或 sudo 才能 apt 装依赖。

## 环境变量

| 变量 | 含义 |
|------|------|
| `DMCORE_PORT` | 控制台端口，默认 8088 |
| `DMCORE_HOST` | 监听地址，默认 0.0.0.0 |
| `GEO_SOURCE` | 地图数据源：online(默认) / local / skip |
| `GEO_LOCAL_DIR` | local 模式的数据目录 |
| `SKIP_GEODATA=1` | 跳过地图数据（兼容旧变量 `SKIP_DATAV=1`） |
| `PGUSER` / `PGPASS` | 库账号，默认 dmuser / dmpageo123 |

## 卸载

```bash
./uninstall.sh                # 安全模式：停服务 + 解除托管 + 清标记（数据全保留）
./uninstall.sh --purge        # 额外清 node_modules / 运行时产物 → 回到刚 clone 状态
./uninstall.sh --drop-db      # 额外删除 trip / Basemap 数据库
./uninstall.sh --all -y       # 最彻底：以上全部 + apt 卸载 PostgreSQL
```

也可从主入口走：`./install.sh uninstall`（参数同上传给 uninstall.sh）。

## 同步到 GitHub

```bash
./sync-github.sh init git@github.com:<你>/dm-family.git   # 首次：init + 关联 + 推送
./sync-github.sh "改动说明"                               # 日常：add + commit + push
./sync-github.sh --dry-run                                # 只预览将提交的内容
```

`.gitignore` 已排除：媒体文件、`DMgeo/geodata`（269M+，由 `import-datav.js` 重建）、
`DMshow/library` 素材、node_modules、supervisor 运行时（含按本机路径生成的 conf）。

> supervisor 的 `programs/*.conf` 与 `supervisord.conf` **不进仓库**——
> 每台机器安装时由 `install/common.sh` 按实际路径自动生成，换机/换目录不失效。

## 与旧版 install.sh 关系

旧版「一条脚本装完所有」已改写为：**入口 + `install/*.sh` 分阶段**。  
直接 `./install.sh` 仍等于全装，但内部顺序固定为先 DM。
