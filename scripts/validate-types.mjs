#!/usr/bin/env node
/**
 * validate-types.mjs — data/types/*.json 동결 스키마 검증기
 *
 * `npm run validate:types` 로 실행한다. 실패가 하나라도 있으면 exit code 1.
 *
 * 두 가지 모드 (validate-explanations.mjs 와 같은 규약):
 *   (기본)     전체 검증 — data/rounds 의 모든 회차에 분류 파일이 있어야 한다(없으면 FAIL).
 *   --partial  부분 검증 — 존재하는 파일만 본다(분류 작업 중 체크포인트용).
 *
 * 검사 항목 (handoff "분류 데이터(동결)"):
 *   · 최상위가 객체이고 `types` 가 객체
 *   · round 필드 == 파일명
 *   · 그 회차의 문항 id 를 정확히 커버 (누락·잉여 금지)
 *   · 값은 `code` | `sql` | `theory` 셋뿐 (문자열, 대소문자 구분)
 *
 * 회차가 늘어나도 그대로 동작해야 하므로 회차 목록은 디스크(data/rounds)에서 읽는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import qtypes from '../server/qtypes.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');
const TYPES_DIR = path.join(DATA_DIR, 'types');

// 동결 값 집합과 값 판정은 `server/qtypes.js` 한 곳에서 온다 — 검증기와 서버가 어긋날 수 없다.
// (qtypes.js 는 fs 를 건드리지 않는 순수 모듈이라 여기서 import 해도 회차 데이터를 읽지 않는다.)
const TYPES = qtypes.TYPES;

/** 값 하나가 계약을 만족하는가. 단위 테스트가 직접 부를 수 있도록 순수 함수로 뽑아 둔다. */
const isValidType = qtypes.isType;

// ------------------------------------------------------------------ 유틸

const failures = [];

function fail(round, qid, rule, detail) {
  failures.push({ round, qid, rule, detail });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 목록이 길면 앞의 몇 개만 보여 준다(로그가 화면을 덮지 않도록). */
function head(list, n) {
  return list.length <= n ? list.join(', ') : list.slice(0, n).join(', ') + ` … (+${list.length - n})`;
}

function emptyCounts() {
  const c = {};
  for (const t of TYPES) c[t] = 0;
  return c;
}

// --------------------------------------------------------- 회차 문항 id

/** data/rounds/<round>.json 의 문항 id 배열. 읽지 못하면 null. */
function roundQuestionIds(round) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, round + '.json'), 'utf8'));
    if (!isPlainObject(doc) || !Array.isArray(doc.questions)) return null;
    return doc.questions.map((q) => (q && typeof q.id === 'string' ? q.id : ''));
  } catch {
    return null;
  }
}

// ------------------------------------------------------- 분류 파일 검증

/**
 * @returns {{ round:string, count:number, failCount:number, missing:boolean, counts:object }}
 */
function validateTypeFile(round, expectedIds) {
  const file = path.join(TYPES_DIR, round + '.json');
  const before = failures.length;
  const counts = emptyCounts();

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(round, null, 'json-parse', err.message);
    return { round, count: 0, failCount: failures.length - before, missing: false, counts };
  }

  if (!isPlainObject(doc)) {
    fail(round, null, 'shape', '최상위가 객체가 아니다');
    return { round, count: 0, failCount: failures.length - before, missing: false, counts };
  }
  if (doc.round !== round) {
    fail(round, null, 'round-filename-mismatch', `round="${doc.round}" != 파일명 "${round}"`);
  }
  if (!isPlainObject(doc.types)) {
    fail(round, null, 'types-object', 'types 는 객체여야 한다');
    return { round, count: 0, failCount: failures.length - before, missing: false, counts };
  }

  const keys = Object.keys(doc.types);

  // ---- 커버리지: 정확히 일치 (누락·잉여 금지)
  if (expectedIds) {
    const have = new Set(keys);
    const want = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !have.has(id));
    const extra = keys.filter((id) => !want.has(id));
    if (missing.length) {
      fail(round, null, 'coverage-missing', `${missing.length}개 누락: ${head(missing, 20)}`);
    }
    if (extra.length) {
      fail(round, null, 'coverage-extra', `${extra.length}개 잉여: ${head(extra, 20)}`);
    }
  } else {
    fail(round, null, 'round-file-unreadable',
      `data/rounds/${round}.json 을 읽을 수 없어 커버리지를 볼 수 없다`);
  }

  // ---- 값 검사
  for (const qid of keys) {
    const v = doc.types[qid];
    if (!isValidType(v)) {
      fail(round, qid, 'value', `${JSON.stringify(v)} — ${TYPES.join(' | ')} 중 하나여야 한다`);
      continue;
    }
    counts[v] += 1;
  }

  return { round, count: keys.length, failCount: failures.length - before, missing: false, counts };
}

// ------------------------------------------------------------------- 본문

function main(argv = process.argv.slice(2)) {
  const partial = argv.includes('--partial');

  if (!fs.existsSync(ROUNDS_DIR)) {
    console.error(`[FAIL] 라운드 디렉터리가 없다: ${ROUNDS_DIR}`);
    process.exit(1);
  }

  const rounds = fs
    .readdirSync(ROUNDS_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => path.basename(n, '.json'))
    .sort();

  let typeFiles = new Set();
  if (fs.existsSync(TYPES_DIR)) {
    typeFiles = new Set(
      fs.readdirSync(TYPES_DIR)
        .filter((n) => n.toLowerCase().endsWith('.json'))
        .map((n) => path.basename(n, '.json'))
    );
  }

  console.log(`모드: ${partial ? '부분 검증(--partial, 존재하는 파일만)' : '전체 검증(모든 회차 필수)'}`);
  console.log('');

  const reports = [];
  const missingRounds = [];

  for (const round of rounds) {
    if (!typeFiles.has(round)) {
      if (partial) {
        reports.push({ round, count: 0, failCount: 0, missing: true, counts: emptyCounts() });
      } else {
        missingRounds.push(round);
        fail(round, null, 'file-missing', `data/types/${round}.json 이 없다`);
        reports.push({ round, count: 0, failCount: 1, missing: true, counts: emptyCounts() });
      }
      continue;
    }
    reports.push(validateTypeFile(round, roundQuestionIds(round)));
  }

  // 회차 파일이 없는 잉여 분류 파일
  const unexpected = [...typeFiles].filter((r) => !rounds.includes(r)).sort();
  for (const r of unexpected) {
    fail(r, null, 'unknown-round', `data/rounds/${r}.json 이 없는 분류 파일이다`);
  }

  for (const r of reports) {
    if (r.missing && partial) {
      console.log(`[SKIP] ${r.round}  (분류 파일 없음 — 작업 대기)`);
      continue;
    }
    const tag = r.failCount === 0 ? '[PASS]' : '[FAIL]';
    const breakdown = TYPES.map((t) => `${t}=${r.counts[t]}`).join(' ');
    console.log(`${tag} ${r.round}  types=${r.count}  ${breakdown}${r.failCount ? `  failures=${r.failCount}` : ''}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log(`--- 실패 상세 (${failures.length}건) ---`);
    for (const f of failures) {
      console.log(`  ${f.round} | ${f.qid ?? '(round)'} | ${f.rule}: ${f.detail}`);
    }
  }

  const done = reports.filter((r) => !r.missing);
  const total = emptyCounts();
  for (const r of done) for (const t of TYPES) total[t] += r.counts[t];
  const grand = TYPES.reduce((a, t) => a + total[t], 0);

  console.log('');
  console.log('--- 요약 ---');
  console.log(`  회차 ${rounds.length}개 중 분류 파일 ${done.length}개, 분류 ${done.reduce((a, r) => a + r.count, 0)}건`);
  console.log(`  유형별 합계: ${TYPES.map((t) => `${t} ${total[t]}`).join(' · ')}  (계 ${grand})`);
  console.log(`  검증 실패 ${failures.length}건`);
  if (partial && reports.some((r) => r.missing)) {
    console.log(`  미작성: ${reports.filter((r) => r.missing).map((r) => r.round).join(', ')}`);
  }
  if (!partial && missingRounds.length) {
    console.log(`  (전체 검증) 분류 파일 없음: ${missingRounds.join(', ')}`);
  }
  if (unexpected.length) {
    console.log(`  (경고) 회차 목록에 없는 분류 파일: ${unexpected.join(', ')}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log('TYPE VALIDATION FAILED');
    process.exit(1);
  }
  console.log('');
  console.log('TYPE VALIDATION OK');
}

// `node -e` 나 테스트에서 import 할 때 argv[1] 이 없을 수 있다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { main, isValidType, TYPES };
