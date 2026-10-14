/** popup 面板逻辑 — 与 content script 通过 chrome.storage / runtime 消息通信 */
(() => {
  'use strict';

  const MEM_KEY = 'volumeBank.v1';
  const BLOCK_KEY = 'bv.blocklist.v1';   // 与 content/dislike-store.js 保持一致的存储键
  const SC_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const SC_DEFAULT = { enabled: true, position: 'top-right' };
  const FEEDBACK_MS = 2500;

  /** 页面情境三态（术语见 CONTEXT.md「页面情境」与 docs/adr/0019） */
  const CTX_LIVE = 'live';
  const CTX_VIDEO = 'video';
  const CTX_NONE = 'none';

  const $ = (id) => document.getElementById(id);
  const enableCheck = $('enabled');
  const scEnableCheck = $('scEnabled');
  const scPositionSel = $('scPosition');
  const blockHideCheck = $('blockHide');
  const statusRow = $('statusRow');
  const pageState = $('pageState');
  const upName = $('upName');
  const boostEl = $('boost');
  const countEl = $('count');
  const clearBtn = $('clearBtn');
  const blockCountEl = $('blockCount');
  const clearBlockBtn = $('clearBlockBtn');
  const ctxRows = document.querySelectorAll('[data-ctx]');

  let currentTabId = null;
  let currentCtx = CTX_NONE;
  let contextStatus = '';   // 情境状态行文案；B 站页且已就绪时为空（整行不存在）
  let feedbackTimer = 0;

  /**
   * 页面情境判定 —— 与 manifest 的 content_scripts.matches 同构，只认地址、
   * 不等 content script 应答，避免面板打开瞬间设置项忽隐忽现。
   */
  function pageContext(url) {
    let u;
    try { u = new URL(url || ''); } catch (_) { return CTX_NONE; }
    if (u.hostname === 'live.bilibili.com') return CTX_LIVE;
    if (u.hostname === 'search.bilibili.com') return CTX_VIDEO;
    if (u.hostname === 'www.bilibili.com' && /^\/(video|list)\//.test(u.pathname)) return CTX_VIDEO;
    return CTX_NONE;
  }

  /** 情境专属设置项的显隐：未在 B 站时不做任何过滤，全部显示 */
  function applyContext(ctx) {
    ctxRows.forEach((row) => {
      row.hidden = ctx !== CTX_NONE && row.dataset.ctx !== ctx;
    });
  }

  /** 统一状态行：文案为空即整行隐藏 */
  function setStatus(text) {
    pageState.textContent = text || '';
    statusRow.hidden = !text;
  }

  /** 操作反馈：顶替状态行约 2.5 秒，随后回落到情境状态 */
  function flashStatus(text) {
    setStatus(text);
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => setStatus(contextStatus), FEEDBACK_MS);
  }

  /** 记忆计数只报当前情境相关的那一半 */
  function countText(bank) {
    const total = Object.keys(bank).length;
    const live = Object.keys(bank).filter((k) => k.endsWith('.live')).length;
    const video = total - live;
    if (currentCtx === CTX_LIVE) return `${live} 条（直播 ${live}/256）`;
    if (currentCtx === CTX_VIDEO) return `${video} 条（视频 ${video}/1024）`;
    return `${total} 条（视频 ${video}/1024 · 直播 ${live}/256）`;
  }

  async function loadGlobal() {
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || { enabled: true, bank: {} };
    enableCheck.checked = !!data.enabled;
    const sc = Object.assign({}, SC_DEFAULT, data.sc);
    scEnableCheck.checked = sc.enabled !== false;
    scPositionSel.value = SC_POSITIONS.indexOf(sc.position) >= 0 ? sc.position : SC_DEFAULT.position;
    scPositionSel.disabled = !scEnableCheck.checked;
    countEl.textContent = countText(data.bank || {});
    return data;
  }

  /** 读取本地屏蔽清单：条数与「彻底隐藏」开关（与页面上的 content script 共用同一 key） */
  async function loadBlocklist() {
    const d = await chrome.storage.local.get(BLOCK_KEY);
    const b = d[BLOCK_KEY] || {};
    const videos = Object.keys(b.videos || {}).length;
    const ups = Object.keys(b.ups || {}).length;
    blockHideCheck.checked = b.hide === true;
    blockCountEl.textContent = `${videos + ups} 条（视频 ${videos} · UP主 ${ups}）`;
  }

  async function queryActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function refreshState() {
    clearTimeout(feedbackTimer);
    const tab = await queryActiveTab();
    currentCtx = pageContext(tab && tab.url);
    applyContext(currentCtx);
    await loadBlocklist();
    await loadGlobal();

    // 未在 B 站（或拿不到标签页）：不做任何过滤，全部设置项可见
    if (currentCtx === CTX_NONE || !tab || !tab.id) {
      currentTabId = null;
      upName.textContent = '—';
      boostEl.textContent = enableCheck.checked ? '—' : '已停用';
      contextStatus = '未在 B 站视频/直播页';
      setStatus(contextStatus);
      return;
    }

    currentTabId = tab.id;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
      if (res && res.ok) {
        upName.textContent = res.name || (res.mid ? `UID ${res.mid}` : '无法识别');
        boostEl.textContent = res.engine.muted ? '已静音' : `${res.engine.boost}%`;
        contextStatus = '';
        setStatus('');
        return;
      }
    } catch (_) {
      // content script 未注入（页面刚加载等），保留默认提示
    }
    upName.textContent = '—';
    boostEl.textContent = '—';
    contextStatus = '尚未就绪，请刷新页面';
    setStatus(contextStatus);
  }

  enableCheck.addEventListener('change', async () => {
    // 先取用户意图：原实现先调 loadGlobal()，它会把复选框刷回存储里的旧值，
    // 导致 data.enabled 读到的永远是旧状态 —— 总开关表现为"点了没反应"（已修复）
    const next = enableCheck.checked;
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || { enabled: true, bank: {} };
    data.enabled = next;
    await chrome.storage.local.set({ [MEM_KEY]: data });
    boostEl.textContent = next ? '—' : '已停用';
  });

  /** 写入醒目留言浮层配置（只动 sc 字段，不碰音量记忆） */
  async function saveSc(patch) {
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || {};
    data.sc = Object.assign({}, SC_DEFAULT, data.sc, patch);
    await chrome.storage.local.set({ [MEM_KEY]: data });
  }

  scEnableCheck.addEventListener('change', async () => {
    scPositionSel.disabled = !scEnableCheck.checked;
    await saveSc({ enabled: scEnableCheck.checked });
  });

  scPositionSel.addEventListener('change', async () => {
    await saveSc({ position: scPositionSel.value });
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('确定清空全部音量记忆？')) return;
    const d = await chrome.storage.local.get(MEM_KEY);
    const prev = d[MEM_KEY] || {};
    // 只清音量记忆，保留总开关与醒目留言配置
    await chrome.storage.local.set({
      [MEM_KEY]: { version: 2, enabled: enableCheck.checked, bank: {}, sc: prev.sc }
    });
    await loadGlobal();
    flashStatus('已清空记忆');
  });

  /** 切换「彻底隐藏已屏蔽内容」（写存储后由 content script 的 storage 监听即时生效） */
  blockHideCheck.addEventListener('change', async () => {
    const d = await chrome.storage.local.get(BLOCK_KEY);
    const b = Object.assign({ version: 1, videos: {}, ups: {} }, d[BLOCK_KEY]);
    b.hide = blockHideCheck.checked;
    await chrome.storage.local.set({ [BLOCK_KEY]: b });
  });

  clearBlockBtn.addEventListener('click', async () => {
    if (!confirm('确定清空全部屏蔽记录？\n清空后此前标记过的内容会重新出现（B 站服务端已收到的降权反馈不受影响）。')) return;
    const d = await chrome.storage.local.get(BLOCK_KEY);
    const hide = (d[BLOCK_KEY] || {}).hide === true;
    // 只清屏蔽记录，保留「彻底隐藏」开关偏好
    await chrome.storage.local.set({ [BLOCK_KEY]: { version: 1, hide, videos: {}, ups: {} } });
    await loadBlocklist();
    flashStatus('已清空屏蔽记录');
  });

  // 打开时与窗口聚焦时刷新
  document.addEventListener('DOMContentLoaded', refreshState);
  window.addEventListener('focus', refreshState);
})();