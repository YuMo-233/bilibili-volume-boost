/**
 * 增益音量条 UI — Shadow DOM 注入，B 站原生音量条风格
 *
 * 设计（用户确认的方向）：
 * - 照搬 B 站音量交互：喇叭按钮 + hover 展开竖直轨道面板，蓝条填充、白点滑块
 * - 位置：紧跟 B 站原生音量按钮之后（"音量旁边"）
 * - 实现：div 自绘轨道 + Pointer Capture，不依赖原生 <input type=range>，
 *   规避 B 站控制栏全局指针事件/ preventDefault 对原生滑块的拦截（拖动失灵修复）
 * - 支持鼠标滚轮微调
 *
 * 公共接口（content.js 依赖，保持不变）：
 *   BoostUI(engine, onBoostChange)
 *   mount(type) / unmount() / isMounted()
 *   _sync() / toast(text)
 */
class BoostUI {
  constructor(engine, onBoostChange) {
    this.engine = engine;
    this.onBoostChange = onBoostChange; // (percent) => void
    this.host = null;
    this.root = null;
    this.track = null;      // 竖直轨道容器
    this.fill = null;       // 蓝色填充条
    this.thumb = null;      // 白色圆点
    this.valEl = null;      // 百分比数值
    this.toastEl = null;
    this._toastTimer = null;
    this._dragId = null;
    this._lastPct = null;
  }

  /** 控制栏注入点（回退序列） */
  static get SLOT_SELECTORS() {
    return {
      video: [
        '.bpx-player-control-bottom .bpx-player-control-bottom-right',
        '.bpx-player-control-bottom .bpx-player-ctrl-right',
        '.bpx-player-control-bottom',
        '.bpx-player-container'
      ],
      live: ['.web-player-controller-wrap .web-player-controller-right', '.web-player-controller-wrap', '.live-player-ctrl-wrap .right']
    };
  }

  /** B 站原生音量按钮（增益条插入其"旁边"） */
  static get ANCHOR_SELECTORS() {
    return {
      video: ['.bpx-player-ctrl-volume'],
      live: ['.web-player-icon-volume', '.webplayer-volume', '.web-player-controller-right [class*="Volume"], .web-player-controller-right [class*="volume"]']
    };
  }

  findSlot(type) {
    const list = BoostUI.SLOT_SELECTORS[type] || [];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  findAnchor(type) {
    const list = BoostUI.ANCHOR_SELECTORS[type] || [];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  isMounted() {
    return this.host && this.host.isConnected;
  }

  /**
   * 位置纠正：B 站播放器初始化时序导致第一次注入时音量按钮可能尚未渲染，
   * 宿主会先落到控制栏末尾。此方法在音量按钮出现后把宿主挪到它"旁边"。
   */
  relocate(type) {
    if (!this.isMounted()) return;
    const anchor = this.findAnchor(type);
    if (!anchor || !anchor.parentNode) return;
    if (this.host.previousElementSibling !== anchor) {
      anchor.parentNode.insertBefore(this.host, anchor.nextSibling);
    }
  }

  mount(type) {
    if (this.isMounted()) return true;
    const slot = this.findSlot(type);
    if (!slot) return false;

    this.host = document.createElement('div');
    this.host.id = 'bv-boost-host';
    this.host.style.cssText = 'all:initial;display:inline-flex;align-items:center;margin-left:2px;position:relative;user-select:none;-webkit-user-select:none;touch-action:none;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = this._template();
    this.track = this.root.querySelector('.bv-track');
    this.fill = this.root.querySelector('.bv-fill');
    this.thumb = this.root.querySelector('.bv-thumb');
    this.valEl = this.root.querySelector('.bv-val');
    this.toastEl = this.root.querySelector('.bv-toast');

    this._bindTrack();

    // 刻度点击直达（500%→100% 五档）
    this.root.querySelectorAll('.bv-scale span').forEach((sp) => {
      sp.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = parseInt(sp.textContent, 10);
        if (!Number.isNaN(val)) this.onBoostChange(val);
      });
    });

    // 插入到 B 站音量按钮旁（其后），否则追加到控制栏容器末尾
    const anchor = this.findAnchor(type);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(this.host, anchor.nextSibling);
    } else {
      slot.appendChild(this.host);
    }

    this._sync();
    return true;
  }

  /** 面板容器（hover/拖动状态互斥管理） */
  _box() {
    return this.root ? this.root.querySelector('.bv-box') : null;
  }

  /**
   * 自绘轨道交互：pointer capture 拖动 + 滚轮微调。
   * 不冒泡给 B 站播放器，规避其全局 mousedown/preventDefault 拦截。
   */
  _bindTrack() {
    // 拖动
    this.track.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._box().classList.add('bv-open'); // 拖动期间锁定展开，防悬停脱靶
      try { this.track.setPointerCapture(e.pointerId); } catch (_) {}
      this._dragId = e.pointerId;
      this._setFromPointer(e);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._dragId) return;
      e.stopPropagation();
      this._setFromPointer(e);
    });
    const release = (e) => {
      if (e.pointerId !== this._dragId) return;
      this._dragId = null;
      this._commit();
      // 松手后恢复 hover 驱动（指针仍在面板内则 CSS :hover 继续显示）
      this._box().classList.remove('bv-open');
    };
    this.track.addEventListener('pointerup', release);
    this.track.addEventListener('pointercancel', release);

    // 滚轮微调（±5）
    this.track.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const next = this.engine.boost + (e.deltaY > 0 ? 5 : -5);
      this.onBoostChange(Math.max(100, Math.min(500, next)));
    }, { passive: false });

    // 面板展开态（鼠标进入时激活；离开时仅非拖动状态下收起）
    this._box().addEventListener('mouseenter', () => {
      this._box().classList.add('bv-open');
    });
    this._box().addEventListener('mouseleave', () => {
      if (this._dragId === null) this._box().classList.remove('bv-open');
    });
  }

  /** 由指针 Y 坐标换算增益百分并实时应用到引擎 */
  _setFromPointer(e) {
    const rect = this.track.getBoundingClientRect();
    const len = rect.height || 1;
    const frac = (rect.bottom - e.clientY) / len; // 顶部=1 对应 500%，底部=0 对应 100%
    this._lastPct = this._posToPercent(Math.max(0, Math.min(1, frac)));
    this._sync();
    this.onBoostChange(this._lastPct);
  }

  /** 松手时确保持久化（连续拖动时持久化由 content.js 防抖承担） */
  _commit() {
    if (this._lastPct != null) {
      this.onBoostChange(this._lastPct);
      this._lastPct = null;
    }
  }

  /** 感知百分比 → 0..1 高度比（等感知线性：100→0、300→1） */
  _fracFromPercent(p) {
    return (p - 100) / 200;
  }

  _posToPercent(frac) {
    return Math.round(100 + frac * 200);
  }

  _sync() {
    if (!this.track) return;
    const frac = this._fracFromPercent(this.engine.boost);
    const muted = this.engine.muted;
    this.fill.style.height = `${(frac * 100).toFixed(1)}%`;
    this.thumb.style.bottom = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
    this.valEl.textContent = muted ? '静音' : `${this.engine.boost}%`;
    this.valEl.classList.toggle('bv-muted', muted);
    this._debugState();
  }

  /** 角标 toast，1.2s 自动消失 */
  toast(text) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('bv-show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('bv-show'), 1200);
  }

  /**
   * 调试通道：把引擎状态同步到宿主元素的 data-bv-state 属性。
   * ISOLATED world 的全局变量页面不可见，但 light DOM 属性共享，便于自动化校验。
   */
  _debugState() {
    if (!this.host) return;
    this.host.setAttribute('data-bv-state', JSON.stringify(this.engine.getState()));
  }

  unmount() {
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.root = null;
      this.track = this.fill = this.thumb = this.valEl = null;
    }
  }

  _template() {
    return `
<style>
  :host { all: initial; }
  /* 增益按钮 — 与 B 站原生 22px 控制按钮对齐 */
  .bv-box {
    display: inline-flex; align-items: center; justify-content: center;
    height: 22px; padding: 0 3px; border-radius: 4px;
    position: relative; cursor: pointer; transition: background .15s;
  }
  .bv-box:hover, .bv-box.bv-open { background: rgba(255,255,255,.14); }
  .bv-btn {
    border: none; background: none; padding: 0; margin: 0;
    width: 18px; height: 18px; display: flex; align-items: center; justify-content: center;
    color: #fff; cursor: pointer; line-height: 0;
  }
  .bv-btn svg { width: 17px; height: 17px; display: block; }
  /* hover 展开的竖直增益面板 */
  .bv-panel {
    display: none; position: absolute; bottom: calc(100% - 2px); left: 50%;
    transform: translateX(-50%);
    flex-direction: column; align-items: center;
    padding: 14px 12px; gap: 8px; border-radius: 10px;
    background: rgba(25,25,30,.96); box-shadow: 0 8px 28px rgba(0,0,0,.5);
    z-index: 2147483646;
  }
  .bv-box:hover .bv-panel, .bv-box.bv-open .bv-panel { display: flex; }
  /* 增益条区域：左侧刻度列 + 右侧轨道 */
  .bv-body {
    display: flex; align-items: center; gap: 8px;
  }
  .bv-scale {
    position: relative; width: 30px; height: 128px;
    font: 10px/1 'Helvetica Neue', 'PingFang SC', Arial, sans-serif;
    color: rgba(255,255,255,.65); user-select: none;
  }
  .bv-scale span {
    position: absolute; left: 0; transform: translateY(50%);
    white-space: nowrap; cursor: pointer;
    padding: 1px 3px; border-radius: 3px;
    transition: color .15s, background .15s;
  }
  .bv-scale span:hover { color: #fff; background: rgba(255,255,255,.16); }
  .bv-track {
    position: relative; width: 4px; height: 128px; border-radius: 3px;
    /* 透明 padding 扩大热区（视觉仍 4px），便于抓取 */
    padding: 0 7px; background-clip: content-box;
    background: rgba(255,255,255,.25); cursor: pointer;
    touch-action: none;
  }
  .bv-fill {
    position: absolute; left: 7px; right: 7px; bottom: 0;
    border-radius: 3px; background: linear-gradient(180deg, #6dc8ff, #00aeec);
    box-shadow: 0 0 6px rgba(0,174,236,.55);
  }
  .bv-thumb {
    position: absolute; left: 50%; width: 12px; height: 12px;
    transform: translate(-50%, 50%); border-radius: 50%;
    background: #fff; border: 2px solid #00aeec;
    box-shadow: 0 1px 4px rgba(0,0,0,.55);
  }
  .bv-val {
    font: 11px/1.2 'Helvetica Neue', 'PingFang SC', Arial, sans-serif;
    color: #fff; white-space: nowrap;
  }
  .bv-val.bv-muted { color: #ff7d7d; }
  .bv-toast {
    opacity: 0; transition: opacity .25s;
    position: fixed; left: 50%; bottom: 14%;
    transform: translateX(-50%);
    padding: 6px 14px; border-radius: 6px;
    background: rgba(0,0,0,.72); color: #fff;
    font: 13px/1.4 'Helvetica Neue', 'PingFang SC', Arial, sans-serif;
    pointer-events: none; z-index: 2147483647;
  }
  .bv-toast.bv-show { opacity: 1; }
</style>
<div class="bv-box">
  <button class="bv-btn" title="音量增益 100%-300%（感知等量刻度，悬停弹出，Alt+↑/↓ 调节，滚轮微调）">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 4V5L7 9H3zm12.4 3a3.4 3.4 0 0 0-1.9-3.05v6.1A3.4 3.4 0 0 0 15.4 12z"/><path d="M14 4.9v2.2a5.4 5.4 0 0 1 0 9.8v2.2a7.6 7.6 0 0 0 0-14.2z"/></svg>
  </button>
  <div class="bv-panel">
    <div class="bv-body">
      <div class="bv-scale">
        <span style="bottom:100%">300%</span>
        <span style="bottom:75%">250%</span>
        <span style="bottom:50%">200%</span>
        <span style="bottom:25%">150%</span>
        <span style="bottom:0">100%</span>
      </div>
      <div class="bv-track"><span class="bv-fill"></span><span class="bv-thumb"></span></div>
    </div>
    <span class="bv-val">100%</span>
  </div>
</div>
<div class="bv-toast"></div>`;
  }
}

if (typeof window !== 'undefined') {
  window.BVBoostUI = BoostUI;
}