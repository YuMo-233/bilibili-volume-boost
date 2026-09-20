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
 * 渲染策略（见 docs/adr/0007）：
 * - 增量渲染：按 id 复用卡片节点，只有真正新增的卡片播放入场动画，
 *   离开列表的卡片先播退场动画再移除；不做整表重建（否则每轮轮询都会重播动画）
 * - 进度条用 requestAnimationFrame 逐帧插值，而不是每秒跳一格
 * - 出入场同时折叠/展开卡片高度，避免相邻卡片瞬跳
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

  /** 出入场动画时长（与 CSS 中的过渡保持一致） */
  static get ANIM_MS() {
    return 260;
  }

  constructor(onClose) {
    this.onClose = onClose || (() => {});
    this.host = null;
    this.root = null;
    this.wrap = null;
    this.position = 'top-right';
    this._cards = new Map();   // id -> { wrap, card, fill, data, pct }
    this._moreEl = null;
    this._shown = false;
    this._raf = null;
    this._lastSweep = 0;
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
    this._cards.clear();
    this._moreEl = null;
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

  /**
   * 增量渲染（调用方已按价格降序）。
   * 只有真正新增的卡片播放入场动画，离开列表的卡片先播退场动画再移除；
   * 已有卡片原地更新，不重建、不移动，避免动画被反复重播。
   */
  render(items) {
    if (!this.wrap) return;
    const max = SuperChatOverlay.MAX_CARDS;
    const top = items.slice(0, max);
    const keep = new Set(top.map((it) => it.id));

    // 1) 退场：不在本次列表中的已渲染卡片（悬挂结束 / 被删除 / 被挤出上限）
    for (const [id, rec] of Array.from(this._cards)) {
      if (keep.has(id)) continue;
      this._cards.delete(id);
      this._leave(rec.wrap);
    }

    // 2) 入场与更新：按列表顺序保证 DOM 顺序，且不移动已有卡片
    let prevWrap = null;
    for (const it of top) {
      let rec = this._cards.get(it.id);
      if (!rec) {
        rec = this._buildItem(it);
        this._cards.set(it.id, rec);
        this._enter(rec.wrap, prevWrap);
      } else {
        this._update(rec, it);
        this._reposition(rec.wrap, prevWrap);
      }
      prevWrap = rec.wrap;
    }

    // 3) 折叠提示始终置于末尾
    this._renderMore(items.length - max);
    this._tick();
  }

  /** 创建卡片（含承载它的可折叠外层） */
  _buildItem(it) {
    const wrap = document.createElement('div');
    wrap.className = 'bv-sc-item';

    const card = document.createElement('div');
    card.className = 'bv-sc-card';
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
    fill.style.width = '0%';
    bar.appendChild(fill);
    card.appendChild(bar);

    wrap.appendChild(card);
    return { wrap, card, fill, data: it, pct: -1 };
  }

  /** 已有卡片只更新会变的字段（配色、头像、价格、留言） */
  _update(rec, it) {
    if (it.bgBottomColor !== rec.data.bgBottomColor || it.bgColor !== rec.data.bgColor) {
      rec.card.style.background = this._cardBg(it);
    }
    if (it.fontColor !== rec.data.fontColor) rec.card.style.color = it.fontColor || '';
    if (it.face !== rec.data.face && it.face) {
      const img = rec.card.querySelector('.bv-sc-face');
      if (img) img.src = it.face;
    }
    if (it.price !== rec.data.price) {
      const price = rec.card.querySelector('.bv-sc-price');
      if (price) price.textContent = `¥${it.price}`;
    }
    if (it.uname !== rec.data.uname) {
      const name = rec.card.querySelector('.bv-sc-name');
      if (name) {
        name.textContent = it.uname || '匿名';
        name.title = it.uname || '';
      }
    }
    rec.data = it;
  }

  /** 保证卡片位于 prevWrap 之后（仅移动需要移动的节点，不动已有卡片） */
  _reposition(wrap, prevWrap) {
    const anchor = prevWrap ? prevWrap.nextSibling : this.wrap.firstChild;
    if (wrap !== anchor && wrap !== prevWrap) this.wrap.insertBefore(wrap, anchor);
  }

  /** 入场：高度 0 → 自然高度，卡片淡入上浮 */
  _enter(wrap, prevWrap) {
    wrap.classList.add('bv-anim', 'bv-enter');
    wrap.style.height = '0px';
    this._reposition(wrap, prevWrap);

    const h = this._naturalHeight(wrap);
    wrap.getBoundingClientRect();          // 强制回流，确立 0 起点
    requestAnimationFrame(() => {
      if (wrap.isConnected) wrap.style.height = `${h}px`;
    });
    setTimeout(() => {
      wrap.classList.remove('bv-enter', 'bv-anim');
      if (wrap.isConnected) wrap.style.height = '';
    }, SuperChatOverlay.ANIM_MS);
  }

  /** 退场：高度 → 0，卡片淡出上浮，动画结束后移除 */
  _leave(wrap) {
    if (!wrap || wrap._leaving) return;
    wrap._leaving = true;
    const h = wrap.offsetHeight;
    wrap.style.height = `${h}px`;
    wrap.getBoundingClientRect();          // 强制回流，确立起始高度
    wrap.classList.add('bv-anim', 'bv-leave');
    wrap.style.height = '0px';
    setTimeout(() => wrap.remove(), SuperChatOverlay.ANIM_MS);
  }

  /** 量取自然高度：先置 auto 再还原，同一任务内完成不会闪 */
  _naturalHeight(wrap) {
    const prev = wrap.style.height;
    wrap.style.height = 'auto';
    const h = wrap.offsetHeight;
    wrap.style.height = prev;
    return h;
  }

  /** 折叠提示：始终位于末尾，无多余项时移除 */
  _renderMore(n) {
    if (n > 0) {
      if (!this._moreEl) {
        this._moreEl = document.createElement('div');
        this._moreEl.className = 'bv-sc-more';
        this.wrap.appendChild(this._moreEl);
      }
      const text = `+${n} 条`;
      if (this._moreEl.textContent !== text) this._moreEl.textContent = text;
      if (this.wrap.lastElementChild !== this._moreEl) this.wrap.appendChild(this._moreEl);
    } else if (this._moreEl) {
      this._moreEl.remove();
      this._moreEl = null;
    }
  }

  /** 卡片底色：顶部叠一层浅色（background_color）晕染，主体用饱和色（background_bottom_color） */
  _cardBg(it) {
    const light = it.bgColor || 'transparent';
    const deep = it.bgBottomColor || '#E54D4D';
    return `linear-gradient(180deg, ${light} 0%, ${light}66 14%, ${deep} 38%, ${deep} 100%)`;
  }

  /** 逐帧插值：进度条平滑推进，而非每秒跳一格 */
  _startTick() {
    if (this._raf) return;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this._tick();
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopTick() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  _tick() {
    if (!this.wrap) return;
    const now = Date.now() / 1000;

    for (const rec of this._cards.values()) {
      const it = rec.data;
      const total = it.endTime - it.startTime;
      if (!rec.fill || !total) continue;
      const ratio = Math.max(0, Math.min(1, (it.endTime - now) / total));
      const pct = ratio * 100;
      // 变化不足 0.05% 不写样式，省掉无意义的逐帧重排
      if (Math.abs(pct - rec.pct) < 0.05) continue;
      rec.pct = pct;
      rec.fill.style.width = `${pct.toFixed(2)}%`;
    }

    // 过期清扫每秒至多一次，让悬挂到点的卡片及时播退场动画
    if (now - this._lastSweep >= 1) {
      this._lastSweep = now;
      for (const [id, rec] of Array.from(this._cards)) {
        if (rec.data.endTime && rec.data.endTime <= now) {
          this._cards.delete(id);
          this._leave(rec.wrap);
        }
      }
    }
  }

  static get TEMPLATE() {
    return `
<style>
  :host { all: initial; }
  .bv-sc-wrap {
    display: flex; flex-direction: column;
    width: 320px; max-width: 32vw;
    /* 末项的下内边距由负外边距吸收，等价于 gap:8px 但可随折叠动画归零 */
    margin-bottom: -8px;
    font: 13px/1.45 'Helvetica Neue', 'PingFang SC', Arial, sans-serif;
  }
  /* 卡片承载层：出入场时折叠/展开自身高度，避免相邻卡片瞬跳 */
  .bv-sc-item {
    box-sizing: border-box; padding-bottom: 8px;
    transition: height .26s cubic-bezier(.22,.7,.3,1);
  }
  .bv-sc-item.bv-anim { overflow: hidden; }
  .bv-sc-card {
    position: relative; border-radius: 8px; overflow: hidden;
    padding: 8px 10px 12px;
    color: #fff; pointer-events: auto;
    box-shadow: 0 6px 20px rgba(0,0,0,.42);
    border: 1px solid rgba(255,255,255,.22);
    text-shadow: 0 1px 2px rgba(0,0,0,.35);
  }
  .bv-sc-item.bv-enter .bv-sc-card { animation: bv-sc-in .26s cubic-bezier(.22,.7,.3,1) both; }
  .bv-sc-item.bv-leave .bv-sc-card { animation: bv-sc-out .26s ease both; }
  @keyframes bv-sc-in {
    from { opacity: 0; transform: translateY(-8px) scale(.97); }
    to   { opacity: 1; transform: none; }
  }
  @keyframes bv-sc-out {
    from { opacity: 1; transform: none; }
    to   { opacity: 0; transform: translateY(-8px) scale(.97); }
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
    display: block; height: 100%;
    background: rgba(255,255,255,.85);
  }
  .bv-sc-more {
    align-self: flex-end;
    /* 用外边距而非内边距：该元素不参与折叠动画，末项留白由 wrap 的负外边距吸收 */
    margin-bottom: 8px;
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
