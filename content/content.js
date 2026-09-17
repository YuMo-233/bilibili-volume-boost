/**
 * 主逻辑编排 — ISOLATED world
 *
 * 职责：
 * 1. 页面类型判定（视频页 / 直播页）
 * 2. UP 主识别（MAIN world 事件优先，DOM 解析兜底）
 * 3. 侦听 video 元素出现/重建，挂载音频增强引擎（重挂生命周期）
 * 4. 快捷键（Alt 组合键，防误触）
 * 5. UP 主记忆的读取/应用/写入（防抖 + LRU）
 * 6. popup 状态查询
 */
(() => {
  'use strict';

  // ---- 基础状态 ----
  const engine = new AudioEngine();
  let current = { mid: null, type: detectType(), name: '' }; // 当前 UP 主
  let enabled = true;       // 插件总开关（运行时镜像）
  let lastPersist = 0;
  const persistDebounce = 300;

  function detectType() {
    return location.hostname.indexOf('live.') === 0 || location.hostname === 'live.bilibili.com'
      ? 'live' : 'video';
  }

  // ---- UP 主识别 ----
  const VIDEO_SELECTORS = '#bilibili-player video, .bpx-player-video video, .bilibili-player-video video, video';
  const hasUpEvent = { video: false, live: false };

  function onSniffEvent(ev) {
    const d = ev.detail;
    if (!d || !d.mid) return;
    setCurrent(d.mid, d.type, d.name);
    hasUpEvent[d.type] = true;
  }

  function setCurrent(mid, type, name) {
    const changed = current.mid !== mid || current.type !== type;
    current = { mid: String(mid), type, name: name || current.name };
    if (changed) applyMemoryGain(); // 切到新 UP 主时套用其记忆
  }

  /** DOM 兜底解析 mid（MAIN world 事件未送达时） */
  function domSniff() {
    if (hasUpEvent[current.type] && current.mid) return;
    try {
      if (current.type === 'video') {
        const a = document.querySelector('.up-info-container a[href*="space.bilibili.com"], a[href*="space.bilibili.com"][title]');
        const m = a && a.href.match(/space\.bilibili\.com\/(\d+)/);
        if (m) setCurrent(m[1], 'video', (a && a.getAttribute('title')) || '');
      } else {
        // 新版直播页无 space 链接（实测），room-owner-username 亦无 uid；
        // DOM 兜底退化为"房间号键"（同一房间长期对应同一主播，保证记忆稳定）
        const a = document.querySelector('.anchor-info a[href*="space.bilibili.com"], a[href*="space.bilibili.com"]');
        const m = a && a.href.match(/space\.bilibili\.com\/(\d+)/);
        const m2 = location.pathname.match(/^\/(\d+)/);
        const nameEl = document.querySelector('.room-owner-username');
        const name = nameEl ? nameEl.textContent.trim() : '';
        if (m) setCurrent(m[1], 'live', name || (a && a.getAttribute('title')) || '');
        else if (m2) setCurrent('room:' + m2[1], 'live', name);
      }
    } catch (_) {}
  }

  // ---- 记忆应用 ----
  // lastApplied：记忆已应用标记（"mid|type"），保证每个主播只应用一次且不被时序捅漏
  let lastApplied = null;

  async function applyMemoryGain(force) {
    if (!current.mid || !enabled || !engine.engaged) return; // 引擎未挂载则等下一轮 interval
    const probe = `${current.mid}|${current.type}`;
    if (!force && lastApplied === probe) return;
    try {
      const memo = await Memory.getGain(current.mid, current.type);
      if (memo != null) {
        engine.setBoost(memo);
        uiSync();
      }
      lastApplied = probe; // 仅在查询成功（引擎已就绪）后置位，避免提前置位导致永不应用
    } catch (_) {}
  }

  /** 防抖写记忆；快照当次 mid/type，避免防抖回调执行时已切到其他主播而写错 key */
  function persistBoost() {
    if (!current.mid || !enabled) return;
    const snapMid = current.mid;
    const snapType = current.type;
    const doWrite = () => Memory.setGain(snapMid, snapType, engine.boost).catch(() => {});
    const now = Date.now();
    if (now - lastPersist < persistDebounce) {
      clearTimeout(persistBoost._t);
      persistBoost._t = setTimeout(doWrite, persistDebounce);
      return;
    }
    lastPersist = now;
    doWrite();
  }

  // ---- UI 同步 ----
  let ui = null;
  function uiSync() { if (ui && ui.isMounted()) ui._sync(); }

  function ensureUI() {
    if (enabled && (!ui || !ui.isMounted())) {
      if (!ui) ui = new BoostUI(engine, (p) => {
        engine.setBoost(p);
        ui._sync();
        persistBoost();
      });
      if (!ui.mount(current.type)) return; // 控制栏尚未渲染，等下次 observer 再试
    }
    // 音量按钮出现后把增益条挪到它"旁边"（播放器初始化时序兜底）
    if (ui) ui.relocate(current.type);
    uiSync();
  }

  // ---- 视频挂载 / 重挂 ----
  function findVideo() {
    const sel = current.type === 'video'
      ? '#bilibili-player video, .bpx-player-video video, .bilibili-player-video video'
      : '.web-player-video-container video, .live-player-video video, .player-container video, video';
    return document.querySelector(sel);
  }

  let lastVideo = null;
  function bindVideo() {
    if (!enabled) return;
    const video = findVideo();
    if (!video) return;
    if (video === lastVideo && engine.engaged) {
      engine.resumeOnUserGesture(); // 播放中手势恢复
      applyMemoryGain();            // mid 事件可能晚于引擎挂载到达，这里兜底应用一次
      return;
    }
    if (engine.attach(video)) {
      lastVideo = video;
      ensureUI();
      applyMemoryGain();
    }
  }

  function onDomChange() {
    domSniff();
    bindVideo();
    ensureUI();
  }

  // ---- 快捷键 ----
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  const digitBoost = (d) => Math.min(500, 100 + d * 40);  // Alt+0→100% ... Alt+9→460%

  function onKeyDown(e) {
    if (!enabled || isEditable(e.target)) return; // 防误触：输入框内放行
    if (!e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        engine.setBoost(engine.boost + 10);
        showToast(`增益 ${engine.boost}%`);
        persistBoost(); uiSync();
        break;
      case 'ArrowDown':
        e.preventDefault();
        engine.setBoost(engine.boost - 10);
        showToast(`增益 ${engine.boost}%`);
        persistBoost(); uiSync();
        break;
      case 'm': case 'M':
        e.preventDefault();
        engine.toggleMute();
        showToast(engine.muted ? '已静音' : `增益 ${engine.boost}%`);
        persistBoost(); uiSync();
        break;
    }
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      engine.setBoost(digitBoost(Number(e.key)));
      showToast(`增益 ${engine.boost}%`);
      persistBoost(); uiSync();
    }
  }

  let toastTarget = null;
  function showToast(text) {
    if (ui && ui.isMounted()) { ui.toast(text); return; }
    if (!toastTarget) {
      toastTarget = document.createElement('div');
      toastTarget.id = 'bv-boost-toast';
      toastTarget.style.cssText = 'position:fixed;left:50%;bottom:14%;transform:translateX(-50%);padding:6px 14px;border-radius:6px;background:rgba(0,0,0,.72);color:#fff;font:13px/1.4 sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity .25s;';
      document.body.appendChild(toastTarget);
    }
    toastTarget.textContent = text;
    toastTarget.style.opacity = '1';
    clearTimeout(toastTarget._t);
    toastTarget._t = setTimeout(() => { toastTarget.style.opacity = '0'; }, 1200);
  }

  // ---- 总开关联动 ----
  function syncEnabled(val) {
    enabled = !!val;
    if (!enabled) {
      engine.teardown();
      if (ui) ui.unmount();
    } else {
      bindVideo();
    }
  }

  // ---- 初始化 ----
  async function init() {
    // 恢复总开关状态
    try {
      const data = await Memory.load();
      enabled = data.enabled;
    } catch (_) {}

    window.addEventListener('bv_boost_up', onSniffEvent, false);
    document.addEventListener('pointerdown', () => engine.resumeOnUserGesture(), true);
    window.addEventListener('keydown', onKeyDown, true);

    // 侦听 video 元素重建与 DOM 变化（B 站切清晰度/切流会替换 video）
    const mo = new MutationObserver(() => onDomChange());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 首次绑定（video 已存在时）
    domSniff();
    bindVideo();
    ensureUI();

    // 存储变化联动（popup 切换总开关 / 清空记忆）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[MEM_KEY]) {
        const nv = changes[MEM_KEY].newValue || {};
        syncEnabled(typeof nv.enabled === 'boolean' ? nv.enabled : true);
      }
    });

    // popup 查询当前页状态
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'getState') {
        sendResponse({
          type: current.type,
          mid: current.mid,
          name: current.name,
          engine: engine.getState(),
          enabled,
          ok: true
        });
      }
      return true;
    });

    // 周期性兜底：SPA 内切换视频（URL/bvid 变化）时重新识别；引擎/主播就绪后补应用记忆
    setInterval(() => {
      domSniff();
      bindVideo();
      ensureUI();
      applyMemoryGain();
    }, 2000);
  }

  init();
})();