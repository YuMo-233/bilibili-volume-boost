/**
 * UP 主识别 — MAIN world 注入
 * 作用：读取页面全局状态（ISOLATED world 无法访问），提取当前 UP 主/主播 mid 与名称，
 *       通过自定义事件传给 ISOLATED world 的主逻辑。
 *
 * 各页面数据源（已实测）：
 * - 视频页：window.__INITIAL_STATE__.upInfo.mid / videoData.owner.mid
 * - 新版直播页：window.__SSR_INITIAL_STATE__.baseInfoRoom.room_info.uid（旧 __INITIAL_STATE__ 已弃用）
 *
 * 除加载期识别外，本模块还负责 **SPA 导航感知**（见 docs/adr/0015）：B 站站内同文档跳转
 * 不重新注入脚本，故由本模块挂钩 history 并派发 bv_boost_nav / 变化后的 bv_boost_up。
 */
(() => {
  'use strict';

  /**
   * 事件出口：异形直播间的静音钩子与 UP 识别跑在 blanc 嵌入帧的 MAIN world 内
   * （all_frames 注入，见 docs/adr/0013），而监听方（引擎/主逻辑）在顶层窗口——
   * 事件不跨文档，必须显式派发到顶层；跨源帧访问 top 会抛异常，退回本窗口派发。
   */
  const emit = (name, detail) => {
    let target = window;
    try { if (window.top && window.top !== window) target = window.top; } catch (_) {}
    try { target.dispatchEvent(new CustomEvent(name, { detail })); } catch (_) {
      try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (__) {}
    }
  };

  let lastUpKey = '';   // 上次已派发的 UP 主（"type:mid"）：导航后据此判断"读到的是不是新值"

  const send = (detail) => {
    lastUpKey = detail.type + ':' + detail.mid;
    emit('bv_boost_up', detail);
  };

  const isLive = () =>
    location.hostname.indexOf('live.') === 0 || location.hostname === 'live.bilibili.com';

  const nameFromDom = () => {
    const el = document.querySelector('.room-owner-username');
    return el ? el.textContent.trim() : '';
  };

  /** 新版直播页 SSR 状态 */
  const probeLiveNew = () => {
    const S2 = window.__SSR_INITIAL_STATE__;
    if (!S2) return null;
    const b = S2.baseInfoRoom;
    const roomInfo = b && b.room_info;
    const anchorBase = b && b.anchor_info && b.anchor_info.base_info;
    const uid = roomInfo && roomInfo.uid;
    if (!uid) return null;
    return {
      mid: String(uid),
      type: 'live',
      name: (anchorBase && (anchorBase.uname || anchorBase.name || anchorBase.username)) || nameFromDom()
    };
  };

  /** 旧版直播页状态（兼容） */
  const probeLiveOld = () => {
    try {
      const s = window.__INITIAL_STATE__;
      const anchor = s && s.roomInfo && s.roomInfo.anchor;
      if (!anchor || !anchor.uid) return null;
      return { mid: String(anchor.uid), type: 'live', name: anchor.uname || '' };
    } catch (_) { return null; }
  };

  const probeVideo = () => {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return null;
      const up = s.upInfo || {};
      const owner = (s.videoData && s.videoData.owner) || null;
      const mid = up.mid || (owner && owner.mid);
      if (!mid) return null;
      return { mid: String(mid), type: 'video', name: up.name || (owner && owner.name) || '' };
    } catch (_) { return null; }
  };

  /** 读取当前 UP 主/主播（不改状态、不派发）；读不到返回 null */
  const probe = () => {
    try {
      if (isLive()) return probeLiveNew() || probeLiveOld();
      return probeVideo();
    } catch (_) { return null; }
  };

  const readOnce = () => {
    const v = probe();
    if (v) send(v);
    return !!v;
  };

  // 页面状态在解析期间写入，轮询几次兜底
  if (!readOnce()) {
    [500, 1500, 3000, 6000].forEach((ms) => setTimeout(() => readOnce(), ms));
  }

  // ---------------------------------------------------------------------------
  // SPA 导航感知（见 docs/adr/0015）
  //
  // B 站视频页之间（点推荐、自动连播、切分P、/list/ 合集）与直播切房都是**同文档导航**：
  // 地址栏变了、本脚本不重新注入、__INITIAL_STATE__ 被路由原地改写。而上面这段只在加载期
  // 轮询 4 次就永久停手 —— 新视频的 UP 主再也送不出去，主逻辑的 mid 停在旧值，旧增益被原样
  // 套用到下一个视频。故挂钩 history / popstate / hashchange，导航后**读到变化为止**重读状态。
  // ---------------------------------------------------------------------------
  const NAV_REREAD_INTERVAL = 250;   // 重读间隔
  const NAV_REREAD_GRACE = 1200;     // 放宽期：到点仍未读到变化就先派发一次（多为同 UP 主切分P/连播）
  const NAV_REREAD_DEADLINE = 8000;  // 此后转慢轮询，兜住路由延迟改写状态的情况

  let navSeq = 0;                    // 导航序号：新导航作废在途的重读
  let lastHref = location.href;

  // 只在顶层窗口挂钩：嵌入帧内也跑着本脚本，其 history 属于帧自身，
  // 若也派发导航信号会与顶层地址栏混淆（见 docs/adr/0013）
  const isTopFrame = (() => {
    try { return window.top === window; } catch (_) { return false; }
  })();

  /**
   * 导航后重读全局状态，直到读出与导航前**不同**的 UP 主为止再派发。
   * 必须"读到变化才收工"：路由是异步拉数据再改写 __INITIAL_STATE__，导航瞬间读到的往往
   * 还是上一个视频的 UP 主；若就此收工，旧 UP 主会被当成新值送去，主逻辑又把旧增益套到
   * 新视频 —— 正是本次要修的故障。
   */
  const readUntilFresh = (staleKey) => {
    const seq = ++navSeq;
    const started = Date.now();
    let anySent = false;   // 是否已派发过（放宽期兜底），保证每次导航主逻辑都能收到一次确认
    const step = () => {
      if (seq !== navSeq) return;                    // 已被更新的导航取代
      const v = probe();
      if (v) {
        const key = v.type + ':' + v.mid;
        if (key !== staleKey) { send(v); return; }    // 读到新 UP 主：派发并收工
      }
      const elapsed = Date.now() - started;
      // 放宽期到点仍无变化：派发一次当前值，让主逻辑结束"识别中"状态
      // （同 UP 主切分P/连播走这条；此刻若状态尚不可读，则等它可读时立刻补派发）
      if (!anySent && elapsed >= NAV_REREAD_GRACE && v) { send(v); anySent = true; }
      if (elapsed >= NAV_REREAD_DEADLINE) return;
      setTimeout(step, anySent ? 800 : NAV_REREAD_INTERVAL);
    };
    step();
  };

  const onNavigate = () => {
    if (location.href === lastHref) return;   // replaceState 原地改写同一 URL：不算导航
    const staleKey = lastUpKey;
    lastHref = location.href;
    emit('bv_boost_nav', { href: location.href });
    readUntilFresh(staleKey);
  };

  if (isTopFrame) {
    ['pushState', 'replaceState'].forEach((fn) => {
      try {
        const orig = history[fn];
        if (typeof orig !== 'function') return;
        history[fn] = function (...args) {
          const ret = orig.apply(this, args);
          try { onNavigate(); } catch (_) {}
          return ret;
        };
      } catch (_) {}
    });
    window.addEventListener('popstate', onNavigate, true);
    window.addEventListener('hashchange', onNavigate, true);
  }

  // ---------------------------------------------------------------------------
  // B 站原生静音镜像（MAIN world 钩子，见 docs/adr/0010）
  //
  // 引擎改用 captureStream 抽头后，抽头信号不受 video.muted 影响，原生静音层需引擎手工镜像；
  // 而 B 站在 MAIN world 写 video.muted，隔离世界对元素加的属性 MAIN world 看不见（跨世界隔离），
  // 故覆写必须发生在 MAIN world：对 B 站谎报"意图"，元素真实静音与否交给引擎统一控制。
  //
  // 协议：
  // - 引擎挂载时给目标 video 打上 data-bv-target 属性、卸载时移除；本模块用 MutationObserver
  //   监听该属性（属性是真实 DOM 状态，必然跨世界可见，比事件桥更稳），据此装/卸钩子。
  // - 覆写后 getter 返回 B 站意图、setter 只记录意图（不写真实值，避免与引擎的强制静音打架
  //   而产生双份声音）。
  // - 意图任何变化（含初次）都以 bv_boost_muted{muted} 回传引擎。
  // ---------------------------------------------------------------------------
  const hookedMuted = new Map(); // element -> { desc, intent }

  const installMutedHook = (el) => {
    if (!el || hookedMuted.has(el)) return;
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
    if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
    // 初始意图取自引擎写入的属性值（'1'/'0'），**绝不读元素当下的 muted**：引擎随后会把真实
    // 静音强制置真，异步安装的钩子若读到被强制后的值，会把静音意图误判为真 → 增益归零 → 整页无声。
    const rec = { desc, intent: el.getAttribute('data-bv-target') === '1' };
    try {
      Object.defineProperty(el, 'muted', {
        configurable: true,
        enumerable: !!desc.enumerable,
        get() { return rec.intent; },
        set(v) {
          rec.intent = !!v;
          emit('bv_boost_muted', { muted: rec.intent });
        }
      });
    } catch (_) { return; }
    hookedMuted.set(el, rec);
    emit('bv_boost_muted', { muted: rec.intent });
  };

  const removeMutedHook = (el) => {
    const rec = hookedMuted.get(el);
    if (!rec) return;
    try { delete el.muted; } catch (_) {
      try { Object.defineProperty(el, 'muted', rec.desc); } catch (__) {}
    }
    hookedMuted.delete(el);
  };

  const mutedObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target;
      if (!el || el.tagName !== 'VIDEO') continue;
      if (el.hasAttribute('data-bv-target')) installMutedHook(el);
      else removeMutedHook(el);
    }
  });
  mutedObserver.observe(document.documentElement || document, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-bv-target']
  });
})();