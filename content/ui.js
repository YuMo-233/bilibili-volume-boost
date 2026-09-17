/**
 * 悬浮滑块 UI — Shadow DOM 注入播放器控制栏
 *
 * - Shadow DOM 隔离样式，不污染 B 站页面也不被其样式覆盖
 * - 滑块为"增益轨道"（100%-500% 对数刻度），与 B 站原生音量滑块并列显示
 * - 提供：增益滑块、百分比徽标、静音按钮；音量变化时弹出 toast
 */
class BoostUI {
  constructor(engine, onBoostChange, onMuteChange) {
    this.engine = engine;
    this.onBoostChange = onBoostChange; // (percent) => void
    this.onMuteChange = onMuteChange;   // (muted) => void
    this.host = null;
    this.root = null;
    this.slider = null;
    this.badge = null;
    this.muteBtn = null;
    this.toastEl = null;
    this._toastTimer = null;
  }

  /** 各播放器类型的控制栏注入点（有回退） */
  static get SLOT_SELECTORS() {
    return {
      video: [
        '.bpx-player-control-bottom .bpx-player-ctrl-right',
        '.bpx-player-control-bottom .bpx-player-control',
        '.bpx-player-control-bottom',
        '.bpx-player-container .bpx-player-control'
      ],
      live: [
        '.web-player-controller-wrap .web-player-controller-right',
        '.web-player-controller-wrap',
        '.live-player-ctrl-wrap .right',
        '.player-controller-wrap .right-part'
      ]
    };
  }

  /** 在指定类型播放器中查找注入点，未找到返回 null */
  findSlot(type) {
    const list = BoostUI.SLOT_SELECTORS[type] || [];
    for (const sel of list) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** 已注入且宿主仍在文档中？ */
  isMounted() {
    return this.host && this.host.isConnected;
  }

  mount(type) {
    if (this.isMounted()) return true;
    const slot = this.findSlot(type);
    if (!slot) return false;

    this.host = document.createElement('div');
    this.host.id = 'bv-boost-host';
    this.host.style.cssText += ';all:initial;display:inline-flex;align-items:center;margin-left:12px;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = this._template();
    this.slider = this.root.querySelector('.bv-slider');
    this.badge = this.root.querySelector('.bv-badge');
    this.muteBtn = this.root.querySelector('.bv-mute');
    this.toastEl = this.root.querySelector('.bv-toast');

    this.slider.addEventListener('input', () => {
      const percent = Number(this.slider.value);
      this._sync();
      this.onBoostChange(percent);
    });

    this.muteBtn.addEventListener('click', () => {
      const muted = this.engine.toggleMute();
      this._sync();
      this.onMuteChange(muted);
    });

    // 半透明层：hovers 时滑块区域显示
    this.root.querySelector('.bv-wrap').addEventListener('mouseenter', () => {
      this.root.querySelector('.bv-wrap').classList.add('bv-hover');
    });
    this.root.querySelector('.bv-wrap').addEventListener('mouseleave', () => {
      this.root.querySelector('.bv-wrap').classList.remove('bv-hover');
    });

    slot.appendChild(this.host);
    this._sync();
    return true;
  }

  unmount() {
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.root = null;
      this.slider = null;
      this.badge = null;
      this.muteBtn = null;
    }
  }

  /** 滑块将百分比(100-500)映射到对数坐标轴 0-100，反之亦然 */
  _percentToPos(p) {
    const x = (p - 100) / 400; // 0..1
    return Math.round(100 * Math.sqrt(x)); // 平方根曲线：低段更宽
  }

  _posToPercent(pos) {
    const x = (pos / 100) ** 2;
    return Math.round(100 + x * 400);
  }

  _sync() {
    if (!this.slider) return;
    this.slider.value = String(this._percentToPos(this.engine.boost));
    this.badge.textContent = `${this.engine.muted ? '静音' : (this.engine.boost + '%')}`;
    this.badge.classList.toggle('bv-muted', this.engine.muted);
    this.muteBtn.classList.toggle('bv-active', this.engine.muted);
  }

  /** 角标 toast，1.2s 自动消失 */
  toast(text) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.add('bv-show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.remove('bv-show'), 1200);
  }

  _template() {
    return `
<style>
  :host { all: initial; }
  .bv-wrap {
    display: inline-flex; align-items: center; gap: 4px;
    height: 36px; padding: 0 8px; border-radius: 6px;
    background: transparent; transition: background .2s;
    user-select: none;
  }
  .bv-wrap.bv-hover { background: rgba(0,0,0,.35); }
  .bv-slider {
    -webkit-appearance: none; appearance: none;
    width: 74px; height: 4px; border-radius: 2px;
    background: linear-gradient(90deg, #57b6ff, #2fa9ff);
    outline: none; cursor: pointer;
  }
  .bv-slider::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 12px; height: 12px; border-radius: 50%;
    background: #fff; box-shadow: 0 0 4px rgba(0,0,0,.5);
    cursor: pointer;
  }
  .bv-slider::-moz-range-thumb {
    width: 12px; height: 12px; border: none; border-radius: 50%;
    background: #fff; cursor: pointer;
  }
  .bv-badge {
    min-width: 38px; text-align: center;
    font: 12px/1.2 'Helvetica Neue', Arial, sans-serif; color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,.6);
  }
  .bv-badge.bv-muted { color: #ff7d7d; }
  .bv-mute {
    border: none; background: none; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 4px;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.6));
  }
  .bv-mute.bv-active { filter: drop-shadow(0 0 3px #ff7d7d); }
  .bv-toast {
    opacity: 0; transition: opacity .25s;
    position: fixed; left: 50%; bottom: 14%;
    transform: translateX(-50%);
    padding: 6px 14px; border-radius: 6px;
    background: rgba(0,0,0,.72); color: #fff;
    font: 13px/1.4 'Helvetica Neue', Arial, sans-serif;
    pointer-events: none; z-index: 2147483647;
  }
  .bv-toast.bv-show { opacity: 1; }
</style>
<div class="bv-wrap">
  <button class="bv-mute" title="静音切换 (Alt+M)">🔇</button>
  <input class="bv-slider" type="range" min="0" max="100" step="2" title="音量增益 (Alt+↑/↓)">
  <span class="bv-badge">100%</span>
</div>
<div class="bv-toast"></div>`;
  }
}

if (typeof window !== 'undefined') {
  window.BVBoostUI = BoostUI;
}