/**
 * fmt.js — 화면 공용 날짜 표기.
 *
 * 최근 기록·대전 카드처럼 "언제였는지" 를 빠르게 훑는 자리에서는 절대 날짜보다
 * 상대 표기가 읽기 쉽다. 대신 정확한 시각은 잃지 않도록 title 속성에 dateTime() 을 남긴다.
 *
 *   window.Fmt.relativeDate(iso, now)  오늘 14:00 / 어제 14:00 / 3일 전 / 2026-08-25
 *   window.Fmt.dateTime(iso)           2026-09-01 14:00
 *
 * 두 함수 모두 순수 함수다 — now 를 주입할 수 있어 headless 에서 단위 검사한다.
 * 값을 못 읽으면(빈 값·형식 오류) 빈 문자열을 돌려준다. 호출부는 빈 문자열이면 표기를 생략한다.
 */
(function (global) {
  'use strict';

  // 하루 경계는 "지난 시간" 이 아니라 "달력 날짜" 로 센다 — 23:59 과 00:01 은 하루 차이다.
  var DAY_MS = 24 * 60 * 60 * 1000;

  // 상대 표기를 쓰는 최대 일수. 이보다 오래되면 절대 날짜가 더 쓸모 있다.
  var RELATIVE_MAX_DAYS = 7;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** epoch ms · 숫자 문자열 · ISO 문자열을 모두 받아 준다 (서버 표기가 바뀌어도 깨지지 않게). */
  function toDate(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    var d;
    if (typeof value === 'number') d = new Date(value);
    else if (/^\d+$/.test(String(value))) d = new Date(Number(value));
    else d = new Date(String(value));
    return isNaN(d.getTime()) ? null : d;
  }

  /** 그 날의 자정(로컬). 달력 날짜 차이를 재는 기준이다. */
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function ymd(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function hm(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** "2026-09-01 14:00" — 절대 시각. title 속성용. */
  function dateTime(value) {
    var d = toDate(value);
    if (!d) return '';
    return ymd(d) + ' ' + hm(d);
  }

  /**
   * 오늘 14:00 · 어제 14:00 · 3일 전 · 2026-08-25.
   * now 를 주지 않으면 현재 시각을 쓴다. 미래 시각(시계 어긋남)은 절대 날짜로 떨어뜨린다.
   */
  function relativeDate(value, now) {
    var d = toDate(value);
    if (!d) return '';
    var base = toDate(now) || new Date();

    var days = Math.round((startOfDay(base) - startOfDay(d)) / DAY_MS);
    if (days === 0) return '오늘 ' + hm(d);
    if (days === 1) return '어제 ' + hm(d);
    if (days > 1 && days <= RELATIVE_MAX_DAYS) return days + '일 전';
    return ymd(d);
  }

  global.Fmt = {
    relativeDate: relativeDate,
    dateTime: dateTime,
  };
})(window);
