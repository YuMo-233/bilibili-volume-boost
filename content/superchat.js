/**
 * 醒目留言（SC）取数 — HTTP 轮询
 *
 * 设计（见 docs/adr/0005、0017）：
 * - 唯一取数路径：轮询 getMessageList，无需登录，返回"当前悬挂中"的全部 SC
 * - SC 属长悬挂内容（最短 60 秒），10 秒轮询不会漏项，无需拦截 WebSocket（弹幕包为 brotli，
 *   浏览器原生 DecompressionStream 不支持）
 * - 以 id 为主键增量合并；接口中消失的 id 判为已移除（悬挂结束或被删除）
 * - **"是否仍悬挂"的唯一判据是 `visible()`**（按本地 `endTime` 过滤，与浮层同一条规则）。
 *   本层不再私自清扫过期项：过期项留在 items 里由 `visible()` 挡住、由下一轮"接口消失即移除"
 *   清出，避免出现第三套与浮层各删各的时钟（见 docs/adr/0017）
 * - `poll()` 带**超时看门狗**：单次请求挂起不再让 `_inflight` 永久为真。否则一次网络挂起即
 *   令整条轮询永久停摆，表现为"候补永不补位、只能刷新页面才恢复"
 *
 * 公共接口（content.js 依赖）：
 *   BVSuperChatFeed(intervalMs) / setRoom(roomId) / start() / stop()
 *   close(id) / visible()
 */
class SuperChatFeed {
  static get API() {
    return 'https://api.live.bilibili.com/av/v1/SuperChat/getMessageList';
  }

  /** 轮询间隔：10 秒（远小于 SC 最短悬挂时长，故不会漏项） */
  static get INTERVAL() {
    return 10000;
  }

  /** 单次请求超时：到点即中止放行，避免挂起的请求把整条轮询卡死 */
  static get TIMEOUT() {
    return 8000;
  }

  constructor(opts) {
    const o = opts || {};
    this.roomId = null;
    this.items = new Map();   // id -> 归一化 SC
    this.closed = new Set();  // 本次会话内被手动关闭的 id（不再随轮询复现）
    this.interval = o.interval || SuperChatFeed.INTERVAL;
    this.timeout = o.timeout || SuperChatFeed.TIMEOUT;
    this.onUpdate = o.onUpdate || (() => {});
    this._timer = null;
    this._on = false;
    this._inflight = false;
    this._ctrl = null;
  }

  /** 切房：清空状态并立即回填一次 */
  setRoom(roomId) {
    const next = roomId == null ? null : String(roomId);
    if (this.roomId === next) return;
    this.roomId = next;
    this.items.clear();
    this.closed.clear();
    this._emit();
    if (this._on) this.poll();
  }

  start() {
    if (this._on) return;
    this._on = true;
    this.poll(); // 首轮即"回填"：带回进入前就已悬挂的 SC
    this._timer = setInterval(() => this.poll(), this.interval);
  }

  stop() {
    this._on = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._abort();   // 顺手中止在途请求，别让它带着旧房间的列表回来
    this.items.clear();
    this._emit();
  }

  get running() { return this._on; }

  /** 手动关闭：从列表移除并记住，避免下一轮轮询又冒出来 */
  close(id) {
    const key = String(id);
    this.closed.add(key);
    if (this.items.delete(key)) this._emit();
  }

  /**
   * 当前应展示的 SC：未手动关闭、未过期，按价格降序。
   * **全插件唯一的"是否仍悬挂"判据**——浮层算显示窗时用的是同一条规则，改这里必须同步改
   * `SuperChatOverlay.computeWindow()`（见 docs/adr/0017）。
   */
  visible() {
    const now = Date.now() / 1000;
    const out = [];
    for (const it of this.items.values()) {
      if (this.closed.has(it.id)) continue;
      if (it.endTime && it.endTime <= now) continue;
      out.push(it);
    }
    out.sort((a, b) => b.price - a.price);
    return out;
  }

  /** 中止在途请求（超时看门狗与 stop() 共用） */
  _abort() {
    if (this._ctrl) {
      try { this._ctrl.abort(); } catch (_) {}
      this._ctrl = null;
    }
  }

  async poll() {
    if (!this.roomId || this._inflight) return;
    const room = this.roomId;
    this._inflight = true;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this._ctrl = ctrl;
    let timer = null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), this.timeout);
    const url = `${SuperChatFeed.API}?room_id=${encodeURIComponent(room)}`;
    let list = null;
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl ? ctrl.signal : undefined });
      const data = await res.json();
      if (data && data.code === 0 && data.data && Array.isArray(data.data.list)) {
        list = data.data.list;
      }
    } catch (_) {
      // 网络异常 / 超时中止：保留现有列表，等下一轮重试
    } finally {
      // 看门狗兜底：正常返回、抛错、超时中止一律走这里，_inflight 必然复位
      if (timer) clearTimeout(timer);
      if (this._ctrl === ctrl) this._ctrl = null;
      this._inflight = false;
    }
    // 迟到/过期的响应一律丢弃：期间已停轮询或换了房间，写进去会污染状态
    if (!list || !this._on || this.roomId !== room) return;

    const seen = new Set();
    for (const raw of list) {
      const it = SuperChatFeed.normalize(raw);
      if (!it) continue;
      seen.add(it.id);
      this.items.set(it.id, it);
    }
    // 接口中消失的 id 判为已移除（过期项也由此清出 items，无需再单独清扫）
    for (const id of Array.from(this.items.keys())) {
      if (!seen.has(id)) this.items.delete(id);
    }
    this._emit();
  }

  /** 归一化接口字段为渲染所需的最小集合 */
  static normalize(raw) {
    if (!raw || raw.id == null) return null;
    const u = raw.user_info || {};
    return {
      id: String(raw.id),
      uid: raw.uid,
      price: Number(raw.price) || 0,
      message: raw.message || '',
      uname: u.uname || '',
      face: u.face || '',
      guardLevel: Number(u.guard_level) || 0,
      startTime: Number(raw.start_time) || 0,
      endTime: Number(raw.end_time) || 0,
      bgColor: raw.background_color || '',
      bgBottomColor: raw.background_bottom_color || '',
      bgPriceColor: raw.background_price_color || '',
      fontColor: raw.font_color || ''
    };
  }

  _emit() {
    try {
      this.onUpdate(this.visible());
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  window.BVSuperChatFeed = SuperChatFeed;
}
