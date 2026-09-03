'use strict';
/**
 * qtypes.js — 문항 유형·언어 동결 계약 + 클라이언트 공개 화이트리스트 (단일 출처).
 *
 * 예전에는 같은 상수·정규화 함수가 `rounds.js`·`battle.js`·`scripts/validate-types.mjs`·
 * `scripts/validate-langs.mjs` 네 곳에 복제돼 있었고, 동기화를 지켜 주는 것은 사람 기억뿐이었다.
 * 이 파일이 그 유일한 출처다 — 네 곳 전부 여기서 가져다 쓴다.
 *
 * **순수 모듈이다.** fs·경로·전역 상태를 일절 건드리지 않으므로 ESM 검증기(.mjs)가
 * `import qtypes from '../server/qtypes.js'` 로 불러도 회차 데이터를 로드하지 않는다.
 *
 * 용어
 *   is*(v)        값 하나가 동결 집합에 드는가 → boolean
 *   normalize*(v) 동결 집합에 들면 그 값, 아니면 null (= "전체")
 *   typeOf(q)     문항의 유형. 미분류·깨진 값은 기본값(theory)
 *   langOf(q)     문항의 언어. **코드 유형에만** 값이 있고 기본값이 없다(없으면 null)
 */

// ------------------------------------------------------------------- 유형

/** 문항 유형 동결 집합. data/types/*.json 의 값 집합과 반드시 같다(SCHEMA.md). */
const TYPES = ['code', 'sql', 'theory'];
const DEFAULT_TYPE = 'theory';

/** 값 하나가 계약을 만족하는가. 쿼리 파라미터 검사도 이 함수를 쓴다. */
function isType(v) {
  return typeof v === 'string' && TYPES.indexOf(v) !== -1;
}

/** 문항·방 설정의 유형 정규화. 허용되지 않은 값은 null(= 전체). */
function normalizeType(v) {
  return isType(v) ? v : null;
}

/** 문항의 유형. 분류가 없거나 깨졌으면 기본값(theory). */
function typeOf(q) {
  return q && isType(q.type) ? q.type : DEFAULT_TYPE;
}

// ------------------------------------------------------------------- 언어

/** 코드 문항 언어 동결 집합. data/langs/*.json 의 값 집합과 반드시 같다(SCHEMA.md). */
const LANGS = ['c', 'java', 'python'];

/** 값 하나가 계약을 만족하는가. 쿼리 파라미터 검사도 이 함수를 쓴다. */
function isLang(v) {
  return typeof v === 'string' && LANGS.indexOf(v) !== -1;
}

/** 문항·방 설정의 언어 정규화. 허용되지 않은 값은 null(= 전체). */
function normalizeLang(v) {
  return isLang(v) ? v : null;
}

/**
 * 문항의 프로그래밍 언어. **코드 유형 문항에만** 값이 있다.
 * 비코드 문항·미분류·깨진 값은 전부 null 이다 — 유형과 달리 기본값이 없다.
 */
function langOf(q) {
  if (!q || typeOf(q) !== 'code') return null;
  return normalizeLang(q.lang);
}

// --------------------------------------------------------- 공개 화이트리스트

/**
 * 클라이언트 전송용 문항 사본. **클라이언트로 나가는 모든 문항은 반드시 이 함수를 거친다.**
 *
 * 언제나 남기는 것: `id`, `num`, `prompt`, `bodyHtml`, `type`, `lang`, `fields[].label`
 * 언제나 제거하는 것: `accept`, `sampleAnswer`, `validator`, `normalize`, `display`,
 *   `sourceImages`, `explanationHtml`, 그 밖에 문항 객체에 새로 붙는 모든 필드
 *   (SCHEMA.md "클라이언트에 절대 전송 금지")
 *
 * **화이트리스트 방식**이라 문항 객체에 무슨 필드가 새로 붙든 자동으로 걸러진다.
 *
 * `type`·`lang` 은 정답 정보가 아니다 — 문항 카드의 유형·언어 뱃지와 필터에 필요하므로
 * 채점 전에도 나간다(SCHEMA.md·PROTOCOL.md).
 *
 * ── 선택 필드 (`opts`) ──
 * 두 호출부의 계약이 서로 다르므로 **차이를 옵션으로만** 둔다. 금지 필드 제거 규칙은 공통이다.
 *   · `bodyText`   지문 평문. 학습 REST 는 **채점 응답의 `bodyTexts` 맵으로만** 내보내고
 *                  (`PROTOCOL.md` "채점 전 비노출"), 대전은 `battle:questions` 에 실어 보낸다.
 *   · `answerMode` 답 배열의 순서 무관 여부. 대전 클라이언트 전용 정보다.
 *
 * @param {object} q 문항 원본
 * @param {{bodyText?:boolean, answerMode?:boolean}} [opts]
 */
function publicQuestion(q, opts) {
  const o = opts || {};
  const out = {
    id: q.id,
    num: q.num,
    prompt: q.prompt == null ? '' : q.prompt,
    bodyHtml: q.bodyHtml == null ? '' : q.bodyHtml,
    type: typeOf(q),
    lang: langOf(q),
    fields: (q.fields || []).map(function (f) {
      return { label: f.label == null ? null : f.label };
    }),
  };
  if (o.bodyText) out.bodyText = q.bodyText == null ? '' : q.bodyText;
  if (o.answerMode) out.answerMode = q.answerMode === 'unordered' ? 'unordered' : 'ordered';
  return out;
}

module.exports = {
  TYPES: TYPES,
  DEFAULT_TYPE: DEFAULT_TYPE,
  LANGS: LANGS,
  isType: isType,
  normalizeType: normalizeType,
  typeOf: typeOf,
  isLang: isLang,
  normalizeLang: normalizeLang,
  langOf: langOf,
  publicQuestion: publicQuestion,
};
