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

  // 문항 인덱스가 완성된 뒤에 해설을 얹는다.
  const ex = loadExplanations();

  return { loaded: ordered.length, skipped: skipped, explanationFiles: ex.files, explanations: ex.attached };
}

// -------------------------------------------------------------------- 조회

/** @returns {Array<{round:string,title:string,questionCount:number}>} 연도→회차 오름차순 */
function listRounds() {
  return ordered.map(function (r) {
    return {
      round: r.round,
      title: r.title || r.round,
      questionCount: r.questions.length,
    };
  });
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
 * 남기는 것: id, num, prompt, bodyHtml, fields[].label
 * 제거하는 것: accept, sampleAnswer, validator, normalize, display, bodyText, sourceImages,
 *              answerMode, explanationHtml
 * (SCHEMA.md "클라이언트에 절대 전송 금지")
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

module.exports = {
  ROUNDS_DIR: ROUNDS_DIR,
  listRounds: listRounds,
  getRound: getRound,
  getQuestion: getQuestion,
  allQuestions: allQuestions,
  hasRound: hasRound,
  explanationOf: explanationOf,
  publicQuestion: publicQuestion,
  reload: reload,
};
