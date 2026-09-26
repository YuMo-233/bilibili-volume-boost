# 0010-换集卡死根因：createMediaElementSource 独占槽位，改用 captureStream 抽头

**状态**: accepted

**症状**: 进入视频页后，在页内切换视频（右侧推荐位、自动连播、分P）时，播放器静默卡死——不报错、不加载、不出声。

**根因**: Web Audio 的 `MediaElementAudioSourceNode` 对同一个 `HTMLMediaElement` **只能创建一次，且不可释放**——再次对同一元素调用会抛 `InvalidStateError: HTMLMediaElement already connected previously`。插件在页面加载时就接管了 video 的音频槽位，而 B 站自己的音频图（仅当素材偏安静、需施加**正**响度增益时才会创建）随后建图即失败，整条播放管线被卡住。

**取证（单变量诱饵实验）**: 把插件的 `createMediaElementSource` 引到一个诱饵 video 上（完全不碰真实播放器），再点击页内换集——339ms 内即 `pushState` 并正常加载；不引诱饵时必卡。因果闭合。

**普查（B 站建图条件）**: 6 个样本中，BV1TWX5BUEgS / BV1Tfhb65EDD 建图（素材偏安静，被施加正增益），BV1LxhD6jEnb / BV15phD6EE6N 不建图，两个直播页都不建图。故"挂进 B 站音频图"的方案在"够响的点播视频"与"直播页"上彻底失效，先予排除。

**决策**: 放弃 `createMediaElementSource`，改用 `video.captureStream()` 取一条**只读音频抽头**，接 `MediaStreamAudioSourceNode → Gain → DynamicsCompressor → destination`。

**验证（真实媒体元素实测，Analyser rms 幅值）**:
1. **不占槽位**: `captureStream()` 之后再对同一元素调 `createMediaElementSource` **仍然成功**（无 already connected）。→ B 站建图不再被堵，根因消除。
2. **抽头不受元素音量/静音影响**: `muted=true` 时 rms=0.5667；`volume=1/0.5/0` 时分别为 0.5633/0.567/0.5652（不变）。对照组 `createMediaElementSource`：`volume=1/0.5/0` → 0.5637/0.2461/0（**受控**）。→ 抽头是解码后原始音频，原生音量层被解耦。
3. **全屏**: captureStream 零 DOM/渲染改动，不影响沉浸全屏；旧机制更激进都未破坏，本机制只会更安全（见 0003）。

**后果与代价**:
- 必须**静音原元素**避免双份声音：captureStream 只是抽头，并不重定向元素输出，元素自身仍会发声。
- 必须**手工镜像原生音量层**：因抽头不受 `volume`/`muted` 影响，须接管 video 的这层语义。
  - **音量**：引擎直接读 `video.volume` 并监听 `volumechange`（读值与事件均跨世界安全）。
  - **静音**：B 站在 **MAIN world** 写 `video.muted`，而隔离世界对元素加的属性（expando）与 `HTMLMediaElement.prototype` 都与 MAIN world 相互隔离，因此覆写必须放在 MAIN world。由 `sniff.js`（MAIN）在引擎给目标 video 打上 `data-bv-target` 标记后覆写该元素的 `muted`：getter 对 B 站返回其"意图"、setter 只记录意图（不写真实值），意图经 `bv_boost_muted` 事件回传隔离世界引擎；元素**真实静音**由引擎统一控制。
  - 最终增益 = `增益倍率 × (意图静音 ? 0 : 原生音量)`（见 0002 修订与 0004）。
- 静音原元素仅在 `ctx.state === 'running'`（本引擎确实在出声）时才进行，避免"元素已静音 + 我们无输出"= 全哑的窗口（如用户手势之前）。
- 保留回退：无 `captureStream` 时退回旧 `createMediaElementSource` 逻辑。

**被否决的备选**:
- **挂进 B 站音频图**: 普查显示 B 站在多数场景（够响的点播、直播）根本不建图，方案失效。
- **延迟接管（仅增益 >100% 时才抢槽位）**: 装本插件的人本就是为增益而来，该方案只"保护从不调音量的人"，等于不保护任何人——用户否决。
