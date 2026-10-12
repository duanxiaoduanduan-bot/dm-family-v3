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

## 19. DMgeo dashboard ·「活动时间线」重做为「补充时间计划」

**需求**：断断要把 dashboard 的「📅 活动时间线」（原来只是要素统计而已）重做成**计划任务**——**新增时就带计划时间**，数据存**后端**。

**后端**（`DMgeo/server.js`）：

- `ensureFeatureStore()` 增加 `plans` 表 DDL：
  `id SERIAL PK, title TEXT NOT NULL, detail TEXT, plan_at TIMESTAMP, done BOOLEAN, priority TEXT, created_at, updated_at` + `plan_at` 索引
- 新增 CRUD 路由（均支持 `?db=`）：
  | 方法 | 路径 | 说明 |
  |------|------|------|
  | GET | `/api/plans` | 列表，按 `plan_at` 升序（未排期排最后） |
  | POST | `/api/plans` | 新建（`title` 必填，`plan_at` 可选但可创建时即指定） |
  | PUT | `/api/plans/:id` | 更新（部分字段） |
  | DELETE | `/api/plans/:id` | 删除 |
- 时间归一化 `normPlanTime()`：接受 `YYYY-MM-DD` / `YYYY-MM-DD HH:mm(:ss)` / `T` 分隔，非法存 NULL

**前端**（`DMgeo/dashboard.html`）：

- 面板 `📅 活动时间线` → `🗓️ 补充时间计划`，整行宽
- 右上「＋ 新增任务」→ 内联表单（标题必填 / 计划时间 `datetime-local` / 优先级 / 说明）→ 保存
- 列表项：勾选框（完成态，划线+半透明）、标题、重要标记、说明、**状态点**（未排期/待执行/24h内/已逾期/已完成，按计划时间实时着色）、计划时间、✎ 编辑、✕ 删除
- `refreshAll()` 改调 `loadPlans()`（替换原 `renderTimeline`）
- 新增 `.plan-*` 系列 CSS

**验证**（Ubuntu 真实库，前端逻辑级 + 后端接口级）：

- 新建（带时间）→ 列表按时间升序 → 勾选完成 → 改期 → 删除 → 清空，全链路 200 通过
- 线上 `dashboard.html` 校验：新面板/`plansList`/`loadPlans` 均在，旧「活动时间线」/`renderTimeline` 已移除；`GET /api/plans?db=trip` 返回 200
- 内联脚本 `node --check` 通过；行尾 LF

**部署**：`server.js` 改动 → `restart dm-DMgeo`；`dashboard.html` 静态 → Ctrl+F5。

## 20. DMgeo dashboard · 计划任务挂钩地图要素 + 地点/时间/任务三备注

**需求**：断断指出——计划任务要**挂钩标的路径（地点）**，并**对地点、时间、任务分别备注**。

**后端**（`DMgeo/server.js`）：

- `plans` 表加列：`feature_id` / `feature_name`（挂钩的要素）+ `place_note` / `time_note` / `task_note`（三个独立备注）
- 加 `DDL_PLANS_MIGRATE`（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`），老库自动补列，无需手工迁移
- CRUD 接口（GET/POST/PUT）全部返回并接受这些新字段

**前端**（`DMgeo/dashboard.html`）：

- 表单加「挂钩标的」下拉：数据来自 `collectHookFeatures(mapData)` —— 把当前库地图上的要素按几何类型归类为 **路径 / 区域 / 地点**，值为 `feature_id|feature_name`；「不挂钩」为默认项
- 表单加**三个独立备注框**：📍 地点备注 / 🕐 时间备注 / 📋 任务备注（保留原「总体补充说明」）
- 列表项：挂钩显示 `🔗 名称` 徽标；三备注以标签形式并排展示
- `refreshAll()` 调 `fillHookOptions(mapData)` 随库刷新下拉

**验证**（Ubuntu 真实库，前端逻辑级 + 后端接口级）：

- 挂钩下拉收到当前库 **19** 个要素（1 条路径 + 地点若干 + 区域），路径项显示完整链路名
- 选路径挂钩 + 填三备注 → 保存 200 → 列表读回挂钩名与三备注全对 → 删除 → 清空
- 线上页面校验：`planFeature`/三备注框/`fillHookOptions`/列表 `plan-hook`·`plan-notes` 均在
- 内联脚本 `node --check` 通过；行尾 LF

**部署**：`server.js` 改动 → `restart dm-DMgeo`；`dashboard.html` 静态 → Ctrl+F5。

## 21. DMgeo dashboard · 计划任务「逐途经点排期」（路径自带点可自标）

**需求**：断断指出——上一版"整条路径挂钩 + 三个整体备注"**不够细**；希望**路径本身带的点**能被我们逐点标注，每个点分别填「时间 / 任务 / 补充」。

**后端**（`DMgeo/server.js`）：

- 新表 `plan_stops`：`id SERIAL PK, plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE, seq INTEGER, stop_name TEXT, lng/lat DOUBLE PRECISION, stop_at TIMESTAMP, stop_task TEXT, stop_note TEXT`
- `ensureFeatureStore()` 建表 + `DDL_PLANS_MIGRATE`（`ADD COLUMN IF NOT EXISTS`），老库自动升级
- 新 helper：`readBody(req)`、`normPlanTime(v)`、`replacePlanStops(pool, planId, stops)`
- `GET /api/plans` 二查 `WHERE plan_id = ANY($1::int[])` 把每个计划的 `stops`（按 seq 排序）挂回；`POST` 收 `input.stops`；`PUT` 支持**仅改途经点**（`hasStops` 分支），保留计划其它字段

**前端**（`DMgeo/dashboard.html`）：

- 「挂钩标的」下拉改为**只列路径**（`LineString`/`MultiLineString`）；`collectHookFeatures` 传回完整 feature 对象
- 新增 `buildPointIndex(mapData)`：用当前库里有名字的点要素建「坐标 → 点名」索引（key `lat.toFixed(5)+','+lng.toFixed(5)`）
- 新增 `extractStops(feature, pointIdx)`：把路径每个顶点拆成一行，匹配到点名显示点名、否则显示「点 N」
- 挂钩切换触发 `onHookChange()` → 自动展开 `#planStopsWrap` 并渲染逐点编辑行（每行：**时间**(datetime-local) / **任务**(text) / **补充**(text)）；同点数时保留已填草稿
- 新增 `renderStops()` 渲染编辑行；`_stopsSeed` 为表单途经点草稿
- `openPlanForm(plan)`：编辑态从 `plan.stops` 回填 `_stopsSeed` 并展开；`closePlanForm()`：重置隐藏；`savePlan()`：payload 带 `stops:_stopsSeed`
- 列表项：计划卡片内新增 `.plan-stops` 逐点展示（序号圆标 + 点名 + 时间/任务/补充 chips，未填显示「未标注」）
- 新增 CSS：`.plan-stops/.stop-line/.stop-badge/.stop-nm/.stop-bits/.stop-chip/.stop-empty/.stops-box/.stop-row/.stop-head/.stop-seq/.stop-name/.stop-in/.stop-grow`
- 「整条」三个备注框保留，label 标注「（整条）/（整体）」以区别于逐点字段

**验证**（Ubuntu 真实库，接口级 + 线上页面级）：

- POST 建计划（挂钩真实路径 `f_583`「出发地→宏润学校→灵觉寺→白洋淀→枣林庄→清河佳苑→台头镇→独流镇」+ 3 个途经点）→ 读回 `seq/stop_name/stop_at/stop_task/stop_note` 全对
- **仅改途经点 PUT**：三备注与标题保持不变，3 个途经点被整体替换（时间/任务/补充均更新）
- DELETE → `deleted:1`，**级联清空 stops**；真实用户计划 `id=7`「准备工作」全程未被触碰
- 线上 `dashboard.html` 校验：`onHookChange()`/`planStopsWrap`/`stop-row`/`stops-box`/`途经点排期`/`_stopsSeed`/`stops:_stopsSeed` 均在
- 内联脚本 `node --check` 通过；行尾 LF

**部署**：`server.js` 改动 → `restart dm-DMgeo`；`dashboard.html` 静态 → Ctrl+F5。

## 22. DMgeo dashboard · 挂钩下拉恢复「地点」，每个节点各自成条

**需求**：断断指出——上一版"只给了一整条线的任务"，但**每个地方节点理论上都该有自己的任务**。

**根因**：`trip` 库里 8 个地点本身就是**独立要素**（`f_564` 出发地 … `f_571` 独流镇，`MultiPoint`），`f_583` 只是把这 8 个点串起来的线。上一版 `collectHookFeatures` **只放行线**，把"地点"这张牌漏了 → 用户只能挂整条线，做不出"每个节点一条任务"。

**前端**（`DMgeo/dashboard.html`）：

- `collectHookFeatures` 恢复收录 **Point/MultiPoint（地点）** + LineString/MultiLineString（路径），**地点排前、路径排后**；无名要素跳过
- `onHookChange()`：仅当挂的是**路径**时展开 `#planStopsWrap`（拆途经点）；挂**地点**时隐藏逐点区（地点任务本身就是这一条）
- 表单标签：「挂钩路径」→「挂钩标的」；提示改为「挂钩每个地点各自成条 · 挂钩路径可拆途经点」
- 逐点区标题：`🛣️ 该路径的途经点 — 每个节点各填「时间 / 任务 / 补充」，即是该地点自己的任务`
- 列表渲染优化：每个途经点 `.stop-line` 改为**独立卡片式条目**（独立底色/边框/内边距），未排期节点加 `.is-open` 橙色描边提示"待标注"
- CSS：`.plan-stops` 去左边框线改为独立 gap 布局；`.stop-line` 加背景/边框/圆角/内边距；`.stop-badge` 放大到 18px；`.stop-empty` 文案「待标注」

**验证**（Ubuntu 真实库 + 线上页面）：

- `/api/geo?db=trip` 实测 19 个要素：8 个 `MultiPoint` 地点 + 5+5 个 `MultiPolygon` + 1 条 `MultiLineString`（8 顶点）
- 线上 `dashboard.html`：`挂钩标的`/`stop-line`/`is-open`/`每个节点各填`/`该路径的途经点` 均在
- 内联脚本 `node --check` 通过；行尾 LF

**部署**：`dashboard.html` 静态 → Ctrl+F5。

## 23. DMgeo dashboard · 全链计划（路径主计划 + 节点子任务）

**需求**：断断指出——上一版要么只能做「单点任务」（挂地点），要么「整条线」糊成一条；希望能有**一份全链计划**：一条路径是主计划，**沿途每个节点都是它下面的独立子任务**（各有时间/任务/补充）。

**后端**（`DMgeo/server.js`）：

- `plans` 表加 `parent_id INTEGER REFERENCES plans(id) ON DELETE CASCADE` + `stop_seq INTEGER`（子任务顺序）
- `DDL_PLANS_MIGRATE` 补列 + **补自引用外键约束**（`DO $$ ... plans_parent_fk ... ON DELETE CASCADE`，幂等）——修复"老库补列只有裸列没约束 → 删父计划留孤儿"的隐患
- `DDL_PLANS_PARENT_IDX`：`idx_plans_parent (parent_id, stop_seq)`
- `GET /api/plans`：返回 `parent_id`/`stop_seq`，并把子任务**按 `parent_id` 嵌套进父计划的 `children[]`**（按 `stop_seq` 排序），顶层只返回 `parent_id IS NULL` 者
- `POST /api/plans`：支持 `parent_id`/`stop_seq`；**顶层计划（非子任务）带 `stops` 时自动为每个途经点生成一条子任务**（title=点名，`feature_id` 继承父、`place_note` 继承补充、`stop_seq`=序号），响应返回 `children[]`
- `PUT /api/plans/:id`：支持改 `parent_id`/`stop_seq`

**前端**（`DMgeo/dashboard.html`）：

- 列表渲染：父计划下新增 `.plan-chain`「🛣️ 沿途节点任务」区，每个节点是**独立条目**（独立勾选框 + 序号 + 点名 + 时间 + 内容 + 编辑），顶部显示进度 `已完成/总数`
- 每个子任务**可单独勾选**（`togglePlan`）、**单独编辑**（`editPlan` 现在会搜 `children`）
- `openPlanForm`：编辑子任务时**不显示**路径逐点编辑器（子任务本身就是单个节点）；新增 `_planParentId` 记录
- `savePlan`：编辑子任务时**不重发 `stops`**、不重新生成子任务
- 兼容旧数据：父计划没有 children 但带 `stops` 时，退化为只读逐点展示
- 新增 CSS：`.plan-chain/.chain-head/.chain-prog/.stop-check/.stop-line.is-done/.stop-when/.stop-ops`

**验证**（Ubuntu 真实库，接口级 + 线上页面级）：

- POST 全链计划（挂 `f_583` + 8 途经点）→ **自动生成 8 条子任务**，`stop_seq` 0~7 顺序正确
- `GET /api/plans` → 父计划带 `children=8`；PUT 子任务 #14（改名/时间/备注）独立生效、`parent_id` 不变
- 子任务单独勾选 `done=true` 生效
- **删父计划 → 8 条子任务级联全清**（修复前会残留 8 条孤儿，修复后 PASS）
- 真实用户计划 `id=7` 全程未动；DB 测试数据已清干净
- 线上页面：`plan-chain`/`chain-head`/`chain-prog`/`stop-check` 等均在；前后端 `node --check` 通过；行尾 LF

**部署**：`server.js` → `restart dm-DMgeo`；`dashboard.html` 静态 → Ctrl+F5。

## 24. DMgeo dashboard · 老链路补物化节点任务 + 时间全部可选

**需求**：断断确认「这条链路（8 节点）就对了，其他几个不用那么细」，并要求**补充时间**（且**可选**）。

**澄清**（AskUserQuestion）：① 单点任务不拆（保持简单）；② 全部时间可选（不强制）；③ 给现有链路 #7 补生成节点子任务。

**后端**（`DMgeo/server.js`）：

- 抽出 `materializeChildren(pool, parent, opts)` 复用：把一条顶层计划的 `plan_stops` 物化成 N 条节点子任务；**幂等**（已有子任务直接返回 `[]`，不重复建）
- 新增 `POST /api/plans/:id/materialize?db=`：把**已有**计划的途经点补物化（用于老数据/一键补齐）；`body.force=true` 可先清空再重建
- `POST /api/plans` 改为调用同一 helper（行为不变）
- **修复回归**：修正子任务字段映射——`stop_task → plans.task_note`、`stop_note → plans.place_note`（原先错位成 time_note/task_note）
- **修复隐患**：`force` 模式原先**先删 `plan_stops` 再读**，导致源数据被清空重建为空；改为**先读后删**

**前端**（`DMgeo/dashboard.html`）：

- 老计划有 `stops` 但无 `children` 时，显示 `🛣️ 该路径有 N 个节点 [▶ 生成节点任务]` 按钮 → `materializePlan(id)` 调 materialize 接口后 `loadPlans()`
- 新增 `.chain-btn` 样式（`plan-stops` 内的 chain-head 右侧按钮）

**验证**（Ubuntu 真实库）：

- `POST /api/plans/7/materialize` → **created=8**；复跑幂等 **created=0**
- 修复字段映射后 force 重建 → 8 条子任务 `task_note` 正确（努力准备/测试/等待/坐船/坐车/到达）
- 恢复过程：因早期 buggy force 误删了 #7 的 `plan_stops`，已从 **feature `f_583` 的 8 个顶点 + 8 个同名 Point 要素**反查重建并写回，数据完整
- 节点时间**可选**：`plan_at` 留空保存成功（未排期），填值（如 #40 白洋淀 `2026-10-26T14:00`）即生效；测后已还原为空
- 单点任务 `#28 学习`（挂单个地点）→ `children=0`，**不拆**，符合预期
- 线上页面：`materializePlan`/`/materialize`/`生成节点任务`/`chain-btn` 均在；前后端 `node --check` 通过；行尾 LF

**部署**：`server.js` → `restart dm-DMgeo`；`dashboard.html` 静态 → Ctrl+F5。

## 25. DMgeo dashboard · 「补充时间计划」面板视觉优化（时间选择可清空）

**需求**：断断要求优化「补充时间计划」这一块（含图标），并指出**时间选择有点问题**。

**定位问题**：
- 原生 `datetime-local` 在深色主题下**日历图标发黑**看不清，整体配色不搭
- **无法清空时间** —— datetime-local 没有清除按钮，填了就删不掉
- 节点行里时间输入**无标签**、与任务/补充挤在一行难懂

**前端**（`DMgeo/dashboard.html`，仅动计划面板）：

- **时间可选 + 一键清空**：新增 `setStopAt/clearStopAt/togglePlanAtClear/clearPlanAt`；时间输入外包 `.time-wrap`，有值时才显示 `✕` 清除按钮（`has-val` class 控制显隐）
- **深色主题适配**：`input[type=datetime-local]{color-scheme:dark}` + `::-webkit-calendar-picker-indicator{filter:invert(.75)}` —— 日历图标转亮可点，`::-webkit-datetime-edit` 文字为浅色
- **节点行重排**：`.stop-fields` 分栏 + `.sf-label` 标签（「到达时间（可选）」「任务」「补充」），时间字段固定宽、任务/补充自适应
- **图标统一**：面板标题 `🗓️`/节点区 `🛣️` 包进 `.pc-ico`（圆角紫色底块），「＋ 新增任务」改为 `.plan-add` 描边按钮；子任务未排期时时间 chip 显示「时间可选」+ 虚线弱化（`.stop-when.is-unset`）
- 输入框统一 `:focus` 高亮（紫边 + 微光底）

**验证**（冒烟测试 + 线上核对）：
- 抽出 `renderStops/setStopAt/clearStopAt` 跑 Node 冒烟：生成 HTML 含 `sf-label`/`time-clear`/`has-val`；`setStopAt` 写入后 `has-val=true`、`clearStopAt` 清空后 `has-val=false`
- 线上 `dashboard.html`：`pc-ico`/`plan-add`/`time-clear`/`time-wrap`/`clearStopAt`/`setStopAt`/`togglePlanAtClear`/`clearPlanAt`/`color-scheme:dark`/`时间可选` 均在
- 内联脚本 `node --check` 通过；行尾 LF

**部署**：`dashboard.html` 静态 → Ctrl+F5（仅前端，未动后端）。

## 26. DMgeo dashboard · 挂钩下拉只留路径（单点不再单列）

**需求**：断断明确「挂钩标的里面只留路径就行了，这里不需要单独拆，单独拆的是下面的（我们已经实现了）」。

**背景**：上一版把下拉恢复成「路径 + 地点」混排。但节点拆解已在**下方**通过「路径 → 节点子任务自动物化」实现，下拉里再单列地点既冗余又容易误用（勾一个地点生成一条孤立任务）。

**前端**（`DMgeo/dashboard.html`）：

- `collectHookFeatures(mapData)` 改为**只收线要素**（`LineString` / `MultiLineString`），统一 `kind:'路径'`；过滤掉 `Point` / `MultiPoint`，并去掉原先「地点优先」的排序逻辑
- 文案：标签「挂钩标的」→「**挂钩路径**」；表头提示 → 「**选一条路径 → 自动拆出沿途节点任务**」；空状态 → 「暂无计划任务 — 点右上「＋ 新增任务」，选一条地图路径即可自动拆出沿途节点任务」
- `onHookChange()` 的 `if(!isLine){hide;return}` 守卫保留，单点不再触发节点区展开

**验证**（线上 192.168.1.9:8084 + 真实数据）：
- 当前库 `/api/geo` 共 19 个要素 → 按新逻辑过滤后**只留 1 条**（`f_583` MultiLineString 八节点链路），8 个 MultiPoint 地点**全部被过滤**
- 全链计划 `#45 前进方向`（hook 八节点链路）结构正常：`children=8`，父级 `parent_id=None`
- 线上页面：`挂钩路径`×2、`选一条路径`×1、`kind:'路径'`×1 均在；内联脚本 `node --check` 通过；行尾 LF（CR=0）
- 上传后 md5 本地/远端一致：`da27ee80f1223901b6351a4ff704b14c`

**部署**：`dashboard.html` 静态 → Ctrl+F5（仅前端）。

## 27. DMgeo dashboard · 链头自动汇总时间（起止 + 跨度）

**需求**：断断「写到时间进去他会自动帮我把时间总计出来」——给节点填时间后，系统自动统计这条链的总时间。

**前端**（`DMgeo/dashboard.html`）：

- 新增 `summarizeTimes(nodes)`：汇总一条链上所有**已排期**节点（有 `plan_at`）的
  - 最早时间 `first` / 最晚时间 `last`
  - **跨度**：跨天按「日期」计（同日=1 天，如 10-11→10-15 = 5 天）；同日不足一天按小时显示
  - 已排期计数 `count/total`
  - 未排期节点**不参与**计算，不影响结果；输入乱序自动排序
- 链头 `.chain-head` 新增 `.chain-time` 汇总胶囊：`⏱ 2026-10-11 → 2026-10-15 · 共 5 天 · 4/8 已排期`（青色描边，与紫色进度 `chain-prog` 区分）；仅当至少 1 个节点排期时才显示
- `.chain-head` 加 `flex-wrap:wrap`，汇总胶囊在窄屏自动换行

**验证**：
- Node 冒烟 6 场景全通过：跨天(3天)/同日(12小时)/同日小数(7小时)/部分排期(2/3)/全空(null)/倒序输入(自动排序)
- 真实链路 `#45 前进方向`（8 节点）端到端：临时给 3 个节点排期 → GET → 本地跑 `summarizeTimes` 得 `⏱ 2026-10-11 → 2026-10-15 · 共 5 天 · 4/8 已排期`（与预期一致）；测后已还原测试时间
- 线上页面含 `chain-time`/`summarizeTimes`/`已排期`/`⏱`；内联脚本 `node --check` 通过；行尾 LF（CR=0）
- 上传后 md5 本地/远端一致：`6ac318f59e0acb9b08e9157582e242ba`

**部署**：`dashboard.html` 静态 → Ctrl+F5（仅前端）。

## 28. DMgeo · 照片媒体库目录随安装自动补齐

**需求**：断断发现 `map-player.html` 的照片目录在全新安装时不存在，要求「安装的时候没有也要补上」。

**根因**：
- map-player 照片区数据来自 `GET /api/geo/media?db=<库>`，扫描 `data/database/<库名>/<featureId>/` 下的图片/视频
- 原来 `data/database/` **只有在前端实际上传照片时**才由 `/upload-photo` 惰性创建；全新安装后目录为空 → 照片列表恒为空，容易被误认为功能坏了
- 安装脚本 `05-geodata.sh` 只 `mkdir -p data data/boundaries`，**漏了 `data/database/<featureDb>`**

**改动**：

1. **`DMgeo/server.js`**：新增启动初始化 `ensureRuntimeDirs()`（放在 `server.listen` 之前，进程启动即执行、幂等）——一次性确保 `data/`、`data/boundaries/`、`data/database/`、`data/database/<featureDb>`（默认 `trip`，读取 `storage-config.json`）存在
   - 注：早先误放在 `http.createServer` 回调内（只在收到请求时执行），已移至启动阶段
2. **`install/05-geodata.sh`**：数据阶段开头补建目录骨架，`FEATDB` 从 `storage-config.json` 读取（缺省 `trip`），`mkdir -p data/boundaries data/database/$FEATDB`

**验证**（线上 192.168.1.9:8084）：
- `rm -rf data/database` 后 `restart dm-DMgeo` → 启动自动重建 `data/database/trip/` ✅
- 上传测试照片 → 落盘 `data/database/trip/45/test_photo.png` → `GET /api/geo/media?db=trip` 正确返回该文件（`featureId:45`）✅
- 测后已清理测试文件，`api/media` 恢复 `[]`，dm-DMgeo RUNNING ✅
- `node --check` + `bash -n` 通过；行尾 LF（CR=0）；server.js 本地/远端 md5 一致 `77fa597bb01bab868e2c9424eb3ad502`

**部署**：`server.js` → `restart dm-DMgeo`；安装脚本随下次安装生效。

## 29. DMgeo map-player · 照片/视频区接入新媒体目录

**需求**：断断上传视频后反馈「前端这个位置并不显示」（照片/视频 tab 空白，提示「拖入视频到 geodata 目录」）。

**根因**（新旧两套媒体目录没打通）：
- **照片/视频 tab** 读 `geodata-list.json`，由 `scanGeodataWithCache()` 扫描 `paths.data`（`DMgeo/data/`），**只扫根目录 + 一级子目录**当 photo_group
- **实际上传**落在 `paths.database`（`DMgeo/data/database/<库>/<要素ID>/`），**三级深**，扫描器看不到 → `geodata-list.json` 恒为 `[]` → tab 空白
- 只有「数据 tab → 附件媒体」走 `/api/geo/media`（新目录）能看到，两者割裂

**改动**（`DMgeo/map-player.html`）：
- 新增 `loadAttachedMedia()`：拉 `/api/geo/media`，按 `isVideo`/扩展名分入 `photoList`/`videoList`，与 `geodata-list.json` 结果**合并去重**（按 file 路径）
- `loadGeodata()` 重构：先清空列表 → 读 `geodata-list.json`（含 geojson/gpx 导入，不再空数据直接 return）→ **末尾无条件调用 `loadAttachedMedia()`** → 统一 `renderPhotoGrid()`/`renderVideoGrid()`
- `attachMedia()` 上传成功后补调 `loadAttachedMedia()`，新传的媒体立即出现在照片/视频 tab

**验证**：
- 线上 `/api/geo/media` 返回上传的视频（`holo-20260823-134609.mp4` 37.2MB，featureId=general）
- 用真实 API 数据跑前端归类逻辑：`photoList:0 videoList:1`，src 正确为 `media/geodata/trip/general/...` ✅
- 内联脚本 `node --check` 通过；行尾 LF（CR=0）；map-player.html 本地/远端 md5 一致 `17853e02255ee0aa24da7f64bc5eeff4`

**部署**：`map-player.html` 静态 → Ctrl+F5（仅前端）。

## 30. DMgeo map-player · 媒体「点选→点地图定位」修复（含刷新不丢坐标）

**需求**：断断「点这个库里面视频再点点，按理说会有位置对应啊」——期望在视频列表点视频、再点地图，把视频定位到地图上。

**定位到 3 个问题**：

1. **视频缩略图点击不进定位模式**：`renderVideoGrid()` 的 `item.onclick` 只设 `activeVideo`，且误判 `if(addPhotoMode)`（复制照片逻辑笔误），从不设 `addVideoMode` → 地图点击的 `else if(addVideoMode&&...)` 分支永不命中。只有先点工具栏「🎬 视频」按钮才行，与直觉不符。
2. **媒体要素刷新后丢失**：`buildGeoJSON()` 存 marker 用 `media`/`mediaType` 字段，而 `importGeoJSON()` 恢复时找的是 `props.type==='photo'&&props.photo` / `type==='video'&&props.video` —— **字段名完全对不上**，媒体要素重新加载就消失。
3. **视频定位存储类型错**：`/api/geo/photo-location` 一律写 `type:'photo'`，视频被当照片存 → 恢复走 `addPhotoToMap`（当图片加载）。

**改动**：

- **前端 `map-player.html`**
  - `renderVideoGrid()` 缩略图 `onclick`：直接 `addVideoMode=true` + 光标 cell + 提示，再点地图即定位（无需先按工具栏按钮）；照片 `renderPhotoGrid()` 同改为直接进 `addPhotoMode`（EXIF 逻辑保留）
  - `savePhotoLocation(name,disp,lat,lng,isVideo)` 增加 isVideo 参数；调用点：视频拖拽传 `true`、照片拖拽用 `isVideoUrl()` 自动判定
  - `buildGeoJSON()`：媒体 marker 补 `type` + `photo`/`video` 字段，与恢复逻辑对齐
  - `importGeoJSON()`：`photo`/`video` 分支统一改走 `addMarker(...)`（内部自动建覆盖层），保证标记列表/拖拽/删除同步
- **后端 `server.js`**：`/api/geo/photo-location` 接收 `isVideo`（或按扩展名判定），视频写 `type:'video'`+`video:` 字段，照片写 `type:'photo'`+`photo:`；同步维护 `mediaType`

**验证**（线上 192.168.1.9:8084）：
- POST photo-location（isVideo=true）→ GET `/api/geo?db=trip` 回读：`type=video mediaType=video video=holo-20260823-134609.mp4`，geom `Point [115.5,38.9]` ✅
- 测后已 DELETE 清理测试要素（`f_1028`），库恢复干净 ✅
- 内联脚本 `node --check` + `server.js --check` 通过；行尾 LF（CR=0）

**部署**：`server.js` → `restart dm-DMgeo`；`map-player.html` → Ctrl+F5。

## 31. DMgeo map-player · addMarker 声明顺序整理（防御性）

**缘起**：上一轮（第 30 节）发现 `addMarker()` 中 `m.on('click', ...)` 引用的 `mk` 在之后才 `var` 定义，怀疑是 bug。

**核实结论**：**不是实际故障**。`m.on('click', fn)` 仅注册回调，回调真正执行（用户点击）时 `mk` 已完成赋值；`var` 提升使闭包捕获同一变量引用。用最小复现验证「修复前后 click 均正确返回 `m_1`」。属于**顺序脆弱**（可读性问题、易误判），非运行错误。

**改动**（`DMgeo/map-player.html`，纯整理，行为不变）：
- 把 `var mk={...}` + `markers.push(mk)` 上移到 `m.on('dragend'/'click')` 注册**之前**；dragend 内部变量改名 `cur` 避免与外层 `mk` 混淆
- `importGeoJSON()` 中 folder / 默认分支改用 `addMarker()` 返回值（原先 `markers[markers.length-1]`），与 photo/video 分支一致，避免依赖内部 push 顺序

**验证**：内联脚本 `node --check` 通过；行尾 LF（CR=0）；线上 map-player.html md5 `04ec789e87fde66a1253b110cffa3200`；行为等价（无功能变化）。

**部署**：`map-player.html` → Ctrl+F5。

## 32. DMgeo map-player · 媒体覆盖层重复创建修复（挂好几个）

**需求**：断断「点了图片再点地图怎么感觉会挂好几个？」

**根因**：**双重创建**。`addMarker()` 内部已有「有 media 就自动建覆盖层」的逻辑（第 600-607 行），但多个调用点又**手动先调了一次** `addPhotoToMap()`/`addVideoToMap()`，导致同一媒体被建 2 份覆盖层 + 1 个标记。

**受影响调用点（全部改为只调 `addMarker`）**：

| 位置 | 场景 |
|---|---|
| `onMapClick` 照片/视频分支 | 点缩略图 → 点地图放置（**主诉**） |
| EXIF 自动定位分支 | 点照片 → 检测到 GPS → 自动定位 |
| GPS 批量导入 | 文件夹导入含 GPS 的照片 |
| 单文件放置（上传成功 / 本地回退） | 拖文件到地图定位 |
| 文件夹批量上传（上传成功 / 本地回退） | 批量挂载 |

**保留不变**：`addMarker` 内部建覆盖层（唯一入口）；编辑模式先移除旧覆盖层再重建（第 690-691 行，无重复）。

**验证**（Node mock 量化）：
- 修复前「点图片→点地图」：照片覆盖层 **2 个** + 标记 1 个（重复）
- 修复后：照片覆盖层 **1 个** + 标记 1 个 ✅
- 内联脚本 `node --check` 通过；行尾 LF（CR=0）；线上 md5 `878e691b5c6c0e4e51e483516ce23612`

**部署**：`map-player.html` → Ctrl+F5。

## 33. DMgeo map-player · 连线可捕捉照片/视频点（吸附）

**需求**：断断「我觉得连线应该可以捕捉到照片和图片的点」——连线时能吸附到已有照片/视频标记，而不只是普通标记。

**原状**：连线（`linkMode`）只认普通标记（`markers`）——`onMarkerClickForLink` 由 marker 的 `click` 触发；照片/视频覆盖层（`addPhotoToMap`/`addVideoToMap` 创建的 `L.marker`）**没绑连线点击**，点它们无反应；点地图空白也无吸附。

**改动**（`DMgeo/map-player.html`）：

1. **照片/视频覆盖层绑定连线点击**：`pm.on('click')` / `vm.on('click')` 在 `linkMode` 下调 `onclickForLink({lat,lng,name,kind,key})`
2. **统一入口 `onclickForLink(pt)`**：替代原只处理 marker 的 `onMarkerClickForLink`；用 `key`（`m:<id>` / `p:<file>` / `v:<file>` / `f:<lat,lng>`）去重，回点同一点即结束连线
3. **空白处吸附 `findSnapPoint(latlng,maxPx=18)`**：在点击坐标 18px 内找最近的照片/视频/标记点并吸附；无则用「自由点」
4. **`onMapClick` 新增 `linkMode` 分支**：优先 `findSnapPoint` 吸附，否则自由点
5. **`bubblingMouseEvents:false`**：三处 `L.marker`（照片/视频/普通标记）全部设置，避免点 marker 时事件同时冒泡到 map 导致**同一位置被加两次**
6. 提示文案：「依次点击各点连线；可点照片/视频/标记，点空白处自动吸附最近的点」

**验证**（Node mock）：
- 点击处附近有照片（10px 内）→ 吸附「照片A(photo)」✅
- 点击处很远 → 走自由点 ✅
- 链正确累积 2 点
- 内联脚本 `node --check` 通过；行尾 LF（CR=0）；线上 md5 `5a34e2fbd46815757b3e9e8c0865569e`

**部署**：`map-player.html` → Ctrl+F5。

## 34. DMgeo map-player · 照片/视频覆盖层显示「捕捉锚点」

**需求**：断断「照片很难点到，能不能让照片视频的点显出来方便捕捉？」

**问题**：照片/视频覆盖层是 80×60 的大 divIcon，真实坐标在图标**正中心**，但中心被图片占着，视觉上没有「点」的位置感，连线时很难对准。

**改动**（`DMgeo/map-player.html`）：

1. **锚点小圆点常显**：照片/视频覆盖层 HTML 末尾加 `<span class="mp-anchor">`，居中定位（`top/left:50%` + 负 margin），画一个白边实心小圆 —— 就是真实坐标所在
   - 照片锚点**黄**（`#fdcb6e`）、视频锚点**紫**（`#a29bfe`），与覆盖层描边同色系
   - `.map-photo` 补 `position:relative`（原来缺，锚点无法定位）
2. **连线模式脉冲高亮 `setSnapHot(on)`**：
   - `startLinkMode()` → `setSnapHot(true)`：照片/视频锚点放大到 16px 并播放 `snapPulse` 扩散环动画；普通标记 `zIndex` 提到 1000 置顶
   - `stopLinkMode()` → `setSnapHot(false)`：还原
   - 通过 `marker.getElement()` 找覆盖层 DOM 切换 `.snap-hot` class
3. `.mp-anchor` 设 `pointer-events:none`（锚点纯视觉，点击仍由覆盖层整体接收，不影响原有交互）

**验证**：内联脚本 `node --check` 通过；行尾 LF（CR=0）；线上含 `mp-anchor`×6、`snapPulse`×4、`setSnapHot`×3、`snap-hot`×4；md5 `fe021530c2714744930266cca90a65bf`

**部署**：`map-player.html` → Ctrl+F5。

## 35. DMgeo dashboard · 路径总览补「媒体文件路径」+「媒体拍摄轨迹」

**需求**：断断「这个路径总览没有看到照片的路径」→ 追问后确认「两个都要」（文件路径清单 + 拍摄轨迹）。

**问题（根因）**：`trip` 库里媒体要素**一直存在**（实测 `props.type`：photo ×15、video ×2），但 `renderPathsOverview()` 第 625 行按设计只过滤 `LineString`/`MultiLineString`：

```js
var paths = mapData.features.filter(f => f.geometry.type==='LineString' || f.geometry.type==='MultiLineString');
```

媒体要素是 `Point`，因此**永远不可能进入「路径总览」**。而 `renderLatestMarkers()` 只取 `Point`/`MultiPoint` 且仅显示 `slice(-10)`（后 10 条），23 个 MultiPoint 一挤，媒体也基本看不到。

**改动**（`DMgeo/dashboard.html`）：

1. 新增 `collectMediaFeatures(mapData)`：收集所有带媒体文件的点要素（`photo`/`video`/`media` 三字段任一，`mediaType` 缺失时按扩展名兜底推断），统一结构 `{id,name,file,mediaType,lng,lat,desc,at}`
2. 新增 `renderMediaPathSection(list)` —— **①媒体文件路径清单**：每行 = 类型徽章 + 名称 + 文件路径（等宽字体、`direction:rtl` 长路径末尾省略）+ 坐标 + 「打开」链接；头部计数「N 个文件」
3. 新增 `renderMediaTrackSection(list)` —— **②媒体拍摄轨迹**：按 `updatedAt/created` 排序后连成链路，逐段列出「A → B + 距离」；按「文件+坐标」去重（同名照片重复定位会原地打结）；头部汇总「N 点 · 照片 X / 视频 Y · 全长 Z」
4. 新增 `haversineKm()` 共用球面距离函数，**顺手重构** `renderPathsOverview` 里原来内联的同一段 Haversine 计算（口径统一，行为不变）
5. 新增 `toggleMediaSec(id)` 折叠开关 + 对应 CSS（`.media-sec`/`.media-sec-head`/`.media-row`/`.mr-path`/`.mr-open`），沿用既有 `.path-card` 折叠风格
6. `renderPathsOverview` 早退逻辑调整：原来 `if(!paths.length){显示"暂无路径";return}` 会在无线路时**直接吞掉媒体区块**，改为累积 `html` 后统一判断

**验证**（Node mock + 真库）：
- mock 6 要素（1 线 + 1 面 + 2 照片 + 1 视频 + 1 无属性 MultiPoint）→ 正确收集 3 条媒体、轨迹 3 点、全长 19.560 km、照片 2 / 视频 1 ✅
- 同名同坐标 3 条 → 去重后 2 条 ✅
- 真库 trip：36 要素（10 MultiPolygon / 1 MultiLineString / 2 Point / 23 MultiPoint），`props.type` = photo 15 + video 2 + polygon 10 + path 1 + point 8
- 内联脚本 `node --check` 通过；行尾 LF（CR=0）
- 部署后线上 md5 一致、`dashboard.html` HTTP 200、含 `renderMediaPathSection`/`renderMediaTrackSection`/`toggleMediaSec`/`collectMediaFeatures`/`haversineKm`
- dashboard.html md5 `56c19ccaca39a...`

## 36. DMgeo map-player · 灯箱视频改为显式非静音播放（排查"视频没声音"）

**需求**：断断「为什么我放的图片他不能播放声音啊」。

**排查（ffprobe 实测，关键结论）**：

| 文件 | 流信息 |
|---|---|
| `holo-20260823-134609.mp4`（39MB, 37.7s） | `0,h264,video` — **只有画面，无音频流** |
| `kqcTSd0fctPs5Tn2.mp4` | `0,h264,video` + `1,aac,audio` — 有音轨 |

→ **"没声音"的直接原因是源文件本身就无声**，不是播放器代码问题。

**改动**（`DMgeo/map-player.html`，`openLightbox()`）：虽非根因，但仍消除"自动播放策略导致静音"这一潜在坑：
1. 从 `innerHTML` 注入改为 `document.createElement('video')`，显式设 `controls/autoplay/playsInline`
2. 显式 `v.muted=false; v.volume=1;`（不再依赖属性默认值）
3. 插入 DOM 后主动 `v.play()`；`NotAllowedError` 兜底：改 `muted=true` 再播，并 toast 提示"浏览器拦截了自动播放，请点视频上的播放键，或再次点击开启声音"
4. 视频 `onclick` 阻止冒泡，避免误触灯箱关闭

**验证**：`node --check` 通过；LF（CR=0）；线上含 `muted=false`；md5 一致

**提醒断断**：若还想要那条视频有声音，需换带音轨的源文件（例如上面那个 `kqcTSd0fctPs5Tn2.mp4`）。

## 37. DMgeo dashboard · 路径总览「站点名丢失」修复（精确匹配 → 精确+就近两级）

**需求**：断断「不对，这路径应该和之前不一样了」→ 贴出实际渲染，指出第 5 个站点只有坐标没有名字，要求「和这个（8 个站点全有名字）保持一致」。

**问题（根因）**：路径顶点与站点要素是**两条独立数据**，坐标存在米级漂移：

| | 经度 | 纬度 |
|---|---|---|
| 路径顶点 `f_627[4]` | `116.101945678` | `38.890136513` |
| 站点要素 `f_1982` 枣林庄 | `116.102404545` | `38.890231155` |

两者相距 **41m**。原逻辑用 `toFixed(5)` 做**精确**字符串匹配（`116.10195` vs `116.10240`）→ key 不同 → 枣林庄站点名丢失，退化成纯坐标显示。其余 7 个站点坐标完全相同，所以只有这一个出问题。

**改动**（`DMgeo/dashboard.html`，`renderPathsOverview()`）：

1. 站点索引从单表改为**双结构**：`stationIdx`（精确 `toFixed(5)` 表，快速命中）+ `stationList`（`{lng,lat,name}` 列表，供就近查找）
2. 新增 `nearestStation(lng,lat,tolM)`：容差默认 **300m**，取最近站点名；匹配改为**两级** —— 先精确查表，未命中再走就近
3. **排除媒体点**：站点名只从「地点」点要素收集，`type/mediaType` 为 `photo`/`video` 的点跳过 —— 否则照片文件名（如 `HONhxHda4AAPyyG_1.jpg`）会被当成站点名误吸附
4. 顺带把循环里的 `c[1]/c[0]` 统一为 `lat/lng` 局部变量，去掉重复 `Number()` 转换

**验证**（真实 trip 库 + Python 复刻新逻辑）：
- 修复前命名 **7/8**，修复后 **8/8** —— 第 5 点正确识别为「枣林庄」，与断断贴出的期望一致
- 第 5 点距枣林庄实测 **41.1m**，在 300m 容差内 ✅
- 邻近点冲突排查：全库 25 个命名点，300m 内近邻对 56 对，**全部是同位重复的媒体点**，无站点名重叠、无站点-媒体互扰 → 容差安全
- 内联脚本 `node --check` 通过；行尾 LF（CR=0）；部署后 md5 一致、线上含 `nearestStation`×2

**部署**：`dashboard.html` → Ctrl+F5。

## 38. DMgeo dashboard · 媒体轨迹并入「路径」统一模具（renderPathCard 复用）

**需求**：断断「还是不完全对，我的意思是这个媒体拍摄轨迹和咱们之前的轨道是一样的」→ 追问确认「指地图上手画的线」。

**问题**：第 35 节新增的「媒体文件路径 / 媒体拍摄轨迹」是**另起的一套 UI**（`.media-sec` 折叠块 + 逐段距离列表），与「路径总览」里手画线的 `.path-card` 展示方式完全不同。断断要的是：**媒体点连成的线，就是一条普通「路径」**，和手画线长得一样、走同一套结构。

**改动**（`DMgeo/dashboard.html`）：

1. **抽出共享渲染器 `renderPathCard(idx,name,coords,typeBadge,props,metaExtra)`**：原来 `renderPathsOverview` 循环体内的卡片模板（路径头 + 长度 + 顶点数 + 途经站点 + 折叠明细）整体提取为函数，手画线与媒体轨迹**共用同一模具**
2. **媒体轨迹改造 `buildMediaTrack(list)`**：把去重后的媒体点转成 `coords` 数组，返回 `{name,coords,props,meta}`，交给 `renderPathCard` 渲染 → 徽章改为 `媒体路径`（新增 `.badge-media` 琥珀色），名称「媒体路径（照片/视频按采集顺序）」，明细里附**媒体文件路径可点链接列表**（照片📷/视频🎬）
3. **站点索引提升为模块级**：`stationIdxRef` / `nearestStationRef`（原为 `renderPathsOverview` 内的局部闭包），因为共享渲染器需要访问；值仍是「精确 → 300m 就近」两级匹配
4. **`togglePath(i)` 支持字符串 id**：手画线用 `pathCard0/1/2`，媒体轨迹用 `pathCard_media`，兼容两种
5. **清理**：删除 `renderMediaPathSection` / `renderMediaTrackSection` / `toggleMediaSec` 三个函数及其全部 `.media-sec`/`.media-row` CSS（约 20 行）

**验证**（真实 trip 库）：
- 媒体点去重后 **3 个**（照片 2 + 视频 1），连成一条「媒体路径」，总长 **529.84 km**，走 `renderPathCard` 输出
- 媒体点距所有命名站点都很远 → 正确退化为坐标显示（0/3 命名），符合预期
- 手画线 `f_627` 仍走同一函数，8/8 站点命名不受影响
- 内联脚本 `node --check` 通过；LF（CR=0）；旧函数/旧 CSS **残留数 0**；部署后 md5 一致、线上 `renderPathCard`×1 / `buildMediaTrack`×1 / `badge-media`×2 / `media-sec`×0

**部署**：`dashboard.html` → Ctrl+F5。

## 39. DMgeo dashboard · 媒体逐条成「路径」卡片 + 可挂钩（照片即攻略缩略图）

**需求**：断断「你其实直接按点来跟前面那个路径一样就行，更方便我们在下方建立同样的路径甚至照片可以作为攻略缩略图」→ 再补「出发地 → … → 独流镇  [路径]  8点 · 119.59km 跟这个一样结果就行」。

**问题**：第 38 节把媒体揉成**一条聚合轨迹**，只有一张卡；断断要的是**每个媒体各自一条**，且头部格式与手画线**逐字一致**（`名称 [类型] N点 · X.XXkm`）。

**改动**（`DMgeo/dashboard.html`）：

1. **媒体逐条成卡**：`mediaFeats.forEach` 每个媒体调 `renderPathCard('m'+i, …)`，徽章用「照片」/「视频」(`.badge-photo`/`.badge-video`)。删掉 `buildMediaTrack` 聚合逻辑
2. **头部格式完全统一**：`renderPathCard` 的头一律输出 `缩略图? + 名称 + 类型徽章 + N点 · 距离`；单点（媒体）长度显示 **`—`**（新增 `metricTxt`），明细行也统一为「类型 / 长度 / 顶点数」（去掉了 isMedia 特化的行结构）
3. **媒体去重**：`collectMediaFeatures` 改为按**文件名**归并（`byFile`），后出现者覆盖 —— 修掉同一视频被定位多次导致重复卡片（实测 4 → 3 条）
4. **卡片缩略图**：`.pc-thumb`（照片 34×34 圆角；视频 🎬 图标）
5. **媒体可挂钩（攻略缩略图）**：
   - `collectHookFeatures` 扩展：除线路径外，**照片/视频点也进「挂钩路径」下拉**，`kind` 区分「路径/照片/视频」
   - `onHookChange` 媒体分支：生成**单节点** `_stopsSeed`（带 `thumb`/`mediaType`/`file`），走同一个 `renderStops`
   - `renderStops` 节点行加 `.stop-thumb` 缩略图（照片出图、视频出 🎬）
6. 清理：删掉 `buildMediaTrack`、`.badge-media`；移除半截未接线的 `_stopsSeedPrev` 回填逻辑

**验证**（真实 trip 库 + Python 复刻渲染）：
- 手画线：`出发地 → 宏润学校 → 灵觉寺 → 白洋淀 → 枣林庄 → 清河佳苑 → 台头镇 → 独流镇  [路径]  8点 · 119.59km`
- 媒体（去重后 3 条）：`HONhxHda4AAPyyG_1.jpg [照片] 1点 · —`、`02035-Jessie_ [照片] 1点 · —`、`holo-20260823-134609.mp4 [视频] 1点 · —`
- 格式与手画线**逐字一致** ✅
- `node --check` 通过；LF（CR=0）；部署后 md5 一致、HTTP 200、线上 `stop-thumb`×4

**部署**：`dashboard.html` → Ctrl+F5。

## 40. DMgeo · 修复自动保存导致要素无限重复堆积（数据已清理）

**需求**：断断「问题出在 map-player 这里，他的路径没有跟之前那些对齐，反而多出来很多点位」→ 确认「备份后清理重复」。

**根因（双重）**：

1. **后端 UPSERT 匹配键完全错位**（`server.js` `/save-geodata`）：
   ```js
   if (cid) DELETE ... WHERE properties->>'clientId' = $1
   else    DELETE ... WHERE properties->>'name' = $1 AND type = $2
   INSERT ...
   ```
   前端 `buildGeoJSON` 给每个要素写 `clientId: m.id`，但 `m.id` 是**前端新生成的会话 id**，对「从库里读回来的要素」而言与库里存的 `clientId` 毫无关系 → DELETE 删不到任何东西 → **每次都纯 INSERT**。反复「刷新 + autoSave」→ 要素指数级翻倍（实测 23:35:57 一秒内灌入 36 条）。
2. **前端没把库主键用于匹配**：`importGeoJSON` 只把库主键落到 `m.dbId`，而 UPSERT 只认 `clientId`，两条链路对不上。

**改动**：

- **`DMgeo/server.js`（核心修复）**：`/save-geodata` 的写库循环重写为**主键优先 UPSERT**：
  - 匹配优先级：**`dbId`（库主键，兼容 `f_2186`/`2186`/数字）→ `clientId` → `name+type` 兜底**
  - 命中则 `UPDATE`（保留原 id，几何/属性就地更新）；未命中才 `INSERT`，并把新 id 回写进 `properties.dbId`，供下次精确命中
  - 彻底移除了「先 DELETE 再 INSERT」的旧套路
- **`DMgeo/map-player.html`（防御加固）**：`importGeoJSON` 里把库主键同步写入 `props.clientId`，使 `clientId` 恒定等于库主键 —— 即使 `dbId` 链路失效，`clientId` 也能兜住

**验证（真实环境）**：
- **清理**：先导出完整备份（`.backup/trip-features-20261011-233818.json`，44 条）→ 删 24 条同名同坐标重复（保留 id 最小）→ 再删 3 条 Point/MultiPoint 重复照片视频 → **44 → 17 条，重复组数 0**
- **修复后回写测试**：
  - 带 dbId + 每次全新 clientId：连写 3 次 → 计数稳定 **20 → 20 → 20**（旧逻辑会 40→60→80）✅
  - 极端场景（**不带 dbId、每次全新 clientId**，靠 `name+type` 兜底）：连写 3 次 → 仍稳定 **20 → 20 → 20** ✅
- 最终数据：17 条 = 5 面 + 1 路径（8 顶点）+ 2 照片 + 1 视频 + 8 站点，**全部要素带 `dbId`**
- `node --check` 通过（server.js / map-player.html）；LF（CR=0）

**部署**：`server.js`（restart dm-DMgeo）+ `map-player.html`（Ctrl+F5）。

## 41. DMgeo · 「照片连线」要素纳入节点任务统计（路径类计划自动同步）

**需求**：断断「这个照片连线的线要素怎么不会像点连线的线一样被统计？」

**根因分析（三条链路比对）**：手画线之所以"被统计"，靠的是挂计划时把线拆成 N 条**节点子任务**（`plans.parent_id`），
侧栏「沿途节点任务 0/8」与时间统计都读这里。而照片连线断在三处：

1. **渲染**：`collectMediaFeatures` 只收 `Point/MultiPoint`，**LineString 形式的手画照片连线根本进不了路径总览**
   （老逻辑里媒体卡片只有"一个点"这种形态）。
2. **挂钩**：`collectHookFeatures` 同样只把点媒体放进下拉，线媒体不进。
3. **落库**：更关键的是 —— `materializeChildren` 只在 **POST 新建**时调用，且**只看"有没有子任务"**；
   用 PUT 改过 stops（编辑计划）后节点数变了也不会重建，于是节点数量与子任务永久脱节，统计自然对不上。

**改动**：

- **`DMgeo/server.js`**：新增 `syncPathChildren(pool, parent, stops)` —— 与 `materializeChildren` 的差别是
  **不"有子任务就跳过"，而是比对节点数量**：数量一致才算已拆解，否则整批重建（`DELETE ... WHERE parent_id` 后重插）。
  PUT `/api/plans/:id` 在 `hasStops` 分支里 **无条件调用**（顶层计划才调用，子任务不递归），
  且不区分几何形态 —— 所以**线要素、单节点媒体都走同一条路**：1 个节点 = 1 条子任务。
- **`DMgeo/dashboard.html`**：
  - `renderPathsOverview` 收集当前库**所有**照片/视频点（含手画照片连线）；
    同名的手画线已在前面渲染过时 **跳过媒体行**，避免同一条路径出现两行。
  - `onHookChange` 的媒体分支：`MultiPoint` 取首点，其余逻辑与手画线一致（同样展开成节点行）。
- **不再暴露手动「生成节点任务」按钮**：节点同步已完全自动，`materializePlan` 调用点废弃（接口保留，向后兼容）。

**验证（真实环境 192.168.1.9:8084）**：

- 新建 3 节点计划 → **children=3**；PUT 把 stops 从 3 改成 2 → **复查 children=2**（旧的 3 条被整批重建，无残留、无孤儿）✅
- 造一条 `LineString` 形态的「照片连线」（`f_2222`）挂计划 → **children=3**，三个节点各是一条独立子任务 ✅
- 测试数据全部清理，库回到 **17 条要素 + 1 条计划（8 节点）**
- `node --check` 通过（server.js / 抽取的主脚本块）；LF（CR=0）；线上关键字校验通过

**部署**：`server.js`（md5 `2419872c6da1ca39e13f083147640479`，restart dm-DMgeo）
+ `dashboard.html`（md5 `bf52f5e63e9c4f82d779d7bfd52639b7`，Ctrl+F5）。

## 42. DMgeo · 修复「照片连线刷新后保存不下来」（PG 参数类型推断失败）

**需求**：断断「通过照片，连线之后他的线一刷新怎么保存不下来呢？」

**排查过程**：

1. 先怀疑是 `p.dbId` 丢失 —— `finishLink()` 生成路径时确实**只 push 了 `{id,name,coords,color,line}`，没有 `dbId`**。
2. 但实测发现更严重的问题：**所有"新增要素"的保存全部静默失败**，后端返回
   ```json
   {"ok":false,"error":"could not determine data type of parameter $1"}
   ```
   而前端 `saveToServer` 只在 `r.ok` 时 toast，失败只 `console.error` —— **所以表面上"像是能存"**。
3. 用 psql `PREPARE` 精确复现，锁定到 INSERT 后回写主键那一句：
   ```sql
   PREPARE t2 AS UPDATE features
     SET properties = properties || jsonb_build_object('dbId', $1) WHERE id = $2;
   -- ERROR:  could not determine data type of parameter $1
   ```
   **根因**：`jsonb_build_object()` 是**变参（variadic）函数**，PostgreSQL 无法从调用上下文推断 `$1` 的类型，
   于是 node-postgres 预编译阶段就报错。UPDATE 分支（"命中已有记录"）不经过这一句，所以**只有新增会失败** ——
   这解释了"为什么点/照片标记也存不住、而编辑已有要素正常"。

**改动（`DMgeo/server.js`）**：

```js
// 修复前
... jsonb_build_object('dbId', $1) WHERE id = $2
// 修复后（显式转型，给出类型上下文）
... jsonb_build_object('dbId', $1::text) WHERE id = $2
```

同类写法全库仅此一处（已 grep 确认无其它 `jsonb_build_object` / `jsonb_set` 隐患）。

**验证（真实环境 192.168.1.9:8084）**：

| 用例 | 结果 |
|---|---|
| 全新照片连线（3 点）保存 | `{"ok":true,"added":1}`，回读 `f_2231` 且 `dbId=f_2231` ✅ |
| 模拟刷新后再存 | 仍 `ok:true`，库中 **1 条**（不重复）✅ |
| 连刷 3 次 | 库中仍 **1 条** ✅ |
| 全量回写（25 要素）连发 2 次 | `added:25` 两次，总数稳定 **25 → 25** ✅ |

测试数据已清理，库回到 **17 条要素 + 1 条计划（8 节点）**。

**部署**：`server.js`（md5 `d302d56fb15147d3475dc02bd54466e1`，restart dm-DMgeo）。

**遗留建议（未实施）**：`saveToServer` 失败时只 `console.error`，用户看不到 —— 建议补一个失败 toast，
避免今后再出现"静默不保存"。

## 43. DMgeo map-player · 修正保存失败提示本身有 bug（Response 未解析）

**需求**：断断「我 push 完了，它说保存失败」。

**排查**：第 42 节加的失败告警**自己写错了** ——
```js
var r = await dbApi('/save-geodata', ...);   // dbApi 直接 return fetch(...) → r 是 Response
if (r.ok) { ... } else { showToast(r.error) } // Response 上没有 error 字段！
```
`dbApi()` 的实现是 `return fetch(url,opts)`，**没有解析 body**。所以：
- 成功时 `r.ok === true`（HTTP 2xx），走成功分支 —— **功能正常**
- 但一旦真的失败，`r.error` 是 `undefined`，提示会显示 `保存失败: HTTP undefined`
- 更糟的是：**如果服务端返回 200 但业务层 `ok:false`，`r.ok` 仍是 true → 完全静默**

**改动（`DMgeo/map-player.html`）**：`saveToServer` 显式解析响应体后按「HTTP 层 + 业务层」双重判断：

```js
var resp = await dbApi('/save-geodata', {...});
var data = null;
try { data = await resp.json() } catch(_) { data = null }
if (resp.ok && data && data.ok) { pendingDeleted=[]; saveFailCount=0; showToast('已同步'); return }
var why = (data && data.error) || ('HTTP ' + resp.status);
saveFailCount++;
showToast('⚠️ 保存失败: ' + why + '（修改不会保留）');
if (saveFailCount === 3) alert('连续 3 次保存失败，修改可能丢失：\n' + why);
```

**同时验证后端确实无恙**（192.168.1.9:8084 实测）：

| 用例 | 结果 |
|---|---|
| 全量回写 17 要素 | `{"ok":true,"added":17}` ✅ |
| 2.2MB / 4000 要素大包 | `{"ok":true,"added":4000}`（无 body 限制）✅ |
| 坐标字符串 / null / 单点线 / 未闭合多边形 / 300 字名称 / 引号转义 | 全部 `ok:true` ✅ |

**顺带**：排查过程中误用 `deleted` 数组删掉了两条真实要素（`f_623` 太西智慧酒店、`f_1549` HONhxHda4AAPyyG_1.jpg），
已从 `.backup/trip-features-20261011-233818.json` 完整恢复（含 `features_id_seq` 校正），
库现为 **18 条要素**，测试数据（ZZ*/BIG_* 前缀）全部清理。

**部署**：`server.js`（md5 `d302d56fb15147d3475dc02bd54466e1`）+ `map-player.html`（md5 `bfd907135e168b1ac494382336697921`，Ctrl+F5）。

## 44. DMgeo · 修复「Geometry has Z dimension but column does not」（三维坐标拒存）

**需求**：断断截图 —— 弹窗「连续 3 次保存失败，修改可能丢失：**Geometry has Z dimension but column does not**」。
（第 43 节的告警修复立功了：真实错误第一次显形。）

**根因**：`features` 表的几何列是**二维** `geometry(Geometry,4326)`，而前端某些来源的坐标带**高程 Z**（如
GPS 导入的照片、某些图源/手环轨迹、浏览器定位 API 的 altitude），形如 `[lng, lat, 55.5]`。
PostGIS 写入时严格校验维度 → 三维几何直接拒收，且**带 Z 的那批要素每次保存都失败**（整包一起发，一个失败整包 400）。

**改动（`DMgeo/server.js`）**：`/save-geodata` 写库循环里，每个要素先过 `sanitizeGeometry()`：

```js
function stripZ(coords) {
  if (!Array.isArray(coords)) return coords;
  if (coords.length && typeof coords[0] === 'number') return coords.slice(0, 2); // [lng,lat,z] → [lng,lat]
  return coords.map(stripZ);
}
function sanitizeGeometry(geom) { ...coordinates: stripZ(geom.coordinates)... }
```

INSERT / UPDATE 走同一入口，Point/Line/Polygon/Multi* 全覆盖；Z 只在**写库时**剥掉，前端内存里的不动。

**验证（真实环境 192.168.1.9:8084）**：

| 用例 | 结果 |
|---|---|
| 带 Z 的照片连线 `[116,38,55.5]...` 保存 | `{"ok":true,"added":1}` ✅ |
| 回读 | 自动降为二维 `[116,38],[116.1,38.1],[116.2,38.2]` ✅ |
| 二维数据回归 | 不受影响（stripZ 对二维是恒等变换）✅ |

测试数据已清理。**部署**：`server.js`（md5 `7d5fec44256552d2c83162bae150fd59`，restart dm-DMgeo）。

---

## 45. DMgeo · Z 维度拒存「加固」—— SQL 层 ST_Force2D 兜底 + GeometryCollection 递归剥 Z

**现象**：第 44 节 stripZ 落地后，断断继续 push 仍报「Geometry has Z dimension but column does not」。
`save-fail.log` 显示 `firstGeometry.coordSample` 已是**二维** `[115.849, 28.689]` —— 说明 stripZ 漏了一种坐标形态。

**根因**：`GeometryCollection` 类型没有 `coordinates` 字段（只有 `geometries[]`），第 44 节的
`sanitizeGeometry` 走 `Array.isArray(geom.coordinates)` 分支判断为 false → **直接原样放行**，其中的带 Z 子几何原封不动进了 SQL。

**改动（`DMgeo/server.js`）三重加固**：

1. **SQL 层 `ST_Force2D` 兜底**（最彻底，无论前端怎么漏都强制降 2D）：
   ```sql
   -- INSERT / UPDATE 两处统一
   geom = ST_Multi(ST_MakeValid(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON($3),4326))))
   ```
2. `sanitizeGeometry` 补 `GeometryCollection` 递归剥 Z（`geometries.map(sanitizeGeometry)`）；
3. 诊断日志增强：新增 `coordMaxDim()`，在剥 Z **前**扫描所有要素，抓到真正带 Z 的原始坐标记入 `zFeature`
   （旧日志只记第一个要素，且 catch 里读到的是已剥完的二维，永远定位不到元凶）。

**验证（真实环境 192.168.1.9:8084，restart 后实测）**：

| 用例 | 结果 |
|---|---|
| 三维 Point `[116.4,39.9,55.5]` | `{"ok":true,"added":1}` ✅ |
| GeometryCollection 含三维 Point | `{"ok":true,"added":1}` ✅ |
| psql 回读 `ST_NDims / ST_Zmflag / ST_AsGeoJSON` | `2 / 0 / MultiPoint[[116.4,39.9]]`（Z 已剥）✅ |

测试数据已清理（`remaining test rows: 0`）。**部署**：`server.js`（md5 `fbc6fa606e7b8a1041ce9ef9e0560af1`，restart dm-DMgeo）。

---

## 46. DMgeo · 「线保存失败」真正根因：LineString 坐标多套一层数组

**现象**：断断反馈「轨迹/连线又不能存了」。第 45 节 ST_Force2D 兜底后不再报 Z 错误，但线保存后**刷新消失**。

**真正根因**：`map-player.html` 的 `buildGeoJSON` 里 LineString 坐标多套了一层数组：

```js
// 错误（多一层 []，输出 [[[lng,lat],[lng,lat]]]）：
coordinates:[p.coords.map(c=>[c[1],c[0]])]
// 正确（输出 [[lng,lat],[lng,lat]]）：
coordinates:p.coords.map(c=>[c[1],c[0]])
```

Polygon 需要这层（环数组），LineString 不需要。多一层的 LineString 被 `ST_GeomFromGeoJSON` 解析坏：
- 第 44 节前：解析成带 Z 坐标 → 报「Geometry has Z dimension」；
- 第 45 节加 ST_Force2D 后：Z 被强制降维，但坐标已解析坏 → `ST_MakeValid` 修成 `MultiPoint [0,0]`（坐标全丢，线消失）。

**改动**：`map-player.html` buildGeoJSON 去掉 LineString 多余外层数组（1 行）。

**误删事故与恢复**：排查期间用 `DELETE ... WHERE name LIKE '__%'` 清理测试数据，误把 `_` 当字面下划线（`_` 是单字符通配符），删了 20 行真实数据。用户前端 autoSave 自动回写恢复了大部分；唯一受损的「出发地→…→独流镇」路径（被存成 `[0,0]`）已从本地备份 `.backup/trip-features-20261011-233818.json` 恢复正确坐标（8 站点 LineString）。

**教训**：PostgreSQL `LIKE` 里 `_` 是单字符通配符，字面下划线需 `ESCAPE` 或用 `=` 精确匹配。清理测试数据一律用 `name IN (...)` 精确匹配，禁止 `LIKE '__%'`。

**部署**：map-player.html（md5 `dc1eefa0`）；server.js（md5 `fbc6fa60`）。

## 47. DMgeo dashboard · 路径总览「展不开」+ 去掉照片点

**现象**：断断反馈 dashboard.html「📐 路径总览」下的路径卡片点开无反应，且下面不该显示照片点。

**根因 1（展不开）**：`renderPathCard` 生成头部 onclick 时把数字索引也包成字符串 `togglePath('0')`，而 `togglePath` 用 `typeof i==='number'` 判断去拼 id（`pathCard0` vs `pathCard_0`），字符串传进去查不到 `pathCard0`，展开失效。修复：按 idx 类型拼参数 —— 数字不带引号、字符串带引号。

**改动 2（去照片点）**：路径总览只渲染手画线路径（LineString/MultiLineString），删除「媒体（照片/视频）逐条成卡」的渲染逻辑；并删除随之失效的 `collectMediaFeatures` / `mediaMetaRow` 死函数。

**部署**：dashboard.html（md5 `c0287dff`，静态文件，直接覆盖无需重启）。

## 48. DMgeo · 挂钩路径去照片 + 路径站点挂照片缩略图（持久化）

**需求**（断断）：①「补充时间计划」的「挂钩路径」下拉里**不要照片/视频**，只保留路径；②但计划选中某条路径后，路径上的站点能**就近把照片缩略图挂过来**，且保存后「最终结果」（计划列表的节点子任务/途经点）里能看到缩略图。

**前端（dashboard.html）**：
- `collectHookFeatures` 改为**只收路径（线）**，删掉照片/视频入下拉逻辑。
- 新增 `collectPhotoPoints`：收集库内照片点（坐标+文件路径，排除视频）。
- `extractStops(feature, pointIdx, photoPts)`：每个站点就近匹配（300m 内）挂照片缩略图到 `thumb`。
- `fillHookOptions` 收集 `_photoPtsGlobal`；`onHookChange` 传参。
- 计划列表渲染：节点子任务（按 `stop_seq` 关联 `plan_stops.thumb`）与未拆解途经点均显示缩略图；编辑回填也保留 `thumb`。

**后端（server.js）**：
- `plan_stops` 表新增 `thumb TEXT DEFAULT ''`（DDL + `DDL_PLANS_MIGRATE` 补列）。
- `replacePlanStops` / `materializeChildren`（读+force 重建）/ 读取 stops 的 SELECT 全部带上 `thumb`。

**验证**：POST 带 `thumb` 的计划 → GET 回读 `stops[0].thumb="/media/photoA.jpg"` 持久化成功，子任务正常生成；测试数据已清。

**部署**：dashboard.html（md5 `f924befb`，静态）；server.js（md5 `b3083b51`，restart dm-DMgeo，已执行补列 `plan_stops.thumb`）。

**补充**：缩略图加灯箱（点开看大图）——`openLightbox(this.src)` 复用单个遮罩节点，点遮罩/✕ 关闭；三处缩略图（编辑表单节点、计划子任务、未拆解途经点）均已挂 onclick。dashboard.html md5 `d9d272f0`。

## 49. DMgeo map-player · 新增谷歌底图（街道/卫星/混合）

**改动**：`map-player.html` 多底图 `baseDefs` 增加三个 Google 瓦片源，底图选择器加对应按钮：
- 谷歌街道 `lyrs=m`、谷歌卫星 `lyrs=s`、谷歌混合 `lyrs=y`，`mt{s}.google.com/vt/...`，子域 `1234`，maxZoom 20。

**⚠️ 网络提醒**：Google 瓦片域名在中国大陆通常被墙、直连不可达，需浏览器走代理/VPN 才能显示；无代理时切到谷歌底图会灰屏，属正常。高德/OSM 仍为大陆可用默认。

**部署**：map-player.html（md5 `8ab0060c`，静态文件，覆盖无需重启）。

## 50. DMmedia · 六个播放器全部加「按名字搜索」

**背景**：`#media`（8085 门户 → 8081 DMmedia）各模块的目录已经由「转播」聚合了本机 + 远端，但列表只能靠翻。本次给六个播放器各加一条搜索栏，输入即筛，结果点一下直接播。

**相关文件（全部在 `DMmedia/`）**

| 文件 | 搜索范围 | 命中后行为 |
|------|----------|------------|
| `tvdrama-player.html` | 剧名 + 集名 | 命中剧名→选中该剧；命中集名→直接播那一集 |
| `mv-player.html` | 标题 + 歌手 | 列表内筛，点击播放 |
| `music-player.html` | 标题 + 歌手 | 列表内筛，点击播放 |
| `album-player.html` | 相册名 + 图片名 + 视频名 | 结果浮层，点击跳相册并**定位到那张图 / 打开那段视频** |
| `book-reader.html` | 书名 + 作者 | 自动展开书架面板并筛，点击开书 |
| `audio-player.html` | 标题 + 作者 + 专辑 | 跨专辑扁平结果，点击直接播 |

**实现要点**

- 纯前端筛选：直接过滤各页已加载的 `*-list.json`（该 JSON 由 `server.js` 的 `respondAggregated()` 产出，已含转播远端），**无需改后端**，因此远端内容天然可搜。
- 每页头部下方加统一 `.searchbar`：🔍 输入框 + ✕ 清除 + 命中计数；样式跟随各页主题色（剧/MV 红、音乐紫、写真金、阅读棕、有声书青）。
- 匹配规则：大小写不敏感的子串匹配；清空即还原完整列表；无结果显示「无匹配」。
- 顺手修了一个隐患：六页的全局 `keydown` 之前会在输入框里按空格/方向键时误触发播放、翻页等，现统一加了「焦点在 input 时直接 return」的守卫；`Esc` 可清空搜索。

**验证**（jsdom 真跑页面脚本，桩掉 fetch / 媒体接口）：35 项断言全绿，覆盖初始列表、按名筛、按歌手/专辑/作者筛、无匹配提示、清空还原、写真馆点结果跳图并定位到第 2 张、阅读自动展开书架面板等。

**部署**：6 个 html 均为静态文件，覆盖即生效，无需重启 dm-DMmedia。

**注意**：本次改动落在 `D:\Dmhome\dm-family-v3\DMmedia`（现行版本）；`D:\llht\dm-family-20260717\dm-family\DMmedia` 是陈旧副本（无 `remotes.html`），未同步。
