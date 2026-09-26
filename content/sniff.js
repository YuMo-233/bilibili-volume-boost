/**
 * UP 主识别 — MAIN world 注入
 * 作用：读取页面全局状态（ISOLATED world 无法访问），提取当前 UP 主/主播 mid 与名称，
 *       通过自定义事件传给 ISOLATED world 的主逻辑。
 *
 * 各页面数据源（已实测）：
 * - 视频页：window.__INITIAL_STATE__.upInfo.mid / videoData.owner.mid
 * - 新版直播页：window.__SSR_INITIAL_STATE__.baseInfoRoom.room_info.uid（旧 __INITIAL_STATE__ 已弃用）
 */
(() => {
  'use strict';

  const send = (detail) => {
    window.dispatchEvent(new CustomEvent('bv_boost_up', { detail }));
  };

  const isLive = () =>
    location.hostname.indexOf('live.') === 0 || location.hostname === 'live.bilibili.com';

  /** 新版直播页 SSR 状态 */
  const readLiveNew = () => {
    const S2 = window.__SSR_INITIAL_STATE__;
    if (!S2) return false;
    const b = S2.baseInfoRoom;
    const roomInfo = b && b.room_info;
    const anchorBase = b && b.anchor_info && b.anchor_info.base_info;
    const uid = roomInfo && roomInfo.uid;
    if (uid) {
      const nameEl = document.querySelector('.room-owner-username');
      send({
        mid: String(uid),
        type: 'live',
        name: (anchorBase && (anchorBase.uname || anchorBase.name || anchorBase.username)) ||
              (nameEl ? nameEl.textContent.trim() : '')
      });
      return true;
    }
    return false;
  };

  /** 旧版直播页状态（兼容） */
  const readLiveOld = () => {
    try {
      const s = window.__INITIAL_STATE__;
      const anchor = s && s.roomInfo && s.roomInfo.anchor;
      if (anchor && anchor.uid) {
        send({ mid: String(anchor.uid), type: 'live', name: anchor.uname || '' });
        return true;
      }
    } catch (_) {}
    return false;
  };

  const readVideo = () => {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return false;
      const up = s.upInfo || {};
      const owner = (s.videoData && s.videoData.owner) || null;
      const mid = up.mid || (owner && owner.mid);
      if (mid) {
        send({ mid: String(mid), type: 'video', name: up.name || (owner && owner.name) || '' });
        return true;
      }
    } catch (_) {}
    return false;
  };

  const readOnce = () => {
    try {
      if (isLive()) return readLiveNew() || readLiveOld();
      return readVideo();
    } catch (_) { return false; }
  };

  // 页面状态在解析期间写入，轮询几次兜底
  if (!readOnce()) {
    [500, 1500, 3000, 6000].forEach((ms) => setTimeout(() => readOnce(), ms));
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
          window.dispatchEvent(new CustomEvent('bv_boost_muted', { detail: { muted: rec.intent } }));
        }
      });
    } catch (_) { return; }
    hookedMuted.set(el, rec);
    window.dispatchEvent(new CustomEvent('bv_boost_muted', { detail: { muted: rec.intent } }));
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