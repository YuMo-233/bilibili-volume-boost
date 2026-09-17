/**
 * UP 主记忆存储 — chrome.storage.local
 *
 * 结构（version 1）：
 * {
 *   enabled: true,                    // 总开关
 *   bank: {
 *     "<mid>.<video|live>": { g: <增益 100-500>, t: <最后使用时间戳> }
 *   }
 * }
 * 配额：视频记忆上限 1024 条、直播记忆上限 256 条（按类型分开，超出各自配额按
 * lastUsed 最旧淘汰）。记忆分桶：同一 UP 主视频/直播各一条（docs/adr/0002 分层模型配套）。
 */
const MEM_KEY = 'volumeBank.v1';
const MAX_VIDEO = 1024;             // 视频页记忆上限（用户指定）
const MAX_LIVE = 256;               // 直播记忆上限（用户指定）
const TOUCH_INTERVAL = 60 * 1000;   // LRU touch 节流：访问保活的最小写盘间隔

const Memory = {
  /** 写操作串行队列：消除多个"读-改-写"副本互相覆盖的竞态 */
  _q: Promise.resolve(),
  _enqueue(task) {
    const p = this._q.then(task, task);
    this._q = p.catch(() => {});
    return p;
  },

  async load() {
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || {};
    if (!data.bank) data.bank = {};
    if (typeof data.enabled !== 'boolean') data.enabled = true;
    // v1 → v2 迁移：旧增益是幅值百分比(100-500)，改为感知刻度(100-263)，
    // 换算遵循 Stevens 幂律：新L = 100·(旧g/100)^0.6（见 docs/adr/0004）
    if (!data.version || data.version < 2) {
      let changed = false;
      for (const k of Object.keys(data.bank)) {
        const rec = data.bank[k];
        if (rec && typeof rec.g === 'number' && rec.g > 263) {
          rec.g = Math.max(100, Math.min(263, Math.round(100 * Math.pow(rec.g / 100, 0.6))));
          changed = true;
        }
      }
      data.version = 2;
      if (changed) {
        this._q = this._q.then(() => chrome.storage.local.set({ [MEM_KEY]: data })).catch(() => {});
      }
    }
    return data;
  },

  key(mid, type) { return `${mid}.${type}`; },

  /** 读取某 UP 主的记忆增益，无则返回 null；命中时刷新 lastUsed（LRU touch） */
  getGain(mid, type) {
    const now = Date.now();
    return this._enqueue(async () => {
      const data = await this.load();
      const rec = data.bank[this.key(mid, type)];
      if (!rec) return null;
      // "访问即保活"：经常观看（即使从不改音量）的 UP 不被 LRU 挤出；touch 节流 60s
      if (now - (rec.t || 0) > TOUCH_INTERVAL) {
        rec.t = now;
        await chrome.storage.local.set({ [MEM_KEY]: data });
      }
      return rec.g;
    });
  },

  /** 写入/更新记忆（防抖由调用方处理） */
  setGain(mid, type, gain) {
    return this._enqueue(async () => {
      const data = await this.load();
      data.bank[this.key(mid, type)] = { g: gain, t: Date.now() };
      this._evict(data);
      await chrome.storage.local.set({ [MEM_KEY]: data });
    });
  },

  async setEnabled(val) {
    const data = await this.load();
    data.enabled = !!val;
    await chrome.storage.local.set({ [MEM_KEY]: data });
  },

  /** 判断记录类型：直播键形如 "uid.live" / "room:xxx.live"；其余视为视频键 */
  typeOf(key) {
    return key.endsWith('.live') ? 'live' : 'video';
  },

  /** 按类型分配额 LRU 淘汰：各自超限时删除该类中 lastUsed 最旧的一条 */
  _evict(data) {
    const collect = (keys, quota) => {
      if (keys.length <= quota) return;
      keys.sort((a, b) => (data.bank[a].t || 0) - (data.bank[b].t || 0));
      const oldest = keys[0];
      if (oldest) delete data.bank[oldest];
    };
    const keys = Object.keys(data.bank);
    collect(keys.filter((k) => this.typeOf(k) === 'video'), MAX_VIDEO);
    collect(keys.filter((k) => this.typeOf(k) === 'live'), MAX_LIVE);
  },

  async clear() {
    await chrome.storage.local.set({ [MEM_KEY]: { enabled: true, bank: {} } });
  }
};

if (typeof window !== 'undefined') {
  window.BVBoostMemory = Memory;
  window.BV_BOOST_MAX_VIDEO = MAX_VIDEO;
  window.BV_BOOST_MAX_LIVE = MAX_LIVE;
}