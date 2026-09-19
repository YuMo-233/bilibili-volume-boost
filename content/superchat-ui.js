/**
 * 醒目留言浮层 — Shadow DOM 注入，B 站 SC 配色复刻
 *
 * 设计（见 docs/adr/0005）：
 * - 注入点：播放器列内的 .live-player-mounter（与 <video> 同级，全屏时随全屏元素一起渲染）
 * - 定位：绝对定位贴播放器四角，位置由 popup 配置（默认右上）
 * - 卡片配色取自接口下发的 background_color / background_bottom_color /
 *   background_price_color，不硬编码价格色阶
 * - 叠放：价格降序，最多 3 条，超出折叠为 "+N 条"
 *
 * 公共接口（content.js 依赖）：
 *   BoostSuperChatOverlay(onClose) / mount() / unmount() / isMounted()
 *   setPosition(pos) / render(items, max) / show() / hide() / isShowing()
 */
class SuperChatOverlay {
  /** 注入点回退序列（B 站改版时逐级退化） */
  static get SLOT_SELECTORS() {
    return ['.live-player-mounter', '.live-player-ctnr', '.player-section'];
  }

  /** 四角位置 */
  static get POSITIONS() {
    return {
      'top-left': { top: '14px', left: '14px' },
      'top-right': { top: '14px', right: '14px' },
      'bottom-left': { bottom: '70px', left: '14px' },
      'bottom-right': { bottom: '70px', right: '14px' }
    };
  }

  /** 叠放上限（超出折叠为 "+N 条"） */
  static get MAX_CARDS() {
    return 3;
  }

  constructor(onClose) {
    this.onClose = onClose || (() => {});
    this.host = null;
    this.root = null;
    this.wrap = null;
    this.position = 'top-right';
    this._items = [];
    this._shown = false;
    this._timer = null;
  }

  isMounted() {
    return !!(this.host && this.host.isConnected);
  }

  isShowing() {
    return this._shown;
  }

  mount() {
    if (this.isMounted()) return true;
    let slot = null;
    for (const sel of SuperChatOverlay.SLOT_SELECTORS) {
      slot = document.querySelector(sel);
      if (slot) break;
    }
    if (!slot) return false;

    this.host = document.createElement('div');
    this.host.id = 'bv-sc-host';
    // all:initial 先置零，再声明自身样式（顺序不可颠倒）
    this.host.style.cssText =
      'all:initial;position:absolute;z-index:2147483000;pointer-events:none;display:none;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = SuperChatOverlay.TEMPLATE;
    this.wrap = this.root.querySelector('.bv-sc-wrap');
    this._applyPosition();
    slot.appendChild(this.host);
    return true;
  }

  unmount() {
    this._stopTick();
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.root = null;
      this.wrap = null;
    }
    this._shown = false;
  }

  setPosition(pos) {
    this.position = SuperChatOverlay.POSITIONS[pos] ? pos : 'top-right';
    if (this.host) this._applyPosition();
  }

  _applyPosition() {
    const p = SuperChatOverlay.POSITIONS[this.position];
    this.host.style.top = p.top || 'auto';
    this.host.style.left = p.left || 'auto';
    this.host.style.right = p.right || 'auto';
    this.host.style.bottom = p.bottom || 'auto';
  }

  show() {
    if (!this.isMounted()) return;
    this.host.style.display = 'block';
    this._shown = true;
    this._startTick();
  }

  hide() {
    if (!this.isMounted()) return;
    this.host.style.display = 'none';
    this._shown = false;
    this._stopTick();
  }

  /** 渲染列表（调用方已按价格降序），最多 max 条，超出折叠 */
  render(items) {
    if (!this.wrap) return;
    const max = SuperChatOverlay.MAX_CARDS;
    this._items = items.slice(0, max);
    const wrap = this.wrap;
    wrap.textContent = '';

    for (const it of this._items) {
      wrap.appendChild(this._buildCard(it));
    }
    if (items.length > max) {
      const more = document.createElement('div');
      more.className = 'bv-sc-more';
      more.textContent = `+${items.length - max} 条`;
      wrap.appendChild(more);
    }
    this._tick();
  }

  _buildCard(it) {
    const card = document.createElement('div');
    card.className = 'bv-sc-card';
    card.dataset.id = it.id;
    card.style.background = this._cardBg(it);
    if (it.fontColor) card.style.color = it.fontColor;

    const hd = document.createElement('div');
    hd.className = 'bv-sc-hd';

    const face = document.createElement('img');
    face.className = 'bv-sc-face';
    face.alt = '';
    if (it.face) face.src = it.face;
    hd.appendChild(face);

    const name = document.createElement('span');
    name.className = 'bv-sc-name';
    name.textContent = it.uname || '匿名';
    name.title = it.uname || '';
    hd.appendChild(name);

    const price = document.createElement('span');
    price.className = 'bv-sc-price';
    price.textContent = `¥${it.price}`;
    if (it.bgPriceColor) price.style.background = it.bgPriceColor;
    hd.appendChild(price);

    const cls = document.createElement('button');
    cls.className = 'bv-sc-cls';
    cls.type = 'button';
    cls.title = '关闭本条醒目留言';
    cls.textContent = '×';
    cls.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.onClose(it.id);
    });
    hd.appendChild(cls);

    card.appendChild(hd);

    const msg = document.createElement('div');
    msg.className = 'bv-sc-msg';
    msg.textContent = it.message || '';   // textContent 防注入
    card.appendChild(msg);

    const bar = document.createElement('div');
    bar.className = 'bv-sc-bar';
    const fill = document.createElement('i');
    bar.appendChild(fill);
    card.appendChild(bar);

    return card;
  }

  /** 卡片底色：顶部叠一层浅色（background_color）晕染，主体用饱和色（background_bottom_color） */
  _cardBg(it) {
    const light = it.bgColor || 'transparent';
    const deep = it.bgBottomColor || '#E54D4D';
    return `linear-gradient(180deg, ${light} 0%, ${light}66 14%, ${deep} 38%, ${deep} 100%)`;
  }

  /** 每秒刷新剩余时间进度条，并移除已过期的卡片 */
  _startTick() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 1000);
  }

  _stopTick() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    if (!this.wrap) return;
    const now = Date.now() / 1000;
    let alive = 0;
    this.wrap.querySelectorAll('.bv-sc-card').forEach((card) => {
      const it = this._items.find((x) => x.id === card.dataset.id);
      if (!it) return;
      const total = it.endTime - it.startTime;
      if (!total || it.endTime <= now) {
        card.remove();
        return;
      }
      alive++;
      const fill = card.querySelector('.bv-sc-bar > i');
      if (fill) {
        const ratio = Math.max(0, Math.min(1, (it.endTime - now) / total));
        fill.style.width = `${(ratio * 100).toFixed(1)}%`;
      }
    });
    // 卡片全部过期后连同折叠提示一起清空，避免留下空壳
    if (alive === 0 && this._items.length > 0) {
      this._items = [];
      this.wrap.textContent = '';
    }
  }

  static get TEMPLATE() {
    return `
<style>
  :host { all: initial; }
  .bv-sc-wrap {
    display: flex; flex-direction: column; gap: 8px;
    width: 320px; max-width: 32vw;
    font: 13px/1.45 'Helvetica Neue', 'PingFang SC', Arial, sans-serif;
  }
  .bv-sc-card {
    position: relative; border-radius: 8px; overflow: hidden;
    padding: 8px 10px 12px;
    color: #fff; pointer-events: auto;
    box-shadow: 0 6px 20px rgba(0,0,0,.42);
    border: 1px solid rgba(255,255,255,.22);
    text-shadow: 0 1px 2px rgba(0,0,0,.35);
  }
  .bv-sc-hd { display: flex; align-items: center; gap: 6px; }
  .bv-sc-face {
    width: 22px; height: 22px; border-radius: 50%;
    flex: none; object-fit: cover; background: rgba(255,255,255,.28);
  }
  .bv-sc-name {
    flex: 1 1 auto; min-width: 0;
    font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .bv-sc-price {
    flex: none; padding: 1px 7px; border-radius: 9px;
    background: rgba(0,0,0,.22);
    font-weight: 700; font-size: 12px;
  }
  .bv-sc-cls {
    flex: none; width: 18px; height: 18px; padding: 0; margin-left: 2px;
    border: none; border-radius: 50%; cursor: pointer;
    background: rgba(0,0,0,.3); color: #fff;
    font: 13px/1 Arial, sans-serif; text-align: center;
    opacity: 0; transition: opacity .15s, background .15s;
  }
  .bv-sc-card:hover .bv-sc-cls { opacity: 1; }
  .bv-sc-cls:hover { background: rgba(0,0,0,.62); }
  .bv-sc-msg {
    margin-top: 5px; font-size: 13px;
    word-break: break-word; white-space: pre-wrap;
    max-height: 5.4em; overflow: hidden;
  }
  .bv-sc-bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: rgba(0,0,0,.24);
  }
  .bv-sc-bar > i {
    display: block; height: 100%; width: 100%;
    background: rgba(255,255,255,.85);
  }
  .bv-sc-more {
    align-self: flex-end;
    padding: 2px 9px; border-radius: 10px;
    background: rgba(0,0,0,.6); color: #fff;
    font-size: 12px; pointer-events: none;
  }
</style>
<div class="bv-sc-wrap"></div>`;
  }
}

if (typeof window !== 'undefined') {
  window.BVSuperChatOverlay = SuperChatOverlay;
}
