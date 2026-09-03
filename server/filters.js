'use strict';
/**
 * filters.js — 유형·언어 쿼리 파라미터 해석 + 답안 정리 (학습 REST 공용).
 *
 * 학습·모의고사·오답노트·대전이 **같은 규칙**을 쓰도록 한 곳에 모아 둔다.
 * 원래 index.js 안에 있던 함수들을 그대로 옮긴 것이고 동작은 바뀌지 않았다.
 *
 * 여기 있는 함수는 전부 순수 함수다 — 요청 객체도 db 도 모른다.
 */

const rounds = require('./rounds.js');

const LANG_NEEDS_CODE = 'lang 은 코드 문항에만 쓸 수 있습니다.';
const NO_QUESTIONS_OF_TYPE = '해당 유형의 문항이 없습니다.';
const NO_QUESTIONS_OF_LANG = '해당 언어의 문항이 없습니다.';

/**
 * 유형 파라미터 해석 — 학습·모의고사·오답노트·대전이 전부 같은 규칙을 쓰도록 한 곳에 둔다.
 * 미지정·빈 값·"all" 은 **전체**(type=null)이고, 그 밖의 값은 `code|sql|theory` 만 허용한다.
 * @returns {{ok:true, type:string|null} | {ok:false, error:string}}
 */
function parseType(raw) {
  if (raw == null) return { ok: true, type: null };
  const bad = { ok: false, error: '유형은 ' + rounds.TYPES.join('/') + ' 중 하나여야 합니다.' };
  if (typeof raw !== 'string') return bad; // ?type=a&type=b 처럼 배열로 들어온 경우
  const v = raw.trim();
  if (v === '' || v === 'all') return { ok: true, type: null };
  return rounds.isType(v) ? { ok: true, type: v } : bad;
}

/**
 * 언어 파라미터 해석 — parseType 과 같은 규약이다.
 * 미지정·빈 값·"all" 은 **전체**(lang=null)이고, 그 밖의 값은 `c|java|python` 만 허용한다.
 * @returns {{ok:true, lang:string|null} | {ok:false, error:string}}
 */
function parseLang(raw) {
  if (raw == null) return { ok: true, lang: null };
  const bad = { ok: false, error: '언어는 ' + rounds.LANGS.join('/') + ' 중 하나여야 합니다.' };
  if (typeof raw !== 'string') return bad; // ?lang=a&lang=b 처럼 배열로 들어온 경우
  const v = raw.trim();
  if (v === '' || v === 'all') return { ok: true, lang: null };
  return rounds.isLang(v) ? { ok: true, lang: v } : bad;
}

/**
 * 유형 + 언어를 **함께** 해석한다 (handoff C3). 학습·모의고사·오답노트가 전부 이 한 곳을 쓴다.
 *   · 언어는 코드 문항에만 있다 → `lang` 이 오면 `type` 은 생략이거나 `code` 여야 한다.
 *   · `lang` 만 오면 `type=code` 로 간주한다 — 아래 호출부가 유형 필터를 그대로 쓰면 된다.
 * @param {object} src `req.query` 또는 `req.body`
 * @returns {{ok:true, type:string|null, lang:string|null} | {ok:false, error:string}}
 */
function parseFilters(src) {
  const q = src || {};
  const t = parseType(q.type);
  if (!t.ok) return t;
  const l = parseLang(q.lang);
  if (!l.ok) return l;
  if (l.lang && t.type && t.type !== 'code') return { ok: false, error: LANG_NEEDS_CODE };
  return { ok: true, type: l.lang ? 'code' : t.type, lang: l.lang };
}

/** 유형·언어 필터를 순서대로 건다. 둘 다 null 이면 원본 사본 그대로다. */
function applyFilters(questions, f) {
  return rounds.filterByLang(rounds.filterByType(questions, f.type), f.lang);
}

/** 필터 결과가 비었을 때 쓸 사유 — 언어까지 걸었으면 언어 쪽을 말해 준다. */
function emptyReason(f) {
  return f.lang ? NO_QUESTIONS_OF_LANG : NO_QUESTIONS_OF_TYPE;
}

/**
 * 제출 답안 정리: 주어진 문항 목록에 실제로 있는 문항 id 만, 필드 수만큼만, 문자열로.
 * 클라이언트가 뭘 보내든 채점기에 이상한 값이 들어가지 않게 한다.
 * (회차 채점과 모의고사/오답노트 채점이 같은 규칙을 쓰도록 문항 배열을 받는다.)
 */
function sanitizeAnswers(questions, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of questions) {
    const given = raw[q.id];
    if (!Array.isArray(given)) continue;
    out[q.id] = q.fields.map(function (_f, i) {
      const v = given[i];
      return typeof v === 'string' ? v.slice(0, 500) : '';
    });
  }
  return out;
}

/** 채점 결과 details → 틀린 문항 id 배열. study_results.wrong_ids 에 그대로 들어간다. */
function wrongIdsOf(details) {
  const out = [];
  for (const d of details || []) if (d.correct === false) out.push(d.questionId);
  return out;
}

module.exports = {
  LANG_NEEDS_CODE: LANG_NEEDS_CODE,
  NO_QUESTIONS_OF_TYPE: NO_QUESTIONS_OF_TYPE,
  NO_QUESTIONS_OF_LANG: NO_QUESTIONS_OF_LANG,
  parseType: parseType,
  parseLang: parseLang,
  parseFilters: parseFilters,
  applyFilters: applyFilters,
  emptyReason: emptyReason,
  sanitizeAnswers: sanitizeAnswers,
  wrongIdsOf: wrongIdsOf,
};
