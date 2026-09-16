#!/usr/bin/env node
/**
 * db-restore.mjs — db-backup.mjs 가 만든 묶음을 DATA_DIR 에 되돌린다.
 *
 * 규칙:
 *   - **서버를 내리고** 실행한다. 살아 있는 서버 밑에서 app.db 를 갈아끼우면 WAL 과 어긋난다.
 *   - DATA_DIR 에 이미 app.db 가 있으면 거부한다. 덮어쓰려면 --force — 이때 기존 파일은
 *     `app.db.bak-<stamp>` 로 옆에 남긴다(secret.key·reports.jsonl 도 같은 규칙).
 *   - 묶음의 `-wal`/`-shm` 은 없어야 정상이고, DATA_DIR 의 낡은 `-wal`/`-shm` 은 지운다
 *     (다른 DB 의 WAL 이 새 app.db 에 적용되는 사고 방지).
 *
 * 실행:
 *   node scripts/db-restore.mjs data/backups/20260916-101500
 *   node scripts/db-restore.mjs /import/20260916-101500 --force
 *   docker compose run --rm -v "<호스트 백업 폴더>:/import:ro" app node scripts/db-restore.mjs /import
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const force = args.includes('--force');
const srcArg = args.find((a) => !a.startsWith('--'));
if (!srcArg) {
  console.error('사용법: node scripts/db-restore.mjs <백업 디렉터리> [--force]');
  process.exit(2);
}
const srcDir = path.resolve(srcArg);
const srcDb = path.join(srcDir, 'app.db');
if (!fs.existsSync(srcDb)) {
  console.error('백업 디렉터리에 app.db 가 없습니다: ' + srcDb);
  process.exit(1);
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  d = d || new Date();
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const destDb = path.join(DATA_DIR, 'app.db');
if (fs.existsSync(destDb) && !force) {
  console.error('이미 app.db 가 있습니다: ' + destDb);
  console.error('덮어쓰려면 --force (기존 파일은 .bak-<stamp> 로 남깁니다)');
  process.exit(1);
}

const s = stamp();
const restored = [];
for (const name of ['app.db', 'secret.key', 'reports.jsonl']) {
  const src = path.join(srcDir, name);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(DATA_DIR, name);
  if (fs.existsSync(dest)) fs.renameSync(dest, dest + '.bak-' + s);
  fs.copyFileSync(src, dest);
  // Windows 마운트에서 온 파일은 0777 로 들어오므로 모드를 정리한다 (서명 키는 소유자만)
  try { fs.chmodSync(dest, name === 'secret.key' ? 0o600 : 0o644); } catch { /* Windows 등 chmod 미지원 */ }
  restored.push(name);
}
// 낡은 WAL 사이드카는 새 DB 와 무관하므로 제거
for (const side of ['app.db-wal', 'app.db-shm']) {
  const f = path.join(DATA_DIR, side);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

console.log('복원 완료 → ' + DATA_DIR);
console.log('  ' + restored.join(', '));
if (!restored.includes('secret.key')) {
  console.log('  (secret.key 없음 — 첫 기동 때 새로 생성되며 기존 세션·토큰은 무효)');
}
