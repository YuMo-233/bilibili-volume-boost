/**
 * 音频增益引擎 — 页面内 Web Audio 管线
 *
 * video → MediaElementAudioSourceNode → Gain(增益) → DynamicsCompressor(限幅) → destination
 *
 * 设计约束（见 docs/adr/0001）：
 * - 不捕获标签页音频（不用 tabCapture），不会触发 Chrome 的"扩展操纵音频则禁全屏"机制，
 *   从而完整保留 B 站原生沉浸全屏。
 * - 不修改 video.volume（分层音量模型，见 docs/adr/0002）：B 站原生滑块管 0-100%，
 *   本引擎只负责 100%-500% 的增益轨道。最终响度 = 原生音量 × 增益。
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
    this.boost = 100;     // 增益百分比 100-500
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

  /**
   * 设置增益百分比。
   * 100% → 增益 1.0；500% → 增益 5.0；对数刻度（越往大越细）。
   */
  setBoost(percent) {
    this.boost = Math.max(100, Math.min(500, Math.round(percent)));
    this.apply();
  }

  setMuted(m) { this.muted = !!m; this.apply(); }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /** 当前增益数值乘子 */
  getGainFactor() {
    if (this.muted) return 0;
    return Math.exp(Math.log(5) * (this.boost - 100) / 400); // 1 → 5 指数映射
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