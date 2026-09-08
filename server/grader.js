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
 *   2026-09-08  전 모드 `preClean` 선행(폭 0 문자 제거·전각/비분리 공백 → 보통 공백·CRLF 통일) /
 *               keepSpace: 줄 trim + 연속 공백 압축 + `,;:()[]{}=` 주변 공백 제거 /
 *               sql: `=<>` 주변 공백까지 제거 (요구 3 — "공백 때문에 틀리는 오답" 제거).
 *               역시 인정 범위를 넓히기만 한다.
 *
 * 표시용 부가 신호 `near`(2026-09-08): 오답 중 "표기(구두점·대소문자)만 다른 답"을 표시한다.
 * **점수·정답 판정에는 일절 관여하지 않는다** — 자세한 근거는 아래 `fieldNear` 주석에 있다.
 */

const logger = require('./logger.js');

// ---------------------------------------------------------------- normalize

/**
 * 눈에 보이지 않는 공백류. 복사·붙여넣기(문제 지문, 에디터, 카카오톡 등)로 딸려 들어와
 * "화면상 정답인데 오답" 을 만드는 주범이다. 세 정규화 모드가 **모두** 이걸 먼저 지난다.
 *   INVISIBLE : 폭 0 문자·소프트하이픈·BOM — 흔적 없이 지운다.
 *   SPACEY    : 전각 공백(U+3000)·비분리 공백(U+00A0) 등 — 보통 공백 한 칸으로 바꾼다.
 * 줄바꿈은 `\n` 으로 통일한다(윈도우에서 붙여 넣은 여러 줄 출력값).
 */
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
const SPACEY_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

function preClean(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(SPACEY_RE, ' ')
    .replace(/\r\n?/g, '\n');
}

const NORMALIZERS = {
  // preClean → 소문자 → 전공백 제거 → 선행 따옴표 제거 → 후행 구두점 제거
  //   선행 따옴표(2026-09-04, 서버 L-3): `"abc"` 처럼 답을 따옴표로 감싸면 후행만 지워져
  //   `"abc` 가 남아 오답이 됐다. 앞쪽은 따옴표류만 지운다(`.NET` 같은 선행 구두점은 보존).
  default(s) {
    return preClean(s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/^["'`]+/g, '')
      .replace(/["'`.,;:]+$/g, '');
  },
  /**
   * 코드 **출력값**용. "공백이 있느냐 없느냐" 는 여전히 판정에 쓰지만(`0 1 2 3` ≠ `0123`),
   * "공백이 몇 칸이냐·구두점 옆에 붙었느냐" 는 더 이상 오답 사유가 아니다.
   *
   *   preClean → 줄마다 trim + 연속 공백 1칸 압축 → 빈 줄 정리
   *            → `,;:()[]{}=` 양옆 공백 제거
   *
   * 2026-09-08 (요구 3): 예전에는 `trim()` 뿐이라 `Vehicle name : Spark` 와
   * `Vehicle name: Spark`, `a = 10` 과 `a=10`, `[1, 2, 3]` 과 `[1,2,3]` 이 서로 달랐다.
   * 데이터가 표기 변형을 accept 에 일일이 열거해 막고 있었는데(2020-3#15 한 문항에만 18개),
   * 열거에서 빠진 변형은 그대로 "맞는데 틀린" 오답이 됐다. 이제 정규화가 흡수한다.
   */
  keepSpace(s) {
    return preClean(s)
      .split('\n')
      .map(function (line) { return line.trim().replace(/[ \t]+/g, ' '); })
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/^\n+|\n+$/g, '')
      .replace(/ ?([,;:()[\]{}=]) ?/g, '$1');
  },
  // preClean → 소문자 → 연속 공백 1칸 압축 → 연산자·구두점 주변 공백 제거 → 후행 세미콜론/마침표/공백 제거
  //   구두점 주변 공백(2026-09-04, 서버 L-2): `select a, b` 와 `select a,b` 가 달랐다. 데이터는
  //   변형을 accept 에 일일이 열거해 왔는데(72건), 이제 정규화가 흡수한다.
  //   비교 연산자(2026-09-08, 요구 3): 같은 이유로 `where a = 1` 과 `where a=1` 도 흡수한다.
  sql(s) {
    return preClean(s)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\s*([,()=<>])\s*/g, '$1')
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

// ---------------------------------------------------------- 근접 오답(near)

/**
 * "표기만 다른 오답" 판정. **점수에는 전혀 관여하지 않는다** — 오답 카드에
 * "정답과 표기만 다릅니다" 한 줄을 띄우기 위한 표시용 신호다(요구 3, UX).
 *
 * 왜 정답으로 인정하지 않는가:
 *   실기 시험의 실제 채점은 표기까지 본다. 여기서 조용히 정답 처리하면 학습자는 자기 답이
 *   시험장에서도 통한다고 믿게 된다. 대신 **왜 틀렸는지**를 즉시 알려 준다 —
 *   "몰라서 틀린 것"과 "표기 때문에 틀린 것"이 화면에서 구분된다.
 *   (진짜 공백 문제는 위 정규화가 이미 정답으로 만든다. 여기 남는 건 구두점·대소문자다.)
 *
 * `looseKey` 는 문자·숫자만 남긴다 — 판정 경로에서는 절대 부르지 않는다.
 */
function looseKey(s) {
  return preClean(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * fieldNear(field, rawValue) → boolean
 * accept 필드: 관대 비교로는 일치한다(= 구두점·대소문자·공백만 다르다).
 * keywords 필드: 요구 키워드를 **일부만** 맞혔다(하나도 못 맞혔으면 near 가 아니다).
 * 그 밖의 validator: near 를 매기지 않는다(계산형은 "거의 맞음" 이 없다).
 */
function fieldNear(field, rawValue) {
  const raw = String(rawValue == null ? '' : rawValue);
  if (raw.trim() === '') return false;
  try {
    if (field.validator) {
      if (field.validator.type !== 'keywords') return false;
      return keywordsPartial(field.validator, raw);
    }
    const key = looseKey(raw);
    if (key === '') return false;
    const accept = field.accept || [];
    for (let i = 0; i < accept.length; i++) {
      if (looseKey(accept[i]) === key) return true;
    }
    return false;
  } catch (e) {
    return false; // near 는 부가 정보다 — 여기서 던져 채점을 흔들지 않는다
  }
}

/** keywords spec 의 요구 키워드 중 하나라도 맞혔는가(전부는 아니고). */
function keywordsPartial(spec, rawValue) {
  const all = Array.isArray(spec.all) ? spec.all : [];
  const any = Array.isArray(spec.any) ? spec.any : [];
  const got = NORMALIZERS.default(rawValue);
  if (got === '') return false;
  let hits = 0;
  const words = all.concat(any);
  for (let i = 0; i < words.length; i++) {
    if (got.indexOf(NORMALIZERS.default(words[i])) !== -1) hits++;
  }
  return hits > 0;
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
    const correct = fieldAccepts(f, answers[i], questionId);
    return {
      fieldIndex: i,
      label: f.label == null ? null : f.label,
      given: String(answers[i] == null ? '' : answers[i]),
      correct: correct,
      near: correct ? false : fieldNear(f, answers[i]),
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
  // near 는 "이 입력이 어느 칸이든 표기만 다르게 맞혔는가" 로 본다 — unordered 라 칸이 고정돼
  // 있지 않기 때문이다. 표시용 신호일 뿐이므로 매칭(complete)에는 영향을 주지 않는다.
  const fieldResults = fields.map(function (f, i) {
    const correct = okOrig.has(i);
    return {
      fieldIndex: i,
      label: f.label == null ? null : f.label,
      given: String(answers[i] == null ? '' : answers[i]),
      correct: correct,
      near: correct ? false : fields.some(function (g) { return fieldNear(g, answers[i]); }),
    };
  });
  return { fieldResults: fieldResults, complete: complete };
}

/**
 * 문항 레벨 near: **오답인데** 모든 칸이 정답이거나 near 이고, near 인 칸이 하나 이상.
 * = "내용은 맞혔는데 표기 때문에 틀렸다". 점수와 무관한 표시용 신호다.
 */
function questionNear(correct, fieldResults) {
  if (correct) return false;
  let hasNear = false;
  for (let i = 0; i < fieldResults.length; i++) {
    const r = fieldResults[i];
    if (r.correct) continue;
    if (!r.near) return false;
    hasNear = true;
  }
  return hasNear;
}

/**
 * gradeQuestion(question, answers) → { questionId, correct, near, fieldResults[], display }
 * answers: 필드 순서대로의 문자열 배열 (없으면 '')
 * 문항 정답 = 모든 필드 정답 (부분점수 없음)
 * `near` 는 점수에 관여하지 않는다 — 오답 카드의 안내 한 줄에만 쓰인다.
 */
function gradeQuestion(question, answers) {
  const fields = question.fields || [];
  const given = Array.isArray(answers) ? answers : [];
  const display = question.display == null ? '' : question.display;
  if (fields.length === 0) {
    return { questionId: question.id, correct: false, near: false, fieldResults: [], display: display };
  }
  if (question.answerMode === 'unordered') {
    const r = gradeUnordered(fields, given, question.id);
    return {
      questionId: question.id,
      correct: r.complete,
      near: questionNear(r.complete, r.fieldResults),
      fieldResults: r.fieldResults,
      display: display,
    };
  }
  const fieldResults = gradeOrdered(fields, given, question.id);
  const correct = fieldResults.every(function (r) { return r.correct; });
  return {
    questionId: question.id,
    correct: correct,
    near: questionNear(correct, fieldResults),
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
  fieldNear: fieldNear,
  runValidator: runValidator,
  ipToInt: ipToInt,
  NORMALIZE_MODES: NORMALIZE_MODES,
  VALIDATOR_TYPES: VALIDATOR_TYPES,
};
