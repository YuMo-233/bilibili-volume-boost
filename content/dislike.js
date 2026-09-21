/**
 * 「不感兴趣」— 逻辑编排（ISOLATED world）
 *
 * 两块功能共用同一套上报通道与自有图层：
 * 1. 视频详情页右侧「相关推荐」卡片：右下角常驻 ⋮，两项直达（见下）
 * 2. 当前正在播放的视频：操作栏「点赞 / 投币」之间一个开关式控件，
 *    一次点击上报「不想看此UP主」，再点一次撤销
 *
 * 设计（见 docs/adr/0008）：
 * - 只处理含 BV 链接的 UGC 视频卡；番剧/直播/广告卡有各自的上报体系，不混入
 * - 上报走 B 站原生通道，非本地假移除：
 *     POST https://api.bilibili.com/x/web-interface/feedback/dislike
 *     POST https://api.bilibili.com/x/web-interface/feedback/dislike/cancel
 *   请求体：app_id=100&platform=5&goto=av&id={aid}&mid={UP主mid}
 *          &feedback_page=1&reason_id={1|4}&csrf={bili_jct}
 *   实测该接口不校验 WBI 签名，携带页面 cookie 即可
 * - 视频身份纯 DOM 提取（零网络请求）：bvid 取自链接/URL，
 *   UP 主 mid 取自 space 链接，aid 由 bvid 本地换算（bv2av）
 * - 会话去重：已上报的 bvid 记入集合，推荐卡再次出现不再注入按钮、不重复上报
 * - 未登录（无 bili_jct）不注入任何 UI
 * - 注入位置见 docs/adr/0008：一律挂自有图层，绝不动宿主 Vue 管理的 DOM 结构
 */
class BoostDislike {
  /** 相关推荐卡片选择器（B 站改版时逐级退化） */
  static get CARD_SELECTORS() {
    return [
      '.recommend-list-v1 .video-page-card-small',
      '.recommend-list-v1 .video-page-card',
      '.recommend-list-v1 [class*="video-page-card"]'
    ];
  }

  /** 上报接口 */
  static get REPORT_URL() {
    return 'https://api.bilibili.com/x/web-interface/feedback/dislike';
  }

  /** 撤销接口 */
  static get CANCEL_URL() {
    return 'https://api.bilibili.com/x/web-interface/feedback/dislike/cancel';
  }

  /** bvid 用的 base58 字符表 */
  static get BV_TABLE() {
    return 'FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf';
  }

  /** 理由 id：不想看此UP主（原生菜单第二项） */
  static get REASON_UP() {
    return 4;
  }

  constructor() {
    this._cards = new Map();    // card 元素 -> { ui, info }
    this._reported = new Set(); // 已上报的 bvid（会话内去重）
    this._running = false;
    this._toggle = null;        // 当前视频的开关控件
    this._raf = null;
    this._onViewport = () => this.scheduleReposition();
  }

  /** 未登录（缺少 csrf）时不注入按钮 */
  isLoggedIn() {
    return !!this._csrf();
  }

  _csrf() {
    const m = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    return m ? m[1] : '';
  }

  start() {
    this._running = true;
    // 布局变化时对齐 slot 位置（用 capture 以覆盖内部滚动容器）
    window.addEventListener('scroll', this._onViewport, { passive: true, capture: true });
    window.addEventListener('resize', this._onViewport, { passive: true });
  }

  stop() {
    this._running = false;
    window.removeEventListener('scroll', this._onViewport, { capture: true });
    window.removeEventListener('resize', this._onViewport);
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._clearAll();
  }

  /**
   * 扫描并同步卡片：新增卡片注入 UI，消失的卡片清理。
   * 由 content.js 的 MutationObserver 与定时轮询共同驱动。
   */
  refresh() {
    if (!this._running) return;
    if (!this.isLoggedIn()) {
      this._clearAll();
      return;
    }

    this._syncToggle();

    const nodes = [];
    for (const sel of BoostDislike.CARD_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => nodes.push(el));
    }
    const alive = new Set(nodes);

    // 清理失效卡片：离开 DOM，或宿主被 B 站 Vue 重渲染顶掉
    for (const [card, rec] of Array.from(this._cards)) {
      if (!alive.has(card) || !card.isConnected || !rec.ui.isMounted()) {
        rec.ui.unmount();
        this._cards.delete(card);
      }
    }

    // 注入缺失的卡片
    for (const card of nodes) {
      if (this._cards.has(card)) continue;
      const info = this._extract(card);
      if (!info) continue;                       // 非 UGC 视频卡（番剧/直播/广告）
      if (this._reported.has(info.bvid)) continue; // 会话内已上报，不再打扰

      const ui = new DislikeCardUI(card, info, {
        onReport: (reasonId) => this._report(info, reasonId),
        onCancel: (reasonId) => this._cancel(info, reasonId)
      });
      if (ui.mount()) this._cards.set(card, { ui, info });
    }

    // 布局可能已变化（图片加载、换一换、内容展开），下一帧统一对齐
    this.scheduleReposition();
  }

  /**
   * rAF 节流的整体重定位：先批量只读测量、再批量写入，
   * 同一帧内最多执行一次，避免逐卡读写交替触发反复重排。
   */
  scheduleReposition() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (!this._running || !this._cards.size) return;
      const batch = [];
      for (const [, rec] of this._cards) {
        const g = rec.ui.measure();                 // 只读
        if (g) batch.push([rec.ui, g]);
      }
      if (this._toggle && this._toggle.isMounted()) {
        const g = this._toggle.measure();
        if (g) batch.push([this._toggle, g]);
      }
      for (const [ui, g] of batch) ui.applyGeometry(g); // 只写
    });
  }

  /** 清空已注入的全部 UI（未登录或停止时） */
  _clearAll() {
    for (const [, rec] of this._cards) rec.ui.unmount();
    this._cards.clear();
    if (this._toggle) {
      this._toggle.unmount();
      this._toggle = null;
    }
  }

  /**
   * 当前视频的开关控件（模仿点赞项，插在点赞与投币之间）。
   * 拿不到本页视频身份（非详情页 / 无 UP 主链接）时不显示。
   */
  _syncToggle() {
    const info = this._currentVideo();
    if (!info) {
      if (this._toggle) {
        this._toggle.unmount();
        this._toggle = null;
      }
      return;
    }
    if (!this._toggle) {
      this._toggle = new VideoDislikeToggle({ onToggle: (on) => this._toggleReport(on) });
    }
    if (!this._toggle.isMounted() && !this._toggle.mount()) {
      this._toggle = null; // 操作栏未就绪，等下一轮
    }
  }

  /** 本页正在播放的视频身份（bvid 取自 URL，UP 主 mid 取自页面链接） */
  _currentVideo() {
    const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (!m) return null;
    const a = document.querySelector('.up-info-container a[href*="space.bilibili.com"], a[href*="space.bilibili.com"][title]');
    const mid = a ? (a.getAttribute('href').match(/space\.bilibili\.com\/(\d+)/) || [])[1] : null;
    if (!mid) return null;
    return { bvid: m[1], aid: BoostDislike.bv2av(m[1]), upMid: mid, upName: '' };
  }

  /** 开关动作：开 = 上报「不想看此UP主」，关 = 撤销 */
  async _toggleReport(on) {
    const info = this._currentVideo();
    if (!info) return false;
    return on ? this._report(info, BoostDislike.REASON_UP) : this._cancel(info, BoostDislike.REASON_UP);
  }

  /**
   * 纯 DOM 提取卡片身份。
   * 只接受含 /video/BV... 链接、且能解析出 UP 主 mid 的视频卡。
   */
  _extract(card) {
    try {
      const link = card.querySelector('a[href*="/video/BV"]');
      if (!link) return null;
      const bvid = this._bvidFrom(link.getAttribute('href'));
      if (!bvid) return null;

      const upLink = card.querySelector('a[href*="space.bilibili.com/"]');
      const upMid = upLink ? (upLink.getAttribute('href').match(/space\.bilibili\.com\/(\d+)/) || [])[1] : null;
      if (!upMid) return null;

      const nameEl = card.querySelector('.upname .name, .upname');
      return {
        bvid,
        aid: BoostDislike.bv2av(bvid),
        upMid,
        upName: nameEl ? nameEl.textContent.trim() : ''
      };
    } catch (_) {
      return null;
    }
  }

  _bvidFrom(href) {
    if (!href) return null;
    const m = href.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    return m ? m[1] : null;
  }

  /**
   * 上报（reasonId：1=这个内容，4=UP主）。
   * 成功后记入会话去重集合。
   */
  async _report(info, reasonId) {
    const ok = await this._post(BoostDislike.REPORT_URL, info, reasonId);
    if (ok) this._reported.add(info.bvid);
    return ok;
  }

  /** 撤销上报（reasonId 需与上报时一致） */
  async _cancel(info, reasonId) {
    const ok = await this._post(BoostDislike.CANCEL_URL, info, reasonId || 1);
    if (ok) this._reported.delete(info.bvid);
    return ok;
  }

  /** 原生请求体（字段与真机抓包一致） */
  async _post(url, info, reasonId) {
    const csrf = this._csrf();
    if (!csrf) return false;
    const body = new URLSearchParams({
      app_id: '100',
      platform: '5',
      from_spmid: '333.1007.0.0',
      spmid: '333.1007.0.0',
      goto: 'av',
      id: String(info.aid),
      mid: String(info.upMid),
      feedback_page: '1',
      reason_id: String(reasonId),
      csrf
    });
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const json = await res.json();
      return !!(json && json.code === 0);
    } catch (_) {
      return false;
    }
  }

  /**
   * bvid → aid 本地换算（零网络请求）。
   * 算法来自 B 站 BV 号编码规则：交换定位后按 base58 解码，再掩码异或。
   */
  static bv2av(bvid) {
    if (!bvid || bvid.length !== 12) return 0;
    const TABLE = BoostDislike.BV_TABLE;
    const XOR = 23442827791579n;
    const MASK = 2251799813685247n;
    const BASE = 58n;

    const chars = bvid.split('');
    let t = chars[3]; chars[3] = chars[9]; chars[9] = t;
    t = chars[4]; chars[4] = chars[7]; chars[7] = t;
    const s = chars.slice(3).join('');

    let n = 0n;
    for (let i = 0; i < s.length; i++) {
      const idx = TABLE.indexOf(s[i]);
      if (idx < 0) return 0;
      n = n * BASE + BigInt(idx);
    }
    return Number((n & MASK) ^ XOR);
  }
}
