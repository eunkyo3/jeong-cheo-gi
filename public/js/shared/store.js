/**
 * shared/store.js — localStorage · sessionStorage 접근 한 벌.
 *
 * jsdom·사파리 프라이빗 모드·용량 초과에서 던질 수 있다. 저장은 **항상 최선 노력**이다 —
 * 읽기 실패는 null, 쓰기·삭제 실패는 무시한다. 부르는 쪽은 try/catch 를 다시 쓰지 않는다.
 *
 *   JPK.store.get(key) / set(key, value) / remove(key)              localStorage
 *   JPK.store.sessionGet / sessionSet / sessionRemove               sessionStorage
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};

  function areaGet(area, key) {
    try {
      return global[area].getItem(key);
    } catch (e) {
      return null;
    }
  }

  function areaSet(area, key, value) {
    try {
      global[area].setItem(key, value);
    } catch (e) { /* 용량 초과·차단 — 무시 */ }
  }

  function areaRemove(area, key) {
    try {
      global[area].removeItem(key);
    } catch (e) { /* 무시 */ }
  }

  JPK.store = {
    get: function (key) { return areaGet('localStorage', key); },
    set: function (key, value) { areaSet('localStorage', key, value); },
    remove: function (key) { areaRemove('localStorage', key); },
    sessionGet: function (key) { return areaGet('sessionStorage', key); },
    sessionSet: function (key, value) { areaSet('sessionStorage', key, value); },
    sessionRemove: function (key) { areaRemove('sessionStorage', key); },
  };
})(window);
