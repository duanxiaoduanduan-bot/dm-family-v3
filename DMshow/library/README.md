# DMshow 素材库

把文件丢进对应目录，刷新主页即可自动完善作品集。

服务总说明见上级 **[../README.md](../README.md)**；家族改动总览见 **[../../CHANGELOG.md](../../CHANGELOG.md)**。

## 目录说明

```
library/
  profile.json     名字、头衔、短简介、标签、外链
  about.md         长文简介 / 文本摘要
  avatar.jpg       头像（可选，也支持 png/webp）
  works/           作品集：每个子文件夹 = 一个作品卡片
  albums/          图集：每个子文件夹 = 一本相册
  videos/          视频：散文件或系列文件夹
  gallery/         散图画廊（瀑布流）
```

## 作品 / 图集文件夹示例

```
works/城市夜景/
  cover.jpg        封面（推荐）
  README.md        摘要正文
  meta.json        可选结构化信息
  01.jpg
  02.jpg
  clip.mp4
```

### meta.json 示例

```json
{
  "title": "城市夜景",
  "summary": "霓虹与雨夜的一组街拍",
  "tags": ["街拍", "夜景"],
  "date": "2026-03",
  "cover": "cover.jpg"
}
```

不写 `meta.json` 时：

- 标题 = 文件夹名
- 摘要 = `README.md` / `desc.md` / `about.md` 第一段
- 封面 = `cover.*` 或第一张图片

## 主页能力

- 自动统计作品 / 图集 / 图片 / 视频数量
- 卡片点开进入全屏幻灯片
- 支持左右切换、键盘方向键、触屏滑动
- 支持自动轮播（灯箱内「自动」或顶栏「轮播」）
