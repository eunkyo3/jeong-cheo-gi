#!/usr/bin/env node
/**
 * db-backup.mjs — 런타임 상태(DATA_DIR)를 **일관된 스냅샷 한 묶음**으로 뜬다.
 *
 * 왜 그냥 파일 복사가 아닌가: 서버는 SQLite 를 WAL 모드로 쓴다. 살아 있는 `app.db` 를 그대로
 * 복사하면 `-wal` 에만 있는 최근 쓰기가 빠지거나 반쯤 적힌 페이지가 섞인다. 그래서 better-sqlite3 의
 * 온라인 백업 API(`db.backup`)로 **서버가 떠 있는 채로도** 정합한 단일 파일을 만든다.
 *
 * 묶음 구성 (`<DATA_DIR>/backups/<YYYYMMDD-HHMMSS>/`):
 *   app.db          온라인 백업으로 만든 단일 파일 (WAL 접힘)
 *   secret.key      세션·세트 토큰·관리자 쿠키 서명 키 — 없으면 옮긴 뒤 전원 재로그인
 *   reports.jsonl   신고 적재 (있을 때만)
 *
 * 실행:
 *   node scripts/db-backup.mjs                 # <DATA_DIR>/backups/<stamp>/ 에 생성
 *   node scripts/db-backup.mjs /somewhere/out  # 대상 디렉터리 지정
 *   docker compose exec app node scripts/db-backup.mjs   # 컨테이너 안(/data/backups/<stamp>/)
 *
 * 복원은 scripts/db-restore.mjs. DATA_DIR 규약은 서버와 동일(기본 repo `data/`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  d = d || new Date();
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

const outDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(DATA_DIR, 'backups', stamp());

const dbFile = path.join(DATA_DIR, 'app.db');
if (!fs.existsSync(dbFile)) {
  console.error('app.db 가 없습니다: ' + dbFile + '  (DATA_DIR=' + DATA_DIR + ')');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// 1) DB — 온라인 백업 (읽기 전용으로 열어 서버와 충돌 없음)
const db = new Database(dbFile, { readonly: true });
try {
  await db.backup(path.join(outDir, 'app.db'));
} finally {
  db.close();
}

// 2) 사이드 파일 — 있는 것만
const copied = ['app.db'];
for (const name of ['secret.key', 'reports.jsonl']) {
  const src = path.join(DATA_DIR, name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(outDir, name));
    copied.push(name);
  }
}

console.log('백업 완료: ' + outDir);
console.log('  ' + copied.join(', '));
if (!copied.includes('secret.key')) {
  console.log('  (secret.key 없음 — 복원 후 기존 세션·토큰은 무효가 됩니다)');
}
