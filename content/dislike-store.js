/**
 * 「不感兴趣」屏蔽清单 — chrome.storage.local
 *
 * 与 volumeBank.v1 分离的独立 key：语义独立（音量记忆 vs 内容屏蔽），
 * 不会被音量记忆的 v1→v2 迁移与 `.video/.live` 分桶逻辑波及。
 *
 * 结构：
 * {
 *   version: 1,
 *   hide: false,                     // false=已屏蔽卡片保持已反馈态；true=整块不出现
 *   videos: { "<bvid>": { t, r } },  // 视频级屏蔽（r = 上报时的 reason_id）
 *   ups:    { "<mid>":  { t, n } }   // UP 主级屏蔽（n = 名称，便于展示与撤销）
 * }
 *
 * 为什么需要它（见 docs/adr/0016）：
 * 官方 `feedback/dislike` 只喂给 B 站**个性化推荐流**；搜索页结果（查询相关性）
 * 与详情页相关推荐（内容相似度）都不消费该信号，且其生效有服务端延迟。
 * 故「标记过的不该再打扰我」这件事必须由本地保证：上报照旧（信号），
 * 屏蔽清单负责呈现（过滤）。二者是两层，不要混在一处。
 *
 * 写操作走串行队列，消除多个"读-改-写"副本互相覆盖的竞态（同 memory.js）。
 * 内存镜像 `_cache` 供 refresh() 同步查询，避免每张卡片一次异步读盘；
 * 外部改动（popup 清空）由 content.js 监听 storage.onChanged 调 invalidate() 失效。
 */
const BLOCK_KEY = 'bv.blocklist.v1';
const MAX_BLOCK_VIDEOS = 2048;   // 视频级屏蔽上限
const MAX_BLOCK_UPS = 512;       // UP 主级屏蔽上限
const BLOCK_DEFAULT_HIDE = false;

const DislikeStore = {
  _q: Promise.resolve(),
  _cache: null,

  _enqueue(task) {
    const p = this._q.then(task, task);
    this._q = p.catch(() => {});
    return p;
  },

  /** 归一化：容忍缺字段与脏数据，永远返回可直接使用的完整结构 */
  _norm(data) {
    const d = data && typeof data === 'object' ? data : {};
    return {
      version: 1,
      hide: typeof d.hide === 'boolean' ? d.hide : BLOCK_DEFAULT_HIDE,
      videos: d.videos && typeof d.videos === 'object' ? d.videos : {},
      ups: d.ups && typeof d.ups === 'object' ? d.ups : {}
    };
  },

  /** 从存储加载并刷新内存镜像 */
  async load() {
    let raw;
    try {
      const d = await chrome.storage.local.get(BLOCK_KEY);
      raw = d[BLOCK_KEY];
    } catch (_) {
      // 读盘失败退化为一本空清单：功能照常可用（只是暂时不过滤），
      // 绝不因为存储异常让整条「不感兴趣」入口消失
      raw = null;
    }
    this._cache = this._norm(raw);
    return this._cache;
  },

  /** 惰性加载：首个查询到来时才读盘 */
  async ensure() {
    if (!this._cache) await this.load();
    return this._cache;
  },

  /** 内存镜像失效（storage.onChanged 后调用，下次查询会重新读盘） */
  invalidate() {
    this._cache = null;
  },

  /** 内存镜像是否已就绪（未就绪时 refresh 不应注入，避免命中清单的卡先闪一下 ⋮） */
  get ready() {
    return !!this._cache;
  },

  // ---- 同步查询（供 refresh 逐卡判定） ----

  isVideoBlocked(bvid) {
    return !!(this._cache && bvid && this._cache.videos[bvid]);
  },

  isUpBlocked(mid) {
    return !!(this._cache && mid && this._cache.ups[String(mid)]);
  },

  /**
   * 卡片的屏蔽判定：返回命中的 reason_id（1=内容，4=UP主），未命中返回 null。
   * 视频级优先于 UP 主级——同一张卡若两者都命中，按"这个内容"呈现。
   */
  match(info) {
    if (!this._cache || !info) return null;
    const v = info.bvid && this._cache.videos[info.bvid];
    if (v) return v.r || 1;
    const u = info.upMid && this._cache.ups[String(info.upMid)];
    if (u) return 4;
    return null;
  },

  get hide() {
    return !!(this._cache && this._cache.hide);
  },

  stats() {
    const c = this._cache;
    return c ? { videos: Object.keys(c.videos).length, ups: Object.keys(c.ups).length } : { videos: 0, ups: 0 };
  },

  // ---- 写操作 ----

  blockVideo(bvid, reasonId) {
    if (!bvid) return Promise.resolve();
    return this._enqueue(async () => {
      const data = await this.load();
      data.videos[bvid] = { t: Date.now(), r: reasonId || 1 };
      this._evict(data);
      await chrome.storage.local.set({ [BLOCK_KEY]: data });
      this._cache = data;
    });
  },

  blockUp(mid, name) {
    if (!mid) return Promise.resolve();
    return this._enqueue(async () => {
      const data = await this.load();
      data.ups[String(mid)] = { t: Date.now(), n: name || (data.ups[String(mid)] || {}).n || '' };
      this._evict(data);
      await chrome.storage.local.set({ [BLOCK_KEY]: data });
      this._cache = data;
    });
  },

  unblockVideo(bvid) {
    if (!bvid) return Promise.resolve();
    return this._enqueue(async () => {
      const data = await this.load();
      if (!data.videos[bvid]) return;
      delete data.videos[bvid];
      await chrome.storage.local.set({ [BLOCK_KEY]: data });
      this._cache = data;
    });
  },

  unblockUp(mid) {
    if (!mid) return Promise.resolve();
    return this._enqueue(async () => {
      const data = await this.load();
      if (!data.ups[String(mid)]) return;
      delete data.ups[String(mid)];
      await chrome.storage.local.set({ [BLOCK_KEY]: data });
      this._cache = data;
    });
  },

  setHide(on) {
    return this._enqueue(async () => {
      const data = await this.load();
      data.hide = !!on;
      await chrome.storage.local.set({ [BLOCK_KEY]: data });
      this._cache = data;
    });
  },

  /** 清空全部屏蔽记录（保留 hide 开关偏好） */
  clear() {
    return this._enqueue(async () => {
      const data = await this.load();
      const next = this._norm({ hide: data.hide });
      await chrome.storage.local.set({ [BLOCK_KEY]: next });
      this._cache = next;
    });
  },

  /** 按上限 LRU 淘汰：视频级与 UP 主级各自独立配额 */
  _evict(data) {
    const collect = (bucket, quota) => {
      const keys = Object.keys(bucket);
      if (keys.length <= quota) return;
      keys.sort((a, b) => (bucket[a].t || 0) - (bucket[b].t || 0));
      let over = keys.length - quota;
      for (const k of keys) {
        if (over-- <= 0) break;
        delete bucket[k];
      }
    };
    collect(data.videos, MAX_BLOCK_VIDEOS);
    collect(data.ups, MAX_BLOCK_UPS);
  }
};

if (typeof window !== 'undefined') {
  window.BVBoostDislikeStore = DislikeStore;
}
