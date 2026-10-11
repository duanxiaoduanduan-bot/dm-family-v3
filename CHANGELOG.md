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

---

## 9. Ubuntu 实机首测修复（v3.1）

首次真机安装暴露的问题，已全部修复。**原则性改动：所有阶段不再"假完成"——校验不过就报错退出，状态页不再说谎。**

| 症状 | 根因 | 修复 |
|------|------|------|
| DMcore :8088 无响应 | Ubuntu 23.04+ PEP 668 禁止 pip 直装系统 Python，Flask 安装静默失败 | `01-dm.sh` 优先 `apt install python3-flask`，pip 兜底加 `--break-system-packages`；健康检查失败则阶段报错并打印 dmcore.log 尾部 |
| DMcore 被跳过不启动 | `pgrep -f "python3 app.py"` 误匹配机器上其他同名项目 | `common.sh` 改为只判断端口监听 |
| postgis 阶段失败 | apt 装完 PG 集群常已自动运行，`pg_ctlcluster start` 报 "already running" 触发 `set -e` 退出；非 root 无 sudo fallback | `02-postgis.sh` start 幂等化 + sudo 自适应 + `pg_isready` 验证；结尾校验 Basemap+postgis 扩展真实可用才标记完成 |
| dm-dm-postgis 疑似崩溃循环 | supervisord 以普通用户跑时 `su postgres` 需密码交互直接失败 | `dm-postgis/dmcore-start.sh` 自动 `sudo -n`，不可用则打印明确提示退出 |
| geodata 显示"已完成"但库里没数据 | import 失败被 warn 吞掉仍 mark_done | `05-geodata.sh` 校验省数据行数>0 且底图文件存在，否则 error；--skip 不再写标记 |
| start 阶段 RUNNING 假象 | start all 后 2 秒看状态，崩溃循环看不出 | `04-start.sh` 5 秒后二次检查 FATAL/BACKOFF/EXITED 并列出日志路径 |

**重跑指引**（已 clone 的机器）：`git pull` 后按缺口重跑阶段即可（全部幂等）：
`./install.sh postgis` → `./install.sh geodata` → `./install.sh dm` → `./install.sh start`。

---

## 10. DMChat 聊天记录持久化（独立文件夹）

此前聊天仅存于 WebSocket 内存，全员离线即丢失。现新增独立 `DMChat/chatlogs/` 文件夹落盘，并可在界面内查看 / 导出。

| 路径 | 说明 |
|------|------|
| `DMChat/server.js` | 新增 `CHATLOG_DIR=chatlogs/`，每条聊天 `appendChatLog` 落盘为 `chatlogs/YYYY-MM/YYYY-MM-DD.jsonl`（按月分文件夹，一行一条，含 from/fromName/text/time/file） |
| `DMChat/server.js` | 新增接口 `/api/chat-dates`（可用日期列表）、`/api/chat-history?date=YYYY-MM-DD`（某日明细，token 校验 + 日期正则防穿越） |
| `DMChat/index.html` | 顶栏新增「📜 记录」按钮；加入时自动加载当日历史到主聊天区；记录面板支持按日期浏览、导出 TXT |
| `DMChat/.gitignore` | `DMChat/chatlogs/` 加入忽略（用户数据，不入库） |

**能力**

- 每条消息按服务器本地日期写入 `chatlogs/YYYY-MM/YYYY-MM-DD.jsonl`（**按月分文件夹**，清理时删整月目录即可、不误删别的天），服务重启 / 全员离线后仍在。
- 新成员加入自动回填当日历史，不丢上下文。
- 记录面板可翻看任意历史日期，一键导出纯文本备份。
- 历史接口需登录 token，且 `date` 仅接受 `YYYY-MM-DD`，杜绝路径穿越。

**部署**：改完 `git push` → Ubuntu 机 `git pull` → 重启 DMChat 即生效（`chatlogs/` 首次运行自动创建）。

---

## 11. DMChat 语音消息 + 图片内联

| 路径 | 说明 |
|------|------|
| `DMChat/index.html` | 消息渲染抽成 `renderBubble()`：图片 `.png/.jpg/.gif/.webp/...` 直接内联显示（点击放大）；音频 `.webm/.ogg/.m4a/.mp3/...` 渲染 `<audio controls>` 播放条。聊天流与「📜 记录」历史面板共用同一渲染 |
| `DMChat/index.html` | 输入区新增「🎤 按住说话」按钮：`pointerdown` 起 MediaRecorder 录音、`pointerup` 停止并上传发送（`/api/upload-file` 复用），消息带 `file.dur` 时长；非 HTTPS 安全上下文时提示走 `https://IP:8443` |
| `DMChat/server.js` | MIME 表补 `audio/ogg`(`.ogg/.oga/.opus`)、`audio/mp4`(`.m4a`)、`audio/aac`、`audio/mpeg`(`.mp3`)、`audio/wav` |

**能力**

- 图片消息直接显示在气泡里，不再只是文字链接；点击放大查看。
- 语音消息按住即录、松开发送，全房可见可回放；语音/图片都随聊天记录一起落盘（`chatlogs/` 记录 file url）。
- 语音依赖浏览器 `getUserMedia`，需 HTTPS（自签 `https://192.168.1.9:8443`）或 localhost，HTTP 下会明确提示。

**部署**：`git push` → Ubuntu `git checkout origin/main -- DMChat/` → `sudo supervisorctl -c DMcore/supervisor/supervisord.conf restart dm-DMChat`。

---

## 12. DMChat HTTPS 证书方案（语音/通话/投屏）

语音消息 / 视频通话 / 屏幕共享需要浏览器「安全上下文」（HTTPS 或 localhost），HTTP 下被浏览器禁用。

| 路径 | 说明 |
|------|------|
| `DMChat/install.sh` | 证书生成改为 **mkcert 优先**（本地 CA，设备导入 CA 后绿锁）+ openssl 自签兜底；同时生成可分发的 `certs/rootCA.crt` |
| `DMChat/server.js` | 新增 `/rootCA.crt` 下载路由（供各设备导入）；禁止静态托管暴露 `certs/` 目录与 `.key` 私钥 |
| `DMChat/HTTPS.md` | 新增：为什么需要 HTTPS、证书方案对比、各设备（Windows/Android/iOS）导入 CA 步骤、常见问题 |

**使用**：各设备浏览器打开 `http://<IP>:8083/rootCA.crt` 下载并导入一次，之后 `https://<IP>:8443` 免警告、语音/通话/投屏可用。

**注意**：证书解决「红字警告」；若 `https://IP:8443` 根本连不上（「无法连接」），是本机代理软件拦截内网 HTTPS，需关代理或加直连规则，两码事。

---

## 13. DMgeo · 整库导出 / 导入（zsql 归档）

db-manager.html 顶栏新增「📦 整库导出」「📥 整库导入」，用于**整个数据库**的备份与迁移（原来是单表级 GeoJSON/CSV）。

| 路径 | 说明 |
|------|------|
| `DMgeo/server.js` | `GET /api/pg/databases/:name/export`（导出）+ `POST /api/pg/databases/:name/import`（导入，含 dryRun 冲突探测） |
| `DMgeo/db-manager.html` | 导出勾选面板、导入确认与**逐表冲突决策**弹窗 |

**格式**：单文件 `.zsql`（未压缩 JSON）

```json
{ "format":"dmgeo-zsql", "version":1, "exportedAt":"...", "database":"trip",
  "tables": { "features": { "columns":[...], "geomColumns":["geom"], "rows":[...] } } }
```

**为什么不用 pg_dump/pg_restore**：纯 Node 实现，不依赖外部二进制，跨机器、跨 PG 版本都能用；导出的文本文件出问题能手查。

**实现要点**

- 列定义从 `pg_catalog` 取（`format_type` + `geometry_columns`），**几何子类型/SRID/默认值/NOT NULL 全部原样还原**；`information_schema` 看不到几何子类型，故不用它。
- 几何列导出 `ST_AsGeoJSON`、导入 `ST_SetSRID(ST_GeomFromGeoJSON(...))`，**参数化绑定**，不拼字符串。
- 序列归位：导入后对 `nextval` 默认值列 `setval`，否则下一条插入撞主键。
- 导入**单事务**：任一表失败整体回滚，不留半截库。
- 冲突（目标库已有同名表）→ 前端逐表选 **覆盖 / 改名备份(`xxx_bak_时间戳`) / 跳过**。
- 目标库不存在则自动建 + 补 PostGIS + 授权（复用 `ensureFeatureStore`）。
- 默认导出勾掉 `stats_features`（它是按库同步的镜像表，不该跟着走）。

**部署**：`git push` → Ubuntu `git checkout origin/main -- DMgeo/` → `sudo supervisorctl -c DMcore/supervisor/supervisord.conf restart dm-DMgeo`。

**实测记录（2026-10-11 · Ubuntu 192.168.1.9 · PostgreSQL 18.6 + PostGIS）**

真实库往返回归通过：源库 5 行（含中文、NULL 几何、`&`/引号特殊字符、JSONB、`numeric(8,2)`、`varchar(32)`、`SERIAL` 主键、GIST 索引）**导出→导入新库后内容指纹完全一致**（`md5(string_agg(...))`：源=目标）；列定义/几何子类型 `Point`/SRID 4326/空间索引/主键均正确还原；`setval` 归位后 `nextval` 返回 6。冲突处理（改名备份 `places_bak_<时间戳>`）、dryRun 冲突探测均验证通过。

**测试中抓到并修掉的 3 个真 bug**

1. 导入到**不存在的库**时报 `database "xxx" does not exist` —— `ensureFeatureStore` 只补 postgis/表，**不负责 CREATE DATABASE**。补：导入前先查 `pg_database`，缺则 `CREATE DATABASE ... OWNER dmuser` 并回报 `autoCreated`。
2. `SERIAL` 列把原 DEFAULT `nextval('places_id_seq')` 原样带过来 → 新库无该序列，建表失败 `relation "places_id_seq" does not exist`。改：识别 `nextval(...)` 默认值后改写成显式 `SERIAL/BIGSERIAL/SMALLSERIAL`（按内部类型 int4/int8/int2 判），导入后由 `setval` 归位。
3. 主键未导出 → 数据完整性退化。补：`dumpDatabase` 读 `pg_index.indisprimary` 导出 `primaryKey`，导入后 `ALTER TABLE ... ADD PRIMARY KEY(...)`。

另：dryRun 阶段挪到建库之前（避免对不存在的库开连接）；归档含几何列而目标库无 PostGIS 时，给出**可操作的中文错误**（附 `sudo -u postgres psql -d <库> -c "CREATE EXTENSION postgis;"`），不再抛误导性的 `type "geometry" does not exist`。

> 注意：服务以 `dmuser` 运行，**无权限给新库装 PostGIS**（`dmuser` 非 superuser）。整库导入到全新库时需先由超级用户装好扩展，或由安装脚本预置。此为既有权限模型，本次未改动。

---

## 14. DMgeo map-player · 修复「用过线/面之后📍 点失效」

**现象**：打开 `map-player.html`，先点「✏️ 线」画过一条线（或「⬠ 面」画过面）之后，再点「📍 点」并点击地图，**创建面板不再弹出**，点也建不出来。

**根因**：Leaflet 的 `map.off('click')` **不带 handler 参数时会移除该事件上的全部监听器**。而地图点击分发器（负责照片/视频/标点三种模式）是匿名函数一次性注册的：

```js
map.on('click', function(e){ ... })        // 总处理器（匿名，无法精确移除）
...
map.off('click'); map.on('click', onDrawClick);   // ✏️ 线：无参 off → 顺手把总处理器删了
```

于是**只要用过一次线/面，总处理器就永久失效**，之后「📍 点」自然没反应。且 `finishDraw()` / `finishPolygonDraw()` 只摘掉自己的 handler，**从未把总处理器挂回去**。

| 路径 | 说明 |
|------|------|
| `DMgeo/map-player.html` | 总处理器提取为具名函数 `onMapClick`；所有 `off/on` 一律带 handler 参数；`finishDraw`/`finishPolygonDraw` 结束时恢复 `onMapClick` |

**修复要点**

- `map.on('click', onMapClick)`（具名，可精确增删）。
- `startDraw` / `startPolygonDraw`：`map.off('click', onMapClick)` 只摘总处理器，不再用无参 `off`。
- `finishDraw` / `finishPolygonDraw`：`map.off('click', onMapClick); map.on('click', onMapClick)` **恢复**总处理器（顺带防重复挂载）。
- `onMapClick` 开头 `if(drawing||polygonDrawing) return;` 作为双保险。

**验证**：按 Leaflet `Events` 语义做事件级模拟——修复后「标点→画线→标点→画面→标点」三次都弹面板；旧代码复现只弹 1 次。静态 HTML，浏览器刷新即生效。

**部署**：`git push` → Ubuntu 覆盖 `DMgeo/map-player.html`（静态文件，无需重启服务，Ctrl+F5 强刷）。

---

## 15. DMgeo map-player · 连线改为多段折线

**现象**：`🔗 连线` 一次只能连**两个点**（A→B 生成一段），要连 A-B-C-D 得连三次、得到三段独立线。

**改动**：改为**累积式多段折线**——依次点 A、B、C、D…，所有点串成**一条**折线（一个要素）。

| 路径 | 说明 |
|------|------|
| `DMgeo/map-player.html` | `linkChain` 累积选中点；`updateLinkPreview()` 虚线实时预览；`finishLink()` 生成折线；按钮文案 `🔗 连线` ↔ `🔗 完成` |

**交互**

- 点「🔗 连线」进入模式 → 依次点击各点（已选点变半透明，虚线跟随）
- 结束方式三选一：再点**最后选中的那个点** / 点「🔗 完成」/ 按 **ESC**
- 少于 2 个点结束时提示「至少需要 2 个点」且不生成
- 折线名称自动拼为 `A → B → C → D`，可整体删除

**验证**：逻辑级模拟 —— `A→B→C→D` 生成 1 条 4 点折线、坐标与顺序正确；`A→B→B`（点两次结束）生成 1 条 2 点折线；只点 1 点结束不生成。静态 HTML，刷新即生效。

**部署**：`git push` → Ubuntu 覆盖 `DMgeo/map-player.html`（无需重启服务，Ctrl+F5）。

## 16. DMgeo dashboard · 路径总览不再收录「区域」

**现象**：`dashboard.html` 的「📐 路径总览」会把面要素（Polygon）也列进来，卡片带粉色 `区域` 徽标（例如「天安门广场」），与线路径混在一起。

**改动**：路径总览**只统计线要素**（`LineString` / `MultiLineString`），面要素（区域）不再纳入。

| 路径 | 说明 |
|------|------|
| `DMgeo/dashboard.html` | `renderPathsOverview()` 过滤条件去掉 `Polygon`/`MultiPolygon`；`isLine` 固定为 `true`，徽标恒为「路径」，删掉「区域」分支 |

**验证**：本地改后 `md5` 上传校验一致；HTTP 拉取 `http://192.168.1.9:8084/dashboard.html` 确认已生效（含「路径总览只统计」注释、无 `badge-photo「区域」`）。

**部署**：静态 HTML，覆盖 `DMgeo/dashboard.html` 后 Ctrl+F5 即生效，无需重启服务。

## 17. DMgeo map-player · 前后端同步「挂紧」（删除/回读不再脱钩）

**现象**：断断反馈 `map-player.html` 与后端「挂得不严格」。排查确认 5 处真实脱钩：

| # | 问题 | 位置 | 后果 |
|---|------|------|------|
| 1 | 回读丢弃数据库主键 | `importGeoJSON()` 只吃 `clientId`，把后端返回的 `f.id` 扔掉 | 从库恢复的要素 `dbId` 恒为空 |
| 2 | 删除传的是 clientId | `deleteMarker()` → `/api/geo/marker/m_1` | 后端 `parseInt('m_1')=NaN` → **400 无效ID**，库里删不掉（幽灵要素） |
| 3 | 里外 `dbId` 从不落库 | `buildGeoJSON()` 不输出 dbId | 编辑/删除永远打不中后端 |
| 4 | 全量覆盖旧套路残留 | `saveToServer()` 先发空 `features:[]` "清库" | 内存快照不完整就抹库（后端已用 `mode=replace` 挡住，但前端仍在发这个空包） |
| 5 | 删路径走 marker 接口 | `deletePath()` 用 `/api/geo/marker/:dbId` | 路径/面 `dbId` 为空 → 删不掉 |

**改动**（`DMgeo/map-player.html`）：

- `importGeoJSON()`：读取 `f.id` → 落到 `marker.dbId` / `path.dbId`（点/线/面/文件夹全落）
- 新增 `pendingDeleted` 队列 + `markDeleted(clientId)`：删除操作入队，下次保存随 `payload.deleted` 显式提交
- `saveToServer()`：**删掉先发空包清库的那次调用**，单次提交；带 `deleted` 数组做精确删除同步，成功即清空队列
- `buildGeoJSON()`：marker/path 输出 `dbId`（有则带上）
- `deleteMarker()` / `deletePath()`：改用 `dbId` 调 `/api/geo/marker/:dbId`，并 `markDeleted(clientId)`

**验证**（Ubuntu 192.168.1.9 真实库端到端）：

- 写入 `clientId=e2e_xxx` 测试点 → 回读得到 `dbId=f_584`
- **新行为**用 `f_584` 删 → `200 ok`，残留 **0** ✅
- **旧行为**用 clientId 删 → `400 无效ID`，残留 **1** ❌（复现幽灵要素）
- 清理后 trip 库回到 19 个要素，未误伤业务数据
- 内联脚本 `node --check` 语法通过；HTTP 拉页面确认 4 个修复点全在

**部署**：静态 HTML，覆盖 `DMgeo/map-player.html` 后 Ctrl+F5 即生效，无需重启服务。

## 18. DMgeo · 照片/视频定位收进 PostGIS（消除双存储）

**现象**：地图上拖动照片/视频图标后，定位写进**旧的 JSON 文件**（`geodata/map-data.geojson`，走 `loadMapDB/saveMapDB`），与主数据（PostGIS `features` 表）**两套存储**，查询/统计对不上。

**改动**：

| 路径 | 说明 |
|------|------|
| `DMgeo/map-player.html` | `savePhotoLocation()` 改调 PostGIS 接口 `POST /api/geo/photo-location`（带 `?db=`），不再调旧的 `/api/update-photo-location` |
| `DMgeo/server.js` | `/api/geo/photo-location` 的 POST/DELETE 改用 `getFeaturePool(?db=)`（原写死 `pgPool`=trip，忽略库选择） |

**顺带修出并修掉一个潜伏 bug**：`/api/geo/photo-location` 的 UPDATE 语句带 `updated_at=NOW()`，但 `features` 表**根本没有 `updated_at` 列**（只有 `created_at`）→ 照片**移动坐标时 400 失败**（旧版写 JSON 所以没人发现）。已删掉该列引用。

**验证**（Ubuntu 真实库）：

- 写 `(100,10)` → 回读 `f_588`；移动到 `(110,20)` → `200 ok`、坐标更新、id 不变；删除 → 残留 0；trip 总数回到 19（未误伤）
- 前端 HTTP 校验：已调 `/api/geo/photo-location`、不再含 `/api/update-photo-location`

**遗留（未动，断断未要求）**：旧 `/api/update-photo-location`、`/api/geo/export`、`/api/geo/stats` 等仍读 `map-data.geojson`，但**已无任何前端调用**，属无害死代码，保留不动。

**部署**：`server.js` 改动 → `restart dm-DMgeo`；`map-player.html` 静态 → Ctrl+F5。
