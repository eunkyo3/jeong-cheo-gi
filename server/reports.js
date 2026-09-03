'use strict';
/**
 * reports.js — 정답 이의 제기 적재(append-only JSONL).
 *
 * 예전에는 `data/reports.json` 배열을 요청마다 통째로 읽고 → 밀어 넣고 → 다시 쓰고 → rename 했다.
 * 인증도 없어 누구나 디스크를 무제한으로 불릴 수 있었고, 비용은 건수의 제곱으로 늘었다(보안 H-3).
 *
 * 지금은 `data/reports.jsonl` 에 **한 줄씩 append** 한다.
 *   - 쓰기 비용이 건수와 무관하다.
 *   - 파일 크기가 MAX_BYTES 를 넘으려 하면 거절한다(무한 증가 차단).
 *   - 기동 시 예전 `reports.json` 이 있으면 한 번 JSONL 로 옮기고 `.migrated` 로 이름을 바꾼다.
 *     **기존 신고는 한 건도 잃지 않는다.**
 *
 * db 를 쓰지 않는다 — 관리자 페이지(레인 F)가 express 없이 `listReports()` 만 require 할 수 있게.
 */

const fs = require('node:fs');
const path = require('node:path');

/** 파일 상한. 넘기려는 append 는 거절한다(부분 기록을 남기지 않는다). */
const MAX_BYTES = 8 * 1024 * 1024;

const FILE_NAME = 'reports.jsonl';
const LEGACY_NAME = 'reports.json';
const MIGRATED_SUFFIX = '.migrated';

/** 한 요청이 실을 수 있는 내 답안 칸 수 / 칸당 글자 수 / 사유 길이. */
const MAX_ANSWER_ITEMS = 10;
const MAX_ANSWER_CHARS = 500;
const MAX_COMMENT_CHARS = 2000;

/** 인자로 디렉터리를 주지 않았을 때의 기본값 — 서버와 같은 규칙(DATA_DIR env). */
function defaultDir() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
}

function fileOf(dir) {
  return path.join(dir || defaultDir(), FILE_NAME);
}

function legacyFileOf(dir) {
  return path.join(dir || defaultDir(), LEGACY_NAME);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
}

/** JSONL 한 줄. 줄바꿈이 섞이면 줄 단위 규약이 깨지므로 JSON.stringify 결과만 쓴다. */
function toLine(entry) {
  return JSON.stringify(entry) + '\n';
}

/**
 * 예전 배열 파일을 JSONL 로 한 번만 옮긴다.
 * 성공하면 원본을 `reports.json.migrated` 로 남긴다(지우지 않는다 — 사람이 확인할 수 있게).
 * @returns {{moved:number}|null} 옮길 게 없었으면 null
 */
function migrateLegacy(dir, logErr) {
  const legacy = legacyFileOf(dir);
  const file = fileOf(dir);
  let raw;
  try {
    raw = fs.readFileSync(legacy, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT' && typeof logErr === 'function') {
      logErr('reports.json 읽기 실패 — 이관을 건너뜁니다:', e.message);
    }
    return null;
  }

  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    if (typeof logErr === 'function') logErr('reports.json 파싱 실패 — 이관을 건너뜁니다:', e.message);
    return null;
  }
  if (!Array.isArray(list)) {
    if (typeof logErr === 'function') logErr('reports.json 이 배열이 아닙니다 — 이관을 건너뜁니다.');
    return null;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (list.length > 0) {
    fs.appendFileSync(file, list.map(toLine).join(''), 'utf8');
  }
  fs.renameSync(legacy, legacy + MIGRATED_SUFFIX);
  return { moved: list.length };
}

/**
 * 한 건을 덧붙인다.
 * 상한을 넘기면 `code = 'REPORTS_FULL'` 인 Error 를 던진다(라우트가 507 로 옮긴다).
 * @returns {{bytes:number}} 기록 후 파일 크기
 */
function appendReport(entry, dir) {
  const file = fileOf(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = toLine(entry);
  const size = sizeOf(file);
  if (size + Buffer.byteLength(line, 'utf8') > MAX_BYTES) {
    const err = new Error('신고 파일이 상한(' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB)에 도달했습니다.');
    err.code = 'REPORTS_FULL';
    throw err;
  }
  fs.appendFileSync(file, line, 'utf8'); // append 는 원자적이다 — 읽기-수정-쓰기 경합이 없다
  return { bytes: size + Buffer.byteLength(line, 'utf8') };
}

/** 파일 전체를 파싱한다. 깨진 줄은 건너뛴다(한 줄이 망가져도 나머지는 읽힌다). */
function readAll(dir) {
  const file = fileOf(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch { /* 깨진 줄은 버린다 */ }
  }
  return out;
}

/**
 * listReports({dir, limit, offset}) → {total, offset, limit, items}
 *
 * **최신 것이 앞**이다(파일은 오래된 것부터 쌓이므로 뒤집어서 자른다).
 * 관리자 페이지(레인 F)가 db 없이 이 함수만 require 해서 쓴다.
 */
function listReports(options) {
  const opts = options || {};
  const all = readAll(opts.dir);
  const total = all.length;
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
    ? Math.min(Math.floor(Number(opts.limit)), 500) : 50;
  const offset = Number.isFinite(Number(opts.offset)) && Number(opts.offset) > 0
    ? Math.floor(Number(opts.offset)) : 0;
  const items = all.slice().reverse().slice(offset, offset + limit);
  return { total: total, offset: offset, limit: limit, items: items };
}

function countReports(dir) {
  return readAll(dir).length;
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  MAX_ANSWER_ITEMS: MAX_ANSWER_ITEMS,
  MAX_ANSWER_CHARS: MAX_ANSWER_CHARS,
  MAX_COMMENT_CHARS: MAX_COMMENT_CHARS,
  FILE_NAME: FILE_NAME,
  LEGACY_NAME: LEGACY_NAME,
  fileOf: fileOf,
  legacyFileOf: legacyFileOf,
  migrateLegacy: migrateLegacy,
  appendReport: appendReport,
  listReports: listReports,
  countReports: countReports,
  readAll: readAll,
};
