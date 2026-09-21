/**
 * 相关推荐「不感兴趣」— 逻辑编排（ISOLATED world）
 *
 * 设计（见 docs/adr/0008）：
 * - 仅在视频详情页右侧「相关推荐」列表注入；只处理含 BV 链接的 UGC 视频卡，
 *   番剧/直播/广告卡有各自的上报体系，不混入
 * - 上报走 B 站原生通道，非本地假移除：
 *     POST https://api.bilibili.com/x/web-interface/feedback/dislike
 *     POST https://api.bilibili.com/x/web-interface/feedback/dislike/cancel
 *   请求体：app_id=100&platform=5&goto=av&id={aid}&mid={UP主mid}
 *          &feedback_page=1&reason_id={1|4}&csrf={bili_jct}
 *   实测该接口不校验 WBI 签名，携带页面 cookie 即可
 * - 视频身份纯 DOM 提取（零网络请求）：bvid 取自卡片 href，
 *   UP 主 mid 取自 space 链接，aid 由 bvid 本地换算（bv2av）
 * - 会话去重：已上报的 bvid 记入集合，再次出现不再注入按钮、不重复上报
 * - 未登录（无 bili_jct）不注入按钮
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

  constructor() {
    this._cards = new Map();    // card 元素 -> { ui, info }
    this._reported = new Set(); // 已上报的 bvid（会话内去重）
    this._running = false;
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
  }

  stop() {
    this._running = false;
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
  }

  /** 清空已注入的全部 UI（未登录或停止时） */
  _clearAll() {
    for (const [, rec] of this._cards) rec.ui.unmount();
    this._cards.clear();
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
