/**
 * 音频增益引擎 — 页面内 Web Audio 管线
 *
 * video → MediaElementAudioSourceNode → Gain(增益) → DynamicsCompressor(限幅) → destination
 *
 * 设计约束（见 docs/adr/0001）：
 * - 不捕获标签页音频（不用 tabCapture），不会触发 Chrome 的"扩展操纵音频则禁全屏"机制，
 *   从而完整保留 B 站原生沉浸全屏。
 * - 不修改 video.volume（分层音量模型，见 docs/adr/0002）：B 站原生滑块管 0-100%，
 *   本引擎只负责增益轨道。最终响度 = 原生音量 × 增益（幅值倍率）。
 *
 * 感知等量刻度（见 docs/adr/0004）：
 * - 对外数值是"感知响度百分比"（Loudness，50-300），遵循 Stevens 幂律（主观响度 ∝ 幅值^0.6），
 *   拖动/步进时每档听感变化相同（类似系统音量滑块的体验）。
 * - 内部幅值倍率 g：g = (L/100)^(5/3)；L = 100 · g^0.6。
 *   下限感知 50% = 幅值 0.315（-10dB，用于压低过响的极端素材），默认 100%（1x）；
 *   上限感知 300% = 幅值 6.24x（+16dB）：正常内容无损；仅极端近满刻度素材由压缩器兜底限幅。
 */
class AudioEngine {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.CtxClass = AC;
    this.ctx = null;      // AudioContext
    this.source = null;   // MediaElementAudioSourceNode
    this.gainNode = null;
    this.comp = null;
    this.video = null;    // 当前挂载的 video 元素
    this.boost = 100;     // 感知音量百分比（Loudness），范围 50-300，默认 100
    this.muted = false;
  }

  /**
   * 挂载到指定 video 元素。
   * 同一元素只允许创建一次 MediaElementAudioSourceNode（重复创建会抛异常），
   * 元素被 B 站重建后需重新调用。
   * @returns {boolean} 是否成功挂载
   */
  attach(video) {
    if (!video || video.tagName !== 'VIDEO') return false;
    if (video === this.video && this.source) return true;
    try {
      this.teardown(); // 断开旧挂载，避免多路叠加
      if (!this.ctx) this.ctx = new this.CtxClass();
      this.source = this.ctx.createMediaElementSource(video);
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
      if (this.ctx.state === 'suspended') {
        // 浏览器自动播放策略：等待用户手势后由 resumeOnUserGesture 恢复
        this.ctx.resume().catch(() => {});
      }
      this.apply();
      return true;
    } catch (err) {
      console.warn('[BVBoost] 音频挂载失败', err);
      return false;
    }
  }

  /** 断开音频图（video 恢复原生直通播放，不受任何影响） */
  teardown() {
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
      this.source = null;
    }
    this.comp = null;
    this.gainNode = null;
    this.video = null;
  }

  /** 用户手势时兜底恢复 AudioContext（首次播放/点击页面） */
  resumeOnUserGesture() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** 音频管线是否已挂载（供内容脚本守卫使用；注意 ≠ getState().engaged 的临时属性） */
  get engaged() {
    return !!this.source;
  }

  /**
   * 设置增益百分比。
   * 感知刻度：100 → 幅值 1.0；300 → 幅值 6.24（等感知步进）。
   */
  // 常亮感知下限/上限（Loudness 百分比）：50-300，默认 100
  static get PERC_MIN() { return 50; }   // 50% → 幅值 0.315（-10dB），用于压低过响素材
  static get PERC_MAX() { return 300; }  // 幅值 6.24x（+16dB），正常内容无损，极端素材由压缩器兜底

  /** 设置感知音量百分比（50-300） */
  setBoost(percent) {
    this.boost = Math.max(AudioEngine.PERC_MIN, Math.min(AudioEngine.PERC_MAX, Math.round(percent)));
    this.apply();
  }

  setMuted(m) { this.muted = !!m; this.apply(); }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /** 当前幅值倍率：感知值 → 1..6.24（Stevens 逆幂律，见 ADR-0004） */
  getGainFactor() {
    if (this.muted) return 0;
    const ratio = this.boost / 100;
    return Math.pow(ratio, 5 / 3); // L^0.6 的逆运算
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
      ctxState: this.ctx ? this.ctx.state : 'none'
    };
  }
}

// 兼容多脚本环境：content.js 在 document_idle 时随同加载，window 上注册便于调试
if (typeof window !== 'undefined') {
  window.BVBoostEngineClass = AudioEngine;
}