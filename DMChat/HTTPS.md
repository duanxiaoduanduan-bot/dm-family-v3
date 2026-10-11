# DMChat HTTPS 与语音/通话证书说明

## 为什么需要 HTTPS

DMChat 的下面这些功能依赖浏览器的「安全上下文」（浏览器只在 HTTPS 或 localhost 下才开放这些权限）：

- 🎤 语音消息（按住说话，`getUserMedia` 录音）
- 📹 视频通话
- 🖥️ 屏幕共享 / 投屏

走 HTTP（`http://IP:8083`）时这些功能会被浏览器禁用；**文字、图片、文件、聊天记录不受影响**，HTTP 下照常用。

## 端口

| 协议 | 端口 | 说明 |
|------|------|------|
| HTTP | 8083 | 日常聊天、图片、文件、记录 |
| HTTPS | 8443 | 语音 / 通话 / 投屏请走这个 |

## 证书方案

自签证书（无论 openssl 还是 mkcert）默认会被浏览器「红字警告」。要让**所有设备（电脑/手机）**访问 HTTPS 不警告，需要把「信任证书」导入各设备一次。

| 方案 | 说明 | 推荐 |
|------|------|------|
| mkcert 本地 CA | 生成一个本地 CA，证书全由它签发；设备导入 CA 后全部可信、绿锁 | ✅ 推荐 |
| openssl 自签 | 每份证书独立自签，设备直接信任该证书 | 兜底 |

## 生成证书（install.sh 已自动处理）

`install.sh` 会优先用 mkcert（若已装），否则回落到 openssl 自签。生成后文件：

- 证书：`certs/dmchat.crt` + `certs/dmchat.key`（服务端用）
- **信任证书（分发给各设备）：`certs/rootCA.crt`**

手动生成（mkcert）：

```bash
sudo apt install -y mkcert
cd DMChat/certs
sudo mkcert -cert-file dmchat.crt -key-file dmchat.key <本机IP> localhost 127.0.0.1 ::1
sudo cp "$(sudo mkcert -CAROOT)/rootCA.pem" rootCA.crt
```

## 分发信任证书

DMChat 提供了下载地址：

```
http://<IP>:8083/rootCA.crt
```

手机/电脑用浏览器打开即可下载。

> ⚠️ **只分发 `rootCA.crt`（公钥证书）**；`rootCA-key.pem`（CA 私钥）绝不能外传，谁拿到私钥就能伪造你的证书。

## 各设备导入步骤

### Windows

1. 双击 `rootCA.crt` → 点「安装证书」
2. 存储位置选「当前用户」→ 下一步
3. 选「将所有证书都放入下列存储」→ 浏览 → 「受信任的根证书颁发机构」→ 确定 → 完成
4. 重启浏览器

### Android

1. 用手机浏览器打开 `http://<IP>:8083/rootCA.crt` 下载
2. 设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书
3. 选刚下载的文件安装；之后 Chrome 访问 HTTPS 不再警告

### iOS

1. 用 **Safari** 打开 `http://<IP>:8083/rootCA.crt` 下载
2. 弹出「已下载描述文件」→ 设置 → 通用 → VPN 与设备管理 → 点该描述文件 → 安装
3. 设置 → 通用 → 关于本机 → 证书信任设置 → 打开该 CA 的「完全信任」

## 与「域名方案」的对比

- **本方案（mkcert/自签）**：免费、零依赖、开箱即用，代价是每台设备要导入一次 CA。
- **域名 + Let's Encrypt**：证书天然可信、所有设备免装、一劳永逸，但需要一个域名（可用免费子域名如 DuckDNS）。

家庭内网多设备、又不想买域名时，本方案是性价比最高的选择。

## 常见问题

**Q：https://IP:8443 根本打不开（不是红字警告，是「无法连接」）？**
A：这是本机代理软件（Clash / V2Ray / Shadowsocks 等）拦截了内网 HTTPS——HTTP 走直连、HTTPS 走代理导致连不上。关闭代理，或把 `192.168.1.9` 加进代理的「直连/绕过」规则。

**Q：红字警告和「无法连接」是两回事吗？**
A：是。红字警告 = 证书不被信任（靠导入 CA 解决）；「无法连接」= 网络没通（靠解决代理解决）。两者独立。
