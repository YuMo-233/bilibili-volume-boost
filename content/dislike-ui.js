/**
 * 相关推荐「不感兴趣」卡片 UI — Shadow DOM 注入，逐项复刻 B 站原生组件
 *
 * ⚠ 注入位置（重要，见 docs/adr/0008「禁止改动词法树」）：
 * 本插件**绝不往 B 站 Vue 管理的节点里插子节点**。视频页是 SSR + hydration
 * （`#mirror-vdcon`），在卡片内插入外部节点会破坏 hydration，触发 B 站重新挂载
 * （控制台会出现 "already an app instance mounted"、白屏检测介入），表现为
 * 进页面卡顿一下、页面像重载、顶部导航栏消失。故改为：
 * 在 document.body 上挂一个自有图层（DislikeLayer），图层内为每张卡片建一个
 * 绝对定位的 slot，位置按卡片在文档中的坐标换算。宿主 DOM 结构零改动。
 *
 * 样式基线来自真机采集（computed style + B 站 index-*.css）：
 * - ⋮ 按钮：18×18 三点图标，色 rgb(167,160,148)，圆角 4px，透明底
 * - 弹出菜单：底色 rgb(24,26,27)，圆角 12px，上下内边距 12px；项高 40px、
 *   字号 14px、文字色 rgb(167,160,148)、左右内边距 12px、文字居中；悬停底色 rgb(31,34,35)
 * - 已反馈态：封面 `filter: blur(20px)`（.3s 过渡）+ 浮层只盖封面
 *   （底色 rgba(24,26,27,.4)、圆角 6px、opacity .3s 淡入）+ 标题信息区隐藏
 *
 * 公共接口（dislike.js 依赖）：
 *   new DislikeCardUI(card, info, { onReport, onCancel })
 *   mount() / unmount() / isMounted() / reposition()
 *   markReported(reasonId) / clearReported() / toast(text)
 */

/** 自有图层：body 上的统一容器，避免改动宿主框架管理的 DOM */
class DislikeLayer {
  static get HOST_ID() { return 'bv-dl-layer'; }

  static _host = null;
  static _root = null;
  static _refs = 0;

  /** 取（必要时创建）图层 ShadowRoot；图层只作定位容器，不拦指针 */
  static acquire() {
    if (!DislikeLayer._host || !DislikeLayer._host.isConnected) {
      const host = document.createElement('div');
      host.id = DislikeLayer.HOST_ID;
      // 容器本身 0 尺寸、不拦指针；各 slot 自定位。
      // z-index 必须低于 B 站吸顶导航（.bili-header__menu 为 1002）：
      // 否则页面滚动到操作栏被导航遮住时，只有我们的控件浮在导航栏之上，观感错乱。
      host.style.cssText =
        'all:initial;position:absolute;top:0;left:0;width:0;height:0;' +
        'z-index:1000;pointer-events:none;overflow:visible;';
      const root = host.attachShadow({ mode: 'closed' });
      // 图层承载多组控件，样式统一在此注入一次
      root.innerHTML = `<style>${DislikeCardUI.STYLE}${VideoDislikeToggle.STYLE}</style>`;
      document.body.appendChild(host);
      DislikeLayer._host = host;
      DislikeLayer._root = root;
      DislikeLayer._refs = 0;
    }
    DislikeLayer._refs++;
    return DislikeLayer._root;
  }

  /** 归还图层；无引用时整体摘除，不留残留 */
  static release() {
    DislikeLayer._refs = Math.max(0, DislikeLayer._refs - 1);
    if (DislikeLayer._refs === 0 && DislikeLayer._host) {
      DislikeLayer._host.remove();
      DislikeLayer._host = null;
      DislikeLayer._root = null;
    }
  }

  static get root() {
    return DislikeLayer._root;
  }
}

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

  /**
   * 卡片部件选择器（两种卡片组件结构不同）：
   * - sm：详情页右侧推荐卡（横版，封面 141×80）；外层 `.pic` 有 overflow:hidden，
   *   故磨砂作用在其内部媒体元素上
   * - lg：搜索页 / 首页同款竖版卡（封面约 217×122）；原生就是直接给 `.bili-video-card__image`
   *   加 blur，外层 `--image--link` 负责裁剪
   */
  static get PARTS() {
    return {
      sm: { cover: '.pic-box', blurWrap: '.pic-box .pic', blurInner: true, info: '.info' },
      lg: {
        cover: '.bili-video-card__image--wrap',
        blurWrap: '.bili-video-card__image',
        blurInner: false,
        info: '.bili-video-card__info'
      }
    };
  }

  _parts() {
    return DislikeCardUI.PARTS[this.variant];
  }

  /** 菜单隐藏延迟：留出从 ⋮ 移到菜单的时间（原生 popover 同样不立即收起） */
  static get HIDE_DELAY() { return 180; }

  constructor(card, info, handlers) {
    this.card = card;
    this.info = info;                                     // { bvid, aid, upMid, upName }
    this.onReport = handlers.onReport;                     // (reasonId) => Promise<boolean>
    this.onCancel = handlers.onCancel;                     // (reasonId) => Promise<boolean>
    this.variant = handlers.variant === 'lg' ? 'lg' : 'sm'; // sm=详情页横版小封面，lg=搜索/首页竖版大封面
    this.slot = null;
    this._menu = null;
    this._overlay = null;
    this._toastEl = null;
    this._hideTimer = null;
    this._toastTimer = null;
    this._reported = null;                                 // null | reasonId
    this._popHover = false;                                // 指针是否停在 ⋮ 或菜单上
    this._unhoverTimer = null;                             // 离开卡片后收起 ⋮ 的延迟
    this._onCardEnter = null;
    this._onCardLeave = null;
    this._blurTarget = null;                               // 当前被磨砂的封面元素
    this._prevFilter = '';                                 // 磨砂前的 inline filter（撤销时还原）
    this._prevTransition = '';                             // 磨砂前的 inline transition
    this._geo = '';                                        // 最近一次写入的 slot 几何签名
    this._coverSig = '';                                   // 最近一次写入的封面矩形签名
  }

  isMounted() {
    return !!(this.slot && this.slot.isConnected);
  }

  /**
   * 挂载：在自有图层里建 slot，并按卡片矩形定位。
   * 不向卡片内插入任何节点，宿主 DOM 结构保持不变。
   */
  mount() {
    if (this.isMounted()) return true;
    if (!document.body) return false;

    const root = DislikeLayer.acquire();
    this.slot = document.createElement('div');
    this.slot.className = 'bv-dl-slot';
    this.slot.innerHTML = DislikeCardUI.markup(this.variant);
    root.appendChild(this.slot);

    this._menu = this.slot.querySelector('.bv-dl-menu');
    this._overlay = this.slot.querySelector('.bv-dl-overlay');
    this._toastEl = this.slot.querySelector('.bv-dl-toast');

    this._bind();
    this.reposition();
    return true;
  }

  unmount() {
    clearTimeout(this._hideTimer);
    clearTimeout(this._toastTimer);
    clearTimeout(this._unhoverTimer);
    // 摘掉卡片上的监听，避免宿主节点留存悬挂引用
    if (this.card && this._onCardEnter) {
      this.card.removeEventListener('mouseenter', this._onCardEnter);
      this.card.removeEventListener('mouseleave', this._onCardLeave);
    }
    this._onCardEnter = null;
    this._onCardLeave = null;
    this._popHover = false;
    this._applyFeedback(false); // 还原封面磨砂与信息区可见性，不留副作用
    if (this.slot) {
      this.slot.remove();
      this.slot = null;
      this._menu = null;
      this._overlay = null;
      this._toastEl = null;
    }
    this._geo = '';
    this._coverSig = '';
    this._reported = null;
    DislikeLayer.release();
  }

  /**
   * 只读测量：卡片在文档中的矩形 + 封面在卡片内的矩形。
   * 与 applyGeometry 分离，便于控制器"一次读取全部卡片、再一次性写入"，
   * 避免逐卡读写交替触发反复重排（layout thrash）。
   */
  measure() {
    if (!this.slot || !this.card.isConnected) return null;
    const body = document.body;
    if (!body) return null;
    const cr = this.card.getBoundingClientRect();
    if (cr.width <= 0 || cr.height <= 0) return null;        // 卡片被隐藏时不写
    const br = body.getBoundingClientRect();
    const g = {
      left: Math.round(cr.left - br.left),
      top: Math.round(cr.top - br.top),
      w: Math.round(cr.width),
      h: Math.round(cr.height),
      cover: null
    };
    const cover = this.card.querySelector(this._parts().cover);
    if (cover) {
      const pr = cover.getBoundingClientRect();
      g.cover = {
        left: Math.round(pr.left - cr.left),
        top: Math.round(pr.top - cr.top),
        w: Math.round(pr.width),
        h: Math.round(pr.height)
      };
    }
    return g;
  }

  /** 写入几何（仅当变化时写，避免无谓样式写引发重排） */
  applyGeometry(g) {
    if (!this.slot || !g) return;
    const sig = `${g.left},${g.top},${g.w},${g.h}`;
    if (sig !== this._geo) {
      this._geo = sig;
      this.slot.style.left = `${g.left}px`;
      this.slot.style.top = `${g.top}px`;
      this.slot.style.width = `${g.w}px`;
      this.slot.style.height = `${g.h}px`;
    }
    if (this._reported !== null && g.cover && this._overlay) {
      const csig = `${g.cover.left},${g.cover.top},${g.cover.w},${g.cover.h}`;
      if (csig !== this._coverSig) {
        this._coverSig = csig;
        this._overlay.style.left = `${g.cover.left}px`;
        this._overlay.style.top = `${g.cover.top}px`;
        this._overlay.style.width = `${g.cover.w}px`;
        this._overlay.style.height = `${g.cover.h}px`;
      }
    }
  }

  /** 单卡重定位（内部为一次测量 + 一次写入） */
  reposition() {
    this.applyGeometry(this.measure());
  }

  /**
   * 交互绑定：
   * - 鼠标移到卡片上才显形 ⋮（原生行为），移出后延迟收起
   * - 悬停 ⋮ 展开菜单（鼠标移入菜单时因是子节点不会触发 mouseleave）
   * - 点击条目上报、点撤销回退
   */
  _bind() {
    const pop = this.slot.querySelector('.bv-dl-pop');
    const items = this.slot.querySelectorAll('.bv-dl-item');

    // 卡片 hover → 显形/隐藏 ⋮（只加监听，不改宿主 DOM 结构）
    this._onCardEnter = () => {
      clearTimeout(this._unhoverTimer);
      this._setHover(true);
    };
    this._onCardLeave = () => this._scheduleUnhover();
    this.card.addEventListener('mouseenter', this._onCardEnter);
    this.card.addEventListener('mouseleave', this._onCardLeave);

    pop.addEventListener('mouseenter', () => {
      this._popHover = true;
      clearTimeout(this._hideTimer);
      clearTimeout(this._unhoverTimer);
      this._setHover(true);
      if (this._reported === null) this._menu.classList.add('bv-show');
    });
    pop.addEventListener('mouseleave', () => {
      this._popHover = false;
      // 延迟收起：鼠标从 ⋮ 移向菜单的途中不闪断
      this._hideTimer = setTimeout(() => this._menu.classList.remove('bv-show'), DislikeCardUI.HIDE_DELAY);
      this._scheduleUnhover();
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
      // 浮层覆盖在卡片上方，需阻断冒泡避免误触发卡片跳转
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    const revert = this.slot.querySelector('.bv-dl-revert');
    revert.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const ok = await this.onCancel(this._reported);
      if (ok) this.clearReported();
      else this.toast('撤销失败，请稍后重试');
    });
    revert.addEventListener('pointerdown', (e) => e.stopPropagation());

    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    this._overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  /** 离开卡片后延迟收起 ⋮；指针停在 ⋮ 或菜单上时不收 */
  _scheduleUnhover() {
    clearTimeout(this._unhoverTimer);
    this._unhoverTimer = setTimeout(() => {
      if (!this._popHover) this._setHover(false);
    }, DislikeCardUI.HIDE_DELAY);
  }

  /** 切换 ⋮ 显隐（走 class，样式在图层里） */
  _setHover(on) {
    if (this.slot) this.slot.classList.toggle('bv-hover', !!on);
  }

  /** 展示已反馈态：封面磨砂 + 浮层只盖封面 + 隐藏标题信息区（严格对齐原生） */
  markReported(reasonId) {
    this._reported = reasonId;
    const item = DislikeCardUI.ITEMS.find((it) => it.reasonId === reasonId);
    const title = this.slot.querySelector('.bv-dl-ov-title');
    if (title) title.textContent = item ? item.title : '内容不感兴趣';

    this.reposition();       // 先按封面矩形落位（applyGeometry 在已反馈态下会写浮层几何）
    this._applyFeedback(true);
    this._menu.classList.remove('bv-show');
    this._overlay.classList.add('bv-show');
  }

  /** 撤销后恢复卡片原状 */
  clearReported() {
    this._reported = null;
    this._applyFeedback(false);
    this._overlay.classList.remove('bv-show');
  }

  /**
   * 进入 / 退出已反馈态：
   * - 封面磨砂：给封面图外层加 `filter: blur(20px)`（原生同款，带 .3s 过渡）
   * - 隐藏信息区：`.info` 置 visibility:hidden（原生整块不再渲染；此处保位以免列表跳动）
   * - 撤下 ⋮：原生上报后卡片不再提供该入口
   *
   * 仅改**内联样式**，不动 DOM 结构，因此不会破坏宿主 Vue hydration。
   * 浮层几何由 applyGeometry 负责（见 measure / applyGeometry）。
   */
  _applyFeedback(on) {
    // 封面磨砂：sm 卡磨砂外层内部的媒体元素（外层 .pic 负责裁剪）；
    // lg 卡按原生做法直接磨砂 .bili-video-card__image（外层 link 负责裁剪）
    const p = this._parts();
    const wrap = this.card.querySelector(p.blurWrap);
    const target = !wrap ? null : (p.blurInner ? (wrap.querySelector('.framepreview-box') || wrap.querySelector('img')) : wrap);
    if (on) {
      if (target && !this._blurTarget) {
        this._blurTarget = target;
        this._prevFilter = target.style.filter;
        this._prevTransition = target.style.transition;
      }
      if (this._blurTarget) {
        this._blurTarget.style.transition = 'filter .3s';
        this._blurTarget.style.filter = 'blur(20px)';
      }
    } else if (this._blurTarget) {
      this._blurTarget.style.filter = this._prevFilter || '';
      this._blurTarget.style.transition = this._prevTransition || '';
      this._blurTarget = null;
    }

    const info = this.card.querySelector(p.info);
    if (info) info.style.visibility = on ? 'hidden' : '';

    const pop = this.slot ? this.slot.querySelector('.bv-dl-pop') : null;
    if (pop) pop.style.display = on ? 'none' : '';
  }

  toast(text) {
    if (!this._toastEl) return;
    this._toastEl.textContent = text;
    this._toastEl.classList.add('bv-show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toastEl.classList.remove('bv-show'), 1600);
  }

  /** 图层共享样式（在 DislikeLayer 的 ShadowRoot 里只注入一次） */
  static get STYLE() {
    return `
      :host { all: initial; }
      * { box-sizing: border-box; }

      /* 每张卡片一个 slot：绝对定位到卡片矩形，本身不拦指针 */
      .bv-dl-slot { position: absolute; pointer-events: none; overflow: visible; }

      /* ⋮ 按钮 + 弹出菜单的 hover 容器（贴卡片右下角，与播放量行齐平）
         与原生一致：默认隐藏，鼠标移到卡片上才显形（见 _bind 的卡片 hover 监听） */
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
        opacity: 0;
        visibility: hidden;
        transition: opacity .2s, visibility .2s, background-color .2s, color .2s;
      }
      .bv-dl-slot.bv-hover .bv-dl-pop { opacity: 1; visibility: visible; }
      .bv-dl-pop:hover { color: rgb(232, 230, 227); background: rgba(255, 255, 255, .08); }
      .bv-dl-pop svg { display: block; }

      /* 弹出菜单：底色/圆角/内边距/项高/字号均取自原生，
         弹出方向与对齐也照搬原生（vui_popover-is-bottom-end：向下弹出、右对齐） */
      .bv-dl-menu {
        position: absolute;
        right: 0;
        top: calc(100% + 4px);
        min-width: 142px;
        padding: 12px 0;
        background: rgb(24, 26, 27);
        border-radius: 12px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-4px);
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

      /* 撤销浮层：严格照搬原生——只盖封面，底色 rgba(24,26,27,.4)、圆角 6px、
         透明度 .3s 淡入；尺寸/位置由 _applyFeedback 按封面矩形写入 inline style */
      .bv-dl-overlay {
        position: absolute;
        left: 0;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(24, 26, 27, .4);
        border-radius: 6px;
        color: rgb(232, 230, 227);
        overflow: hidden;
        opacity: 0;
        visibility: hidden;
        transition: opacity .3s;
        pointer-events: none;
        z-index: 2;
      }
      .bv-dl-overlay.bv-show { opacity: 1; visibility: visible; pointer-events: auto; }
      /* 封面尺寸小，内容按比例缩小并改为竖向堆叠（原生为左列+右按钮的横排） */
      .bv-dl-ov-inner { display: flex; flex-direction: column; align-items: center; }
      .bv-dl-ov-inner > svg { width: 22px; height: 22px; margin-bottom: 2px; }
      .bv-dl-ov-title { font: 400 11px/14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .bv-dl-ov-desc { font: 400 10px/12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; opacity: .6; }

      /* 撤销按钮：底色 rgba(24,26,27,.2)、圆角 6px、白字（原生内边距 6px 12px 按比例缩小） */
      .bv-dl-revert {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        margin-top: 4px;
        padding: 3px 8px;
        background: rgba(24, 26, 27, .2);
        border-radius: 6px;
        font: 400 11px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        color: rgb(232, 230, 227);
        cursor: pointer;
        transition: background-color .2s;
      }
      .bv-dl-revert svg { width: 13px; height: 13px; }
      .bv-dl-revert:hover { background: rgba(24, 26, 27, .45); }

      /* 大封面卡（搜索页 / 首页同款竖版卡）：浮层用原生尺寸与原生「左列 + 右按钮」横排 */
      .bv-dl-ov-inner.bv-lg { flex-direction: row; gap: 24px; }
      .bv-dl-ov-col { display: flex; flex-direction: column; align-items: center; }
      .bv-dl-ov-inner.bv-lg .bv-dl-ov-col > svg { width: 36px; height: 36px; margin-bottom: 5px; }
      .bv-dl-ov-inner.bv-lg .bv-dl-ov-title { font: 400 14px/20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .bv-dl-ov-inner.bv-lg .bv-dl-ov-desc { font: 400 12px/16px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; opacity: .6; }
      .bv-dl-ov-inner.bv-lg .bv-dl-revert { gap: 0; margin-top: 0; padding: 6px 12px; font: 400 13px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
      .bv-dl-ov-inner.bv-lg .bv-dl-revert svg { width: 16px; height: 16px; margin-right: 6px; }

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
    `;
  }

  /**
   * 单卡片 slot 的结构（样式在图层里统一注入）。
   * sm 卡封面小（141×80），内容竖向堆叠；
   * lg 卡封面大（约 217×122），用原生「左列（图标在上）+ 右撤销按钮」横排。
   */
  static markup(variant) {
    const dots = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${DislikeCardUI.DOTS_PATH}"></path></svg>`;
    const frown = `<svg viewBox="0 0 36 36" width="36" height="36" fill="currentColor" aria-hidden="true"><path d="${DislikeCardUI.FROWN_PATH}"></path></svg>`;
    const revertIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${DislikeCardUI.REVERT_PATHS.map((d) => `<path d="${d}"></path>`).join('')}</svg>`;
    const itemsHtml = DislikeCardUI.ITEMS
      .map((it) => `<div class="bv-dl-item" data-reason="${it.reasonId}" role="button">${it.label}</div>`)
      .join('');

    const text = `
      <span class="bv-dl-ov-title">内容不感兴趣</span>
      <span class="bv-dl-ov-desc">将减少此类内容推荐</span>`;
    const inner = variant === 'lg'
      ? `<div class="bv-dl-ov-col">${frown}${text}</div><div class="bv-dl-revert">${revertIcon}撤销</div>`
      : `${frown}${text}<div class="bv-dl-revert">${revertIcon}撤销</div>`;

    return `
      <div class="bv-dl-pop" title="更多操作">
        ${dots}
        <div class="bv-dl-menu">${itemsHtml}</div>
      </div>

      <div class="bv-dl-overlay">
        <div class="bv-dl-ov-inner${variant === 'lg' ? ' bv-lg' : ''}">${inner}</div>
      </div>

      <div class="bv-dl-toast"></div>
    `;
  }
}

/**
 * 当前视频「不感兴趣」开关 — 模仿点赞控件，插在点赞与投币之间
 *
 * 约束（实测）：
 * - 操作栏 `.video-toolbar-left-main` 的项是 Vue 渲染的，插件**不插入节点**；
 *   空间靠给第 2 项（投币）加 `margin-left` 让出来，我们再把控件绝对定位到空位上。
 * - 操作栏容器 `.video-toolbar-container` 总宽 693，左组 400 + 右组 197，
 *   空余 96px；因此控件宽度 + 8 必须 ≤ 96。
 * - 点击一次 = 上报「不感兴趣（不想看此UP主，reason_id=4）」，再点一次 = 撤销。
 *
 * 公共接口（dislike.js 依赖）：
 *   new VideoDislikeToggle({ onToggle }) / mount() / unmount() / isMounted()
 *   measure() / applyGeometry(g) / setOn(bool)
 */
class VideoDislikeToggle {
  /** 图标尺寸（与原生点赞项图标一致） */
  static get ICON() { return 24; }

  /**
   * 项内留白：原生每项固定 92 宽而内容仅约 66，余下约 26px 是项内空白，
   * 相邻项的视觉间距因此约 34px。本项照搬这个留白，间距才能与原生一致。
   */
  static get INNER_SLACK() { return 26; }

  /** 与原生项一致的间距 */
  static get GAP() { return 8; }

  /** 本项宽度 = 图标 + 项内留白 */
  static get WIDTH() { return VideoDislikeToggle.ICON + VideoDislikeToggle.INNER_SLACK; }

  /** 让位量 = 本项宽度 + 间距；超过操作栏余量时宁可不显示 */
  static get NEEDED() { return VideoDislikeToggle.WIDTH + VideoDislikeToggle.GAP; }

  /** 激活色（B 站品牌蓝，点赞激活同色） */
  static get ON_COLOR() { return 'rgb(0, 174, 236)'; }

  /** 点赞图标路径（垂直翻转即为"踩"，保证与点赞控件同源同形） */
  static get THUMB_PATH() {
    return 'M9.77234 30.8573V11.7471H7.54573C5.50932 11.7471 3.85742 13.3931 3.85742 15.425V27.1794C3.85742 29.2112 5.50932 30.8573 7.54573 30.8573H9.77234ZM11.9902 30.8573V11.7054C14.9897 10.627 16.6942 7.8853 17.1055 3.33591C17.2666 1.55463 18.9633 0.814421 20.5803 1.59505C22.1847 2.36964 23.243 4.32583 23.243 6.93947C23.243 8.50265 23.0478 10.1054 22.6582 11.7471H29.7324C31.7739 11.7471 33.4289 13.402 33.4289 15.4435C33.4289 15.7416 33.3928 16.0386 33.3215 16.328L30.9883 25.7957C30.2558 28.7683 27.5894 30.8573 24.528 30.8573H11.9911H11.9902Z';
  }

  constructor(handlers) {
    this.onToggle = handlers.onToggle;  // (nextOn) => Promise<boolean>
    this.slot = null;
    this._el = null;
    this._toastEl = null;
    this._on = false;
    this._busy = false;
    this._geo = '';
    this._marginPx = 0;                 // 已写入第 2 项的 margin-left
    this._toastTimer = null;
  }

  isMounted() {
    return !!(this.slot && this.slot.isConnected);
  }

  mount() {
    if (this.isMounted()) return true;
    if (!document.body) return false;
    if (!this._items()) return false;   // 操作栏未就绪则先不挂

    const root = DislikeLayer.acquire();
    this.slot = document.createElement('div');
    this.slot.className = 'bv-dl-slot';
    this.slot.innerHTML = VideoDislikeToggle.MARKUP;
    root.appendChild(this.slot);

    this._el = this.slot.querySelector('.bv-dl-toggle');
    this._toastEl = this.slot.querySelector('.bv-dl-toggle-toast');
    this._el.addEventListener('click', (e) => this._onClick(e));
    this._el.addEventListener('pointerdown', (e) => e.stopPropagation());

    const g = this.measure();
    if (!g) {                            // 余量不足：不留残留
      this.unmount();
      return false;
    }
    this.applyGeometry(g);
    return true;
  }

  unmount() {
    clearTimeout(this._toastTimer);
    this._releaseMargin();
    if (this.slot) {
      this.slot.remove();
      this.slot = null;
      this._el = null;
      this._toastEl = null;
    }
    this._geo = '';
    this._on = false;
    DislikeLayer.release();
  }

  /** 点赞项与其后一项的容器 */
  _items() {
    const main = document.querySelector('.video-toolbar-left-main');
    if (!main || main.children.length < 2) return null;
    return main;
  }

  /** 归还让位（卸载时还原原生布局） */
  _releaseMargin() {
    const main = this._items();
    if (main && this._marginPx) main.children[1].style.marginLeft = '';
    this._marginPx = 0;
  }

  /**
   * 只读测量：算出操作栏真实余量，余量够才落位。
   * 余量 = 容器宽 − 左组宽（不含本已占的让位边距）− 右组宽。
   * 本项总宽固定为 WIDTH（图标 + 项内留白），让位 NEEDED，与原生节奏一致。
   */
  measure() {
    if (!this.slot) return null;
    const tc = document.querySelector('.video-toolbar-container');
    const left = document.querySelector('.video-toolbar-left');
    const right = document.querySelector('.video-toolbar-right');
    const main = this._items();
    if (!tc || !left || !right || !main) return null;

    const r1 = main.children[0].getBoundingClientRect();
    if (r1.width <= 0 || r1.height <= 0) return null;

    const baseLeft = left.offsetWidth - this._marginPx;
    const slack = Math.max(0, tc.clientWidth - baseLeft - right.offsetWidth);
    if (slack < VideoDislikeToggle.NEEDED) return null;   // 余量不足宁可不显示，避免挤压原生布局

    const br = document.body.getBoundingClientRect();
    return {
      left: Math.round(r1.right - br.left) + VideoDislikeToggle.GAP,
      top: Math.round(r1.top - br.top),
      w: VideoDislikeToggle.WIDTH,
      h: Math.round(r1.height),
      margin: VideoDislikeToggle.NEEDED
    };
  }

  applyGeometry(g) {
    if (!this.slot || !g) return;
    // 让位边距（只写变化的）
    const main = this._items();
    if (main && g.margin !== this._marginPx) {
      main.children[1].style.marginLeft = `${g.margin}px`;
      this._marginPx = g.margin;
    }
    const sig = `${g.left},${g.top},${g.w},${g.h}`;
    if (sig === this._geo) return;
    this._geo = sig;
    this.slot.style.left = `${g.left}px`;
    this.slot.style.top = `${g.top}px`;
    this.slot.style.width = `${g.w}px`;
    this.slot.style.height = `${g.h}px`;
  }

  reposition() {
    this.applyGeometry(this.measure());
  }

  setOn(on) {
    this._on = !!on;
    if (this._el) this._el.classList.toggle('bv-on', this._on);
  }

  async _onClick(e) {
    e.stopPropagation();
    e.preventDefault();
    if (this._busy) return;
    this._busy = true;
    const next = !this._on;
    const ok = await this.onToggle(next);
    this._busy = false;
    if (ok) {
      this.setOn(next);
      this.toast(next ? '已减少此类推荐' : '已撤销');
    } else {
      this.toast(next ? '操作失败，请稍后重试' : '撤销失败，请稍后重试');
    }
  }

  toast(text) {
    if (!this._toastEl) return;
    this._toastEl.textContent = text;
    this._toastEl.classList.add('bv-show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this._toastEl.classList.remove('bv-show'), 1600);
  }

  /** 控件样式（仅图标；尺寸与留白对齐原生项节奏） */
  static get STYLE() {
    return `
      /* 当前视频开关：模仿点赞项的图标形态（无底色） */
      .bv-dl-toggle {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        color: rgb(167, 160, 148);
        cursor: pointer;
        pointer-events: auto;
        transition: color .2s;
      }
      .bv-dl-toggle:hover { color: rgb(0, 174, 236); }
      .bv-dl-toggle.bv-on { color: rgb(0, 174, 236); }
      /* 垂直翻转点赞图标即为"踩"，与点赞控件同源同形 */
      .bv-dl-toggle-icon {
        width: 24px;
        height: 24px;
        flex: 0 0 auto;
        transform: scaleY(-1);
      }
      .bv-dl-toggle-toast {
        position: absolute;
        left: 50%;
        top: 100%;
        transform: translate(-50%, 4px);
        padding: 4px 10px;
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
      .bv-dl-toggle-toast.bv-show { opacity: 1; visibility: visible; transform: translate(-50%, 0); }
    `;
  }

  static get MARKUP() {
    return `
      <div class="bv-dl-toggle" role="button" title="不感兴趣（减少此类与该作者推荐）">
        <svg viewBox="0 0 36 36" class="bv-dl-toggle-icon" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="${VideoDislikeToggle.THUMB_PATH}"></path></svg>
      </div>
      <div class="bv-dl-toggle-toast"></div>
    `;
  }
}
