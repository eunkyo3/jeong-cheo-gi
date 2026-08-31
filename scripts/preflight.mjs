#!/usr/bin/env node
/**
 * preflight.mjs — 출하 전 일괄 점검 (`npm run preflight`)
 *
 * 순서대로 돌리고 **첫 실패에서 멈춘다**. 하나라도 실패하면 exit code 1.
 *
 *   ① 단위 테스트   node --test tests/*.test.mjs
 *   ② 데이터 검증   node scripts/validate-data.mjs
 *   ③ 골든 회귀     node scripts/golden-check.mjs
 *   ④ 종단 대전     node scripts/e2e-battle.js (격리 임시 DATA_DIR, 실서버 2인 소켓 대전)
 *   ⑤ 커버리지 집계 data/PROGRESS.md + data/excluded.md 판독 (게이트 아님, 보고)
 *   ⑥ 해설 검증   node scripts/validate-explanations.mjs (전체 모드)
 *                 — data/explanations 에 json 이 하나도 없으면 집필 전이므로 SKIP
 *
 * 회차 파일이 20개 더 늘어나도 그대로 동작해야 하므로 현재 상태를 하나도 못박지 않는다.
 * 테스트 파일 목록도 회차 목록도 진행 표도 전부 **디스크에서 읽어** 센다.
 * (`tests/*.test.mjs` 글롭은 셸이 아니라 여기서 편다 — Windows 셸은 글롭을 확장하지 않는다.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');
const EXPLAIN_DIR = path.join(DATA_DIR, 'explanations');
const PROGRESS_FILE = path.join(DATA_DIR, 'PROGRESS.md');
const EXCLUDED_FILE = path.join(DATA_DIR, 'excluded.md');

// --------------------------------------------------------------- 표 유틸

/** 한글·전각 문자를 2칸으로 세는 표시 폭. */
function width(s) {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return n;
}

function pad(s, w) {
  return String(s) + ' '.repeat(Math.max(0, w - width(s)));
}

/** rows[0] 을 헤더로 보고 폭을 맞춘 표를 찍는다. */
function printTable(rows) {
  if (rows.length === 0) return;
  const cols = rows[0].length;
  const widths = [];
  for (let c = 0; c < cols; c++) {
    widths.push(rows.reduce((m, r) => Math.max(m, width(r[c])), 0));
  }
  const line = '  ' + widths.map((w) => '-'.repeat(w)).join('-+-');
  rows.forEach((r, i) => {
    console.log('  ' + r.map((cell, c) => pad(cell, widths[c])).join(' | '));
    if (i === 0) console.log(line);
  });
}

// ------------------------------------------------------------ 외부 단계 실행

function listTestFiles() {
  let names = [];
  try {
    names = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.mjs'));
  } catch (e) {
    return { ok: false, error: 'tests 디렉터리를 읽을 수 없습니다: ' + e.message, files: [] };
  }
  names.sort();
  if (names.length === 0) return { ok: false, error: 'tests/*.test.mjs 가 하나도 없습니다.', files: [] };
  return { ok: true, files: names.map((f) => path.join(TESTS_DIR, f)) };
}

function run(name, args) {
  console.log('');
  console.log('=== ' + name + ' ===');
  console.log('    ' + ['node', ...args.map((a) => path.relative(ROOT, a) || a)].join(' '));
  console.log('');
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  const ms = Date.now() - started;
  if (r.error) return { ok: false, ms, detail: r.error.message };
  if (r.status !== 0) return { ok: false, ms, detail: 'exit code ' + r.status };
  return { ok: true, ms, detail: '' };
}

// ------------------------------------------------------------- 커버리지 집계

/** data/rounds/*.json — 실제로 존재하는 회차 파일. */
function roundFiles() {
  try {
    return fs.readdirSync(ROUNDS_DIR)
      .filter((f) => f.toLowerCase().endsWith('.json'))
      .map((f) => path.basename(f, '.json'))
      .sort();
  } catch {
    return [];
  }
}

/** 마크다운 표의 데이터 행을 셀 배열로 뽑는다(헤더·구분선 제외). */
function tableRows(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 구분선
    out.push(cells);
  }
  return out;
}

const CHECKED = /\[\s*[xX]\s*\]/;
const ROUND_ID = /^\d{4}-\d+$/;

/**
 * PROGRESS.md 판독 → { rounds, restored, validated, audited, questionTotal }
 * 열 순서는 헤더에서 찾는다(열이 늘어나도 견디도록).
 */
function readProgress() {
  const text = fs.readFileSync(PROGRESS_FILE, 'utf8');
  const rows = tableRows(text);
  if (rows.length === 0) throw new Error('진행 표를 찾지 못했습니다.');

  const header = rows[0];
  const idx = (needle) => header.findIndex((h) => h.replace(/\s/g, '').includes(needle));
  const iRestored = idx('복원완료');
  const iValidated = idx('validate');
  const iAudited = idx('감사');
  const iCount = idx('문항수');
  if (iRestored < 0 || iValidated < 0 || iAudited < 0) {
    throw new Error('진행 표에 복원완료/validate통과/감사통과 열이 없습니다.');
  }

  const entries = rows.slice(1).filter((r) => ROUND_ID.test(r[0]));
  let restored = 0;
  let validated = 0;
  let audited = 0;
  let questionTotal = 0;
  for (const r of entries) {
    if (CHECKED.test(r[iRestored] || '')) restored++;
    if (CHECKED.test(r[iValidated] || '')) validated++;
    if (CHECKED.test(r[iAudited] || '')) audited++;
    const n = iCount >= 0 ? Number(String(r[iCount] || '').replace(/[^\d]/g, '')) : NaN;
    if (Number.isFinite(n)) questionTotal += n;
  }
  return {
    rounds: entries.map((r) => r[0]),
    restored,
    validated,
    audited,
    questionTotal,
  };
}

/** excluded.md 판독 → 제외 문항 행 수. 표가 비어 있으면 0. */
function readExcluded() {
  const text = fs.readFileSync(EXCLUDED_FILE, 'utf8');
  const rows = tableRows(text);
  if (rows.length === 0) return { count: 0, stated: null };
  const entries = rows.slice(1).filter((r) => ROUND_ID.test(r[0]));
  const m = /현재 제외 문항:\s*(\d+)\s*건/.exec(text);
  return { count: entries.length, stated: m ? Number(m[1]) : null };
}

function coverageStep() {
  const warnings = [];
  const files = roundFiles();
  const progress = readProgress();
  const excluded = readExcluded();

  const total = progress.rounds.length;
  const present = new Set(files);
  const missingJson = progress.rounds.filter((r) => !present.has(r));
  const unlisted = files.filter((f) => progress.rounds.indexOf(f) === -1);

  if (unlisted.length) warnings.push('PROGRESS.md 에 없는 회차 파일: ' + unlisted.join(', '));
  if (progress.restored > files.length) {
    warnings.push('복원완료 체크(' + progress.restored + ')가 실제 JSON 파일 수(' + files.length + ')보다 많습니다.');
  }
  if (excluded.stated != null && excluded.stated !== excluded.count) {
    warnings.push('excluded.md 요약(' + excluded.stated + '건)과 표 행 수(' + excluded.count + '건)가 다릅니다.');
  }

  return {
    total,
    files: files.length,
    restored: progress.restored,
    validated: progress.validated,
    audited: progress.audited,
    questionTotal: progress.questionTotal,
    excluded: excluded.count,
    missingJson,
    warnings,
  };
}

// ------------------------------------------------------------------- 본문

function pct(n, total) {
  return total === 0 ? '-' : Math.round((n / total) * 100) + '%';
}

function main() {
  const started = Date.now();
  const results = [];
  let failed = null;

  const tests = listTestFiles();
  const steps = tests.ok
    ? [
      { name: '① 단위 테스트', args: ['--test', ...tests.files] },
      { name: '② 데이터 검증', args: [path.join(ROOT, 'scripts', 'validate-data.mjs')] },
      { name: '③ 골든 회귀', args: [path.join(ROOT, 'scripts', 'golden-check.mjs')] },
      { name: '④ 종단 대전', args: [path.join(ROOT, 'scripts', 'e2e-battle.js')] },
    ]
    : [];

  if (!tests.ok) {
    results.push({ name: '① 단위 테스트', ok: false, ms: 0, detail: tests.error });
    failed = '① 단위 테스트';
  }

  for (const step of steps) {
    if (failed) { results.push({ name: step.name, ok: null, ms: 0, detail: '미실행' }); continue; }
    const r = run(step.name, step.args);
    results.push({ name: step.name, ok: r.ok, ms: r.ms, detail: r.detail });
    if (!r.ok) failed = step.name;
  }

  // ⑤ 커버리지 — 게이트가 아니라 보고. 앞 단계가 실패했으면 건너뛴다(첫 실패에서 멈춤).
  let cov = null;
  if (!failed) {
    console.log('');
    console.log('=== ⑤ 커버리지 집계 ===');
    const t = Date.now();
    try {
      cov = coverageStep();
      results.push({ name: '⑤ 커버리지 집계', ok: true, ms: Date.now() - t, detail: '' });
    } catch (e) {
      results.push({ name: '⑤ 커버리지 집계', ok: false, ms: Date.now() - t, detail: e.message });
      failed = '⑤ 커버리지 집계';
    }
  } else {
    results.push({ name: '⑤ 커버리지 집계', ok: null, ms: 0, detail: '미실행' });
  }

  // ⑥ 해설 검증 — 해설 파일이 하나라도 있으면 **전체 모드**로 게이트한다.
  // 집필 전(파일 0개)에는 게이트할 것이 없으므로 건너뛴다. 집필이 끝나면 자동으로 전 회차 필수가 된다.
  let explainFiles = 0;
  try {
    explainFiles = fs.readdirSync(EXPLAIN_DIR).filter((f) => f.toLowerCase().endsWith('.json')).length;
  } catch { /* 디렉터리 없음 = 0개 */ }

  if (failed) {
    results.push({ name: '⑥ 해설 검증', ok: null, ms: 0, detail: '미실행' });
  } else if (explainFiles === 0) {
    console.log('');
    console.log('=== ⑥ 해설 검증 ===');
    console.log('    data/explanations/*.json 이 0개 — 집필 전이므로 건너뜁니다.');
    results.push({ name: '⑥ 해설 검증', ok: null, ms: 0, detail: '해설 파일 0개 — 건너뜀' });
  } else {
    const r = run('⑥ 해설 검증', [path.join(ROOT, 'scripts', 'validate-explanations.mjs')]);
    results.push({ name: '⑥ 해설 검증', ok: r.ok, ms: r.ms, detail: r.detail });
    if (!r.ok) failed = '⑥ 해설 검증';
  }

  // ------------------------------------------------------------- 요약 출력

  console.log('');
  console.log('==================== preflight 요약 ====================');
  console.log('');
  printTable([
    ['단계', '결과', '시간', '비고'],
    ...results.map((r) => [
      r.name,
      r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP',
      r.ms ? (r.ms / 1000).toFixed(1) + 's' : '-',
      r.detail || '',
    ]),
  ]);

  if (cov) {
    console.log('');
    printTable([
      ['커버리지', '수치', '비율'],
      ['회차 총계 (PROGRESS.md)', String(cov.total), '-'],
      ['JSON 파일 존재', String(cov.files), pct(cov.files, cov.total)],
      ['복원완료', String(cov.restored), pct(cov.restored, cov.total)],
      ['validate통과', String(cov.validated), pct(cov.validated, cov.total)],
      ['감사통과', String(cov.audited), pct(cov.audited, cov.total)],
      ['등재 문항 수', String(cov.questionTotal), '-'],
      ['제외 문항 (excluded.md)', String(cov.excluded), '-'],
    ]);
    if (cov.missingJson.length) {
      console.log('');
      console.log('  JSON 미작성 회차 (' + cov.missingJson.length + '): ' + cov.missingJson.join(', '));
    }
    for (const w of cov.warnings) console.log('  (경고) ' + w);
  }

  console.log('');
  console.log('  총 소요 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
  if (failed) {
    console.log('');
    console.error('PREFLIGHT FAILED — ' + failed);
    process.exit(1);
  }
  console.log('');
  console.log('PREFLIGHT OK');
}

main();
