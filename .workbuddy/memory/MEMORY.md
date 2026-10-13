# 项目长期笔记（B站音量增强）

## 仓库与产物位置

- 仓库：`D:\app\浏览器插件`（Chrome/Edge MV3 扩展本体 + `docs/` + `CONTEXT.md`）。
- **非上架物料一律放仓库外** `d:\app\dist\<name>\`，不进仓库。既有：`edge-store\`（商店素材）、`promo\`（宣传片工程）。扩展包只含 `manifest.json` + `content/*` + `popup/*` + `icons/*` + `_locales/*`。
- 商店包由 `python scripts/pack-store.py [输出目录]` 生成（默认 `d:\app\dist\edge-store\bili-volume-boost-<version>.zip`）：版本号取自 `manifest.json`、固定时间戳可复现、打印 sha256；**不要手工拖拽压缩**。`素材/*` 已在 `.gitignore` 中排除。
- 扩展名与简介自 1.3.4 起走 i18n：manifest 用 `__MSG_extName__` / `__MSG_extDesc__`，实际文案在 `_locales/zh_CN/messages.json`。**改文案只改语言文件**；键缺失会导致扩展无法加载。这也决定商店一览显示哪个语区（语言由包内 i18n 引用推断，页面上改不掉）。
- `docs/store/edge-submission.md` 是上架提交的总清单，含各字段可粘贴文案与版本对应关系。

## 领域语言

- 术语表在仓库根的 `CONTEXT.md`，架构决策在 `docs/adr/`（编号递增）。**代码与文档必须使用 CONTEXT.md 的规范术语**（如「沉浸全屏」「增益」「显示窗」「候补」「补位」）。
- 写文档前先读 `CONTEXT.md`；新增概念按同一格式建档，并保留 `_Avoid_` 反例。

## 环境

- 托管 Python：`C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe`（已装 `imageio-ffmpeg`、`numpy`）。
- 托管 Node：`C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe`；`puppeteer-core` 装在 `...\node\workspace\node_modules`，ESM 里用 `createRequire` 解析。
- 无独立 ffmpeg，走 `imageio_ffmpeg.get_ffmpeg_exe()`；当前为 v7.1。
- 无 Chrome，只有 Edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

## 收尾约定

- 任务完成后提交 git，**只提交自身改动**，提交信息 ≤10 字概括功能；仓库里没有自身改动、或产物本就在仓库外时，跳过提交。
- `.workbuddy/memory/`（`MEMORY.md` + 每日日志）**已纳入版本库**（2026-10-14 决定：用户希望项目记忆跟着项目走，便于换机器/换人接手）。因此它的改动同样算"自身改动"，随任务一并提交。
- `素材/*` 仍在 `.gitignore` 中排除——非上架物料不进仓库。
