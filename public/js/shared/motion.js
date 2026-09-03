/**
 * shared/motion.js — 사용자의 모션 축소 설정.
 *
 * `prefers-reduced-motion: reduce` 는 전정 장애·멀미가 있는 사람이 켜 두는 OS 설정이다.
 * CSS 는 미디어 쿼리로 알아서 지키지만, 스크립트가 직접 부르는 부드러운 스크롤
 * (`scrollIntoView({behavior:'smooth'})`, `scrollTo({behavior:'smooth'})`)은 CSS 가 막지 못한다.
 * 그래서 behavior 값을 여기서 골라 준다.
 *
 *   JPK.motion.prefersReducedMotion()  → boolean (matchMedia 가 없으면 false)
 *   JPK.motion.smoothScrollBehavior()  → 'smooth' | 'auto'
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};

  function prefersReducedMotion() {
    try {
      if (!global.matchMedia) return false;
      return !!global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;   // 미디어 쿼리를 못 읽으면 기존 동작(부드러운 스크롤)을 유지한다
    }
  }

  function smoothScrollBehavior() {
    return prefersReducedMotion() ? 'auto' : 'smooth';
  }

  JPK.motion = {
    prefersReducedMotion: prefersReducedMotion,
    smoothScrollBehavior: smoothScrollBehavior,
  };
})(window);
