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
 * - 未登录（无 bili_jct）不注入任何 UI
 * - 注入位置见 docs/adr/0008：一律挂自有图层，绝不动宿主 Vue 管理的 DOM 结构
 *
 * 两层职责（见 docs/adr/0016）：
 * 1. **信号层**：官方 `feedback/dislike` 上报。它只喂给 B 站的个性化推荐流，
 *    搜索页（查询相关性）与详情页相关推荐（内容相似度）都不消费它，且生效有服务端延迟。
 * 2. **过滤层**：本地持久化的**屏蔽清单**（DislikeStore）。上报成功后把 bvid /
 *    UP 主 mid 记入清单，此后无论刷新、换页还是重进，命中清单的卡片直接呈
 *    已屏蔽态（默认）或整块隐藏，不再被当成新卡重新注入 ⋮。
 *    仅靠内存集合是不够的——刷新即清零，卡片会"复活"，这正是本层存在的理由。
 *
 * mid 来源已实测：搜索页 `.bili-video-card` 的 `.bili-video-card__info--owner`
 * 就带 `//space.bilibili.com/{mid}`，与详情页推荐卡一样可直接解析；
 * `_fillUp()` 仅在卡片结构变化、DOM 里取不到 mid 时兜底（见 _extract）。
 */
class BoostDislike {
  /** 详情页右侧「相关推荐」卡片选择器（B 站改版时逐级退化） */
  static get RELATED_CARD_SELECTORS() {
    return [
      '.recommend-list-v1 .video-page-card-small',
      '.recommend-list-v1 .video-page-card',
      '.recommend-list-v1 [class*="video-page-card"]'
    ];
  }

  /** 搜索页结果卡片：与首页同属竖版 `.bili-video-card` 组件（封面在上、信息在下） */
  static get SEARCH_CARD_SELECTORS() {
    return ['.bili-video-card'];
  }

  /** 搜索页宿主 */
  static get SEARCH_HOST() { return 'search.bilibili.com'; }

  /**
   * 当前页面扫哪些卡片、用哪套已反馈态几何。
   * 搜索卡是竖版大封面（约 217×122），浮层内容可用原生尺寸；
   * 详情页推荐卡是横版小封面（141×80），需缩小。
   */
  static context() {
    const search = location.hostname === BoostDislike.SEARCH_HOST;
    return {
      selectors: search ? BoostDislike.SEARCH_CARD_SELECTORS : BoostDislike.RELATED_CARD_SELECTORS,
      variant: search ? 'lg' : 'sm'
    };
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
    this._cards = new Map();    // card 元素 -> { ui, info, blocked }（blocked = 命中的 reason_id 或 null）
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
    // 屏蔽清单是逐卡判定的前提：读到盘后立刻补一轮，把命中清单的卡片落到已屏蔽态
    DislikeStore.ensure().then(() => { if (this._running) this.refresh(); }).catch(() => {});
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
    // 清单未就绪前不注入：否则命中清单的卡片会先以"新卡"形态闪一个 ⋮（start 里会补一轮）
    if (!DislikeStore.ready) return;

    this._syncToggle();

    const ctx = BoostDislike.context();
    const nodes = [];
    for (const sel of ctx.selectors) {
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

      const ui = new DislikeCardUI(card, info, {
        onReport: (reasonId) => this._report(info, reasonId),
        onCancel: (reasonId) => this._cancel(info, reasonId),
        variant: ctx.variant
      });
      if (ui.mount()) this._cards.set(card, { ui, info });
    }

    // 屏蔽清单是唯一判定来源：新注入的卡片与已在册的卡片一并复核。
    // 好处是"清单被外部改动"（popup 清空 / 切换隐藏模式）不需要任何额外通知路径即可生效。
    for (const [card, rec] of this._cards) this._applyBlocked(card, rec);

    // 布局可能已变化（图片加载、换一换、内容展开），下一帧统一对齐
    this.scheduleReposition();
  }

  /**
   * 按当前屏蔽清单复核一张卡片的呈现。
   * 判定（DislikeStore.match）与呈现分离；比较基准取 UI 自身的已反馈态，
   * 因为用户点菜单上报 / 点撤销都会即时改变 UI 状态，这里只需补"清单与 UI 不一致"的那部分差。
   *
   * 命中屏蔽时默认呈**已屏蔽态**（磨砂 + 撤销，原位不跳动，沿用 docs/adr/0008 的取舍）；
   * 只有在 popup 打开「彻底隐藏」后才整块撤下（见 docs/adr/0016）。
   */
  _applyBlocked(card, rec) {
    if (!rec || !rec.ui.isMounted()) return;
    const want = DislikeStore.match(rec.info);   // null | 1 | 4
    if (rec.ui.reportedReason() !== want) {
      if (want) rec.ui.markReported(want);
      else rec.ui.clearReported();
    }
    rec.ui.setCardHidden(!!want && DislikeStore.hide);
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
      return;
    }
    // 开关回显屏蔽清单：该 UP 主已在清单里时进页面即呈激活态（见 docs/adr/0016）
    this._toggle.setOn(DislikeStore.isUpBlocked(info.upMid));
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
   * 纯 DOM 提取卡片身份（零网络请求）。
   * 只接受含 `/video/BV...` 链接的视频卡；UP 主 mid 取不到时置 null，
   * 由 `_fillUp()` 在"真正要上报 UP 主级理由"时兜底补取（平时不请求）。
   *
   * 实测（2026-10）：搜索页 `.bili-video-card` 的 `.bili-video-card__info--owner`
   * 本身就带 `//space.bilibili.com/{mid}`，与详情页推荐卡一致，故两处都能零请求拿到 mid。
   * 早期 ADR 0008 记录的"搜索卡完全不含 UP 主信息"已不成立，见 docs/adr/0016。
   */
  _extract(card) {
    try {
      const link = card.querySelector('a[href*="/video/BV"]');
      if (!link) return null;
      const href = link.getAttribute('href');
      const bvid = this._bvidFrom(href);
      if (!bvid) return null;

      const upLink = card.querySelector('a[href*="space.bilibili.com/"]');
      const upMid = upLink ? (upLink.getAttribute('href').match(/space\.bilibili\.com\/(\d+)/) || [])[1] : null;

      const nameEl = card.querySelector('.bili-video-card__info--author, .upname .name, .upname');
      return {
        bvid,
        aid: BoostDislike.bv2av(bvid),
        upMid: upMid || null,   // 取不到时上报前再补取（见 _fillUp）
        upName: nameEl ? nameEl.textContent.trim() : '',
        // 推荐位追踪 id：部分卡片（`.bili-video-card__wrap` 变体）把它挂在视频链接的
        // query 里，有则随上报带上、无则为空串——不是所有卡都带，故不做必填
        trackId: (href.match(/[?&]track_id=([^&#]+)/) || [])[1] || ''
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
   * 上报成功才记入**屏蔽清单**——清单才是"刷新/换页后仍不再打扰"的依据（见 docs/adr/0016）。
   * 顺序不能颠倒：先拿到服务端确认再落本地，避免上报失败却留下本地屏蔽。
   */
  async _report(info, reasonId) {
    // 「不想看此UP主」必须带 UP 主 mid；DOM 取不到时才补取一次
    if (reasonId === BoostDislike.REASON_UP && !info.upMid && !(await this._fillUp(info))) {
      return false;
    }
    if (!(await this._post(BoostDislike.REPORT_URL, info, reasonId))) return false;

    await DislikeStore.blockVideo(info.bvid, reasonId);
    if (reasonId === BoostDislike.REASON_UP && info.upMid) {
      await DislikeStore.blockUp(info.upMid, info.upName);
    }
    return true;
  }

  /** 补取 UP 主 mid（`view` 接口免 WBI，同时带回精确 aid） */
  async _fillUp(info) {
    try {
      const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(info.bvid)}`, {
        credentials: 'include'
      });
      const json = await res.json();
      const data = json && json.data;
      if (!data || !data.owner || !data.owner.mid) return false;
      info.upMid = String(data.owner.mid);
      if (data.aid) info.aid = data.aid;
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 撤销上报（reasonId 需与上报时一致）。
   * 撤销成功才解除本地屏蔽：UP 主级撤销同时撤下该 UP 主的整条屏蔽记录，
   * 这样该 UP 主的其它卡片也会一并恢复（它们此前是靠 mid 命中清单的）。
   */
  async _cancel(info, reasonId) {
    const rid = reasonId || 1;
    if (!(await this._post(BoostDislike.CANCEL_URL, info, rid))) return false;

    await DislikeStore.unblockVideo(info.bvid);
    if (rid === BoostDislike.REASON_UP && info.upMid) {
      await DislikeStore.unblockUp(info.upMid);
    }
    return true;
  }

  /**
   * 原生请求体（字段与真机抓包一致，另按参考实现补 `track_id`）。
   *
   * 两处刻意的取舍：
   * - `track_id` 只在卡片链接里带得到时才发（搜索页部分卡片带，推荐卡不带），
   *   它是"反馈归因到哪个推荐位"的字段，有则带上更精确。
   * - `mid` 取不到时**整个字段不发**，不退化成 `mid=0`：与其向服务端声明一个
   *   并不存在的 UP 主，不如让"内容级"理由保持纯内容级语义。
   */
  async _post(url, info, reasonId) {
    const csrf = this._csrf();
    if (!csrf) return false;
    const params = {
      app_id: '100',
      platform: '5',
      from_spmid: '333.1007.0.0',
      spmid: '333.1007.0.0',
      goto: 'av',
      id: String(info.aid),
      feedback_page: '1',
      reason_id: String(reasonId),
      csrf
    };
    if (info.upMid) params.mid = String(info.upMid);   // UP 主未知时不带该字段
    if (info.trackId) params.track_id = String(info.trackId);
    const body = new URLSearchParams(params);
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
