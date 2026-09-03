'use strict';
/**
 * grader.js — 공용 채점 엔진 (순수 함수, Phase 0 동결)
 *
 * 동결된 원시 개념:
 *   accept      : 인정 답안 문자열 목록 (normalize 적용 후 비교)
 *   normalize   : "default" | "keepSpace" | "sql"  (모두 NFC 선행)
 *   answerMode  : "ordered" | "unordered"  (문항 레벨)
 *   validator   : { type, ... } 계산형 검증. validator 필드는 accept=[] 이며
 *                 normalize 미적용(원문 trim만 — 기존 자산 checkField 체계 계승).
 *
 * validator.type 카탈로그 확장은 다음 3단계 절차로만 허용된다(계획 원칙 3):
 *   (1) 여기에 타입 함수 추가
 *   (2) tests/grader.test.mjs 에 해당 타입 단위 테스트 추가
 *   (3) `npm run validate` 전 회차 재실행 통과
 * 이 절차 밖의 grader 수정은 금지.
 *
 * 절차의 유일한 예외(서버 H-1, 2026-09-02): **validator 예외를 오답으로 강등하는 방어벽**.
 * `runValidator` 는 카탈로그에 없는 타입·깨진 CIDR 같은 데이터 오류에 예외를 던진다. 그 예외가
 * `gradeSet` 밖으로 나가면 대전 리듀서 안에서 삼켜져 방이 영구 정지하고 전적이 사라졌다.
 * 채점 규칙은 한 글자도 바뀌지 않는다 — 던지던 자리가 `correct:false` 가 될 뿐이고,
 * 원인은 `logErr` 로 (문항 id, validator 타입) 당 한 번 남는다.
 *
 * 정규화 변경 이력(3단계 절차 적용 — 테스트 추가 + `npm run validate` + `npm run golden:check` 통과):
 *   2026-09-04  default: 선행 따옴표 제거 (서버 L-3) / sql: `,()` 주변 공백 제거 (서버 L-2).
 *               두 변경 모두 정답 인정 범위를 넓히는 방향이며, 전 회차 accept·sampleAnswer 자가채점과
 *               골든 회귀에서 판정 변화 0건을 확인했다.
 */

const logger = require('./logger.js');

// ---------------------------------------------------------------- normalize

const NORMALIZERS = {
  // NFC → 소문자 → 전공백 제거 → 선행 따옴표 제거 → 후행 구두점 제거
  //   선행 따옴표(2026-09-04, 서버 L-3): `"abc"` 처럼 답을 따옴표로 감싸면 후행만 지워져
  //   `"abc` 가 남아 오답이 됐다. 앞쪽은 따옴표류만 지운다(`.NET` 같은 선행 구두점은 보존).
  default(s) {
    return String(s == null ? '' : s)
      .normalize('NFC')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/^["'`]+/g, '')
      .replace(/["'`.,;:]+$/g, '');
  },
  // NFC → trim (내부 공백·대소문자 유지 — 코드 출력 등)
  keepSpace(s) {
    return String(s == null ? '' : s).normalize('NFC').trim();
  },
  // NFC → 소문자 → 연속 공백 1칸 압축 → `,` `(` `)` 주변 공백 제거 → 후행 세미콜론/마침표/공백 제거
  //   구두점 주변 공백(2026-09-04, 서버 L-2): `select a, b` 와 `select a,b` 가 달랐다. 데이터는
  //   변형을 accept 에 일일이 열거해 왔는데(72건), 이제 정규화가 흡수한다.
  sql(s) {
    return String(s == null ? '' : s)
      .normalize('NFC')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*([,()])\s*/g, '$1')
      .replace(/[\s;.]+$/g, '');
  },
};

const NORMALIZE_MODES = Object.keys(NORMALIZERS);

function normalizeValue(mode, value) {
  const fn = NORMALIZERS[mode || 'default'];
  if (!fn) throw new Error('unknown normalize mode: ' + mode);
  return fn(value);
}

// -------------------------------------------------------- validator 카탈로그

function ipToInt(s) {
  const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const parts = [+m[1], +m[2], +m[3], +m[4]];
  for (const p of parts) if (p > 255) return null;
  const prefix = m[5] !== undefined ? +m[5] : null;
  if (prefix !== null && prefix > 32) return null;
  return { val: ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3], prefix };
}

const VALIDATORS = {
  /**
   * ip-in-subnet: { cidr: "192.168.35.0/24", exclude: ["192.168.35.3"] }
   * 해당 CIDR 내 유효 호스트 주소인지 검사.
   * 네트워크 주소·브로드캐스트 주소·exclude 목록은 오답.
   * 입력에 프리픽스를 함께 쓴 경우 cidr 프리픽스와 일치해야 한다.
   */
  'ip-in-subnet': function (spec, rawValue) {
    const slash = String(spec.cidr).split('/');
    const net = ipToInt(slash[0]);
    const prefix = Number(slash[1]);
    if (!net || !Number.isInteger(prefix)) throw new Error('bad cidr: ' + spec.cidr);
    const size = Math.pow(2, 32 - prefix);
    const netStart = Math.floor(net.val / size) * size;
    const broadcast = netStart + size - 1;
    const excluded = (spec.exclude || []).map(function (ip) {
      const p = ipToInt(ip);
      if (!p) throw new Error('bad exclude ip: ' + ip);
      return p.val;
    });

    const got = ipToInt(rawValue);
    if (!got) return false;
    if (got.prefix !== null && got.prefix !== prefix) return false;
    if (got.val <= netStart || got.val >= broadcast) return false;
    if (excluded.indexOf(got.val) !== -1) return false;
    return true;
  },

  /**
   * keywords: { all: ["무결성"], any: ["제약", "규칙"], minAny: 1 }
   * 서술형("…을 서술하시오") 문항용. 입력과 키워드를 모두 default 정규화한 뒤
   *   - `all` 의 키워드가 전부 포함되고
   *   - `any` 의 키워드가 `minAny` 개 이상 포함되면 정답.
   * `minAny` 생략 시 `any` 가 비어 있지 않으면 1, 비어 있으면 0.
   * `all` 과 `any` 가 둘 다 비어 있는 spec 은 오류(무조건 정답이 되므로).
   * 등재 근거: 2020년 회차의 서술형 8문항 — accept 열거로는 정상 문장을 인정할 수 없음 (2026-08-29, lead 승인).
   */
  keywords: function (spec, rawValue) {
    const all = Array.isArray(spec.all) ? spec.all : [];
    const any = Array.isArray(spec.any) ? spec.any : [];
    if (all.length === 0 && any.length === 0) throw new Error('keywords validator needs all[] or any[]');
    const minAny = spec.minAny == null ? (any.length > 0 ? 1 : 0) : Number(spec.minAny);
    if (!Number.isInteger(minAny) || minAny < 0 || minAny > any.length) {
      throw new Error('keywords validator: bad minAny ' + spec.minAny);
    }
    const got = NORMALIZERS.default(rawValue);
    if (got === '') return false;
    for (let i = 0; i < all.length; i++) {
      if (got.indexOf(NORMALIZERS.default(all[i])) === -1) return false;
    }
    let hits = 0;
    for (let i = 0; i < any.length; i++) {
      if (got.indexOf(NORMALIZERS.default(any[i])) !== -1) hits++;
    }
    return hits >= minAny;
  },
};

const VALIDATOR_TYPES = Object.keys(VALIDATORS);

function runValidator(spec, rawValue) {
  const fn = VALIDATORS[spec.type];
  if (!fn) throw new Error('unknown validator type: ' + spec.type);
  return fn(spec, String(rawValue == null ? '' : rawValue).trim());
}

// -------------------------------------------------------------- 필드 매칭

/**
 * validator 예외를 이미 한 번 보고한 (문항 id, validator 타입) 짝.
 * 20문항 × 채점 수천 번이어도 로그는 짝당 한 줄이다. 크기는 데이터가 가진 짝 수로 묶여 있다.
 */
const reportedValidatorFaults = new Set();

/**
 * fieldAccepts(field, rawValue, questionId?) → boolean
 * `questionId` 는 로그용이다(없어도 판정은 같다 — golden-check 처럼 필드만 들고 부르는 곳이 있다).
 *
 * validator 가 던지면 **오답으로 강등**한다. 데이터 오류 하나가 대전 한 판을 멈추게 하는 것보다,
 * 그 문항만 오답이 되고 서버 로그에 원인이 남는 편이 낫다(서버 H-1).
 */
function fieldAccepts(field, rawValue, questionId) {
  try {
    return acceptsOrThrow(field, rawValue);
  } catch (e) {
    const key = String(questionId == null ? '(문항 미상)' : questionId) + '|'
      + (field && field.validator ? String(field.validator.type) : 'normalize:' + String(field && field.normalize));
    if (!reportedValidatorFaults.has(key)) {
      reportedValidatorFaults.add(key);
      logger.logErr('채점 규칙 예외 — 해당 필드를 오답 처리했습니다.', key, '-', e && e.message);
    }
    return false;
  }
}

/** 원래의 판정 로직. 던지는 경로가 여기 남아 있고, 강등은 위 `fieldAccepts` 가 한다. */
function acceptsOrThrow(field, rawValue) {
  if (field.validator) return runValidator(field.validator, rawValue);
  const mode = field.normalize || 'default';
  const got = normalizeValue(mode, rawValue);
  if (got === '') return false;
  // normalize 는 입력과 accept 양변에 동일 적용
  const accept = field.accept || [];
  for (let i = 0; i < accept.length; i++) {
    if (normalizeValue(mode, accept[i]) === got) return true;
  }
  return false;
}

// -------------------------------------------------------------- 문항 채점

function gradeOrdered(fields, answers, questionId) {
  return fields.map(function (f, i) {
    return {
      fieldIndex: i,
      label: f.label == null ? null : f.label,
      given: String(answers[i] == null ? '' : answers[i]),
      correct: fieldAccepts(f, answers[i], questionId),
    };
  });
}

/**
 * unordered: 입력값 집합 ↔ fields[] accept 집합의 최대 이분 매칭.
 * 규칙(P1-2): 매칭 전에 정규화된 입력값을 중복 제거한다.
 *   → accept 집합이 서로 겹쳐도 같은 답 하나로 두 필드를 채울 수 없다.
 *   → 중복 제거 후 입력 수 < 필드 수 이면 완전 매칭 실패(오답).
 * 전제: unordered 문항은 전 필드가 동일 normalize (validate-data.mjs 에서 강제 — dedupe 기준 단일화).
 */
function gradeUnordered(fields, answers, questionId) {
  // 카탈로그에 없는 normalize 값은 dedupe 기준을 세울 수 없다 — default 로 떨어뜨린다.
  // (그런 필드는 아래 fieldAccepts 에서 어차피 전부 오답으로 강등된다. 서버 H-1 과 같은 취지.)
  const raw0 = (fields[0] && fields[0].normalize) || 'default';
  const mode = NORMALIZERS[raw0] ? raw0 : 'default';

  // 원본 슬롯 인덱스를 유지한 채 정규화 후 중복 제거
  const seen = new Set();
  const candidates = []; // { origIndex, raw }
  for (let i = 0; i < fields.length; i++) {
    const raw = String(answers[i] == null ? '' : answers[i]);
    const norm = normalizeValue(mode, raw);
    if (norm === '' || seen.has(norm)) continue;
    seen.add(norm);
    candidates.push({ origIndex: i, raw: raw });
  }

  // 인접 리스트: candidate c 가 field f 를 만족하는가
  const adj = candidates.map(function (c) {
    const ok = [];
    for (let f = 0; f < fields.length; f++) if (fieldAccepts(fields[f], c.raw, questionId)) ok.push(f);
    return ok;
  });

  // 증가 경로(헝가리안) 최대 이분 매칭
  const matchField = new Array(fields.length).fill(-1); // field -> candidate index
  function tryAssign(c, visited) {
    for (let k = 0; k < adj[c].length; k++) {
      const f = adj[c][k];
      if (visited[f]) continue;
      visited[f] = true;
      if (matchField[f] === -1 || tryAssign(matchField[f], visited)) {
        matchField[f] = c;
        return true;
      }
    }
    return false;
  }
  for (let c = 0; c < candidates.length; c++) {
    tryAssign(c, new Array(fields.length).fill(false));
  }

  const matchedCount = matchField.filter(function (c) { return c !== -1; }).length;
  const complete = matchedCount === fields.length;

  // 실제 매칭에 쓰인 candidate 의 원본 슬롯 집합
  const okOrig = new Set();
  for (let f = 0; f < matchField.length; f++) {
    if (matchField[f] !== -1) okOrig.add(candidates[matchField[f]].origIndex);
  }

  // 필드 결과는 "입력 슬롯" 기준으로 되돌려 준다(사용자는 자기가 입력한 칸을 본다)
  const fieldResults = fields.map(function (f, i) {
    return {
      fieldIndex: i,
      label: f.label == null ? null : f.label,
      given: String(answers[i] == null ? '' : answers[i]),
      correct: okOrig.has(i),
    };
  });
  return { fieldResults: fieldResults, complete: complete };
}

/**
 * gradeQuestion(question, answers) → { questionId, correct, fieldResults[], display }
 * answers: 필드 순서대로의 문자열 배열 (없으면 '')
 * 문항 정답 = 모든 필드 정답 (부분점수 없음)
 */
function gradeQuestion(question, answers) {
  const fields = question.fields || [];
  const given = Array.isArray(answers) ? answers : [];
  const display = question.display == null ? '' : question.display;
  if (fields.length === 0) {
    return { questionId: question.id, correct: false, fieldResults: [], display: display };
  }
  if (question.answerMode === 'unordered') {
    const r = gradeUnordered(fields, given, question.id);
    return { questionId: question.id, correct: r.complete, fieldResults: r.fieldResults, display: display };
  }
  const fieldResults = gradeOrdered(fields, given, question.id);
  return {
    questionId: question.id,
    correct: fieldResults.every(function (r) { return r.correct; }),
    fieldResults: fieldResults,
    display: display,
  };
}

/**
 * gradeSet(questions, answersMap) → { correctCount, totalCount, score, details[] }
 * answersMap: { [questionId]: string[] }
 * 점수 = Math.round(correctCount / totalCount * 100) — 문항 수 무관 100점 만점
 */
function gradeSet(questions, answersMap) {
  const map = answersMap || {};
  const details = questions.map(function (q) { return gradeQuestion(q, map[q.id] || []); });
  const correctCount = details.filter(function (d) { return d.correct; }).length;
  const totalCount = questions.length;
  const score = totalCount === 0 ? 0 : Math.round((correctCount / totalCount) * 100);
  return { correctCount: correctCount, totalCount: totalCount, score: score, details: details };
}

module.exports = {
  gradeQuestion: gradeQuestion,
  gradeSet: gradeSet,
  normalizeValue: normalizeValue,
  fieldAccepts: fieldAccepts,
  runValidator: runValidator,
  ipToInt: ipToInt,
  NORMALIZE_MODES: NORMALIZE_MODES,
  VALIDATOR_TYPES: VALIDATOR_TYPES,
};
