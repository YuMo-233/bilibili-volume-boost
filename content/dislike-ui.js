/**
 * 相关推荐「不感兴趣」卡片 UI — Shadow DOM 注入，逐项复刻 B 站原生组件
 *
 * 样式基线全部来自真机采集（computed style），见 docs/adr/0008：
 * - ⋮ 按钮：18×18 三点图标，色 rgb(167,160,148)，圆角 4px，透明底
 * - 弹出菜单：底色 rgb(24,26,27)，圆角 12px，上下内边距 12px；项高 40px、
 *   字号 14px、文字色 rgb(167,160,148)、左右内边距 12px、文字居中；悬停底色 rgb(31,34,35)
 * - 撤销浮层：底色 rgba(24,26,27,.4)，圆角 6px；皱眉图标 36px 色 rgb(232,230,227)，
 *   标题 14px、说明 12px；「撤销」按钮底色 rgba(24,26,27,.2)、圆角 6px、
 *   内边距 6px 12px、字号 13px、色 rgb(232,230,227)，带 24px 回退箭头
 *
 * 交互（与原生一致）：鼠标移到 ⋮ 上弹出菜单 → 点击条目即上报 → 卡片原位覆盖撤销浮层。
 * 浮层覆盖在原卡片位置而非移除卡片，因此不产生列表跳动（见 ADR-0008）。
 *
 * 公共接口（dislike.js 依赖）：
 *   new DislikeCardUI(card, info, { onReport, onCancel })
 *   mount() / unmount() / markReported(reasonId) / clearReported() / toast(text)
 */
class DislikeCardUI {
  /** 原生 ⋮ 三点图标（18×18，viewBox 0 0 24 24） */
  static get DOTS_PATH() {
    return 'M13.62335 5.49835C13.62335 6.3949 12.8966 7.12171 12 7.12171C11.10345 7.12171 10.37665 6.3949 10.37665 5.49835C10.37665 4.6018 11.10345 3.875 12 3.875C12.8966 3.875 13.62335 4.6018 13.62335 5.49835zM13.62345 18.4985C13.62345 19.3951 12.8966 20.12195 12 20.12195C11.10335 20.12195 10.3765 19.3951 10.3765 18.4985C10.3765 17.60185 11.10335 16.875 12 16.875C12.8966 16.875 13.62345 17.60185 13.62345 18.4985zM12 13.62485C12.89745 13.62485 13.62495 12.89735 13.62495 11.99995C13.62495 11.1025 12.89745 10.375 12 10.375C11.10255 10.375 10.37505 11.1025 10.37505 11.99995C10.37505 12.89735 11.10255 13.62485 12 13.62485z';
  }

  /** 原生撤销浮层皱眉图标（36×36，viewBox 0 0 36 36） */
  static get FROWN_PATH() {
    return 'M3 18C3 9.715724999999999 9.715724999999999 3 18 3C26.284274999999997 3 33 9.715724999999999 33 18C33 26.284274999999997 26.284274999999997 33 18 33C9.715724999999999 33 3 26.284274999999997 3 18zM12.796710000000001 12.694004999999999C12.358049999999999 12.253995 11.645745 12.2529 11.205735 12.691575C10.765709999999999 13.130234999999999 10.764615 13.842555 11.20329 14.282565000000002L13.41144 16.494975L11.20329 18.7074C10.764615 19.147350000000003 10.765709999999999 19.8597 11.205735 20.298375C11.645745 20.73705 12.358049999999999 20.735925 12.796710000000001 20.295975L15.2682 17.81895C15.99795 17.087175000000002 15.99795 15.902775000000002 15.2682 15.17097L12.796710000000001 12.694004999999999zM24.794325 12.691575C24.354300000000002 12.2529 23.64195 12.253995 23.203274999999998 12.694004999999999L20.7318 15.17097C20.00205 15.902775000000002 20.00205 17.087175000000002 20.7318 17.81895L23.203274999999998 20.295975C23.64195 20.735925 24.354300000000002 20.73705 24.794325 20.298375C25.234274999999997 19.8597 25.2354 19.147350000000003 24.796725000000002 18.7074L22.588575 16.494975L24.796725000000002 14.282565000000002C25.2354 13.842555 25.234274999999997 13.130234999999999 24.794325 12.691575zM15.900974999999999 24.68535C16.843875 23.425575000000002 17.722649999999998 23.257199999999997 18 23.257199999999997C18.277350000000002 23.257199999999997 19.15605 23.425575000000002 20.099025 24.68535C20.471024999999997 25.182975 21.176025 25.284675 21.67365 24.912675C22.171274999999998 24.540599999999998 22.273049999999998 23.8356 21.900975 23.33805C20.5938 21.591 19.082024999999998 21.007199999999997 18 21.007199999999997C16.917900000000003 21.007199999999997 15.406125 21.591 14.09898 23.33805C13.72692 23.8356 13.82871 24.540599999999998 14.326305 24.912675C14.823929999999999 25.284675 15.5289 25.182975 15.900974999999999 24.68535z';
  }

  /** 原生「撤销」回退箭头（24×24，viewBox 0 0 24 24，两条路径） */
  static get REVERT_PATHS() {
    return [
      'M8.28032 2.46967C8.57321 2.76257 8.57321 3.23744 8.28032 3.53033L4.81065 7L8.28032 10.46965C8.57321 10.76255 8.57321 11.23745 8.28032 11.53035C7.98743 11.8232 7.51254 11.8232 7.21966 11.53035L3.57321 7.88389C3.08505 7.39573 3.08505 6.60428 3.57321 6.11612L7.21966 2.46967C7.51254 2.17678 7.98743 2.17678 8.28032 2.46967z',
      'M3.75 7C3.75 6.58579 4.08579 6.25 4.5 6.25L14.25 6.25C17.97795 6.25 21 9.27208 21 13C21 16.72795 17.97795 19.75 14.25 19.75L7.5 19.75C7.08579 19.75 6.75 19.4142 6.75 19C6.75 18.5858 7.08579 18.25 7.5 18.25L14.25 18.25C17.1495 18.25 19.5 15.8995 19.5 13C19.5 10.10052 17.1495 7.75 14.25 7.75L4.5 7.75C4.08579 7.75 3.75 7.41421 3.75 7z'
    ];
  }

  /** 菜单条目：文案 + 对应原生 reason_id（1=这个内容，4=UP主） */
  static get ITEMS() {
    return [
      { reasonId: 1, label: '内容不感兴趣', title: '内容不感兴趣' },
      { reasonId: 4, label: '不想看此UP主', title: '不想看此UP主' }
    ];
  }

  /** 菜单隐藏延迟：留出从 ⋮ 移到菜单的时间（原生 popover 同样不立即收起） */
  static get HIDE_DELAY() { return 180; }

  constructor(card, info, handlers) {
    this.card = card;
    this.info = info;                                     // { bvid, aid, upMid, upName }
    this.onReport = handlers.onReport;                     // (reasonId) => Promise<boolean>
    this.onCancel = handlers.onCancel;                     // () => Promise<boolean>
    this.host = null;
    this.root = null;
    this._menu = null;
    this._overlay = null;
    this._toastEl = null;
    this._hideTimer = null;
    this._toastTimer = null;
    this._reported = null;                                 // null | reasonId
  }

  isMounted() {
    return !!(this.host && this.host.isConnected);
  }

  mount() {
    if (this.isMounted()) return true;
    // 宿主覆盖整张卡片，自身不拦指针；需要交互的子元素单独开启
    this.host = document.createElement('div');
    this.host.className = 'bv-dl-host';
    this.host.style.cssText =
      'all:initial;position:absolute;top:0;left:0;right:0;bottom:0;' +
      'z-index:2147482000;pointer-events:none;overflow:visible;';
    this.root = this.host.attachShadow({ mode: 'closed' });
    this.root.innerHTML = DislikeCardUI.TEMPLATE;

    this._menu = this.root.querySelector('.bv-dl-menu');
    this._overlay = this.root.querySelector('.bv-dl-overlay');
    this._toastEl = this.root.querySelector('.bv-dl-toast');

    // 卡片需成为定位上下文（原生卡片是 static，位置由图片容器撑开）
    if (getComputedStyle(this.card).position === 'static') {
      this.card.style.position = 'relative';
    }

    this._bind();
    this.card.appendChild(this.host);
    return true;
  }

  unmount() {
    clearTimeout(this._hideTimer);
    clearTimeout(this._toastTimer);
    if (this.host) {
      this.host.remove();
      this.host = null;
      this.root = null;
      this._menu = null;
      this._overlay = null;
      this._toastEl = null;
    }
    this._reported = null;
  }

  /** 交互绑定：hover 展开菜单、点击条目上报、撤销回退 */
  _bind() {
    const pop = this.root.querySelector('.bv-dl-pop');
    const items = this.root.querySelectorAll('.bv-dl-item');

    pop.addEventListener('mouseenter', () => {
      clearTimeout(this._hideTimer);
      if (this._reported === null) this._menu.classList.add('bv-show');
    });
    pop.addEventListener('mouseleave', () => {
      // 延迟收起：鼠标从 ⋮ 移向菜单的途中不闪断
      this._hideTimer = setTimeout(() => this._menu.classList.remove('bv-show'), DislikeCardUI.HIDE_DELAY);
    });

    items.forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const reasonId = Number(el.dataset.reason);
        if (this._reported !== null) return;
        this._menu.classList.remove('bv-show');
        const ok = await this.onReport(reasonId);
        if (ok) this.markReported(reasonId);
        else this.toast('操作失败，请稍后重试');
      });
      // 卡片本身是链接，需阻断冒泡避免误跳转
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    const revert = this.root.querySelector('.bv-dl-revert');
    revert.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const ok = await this.onCancel(this._reported);
      if (ok) this.clearReported();
      else this.toast('撤销失败，请稍后重试');
    });
    revert.addEventListener('pointerdown', (e) => e.stopPropagation());

    // ⋮ 与菜单都需拦截卡片跳转
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this._overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** 展示已上报浮层（覆盖卡片原位，不移动列表） */
  markReported(reasonId) {
    this._reported = reasonId;
    const item = DislikeCardUI.ITEMS.find((it) => it.reasonId === reasonId);
    const title = this.root.querySelector('.bv-dl-ov-title');
    if (title) title.textContent = item ? item.title : '内容不感兴趣';
    this._menu.classList.remove('bv-show');
    this._overlay.classList.add('bv-show');
  }

  /** 撤销后隐藏浮层，卡片恢复原状 */
  clearReported() {
    this._reported = null;
    this._overlay.classList.remove('bv-show');
  }

  toast(text) {
    if (!this._toastEl) return;
    this._toastEl.textContent = text;
    this._toastEl.classList.add('bv-show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toastEl.classList.remove('bv-show'), 1600);
  }

  /** 组件模板（样式数值全部对齐真机采集结果） */
  static get TEMPLATE() {
    const dots = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${DislikeCardUI.DOTS_PATH}"></path></svg>`;
    const frown = `<svg viewBox="0 0 36 36" width="36" height="36" fill="currentColor" aria-hidden="true"><path d="${DislikeCardUI.FROWN_PATH}"></path></svg>`;
    const revertIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${DislikeCardUI.REVERT_PATHS.map((d) => `<path d="${d}"></path>`).join('')}</svg>`;
    const itemsHtml = DislikeCardUI.ITEMS
      .map((it) => `<div class="bv-dl-item" data-reason="${it.reasonId}" role="button">${it.label}</div>`)
      .join('');

    return `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }

        /* ⋮ 按钮 + 弹出菜单的 hover 容器 */
        .bv-dl-pop {
          position: absolute;
          right: 2px;
          bottom: 2px;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 4px;
          color: rgb(167, 160, 148);
          cursor: pointer;
          pointer-events: auto;
          transition: background-color .2s, color .2s;
        }
        .bv-dl-pop:hover { color: rgb(232, 230, 227); background: rgba(255, 255, 255, .08); }
        .bv-dl-pop svg { display: block; }

        /* 弹出菜单：底色/圆角/内边距/项高/字号均取自原生 */
        .bv-dl-menu {
          position: absolute;
          right: 0;
          bottom: calc(100% + 4px);
          min-width: 142px;
          padding: 12px 0;
          background: rgb(24, 26, 27);
          border-radius: 12px;
          opacity: 0;
          visibility: hidden;
          transform: translateY(4px);
          transition: opacity .2s, transform .2s, visibility .2s;
          pointer-events: none;
        }
        .bv-dl-menu.bv-show {
          opacity: 1;
          visibility: visible;
          transform: translateY(0);
          pointer-events: auto;
        }
        .bv-dl-item {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 40px;
          padding: 0 12px;
          font: 400 14px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
          color: rgb(167, 160, 148);
          white-space: nowrap;
          cursor: pointer;
          transition: background-color .2s, color .2s;
        }
        .bv-dl-item:hover { background: rgb(31, 34, 35); color: rgb(232, 230, 227); }

        /* 撤销浮层：覆盖卡片原位，底色 rgba(24,26,27,.4)、圆角 6px */
        .bv-dl-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 24px;
          background: rgba(24, 26, 27, .4);
          border-radius: 6px;
          color: rgb(232, 230, 227);
          opacity: 0;
          visibility: hidden;
          transition: opacity .2s, visibility .2s;
          pointer-events: none;
        }
        .bv-dl-overlay.bv-show { opacity: 1; visibility: visible; pointer-events: auto; }
        .bv-dl-ov-left { display: flex; align-items: center; gap: 10px; }
        .bv-dl-ov-left svg { flex: 0 0 auto; width: 30px; height: 30px; }
        .bv-dl-ov-text { display: flex; flex-direction: column; gap: 2px; }
        .bv-dl-ov-title { font: 400 14px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
        .bv-dl-ov-desc { font: 400 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; opacity: .85; }

        /* 撤销按钮：底色 rgba(24,26,27,.2)、圆角 6px、内边距 6px 12px、字号 13px */
        .bv-dl-revert {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
          padding: 6px 12px;
          background: rgba(24, 26, 27, .2);
          border-radius: 6px;
          font: 400 13px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
          color: rgb(232, 230, 227);
          cursor: pointer;
          transition: background-color .2s;
        }
        .bv-dl-revert:hover { background: rgba(24, 26, 27, .45); }

        /* 轻提示：仅用于失败反馈（成功路径由撤销浮层承担，与原生一致） */
        .bv-dl-toast {
          position: absolute;
          left: 50%;
          bottom: 8px;
          transform: translate(-50%, 6px);
          padding: 5px 12px;
          border-radius: 6px;
          background: rgba(0, 0, 0, .78);
          font: 400 12px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
          color: #fff;
          white-space: nowrap;
          opacity: 0;
          visibility: hidden;
          transition: opacity .2s, transform .2s, visibility .2s;
          pointer-events: none;
        }
        .bv-dl-toast.bv-show { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
      </style>

      <div class="bv-dl-pop" title="更多操作">
        ${dots}
        <div class="bv-dl-menu">${itemsHtml}</div>
      </div>

      <div class="bv-dl-overlay">
        <div class="bv-dl-ov-left">
          ${frown}
          <div class="bv-dl-ov-text">
            <span class="bv-dl-ov-title">内容不感兴趣</span>
            <span class="bv-dl-ov-desc">将减少此类内容推荐</span>
          </div>
        </div>
        <div class="bv-dl-revert">${revertIcon}撤销</div>
      </div>

      <div class="bv-dl-toast"></div>
    `;
  }
}
