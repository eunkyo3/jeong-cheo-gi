#!/usr/bin/env node
/**
 * validate-explanations.mjs — data/explanations/*.json 동결 스키마 검증기
 *
 * `npm run validate:explain` 로 실행한다. 실패가 하나라도 있으면 exit code 1.
 *
 * 두 가지 모드:
 *   (기본)     전체 검증 — data/rounds 의 모든 회차에 해설 파일이 있어야 한다(없으면 FAIL).
 *   --partial  부분 검증 — 존재하는 해설 파일만 본다(집필 중 체크포인트용).
 *
 * 검사 항목 (handoff "데이터 계약(동결)"):
 *   · round 필드 == 파일명
 *   · 그 회차의 문항 id 를 정확히 커버 (누락·잉여 금지)
 *   · 값은 문자열이고 길이 150~1500자(태그 포함)
 *   · 허용 태그 p b mark br ul ol li code pre **만**, 속성 금지
 *   · `<script` (대소문자 무시) · `javascript:` 는 즉시 실패
 *
 * 회차가 늘어나도 그대로 동작해야 하므로 회차 목록은 디스크(data/rounds)에서 읽는다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');
const EXPLAIN_DIR = path.join(DATA_DIR, 'explanations');

const ALLOWED_TAGS = new Set(['p', 'b', 'mark', 'br', 'ul', 'ol', 'li', 'code', 'pre']);
const MIN_LEN = 150;
const MAX_LEN = 1500;

/** `<p>` `</p>` `<br/>` `<br />` 만 통과. 속성이 하나라도 붙으면 매치되지 않는다. */
const TAG_RE = /^<\/?([a-zA-Z][a-zA-Z0-9]*)\s*\/?>$/;

// ------------------------------------------------------------------ 유틸

const failures = [];

function fail(round, qid, rule, detail) {
  failures.push({ round, qid, rule, detail });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 너무 긴 값은 로그에서 잘라 보여준다. */
function snip(s, n) {
  const t = String(s).replace(/\s+/g, ' ');
  return t.length <= n ? t : t.slice(0, n) + '…';
}

/**
 * 마크업 린트. 허용 태그 화이트리스트 + 속성 금지 + 스크립트 차단.
 * `<`/`>` 는 코드 텍스트에서 엔티티여야 하므로, 태그가 아닌 `<` 는 그 자체로 실패다.
 *
 * 단위 테스트가 직접 부를 수 있도록 순수 함수로 뽑아 둔다.
 * @returns {Array<{rule:string, detail:string}>} 위반 목록(비어 있으면 통과)
 */
function lintHtml(html) {
  const out = [];
  if (typeof html !== 'string') return [{ rule: 'value-type', detail: `문자열이 아니다 (${typeof html})` }];

  if (/<\s*script/i.test(html)) out.push({ rule: 'script-tag', detail: '`<script` 는 금지다' });
  if (/javascript:/i.test(html)) out.push({ rule: 'javascript-url', detail: '`javascript:` 는 금지다' });

  let i = 0;
  const seenBad = new Set();
  while ((i = html.indexOf('<', i)) !== -1) {
    const end = html.indexOf('>', i);
    if (end === -1) {
      out.push({ rule: 'unclosed-tag', detail: '닫히지 않은 "<": ...' + snip(html.slice(i), 40) });
      return out;
    }
    const raw = html.slice(i, end + 1);
    const m = TAG_RE.exec(raw);
    if (!m) {
      // 속성이 붙었거나(`<p class="x">`) 태그 모양이 아닌 `<`(엔티티로 써야 함)
      if (!seenBad.has(raw)) {
        seenBad.add(raw);
        const attr = /^<\/?[a-zA-Z][a-zA-Z0-9]*\s+\S/.test(raw);
        out.push({
          rule: attr ? 'tag-attribute' : 'bad-tag',
          detail: snip(raw, 60) + ' — ' + (attr ? '태그에 속성을 붙일 수 없다' : '태그가 아닌 "<" 는 &lt; 로 써야 한다'),
        });
      }
    } else if (!ALLOWED_TAGS.has(m[1].toLowerCase())) {
      if (!seenBad.has(raw)) {
        seenBad.add(raw);
        out.push({
          rule: 'tag-not-allowed',
          detail: snip(raw, 60) + ' — 허용: ' + [...ALLOWED_TAGS].join(' '),
        });
      }
    }
    i = end + 1;
  }
  return out;
}

function checkMarkup(round, qid, html) {
  for (const v of lintHtml(html)) fail(round, qid, v.rule, v.detail);
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

// ------------------------------------------------------- 해설 파일 검증

/**
 * @returns {{ round: string, count: number, failCount: number, missing: boolean }}
 */
function validateExplainFile(round, expectedIds) {
  const file = path.join(EXPLAIN_DIR, round + '.json');
  const before = failures.length;

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(round, null, 'json-parse', err.message);
    return { round, count: 0, failCount: failures.length - before, missing: false };
  }

  if (!isPlainObject(doc)) {
    fail(round, null, 'shape', '최상위가 객체가 아니다');
    return { round, count: 0, failCount: failures.length - before, missing: false };
  }
  if (doc.round !== round) {
    fail(round, null, 'round-filename-mismatch', `round="${doc.round}" != 파일명 "${round}"`);
  }
  if (!isPlainObject(doc.explanations)) {
    fail(round, null, 'explanations-object', 'explanations 는 객체여야 한다');
    return { round, count: 0, failCount: failures.length - before, missing: false };
  }

  const keys = Object.keys(doc.explanations);

  // ---- 커버리지: 정확히 일치 (누락·잉여 금지)
  if (expectedIds) {
    const have = new Set(keys);
    const want = new Set(expectedIds);
    const missing = expectedIds.filter((id) => !have.has(id));
    const extra = keys.filter((id) => !want.has(id));
    if (missing.length) {
      fail(round, null, 'coverage-missing', `${missing.length}개 누락: ${missing.join(', ')}`);
    }
    if (extra.length) {
      fail(round, null, 'coverage-extra', `${extra.length}개 잉여: ${extra.join(', ')}`);
    }
  } else {
    fail(round, null, 'round-file-unreadable',
      `data/rounds/${round}.json 을 읽을 수 없어 커버리지를 볼 수 없다`);
  }

  // ---- 값 검사
  for (const qid of keys) {
    const html = doc.explanations[qid];
    if (typeof html !== 'string') {
      fail(round, qid, 'value-type', `문자열이 아니다 (${typeof html})`);
      continue;
    }
    const len = html.length;
    if (len < MIN_LEN || len > MAX_LEN) {
      fail(round, qid, 'length', `${len}자 — ${MIN_LEN}~${MAX_LEN}자여야 한다`);
    }
    checkMarkup(round, qid, html);
  }

  return { round, count: keys.length, failCount: failures.length - before, missing: false };
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

  let explainFiles = new Set();
  if (fs.existsSync(EXPLAIN_DIR)) {
    explainFiles = new Set(
      fs.readdirSync(EXPLAIN_DIR)
        .filter((n) => n.toLowerCase().endsWith('.json'))
        .map((n) => path.basename(n, '.json'))
    );
  }

  console.log(`모드: ${partial ? '부분 검증(--partial, 존재하는 파일만)' : '전체 검증(모든 회차 필수)'}`);
  console.log('');

  const reports = [];
  const missingRounds = [];

  for (const round of rounds) {
    if (!explainFiles.has(round)) {
      if (partial) {
        reports.push({ round, count: 0, failCount: 0, missing: true });
      } else {
        missingRounds.push(round);
        fail(round, null, 'file-missing', `data/explanations/${round}.json 이 없다`);
        reports.push({ round, count: 0, failCount: 1, missing: true });
      }
      continue;
    }
    reports.push(validateExplainFile(round, roundQuestionIds(round)));
  }

  // 회차 파일이 없는 잉여 해설 파일
  const unexpected = [...explainFiles].filter((r) => !rounds.includes(r)).sort();
  for (const r of unexpected) {
    fail(r, null, 'unknown-round', `data/rounds/${r}.json 이 없는 해설 파일이다`);
  }

  for (const r of reports) {
    if (r.missing && partial) {
      console.log(`[SKIP] ${r.round}  (해설 파일 없음 — 집필 대기)`);
      continue;
    }
    const tag = r.failCount === 0 ? '[PASS]' : '[FAIL]';
    console.log(`${tag} ${r.round}  explanations=${r.count}${r.failCount ? `  failures=${r.failCount}` : ''}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log(`--- 실패 상세 (${failures.length}건) ---`);
    for (const f of failures) {
      console.log(`  ${f.round} | ${f.qid ?? '(round)'} | ${f.rule}: ${f.detail}`);
    }
  }

  const done = reports.filter((r) => !r.missing);
  console.log('');
  console.log('--- 요약 ---');
  console.log(`  회차 ${rounds.length}개 중 해설 파일 ${done.length}개, 해설 ${done.reduce((a, r) => a + r.count, 0)}건`);
  console.log(`  검증 실패 ${failures.length}건`);
  if (partial && reports.some((r) => r.missing)) {
    console.log(`  미작성: ${reports.filter((r) => r.missing).map((r) => r.round).join(', ')}`);
  }
  if (!partial && missingRounds.length) {
    console.log(`  (전체 검증) 해설 파일 없음: ${missingRounds.join(', ')}`);
  }
  if (unexpected.length) {
    console.log(`  (경고) 회차 목록에 없는 해설 파일: ${unexpected.join(', ')}`);
  }

  if (failures.length > 0) {
    console.log('');
    console.log('EXPLANATION VALIDATION FAILED');
    process.exit(1);
  }
  console.log('');
  console.log('EXPLANATION VALIDATION OK');
}

// `node -e` 나 테스트에서 import 할 때 argv[1] 이 없을 수 있다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { main, lintHtml, ALLOWED_TAGS, MIN_LEN, MAX_LEN };
