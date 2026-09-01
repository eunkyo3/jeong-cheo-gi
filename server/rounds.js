'use strict';
/**
 * rounds.js — 회차 문제 데이터 로더 (공용).
 *
 * 기동 시 `data/rounds/*.json` 을 전부 메모리로 읽는다. 이후 파일시스템 접근 없음.
 *   - 회차 id 는 **인메모리 화이트리스트**로만 조회한다 (경로 순회 차단, PROTOCOL.md).
 *   - `publicQuestion()` 은 정답 계열 필드를 전부 제거한 사본을 만든다.
 *     클라이언트로 나가는 모든 문항은 반드시 이 함수를 거친다.
 *
 * 깨진 파일 하나가 서버 기동을 막지 않도록, 파일 단위로 검증하고 실패는 경고 후 건너뛴다.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROUNDS_DIR = path.join(__dirname, '..', 'data', 'rounds');
const EXPLAIN_DIR = path.join(__dirname, '..', 'data', 'explanations');
const TYPES_DIR = path.join(__dirname, '..', 'data', 'types');
const LANGS_DIR = path.join(__dirname, '..', 'data', 'langs');

/** 문항 유형 동결 집합. scripts/validate-types.mjs 의 TYPES 와 반드시 같아야 한다. */
const TYPES = ['code', 'sql', 'theory'];
const DEFAULT_TYPE = 'theory';

/** 값 하나가 계약을 만족하는가. 쿼리 파라미터 검사도 이 함수를 쓴다. */
function isType(v) {
  return typeof v === 'string' && TYPES.indexOf(v) !== -1;
}

/** 문항의 유형. 분류가 없거나 깨졌으면 기본값(theory). */
function typeOf(q) {
  return q && isType(q.type) ? q.type : DEFAULT_TYPE;
}

/** 코드 문항 언어 동결 집합. scripts/validate-langs.mjs 의 LANGS 와 반드시 같아야 한다. */
const LANGS = ['c', 'java', 'python'];

/** 값 하나가 계약을 만족하는가. 쿼리 파라미터 검사도 이 함수를 쓴다. */
function isLang(v) {
  return typeof v === 'string' && LANGS.indexOf(v) !== -1;
}

/**
 * 문항의 프로그래밍 언어. **코드 유형 문항에만** 값이 있다.
 * 비코드 문항·미분류·깨진 값은 전부 null 이다 — 유형과 달리 기본값이 없다.
 */
function langOf(q) {
  if (!q || typeOf(q) !== 'code') return null;
  return isLang(q.lang) ? q.lang : null;
}

/** @type {Array<object>} 연도→회차 오름차순 정렬된 회차 원본 */
let ordered = [];
/** @type {Map<string, object>} 화이트리스트 겸 조회 인덱스 */
let byId = new Map();
/** @type {Map<string, object>} 전역 문항 id → 문항 */
let byQuestionId = new Map();
/** @type {Array<object>} 전 회차 문항 평탄화 */
let flatQuestions = [];

// ------------------------------------------------------------------ 정렬 키

/** "2026-2" → [2026, 2]. 형식이 다르면 뒤로 밀되 문자열 순서를 유지한다. */
function sortKey(id) {
  const m = /^(\d{4})-(\d+)$/.exec(String(id));
  if (!m) return [Number.MAX_SAFE_INTEGER, 0, String(id)];
  return [Number(m[1]), Number(m[2]), ''];
}

function compareRounds(a, b) {
  const ka = sortKey(a.round);
  const kb = sortKey(b.round);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}

// -------------------------------------------------------------------- 검증

/** 최소 스키마 검사. 깊은 검증은 `npm run validate` 담당. */
function validateRound(data, file) {
  if (!data || typeof data !== 'object') throw new Error('객체가 아님');
  if (typeof data.round !== 'string' || data.round === '') throw new Error('round 누락');
  if (!Array.isArray(data.questions)) throw new Error('questions 배열 누락');
  const base = path.basename(file, '.json');
  if (data.round !== base) {
    console.warn('[rounds] ' + file + ': round("' + data.round + '") 가 파일명과 다릅니다. 파일명을 따릅니다.');
    data.round = base;
  }
  data.questions.forEach(function (q, i) {
    if (!q || typeof q !== 'object') throw new Error('questions[' + i + '] 가 객체가 아님');
    if (typeof q.id !== 'string' || q.id === '') throw new Error('questions[' + i + '].id 누락');
    if (!Array.isArray(q.fields)) throw new Error(q.id + '.fields 배열 누락');
  });
  return data;
}

// ---------------------------------------------------------------- 해설 부착

/**
 * `data/explanations/<round>.json` 을 읽어 문항 객체에 `explanationHtml` 을 붙인다.
 *
 * **내부 전용 필드다.** publicQuestion() 이 화이트리스트 방식이라 클라이언트로 나가는 문항
 * 사본에는 절대 실리지 않는다(battle.js 의 publicQuestion 도 마찬가지). 해설은 채점이
 * 끝난 뒤 채점 응답·battle:finished 페이로드로만 나간다 — PROTOCOL.md "채점 전 비노출".
 *
 * 해설은 부가 자산이므로, 파일이 없거나 깨져도 서버는 그냥 뜬다(경고 후 건너뜀).
 *
 * @returns {{ files: number, attached: number }}
 */
function loadExplanations() {
  let files = [];
  try {
    files = fs.readdirSync(EXPLAIN_DIR).filter(function (f) { return f.toLowerCase().endsWith('.json'); });
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[rounds] ' + EXPLAIN_DIR + ' 를 읽을 수 없습니다: ' + e.message);
    return { files: 0, attached: 0 };
  }

  let ok = 0;
  let attached = 0;
  for (const file of files.sort()) {
    const full = path.join(EXPLAIN_DIR, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn('[rounds] 해설 ' + file + ' 건너뜀 — ' + e.message);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !doc.explanations || typeof doc.explanations !== 'object') {
      console.warn('[rounds] 해설 ' + file + ' 건너뜀 — explanations 객체가 없습니다.');
      continue;
    }
    ok++;
    for (const qid of Object.keys(doc.explanations)) {
      const html = doc.explanations[qid];
      if (typeof html !== 'string' || html === '') continue;
      const q = byQuestionId.get(qid);
      if (!q) {
        console.warn('[rounds] 해설 ' + file + ': 알 수 없는 문항 id ' + qid + ' — 무시합니다.');
        continue;
      }
      q.explanationHtml = html;
      attached++;
    }
  }
  return { files: ok, attached: attached };
}

// ---------------------------------------------------------------- 유형 부착

/**
 * `data/types/<round>.json` 을 읽어 문항 객체에 `type`("code"|"sql"|"theory") 을 붙인다.
 *
 * 해설과 달리 **정답 정보가 아니다** — publicQuestion() 화이트리스트에 올라가 클라이언트로 나간다
 * (유형 뱃지·유형 필터용, handoff "API/UI 계약").
 *
 * 분류는 부가 자산이므로 파일이 없거나 깨져도 서버는 그냥 뜬다: 그 문항은 기본값 theory 로 두고
 * 경고만 남긴다. 문항 하나하나 경고하면 로그가 덮이므로 **회차 단위로 요약**해 한 줄씩 찍는다.
 *
 * @returns {{ files:number, attached:number, defaulted:number }}
 */
function loadTypes() {
  let files = [];
  try {
    files = fs.readdirSync(TYPES_DIR).filter(function (f) { return f.toLowerCase().endsWith('.json'); });
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[rounds] ' + TYPES_DIR + ' 를 읽을 수 없습니다: ' + e.message);
    files = [];
  }

  let ok = 0;
  let attached = 0;
  for (const file of files.sort()) {
    const full = path.join(TYPES_DIR, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn('[rounds] 유형 ' + file + ' 건너뜀 — ' + e.message);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !doc.types || typeof doc.types !== 'object') {
      console.warn('[rounds] 유형 ' + file + ' 건너뜀 — types 객체가 없습니다.');
      continue;
    }
    ok++;
    let unknownIds = 0;
    let badValues = 0;
    for (const qid of Object.keys(doc.types)) {
      const v = doc.types[qid];
      const q = byQuestionId.get(qid);
      if (!q) { unknownIds++; continue; }
      if (!isType(v)) { badValues++; continue; }
      q.type = v;
      attached++;
    }
    if (unknownIds) console.warn('[rounds] 유형 ' + file + ': 알 수 없는 문항 id ' + unknownIds + '건 — 무시합니다.');
    if (badValues) console.warn('[rounds] 유형 ' + file + ': 허용되지 않은 값 ' + badValues + '건 — 기본값(' + DEFAULT_TYPE + ')으로 둡니다.');
  }

  // 분류가 닿지 않은 문항은 기본값으로 채운다 — q.type 은 항상 유효한 값이다.
  let defaulted = 0;
  const missingByRound = new Map();
  for (const r of ordered) {
    for (const q of r.questions) {
      if (isType(q.type)) continue;
      q.type = DEFAULT_TYPE;
      defaulted++;
      missingByRound.set(r.round, (missingByRound.get(r.round) || 0) + 1);
    }
  }
  for (const entry of missingByRound) {
    console.warn('[rounds] 유형 미분류 ' + entry[0] + ': ' + entry[1] + '문항 — 기본값(' + DEFAULT_TYPE + ')으로 둡니다.');
  }

  return { files: ok, attached: attached, defaulted: defaulted };
}

// ---------------------------------------------------------------- 언어 부착

/**
 * `data/langs/<round>.json` 을 읽어 **코드 유형 문항**에 `lang`("c"|"java"|"python") 을 붙인다.
 *
 * 유형과 마찬가지로 **정답 정보가 아니다** — publicQuestion() 화이트리스트에 올라가 채점 전에도
 * 클라이언트로 나간다(언어 뱃지·언어 필터용, handoff C2).
 *
 * 유형과 다른 점: **기본값이 없다.** 분류가 없으면 그 문항의 lang 은 그냥 null 이고
 * 언어 필터에서 빠질 뿐이다(비코드 문항은 애초에 대상이 아니다).
 *
 * 분류는 부가 자산이므로 파일이 없거나 깨져도 서버는 그냥 뜬다. loadTypes 와 같은 규칙으로
 * 문항 단위 경고 대신 **회차 단위로 요약**해 한 줄씩 찍는다.
 *
 * loadTypes() **뒤에** 불러야 한다 — 코드 유형 판정이 끝나 있어야 비코드 문항을 걸러낼 수 있다.
 *
 * @returns {{ files:number, attached:number, unclassified:number }}
 */
function loadLangs() {
  let files = [];
  try {
    files = fs.readdirSync(LANGS_DIR).filter(function (f) { return f.toLowerCase().endsWith('.json'); });
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[rounds] ' + LANGS_DIR + ' 를 읽을 수 없습니다: ' + e.message);
    files = [];
  }

  let ok = 0;
  let attached = 0;
  for (const file of files.sort()) {
    const full = path.join(LANGS_DIR, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (e) {
      console.warn('[rounds] 언어 ' + file + ' 건너뜀 — ' + e.message);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !doc.langs || typeof doc.langs !== 'object') {
      console.warn('[rounds] 언어 ' + file + ' 건너뜀 — langs 객체가 없습니다.');
      continue;
    }
    ok++;
    let unknownIds = 0;
    let badValues = 0;
    let notCode = 0;
    for (const qid of Object.keys(doc.langs)) {
      const v = doc.langs[qid];
      const q = byQuestionId.get(qid);
      if (!q) { unknownIds++; continue; }
      if (!isLang(v)) { badValues++; continue; }
      if (typeOf(q) !== 'code') { notCode++; continue; }
      q.lang = v;
      attached++;
    }
    if (unknownIds) console.warn('[rounds] 언어 ' + file + ': 알 수 없는 문항 id ' + unknownIds + '건 — 무시합니다.');
    if (badValues) console.warn('[rounds] 언어 ' + file + ': 허용되지 않은 값 ' + badValues + '건 — 무시합니다.');
    if (notCode) console.warn('[rounds] 언어 ' + file + ': 코드 유형이 아닌 문항 ' + notCode + '건 — 무시합니다.');
  }

  // 언어가 닿지 않은 코드 문항은 lang=null 로 남는다(언어 필터에서만 빠진다).
  let unclassified = 0;
  const missingByRound = new Map();
  for (const r of ordered) {
    for (const q of r.questions) {
      if (typeOf(q) !== 'code' || isLang(q.lang)) continue;
      unclassified++;
      missingByRound.set(r.round, (missingByRound.get(r.round) || 0) + 1);
    }
  }
  for (const entry of missingByRound) {
    console.warn('[rounds] 언어 미분류 ' + entry[0] + ': 코드 ' + entry[1] + '문항 — lang=null 로 둡니다.');
  }

  return { files: ok, attached: attached, unclassified: unclassified };
}

// -------------------------------------------------------------------- 로드

function reload() {
  ordered = [];
  byId = new Map();
  byQuestionId = new Map();
  flatQuestions = [];

  let files = [];
  try {
    files = fs.readdirSync(ROUNDS_DIR).filter(function (f) { return f.toLowerCase().endsWith('.json'); });
  } catch (e) {
    console.warn('[rounds] ' + ROUNDS_DIR + ' 를 읽을 수 없습니다: ' + e.message);
    return { loaded: 0, skipped: 0 };
  }

  let skipped = 0;
  for (const file of files.sort()) {
    const full = path.join(ROUNDS_DIR, file);
    let data;
    try {
      data = validateRound(JSON.parse(fs.readFileSync(full, 'utf8')), file);
    } catch (e) {
      skipped++;
      console.warn('[rounds] ' + file + ' 건너뜀 — ' + e.message);
      continue;
    }
    if (byId.has(data.round)) {
      skipped++;
      console.warn('[rounds] ' + file + ' 건너뜀 — 회차 id 중복: ' + data.round);
      continue;
    }
    byId.set(data.round, data);
    ordered.push(data);
    for (const q of data.questions) {
      if (byQuestionId.has(q.id)) {
        console.warn('[rounds] 문항 id 중복: ' + q.id + ' (' + file + ') — 먼저 로드된 쪽을 유지합니다.');
        continue;
      }
      byQuestionId.set(q.id, q);
      flatQuestions.push(q);
    }
  }

  ordered.sort(compareRounds);

  // 문항 인덱스가 완성된 뒤에 해설·유형을 얹는다. 언어는 유형 판정에 기대므로 유형 다음이다.
  const ex = loadExplanations();
  const ty = loadTypes();
  const lg = loadLangs();

  return {
    loaded: ordered.length,
    skipped: skipped,
    explanationFiles: ex.files,
    explanations: ex.attached,
    typeFiles: ty.files,
    types: ty.attached,
    typesDefaulted: ty.defaulted,
    langFiles: lg.files,
    langs: lg.attached,
    langsUnclassified: lg.unclassified,
  };
}

// -------------------------------------------------------------------- 조회

/** 문항 배열의 유형별 개수 {code, sql, theory}. 합계는 언제나 배열 길이다. */
function countTypes(questions) {
  const counts = {};
  for (const t of TYPES) counts[t] = 0;
  for (const q of questions || []) counts[typeOf(q)] += 1;
  return counts;
}

/**
 * 문항 배열의 언어별 개수 {c, java, python}.
 * **코드 문항만** 센다 — 합계는 countTypes(...).code 이하다(미분류 코드 문항만큼 모자랄 수 있다).
 */
function countLangs(questions) {
  const counts = {};
  for (const l of LANGS) counts[l] = 0;
  for (const q of questions || []) {
    const l = langOf(q);
    if (l) counts[l] += 1;
  }
  return counts;
}

/**
 * @returns {Array<{round:string,title:string,questionCount:number,
 *   counts:{code:number,sql:number,theory:number},langs:{c:number,java:number,python:number}}>}
 * 연도→회차 오름차순
 */
function listRounds() {
  return ordered.map(function (r) {
    return {
      round: r.round,
      title: r.title || r.round,
      questionCount: r.questions.length,
      counts: countTypes(r.questions),
      langs: countLangs(r.questions),
    };
  });
}

/**
 * 유형 필터. type 이 null/빈 값이면 원본을 그대로(사본으로) 돌려준다 — "전체".
 * 문항 객체는 원본 참조 그대로다(불변 데이터).
 */
function filterByType(questions, type) {
  const list = questions || [];
  if (!isType(type)) return list.slice();
  return list.filter(function (q) { return typeOf(q) === type; });
}

/**
 * 언어 필터. lang 이 null/빈 값이면 원본을 그대로(사본으로) 돌려준다 — "전체".
 * 유효한 언어를 주면 **그 언어의 코드 문항만** 남는다(비코드·미분류는 langOf 가 null 이라 자연히 빠진다).
 * 문항 객체는 원본 참조 그대로다(불변 데이터).
 */
function filterByLang(questions, lang) {
  const list = questions || [];
  if (!isLang(lang)) return list.slice();
  return list.filter(function (q) { return langOf(q) === lang; });
}

/** 회차 id(또는 회차 객체)의 특정 유형 문항. 없는 회차면 빈 배열. */
function questionsOfType(round, type) {
  const r = typeof round === 'string' ? byId.get(round) : round;
  if (!r || !Array.isArray(r.questions)) return [];
  return filterByType(r.questions, type);
}

/**
 * 회차 원본(정답 포함)을 반환한다. **서버 내부 전용.**
 * id 는 인메모리 화이트리스트로만 검사하며 파일시스템을 건드리지 않는다.
 */
function getRound(id) {
  if (typeof id !== 'string') return null;
  return byId.get(id) || null;
}

/** 전역 문항 id("2026-2#1") → 문항 원본. 랜덤 출제용. */
function getQuestion(globalId) {
  if (typeof globalId !== 'string') return null;
  return byQuestionId.get(globalId) || null;
}

/** 전 회차 문항 평탄화 배열(원본 참조). 랜덤 풀 구성용. */
function allQuestions() {
  return flatQuestions.slice();
}

/** 회차 id 화이트리스트. */
function hasRound(id) {
  return typeof id === 'string' && byId.has(id);
}

/**
 * 문항 해설 HTML. 없으면 빈 문자열.
 * **채점이 끝난 뒤에만** 응답에 실어야 한다(PROTOCOL.md "채점 전 비노출").
 */
function explanationOf(qid) {
  const q = byQuestionId.get(qid);
  return q && typeof q.explanationHtml === 'string' ? q.explanationHtml : '';
}

/**
 * 클라이언트 전송용 문항 사본.
 * 남기는 것: id, num, prompt, bodyHtml, type, lang, fields[].label
 * 제거하는 것: accept, sampleAnswer, validator, normalize, display, bodyText, sourceImages,
 *              answerMode, explanationHtml
 * (SCHEMA.md "클라이언트에 절대 전송 금지")
 *
 * `type`·`lang` 은 **정답 정보가 아니다** — 문항 카드의 유형·언어 뱃지와 필터에 필요하므로 채점 전에도 나간다.
 *
 * **화이트리스트 방식**이라 문항 객체에 무슨 필드가 새로 붙든 자동으로 걸러진다 —
 * explanationHtml 도 여기서는 절대 나가지 않는다(채점 응답에서만 나간다).
 */
function publicQuestion(q) {
  return {
    id: q.id,
    num: q.num,
    prompt: q.prompt == null ? '' : q.prompt,
    bodyHtml: q.bodyHtml == null ? '' : q.bodyHtml,
    type: typeOf(q),
    lang: langOf(q), // 코드 문항의 언어(c|java|python) 또는 null — 유형과 같은 이유로 채점 전에도 나간다
    fields: (q.fields || []).map(function (f) {
      return { label: f.label == null ? null : f.label };
    }),
  };
}

const stats = reload();
if (stats.loaded === 0) {
  console.warn('[rounds] 로드된 회차가 없습니다. data/rounds/*.json 을 확인하세요.');
}
if (stats.explanationFiles === 0) {
  console.warn('[rounds] 해설 파일이 없습니다. data/explanations/*.json (해설 없이도 동작합니다).');
}
if (stats.langFiles === 0) {
  console.warn('[rounds] 언어 분류 파일이 없습니다. data/langs/*.json (코드 문항 lang 이 전부 null 로 동작합니다).');
}
if (stats.typeFiles === 0) {
  console.warn('[rounds] 유형 분류 파일이 없습니다. data/types/*.json (전 문항이 ' + DEFAULT_TYPE + ' 로 동작합니다).');
}

module.exports = {
  ROUNDS_DIR: ROUNDS_DIR,
  TYPES_DIR: TYPES_DIR,
  LANGS_DIR: LANGS_DIR,
  TYPES: TYPES,
  DEFAULT_TYPE: DEFAULT_TYPE,
  LANGS: LANGS,
  isType: isType,
  typeOf: typeOf,
  isLang: isLang,
  langOf: langOf,
  countTypes: countTypes,
  countLangs: countLangs,
  filterByType: filterByType,
  filterByLang: filterByLang,
  questionsOfType: questionsOfType,
  listRounds: listRounds,
  getRound: getRound,
  getQuestion: getQuestion,
  allQuestions: allQuestions,
  hasRound: hasRound,
  explanationOf: explanationOf,
  publicQuestion: publicQuestion,
  reload: reload,
};
