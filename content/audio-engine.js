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
 * 代价与补偿（见 docs/adr/0002、0010）：
 * - captureStream 的音轨**不受元素 volume/muted 影响**（实测 vol=0/0.5/1 与 muted 下幅值不变），
 *   因此原生的"分层音量"要靠本引擎手工镜像：静音原元素避免双份声音，再把 B 站音量与静音
 *   意图乘到增益上，最终响度仍 = 原生音量 × 增益。
 * - 其中**静音意图**必须由 **MAIN world 的 sniff.js** 覆写 video.muted 取得：B 站在 MAIN world
 *   写 video.muted，而隔离世界对元素加的属性 MAIN world 看不见（跨世界隔离），故覆写不能放在
 *   本引擎里。本引擎只负责派发钩子请求、接收意图回传，并统一控制元素的真实静音。
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
    this._onNativeMute = null; // B 站原生静音意图回传监听器（来自 MAIN world 钩子）
    this._onVolumeChange = null;
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

      if (typeof video.captureStream === 'function') {
        this._legacy = false;
        const stream = video.captureStream();
        if (!stream.getAudioTracks().length) {
          try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
          throw new Error('captureStream 未产出音轨');
        }
        this.stream = stream;
        this.source = this.ctx.createMediaStreamSource(stream);
      } else {
        this._legacy = true;
        this.source = this.ctx.createMediaElementSource(video);
      }

      this.gainNode = this.ctx.createGain();
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -1;   // 约 -1dB 起限
      this.comp.knee.value = 0;
      this.comp.ratio.value = 20;       // 20:1 近限幅器
      this.comp.attack.value = 0.001;   // 极短起音，消灭削波瞬态
      this.comp.release.value = 0.25;
      this.source.connect(this.gainNode);
      this.gainNode.connect(this.comp);
      this.comp.connect(this.ctx.destination);
      this.video = video;

      if (!this._legacy) {
        this._installHooks(video);
        // 上下文状态变化（含用户手势后 resume）时同步原元素的静音
        this.ctx.onstatechange = () => this._syncElementSilence();
      }

      // 自动播放策略：上下文在用户激活前必然起不来，此时 resume() 只会被拒并留下
      // "The AudioContext was not allowed to start" 提示，故先自检（见 _canResume）
      if (this.ctx.state === 'suspended' && this._canResume()) {
        this.ctx.resume().catch(() => {});
      }
      if (!this._legacy) this._syncElementSilence();
      this.apply();
      return true;
    } catch (err) {
      console.warn('[BVBoost] 音频挂载失败', err);
      return false;
    }
  }

  /** 断开音频图（video 恢复原生直通播放，不受任何影响） */
  teardown() {
    const v = this.video;
    if (this._onNativeMute) {
      try { window.removeEventListener('bv_boost_muted', this._onNativeMute); } catch (_) {}
    }
    if (v && this._onVolumeChange) {
      try { v.removeEventListener('volumechange', this._onVolumeChange); } catch (_) {}
    }
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
    this.comp = null;
    this.gainNode = null;
    this.video = null;
  }

  /**
   * 登记目标元素并接通跨世界钩子：
   * - 静音意图：给元素打上 data-bv-target 标记，请 MAIN world（sniff.js）覆写其 muted 记录
   *   B 站意图，并通过 bv_boost_muted 事件回传（跨世界隔离，覆写无法在本引擎内完成）。
   * - 音量：无需跨世界，直接读现值 + 监听 volumechange 镜像。
   * 元素的**真实静音**由本引擎统一控制（见 _syncElementSilence），钩子只负责记录意图。
   */
  _installHooks(video) {
    const self = this;
    this._onNativeMute = (e) => {
      const m = e && e.detail ? e.detail.muted : undefined;
      if (typeof m === 'boolean') { self.nativeMuted = m; self.apply(); }
    };
    window.addEventListener('bv_boost_muted', this._onNativeMute);

    this._onVolumeChange = () => {
      self.nativeVolume = Number.isFinite(video.volume) ? video.volume : self.nativeVolume;
      // 安全网：万一 MAIN world 钩子缺失，B 站取消静音会让原元素真的出声（双份声音），
      // 这里在出声期间把真实静音重新压回 true；钩子在位时该真实值不会被 B 站改动，本句为惰性。
      if (!self._legacy && self.ctx && self.ctx.state === 'running' && video.muted !== true) {
        try { video.muted = true; } catch (_) {}
      }
      self.apply();
    };
    video.addEventListener('volumechange', this._onVolumeChange);

    // 打标记属性即触发 MAIN world 安装 muted 钩子（见 sniff.js 的 MutationObserver）；
    // 属性值携带"引擎在接管前捕获的 B 站真实静音意图"（'1'/'0'），作为钩子初始意图——
    // 钩子绝不能去读元素当下的 muted，因为引擎随后就会把它强制置真。
    try { video.setAttribute('data-bv-target', this.nativeMuted ? '1' : '0'); } catch (_) {}
  }

  /**
   * 同步原元素的真实静音：仅当本引擎确实在出声（ctx running）时才静音原元素，
   * 否则会出现"元素已静音 + 我们还没输出"= 全哑的窗口（如用户手势之前）。
   * 这里直接写 video.muted（隔离世界的写不会经过 MAIN world 钩子），对 B 站不可见。
   */
  _syncElementSilence() {
    if (this._legacy || !this.video) return;
    const running = !!(this.ctx && this.ctx.state === 'running');
    const target = running ? true : this.nativeMuted;
    try { this.video.muted = target; } catch (_) {}
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

  /** 用户手势时兜底恢复 AudioContext（首次播放/点击页面）；resume 后 onstatechange 会自动静音原元素 */
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

  setMuted(m) { this.muted = !!m; this.apply(); }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /**
   * 当前幅值倍率 = 增益倍率 × 原生音量层（Stevens 逆幂律，见 ADR-0004）。
   * capture 路径下 captureStream 不受元素 volume/muted 影响，故必须手工乘上镜像层，
   * 才能维持 ADR-0002 的"最终响度 = 原生音量 × 增益"；回退路径由元素自身施加原生音量层。
   */
  getGainFactor() {
    if (this.muted) return 0;
    const ratio = this.boost / 100;
    const boostF = Math.pow(ratio, 5 / 3); // L^0.6 的逆运算
    if (this._legacy) return boostF;
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
      ctxState: this.ctx ? this.ctx.state : 'none',
      reduction: Math.round(this.getReduction() * 10) / 10
    };
  }
}

// 兼容多脚本环境：content.js 在 document_idle 时随同加载，window 上注册便于调试
if (typeof window !== 'undefined') {
  window.BVBoostEngineClass = AudioEngine;
}
