'use strict';
/**
 * db.js — 도메인 메서드로 고정된 저장소 어댑터.
 *
 * 어댑터는 2종으로 확정한다 (계획 리스크 표):
 *   - "sqlite" : better-sqlite3 (기본)
 *   - "json"   : 파일 기반 폴백. 쓰기마다 원자적 임시파일 교체.
 * 두 어댑터는 동일한 도메인 메서드 인터페이스를 구현하며
 * `tests/db-adapter.test.mjs` 의 계약 테스트를 공유한다(폴백 경로 상시 검증).
 *
 * 어댑터는 raw row 를 반환한다. 집계·정렬은 ranking.js 의 JS 에서 수행한다.
 *
 * 선택 규칙:
 *   DB_ADAPTER=sqlite|json 이 있으면 그대로 강제한다.
 *   없으면 better-sqlite3 로드를 시도하고, 실패 시 경고를 찍고 json 으로 자동 폴백한다.
 *   (계획의 수동 전환 절차를 보존하되, "npm install + npm start" 원칙을 깨지 않기 위해
 *    자동 폴백을 추가했다. 폴백 발동 시 콘솔에 눈에 띄게 남는다.)
 */

const fs = require('node:fs');
const path = require('node:path');

// ------------------------------------------------------------------ helpers

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** 원자적 파일 교체: 임시파일에 쓰고 rename. */
function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 선택 인자로 들어온 문항 id 배열을 컬럼에 넣을 값으로 바꾼다.
 * 배열이면 JSON 문자열, 그 밖(미지정/null/비배열)이면 null.
 * (matches.round_ids / question_ids 와 같은 보관 규약 — 어댑터는 raw 문자열을 그대로 돌려준다.)
 */
function idsColumn(v) {
  return Array.isArray(v) ? JSON.stringify(v.map(String)) : null;
}

/** 임의의 입력을 양의 정수 id 목록(중복 제거)으로 정리한다. 다건 조회의 공통 입구. */
function normalizeIdList(ids) {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  for (const v of ids) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) seen.add(n);
  }
  return Array.from(seen);
}

/** 깊은 복사. JSON 어댑터는 내부 배열을 절대 그대로 내주지 않는다(호출자가 고쳐 쓰면 상태가 오염된다). */
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** 행 배열에서 가장 큰 id. 비어 있으면 0. JSON 어댑터의 seq 복구에 쓴다. */
function maxId(rows) {
  let m = 0;
  if (!Array.isArray(rows)) return 0;
  for (const r of rows) {
    const n = r && Number(r.id);
    if (Number.isInteger(n) && n > m) m = n;
  }
  return m;
}

/**
 * `study_results.round` 에 들어가는 대전 기록 키.
 * 회차 id / 'practice' / 'wrong' 과 나란히 놓이는 네 번째 값이며,
 * 집계(/api/me/history, /api/me/wrong)는 round 값을 해석하지 않으므로 그대로 합류한다.
 */
const BATTLE_ROUND = 'battle';

/**
 * saveMatch 의 참가자 행이 학습 기록까지 남길 정보를 갖췄는가.
 * 예전 호출자(questionIds/wrongIds 를 모르는 코드·테스트)는 매치만 기록하고 조용히 건너뛴다.
 */
function hasStudyPayload(p) {
  return Array.isArray(p.questionIds) && Array.isArray(p.wrongIds);
}

/**
 * 대전 학습 기록의 taken_at 은 **매치 종료 시각**이다(기록 시각이 아니라).
 * scripts/backfill-battle-notes.mjs 가 같은 값으로 중복을 판별하므로 소급분과 신규분이 겹치지 않는다.
 */
function matchTakenAt(match) {
  return typeof match.finishedAt === 'string' && match.finishedAt !== '' ? match.finishedAt : nowIso();
}

// ------------------------------------------------------- 마이그레이션 프레임
//
// 스키마 변경은 **오직 MIGRATIONS 배열에만** 적는다. `PRAGMA user_version` 이 어디까지 적용됐는지
// 기억하고, 부팅 때 밀린 것만 순서대로(각각 트랜잭션 안에서) 돌린다.
// 새로 만든 DB 는 아래 SCHEMA_SQL 이 곧바로 최종 모양으로 만들고 user_version 만 끝 번호로 찍는다
// — 즉 "새 DB" 와 "끝까지 마이그레이션한 옛 DB" 의 스키마가 같다.
//
// 각 migration 의 up() 은 **여러 번 돌아도 안전하게(idempotent)** 쓴다. 컬럼·인덱스·FK 존재를
// 직접 확인한 뒤에만 손대므로, user_version 이 0 인 채 이미 최신 모양인 DB 도 문제없이 통과한다.

/** 최종 스키마. FK 는 여기(신규 DB)와 마이그레이션 4(기존 DB)가 같은 모양으로 만든다. */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_name TEXT NOT NULL,
    mode TEXT NOT NULL,
    round_ids TEXT NOT NULL,
    question_ids TEXT NOT NULL,
    time_limit_s INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    winner_user_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS match_players (
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    correct_count INTEGER NOT NULL,
    submitted_at TEXT,
    answers TEXT NOT NULL,
    PRIMARY KEY (match_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS study_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    round TEXT NOT NULL,
    score INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    question_ids TEXT,
    wrong_ids TEXT,
    match_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mp_user ON match_players(user_id);
  CREATE INDEX IF NOT EXISTS idx_mp_match ON match_players(match_id);
  CREATE INDEX IF NOT EXISTS idx_sr_user ON study_results(user_id);
  CREATE INDEX IF NOT EXISTS idx_sr_user_id ON study_results(user_id, id DESC);
`;

function tableColumns(db, table) {
  try {
    return db.pragma('table_info(' + table + ')').map(function (c) { return c.name; });
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** 그 테이블에 선언된 FK 가 하나라도 있는가. 재작성 여부를 이걸로 판단한다. */
function hasForeignKeys(db, table) {
  try {
    return db.pragma('foreign_key_list(' + table + ')').length > 0;
  } catch {
    return false;
  }
}

/** 테이블을 새 정의로 갈아끼운다 — 만들고, 옮기고, 버리고, 이름을 바꾼다(SQLite 정석 절차). */
function rebuildTable(db, table, createSql, columns, indexSql) {
  const tmp = table + '__mig';
  db.exec('DROP TABLE IF EXISTS ' + tmp);
  db.exec(createSql.replace(table, tmp));
  const cols = columns.join(',');
  db.exec('INSERT INTO ' + tmp + ' (' + cols + ') SELECT ' + cols + ' FROM ' + table);
  db.exec('DROP TABLE ' + table);            // 딸린 인덱스도 함께 사라진다
  db.exec('ALTER TABLE ' + tmp + ' RENAME TO ' + table);
  db.exec(indexSql);                         // 그래서 인덱스는 여기서 되살린다
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'study_results 부가 컬럼(question_ids/wrong_ids/match_id)',
    up(db) {
      if (!tableExists(db, 'study_results')) return;
      const cols = tableColumns(db, 'study_results');
      for (const col of [['question_ids', 'TEXT'], ['wrong_ids', 'TEXT'], ['match_id', 'INTEGER']]) {
        if (cols.indexOf(col[0]) !== -1) continue;
        db.exec('ALTER TABLE study_results ADD COLUMN ' + col[0] + ' ' + col[1]); // 기존 행은 NULL
      }
    },
  },
  {
    version: 2,
    name: 'users.session_version',
    up(db) {
      if (!tableExists(db, 'users')) return;
      if (tableColumns(db, 'users').indexOf('session_version') !== -1) return;
      db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 3,
    name: 'idx_sr_user_id(user_id, id DESC)',
    up(db) {
      if (!tableExists(db, 'study_results')) return;
      db.exec('CREATE INDEX IF NOT EXISTS idx_sr_user_id ON study_results(user_id, id DESC)');
    },
  },
  {
    version: 4,
    name: 'match_players / study_results 실제 FK(ON DELETE CASCADE) 부여',
    // SQLite 는 트랜잭션 안에서 PRAGMA foreign_keys 를 무시한다 — 밖에서 끄고 켠다.
    fkOff: true,
    up(db) {
      if (tableExists(db, 'match_players') && !hasForeignKeys(db, 'match_players')) {
        rebuildTable(db, 'match_players', `
          CREATE TABLE match_players (
            match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            correct_count INTEGER NOT NULL,
            submitted_at TEXT,
            answers TEXT NOT NULL,
            PRIMARY KEY (match_id, user_id)
          )`,
          ['match_id', 'user_id', 'correct_count', 'submitted_at', 'answers'],
          `CREATE INDEX IF NOT EXISTS idx_mp_user ON match_players(user_id);
           CREATE INDEX IF NOT EXISTS idx_mp_match ON match_players(match_id);`);
      }
      if (tableExists(db, 'study_results') && !hasForeignKeys(db, 'study_results')) {
        rebuildTable(db, 'study_results', `
          CREATE TABLE study_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            round TEXT NOT NULL,
            score INTEGER NOT NULL,
            taken_at TEXT NOT NULL,
            question_ids TEXT,
            wrong_ids TEXT,
            match_id INTEGER
          )`,
          ['id', 'user_id', 'round', 'score', 'taken_at', 'question_ids', 'wrong_ids', 'match_id'],
          `CREATE INDEX IF NOT EXISTS idx_sr_user ON study_results(user_id);
           CREATE INDEX IF NOT EXISTS idx_sr_user_id ON study_results(user_id, id DESC);`);
      }
    },
  },
];

/** 최신 스키마 번호. JSON 어댑터의 `schemaVersion` 도 같은 눈금을 쓴다. */
const SCHEMA_VERSION = MIGRATIONS.length;

/** 백업 파일 접미사 `bak-20260902-134501` 의 시각 부분(로컬 시각). */
function backupStamp(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' +
    p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

/** 스냅숏 보관 개수. 늘어나기만 하면 디스크를 먹으므로 최근 것만 남긴다. */
const BACKUP_KEEP = 5;

/** `<file>.bak-*` 를 최신 keep 개만 남기고 지운다. */
function pruneBackups(file, keep) {
  const dir = path.dirname(file);
  // 정확히 `<파일>.bak-YYYYMMDD-HHMMSS` 만 센다 — sqlite 가 만드는 `-wal`/`-shm` 사이드카를 지우지 않도록.
  const re = new RegExp('^' + path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.bak-\\d{8}-\\d{6}$');
  let names;
  try {
    names = fs.readdirSync(dir).filter(n => re.test(n)).sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* 지우지 못해도 계속 간다 */ }
  }
}

/** 마이그레이션 직전 스냅숏. 실패하면 이 파일을 되돌리면 된다. 최근 5개만 남긴다. */
function backupFile(file, keep) {
  if (!fs.existsSync(file)) return null;
  const dest = file + '.bak-' + backupStamp();
  fs.copyFileSync(file, dest);
  pruneBackups(file, keep == null ? BACKUP_KEEP : keep);
  return dest;
}

/**
 * 밀린 마이그레이션을 적용한다. 하나라도 밀려 있으면 **먼저 파일을 통째로 백업한다.**
 * @returns {{from:number, to:number, applied:string[], backup:string|null}}
 */
function migrateSqlite(db, dbFile) {
  const from = Number(db.pragma('user_version', { simple: true })) || 0;
  const pending = MIGRATIONS.filter(m => m.version > from);
  const result = { from: from, to: from, applied: [], backup: null };
  if (pending.length === 0) return result;

  // WAL 에 남은 변경을 본체로 접은 뒤 복사해야 백업이 온전하다
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 실패해도 백업은 시도한다 */ }
  try {
    result.backup = backupFile(dbFile, BACKUP_KEEP);
  } catch (e) {
    throw new Error('DB 백업에 실패해 마이그레이션을 중단합니다: ' + e.message);
  }

  for (const m of pending) {
    if (m.fkOff) db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      m.up(db);
      db.exec('PRAGMA user_version = ' + m.version); // user_version 도 같은 트랜잭션에 든다
      db.exec('COMMIT');
      result.applied.push('v' + m.version + ' ' + m.name);
      result.to = m.version;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 이미 닫혔을 수 있다 */ }
      throw new Error('DB 마이그레이션 실패 (v' + m.version + ' ' + m.name + '): ' + e.message +
        (result.backup ? ' — 백업: ' + path.basename(result.backup) : ''));
    } finally {
      if (m.fkOff) db.pragma('foreign_keys = ON');
    }
  }
  return result;
}

// ------------------------------------------------------------- sqlite 어댑터

function createSqliteAdapter(dbFile) {
  const Database = require('better-sqlite3');
  ensureDir(path.dirname(dbFile));
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 스키마를 만들기 **전에** 물어야 "빈 파일"과 "예전 DB"를 구분할 수 있다
  const isFresh = !tableExists(db, 'users') && !tableExists(db, 'study_results') &&
    !tableExists(db, 'matches') && !tableExists(db, 'match_players');

  db.exec(SCHEMA_SQL);

  let migration = { from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [], backup: null };
  if (isFresh) {
    // 방금 만든 DB 는 이미 최종 모양이다 — 번호만 끝으로 찍는다
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
  } else {
    migration = migrateSqlite(db, dbFile);
    if (migration.applied.length) {
      const logger = require('./logger.js');
      logger.log('[db] 스키마 마이그레이션 v' + migration.from + ' → v' + migration.to,
        '(' + migration.applied.length + '건)',
        migration.backup ? '백업 ' + path.basename(migration.backup) : '');
    }
  }

  const stmt = {
    insertUser: db.prepare('INSERT INTO users (nickname, password_hash, created_at) VALUES (?, ?, ?)'),
    findByNick: db.prepare('SELECT * FROM users WHERE nickname = ?'),
    findById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertMatch: db.prepare(`INSERT INTO matches
      (room_name, mode, round_ids, question_ids, time_limit_s, started_at, finished_at, winner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    insertPlayer: db.prepare(`INSERT INTO match_players
      (match_id, user_id, correct_count, submitted_at, answers) VALUES (?, ?, ?, ?, ?)`),
    allMatches: db.prepare('SELECT * FROM matches ORDER BY id'),
    playersByMatch: db.prepare('SELECT * FROM match_players WHERE match_id = ?'),
    allPlayers: db.prepare('SELECT * FROM match_players'),
    insertStudy: db.prepare(`INSERT INTO study_results
      (user_id, round, score, taken_at, question_ids, wrong_ids, match_id) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    studyByUser: db.prepare('SELECT * FROM study_results WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
    updateStudyMatch: db.prepare('UPDATE study_results SET match_id = ? WHERE id = ?'),
    allUsers: db.prepare('SELECT * FROM users'),
    // 내가 참가한 매치만 — match_players 로 소유권을 거른다(남의 대전은 애초에 나오지 않는다)
    matchesByUser: db.prepare(`SELECT m.* FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = ? ORDER BY m.id`),
    // 답안 본문은 싣지 않는다 — 상대의 입력 내용은 어떤 조회로도 나가면 안 된다
    playersWithNick: db.prepare(`SELECT mp.match_id, mp.user_id, mp.correct_count, mp.submitted_at, u.nickname
      FROM match_players mp LEFT JOIN users u ON u.id = mp.user_id
      WHERE mp.match_id = ? ORDER BY mp.user_id`),
    updatePwHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    bumpSv: db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?'),
    // 회차별 최고점 — 이력 화면이 1000행을 긁어 세던 것을 한 줄 집계로 대신한다(서버 M-10)
    bestByRound: db.prepare(`SELECT round, MAX(score) AS best, COUNT(*) AS count
      FROM study_results WHERE user_id = ? GROUP BY round`),
  };

  // IN (?,?,…) 은 개수마다 SQL 이 달라 정적으로 준비할 수 없다 — 개수별로 한 번만 만들어 재사용한다.
  const IN_CHUNK = 500;
  const inStmtCache = new Map();
  function inStatement(kind, sqlFor, n) {
    const key = kind + ':' + n;
    let s = inStmtCache.get(key);
    if (!s) {
      s = db.prepare(sqlFor(new Array(n).fill('?').join(',')));
      if (inStmtCache.size < 200) inStmtCache.set(key, s); // 캐시가 무한히 자라지 않게
    }
    return s;
  }

  /** ids 를 IN_CHUNK 개씩 잘라 조회하고 결과를 이어 붙인다. */
  function selectIn(kind, sqlFor, ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const part = ids.slice(i, i + IN_CHUNK);
      out.push.apply(out, inStatement(kind, sqlFor, part.length).all(part));
    }
    return out;
  }

  const PLAYERS_IN_SQL = ph => `SELECT mp.match_id, mp.user_id, mp.correct_count, mp.submitted_at, u.nickname
    FROM match_players mp LEFT JOIN users u ON u.id = mp.user_id
    WHERE mp.match_id IN (${ph}) ORDER BY mp.match_id, mp.user_id`;
  const NAMES_IN_SQL = ph => `SELECT id, room_name FROM matches WHERE id IN (${ph}) ORDER BY id`;

  const saveMatchTx = db.transaction((match, players) => {
    const info = stmt.insertMatch.run(
      match.roomName, match.mode, JSON.stringify(match.roundIds || []),
      JSON.stringify(match.questionIds || []), match.timeLimitS,
      match.startedAt, match.finishedAt,
      match.winnerUserId == null ? null : match.winnerUserId
    );
    const matchId = Number(info.lastInsertRowid);
    const takenAt = matchTakenAt(match);
    for (const p of players) {
      stmt.insertPlayer.run(matchId, p.userId, p.correctCount,
        p.submittedAt == null ? null : p.submittedAt, JSON.stringify(p.answers || {}));
      // 같은 트랜잭션에서 학습 기록도 남긴다 — 매치만 남고 오답노트가 비는 일이 없도록.
      // match_id 도 여기서 박아 둔다: 오답노트를 대전 단위로 묶는 유일한 연결고리다.
      if (!hasStudyPayload(p)) continue;
      stmt.insertStudy.run(p.userId, BATTLE_ROUND, p.score == null ? 0 : p.score, takenAt,
        idsColumn(p.questionIds), idsColumn(p.wrongIds), matchId);
    }
    return matchId;
  });

  return {
    kind: 'sqlite',
    createUser(nickname, passwordHash) {
      const info = stmt.insertUser.run(nickname, passwordHash, nowIso());
      return stmt.findById.get(Number(info.lastInsertRowid));
    },
    findUserByNickname(nickname) { return stmt.findByNick.get(nickname) || null; },
    findUserById(id) { return stmt.findById.get(id) || null; },
    listUsers() { return stmt.allUsers.all(); },
    saveMatch(match, players) { return saveMatchTx(match, players); },
    listMatches() { return stmt.allMatches.all(); },
    listMatchPlayers(matchId) {
      return matchId == null ? stmt.allPlayers.all() : stmt.playersByMatch.all(matchId);
    },
    /**
     * 내가 참가한 매치 목록(오래된 것 먼저). 각 행에 참가자 전원을 `players` 로 붙인다
     * — 상대 닉네임·정답 수까지 한 번에 필요하기 때문이다(오답노트 대전별 보기).
     * 보관 답안(`answers`)은 일부러 뺐다. 정렬은 호출자 몫이다(어댑터는 raw row 규약).
     */
    listMatchesByUser(userId) {
      const matches = stmt.matchesByUser.all(userId);
      if (matches.length === 0) return [];
      // 매치 수만큼 쿼리를 날리던 N+1 을 IN 한 번 + JS 그룹핑으로 바꿨다(서버 M-2)
      const rows = selectIn('players', PLAYERS_IN_SQL, matches.map(m => m.id));
      const byMatch = new Map();
      for (const r of rows) {
        let list = byMatch.get(r.match_id);
        if (!list) byMatch.set(r.match_id, list = []);
        list.push(r);
      }
      return matches.map(function (m) {
        return Object.assign({}, m, { players: byMatch.get(m.id) || [] });
      });
    },
    /**
     * 매치 id → 방 이름만 뽑는다. 이력 화면이 방 이름 하나 때문에 매치 전체를 끌어오던 것을
     * 대신한다(서버 M-3). 어댑터 규약대로 **raw row 배열** `[{id, room_name}]` 을 id 오름차순으로 준다.
     */
    listMatchNames(ids) {
      const list = normalizeIdList(ids);
      if (list.length === 0) return [];
      const rows = selectIn('names', NAMES_IN_SQL, list);
      return rows.sort((a, b) => a.id - b.id);
    },
    /**
     * 회차(집합 키)별 최고점·응시 횟수. `[{round, best, count}]`.
     * 전체 이력을 파싱하지 않고도 최고점을 알 수 있는 경로다.
     */
    bestScoresByRound(userId) { return stmt.bestByRound.all(userId); },
    /** 로그인 시 예전 bcrypt 해시를 scrypt 로 갈아 끼울 때 쓴다. */
    updatePasswordHash(userId, passwordHash) {
      stmt.updatePwHash.run(String(passwordHash), Number(userId));
    },
    /** 세션 세대를 +1 한다 → 그 사용자에게 이미 나간 쿠키가 전부 무효가 된다. 새 값을 돌려준다. */
    bumpSessionVersion(userId) {
      stmt.bumpSv.run(Number(userId));
      const row = stmt.findById.get(Number(userId));
      return row ? Number(row.session_version) || 0 : 0;
    },
    /** 소급 적재용 — 이미 있는 학습 기록 행에 match_id 만 채운다. */
    updateStudyMatchId(id, matchId) {
      stmt.updateStudyMatch.run(matchId == null ? null : Number(matchId), id);
    },
    /**
     * questionIds/wrongIds 는 선택 — 없으면 NULL(예전 기록과 같은 모양)로 남는다.
     * takenAt 도 선택 — 소급 적재(backfill)만 과거 시각을 명시하고, 평소에는 지금 시각이다.
     * matchId 도 선택 — 대전(round='battle') 행에서만 값이 있다.
     */
    saveStudyResult(userId, round, score, questionIds, wrongIds, takenAt, matchId) {
      stmt.insertStudy.run(userId, round, score, takenAt == null ? nowIso() : String(takenAt),
        idsColumn(questionIds), idsColumn(wrongIds), matchId == null ? null : Number(matchId));
    },
    listStudyResults(userId, limit) { return stmt.studyByUser.all(userId, limit || 50); },
    /** JSON 어댑터와 계약을 맞추기 위한 자리 — sqlite 는 쓰기가 이미 즉시 반영된다. */
    flushSync() { /* no-op */ },
    schemaVersion() { return Number(db.pragma('user_version', { simple: true })) || 0; },
    close() { db.close(); },
  };
}

// --------------------------------------------------------------- json 어댑터

/** 살아 있는 JSON 어댑터들의 flushSync — 프로세스가 그냥 끝나도 미룬 쓰기를 흘려보낸다. */
const LIVE_JSON_FLUSH = new Set();
let jsonExitHookInstalled = false;
function installJsonExitHook() {
  if (jsonExitHookInstalled) return;
  jsonExitHookInstalled = true;
  // 어댑터가 몇 개 열리든 프로세스 리스너는 이 하나뿐이다
  process.on('exit', function () {
    for (const flushSync of LIVE_JSON_FLUSH) {
      try { flushSync(); } catch { /* 종료 중이라 더 할 수 있는 게 없다 */ }
    }
  });
}

/** JSON 파일에도 같은 눈금의 스키마 번호를 둔다. 인덱스·FK 는 sqlite 전용이라 여기서는 형태만 맞춘다. */
function migrateJsonData(data) {
  const from = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 0;
  if (from >= SCHEMA_VERSION) {
    data.schemaVersion = SCHEMA_VERSION;
    return { from: from, applied: [] };
  }
  const applied = [];
  if (from < 1) {
    // v1 — study_results 부가 컬럼. sqlite 의 NULL 과 같은 모양으로 채운다.
    for (const r of data.study_results) {
      if (r.question_ids === undefined) r.question_ids = null;
      if (r.wrong_ids === undefined) r.wrong_ids = null;
      if (r.match_id === undefined) r.match_id = null;
    }
    applied.push('v1 study_results 부가 컬럼');
  }
  if (from < 2) {
    // v2 — users.session_version
    for (const u of data.users) {
      if (!Number.isInteger(u.session_version)) u.session_version = 0;
    }
    applied.push('v2 users.session_version');
  }
  // v3(인덱스)·v4(FK)는 sqlite 전용이다 — JSON 어댑터에는 대응물이 없다.
  data.schemaVersion = SCHEMA_VERSION;
  return { from: from, applied: applied };
}

function createJsonAdapter(dbFile) {
  ensureDir(path.dirname(dbFile));

  const emptySeq = { users: 0, matches: 0, study_results: 0 };
  const empty = { schemaVersion: SCHEMA_VERSION, users: [], matches: [], match_players: [], study_results: [], seq: Object.assign({}, emptySeq) };
  let data;
  let existed = false;
  let rawSchemaVersion;
  try {
    data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    existed = true;
    rawSchemaVersion = data.schemaVersion;
    for (const k of Object.keys(empty)) if (data[k] === undefined) data[k] = clone(empty[k]);
  } catch {
    data = clone(empty);
  }
  for (const k of ['users', 'matches', 'match_players', 'study_results']) {
    if (!Array.isArray(data[k])) data[k] = [];
  }
  // schemaVersion 이 없는 **기존** 파일은 v0 이다. 위 기본값 채우기가 최신 번호를 덮어씌우면
  // 마이그레이션이 통째로 건너뛰어지므로 여기서 되돌린다. 새로 만드는 파일만 최신 번호로 둔다.
  if (existed && !Number.isInteger(rawSchemaVersion)) data.schemaVersion = 0;

  // seq 는 **얕은 대입이 아니라 병합**이다. 하위 키가 하나라도 빠지면 `++undefined` 로
  // id 가 NaN 이 되어 그 뒤의 모든 조회가 조용히 어긋났다(서버 M-4).
  // 게다가 실제 최대 id 보다 작으면 id 가 겹치므로, 파일을 읽을 때마다 최대값으로 끌어올린다.
  const seq = Object.assign({}, emptySeq);
  if (data.seq && typeof data.seq === 'object') {
    for (const k of Object.keys(emptySeq)) {
      const v = Number(data.seq[k]);
      if (Number.isInteger(v) && v > 0) seq[k] = v;
    }
  }
  seq.users = Math.max(seq.users, maxId(data.users));
  seq.matches = Math.max(seq.matches, maxId(data.matches));
  seq.study_results = Math.max(seq.study_results, maxId(data.study_results));
  data.seq = seq;

  const migration = migrateJsonData(data);
  if (existed && migration.applied.length) {
    // sqlite 와 같은 규약 — 형태를 바꾸기 전에 원본을 남긴다
    try {
      backupFile(dbFile, BACKUP_KEEP);
      require('./logger.js').log('[db] JSON 스키마 마이그레이션 v' + migration.from + ' → v' + SCHEMA_VERSION,
        '(' + migration.applied.length + '건)');
    } catch (e) {
      require('./logger.js').logErr('[db] JSON 백업 실패 — 마이그레이션은 계속합니다:', e.message);
    }
  }

  // 쓰기마다 파일 전체를 동기 재작성하던 것을 200ms 디바운스로 묶는다(서버 M-5).
  // 읽기는 전부 메모리에서 나가므로 지연이 관측되는 곳은 "파일" 뿐이고,
  // close()/flushSync()/프로세스 종료가 반드시 흘려보낸다.
  const FLUSH_DELAY_MS = 200;
  let timer = null;
  let dirty = false;

  function flushSync() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return;
    dirty = false;
    writeAtomic(dbFile, JSON.stringify(data, null, 0));
  }

  function flush() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(function () { timer = null; flushSync(); }, FLUSH_DELAY_MS);
    if (typeof timer.unref === 'function') timer.unref(); // 미룬 쓰기가 프로세스를 붙잡지 않게
  }

  installJsonExitHook();
  LIVE_JSON_FLUSH.add(flushSync);

  if (migration.applied.length) flush(); // 마이그레이션 결과를 디스크에도 반영한다

  return {
    kind: 'json',
    createUser(nickname, passwordHash) {
      if (data.users.some(u => u.nickname === nickname)) {
        const err = new Error('UNIQUE constraint failed: users.nickname');
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      const row = { id: ++data.seq.users, nickname, password_hash: passwordHash, created_at: nowIso(), session_version: 0 };
      data.users.push(row);
      flush();
      return clone(row);
    },
    findUserByNickname(nickname) {
      const r = data.users.find(u => u.nickname === nickname);
      return r ? clone(r) : null;
    },
    findUserById(id) {
      const r = data.users.find(u => u.id === id);
      return r ? clone(r) : null;
    },
    listUsers() { return clone(data.users); },
    saveMatch(match, players) {
      const matchId = ++data.seq.matches;
      data.matches.push({
        id: matchId,
        room_name: match.roomName,
        mode: match.mode,
        round_ids: JSON.stringify(match.roundIds || []),
        question_ids: JSON.stringify(match.questionIds || []),
        time_limit_s: match.timeLimitS,
        started_at: match.startedAt,
        finished_at: match.finishedAt,
        winner_user_id: match.winnerUserId == null ? null : match.winnerUserId,
      });
      const takenAt = matchTakenAt(match);
      for (const p of players) {
        data.match_players.push({
          match_id: matchId,
          user_id: p.userId,
          correct_count: p.correctCount,
          submitted_at: p.submittedAt == null ? null : p.submittedAt,
          answers: JSON.stringify(p.answers || {}),
        });
        // sqlite 트랜잭션과 같은 규약 — 학습 기록도 같은 flush 안에서 함께 쓴다(match_id 포함).
        if (!hasStudyPayload(p)) continue;
        data.study_results.push({
          id: ++data.seq.study_results,
          user_id: p.userId,
          round: BATTLE_ROUND,
          score: p.score == null ? 0 : p.score,
          taken_at: takenAt,
          question_ids: idsColumn(p.questionIds),
          wrong_ids: idsColumn(p.wrongIds),
          match_id: matchId,
        });
      }
      flush(); // 매치+참가자+학습 기록을 한 번에 교체 → 원자성 확보
      return matchId;
    },
    listMatches() { return clone(data.matches); },
    listMatchPlayers(matchId) {
      const rows = matchId == null ? data.match_players : data.match_players.filter(p => p.match_id === matchId);
      return clone(rows);
    },
    /** sqlite 어댑터와 같은 계약 — 보관 답안은 빼고 참가자 전원을 닉네임과 함께 붙인다. */
    listMatchesByUser(userId) {
      const mine = new Set(data.match_players.filter(p => p.user_id === userId).map(p => p.match_id));
      const nickOf = new Map(data.users.map(u => [u.id, u.nickname]));
      return data.matches.filter(m => mine.has(m.id)).sort((a, b) => a.id - b.id).map(function (m) {
        const players = data.match_players
          .filter(p => p.match_id === m.id)
          .sort((a, b) => a.user_id - b.user_id)
          .map(p => ({
            match_id: p.match_id,
            user_id: p.user_id,
            correct_count: p.correct_count,
            submitted_at: p.submitted_at == null ? null : p.submitted_at,
            nickname: nickOf.has(p.user_id) ? nickOf.get(p.user_id) : null,
          }));
        return Object.assign(clone(m), { players: players });
      });
    },
    /** sqlite 와 같은 계약 — raw row 배열 `[{id, room_name}]` 을 id 오름차순으로 준다. */
    listMatchNames(ids) {
      const want = new Set(normalizeIdList(ids));
      if (want.size === 0) return [];
      return data.matches
        .filter(m => want.has(m.id))
        .sort((a, b) => a.id - b.id)
        .map(m => ({ id: m.id, room_name: m.room_name }));
    },
    /** sqlite 의 `GROUP BY round` 와 같은 결과 — `[{round, best, count}]`. */
    bestScoresByRound(userId) {
      const agg = new Map();
      for (const r of data.study_results) {
        if (r.user_id !== userId) continue;
        const cur = agg.get(r.round);
        if (!cur) agg.set(r.round, { round: r.round, best: r.score, count: 1 });
        else {
          cur.count += 1;
          if (r.score > cur.best) cur.best = r.score;
        }
      }
      return Array.from(agg.values());
    },
    /** 로그인 시 예전 bcrypt 해시를 scrypt 로 갈아 끼울 때 쓴다. */
    updatePasswordHash(userId, passwordHash) {
      const row = data.users.find(u => u.id === Number(userId));
      if (!row) return;
      row.password_hash = String(passwordHash);
      flush();
    },
    /** 세션 세대를 +1 한다 → 그 사용자에게 이미 나간 쿠키가 전부 무효가 된다. 새 값을 돌려준다. */
    bumpSessionVersion(userId) {
      const row = data.users.find(u => u.id === Number(userId));
      if (!row) return 0;
      row.session_version = (Number.isInteger(row.session_version) ? row.session_version : 0) + 1;
      flush();
      return row.session_version;
    },
    /** 소급 적재용 — 이미 있는 학습 기록 행에 match_id 만 채운다. */
    updateStudyMatchId(id, matchId) {
      const row = data.study_results.find(s => s.id === id);
      if (!row) return;
      row.match_id = matchId == null ? null : Number(matchId);
      flush();
    },
    /**
     * questionIds/wrongIds 는 선택 — 없으면 null(sqlite 의 NULL 과 같은 모양)로 저장한다.
     * takenAt 도 선택 — 소급 적재(backfill)만 과거 시각을 명시한다.
     * matchId 도 선택 — 대전(round='battle') 행에서만 값이 있다.
     */
    saveStudyResult(userId, round, score, questionIds, wrongIds, takenAt, matchId) {
      data.study_results.push({
        id: ++data.seq.study_results,
        user_id: userId,
        round,
        score,
        taken_at: takenAt == null ? nowIso() : String(takenAt),
        question_ids: idsColumn(questionIds),
        wrong_ids: idsColumn(wrongIds),
        match_id: matchId == null ? null : Number(matchId),
      });
      flush();
    },
    listStudyResults(userId, limit) {
      // match_id 도입 이전에 쓰인 파일에는 키 자체가 없다 — sqlite 의 NULL 과 같은 모양으로 맞춘다.
      return clone(data.study_results.filter(s => s.user_id === userId).reverse().slice(0, limit || 50))
        .map(r => (r.match_id === undefined ? Object.assign(r, { match_id: null }) : r));
    },
    /** 미룬 쓰기를 지금 디스크로 내린다. 종료 훅(레인 C)이 이걸 부른다. */
    flushSync: flushSync,
    schemaVersion() { return data.schemaVersion; },
    close() {
      flushSync();
      LIVE_JSON_FLUSH.delete(flushSync);
    },
  };
}

// ------------------------------------------------------------------- factory

/**
 * open({ dir, adapter }) → 어댑터 인스턴스
 * adapter 미지정 시 DB_ADAPTER env → 자동 감지 순으로 결정한다.
 */
function open(options) {
  const opts = options || {};
  const dir = opts.dir || path.join(__dirname, '..', 'data');
  const want = opts.adapter || process.env.DB_ADAPTER || 'auto';

  if (want === 'json') return createJsonAdapter(path.join(dir, 'app.json'));
  if (want === 'sqlite') return createSqliteAdapter(path.join(dir, 'app.db'));

  try {
    return createSqliteAdapter(path.join(dir, 'app.db'));
  } catch (e) {
    require('./logger.js').logErr('[db] better-sqlite3 를 사용할 수 없어 JSON 어댑터로 폴백합니다.');
    require('./logger.js').logErr('[db] 사유: ' + e.message.split('\n')[0]);
    require('./logger.js').logErr('[db] 기능은 동일합니다. sqlite 를 쓰려면 빌드 도구 설치 후 DB_ADAPTER=sqlite 로 실행하세요.');
    return createJsonAdapter(path.join(dir, 'app.json'));
  }
}

module.exports = { open, createSqliteAdapter, createJsonAdapter, BATTLE_ROUND };

// ===== 관리자 조회 (lane F) =====
//
// 관리자 페이지(`/api/admin/*`)만 쓰는 읽기 전용 메서드다. 위쪽 어댑터 본문은 건드리지 않고
// **팩토리를 감싸서** 반환 객체에 메서드를 얹는다 — 같은 파일을 동시에 고치는 다른 작업과
// 충돌하지 않게 하려는 것이다. 아래 네 메서드가 두 어댑터에 동일한 모양으로 붙는다.
//
//   adminCounts()                              → {users, matches, matchPlayers, studyResults}
//   adminListUsers({limit, offset, q})         → {items, total}   (password_hash 는 절대 싣지 않는다)
//   adminListMatches({limit, offset})          → {items, total}
//   adminListStudy({limit, offset, userId})    → {items, total}
//
// sqlite 는 **같은 파일에 두 번째 커넥션**을 열어 준비된 문(prepared statement)만 쓴다.
// WAL 이라 본 커넥션의 커밋을 곧바로 읽는다. 어댑터의 close() 를 감싸 같이 닫는다.
// json 폴백은 준비된 문이라는 개념이 없으므로 파일 스냅숏을 읽어 JS 로 거른다.

/** 페이지 인자 정규화 — limit 은 1~100, offset 은 0 이상. */
function adminPage(options) {
  const o = options || {};
  let limit = Number(o.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  limit = Math.min(Math.floor(limit), 100);
  let offset = Number(o.offset);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit: limit, offset: Math.floor(offset) };
}

/** `question_ids` / `wrong_ids` 컬럼(JSON 문자열 또는 NULL) → 개수. 해석 불가면 null. */
function adminIdsCount(raw) {
  if (raw == null) return null;
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.length : null;
  } catch {
    return null;
  }
}

/** LIKE 패턴에서 특수문자를 죽인다(ESCAPE '\' 와 짝). */
function adminLikeEscape(s) {
  return String(s).replace(/[\\%_]/g, function (m) { return '\\' + m; });
}

/** 검색어 정규화 — 빈 문자열이면 '검색 없음'을 뜻하는 ''. */
function adminQuery(q) {
  return String(q == null ? '' : q).trim().slice(0, 60);
}

// ------------------------------------------------------------ sqlite 관리자

function attachSqliteAdmin(adapter, dbFile) {
  if (!adapter || typeof adapter.adminCounts === 'function') return adapter;
  let sdb = null;
  let q = null;
  try {
    const Database = require('better-sqlite3');
    sdb = new Database(dbFile, { fileMustExist: true });
    sdb.pragma('busy_timeout = 3000');
    q = {
      counts: sdb.prepare(`SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM matches) AS matches,
        (SELECT COUNT(*) FROM match_players) AS match_players,
        (SELECT COUNT(*) FROM study_results) AS study_results`),
      userCount: sdb.prepare('SELECT COUNT(*) AS n FROM users'),
      userCountQ: sdb.prepare("SELECT COUNT(*) AS n FROM users WHERE nickname LIKE ? ESCAPE '\\'"),
      // password_hash 는 SELECT 목록에 아예 넣지 않는다 — 관리자에게도 내보내지 않는다
      users: sdb.prepare(`SELECT u.id, u.nickname, u.created_at,
          (SELECT COUNT(*) FROM match_players mp WHERE mp.user_id = u.id) AS match_count,
          (SELECT MAX(s.taken_at) FROM study_results s WHERE s.user_id = u.id) AS last_study_at
        FROM users u ORDER BY u.id DESC LIMIT ? OFFSET ?`),
      usersQ: sdb.prepare(`SELECT u.id, u.nickname, u.created_at,
          (SELECT COUNT(*) FROM match_players mp WHERE mp.user_id = u.id) AS match_count,
          (SELECT MAX(s.taken_at) FROM study_results s WHERE s.user_id = u.id) AS last_study_at
        FROM users u WHERE u.nickname LIKE ? ESCAPE '\\' ORDER BY u.id DESC LIMIT ? OFFSET ?`),
      matchCount: sdb.prepare('SELECT COUNT(*) AS n FROM matches'),
      matches: sdb.prepare(`SELECT id, room_name, mode, round_ids, question_ids, time_limit_s,
          started_at, finished_at, winner_user_id
        FROM matches ORDER BY id DESC LIMIT ? OFFSET ?`),
      // 같은 페이지의 참가자를 한 번에 — 답안 본문(mp.answers)은 어떤 경로로도 나가지 않는다
      matchPlayers: sdb.prepare(`SELECT mp.match_id, mp.user_id, mp.correct_count, mp.submitted_at,
          u.nickname,
          (SELECT s.score FROM study_results s
            WHERE s.match_id = mp.match_id AND s.user_id = mp.user_id LIMIT 1) AS score
        FROM match_players mp LEFT JOIN users u ON u.id = mp.user_id
        WHERE mp.match_id IN (SELECT id FROM matches ORDER BY id DESC LIMIT ? OFFSET ?)
        ORDER BY mp.match_id DESC, mp.user_id`),
      studyCount: sdb.prepare('SELECT COUNT(*) AS n FROM study_results'),
      studyCountU: sdb.prepare('SELECT COUNT(*) AS n FROM study_results WHERE user_id = ?'),
      study: sdb.prepare(`SELECT s.id, s.user_id, u.nickname, s.round, s.score, s.taken_at,
          s.match_id, s.question_ids, s.wrong_ids
        FROM study_results s LEFT JOIN users u ON u.id = s.user_id
        ORDER BY s.id DESC LIMIT ? OFFSET ?`),
      studyU: sdb.prepare(`SELECT s.id, s.user_id, u.nickname, s.round, s.score, s.taken_at,
          s.match_id, s.question_ids, s.wrong_ids
        FROM study_results s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.user_id = ? ORDER BY s.id DESC LIMIT ? OFFSET ?`),
    };
  } catch (e) {
    // 관리자 조회만 붙지 않는다. 본 기능은 그대로 돈다(라우트가 "준비 중"으로 표시한다).
    if (sdb) { try { sdb.close(); } catch { /* noop */ } }
    return adapter;
  }

  const baseClose = typeof adapter.close === 'function' ? adapter.close.bind(adapter) : null;

  return Object.assign(adapter, {
    adminCounts() {
      const r = q.counts.get() || {};
      return {
        users: Number(r.users) || 0,
        matches: Number(r.matches) || 0,
        matchPlayers: Number(r.match_players) || 0,
        studyResults: Number(r.study_results) || 0,
      };
    },
    adminListUsers(options) {
      const p = adminPage(options);
      const term = adminQuery(options && options.q);
      if (!term) {
        return { items: q.users.all(p.limit, p.offset), total: Number(q.userCount.get().n) || 0 };
      }
      const like = '%' + adminLikeEscape(term) + '%';
      return { items: q.usersQ.all(like, p.limit, p.offset), total: Number(q.userCountQ.get(like).n) || 0 };
    },
    adminListMatches(options) {
      const p = adminPage(options);
      const rows = q.matches.all(p.limit, p.offset);
      const byMatch = new Map();
      for (const pl of q.matchPlayers.all(p.limit, p.offset)) {
        if (!byMatch.has(pl.match_id)) byMatch.set(pl.match_id, []);
        byMatch.get(pl.match_id).push(pl);
      }
      const items = rows.map(function (m) {
        const players = (byMatch.get(m.id) || []).map(function (pl) {
          return {
            user_id: pl.user_id,
            nickname: pl.nickname,
            correct_count: pl.correct_count,
            score: pl.score == null ? null : Number(pl.score),
            submitted_at: pl.submitted_at,
            winner: m.winner_user_id != null && pl.user_id === m.winner_user_id,
          };
        });
        return {
          id: m.id,
          room_name: m.room_name,
          mode: m.mode,
          time_limit_s: m.time_limit_s,
          started_at: m.started_at,
          finished_at: m.finished_at,
          winner_user_id: m.winner_user_id,
          round_ids: m.round_ids,
          question_count: adminIdsCount(m.question_ids),
          players: players,
        };
      });
      return { items: items, total: Number(q.matchCount.get().n) || 0 };
    },
    adminListStudy(options) {
      const p = adminPage(options);
      const uid = Number(options && options.userId);
      const byUser = Number.isInteger(uid) && uid > 0;
      const rows = byUser ? q.studyU.all(uid, p.limit, p.offset) : q.study.all(p.limit, p.offset);
      const total = byUser ? Number(q.studyCountU.get(uid).n) : Number(q.studyCount.get().n);
      return {
        items: rows.map(function (s) {
          return {
            id: s.id,
            user_id: s.user_id,
            nickname: s.nickname,
            round: s.round,
            score: s.score,
            taken_at: s.taken_at,
            match_id: s.match_id == null ? null : s.match_id,
            question_count: adminIdsCount(s.question_ids),
            wrong_count: adminIdsCount(s.wrong_ids),
          };
        }),
        total: total || 0,
      };
    },
    close() {
      try { if (baseClose) baseClose(); } finally { try { sdb.close(); } catch { /* 이미 닫힘 */ } }
    },
  });
}

// -------------------------------------------------------------- json 관리자

function attachJsonAdmin(adapter, dbFile) {
  if (!adapter || typeof adapter.adminCounts === 'function') return adapter;

  const EMPTY = { users: [], matches: [], match_players: [], study_results: [] };

  /** 디스크 스냅숏. 어댑터가 디바운스 flush 를 쓰면 먼저 내려 쓰게 한다. */
  function snap() {
    if (typeof adapter.flushSync === 'function') {
      try { adapter.flushSync(); } catch { /* best effort */ }
    }
    try {
      const d = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      for (const k of Object.keys(EMPTY)) if (!Array.isArray(d[k])) d[k] = [];
      return d;
    } catch {
      return JSON.parse(JSON.stringify(EMPTY));
    }
  }

  function page(list, p) {
    return list.slice(p.offset, p.offset + p.limit);
  }

  return Object.assign(adapter, {
    adminCounts() {
      const d = snap();
      return {
        users: d.users.length,
        matches: d.matches.length,
        matchPlayers: d.match_players.length,
        studyResults: d.study_results.length,
      };
    },
    adminListUsers(options) {
      const d = snap();
      const p = adminPage(options);
      const term = adminQuery(options && options.q).toLowerCase();
      const matched = term
        ? d.users.filter(function (u) { return String(u.nickname || '').toLowerCase().indexOf(term) !== -1; })
        : d.users;
      const sorted = matched.slice().sort(function (a, b) { return b.id - a.id; });
      const items = page(sorted, p).map(function (u) {
        let last = null;
        let matchCount = 0;
        for (const s of d.study_results) {
          if (s.user_id !== u.id) continue;
          if (last == null || String(s.taken_at) > last) last = String(s.taken_at);
        }
        for (const mp of d.match_players) if (mp.user_id === u.id) matchCount += 1;
        // password_hash 는 옮겨 담지 않는다 — 관리자에게도 내보내지 않는다
        return {
          id: u.id,
          nickname: u.nickname,
          created_at: u.created_at,
          match_count: matchCount,
          last_study_at: last,
        };
      });
      return { items: items, total: matched.length };
    },
    adminListMatches(options) {
      const d = snap();
      const p = adminPage(options);
      const sorted = d.matches.slice().sort(function (a, b) { return b.id - a.id; });
      const nickOf = new Map(d.users.map(function (u) { return [u.id, u.nickname]; }));
      const items = page(sorted, p).map(function (m) {
        const players = d.match_players
          .filter(function (mp) { return mp.match_id === m.id; })
          .sort(function (a, b) { return a.user_id - b.user_id; })
          .map(function (mp) {
            const sr = d.study_results.find(function (s) {
              return s.match_id === m.id && s.user_id === mp.user_id;
            });
            return {
              user_id: mp.user_id,
              nickname: nickOf.has(mp.user_id) ? nickOf.get(mp.user_id) : null,
              correct_count: mp.correct_count,
              score: sr && sr.score != null ? Number(sr.score) : null,
              submitted_at: mp.submitted_at == null ? null : mp.submitted_at,
              winner: m.winner_user_id != null && mp.user_id === m.winner_user_id,
            };
          });
        return {
          id: m.id,
          room_name: m.room_name,
          mode: m.mode,
          time_limit_s: m.time_limit_s,
          started_at: m.started_at,
          finished_at: m.finished_at,
          winner_user_id: m.winner_user_id == null ? null : m.winner_user_id,
          round_ids: m.round_ids,
          question_count: adminIdsCount(m.question_ids),
          players: players,
        };
      });
      return { items: items, total: d.matches.length };
    },
    adminListStudy(options) {
      const d = snap();
      const p = adminPage(options);
      const uid = Number(options && options.userId);
      const byUser = Number.isInteger(uid) && uid > 0;
      const matched = byUser ? d.study_results.filter(function (s) { return s.user_id === uid; }) : d.study_results;
      const sorted = matched.slice().sort(function (a, b) { return b.id - a.id; });
      const nickOf = new Map(d.users.map(function (u) { return [u.id, u.nickname]; }));
      const items = page(sorted, p).map(function (s) {
        return {
          id: s.id,
          user_id: s.user_id,
          nickname: nickOf.has(s.user_id) ? nickOf.get(s.user_id) : null,
          round: s.round,
          score: s.score,
          taken_at: s.taken_at,
          match_id: s.match_id === undefined || s.match_id === null ? null : s.match_id,
          question_count: adminIdsCount(s.question_ids),
          wrong_count: adminIdsCount(s.wrong_ids),
        };
      });
      return { items: items, total: matched.length };
    },
  });
}

// 팩토리 감싸기 — 위 본문을 고치지 않고 반환 객체에만 메서드를 얹는다.
const _adminOpen = module.exports.open;
const _adminSqlite = module.exports.createSqliteAdapter;
const _adminJson = module.exports.createJsonAdapter;

module.exports.createSqliteAdapter = function (dbFile) {
  return attachSqliteAdmin(_adminSqlite(dbFile), dbFile);
};

module.exports.createJsonAdapter = function (dbFile) {
  return attachJsonAdmin(_adminJson(dbFile), dbFile);
};

module.exports.open = function (options) {
  const opts = options || {};
  const dir = opts.dir || path.join(__dirname, '..', 'data');
  const adapter = _adminOpen(opts);
  if (!adapter) return adapter;
  return adapter.kind === 'json'
    ? attachJsonAdmin(adapter, path.join(dir, 'app.json'))
    : attachSqliteAdmin(adapter, path.join(dir, 'app.db'));
};
