/**
 * UP 主识别 — MAIN world 注入
 * 作用：读取页面全局变量 window.__INITIAL_STATE__（ISOLATED world 无法访问），
 *       提取当前 UP 主/主播 mid 与名称，通过自定义事件传给 ISOLATED world 的主逻辑。
 */
(() => {
  'use strict';

  const send = (detail) => {
    window.dispatchEvent(new CustomEvent('bv_boost_up', { detail }));
  };

  const readOnce = () => {
    try {
      const s = window.__INITIAL_STATE__;
      if (!s) return false;
      if (location.pathname.startsWith('/video')) {
        const up = s.upInfo || {};
        const owner = (s.videoData && s.videoData.owner) || null;
        const mid = up.mid || (owner && owner.mid);
        if (mid) {
          send({ mid: String(mid), type: 'video', name: up.name || (owner && owner.name) || '' });
          return true;
        }
      } else if (location.hostname.indexOf('live.') === 0 || location.hostname === 'live.bilibili.com') {
        const anchor = s.roomInfo && s.roomInfo.anchor;
        if (anchor && anchor.uid) {
          send({ mid: String(anchor.uid), type: 'live', name: anchor.uname || '' });
          return true;
        }
      }
    } catch (_) { /* 忽略解析失败 */ }
    return false;
  };

  // __INITIAL_STATE__ 由页面脚本在解析期间写入，轮询几次兜底
  if (!readOnce()) {
    [500, 1500, 3000, 6000].forEach((ms) => setTimeout(() => readOnce(), ms));
  }
})();