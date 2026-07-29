# 网盘 file-manager 说明

端口默认 **8087**（`FILE_PORT` / `config.json` → `DMmedia.files`）。  
页面：`file-manager.html`，服务：`file-manager.js`。  
版本：**v2.2**（可新增存储介质）。

## 访问

| 方式 | 地址 | 说明 |
|------|------|------|
| 直连 | `http://主机:8087` | 传输通常更快 |
| 代理 | `http://主机:8080/files` | 统一入口，多一跳 |

## 新增存储介质（v2.2）

支持把 **U 盘 / 移动硬盘 / Windows 盘符 / Linux 挂载点 / 任意可读目录** 固定到侧边栏「我的存储」。

### 怎么用

1. 侧边栏底部 **「💾 添加存储」**，或顶栏 **「💾 存储」**
2. **检测到的位置**：插上 U 盘后点 🔄，再点 **固定**
3. **手动添加**：填路径，例如  
   - Windows：`D:\`、`E:\备份`  
   - Linux：`/mnt/usb`、`/media/user/DISK`、`/run/media/...`
4. 也可 **用当前目录** 一键填入后固定  
5. 外接设备列表每项旁的 **📌** = 固定到我的存储  

配置写入：`DMmedia/file-shortcuts.json`（`type: "storage"`）。拔盘后条目仍在，路径不可读时打开会报错，可在管理面板 **移除**。

### 相关 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mounts` | 扫描外接/盘符/已固定存储 |
| POST | `/api/storage/add` | body: `{ name?, path, type?: "storage" }` |
| POST | `/api/storage/remove` | body: `{ path }` |
| GET/POST | `/api/shortcuts` | 全部侧边栏入口（含 storage） |

## 近期修复（v2.1）

### 按键无响应

1. **弹窗秒关**  
   全局 `document.click` 里调用了 `hideModal()`，点「新建文件夹」等会冒泡后立刻关掉。  
   → 已删除该逻辑，只保留点遮罩关闭。

2. **缺少 `addShortcut`**  
   「快捷目录 → + 添加目录」调用未定义函数。  
   → 已补全，并支持目录选择器。

3. **路径破坏 onclick**  
   右键菜单用字符串拼接路径，引号/特殊字符导致菜单项无效。  
   → 改为 `data-cmd` + `addEventListener`。

4. **API 前缀**  
   仅在 `/files/` 下才加前缀，访问 `/files` 时 API 可能打错服务。  
   → 兼容 `/files`、`/files/` 与直连根路径。

### 传输速度与质量

| 项 | 行为 |
|----|------|
| 上传 | 原始 `application/octet-stream`，边收边写盘，**不整包进内存** |
| 完整性 | `xhr.send(file)` 原样字节，不转码 |
| 进度 | 百分比 + **实时速度 (KB/s·MB/s)** + 已传/总量 |
| 并发 | 默认 2（前端 `UPLOAD_CONCURRENCY`） |
| 下载 | `Accept-Ranges` + **HTTP 206**，1MB `highWaterMark` |
| 超时 | `requestTimeout/headersTimeout/timeout = 0`，避免大文件中断 |
| 代理 | `DMcore/proxy.js` 同步关闭长传超时并流式 pipe |

### 中文 / 乱码

| 对象 | 是否会乱码 | 说明 |
|------|------------|------|
| **文件内容**（图/视频/zip/原文） | **不会** | 二进制原样上下传，不转码、不改编码 |
| **上传后的文件名**（含中文） | **正常** | `X-File-Name` + `encodeURIComponent` / 服务端 decode 一次 |
| **下载保存的文件名** | **现代浏览器正常** | `filename*=UTF-8''...`（RFC 5987）；`filename=` 仅 ASCII 兜底 |
| 路径中的中文目录 | **正常** | `path=` 使用 `encodeURIComponent` |

注意：极老浏览器若忽略 `filename*`，可能看到英文下划线兜底名，内容仍完好。重启 `file-manager.js` 后生效。

multipart 仍兼容，但单次有大小上限提示；**推荐走流式上传**（当前前端默认）。

## 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/list?path=` | 列目录 |
| GET | `/api/download?path=` | 下载（支持 Range） |
| POST | `/api/upload?dir=&name=` | 流式上传；头 `X-File-Name` |
| DELETE | `/api/delete` | body: `{ paths: [] }` |
| POST | `/api/mkdir` | `{ parent, name }` |
| POST | `/api/rename` | `{ path, name }` |
| GET/POST | `/api/shortcuts` | 快捷目录 |
| GET | `/api/browse?path=` | 目录选择器 |
| GET | `/api/mounts` | 外接设备探测 |
| GET | `/api/info` | `{ pageDir }` |

## 界面功能摘要

- 列表 / 网格、排序、多选、批量下载/删除  
- 拖拽上传、文件夹上传  
- 侧边栏快捷目录 + 媒体库 + 外接设备  
- 右键：下载 / 重命名 / 复制路径 / 删除  

## 性能预期（局域网）

- 可与 **FTP 同一量级**，不保证全面超过 FTP  
- 更快路径：直连 `:8087`、有线、目标目录用本机快盘、传大文件  
- 面板上的 MB/s 是实际观感标准  

## 重启

```bash
# 随 DMmedia
bash dmcore-start.sh
# 或
FILE_PORT=8087 node file-manager.js
```
