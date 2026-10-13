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
 * 8. SPA 导航（同文档换页）→ 重识别（docs/adr/0015）
 * 9. 「不感兴趣」屏蔽清单联动（docs/adr/0016）：清单变化后立即复核卡片呈现
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

  // ---- 活动文档（异形直播间：播放器域在 blanc 嵌入帧内，见 docs/adr/0013） ----
  // 部分直播间（活动/特殊模板）整个直播间的 DOM 嵌在同源 iframe 内
  // （live.bilibili.com/blanc/{真实房间号}?liteVersion=true，外层 .live-non-revenue-player），
  // 顶层文档只是空壳：video、控制栏、SC 注入点全在帧内。插件的播放器域查询与
  // 文档级监听必须落到该帧文档上，否则在该类房间完全失效。
  let embedFrame = null;   // 嵌入播放器帧（iframe 元素）
  let embedDoc = null;     // 其文档（仅用于挂钩变更检测；查询走 actDoc 实时解析）

  function findEmbedFrame() {
    return document.querySelector('iframe[src*="/blanc/"]') || null;
  }

  /** 活动文档：嵌入帧可用时为帧文档，否则顶层文档 */
  function actDoc() {
    if (current.type === 'live') {
      const f = findEmbedFrame();
      if (f) {
        try {
          const d = f.contentDocument;
          if (d && d.body) return d;
        } catch (_) {}   // 跨源/未就绪：退回顶层，等下一轮
      }
    }
    return document;
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
    if (changed) {
      applyMemoryGain(); // 切到新 UP 主时套用其记忆
      // UP 主识别就绪 → 立刻解除屏蔽开关的"未就绪"置灰（见 docs/adr/0017）。
      // 少了这一步就得等下一轮 refresh（DOM 变更或 2 秒 tick）才亮起来。
      syncDislike();
    }
  }

  /** DOM 兜底解析 mid（MAIN world 事件未送达时；异形房查嵌入帧内文档） */
  function domSniff() {
    if (hasUpEvent[current.type] && current.mid) return;
    try {
      const doc = actDoc();
      if (current.type === 'video') {
        const a = doc.querySelector('.up-info-container a[href*="space.bilibili.com"], a[href*="space.bilibili.com"][title]');
        const m = a && a.href.match(/space\.bilibili\.com\/(\d+)/);
        if (m) setCurrent(m[1], 'video', (a && a.getAttribute('title')) || '');
      } else {
        // 新版直播页无 space 链接（实测），room-owner-username 亦无 uid；
        // DOM 兜底退化为"房间号键"（同一房间长期对应同一主播，保证记忆稳定）。
        // 房间号取顶层地址栏：异形房嵌入帧 URL 是 blanc/{真实号}，与既有记忆键
        // 不同源，保持顶层路径可避免该类房间的记忆键漂移。
        const a = doc.querySelector('.anchor-info a[href*="space.bilibili.com"], a[href*="space.bilibili.com"]');
        const m = a && a.href.match(/space\.bilibili\.com\/(\d+)/);
        const m2 = location.pathname.match(/^\/(\d+)/);
        const nameEl = doc.querySelector('.room-owner-username');
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
      // 无记忆时必须**显式回到默认 100%**：SPA 导航到"没记过的 UP 主"时若什么都不做，
      // 增益就会把上一个视频的值留在引擎里（引擎是整会话单例，见 docs/adr/0015）
      engine.setBoost(memo != null ? memo : 100);
      uiSync();
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
      }, actDoc);
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
      scOverlay = new SuperChatOverlay((id) => scFeed.close(id), actDoc);
    }
    scOverlay.setPosition(scConfig.position);
    const remounted = !scOverlay.isMounted() && scOverlay.mount(); // 播放器重建后自动重挂
    // 接口只认真实房间号：换算完成前先不启动取数，避免用短号整轮报错
    const room = realRoomId();
    if (room) {
      scFeed.setRoom(room);
      if (!scFeed.running) scFeed.start();
    }
    if (document.fullscreenElement) scOverlay.show();
    else scOverlay.hide();
    // 重建后的新宿主是空的，用当前列表立即回填，否则最长要等一轮轮询（10 秒）
    // 才有卡片；放在显隐之后，全屏下量到的是真实高度，入场动画不会塌成 0
    if (remounted) scOverlay.render(scFeed.visible());
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
  // UP 主识别结果以只读方式注入：屏蔽开关坚持以识别结果为准，不再自己从 DOM 现取 mid
  // （SPA 换页瞬间两者会短暂不一致，见 docs/adr/0017）
  const dislike = new BoostDislike(() => current);

  /**
   * 屏蔽清单的第一轮读盘在这里兜住：start() 内部会 `ensure()` 并在完成后补一次 refresh，
   * 故此处即便 refresh 因"清单未就绪"提前返回，稍后也会自动补上。
   */
  function syncDislike() {
    // 总开关关闭时一并撤下注入（本功能无独立开关，随总开关联动）
    if (!enabled) {
      if (dislike._running) dislike.stop();
      return;
    }
    if (current.type === 'video') {
      if (!dislike._running) dislike.start();
      dislike.refresh(); // 新增卡片注入 / 失效卡片清理（含未登录、清单屏蔽与已反馈态复核）
    } else if (dislike._running) {
      dislike.stop();
    }
  }

  function dislikeState() {
    const st = DislikeStore.stats();
    return {
      running: dislike._running,
      loggedIn: dislike.isLoggedIn(),
      cards: dislike._cards.size,
      blockedVideos: st.videos,   // 清单里的视频级屏蔽条数
      blockedUps: st.ups,         // 清单里的 UP 主级屏蔽条数
      hide: DislikeStore.hide,    // 是否开启「彻底隐藏」
      toggle: !!(dislike._toggle && dislike._toggle.isMounted()),
      toggleReady: !!(dislike._toggle && dislike._toggle.isMounted() && dislike._toggle._ready),
      upReady: !!current.mid      // 当前 UP 主是否已识别就绪
    };
  }

  // ---- 视频挂载 / 重挂 ----
  function findVideo() {
    const sel = current.type === 'video'
      ? '#bilibili-player video, .bpx-player-video video, .bilibili-player-video video'
      : '.web-player-video-container video, .live-player-video video, .player-container video, video';
    // 异形房：video 在嵌入帧内；跨文档取到后引擎照常按元素挂载（同源，见 docs/adr/0013）
    return actDoc().querySelector(sel);
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
      bindVideo._t = setTimeout(() => { bindVideo(); }, 100);
    }
  }

  function onDomChange() {
    ensureEmbedHooks();
    domSniff();
    bindVideo();
    ensureUI();
    syncDislike();
  }

  // ---- 页面身份 / SPA 导航 → 重识别（见 docs/adr/0015） ----
  // B 站视频页之间（点推荐、自动连播、切分P、/list/ 合集）与直播切房都是**同文档导航**：
  // 地址栏变了、脚本实例不重载，而 UP 主识别只在加载期跑过一次（sniff 轮询 4 次即停，
  // domSniff 又被 hasUpEvent 闸门永久短路），于是 current.mid 停在旧 UP 主、旧增益被原样
  // 套用到下一个视频。故以「页面身份」变化为信号，清空识别状态并重跑整条链路。

  /**
   * 页面身份：判定"是否换了一个内容"的稳定标识。
   * 视频页取 bvid（/list/ 合集的 bvid 在 query 里而非路径），直播页取路径首段数字（短号）。
   * ?t= / ?p= / spm_id_from 等参数不参与——身份不变即同一内容，不触发重识别（防音量抖动）。
   */
  function pageIdentity() {
    if (current.type === 'live') {
      const m = location.pathname.match(/^\/(\d+)/);
      return m ? 'live:' + m[1] : 'live:' + location.pathname;
    }
    const p = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (p) return 'video:' + p[1].toUpperCase();
    const q = location.search.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
    if (q) return 'video:' + q[1].toUpperCase();
    const av = location.pathname.match(/\/video\/av(\d+)/i) || location.search.match(/[?&]aid=(\d+)/i);
    if (av) return 'video:av' + av[1];
    return 'video:' + location.pathname;
  }

  let identity = pageIdentity();
  let navFallbackTimer = null;

  /**
   * 清空 UP 主识别状态：mid 置未知（增益在识别完成前不动）、事件已送达标记归零
   * （让 domSniff 对本次身份重新武装，见 docs/adr/0015）、记忆应用闩锁作废。
   */
  function resetIdentification() {
    current = { mid: null, type: detectType(), name: '' };
    hasUpEvent.video = false;
    hasUpEvent.live = false;
    lastApplied = null;
  }

  /** 识别迟迟不出结果（MAIN world 事件与 DOM 兜底都失败）→ 兜底回默认，绝不沿用旧增益 */
  function armNavFallback() {
    clearTimeout(navFallbackTimer);
    navFallbackTimer = setTimeout(() => {
      if (current.mid || !enabled) return;   // 已识别出 UP 主：交给 applyMemoryGain 处置
      engine.setBoost(100);
      uiSync();
    }, 2500);
  }

  /**
   * 重识别：整条链路的唯一入口（首绑 / 2 秒兜底 / 导航事件共用）。
   * 只重跑识别与注入，**不重建引擎与音频管线**——teardown 会停抽头音轨、还原静音，
   * 制造无声窗口，与 docs/adr/0011「绝不整页无声」冲突；video 的复用/重建由
   * bindVideo 与引擎自身的重抽（recapture）覆盖。
   */
  function reinstate() {
    ensureEmbedHooks();
    domSniff();
    bindVideo();
    ensureUI();
    applyMemoryGain();
    syncSC();
    syncDislike();
  }

  /** 页面身份变化 → 重识别。身份未变（仅 ?t= 等噪声改写地址栏）时什么都不做 */
  function onNavigation() {
    const next = pageIdentity();
    if (next === identity) return;
    identity = next;
    resetIdentification();
    armNavFallback();
    reinstate();
  }

  // ---- 嵌入帧挂钩（观察者与文档级监听的迁移，见 docs/adr/0013） ----
  let moRef = null;   // 主 MutationObserver（init 中创建，帧更换时重挂目标）

  const onResumeGesture = () => engine.resumeOnUserGesture();
  /** 进出沉浸全屏 → 醒目留言浮层显隐（只监听，不介入全屏逻辑，见 docs/adr/0003） */
  const onFsChange = () => {
    syncSC();
    // B 站进出全屏会重建播放器容器，延时补挂一次
    setTimeout(() => syncSC(), 500);
  };
  /** 嵌入帧内导航/重载：重挂钩并立即全链路刷新一次 */
  const onEmbedLoad = () => {
    ensureEmbedHooks();
    domSniff();
    bindVideo();
    ensureUI();
    syncSC();
    syncDislike();
  };

  /**
   * 嵌入帧出现/更换（含帧内切房重载）时迁移观察者与文档级监听。
   * MutationObserver 不能跨文档继承：旧帧文档的观察与监听在新文档上全部失效，
   * 必须显式重挂；宿主有效性由 isMounted 的「归属文档一致」判定兜住，
   * 下一轮 ensureUI/syncSC 会自动在新文档重建。
   */
  function ensureEmbedHooks() {
    const f = current.type === 'live' ? findEmbedFrame() : null;
    let d = null;
    if (f) {
      try { d = (f.contentDocument && f.contentDocument.body) ? f.contentDocument : null; } catch (_) {}
    }
    if (f === embedFrame && d === embedDoc) return;

    if (embedDoc) {
      try { embedDoc.removeEventListener('keydown', onKeyDown, true); } catch (_) {}
      try { embedDoc.removeEventListener('pointerdown', onResumeGesture, true); } catch (_) {}
      try { embedDoc.removeEventListener('fullscreenchange', onFsChange, true); } catch (_) {}
    }
    if (embedFrame) {
      try { embedFrame.removeEventListener('load', onEmbedLoad, true); } catch (_) {}
    }

    embedFrame = f;
    embedDoc = d;

    if (embedFrame) {
      try { embedFrame.addEventListener('load', onEmbedLoad, true); } catch (_) {}
    }
    if (embedDoc) {
      embedDoc.addEventListener('keydown', onKeyDown, true);          // 帧内焦点下的快捷键
      embedDoc.addEventListener('pointerdown', onResumeGesture, true); // 帧内手势恢复 AudioContext
      embedDoc.addEventListener('fullscreenchange', onFsChange, true);
    }

    if (moRef) {
      moRef.disconnect();
      moRef.observe(document.documentElement, { childList: true, subtree: true });
      if (embedDoc) {
        try { moRef.observe(embedDoc.documentElement || embedDoc, { childList: true, subtree: true }); } catch (_) {}
      }
    }
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
    // 先挂监听再读存储：sniff 在 document_start 就可能派发 UP 主/导航事件，
    // 等存储读完再挂会漏掉早到的事件（漏掉的识别由 2 秒兜底补，但能不漏最好）
    window.addEventListener('bv_boost_up', onSniffEvent, false);
    window.addEventListener('bv_boost_nav', onNavigation, false);   // SPA 导航（docs/adr/0015）
    document.addEventListener('pointerdown', onResumeGesture, true);
    window.addEventListener('keydown', onKeyDown, true);
    // 进出沉浸全屏 → 醒目留言浮层显隐（只监听，不介入全屏逻辑，见 docs/adr/0003）
    document.addEventListener('fullscreenchange', onFsChange, true);

    // 恢复总开关与醒目留言配置
    try {
      const data = await Memory.load();
      enabled = data.enabled;
      if (data.sc) scConfig = data.sc;
    } catch (_) {}

    // 侦听 video 元素重建与 DOM 变化（B 站切清晰度/切流会替换 video）
    moRef = new MutationObserver(() => onDomChange());
    moRef.observe(document.documentElement, { childList: true, subtree: true });

    // 首次绑定（先挂异形房嵌入帧的观察者/监听，再走全链路）
    reinstate();

    // 存储变化联动（popup 切换总开关 / 醒目留言开关与位置 / 清空记忆 / 屏蔽清单）
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[MEM_KEY]) {
        const nv = changes[MEM_KEY].newValue || {};
        syncEnabled(typeof nv.enabled === 'boolean' ? nv.enabled : true);
        if (nv.sc) {
          scConfig = nv.sc;
          syncSC();
        }
      }
      // 屏蔽清单被外部改动（popup 清空 / 切换「彻底隐藏」）→ 失效内存镜像后立即复核。
      // 必须先 ensure() 重新读盘，否则 refresh 会因"清单未就绪"直接返回、改动不生效。
      if (changes[BLOCK_KEY]) {
        DislikeStore.invalidate();
        DislikeStore.ensure().then(() => syncDislike());
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
          identity,
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

    // 周期性兜底：onNavigation 靠地址栏快照比对兜住 history 钩子失效；
    // reinstate 负责引擎/主播就绪后补应用记忆（SPA 内换页的识别由 bv_boost_nav 即时驱动）
    setInterval(() => {
      onNavigation();
      reinstate();
    }, 2000);
  }

  init();
})();