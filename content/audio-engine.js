/**
 * 音频增益引擎 — 页面内 Web Audio 管线
 *
 * video ─captureStream()─▶ MediaStreamAudioSourceNode → Gain(增益×原生音量) → DynamicsCompressor(限幅) → destination
 *
 * 为什么用 captureStream 而不是 createMediaElementSource（见 docs/adr/0001、0010）：
 * - createMediaElementSource 会**独占**元素的音频槽位，且不可逆；B 站自己的音频图若此时也要
 *   接管同一元素，就会抛 "HTMLMediaElement already connected previously" 而建图失败，
 *   表现为页内换集后静默卡死。captureStream 是对解码后音频的**只读抽头**，不占槽位
 *   （实测：captureStream 之后再调 createMediaElementSource 仍成功），B 站建图不受影响。
 *
 * 代价与补偿（见 docs/adr/0002、0010、0011）：
 * - captureStream 的音轨**不受元素 volume/muted 影响**（实测 vol=0/0.5/1 与 muted 下幅值不变），
 *   因此原生的"分层音量"要靠本引擎手工镜像：静音原元素避免双份声音，再把 B 站音量与静音
 *   意图乘到增益上，最终响度仍 = 原生音量 × 增益。
 * - 其中**静音意图**必须由 **MAIN world 的 sniff.js** 覆写 video.muted 取得：B 站在 MAIN world
 *   写 video.muted，而隔离世界对元素加的属性 MAIN world 看不见（跨世界隔离），故覆写不能放在
 *   本引擎里。本引擎只负责派发钩子请求、接收意图回传，并统一控制元素的真实静音。
 *
 * 抽头可发声判定与自愈（见 docs/adr/0011）：
 * - 抽头是**唯一**声源：一旦静音原元素，用户能听到的声音只剩抽头这一路。因此绝不能在抽头
 *   不可用时还静音原元素——那等于整页无声（历史 bug 的根因）。
 *   故引入 **可发声判定**：仅当 上下文 running + MAIN world 静音钩子已就绪 + 抽头音轨确有声
 *   （readyState==='live' 且未 muted）时，才静音原元素并放行本图增益；否则原元素保持原生发声、
 *   本图增益归零（降级为"只有原生声音，无增益"，绝不无声）。
 * - 抽头音轨会在**媒体源变化**时 ends（换源/换集/切清晰度），故监听音轨 'mute'/'unmute'/'ended'
 *   与元素 'emptied'，就地**重抽（recapture）**；并周期性兜底校验抽头与元素真实静音状态。
 *
 * 全屏边界：captureStream 零 DOM/渲染改动，不影响 B 站原生沉浸全屏（见 docs/adr/0003）。
 *
 * 感知等量刻度（见 docs/adr/0004）：
 * - 对外数值是"感知响度百分比"（Loudness，50-500），遵循 Stevens 幂律（主观响度 ∝ 幅值^0.6），
 *   拖动/步进时每档听感变化相同（类似系统音量滑块的体验）。
 * - 内部幅值倍率 g：g = (L/100)^(5/3)；L = 100 · g^0.6。
 *   下限感知 50% = 幅值 0.315（-10dB，用于压低过响的极端素材），默认 100%（1x）；
 *   上限感知 500% = 幅值 14.62x（+23.3dB）。
 * - 300 是**常规/极限分界**，不是"无损边界"：是否真的无损取决于素材（实测一条
 *   主体 -31dBFS 的安静视频，峰值在上限前就已进入限幅）。真实限幅量由
 *   getReduction() 读出并显示，不靠档位承诺。
 */
class AudioEngine {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.CtxClass = AC;
    this.ctx = null;         // AudioContext
    this.source = null;      // MediaStreamAudioSourceNode（capture）或 MediaElementAudioSourceNode（回退）
    this.stream = null;      // captureStream() 产出的 MediaStream
    this.gainNode = null;
    this.comp = null;
    this.video = null;       // 当前挂载的 video 元素
    this.boost = 100;        // 感知音量百分比（Loudness），范围 50-500，默认 100
    this.muted = false;      // 插件自身的静音（≠ B 站原生静音）
    this.nativeVolume = 1;   // 镜像：B 站原生音量（0-1）
    this.nativeMuted = false; // 镜像：B 站原生静音意图
    this._legacy = false;    // 无 captureStream 时回退 createMediaElementSource

    this._onNativeMute = null;   // B 站原生静音意图回传监听器（来自 MAIN world 钩子）
    this._onVolumeChange = null;
    this._onSourceReset = null;  // 媒体源重置（emptied）监听器

    this._tapTrack = null;       // 当前抽头音轨（用于生命周期监听）
    this._tapLive = false;       // 可发声判定：抽头音轨当前确有声（live 且未 muted）
    this._hookReady = false;     // MAIN world 静音钩子是否已就绪（回传过初始意图）
    this._emitTap = false;       // 本图当前是否为唯一声源（决定增益是否放行）
    this._watchdog = null;       // 周期兜底：内容级校验抽头是否真的在出声
    this._retapTimer = null;     // 重抽退避重试

    this._analyser = null;       // 抽头信号分析器（内容级可发声判定）
    this._anBuf = null;
    this._lastPeak = 0;          // 最近一次抽头峰值（诊断用）
    this._tapProven = false;     // 抽头是否已被实测证明"确有声"（证明前绝不静音原元素）
    this._noBoost = false;       // 抽头持续无声 → 降级原生发声，不再接管
    this._silentSince = 0;       // 媒体在播但抽头连续无声的起点
    this._recaptureCount = 0;    // 连续重抽次数
    this._attachAt = 0;          // 诊断：挂载完成时刻（ms，自页面导航起）
    this._provenAt = 0;          // 诊断：抽头首次被证明有声时刻
    this._boostAt = 0;           // 诊断：增益首次真正放行时刻
    this._wasEmitTap = false;

    // 抽头音轨事件（生命周期自愈）
    this._onTapMute = () => { this._tapLive = false; this._updateOutput(); };
    this._onTapUnmute = () => {
      this._tapLive = !!(this._tapTrack && this._tapTrack.readyState === 'live' && !this._tapTrack.muted);
      this._updateOutput();
    };
    this._onTapEnded = () => { this._tapLive = false; this._recapture(); };
  }

  /**
   * 挂载到指定 video 元素。
   * 优先用 captureStream 抽头（不占独占槽位）；无该 API 时回退 createMediaElementSource。
   * 元素被 B 站重建后需重新调用。
   * @returns {boolean} 是否成功挂载
   */
  attach(video) {
    if (!video || video.tagName !== 'VIDEO') return false;
    if (video === this.video && this.source) return true;
    try {
      this.teardown(); // 断开旧挂载，避免多路叠加
      if (!this.ctx) this.ctx = new this.CtxClass();

      // 先记录 B 站当下的原生音量/静音意图，后续手工镜像
      this.nativeVolume = Number.isFinite(video.volume) ? video.volume : 1;
      this.nativeMuted = !!video.muted;
      this._hookReady = false;
      this._tapLive = false;

      this._buildChain();

      if (typeof video.captureStream === 'function') {
        this._legacy = false;
        // 抽头取不到音轨（源尚未就绪等）→ 本次挂载失败，元素保持原生发声，等待下轮重试
        if (!this._capture(video)) { this.teardown(); return false; }
      } else {
        this._legacy = true;
        this.source = this.ctx.createMediaElementSource(video);
        this.source.connect(this.gainNode);
      }

      this.video = video;

      if (!this._legacy) {
        this._installHooks(video);
        // 上下文状态变化（含用户手势后 resume）时重算输出
        this.ctx.onstatechange = () => this._updateOutput();
        this._startWatchdog();
      }

      // 自动播放策略：上下文在用户激活前必然起不来，此时 resume() 只会被拒并留下
      // "The AudioContext was not allowed to start" 提示，故先自检（见 _canResume）
      if (this.ctx.state === 'suspended' && this._canResume()) {
        this.ctx.resume().catch(() => {});
      }
      this._attachAt = this._now();
      this._updateOutput();
      return true;
    } catch (err) {
      console.warn('[BVBoost] 音频挂载失败', err);
      return false;
    }
  }

  /** 建增益链：Gain → DynamicsCompressor → destination（幂等，重抽时复用） */
  _buildChain() {
    if (!this.gainNode) this.gainNode = this.ctx.createGain();
    if (!this._analyser) {
      this._analyser = this.ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this._anBuf = new Float32Array(this._analyser.fftSize);
    }
    if (!this.comp) {
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -1;   // 约 -1dB 起限
      this.comp.knee.value = 0;
      this.comp.ratio.value = 20;       // 20:1 近限幅器
      this.comp.attack.value = 0.001;   // 极短起音，消灭削波瞬态
      this.comp.release.value = 0.25;
      this.gainNode.connect(this.comp);
      this.comp.connect(this.ctx.destination);
    }
  }

  /**
   * 取一条 captureStream 抽头并接进增益链。
   * 成功返回 true；无音轨或抛错返回 false（不改变已有图，交由调用方决定回退）。
   */
  _capture(video) {
    let stream = null;
    try {
      stream = video.captureStream();
      const track = stream.getAudioTracks()[0];
      if (!track) {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        return false;
      }
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.gainNode);
      if (this._analyser) this.source.connect(this._analyser);
      this._wireTap(track);
      this._tapLive = track.readyState === 'live' && !track.muted;
      this._tapProven = false;   // 新抽头需重新实测证明有声后，才允许静音原元素
      this._noBoost = false;
      return true;
    } catch (_) {
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (__) {}
      return false;
    }
  }

  /** 订阅抽头音轨生命周期（mute/unmute/ended） */
  _wireTap(track) {
    this._unwireTap();
    this._tapTrack = track;
    try {
      track.addEventListener('mute', this._onTapMute);
      track.addEventListener('unmute', this._onTapUnmute);
      track.addEventListener('ended', this._onTapEnded);
    } catch (_) {}
  }

  _unwireTap() {
    const t = this._tapTrack;
    if (t) {
      try { t.removeEventListener('mute', this._onTapMute); } catch (_) {}
      try { t.removeEventListener('unmute', this._onTapUnmute); } catch (_) {}
      try { t.removeEventListener('ended', this._onTapEnded); } catch (_) {}
    }
    this._tapTrack = null;
  }

  /**
   * 就地重抽：媒体源变化后旧抽头音轨已失效，用同一 video 重新取一条抽头接回原增益链。
   * 取不到（源尚在切换）时先恢复元素原生发声，并退避重试，避免任何无声窗口。
   */
  _recapture() {
    if (this._legacy || !this.video || !this.ctx) return;
    const v = this.video;
    try { if (this.source) this.source.disconnect(); } catch (_) {}
    try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this.source = null;
    this.stream = null;
    this._unwireTap();
    this._tapLive = false;
    this._tapProven = false;
    if (this._capture(v)) { this._updateOutput(); return; }
    this._updateOutput();       // 抽头暂不可用：立刻恢复原生发声
    this._scheduleRetap(0);
  }

  _scheduleRetap(attempt) {
    clearTimeout(this._retapTimer);
    if (attempt > 6 || this._legacy || !this.video) return;
    this._retapTimer = setTimeout(() => {
      if (this._legacy || !this.video) return;
      if (this._capture(this.video)) this._updateOutput();
      else this._scheduleRetap(attempt + 1);
    }, 400 * (attempt + 1));
  }

  /**
   * 登记目标元素并接通跨世界钩子：
   * - 静音意图：给元素打上 data-bv-target 标记，请 MAIN world（sniff.js）覆写其 muted 记录
   *   B 站意图，并通过 bv_boost_muted 事件回传（跨世界隔离，覆写无法在本引擎内完成）。
   * - 音量：无需跨世界，直接读现值 + 监听 volumechange 镜像。
   * 元素真实静音由本引擎统一控制（见 _updateOutput），钩子只负责记录意图。
   */
  _installHooks(video) {
    const self = this;
    this._onNativeMute = (e) => {
      const m = e && e.detail ? e.detail.muted : undefined;
      if (typeof m === 'boolean') {
        self.nativeMuted = m;
        self._hookReady = true;   // 钩子已就绪：其后才允许静音原元素接管
        self._updateOutput();
      }
    };
    window.addEventListener('bv_boost_muted', this._onNativeMute);

    this._onVolumeChange = () => {
      self.nativeVolume = Number.isFinite(video.volume) ? video.volume : self.nativeVolume;
      self._updateOutput();
    };
    video.addEventListener('volumechange', this._onVolumeChange);

    // 媒体验源（换源/换集/清空）→ 抽头音轨随之失效，就地重抽
    this._onSourceReset = () => {
      self._tapLive = false;
      self._updateOutput();
      self._scheduleRetap(0);
    };
    video.addEventListener('emptied', this._onSourceReset);

    // 打标记属性即触发 MAIN world 安装 muted 钩子（见 sniff.js 的 MutationObserver）；
    // 属性值携带"引擎在接管前捕获的 B 站真实静音意图"（'1'/'0'），作为钩子初始意图——
    // 钩子绝不能去读元素当下的 muted，因为引擎随后就会把它强制置真。
    try { video.setAttribute('data-bv-target', this.nativeMuted ? '1' : '0'); } catch (_) {}
  }

  /** 诊断时间戳基准：优先 performance.now()（自页面导航起），否则 Date.now() */
  _now() {
    try { return performance.now(); } catch (_) { return Date.now(); }
  }

  /** 抽头原始信号峰值（0..1；即静音门槛之上是否有声）。无分析器返回 0 */
  _tapPeak() {
    if (!this._analyser || !this._anBuf) return 0;
    try {
      this._analyser.getFloatTimeDomainData(this._anBuf);
      let m = 0;
      for (let i = 0; i < this._anBuf.length; i++) {
        const a = Math.abs(this._anBuf[i]);
        if (a > m) m = a;
      }
      return m;
    } catch (_) { return 0; }
  }

  /**
   * 周期兜底（**内容级**可发声判定）：音轨 readyState/muted 会撒谎——Chrome 下抽头可能
   * 明明"live 且未 muted"却输出静音（如 MSE 换源后旧节点不再跟随）。故用 AnalyserNode
   * 直接测抽头信号，只有**实测确有声**才敢静音原元素：
   *  - 有信号 → 置 _tapProven，解 _noBoost，放行接管；
   *  - 媒体在播却连续无声 → 先重抽（≤3 次），仍无声则判定抽头不可用，置 _noBoost
   *    降级为原生发声（只失去增益，绝不无声）；信号一旦回来立即恢复接管。
   */
  _startWatchdog() {
    clearTimeout(this._watchdog);
    const tick = () => {
      this._watchdogTick();
      // 未证明/降级期加密采样（尽快接管或尽快恢复），稳定后降到 500ms
      const fast = !this._tapProven || this._noBoost;
      this._watchdog = setTimeout(tick, fast ? 50 : 500);
    };
    this._watchdog = setTimeout(tick, 0);   // 挂载后立即先测一次，缩短起播接管延迟
  }

  /** 单次兜底采样（内容级可发声判定，由 _startWatchdog 自适应节流驱动） */
  _watchdogTick() {
    if (this._legacy || !this.video) return;
    const v = this.video;
    const t0 = this._tapTrack;
    if (t0 && t0.readyState === 'ended') { this._recapture(); return; }

    const peak = this._tapPeak();
    this._lastPeak = peak;
    const running = !!(this.ctx && this.ctx.state === 'running');
    const shouldSound = running && !v.paused && !v.ended && v.readyState >= 3 &&
      !this.muted && !this.nativeMuted && this.nativeVolume > 0;

    if (peak > AudioEngine.SILENCE_EPS) {
      if (!this._tapProven) this._provenAt = this._now();
      this._tapProven = true;
      this._silentSince = 0;
      this._recaptureCount = 0;
      this._noBoost = false;   // 抽头确有信号 → 立即恢复接管
    } else if (shouldSound) {
      if (!this._silentSince) this._silentSince = Date.now();
      if (Date.now() - this._silentSince > 2000) {
        if (this._recaptureCount < 3) {
          this._recaptureCount++;
          this._silentSince = Date.now();
          this._recapture();
        } else {
          this._noBoost = true;   // 重抽仍无声 → 判定抽头不可用，降级原生发声
        }
      }
    } else {
      this._silentSince = 0;
    }

    const cur = this._tapTrack;
    this._tapLive = !!(cur && cur.readyState === 'live' && !cur.muted);
    this._updateOutput();
  }

  /**
   * 重算并落地输出状态（可发声判定，见头部说明）。
   * 静音原元素当且仅当"本图确实是唯一声源"（钩子就绪 + 抽头确有声 + 上下文 running），
   * 否则原元素保持原生发声、本图增益归零——保证任何情况下都不出现整页无声。
   */
  _updateOutput() {
    const running = !!(this.ctx && this.ctx.state === 'running');
    const tapUsable = !this._legacy && running && this._hookReady && this._tapLive
      && this._tapProven && !this._noBoost;
    const pluginMuted = !!this.muted;

    if (!this._legacy && this.video) {
      const target = (pluginMuted || tapUsable) ? true : this.nativeMuted;
      try { this.video.muted = target; } catch (_) {}
    }
    // 本图放行增益的条件：回退路径恒放行；抽头路径仅当自己是唯一声源且插件未静音
    this._emitTap = this._legacy ? true : (tapUsable && !pluginMuted);
    if (this._emitTap && !this._wasEmitTap) this._boostAt = this._now();
    this._wasEmitTap = this._emitTap;
    this.apply();
  }

  /** 断开音频图（video 恢复原生直通播放，不受任何影响） */
  teardown() {
    const v = this.video;
    clearTimeout(this._watchdog);
    clearTimeout(this._retapTimer);
    this._watchdog = null;
    this._retapTimer = null;

    if (this._onNativeMute) {
      try { window.removeEventListener('bv_boost_muted', this._onNativeMute); } catch (_) {}
    }
    if (v && this._onVolumeChange) {
      try { v.removeEventListener('volumechange', this._onVolumeChange); } catch (_) {}
    }
    if (v && this._onSourceReset) {
      try { v.removeEventListener('emptied', this._onSourceReset); } catch (_) {}
    }
    this._unwireTap();

    if (v && !this._legacy) {
      // 先把实际静音还原为 B 站意图，再移除标记属性（触发 MAIN world 卸下 muted 钩子）
      try { v.muted = !!this.nativeMuted; } catch (_) {}
      try { v.removeAttribute('data-bv-target'); } catch (_) {}
    }
    if (this.stream) {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this.stream = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
      this.source = null;
    }
    this._onNativeMute = null;
    this._onVolumeChange = null;
    this._onSourceReset = null;
    this.comp = null;
    this.gainNode = null;
    this.video = null;
    this._hookReady = false;
    this._tapLive = false;
    this._emitTap = false;
    this._analyser = null;
    this._anBuf = null;
    this._lastPeak = 0;
    this._tapProven = false;
    this._noBoost = false;
    this._silentSince = 0;
    this._recaptureCount = 0;
    this._attachAt = 0;
    this._provenAt = 0;
    this._boostAt = 0;
    this._wasEmitTap = false;
  }

  /**
   * 自动播放策略自检：只有这几种情况下 resume() 才会被放行——
   *   · 页面已获得用户激活（sticky activation，首次点击后恒为真）
   *   · 该源本身已被允许自动播放（MEI 等），表现为媒体已在正常出声
   * 其余时机调用必定被拒，且浏览器会在控制台留下
   * "The AudioContext was not allowed to start" 提示，故调用前先过这一关。
   */
  _canResume() {
    const ua = navigator.userActivation;
    if (ua && ua.hasBeenActive) return true;
    const v = this.video;
    return !!(v && !v.paused && !v.ended);
  }

  /** 用户手势时兜底恢复 AudioContext（首次播放/点击页面）；resume 后 onstatechange 会重算输出 */
  resumeOnUserGesture() {
    if (this.ctx && this.ctx.state === 'suspended' && this._canResume()) {
      this.ctx.resume().catch(() => {});
    }
  }

  /** 音频管线是否已挂载（供内容脚本守卫使用；注意 ≠ getState().engaged 的临时属性） */
  get engaged() {
    return !!this.source;
  }

  /**
   * 设置增益百分比。
   * 感知刻度：100 → 幅值 1.0；300 → 6.24；500 → 14.62（等感知步进）。
   */
  // 常亮感知下限/上限（Loudness 百分比）：50-500，默认 100
  static get SILENCE_EPS() { return 1e-4; } // 抽头"有信号"判定门槛（约 -80dBFS）
  static get PERC_MIN() { return 50; }   // 50% → 幅值 0.315（-10dB），用于压低过响素材
  static get PERC_MAX() { return 500; }  // 幅值 14.62x（+23.3dB）；实限于压缩器，见 getReduction()

  /** 设置感知音量百分比（50-500） */
  setBoost(percent) {
    const p = Math.round(Number(percent));
    if (!Number.isFinite(p)) return; // 防坏记忆值把增益算成 NaN 而整路静音
    this.boost = Math.max(AudioEngine.PERC_MIN, Math.min(AudioEngine.PERC_MAX, p));
    this.apply();
  }

  /**
   * 当前限幅量（dB，≥0，0 表示未介入）。
   * 直接读 DynamicsCompressorNode.reduction，即压缩器此刻压掉了多少 dB——
   * 用它取代"档位承诺无损"的说法：真实是否被压、压了多少，由它回答（见 docs/adr/0004）。
   */
  getReduction() {
    if (!this.comp) return 0;
    const r = this.comp.reduction;
    return Number.isFinite(r) ? Math.abs(r) : 0;
  }

  setMuted(m) { this.muted = !!m; this._updateOutput(); }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /**
   * 当前幅值倍率 = 增益倍率 × 原生音量层（Stevens 逆幂律，见 ADR-0004）。
   * capture 路径下 captureStream 不受元素 volume/muted 影响，故必须手工乘上镜像层，
   * 才能维持 ADR-0002 的"最终响度 = 原生音量 × 增益"；回退路径由元素自身施加原生音量层。
   * 抽头不可用时（_emitTap=false）本图必须不出声，否则会与原生声音叠加成双份。
   */
  getGainFactor() {
    if (this.muted) return 0;
    const ratio = this.boost / 100;
    const boostF = Math.pow(ratio, 5 / 3); // L^0.6 的逆运算
    if (this._legacy) return boostF;
    if (!this._emitTap) return 0;          // 非唯一声源：本图静默，交由原元素发声
    const vol = Number.isFinite(this.nativeVolume) ? this.nativeVolume : 1;
    const g = boostF * (this.nativeMuted ? 0 : vol);
    return Number.isFinite(g) ? g : 1;
  }

  /** 平滑过渡到目标增益，避免爆音瞬态 */
  apply() {
    if (!this.ctx || !this.gainNode) return;
    const now = this.ctx.currentTime;
    const g = this.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value || 0, now);
    g.linearRampToValueAtTime(this.getGainFactor(), now + 0.08);
  }

  getState() {
    return {
      boost: this.boost,
      muted: this.muted,
      engaged: !!this.source,
      mode: this._legacy ? 'element' : 'capture',
      nativeVolume: Math.round(this.nativeVolume * 100) / 100,
      nativeMuted: this.nativeMuted,
      hookReady: this._hookReady,
      tapLive: this._tapLive,
      emitTap: this._emitTap,
      tapPeak: Math.round(this._lastPeak * 10000) / 10000,
      tapProven: this._tapProven,
      noBoost: this._noBoost,
      attachMs: Math.round(this._attachAt),
      provenMs: Math.round(this._provenAt),
      boostMs: Math.round(this._boostAt),
      ctxState: this.ctx ? this.ctx.state : 'none',
      reduction: Math.round(this.getReduction() * 10) / 10
    };
  }
}

// 兼容多脚本环境：content.js 在 document_idle 时随同加载，window 上注册便于调试
if (typeof window !== 'undefined') {
  window.BVBoostEngineClass = AudioEngine;
}
