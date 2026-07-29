# dm-family 改动说明

本文汇总近期对 **DMshow / 网盘 / 分阶段安装 / 代理** 的改动，便于部署与回顾。

---

## 1. DMshow · 作品集主页

**相关文件**

| 路径 | 说明 |
|------|------|
| `DMshow/server.js` | 扫描 `library/`，提供 `/api/portfolio`、`/api/profile` |
| `DMshow/index.html` | 作品集 UI、灯箱、自动轮播 |
| `DMshow/library/` | 素材库（丢文件即上线） |
| `DMshow/library/README.md` | 目录约定与 meta 写法 |
| `DMshow/dm-manifest.json` | 端口 **8086**，与 `routes.json` 的 `/show` 一致 |

**能力**

- 个人主页：头像 / 名字 / 短简介 / 标签 / 外链 / 统计
- 文本摘要：读 `library/about.md`，可展开
- 作品集 `works/`、图集 `albums/`、视频 `videos/`、画廊 `gallery/`
- 点击放大（灯箱）、左右键 / 滑动、**自动轮播**
- 网页「编辑资料」会写回 `profile.json` + `about.md`

**用法摘要**

```text
DMshow/library/
  profile.json   about.md   avatar.jpg
  works/项目名/   cover.jpg + README.md + 媒体
  albums/相册名/  *.jpg
  videos/         *.mp4
  gallery/        散图
```

启动：`cd DMshow && node server.js` → `http://127.0.0.1:8086`（代理：`/show`）

---

## 2. DMmedia 网盘（file-manager）

**相关文件**

| 路径 | 说明 |
|------|------|
| `DMmedia/file-manager.js` | 后端 API、流式上传、Range 下载、**存储介质** |
| `DMmedia/file-manager.html` | 前端交互、上传面板、**添加存储** |
| `DMmedia/file-shortcuts.json` | 快捷目录 + 已固定存储（`type: storage`） |
| `DMmedia/FILE-MANAGER.md` | 网盘专项说明 |
| `DMcore/proxy.js` | 大文件代理：关超时、流式 pipe |

**新增存储介质（v2.2）**

- 侧边栏「我的存储」+「添加存储」面板  
- 自动检测：`/media`、`/mnt`、`/run/media`、`/storage`、Windows 盘符  
- 一键 **固定 / 移除**；可手动填路径或「用当前目录」  
- API：`POST /api/storage/add`、`POST /api/storage/remove`、增强 `GET /api/mounts`

**修过的问题**

| 问题 | 原因 | 修复 |
|------|------|------|
| 新建文件夹 / 弹窗「没反应」 | 全局 `click` 立刻 `hideModal()` | 去掉该逻辑，仅遮罩关闭 |
| 「+ 添加目录」无效 | 缺少 `addShortcut` | 已实现 |
| 右键/路径含特殊字符失效 | 路径塞进 `onclick` 字符串 | 改为 `data-*` + 事件绑定 |
| `/files` 无尾斜杠 API 错 | 前缀判断过严 | 兼容 `/files`、`/files/`、直连 `:8087` |
| 大文件上传慢 / 易炸 | multipart 整文件进内存 | **原始二进制流**边收边写 |
| 下载弱 | 无 Range | 支持 **206** + 1MB 缓冲 |
| 长传中断 | Node 默认 requestTimeout | 服务端与代理均 **关闭超时** |

**传输相关**

- 上传：`xhr.send(file)` 原样字节，面板显示 **进度 + MB/s**
- 并发：默认 **2** 路（`UPLOAD_CONCURRENCY`）
- 下载：流式 + Range；批量下载带间隔防浏览器拦截
- 支持文件夹上传
- 面包屑兼容 Windows 盘符路径
- **乱码**：内容原样不转码；文件名 UTF-8（上传 `X-File-Name`，下载 `filename*=UTF-8''`）
- **存储介质**：U 盘/盘符/自定义目录可固定到「我的存储」（见上 v2.2）

**访问**

- 直连（更快）：`http://主机:8087`
- 代理：`http://主机:8080/files`

改完后需 **重启** `file-manager.js`（或 DMmedia 启动脚本）才生效。

**速度说明（预期）**

- 局域网大文件：可接近网卡/磁盘上限，与 FTP **同一量级**，不保证全面超过 FTP
- 瓶颈通常是网络、磁盘、是否走代理，而非故意限速

---

## 3. 分阶段安装（先装 DM）

**相关文件**

| 路径 | 说明 |
|------|------|
| `install.sh` | 总入口 |
| `install/common.sh` | 日志、标记、公共函数 |
| `install/01-dm.sh` | **DM 核心（永远最先）** |
| `install/02-postgis.sh` | PostgreSQL / PostGIS |
| `install/03-apps.sh` | 各服务 npm 依赖 |
| `install/04-start.sh` | 启动托管服务 |
| `install/README.md` | 安装专项说明 |

**默认一键顺序**

```text
dm → postgis → apps → start
```

**常用命令**

```bash
./install.sh              # 全装（先 DM）
./install.sh dm           # 只装核心控制台 + 代理
./install.sh postgis
./install.sh apps
./install.sh start
./install.sh list
./install.sh status
./install.sh help
```

完成标记：`.dm-install/*.done`  
环境：Linux / DevTop（bash）；Windows 本机一般不能直接跑。

---

## 4. 其它连带修改

| 文件 | 改动 |
|------|------|
| `DMcore/proxy.js` | 大文件友好：去 hop 头、timeout=0、流式转发 |
| `DMshow/dm-manifest.json` | 端口与描述对齐作品集 |
| `config.json` / `routes.json` | 既有端口约定未改逻辑；show→8086，files→8087 |

---

## 5. 文档索引

| 文档 | 内容 |
|------|------|
| **本文件 `CHANGELOG.md`** | 全部改动总览 |
| `install/README.md` | 分阶段安装 |
| `DMshow/library/README.md` | 作品素材库约定 |
| `DMshow/README.md` | DMshow 服务说明 |
| `DMmedia/FILE-MANAGER.md` | 网盘问题、用法、性能 |
| `DMcore/README.md` | 控制台原有说明（未重写架构） |

---

## 6. 建议验证清单

1. `./install.sh dm` → 打开 `:8088` 控制台  
2. `cd DMshow && node server.js` → 往 `library/` 丢图 → ↻ 刷新  
3. 网盘 `:8087` → 新建文件夹、上传大文件看 MB/s、下载  
4. 代理路径 `/files`、`/show` 各点一次  

*文档生成对应工作区改动；若你本地还有未合并分支，以实际 diff 为准。*

---

## 7. 部署完整度（v3 · 卸载 / GitHub 同步 / 换机修复）

**本版目标**：任意 Ubuntu 机器 `git clone` → `./install.sh` 即可跑；可一键卸载；代码可同步 GitHub。

**修复（换机必炸级）**

| 问题 | 修复 |
|------|------|
| `DMcore/supervisor/programs/*.conf` 写死 `/config/Desktop/dm-family/` | 改为**安装时按当前路径动态生成**（`install/common.sh` 的 `write_supervisor_programs()`，`01-dm.sh`/`04-start.sh` 调用）；conf 不再入库 |
| `supervisord.conf` 同样写死旧路径 | 删除旧文件，由 `ensure_supervisord_conf` 按需重建 |
| DMshow 托管配置端口错（8089）、无启动脚本 | 补 `DMshow/dmcore-start.sh`（与其他服务统一走 `common/ports.sh`）+ `package.json` |
| DMpageo manifest 端口 8089 | 修正为 **8085**（与 config.json / routes.json 一致） |
| DMmedia manifest 网盘端口写成 8082 | 修正为 **8087** |
| `config.json` 缺 DMshow 条目 | 已补（8086） |

**新增**

| 文件 | 作用 |
|------|------|
| `uninstall.sh` | 一键卸载。默认只停服务+清标记（数据全保留）；`--purge` 清构建产物；`--drop-db` 删库；`--with-postgres` 卸 PG；`--all` 全做；`-y` 免确认 |
| `.gitignore` | 排除媒体（250M+）、`DMgeo/geodata`（269M+）、素材库、node_modules、supervisor 运行时 |
| `sync-github.sh` | `init <仓库>` 首次关联推送；`"说明"` 日常提交推送；`--dry-run` 预览；>5MB 文件自动拦截 |
| `install.sh uninstall` | 主入口转发到 uninstall.sh |

**验证**：101 个代码/文档文件入库，0 数据文件；全部脚本 `bash -n` 通过；conf 生成函数实测路径正确。

**已知边界**：版本升级策略未定（断断暂不控制版本）；Ubuntu 实机全流程未跑（脚本面向 apt 系，语法已静态验证）。

---

## 8. 地图数据初始化（geodata 阶段 · 装完不黑屏）

**背景**：底图数据来自阿里 DataV.GeoAtlas 开源下载、写入 PostGIS，不进仓库；
但新机器装完缺数据直接黑屏。且旧流程有两个断点：

| 断点 | 后果 |
|------|------|
| `02-postgis.sh` 在 apps 之前跑 `import-datav.js`，此时 `pg` 包未装 | 新机导入必失败，被 warn 吞掉 → 空表 |
| `import-world.js` 从未被安装流程调用 | 世界底图缺失 |

**修复**：新增独立阶段 `install/05-geodata.sh`，一键顺序变为

```text
dm → postgis → apps → geodata → start
```

**数据源三选一**（`GEO_SOURCE`）：

| 方式 | 用法 |
|------|------|
| 在线（默认） | `./install.sh geodata` —— 阿里 DataV（行政区划）+ Natural Earth（世界国界），脚本内置重试与离线缓存 |
| 本地导入 | `./install.sh geodata --local <目录>` —— 支持完整缓存布局或散装 geojson/json/gpx；`map-boundaries/` 一并拷入 |
| 跳过 | `SKIP_GEODATA=1`（兼容旧 `SKIP_DATAV=1`） |

**其它**：02-postgis.sh 不再负责数据导入（时机错误已移除）；导入时若 PG 未运行会临时拉起、导完恢复；结束打印 Basemap 省/市/区行数与底图文件校验。日常导入自有数据还可用 DMgeo「数据库管理」页（`POST /api/pg/tables/:name/upload`，GeoJSON/CSV）。
