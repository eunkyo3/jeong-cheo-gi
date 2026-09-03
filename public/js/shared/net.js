/**
 * shared/net.js — 온라인/오프라인 감지 (프런트 4-4).
 *
 * 예전에는 대전 화면만 소켓 끊김 배너가 있었고, 학습·오답노트·랭킹은 네트워크가 끊겨도 정상처럼
 * 보이다가 제출·조회 시점에야 실패했다. 브라우저의 `online`/`offline` 이벤트를 한 곳에서 받아
 * 각 화면이 알림 한 줄을 켜고 끄게 한다. 대전 화면은 자기 소켓 배너를 그대로 쓴다.
 *
 *   JPK.net.isOnline()            → boolean  (navigator.onLine 이 없으면 true)
 *   JPK.net.onChange(cb)          → cb(online) 를 즉시 1회 + 변화마다 호출, 해제 함수 반환
 *   JPK.net.bindNotice(el, text?) → el 을 오프라인일 때만 보이는 알림으로 만든다 (role="alert" 권장)
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var nav = global.navigator || {};
  var DEFAULT_TEXT = '인터넷 연결이 끊겼습니다. 연결이 돌아오면 이어서 쓸 수 있습니다.';

  function isOnline() {
    return typeof nav.onLine === 'boolean' ? nav.onLine : true;
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    function on() { cb(true); }
    function off() { cb(false); }
    global.addEventListener('online', on);
    global.addEventListener('offline', off);
    try { cb(isOnline()); } catch (e) { /* 콜백 오류가 감지기를 죽이지 않게 */ }
    return function () {
      global.removeEventListener('online', on);
      global.removeEventListener('offline', off);
    };
  }

  function bindNotice(el, text) {
    if (!el) return function () {};
    return onChange(function (online) {
      if (online) {
        el.textContent = '';
        el.hidden = true;
      } else {
        el.textContent = text || DEFAULT_TEXT;
        el.hidden = false;
      }
    });
  }

  JPK.net = { isOnline: isOnline, onChange: onChange, bindNotice: bindNotice };
})(window);
