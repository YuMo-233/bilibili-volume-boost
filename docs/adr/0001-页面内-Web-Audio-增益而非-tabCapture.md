# 0001-页面内 Web Audio 增益而非 tabCapture

**状态**: accepted

**决策**: 音量增益不采用通用音量插件（如 Volume Master）的 `chrome.tabCapture` + offscreen 文档方案，而是在 content script 页面内把 `MediaElementAudioSourceNode(video) → GainNode → DynamicsCompressorNode → AudioContext.destination` 直接挂在播放器 video 元素上，全程不碰标签页级音频流。

**理由**: Chrome 有安全机制——扩展一旦捕获标签页音频（tabCapture），浏览器就禁止该标签页进入真正的系统全屏并显示蓝色方框图标；实测 B 站全屏因此退化为网页全屏（NGA 实操反馈与 Volume Master 官方 FAQ 均已确认，且官方明确表示"无法绕过"）。页面内 Web Audio 方案不触发该机制，原生沉浸全屏得以完整保留，这是本插件与通用音量放大器的核心差异化。

**自动播放策略（resume 时机）**: 页面内方案必然要面对 `AudioContext` 的自动播放策略——在用户激活之前，新建的上下文处于 `suspended`，此时调 `resume()` 会被浏览器拒绝，并在控制台留下 `The AudioContext was not allowed to start` 提示。因此 `resume()` 只在两种**放行无疑**的时机调用：页面已获得用户激活（首次点击后 sticky activation 恒为真），或该源已被允许自动播放（MEI 等，表现为 video 正在正常出声）。首次交互前的 resume 交给 `pointerdown` 监听（见 `AudioEngine._canResume`）。

**对后人的警告**: 不要为了省事改用 tabCapture——那会直接摧毁沉浸全屏，回到本插件存在的对立面。

**修订（见 0010）**: 决策中的音频源节点已不再是 `MediaElementAudioSourceNode`。因它**独占且不可释放**，会堵死 B 站自建音频图、导致页内换集静默卡死，现已改用 `video.captureStream()` 抽头 + `MediaStreamAudioSourceNode`（不占槽位）。"页面内 Web Audio、不碰标签页音频"这一核心决策不变。