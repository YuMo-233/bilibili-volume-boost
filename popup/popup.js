/** popup 面板逻辑 — 与 content script 通过 chrome.storage / runtime 消息通信 */
(() => {
  'use strict';

  const MEM_KEY = 'volumeBank.v1';

  const $ = (id) => document.getElementById(id);
  const enableCheck = $('enabled');
  const pageState = $('pageState');
  const upName = $('upName');
  const boostEl = $('boost');
  const countEl = $('count');
  const clearBtn = $('clearBtn');

  let currentTabId = null;

  async function loadGlobal() {
    const d = await chrome.storage.local.get(MEM_KEY);
    const data = d[MEM_KEY] || { enabled: true, bank: {} };
    enableCheck.checked = !!data.enabled;
    const bank = data.bank || {};
    const nv = Object.keys(bank).filter((k) => k.endsWith('.live')).length;
    const count = Object.keys(bank).length;
    countEl.textContent = `${count} 条（视频 ${count - nv}/1024 · 直播 ${nv}/256）`;
    return data;
  }

  async function queryActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  async function refreshState() {
    const data = await loadGlobal();
    const tab = await queryActiveTab();
    if (!tab || !tab.id) return;

    // 只对 B 站页面查询 content script 状态
    if (tab.url && /bilibili\.com/.test(tab.url)) {
      currentTabId = tab.id;
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
        if (res && res.ok) {
          pageState.textContent = res.type === 'live' ? '直播页' : '视频页';
          upName.textContent = res.name || (res.mid ? `UID ${res.mid}` : '无法识别');
          boostEl.textContent = res.engine.muted ? '已静音' : `${res.engine.boost}%`;
          return;
        }
      } catch (_) {
        // content script 未注入（页面刚加载等），保留默认提示
      }
      pageState.textContent = '尚未就绪，请刷新页面';
      upName.textContent = '—';
      boostEl.textContent = '—';
    } else {
      pageState.textContent = '未在 B 站视频/直播页';
      upName.textContent = '—';
      boostEl.textContent = enableCheck.checked ? '—' : '已停用';
    }
  }

  enableCheck.addEventListener('change', async () => {
    const data = await loadGlobal();
    data.enabled = enableCheck.checked;
    await chrome.storage.local.set({ [MEM_KEY]: data });
    boostEl.textContent = enableCheck.checked ? '—' : '已停用';
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('确定清空全部音量记忆？')) return;
    await chrome.storage.local.set({ [MEM_KEY]: { enabled: enableCheck.checked, bank: {} } });
    loadGlobal();
    pageState.textContent = '已清空记忆';
  });

  // 打开时与窗口聚焦时刷新
  document.addEventListener('DOMContentLoaded', refreshState);
  window.addEventListener('focus', refreshState);
})();