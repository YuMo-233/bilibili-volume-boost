/**
 * 主逻辑编排 — ISOLATED world
 *
 * 职责：
 * 1. 页面类型判定（视频页 / 直播页）
 * 2. UP 主识别（MAIN world 事件优先，DOM 解析兜底）
 * 3. 侦听 video 元素出现/重建，挂载音频增强引擎（重挂生命周期）
 * 4. 快捷键（Alt 组合键，防误触）
 * 5. UP 主记忆的读取/应用/写入（防抖 + LRU）
 * 6. 醒目留言浮层（仅直播页）：轮询取数 + 全屏显隐（docs/adr/0005）
 * 7. popup 状态查询
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

  /** 搜索页只跑「不感兴趣」卡片入口，不介入播放器与音量 UI */
  const SEARCH_ONLY = location.hostname === 'search.bilibili.com';

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
    } catch (e) {
      // 诊断输出：自动化定位记忆读取异常
      document.documentElement.setAttribute('data-bv-dbg-err', String((e && (e.stack || e.message)) || e));
    }
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
    if (SEARCH_ONLY) return; // 搜索页无播放器控制栏，跳过音量 UI
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

  // ---- 醒目留言浮层（仅直播页，见 docs/adr/0005） ----
  let scFeed = null;
  let scOverlay = null;
  let scConfig = { enabled: true, position: 'top-right' };

  /**
   * 直播间号（URL 首段数字）。
   * ⚠ 这可能是**短号**：直播接口只认真实房间号，短号会让请求直接失败
   * （实测 getMessageList?room_id=短号 → code:-1「系统繁忙」），
   * 故喂给取数前必须先经 realRoomId() 换算。
   */
  function liveRoomId() {
    const m = location.pathname.match(/^\/(\d+)/);
    return m ? m[1] : null;
  }

  let resolvedPath = null;   // 已换算的路径号
  let resolvedRoom = null;   // 换算出的真实房间号

  /** 短号 → 真实房间号（room_init，免登录） */
  async function fetchRealRoomId(pathId) {
    try {
      const res = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(pathId)}`, {
        credentials: 'include'
      });
      const json = await res.json();
      const real = json && json.code === 0 && json.data && json.data.room_id;
      return real ? String(real) : pathId;
    } catch (_) {
      return pathId;   // 失败时退回原值，行为与换算前一致
    }
  }

  /**
   * 当前房间的真实房间号。首次调用触发换算（期间返回 null），
   * 换算完成后自行驱动一次 syncSC 把取数接着启动。
   */
  function realRoomId() {
    const pathId = liveRoomId();
    if (!pathId) return null;
    if (resolvedPath === pathId) return resolvedRoom;
    resolvedPath = pathId;
    resolvedRoom = null;
    fetchRealRoomId(pathId).then((real) => {
      if (resolvedPath !== pathId) return;   // 换算期间又换了房，丢弃结果
      resolvedRoom = real;
      syncSC();
    });
    return null;
  }

  function scActive() {
    return current.type === 'live' && scConfig.enabled && !!liveRoomId();
  }

  /**
   * 保持浮层挂载 + 轮询运行，并按全屏状态显隐。
   * 仅在沉浸全屏（Fullscreen API）下显示：全屏元素只渲染自身子树，
   * 故浮层必须注入播放器内才可见（网页全屏/普通状态不显示，避免与原生公屏 SC 重复）。
   */
  function syncSC() {
    if (!scActive()) {
      if (scFeed && scFeed.running) scFeed.stop();
      if (scOverlay) scOverlay.hide();
      return;
    }
    if (!scFeed) {
      scFeed = new SuperChatFeed({
        onUpdate: (list) => { if (scOverlay) scOverlay.render(list); }
      });
    }
    if (!scOverlay) {
      scOverlay = new SuperChatOverlay((id) => scFeed.close(id));
    }
    scOverlay.setPosition(scConfig.position);
    if (!scOverlay.isMounted()) scOverlay.mount(); // 播放器重建后自动重挂
    // 接口只认真实房间号：换算完成前先不启动取数，避免用短号整轮报错
    const room = realRoomId();
    if (room) {
      scFeed.setRoom(room);
      if (!scFeed.running) scFeed.start();
    }
    if (document.fullscreenElement) scOverlay.show();
    else scOverlay.hide();
  }

  function scState() {
    return {
      enabled: scConfig.enabled,
      position: scConfig.position,
      showing: !!(scOverlay && scOverlay.isShowing()),
      count: scFeed ? scFeed.visible().length : 0
    };
  }

  // ---- 相关推荐「不感兴趣」（仅视频详情页，见 docs/adr/0008） ----
  const dislike = new BoostDislike();

  function syncDislike() {
    // 总开关关闭时一并撤下注入（本功能无独立开关，随总开关联动）
    if (!enabled) {
      if (dislike._running) dislike.stop();
      return;
    }
    if (current.type === 'video') {
      if (!dislike._running) dislike.start();
      dislike.refresh(); // 新增卡片注入 / 失效卡片清理（含未登录与去重判定）
    } else if (dislike._running) {
      dislike.stop();
    }
  }

  function dislikeState() {
    return {
      running: dislike._running,
      loggedIn: dislike.isLoggedIn(),
      cards: dislike._cards.size,
      reported: Array.from(dislike._reported),
      toggle: !!(dislike._toggle && dislike._toggle.isMounted())
    };
  }

  // ---- 视频挂载 / 重挂 ----
  function findVideo() {
    const sel = current.type === 'video'
      ? '#bilibili-player video, .bpx-player-video video, .bilibili-player-video video'
      : '.web-player-video-container video, .live-player-video video, .player-container video, video';
    return document.querySelector(sel);
  }

  let lastVideo = null;
  let attachRetries = 0;   // attach 失败（多为媒体尚无音轨）时的短促重试计数
  function bindVideo() {
    if (SEARCH_ONLY) return; // 搜索页不接管播放器
    if (!enabled) return;
    const video = findVideo();
    if (!video) return;
    if (video !== lastVideo) attachRetries = 0;
    if (video === lastVideo && engine.engaged) {
      engine.resumeOnUserGesture(); // 播放中手势恢复
      applyMemoryGain();            // mid 事件可能晚于引擎挂载到达，这里兜底应用一次
      return;
    }
    if (engine.attach(video)) {
      lastVideo = video;
      attachRetries = 0;
      ensureUI();
      applyMemoryGain();
      return;
    }
    // 挂载失败（多为媒体尚无音轨）：短促重试，避免干等 2s 轮询导致起播无增益
    if (attachRetries < 10) {
      attachRetries++;
      clearTimeout(bindVideo._t);
      bindVideo._t = setTimeout(() => { bindVideo(); }, 120);
    }
  }

  function onDomChange() {
    domSniff();
    bindVideo();
    ensureUI();
    syncDislike();
  }

  // ---- 快捷键 ----
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  // Alt+0→50% ... Alt+1→100%，其后每档 +50%，Alt+9→500%（感知刻度十档锚点）
  const digitBoost = (d) => (d === 0 ? 50 : 100 + (d - 1) * 50);

  function onKeyDown(e) {
    if (SEARCH_ONLY) return; // 搜索页不启用音量快捷键
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
    syncDislike();
  }

  // ---- 初始化 ----
  async function init() {
    // 恢复总开关与醒目留言配置
    try {
      const data = await Memory.load();
      enabled = data.enabled;
      if (data.sc) scConfig = data.sc;
    } catch (_) {}

    window.addEventListener('bv_boost_up', onSniffEvent, false);
    document.addEventListener('pointerdown', () => engine.resumeOnUserGesture(), true);
    window.addEventListener('keydown', onKeyDown, true);
    // 进出沉浸全屏 → 醒目留言浮层显隐（只监听，不介入全屏逻辑，见 docs/adr/0003）
    document.addEventListener('fullscreenchange', () => {
      syncSC();
      // B 站进出全屏会重建播放器容器，延时补挂一次
      setTimeout(() => syncSC(), 500);
    }, true);

    // 侦听 video 元素重建与 DOM 变化（B 站切清晰度/切流会替换 video）
    const mo = new MutationObserver(() => onDomChange());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 首次绑定（video 已存在时）
    domSniff();
    bindVideo();
    ensureUI();
    syncSC();
    syncDislike();

    // 存储变化联动（popup 切换总开关 / 醒目留言开关与位置 / 清空记忆）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[MEM_KEY]) {
        const nv = changes[MEM_KEY].newValue || {};
        syncEnabled(typeof nv.enabled === 'boolean' ? nv.enabled : true);
        if (nv.sc) {
          scConfig = nv.sc;
          syncSC();
        }
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
          sc: scState(),
          ok: true
        });
      }
      return true;
    });

    // 调试钩子（浏览器自动化）：触发后把当前状态与存储 dump 到 <html data-bv-dbg>
    window.addEventListener('bv_boost_debug', async () => {
      try {
        const data = await Memory.load();
        document.documentElement.setAttribute('data-bv-dbg', JSON.stringify({
          mid: current.mid, type: current.type, name: current.name,
          boost: engine.boost, engaged: engine.getState().engaged,
          eng: engine.getState(),
          lastApplied,
          enabled: data.enabled, bank: data.bank,
          sc: scState(), scCfg: data.sc,
          dislike: dislikeState()
        }));
      } catch (e) {
        document.documentElement.setAttribute('data-bv-dbg', JSON.stringify({ err: String(e) }));
      }
    }, false);

    // 调试动作（浏览器自动化）：强制应用一次记忆，用于定位应用链路
    window.addEventListener('bv_boost_apply', () => {
      applyMemoryGain(true);
    }, false);

    // 周期性兜底：SPA 内切换视频（URL/bvid 变化）时重新识别；引擎/主播就绪后补应用记忆
    setInterval(() => {
      domSniff();
      bindVideo();
      ensureUI();
      applyMemoryGain();
      syncSC();
      syncDislike();
    }, 2000);
  }

  init();
})();