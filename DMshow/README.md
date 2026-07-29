# DMshow · 作品集个人主页

把照片、视频、文字放进 `library/`，主页自动排版成作品集；支持灯箱放大与自动轮播。

## 启动

```bash
cd DMshow
node server.js
# 默认 http://0.0.0.0:8086
# 环境变量: PORT 或 DM_PORT
```

经 DMcore 统一入口：`http://主机:8080/show`

## 素材库（自动完善主页）

详见 **[library/README.md](library/README.md)**。

```text
library/
  profile.json     # 名字、头衔、标签、链接
  about.md         # 长文简介 / 文本摘要
  avatar.jpg       # 可选头像
  works/项目名/    # 作品卡片
  albums/相册名/   # 图集幻灯
  videos/          # 视频
  gallery/         # 散图画廊
```

每个作品/图集文件夹可放：

- `cover.jpg`（或 poster/封面）— 卡片封面  
- `README.md` / `desc.md` — 摘要  
- `meta.json` — `title` / `summary` / `tags` / `date` / `cover`

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/portfolio` | 扫描 library 生成完整作品集 JSON |
| POST | `/api/profile` | 保存资料到 profile.json（可选 about→about.md） |
| GET | `/api/sources` | 可用来源（含 library 与外置目录） |
| GET | `/api/scan?path=` | 扫描指定目录媒体 |
| GET | `/library/...` | 静态输出素材文件 |

## 页面能力

- 主页统计：作品 / 图集 / 图片 / 视频数量  
- 文本摘要展开  
- 卡片进入全屏灯箱  
- 顶栏「轮播」、画廊「自动轮播」、灯箱内自动/暂停  
- 键盘 ← → 空格，触屏滑动  

## 清单

见 `dm-manifest.json`（DMcore 托管用，端口 8086）。
