#!/usr/bin/env node
/**
 * validate-data.mjs — data/rounds/*.json 동결 스키마 검증기 (Phase 0)
 *
 * `npm run validate` 로 실행한다. 실패가 하나라도 있으면 exit code 1.
 *
 * grader.js 는 CommonJS 이므로 createRequire 로 가져온다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');

const { gradeQuestion, normalizeValue, NORMALIZE_MODES, VALIDATOR_TYPES } = require(
  path.join(ROOT, 'server', 'grader.js')
);

// SCHEMA.md 회차 목록 (총 21회차)
const EXPECTED_ROUNDS = [
  '2020-1', '2020-2', '2020-3', '2020-4',
  '2021-1', '2021-2', '2021-3',
  '2022-1', '2022-2', '2022-3',
  '2023-1', '2023-2', '2023-3',
  '2024-1', '2024-2', '2024-3',
  '2025-1', '2025-2', '2025-3',
  '2026-1', '2026-2',
];

const ROUND_KEYS = ['round', 'title', 'sourceUrl', 'questions'];
const QUESTION_KEYS = [
  'id', 'num', 'prompt', 'bodyHtml', 'bodyText',
  'sourceImages', 'answerMode', 'fields', 'display',
];
const FIELD_KEYS = ['label', 'accept', 'normalize', 'validator', 'sampleAnswer'];

const ANSWER_MODES = ['ordered', 'unordered'];
const SOURCE_URL_RE = /^https:\/\/chobopark\.tistory\.com\/\d+$/;

// 만료되는 외부 URL (서명 URL) 금지 패턴
const FORBIDDEN_URL_PATTERNS = [
  { name: 'blog.kakaocdn.net', re: /blog\.kakaocdn\.net/i },
  { name: 't1.daumcdn.net', re: /t1\.daumcdn\.net/i },
  { name: 'signed URL (credential=)', re: /credential=/i },
  { name: 'signed URL (expires=)', re: /expires=/i },
];

// ------------------------------------------------------------------ 유틸

const failures = [];

function fail(round, qid, rule, detail) {
  failures.push({ round, qid, rule, detail });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** gradeQuestion 을 안전하게 호출한다(검증 중 grader 예외로 죽지 않도록). */
function safeGrade(question, answers) {
  try {
    return { ok: true, result: gradeQuestion(question, answers) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// ------------------------------------------------------- 회차 파일 검증

/**
 * @returns {{ round: string, questionCount: number, failCount: number }}
 */
function validateRoundFile(filePath, seenIds) {
  const stem = path.basename(filePath, '.json');
  const before = failures.length;

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(stem, null, 'json-parse', err.message);
    return { round: stem, questionCount: 0, failCount: failures.length - before };
  }

  if (!isPlainObject(doc)) {
    fail(stem, null, 'round-shape', 'round JSON 최상위가 객체가 아니다');
    return { round: stem, questionCount: 0, failCount: failures.length - before };
  }

  for (const key of ROUND_KEYS) {
    if (!(key in doc)) fail(stem, null, 'round-required-key', `누락: "${key}"`);
  }

  if (doc.round !== stem) {
    fail(stem, null, 'round-filename-mismatch', `round="${doc.round}" != 파일명 "${stem}"`);
  }
  if (typeof doc.title !== 'string' || doc.title.trim() === '') {
    fail(stem, null, 'round-title', 'title 은 비어있지 않은 문자열이어야 한다');
  }
  if (typeof doc.sourceUrl !== 'string' || !SOURCE_URL_RE.test(doc.sourceUrl)) {
    fail(stem, null, 'source-url', `https://chobopark.tistory.com/<id> 형식이 아니다: ${JSON.stringify(doc.sourceUrl)}`);
  }
  if (!Array.isArray(doc.questions)) {
    fail(stem, null, 'questions-array', 'questions 는 배열이어야 한다');
    return { round: stem, questionCount: 0, failCount: failures.length - before };
  }

  const questions = doc.questions;
  questions.forEach((q, idx) => {
    validateQuestion(stem, q, idx, seenIds, idx > 0 ? questions[idx - 1].num : null);
  });

  return { round: stem, questionCount: questions.length, failCount: failures.length - before };
}

function validateQuestion(round, q, idx, seenIds, prevNum) {
  const qid = isPlainObject(q) && typeof q.id === 'string' ? q.id : `${round}[index ${idx}]`;

  if (!isPlainObject(q)) {
    fail(round, qid, 'question-shape', '문항이 객체가 아니다');
    return;
  }

  for (const key of QUESTION_KEYS) {
    if (!(key in q)) fail(round, qid, 'question-required-key', `누락: "${key}"`);
  }

  // num: 원본 문항 번호를 보존한다. 양의 정수, 엄격 오름차순. 제외 문항이 있으면 빈 번호가 생길 수 있다
  // (excluded.md 의 "Q7" 과 JSON 의 #7 부재가 대응되도록 — 재번호 금지).
  if (!Number.isInteger(q.num) || q.num < 1) {
    fail(round, qid, 'num-positive', `num=${JSON.stringify(q.num)} 은 1 이상의 정수여야 한다`);
  } else if (idx > 0 && Number.isInteger(prevNum) && q.num <= prevNum) {
    fail(round, qid, 'num-ascending', `num=${q.num} 이 직전 문항 num=${prevNum} 보다 크지 않다 (엄격 오름차순)`);
  }

  // id === `${round}#${num}`
  const expectedId = `${round}#${q.num}`;
  if (q.id !== expectedId) {
    fail(round, qid, 'id-format', `id=${JSON.stringify(q.id)} 이지만 "${expectedId}" 이어야 한다`);
  }

  // 전역 유일성
  if (typeof q.id === 'string') {
    if (seenIds.has(q.id)) {
      fail(round, qid, 'id-duplicate', `id 중복 — 이미 ${seenIds.get(q.id)} 에서 사용됨`);
    } else {
      seenIds.set(q.id, round);
    }
  }

  for (const key of ['prompt', 'bodyHtml', 'bodyText', 'display']) {
    if (key in q && typeof q[key] !== 'string') {
      fail(round, qid, 'question-field-type', `${key} 은 문자열이어야 한다`);
    }
  }

  // sourceImages: data/ 기준 상대경로, 실제 존재해야 함
  if (!isStringArray(q.sourceImages)) {
    fail(round, qid, 'source-images-type', 'sourceImages 는 문자열 배열이어야 한다');
  } else {
    for (const rel of q.sourceImages) {
      const abs = path.resolve(DATA_DIR, rel);
      if (!fs.existsSync(abs)) {
        fail(round, qid, 'source-image-missing', `파일 없음: ${rel} (→ ${abs})`);
      }
    }
  }

  // 만료 외부 URL 금지
  for (const key of ['bodyHtml', 'bodyText', 'prompt']) {
    const text = typeof q[key] === 'string' ? q[key] : '';
    for (const pat of FORBIDDEN_URL_PATTERNS) {
      if (pat.re.test(text)) {
        fail(round, qid, 'expiring-external-url', `${key} 에 금지 패턴 "${pat.name}" 포함`);
      }
    }
  }

  // answerMode
  if (!ANSWER_MODES.includes(q.answerMode)) {
    fail(round, qid, 'answer-mode', `answerMode=${JSON.stringify(q.answerMode)} — ${ANSWER_MODES.join('|')} 중 하나여야 한다`);
  }

  // fields
  if (!Array.isArray(q.fields) || q.fields.length === 0) {
    fail(round, qid, 'fields-array', 'fields 는 비어있지 않은 배열이어야 한다');
    return;
  }

  q.fields.forEach((f, fi) => validateField(round, qid, f, fi));

  // unordered 규칙
  if (q.answerMode === 'unordered') {
    if (q.fields.length < 2) {
      fail(round, qid, 'unordered-field-count', `unordered 문항은 필드가 2개 이상이어야 한다 (현재 ${q.fields.length})`);
    }
    const modes = new Set(q.fields.map((f) => (isPlainObject(f) ? f.normalize || 'default' : '<invalid>')));
    if (modes.size > 1) {
      fail(round, qid, 'unordered-normalize-uniform', `unordered 문항의 전 필드 normalize 가 동일해야 한다 (발견: ${[...modes].join(', ')})`);
    }
  }

  // hint 정답 노출 금지 (2025-2#11 · 2023-1#9/#19 감사 사례) — 복원자가 추가한 안내 문구의 "예:" 가 곧 정답이었다.
  // hint 텍스트(default 정규화)에 어떤 accept 항목(해당 필드 normalize 적용, 3자 이상)이 부분 문자열로 들어 있으면 실패.
  {
    const hints = (typeof q.bodyHtml === 'string' ? q.bodyHtml.match(/<div class="hint">([\s\S]*?)<\/div>/g) : null) || [];
    if (hints.length && Array.isArray(q.fields)) {
      const hn = normalizeValue('default', hints.join(' ').replace(/<[^>]+>/g, ' '));
      q.fields.forEach((f, fi) => {
        if (!isPlainObject(f) || !Array.isArray(f.accept)) return;
        for (const a of f.accept) {
          if (typeof a !== 'string') continue;
          const an = normalizeValue(NORMALIZE_MODES.includes(f.normalize) ? f.normalize : 'default', a);
          if (an.length >= 3 && hn.includes(an)) {
            fail(round, qid, 'hint-leaks-answer', `hint 에 fields[${fi}] 의 accept ${JSON.stringify(a)} 가 포함되어 정답을 노출한다`);
            break;
          }
        }
      });
    }
  }

  // 여기서부터는 채점 기반 검증 — 필드 형태가 온전할 때만 의미가 있다
  const fieldsSane = q.fields.every(
    (f) => isPlainObject(f) &&
      (f.validator === null || isPlainObject(f.validator)) &&
      Array.isArray(f.accept) &&
      typeof f.sampleAnswer === 'string'
  );
  if (!fieldsSane) return;

  const samples = q.fields.map((f) => f.sampleAnswer);

  // sampleAnswer 자가 채점
  const selfGraded = safeGrade(q, samples);
  if (!selfGraded.ok) {
    fail(round, qid, 'sample-answer-grade-throw', `gradeQuestion 예외: ${selfGraded.error.message}`);
    return;
  }
  if (!selfGraded.result.correct) {
    const wrong = selfGraded.result.fieldResults
      .filter((r) => !r.correct)
      .map((r) => `[${r.fieldIndex}] ${JSON.stringify(r.given)}`)
      .join(', ');
    fail(round, qid, 'sample-answer-grade', `sampleAnswer 조합이 정답 판정되지 않는다 — 실패 슬롯: ${wrong || '(없음/매칭 불완전)'}`);
  }

  // accept 자가 채점: 각 accept 항목을 해당 슬롯에 넣으면 정답이어야 한다
  q.fields.forEach((f, fi) => {
    if (f.validator) return; // validator 필드는 accept 를 쓰지 않는다
    f.accept.forEach((entry) => {
      const answers = samples.slice();
      answers[fi] = entry;
      const g = safeGrade(q, answers);
      if (!g.ok) {
        fail(round, qid, 'accept-grade-throw', `accept[${fi}] ${JSON.stringify(entry)} — gradeQuestion 예외: ${g.error.message}`);
        return;
      }
      if (!g.result.correct) {
        fail(
          round, qid, 'accept-grade',
          `필드 ${fi}(${JSON.stringify(f.label)}) 슬롯에 accept 항목 ${JSON.stringify(entry)} 를 넣으면 오답 판정된다`
        );
      }
    });
  });
}

function validateField(round, qid, f, fi) {
  if (!isPlainObject(f)) {
    fail(round, qid, 'field-shape', `fields[${fi}] 가 객체가 아니다`);
    return;
  }

  for (const key of FIELD_KEYS) {
    if (!(key in f)) fail(round, qid, 'field-required-key', `fields[${fi}] 누락: "${key}"`);
  }

  if (!('label' in f) || (typeof f.label !== 'string' && f.label !== null)) {
    fail(round, qid, 'field-label', `fields[${fi}].label 은 문자열(또는 null)이어야 한다`);
  }

  if (typeof f.sampleAnswer !== 'string' || f.sampleAnswer.trim() === '') {
    fail(round, qid, 'field-sample-answer', `fields[${fi}].sampleAnswer 는 비어있지 않은 문자열이어야 한다`);
  }

  const mode = f.normalize;
  if (!NORMALIZE_MODES.includes(mode)) {
    fail(round, qid, 'normalize-mode', `fields[${fi}].normalize=${JSON.stringify(mode)} — ${NORMALIZE_MODES.join('|')} 중 하나여야 한다`);
  }

  // validator 배타 규칙
  if (f.validator === null) {
    if (!isStringArray(f.accept) || f.accept.length === 0) {
      fail(round, qid, 'accept-required', `fields[${fi}]: validator 가 null 이면 accept 는 비어있지 않은 문자열 배열이어야 한다`);
    }
  } else if (isPlainObject(f.validator)) {
    if (!VALIDATOR_TYPES.includes(f.validator.type)) {
      fail(round, qid, 'validator-type', `fields[${fi}].validator.type=${JSON.stringify(f.validator.type)} — grader 카탈로그(${VALIDATOR_TYPES.join('|')}) 에 없다`);
    }
    if (!Array.isArray(f.accept) || f.accept.length !== 0) {
      fail(round, qid, 'validator-exclusivity', `fields[${fi}]: validator 가 있으면 accept 는 [] 여야 한다 (현재 ${JSON.stringify(f.accept)})`);
    }
    if (f.validator.type === 'keywords') {
      const all = f.validator.all, any = f.validator.any;
      const okArr = (v) => v === undefined || (isStringArray(v) && v.every((s) => s.trim() !== ''));
      if (!okArr(all) || !okArr(any)) {
        fail(round, qid, 'keywords-shape', `fields[${fi}].validator.all/any 는 비어있지 않은 문자열들의 배열이어야 한다`);
      } else if ((all || []).length === 0 && (any || []).length === 0) {
        fail(round, qid, 'keywords-empty', `fields[${fi}].validator 는 all[] 또는 any[] 중 하나 이상을 가져야 한다 (없으면 무조건 정답)`);
      }
      if (f.validator.minAny !== undefined && (!Number.isInteger(f.validator.minAny) || f.validator.minAny < 0 || f.validator.minAny > (any || []).length)) {
        fail(round, qid, 'keywords-minany', `fields[${fi}].validator.minAny=${JSON.stringify(f.validator.minAny)} 는 0..any.length 범위의 정수여야 한다`);
      }
    }
  } else {
    fail(round, qid, 'validator-shape', `fields[${fi}].validator 는 null 또는 객체여야 한다`);
  }
}

// ------------------------------------------------------------------ main

function main() {
  if (!fs.existsSync(ROUNDS_DIR)) {
    console.error(`[FAIL] 라운드 디렉터리가 없다: ${ROUNDS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(ROUNDS_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => path.join(ROUNDS_DIR, n));

  const seenIds = new Map();
  const reports = [];

  for (const file of files) {
    reports.push(validateRoundFile(file, seenIds));
  }

  for (const r of reports) {
    const tag = r.failCount === 0 ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${r.round}  questions=${r.questionCount}${r.failCount ? `  failures=${r.failCount}` : ''}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log(`--- 실패 상세 (${failures.length}건) ---`);
    for (const f of failures) {
      console.log(`  ${f.round} | ${f.qid ?? '(round)'} | ${f.rule}: ${f.detail}`);
    }
  }

  const present = new Set(reports.map((r) => r.round));
  const missing = EXPECTED_ROUNDS.filter((r) => !present.has(r));
  const unexpected = reports.map((r) => r.round).filter((r) => !EXPECTED_ROUNDS.includes(r));

  console.log('');
  console.log('--- 요약 ---');
  console.log(`  파일 ${reports.length}개, 문항 ${reports.reduce((a, r) => a + r.questionCount, 0)}개, 고유 id ${seenIds.size}개`);
  console.log(`  검증 실패 ${failures.length}건`);
  console.log(
    `  커버리지: ${EXPECTED_ROUNDS.length}회차 중 ${EXPECTED_ROUNDS.length - missing.length}회차 존재` +
      (missing.length ? ` — 미수집: ${missing.join(', ')}` : ' — 전 회차 완비')
  );
  if (unexpected.length) {
    console.log(`  (경고) 회차 목록에 없는 파일: ${unexpected.join(', ')}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log('VALIDATION FAILED');
    process.exit(1);
  }
  console.log('');
  console.log('VALIDATION OK');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { main, EXPECTED_ROUNDS };
