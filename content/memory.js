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
 * 上限 256 条，超出按 lastUsed 最旧淘汰（LRU）。
 * 记忆分桶：同一 UP 主视频/直播各一条（docs/adr/0002 分层模型配套）。
 */
const MEM_KEY = 'volumeBank.v1';
const MAX_ENTRIES = 256;
const TOUCH_INTERVAL = 60 * 1000; // LRU touch 节流：访问保活的最小写盘间隔

const Memory = {
  async load() {
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || {};
    if (!data.bank) data.bank = {};
    if (typeof data.enabled !== 'boolean') data.enabled = true;
    return data;
  },

  key(mid, type) { return `${mid}.${type}`; },

  /** 读取某 UP 主的记忆增益，无则返回 null；命中时刷新 lastUsed（LRU touch） */
  async getGain(mid, type) {
    const data = await this.load();
    const rec = data.bank[this.key(mid, type)];
    if (!rec) return null;
    // "访问即保活"：经常观看（即使从不改音量）的 UP 不被 LRU 挤出；
    // touch 节流 60s，避免高频写盘
    if (Date.now() - (rec.t || 0) > TOUCH_INTERVAL) {
      rec.t = Date.now();
      await chrome.storage.local.set({ [MEM_KEY]: data });
    }
    return rec.g;
  },

  /** 写入/更新记忆（防抖由调用方处理） */
  async setGain(mid, type, gain) {
    const data = await this.load();
    data.bank[this.key(mid, type)] = { g: gain, t: Date.now() };
    this._evict(data);
    await chrome.storage.local.set({ [MEM_KEY]: data });
  },

  async setEnabled(val) {
    const data = await this.load();
    data.enabled = !!val;
    await chrome.storage.local.set({ [MEM_KEY]: data });
  },

  /** LRU 淘汰：总数超 256 时删除最旧一条 */
  _evict(data) {
    const keys = Object.keys(data.bank);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => (data.bank[a].t || 0) - (data.bank[b].t || 0));
      const oldest = keys[0];
      if (oldest) delete data.bank[oldest];
    }
  },

  async clear() {
    await chrome.storage.local.set({ [MEM_KEY]: { enabled: true, bank: {} } });
  }
};

if (typeof window !== 'undefined') {
  window.BVBoostMemory = Memory;
  window.BV_BOOST_MAX_ENTRIES = MAX_ENTRIES;
}