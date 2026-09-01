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

// ------------------------------------------------------------- sqlite 어댑터

function createSqliteAdapter(dbFile) {
  const Database = require('better-sqlite3');
  ensureDir(path.dirname(dbFile));
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      match_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      correct_count INTEGER NOT NULL,
      submitted_at TEXT,
      answers TEXT NOT NULL,
      PRIMARY KEY (match_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS study_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
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
  `);

  // 마이그레이션: 위 CREATE TABLE 은 기존 DB 를 바꾸지 않는다.
  // 예전 스키마로 만들어진 파일도 재기동만으로 새 컬럼을 갖도록 없는 것만 덧붙인다(무중단, 데이터 보존).
  const studyCols = db.prepare('PRAGMA table_info(study_results)').all().map(function (c) { return c.name; });
  for (const col of [['question_ids', 'TEXT'], ['wrong_ids', 'TEXT'], ['match_id', 'INTEGER']]) {
    if (studyCols.indexOf(col[0]) !== -1) continue;
    db.exec('ALTER TABLE study_results ADD COLUMN ' + col[0] + ' ' + col[1]); // 기존 행은 NULL 로 채워진다
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
  };

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
      return stmt.matchesByUser.all(userId).map(function (m) {
        return Object.assign({}, m, { players: stmt.playersWithNick.all(m.id) });
      });
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
    close() { db.close(); },
  };
}

// --------------------------------------------------------------- json 어댑터

function createJsonAdapter(dbFile) {
  ensureDir(path.dirname(dbFile));

  const empty = { users: [], matches: [], match_players: [], study_results: [], seq: { users: 0, matches: 0, study_results: 0 } };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    for (const k of Object.keys(empty)) if (data[k] === undefined) data[k] = empty[k];
  } catch {
    data = JSON.parse(JSON.stringify(empty));
  }

  const flush = () => writeAtomic(dbFile, JSON.stringify(data, null, 0));
  const clone = o => JSON.parse(JSON.stringify(o));

  return {
    kind: 'json',
    createUser(nickname, passwordHash) {
      if (data.users.some(u => u.nickname === nickname)) {
        const err = new Error('UNIQUE constraint failed: users.nickname');
        err.code = 'SQLITE_CONSTRAINT_UNIQUE';
        throw err;
      }
      const row = { id: ++data.seq.users, nickname, password_hash: passwordHash, created_at: nowIso() };
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
    close() { flush(); },
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
    console.warn('[db] better-sqlite3 를 사용할 수 없어 JSON 어댑터로 폴백합니다.');
    console.warn('[db] 사유: ' + e.message.split('\n')[0]);
    console.warn('[db] 기능은 동일합니다. sqlite 를 쓰려면 빌드 도구 설치 후 DB_ADAPTER=sqlite 로 실행하세요.');
    return createJsonAdapter(path.join(dir, 'app.json'));
  }
}

module.exports = { open, createSqliteAdapter, createJsonAdapter, BATTLE_ROUND };
