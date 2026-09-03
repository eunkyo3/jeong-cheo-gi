/**
 * shared/qmeta.js — 문항 메타(유형·언어·출처)의 값 셋과 화면 표기.
 *
 * 서버 계약과 짝을 이룬다: 유형은 `data/types/*.json`, 언어는 `data/langs/*.json` 의 값 셋이고
 * `server/qtypes.js` 가 같은 목록을 들고 있다. 예전에는 이 표가 다섯 파일에 흩어져 있었다 —
 * 한 곳이 바뀌면 화면마다 다른 말이 나오므로 여기 한 벌만 둔다.
 *
 *   JPK.qmeta.TYPE_ORDER / TYPE_LABEL / LANGS / LANG_LABEL
 *   JPK.qmeta.normalizeType(v) / normalizeLang(v)   모르는 값은 전부 '' (= 전체)
 *   JPK.qmeta.questionOrigin(qid)                   "2026-2#3" → "2026년 2회 · 3번"
 *   JPK.qmeta.typeLangText(type, lang)              "코드 · Python"
 *   JPK.qmeta.countsText(counts)                    "코드 8 · SQL 1 · 이론 11"
 *   JPK.qmeta.langsText(langs)                      "C 4 · Java 3 · Python 1"
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};

  // 문항 유형 — 서버 계약(data/types/*.json)의 값 셋과 화면 표기.
  var TYPE_ORDER = ['code', 'sql', 'theory'];
  var TYPE_LABEL = { code: '코드', sql: 'SQL', theory: '이론' };

  // 코드 문항 언어 — 서버 계약(data/langs/*.json)의 값 셋과 화면 표기.
  // 언어는 **코드 유형에만** 있는 축이다 (lang 이 오면 type 은 생략이거나 code 여야 한다).
  var LANGS = ['c', 'java', 'python'];
  var LANG_LABEL = { c: 'C', java: 'Java', python: 'Python' };

  /** 알 수 없는 값은 전부 '' (= 전체) 로 떨어뜨린다 — 서버에 이상한 type 을 보내지 않는다. */
  function normalizeType(value) {
    var t = String(value == null ? '' : value).trim().toLowerCase();
    return TYPE_ORDER.indexOf(t) === -1 ? '' : t;
  }

  /** normalizeType 과 같은 규칙 — 알 수 없는 값(비코드 문항의 null 포함)은 ''. */
  function normalizeLang(value) {
    var l = String(value == null ? '' : value).trim().toLowerCase();
    return LANGS.indexOf(l) === -1 ? '' : l;
  }

  /**
   * 문항 id("2026-2#3")에서 출처 회차·번호를 사람이 읽는 표기로 뽑는다.
   * "YYYY-N#num" 형태만 "YYYY년 N회 · num번" 으로 바꾸고, 그 외 형태는 '#' 앞부분을 그대로 보여준다.
   */
  function questionOrigin(qid) {
    var s = String(qid == null ? '' : qid);
    var hashIdx = s.indexOf('#');
    var prefix = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
    var num = hashIdx >= 0 ? s.slice(hashIdx + 1) : '';
    var m = /^(\d{4})-(\d+)$/.exec(prefix);
    if (!m) return prefix;
    var label = m[1] + '년 ' + m[2] + '회';
    return num ? label + ' · ' + num + '번' : label;
  }

  /**
   * "코드 · Python" 처럼 유형 옆에 언어를 붙인 한 줄 표기(방 목록·대기실 요약).
   * 유형이 없으면 '' 를 돌려준다 — 부르는 쪽이 '전체' 등으로 대체한다.
   */
  function typeLangText(type, lang) {
    var t = normalizeType(type);
    if (!t) return '';
    var l = normalizeLang(lang);
    return TYPE_LABEL[t] + (l ? ' · ' + LANG_LABEL[l] : '');
  }

  /** {code:8,sql:1,theory:11} → "코드 8 · SQL 1 · 이론 11" (0인 유형은 생략). */
  function countsText(counts) {
    if (!counts || typeof counts !== 'object') return '';
    var parts = [];
    TYPE_ORDER.forEach(function (t) {
      var n = Number(counts[t]) || 0;
      if (n > 0) parts.push(TYPE_LABEL[t] + ' ' + n);
    });
    return parts.join(' · ');
  }

  /** {c:4,java:3,python:1} → "C 4 · Java 3 · Python 1" (0인 언어는 생략). countsText 와 같은 모양. */
  function langsText(langs) {
    if (!langs || typeof langs !== 'object') return '';
    var parts = [];
    LANGS.forEach(function (l) {
      var n = Number(langs[l]) || 0;
      if (n > 0) parts.push(LANG_LABEL[l] + ' ' + n);
    });
    return parts.join(' · ');
  }

  JPK.qmeta = {
    TYPE_ORDER: TYPE_ORDER,
    TYPE_LABEL: TYPE_LABEL,
    LANGS: LANGS,
    LANG_LABEL: LANG_LABEL,
    normalizeType: normalizeType,
    normalizeLang: normalizeLang,
    questionOrigin: questionOrigin,
    typeLangText: typeLangText,
    countsText: countsText,
    langsText: langsText,
  };
})(window);
