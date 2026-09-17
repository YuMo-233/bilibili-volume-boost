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
})();