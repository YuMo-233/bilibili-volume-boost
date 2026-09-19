# B站音量增强（bilibili-volume-boost）

一个 Chrome / Edge Manifest V3 扩展：为 bilibili 的视频与直播提供原生 100% 上限之外的音量增益，按 UP 主记忆音量，并在直播沉浸全屏时于画面角落显示醒目留言（SC）。

**全程不破坏 B 站原生的沉浸全屏**——这是本项目的核心设计约束。

## 功能

### 音量增益

- 感知等量刻度 **50%–300%**（默认 100%）。遵循 Stevens 幂律（主观响度 ∝ 幅值^0.6），拖动与步进时每档听感变化一致；上限 300% 对应幅值 **6.24x**（+16dB），下限 50% 对应 0.315x（−10dB，用于压低过响素材）
- 分层音量模型：完全不修改 B 站原生音量滑块（管 0–100%），插件增益叠加在其之上，**最终响度 = 原生音量 × 增益**
- 串联 `DynamicsCompressorNode` 限幅（阈值 −1dB、比例 20:1、极短 attack），极限增益下不削波爆音
- **按 UP 主记忆**：视频页按 mid、直播页按主播 uid 分别记忆，再次进入自动套用；视频 1024 条 / 直播 256 条独立配额，各自 LRU 淘汰
- 增益滑块注入播放器控制栏、紧邻 B 站原生音量按钮，Shadow DOM 隔离样式，全屏下跟随原生控制栏

### 直播全屏醒目留言（SC）

- **仅在沉浸全屏下显示**（网页全屏与普通状态不显示，避免与原生公屏 SC 重复）
- 显示于画面四角之一，可在 popup 切换（默认右上）
- 卡片含头像、用户名、价格、留言正文与剩余悬挂时间进度条
- 配色直接取自接口下发的 `background_color` / `background_bottom_color` / `background_price_color`，与 B 站原生 SC 色阶一致，无需硬编码价格档位
- 同时悬挂多条时按价格降序，最多显示 3 条，超出折叠为「+N 条」
- 悬停可点击 × 手动关闭单条

### 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt` + `↑` / `↓` | 增益 ±10% |
| `Alt` + `0`–`9` | 定档（100% 起，每档 +20%） |
| `Alt` + `M` | 静音切换 |

焦点位于输入框 / textarea / 可编辑元素时全部放行，绝不拦截打字。

## 安装

未发布到扩展商店，需以开发者模式加载：

1. 下载或克隆本仓库
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 打开右上角「开发者模式」
4. 点「加载已解压的扩展程序」，选择本仓库根目录

## 使用

- 播放器控制栏出现增益按钮，悬停弹出竖直滑块，可拖动、滚轮微调或点刻度直达
- 快捷键在页面任意位置生效（输入框内除外）
- popup 面板显示当前页面类型、识别到的 UP 主与当前增益，并提供插件总开关、SC 浮层开关与 SC 显示位置

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存 UP 主音量记忆与配置 |
| `activeTab` | popup 读取当前页面状态 |
| `host_permissions` → `api.live.bilibili.com` | 轮询直播醒目留言列表 |

扩展不向任何第三方服务器上报数据，仅向 B 站官方接口读取公开的醒目留言列表；所有配置只存于本地 `chrome.storage.local`。

## 工作原理

### 为什么不用 tabCapture

`chrome.tabCapture` 会让 Chrome 施加「扩展正在操纵音频」的限制，导致沉浸全屏被禁用。因此改为在页面内直接用 `MediaElementAudioSourceNode` 接管 video 元素的音频：

```
video → MediaElementAudioSourceNode → GainNode → DynamicsCompressorNode → destination
```

### 直播全屏 SC 为什么能显示

B 站原生 SC 面板位于右侧栏（`.aside-area`），与播放器列（`.player-ctnr`）是**兄弟节点**。沉浸全屏走 Fullscreen API，浏览器只渲染全屏元素的子树、右栏被排除，因此原生 SC 在全屏下必然不可见。

本扩展改为自绘浮层，注入播放器列内的 `.live-player-mounter`（与 `<video>` 同级，位于全屏元素子树内），故跟随全屏显示。

取数走 `GET /av/v1/SuperChat/getMessageList?room_id=`（无需登录），每 10 秒轮询一次。选择轮询而非拦截页面 WebSocket，是因为 B 站直播弹幕包为 brotli 压缩，而浏览器原生 `DecompressionStream` 不支持 brotli；SC 属长悬挂内容（最短 60 秒），10 秒轮询不会漏项。

## 目录结构

```
manifest.json
content/
  sniff.js          UP 主/主播识别（MAIN world，读取页面全局状态）
  audio-engine.js   Web Audio 增益引擎（挂载 / 重挂 / 限幅）
  memory.js         UP 主记忆存储（分桶 + LRU）
  ui.js             增益悬浮滑块（Shadow DOM）
  superchat.js      醒目留言取数（HTTP 轮询）
  superchat-ui.js   醒目留言浮层（Shadow DOM）
  content.js        主逻辑编排
popup/
  popup.html / popup.js   配置面板
icons/                图标（icon.svg 与生成的多尺寸 PNG）
scripts/gen-icons.js  纯 Node 无依赖的图标生成脚本
docs/adr/             架构决策记录
CONTEXT.md            领域术语表
```

## 设计文档

架构决策以 ADR 形式记录在 [`docs/adr/`](docs/adr)，领域术语见 [`CONTEXT.md`](CONTEXT.md)：

- [0001 页面内 Web Audio 增益而非 tabCapture](docs/adr/0001-页面内-Web-Audio-增益而非-tabCapture.md)
- [0002 分层音量模型](docs/adr/0002-分层音量模型.md)
- [0003 全屏边界：不做任何全屏 UI 改造](docs/adr/0003-全屏边界-不做任何全屏-UI-改造.md)
- [0004 感知等量增益刻度](docs/adr/0004-感知等量增益刻度.md)
- [0005 全屏醒目留言浮层：自绘复刻 + HTTP 轮询](docs/adr/0005-全屏醒目留言浮层-自绘复刻.md)

## 开发

图标由脚本程序化生成，无任何第三方依赖：

```bash
node scripts/gen-icons.js
```

## 已知限制

- 增益只作用于当前播放器，不改变系统音量
- SC 浮层有最多一个轮询间隔（10 秒）的显示延迟；SC 被删除或悬挂结束时，需等下一轮轮询才会消失
- SC 浮层依赖直播页 DOM 结构（`.live-player-mounter`），B 站改版可能导致注入点失效
- 仅在 Chromium 内核浏览器（Chrome / Edge）测试

## 免责声明

本项目为个人学习与自用工具，与哔哩哔哩官方无关。请遵守 B 站用户协议与相关法律法规，请勿用于商业用途或批量抓取。

## 开源协议

[Apache License 2.0](LICENSE) © 2026 YuMo-233
