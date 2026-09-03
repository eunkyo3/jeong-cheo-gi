// db-adapter.test.mjs — 동일 계약 테스트를 sqlite / json 두 어댑터에 실행한다.
// 폴백 경로(json)를 상시 검증하기 위한 것이므로 어느 한쪽만 통과해서는 안 된다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../server/db.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-db-'));
}

const ADAPTERS = ['sqlite', 'json'];

for (const adapter of ADAPTERS) {
  describe(`db adapter: ${adapter}`, () => {
    test('createUser / findUserByNickname / findUserById', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        assert.equal(d.kind, adapter);
        const u = d.createUser('철수', 'hash-a');
        assert.ok(u.id > 0);
        assert.equal(u.nickname, '철수');
        assert.equal(u.password_hash, 'hash-a');
        assert.ok(u.created_at);

        const byNick = d.findUserByNickname('철수');
        assert.equal(byNick.id, u.id);
        const byId = d.findUserById(u.id);
        assert.equal(byId.nickname, '철수');

        assert.equal(d.findUserByNickname('없는사람'), null);
        assert.equal(d.findUserById(9999), null);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('닉네임 중복은 거부된다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        d.createUser('중복', 'h1');
        assert.throws(() => d.createUser('중복', 'h2'), /UNIQUE|constraint/i);
        assert.equal(d.listUsers().length, 1);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('saveMatch 는 매치와 참가자를 함께 기록한다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('A', 'h');
        const b = d.createUser('B', 'h');
        const matchId = d.saveMatch({
          roomName: '테스트방',
          mode: 'round',
          roundIds: ['2026-2'],
          questionIds: ['2026-2#1', '2026-2#2'],
          timeLimitS: 600,
          startedAt: '2026-08-28T00:00:00.000Z',
          finishedAt: '2026-08-28T00:10:00.000Z',
          winnerUserId: a.id,
        }, [
          { userId: a.id, correctCount: 2, submittedAt: '2026-08-28T00:05:00.000Z', answers: { '2026-2#1': ['ㄱ'] } },
          { userId: b.id, correctCount: 1, submittedAt: '2026-08-28T00:06:00.000Z', answers: {} },
        ]);
        assert.ok(matchId > 0);

        const matches = d.listMatches();
        assert.equal(matches.length, 1);
        assert.equal(matches[0].room_name, '테스트방');
        assert.equal(matches[0].mode, 'round');
        assert.equal(matches[0].time_limit_s, 600);
        assert.equal(matches[0].winner_user_id, a.id);
        // round_ids / question_ids 는 JSON 문자열로 보관한다
        assert.deepEqual(JSON.parse(matches[0].round_ids), ['2026-2']);
        assert.deepEqual(JSON.parse(matches[0].question_ids), ['2026-2#1', '2026-2#2']);

        const players = d.listMatchPlayers(matchId);
        assert.equal(players.length, 2);
        const pa = players.find(p => p.user_id === a.id);
        assert.equal(pa.correct_count, 2);
        assert.deepEqual(JSON.parse(pa.answers), { '2026-2#1': ['ㄱ'] });

        // matchId 없이 부르면 전체 반환
        assert.equal(d.listMatchPlayers().length, 2);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('saveMatch 는 참가자별 study_results(round=battle) 도 같은 쓰기에서 남긴다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('대전A', 'h');
        const b = d.createUser('대전B', 'h');
        const qids = ['2026-2#1', '2026-2#2'];
        const id = d.saveMatch({
          roomName: '대전방', mode: 'round', roundIds: ['2026-2'], questionIds: qids,
          timeLimitS: 600,
          startedAt: '2026-08-31T00:00:00.000Z',
          finishedAt: '2026-08-31T00:10:00.000Z',
          winnerUserId: a.id,
        }, [
          { userId: a.id, correctCount: 1, score: 50, submittedAt: '2026-08-31T00:05:00.000Z', answers: {}, questionIds: qids, wrongIds: ['2026-2#2'] },
          { userId: b.id, correctCount: 0, score: 0, submittedAt: null, answers: {}, questionIds: qids, wrongIds: qids },
        ]);
        assert.ok(id > 0);
        assert.equal(d.listMatchPlayers(id).length, 2); // 매치 기록은 그대로

        const ra = d.listStudyResults(a.id, 10);
        assert.equal(ra.length, 1);
        assert.equal(ra[0].round, 'battle');
        assert.equal(ra[0].score, 50);
        assert.deepEqual(JSON.parse(ra[0].question_ids), qids);
        assert.deepEqual(JSON.parse(ra[0].wrong_ids), ['2026-2#2']);
        // taken_at 은 매치 종료 시각 — 소급 스크립트가 이 값으로 중복을 판별한다
        assert.equal(ra[0].taken_at, '2026-08-31T00:10:00.000Z');
        // match_id 는 같은 쓰기에서 박힌다 — 오답노트를 대전 단위로 묶는 연결고리
        assert.equal(ra[0].match_id, id);

        const rb = d.listStudyResults(b.id, 10);
        assert.equal(rb.length, 1);
        assert.equal(rb[0].round, 'battle');
        assert.equal(rb[0].score, 0);
        assert.deepEqual(JSON.parse(rb[0].wrong_ids), qids); // 전 문항 오답
        assert.equal(rb[0].match_id, id);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('listMatchesByUser 는 내가 참가한 매치만, 참가자 닉네임과 함께 돌려준다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('참가A', 'h');
        const b = d.createUser('참가B', 'h');
        const c = d.createUser('제3자', 'h');
        const qids = ['2026-2#1', '2026-2#2'];
        const mine = d.saveMatch({
          roomName: '내방', mode: 'round', roundIds: ['2026-2'], questionIds: qids,
          timeLimitS: 600, startedAt: 't0', finishedAt: 't1', winnerUserId: b.id,
        }, [
          { userId: a.id, correctCount: 1, score: 50, submittedAt: 't1', answers: { '2026-2#1': ['비밀'] }, questionIds: qids, wrongIds: ['2026-2#2'] },
          { userId: b.id, correctCount: 2, score: 100, submittedAt: 't1', answers: {}, questionIds: qids, wrongIds: [] },
        ]);
        const theirs = d.saveMatch({
          roomName: '남의방', mode: 'round', roundIds: ['2026-2'], questionIds: qids,
          timeLimitS: 600, startedAt: 't0', finishedAt: 't2', winnerUserId: c.id,
        }, [
          { userId: b.id, correctCount: 0, score: 0, submittedAt: 't2', answers: {}, questionIds: qids, wrongIds: qids },
          { userId: c.id, correctCount: 2, score: 100, submittedAt: 't2', answers: {}, questionIds: qids, wrongIds: [] },
        ]);

        const list = d.listMatchesByUser(a.id);
        assert.equal(list.length, 1); // 남의 매치는 애초에 나오지 않는다
        assert.equal(list[0].id, mine);
        assert.equal(list[0].room_name, '내방');
        assert.equal(list[0].winner_user_id, b.id);
        assert.equal(list[0].players.length, 2);
        const rowB = list[0].players.find(p => p.user_id === b.id);
        assert.equal(rowB.nickname, '참가B');
        assert.equal(rowB.correct_count, 2);
        // 상대의 보관 답안은 어떤 조회로도 나가지 않는다
        assert.ok(!('answers' in rowB), Object.keys(rowB).join(','));

        assert.equal(d.listMatchesByUser(b.id).length, 2);
        assert.deepEqual(d.listMatchesByUser(c.id).map(m => m.id), [theirs]);
        assert.equal(d.listMatchesByUser(9999).length, 0);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('updateStudyMatchId 는 기존 행의 match_id 만 채운다 (소급용)', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('소급연결', 'h');
        d.saveStudyResult(u.id, 'battle', 40, ['2026-2#1'], ['2026-2#1'], '2020-01-01T00:00:00.000Z');
        const before = d.listStudyResults(u.id, 10)[0];
        assert.equal(before.match_id, null); // match_id 없이 적재된 예전 모양

        d.updateStudyMatchId(before.id, 77);
        const after = d.listStudyResults(u.id, 10)[0];
        assert.equal(after.match_id, 77);
        assert.equal(after.score, 40);                              // 나머지는 그대로
        assert.equal(after.taken_at, '2020-01-01T00:00:00.000Z');
        assert.deepEqual(JSON.parse(after.wrong_ids), ['2026-2#1']);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('questionIds/wrongIds 없는 예전 호출자는 매치만 남기고 학습 기록은 건너뛴다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('구식', 'h');
        const id = d.saveMatch({
          roomName: '구식방', mode: 'round', roundIds: ['2026-2'], questionIds: ['2026-2#1'],
          timeLimitS: 600, startedAt: 't0', finishedAt: 't1', winnerUserId: a.id,
        }, [{ userId: a.id, correctCount: 1, submittedAt: 't1', answers: {} }]);
        assert.equal(d.listMatchPlayers(id).length, 1);
        assert.equal(d.listStudyResults(a.id, 10).length, 0); // study 행 없음
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('saveStudyResult 는 takenAt 을 명시하면 그 시각으로 적재한다 (소급용)', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('소급', 'h');
        d.saveStudyResult(u.id, 'battle', 40, ['2026-2#1'], ['2026-2#1'], '2020-01-01T00:00:00.000Z');
        const rows = d.listStudyResults(u.id, 10);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].taken_at, '2020-01-01T00:00:00.000Z');
        assert.equal(rows[0].round, 'battle');
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('무승부는 winner_user_id NULL 로 기록된다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('A', 'h');
        const b = d.createUser('B', 'h');
        const id = d.saveMatch({
          roomName: '무승부방', mode: 'random', roundIds: ['2026-2'], questionIds: ['2026-2#1'],
          timeLimitS: 1200, startedAt: 't0', finishedAt: 't1', winnerUserId: null,
        }, [
          { userId: a.id, correctCount: 1, submittedAt: null, answers: {} },
          { userId: b.id, correctCount: 1, submittedAt: null, answers: {} },
        ]);
        const m = d.listMatches().find(x => x.id === id);
        assert.equal(m.winner_user_id, null);
        // 미제출자의 submitted_at 은 null 로 보존된다
        assert.equal(d.listMatchPlayers(id).every(p => p.submitted_at === null), true);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('saveStudyResult / listStudyResults', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('학생', 'h');
        d.saveStudyResult(u.id, '2026-2', 85);
        d.saveStudyResult(u.id, '2026-1', 70);
        const rows = d.listStudyResults(u.id, 10);
        assert.equal(rows.length, 2);
        // 최신순
        assert.equal(rows[0].round, '2026-1');
        assert.equal(rows[0].score, 70);
        assert.ok(rows[0].taken_at);
        // 다른 유저의 기록은 섞이지 않는다
        const other = d.createUser('타인', 'h');
        assert.equal(d.listStudyResults(other.id, 10).length, 0);
        // limit 적용
        assert.equal(d.listStudyResults(u.id, 1).length, 1);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('saveStudyResult 는 출제/오답 문항 id 를 함께 보관한다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('오답', 'h');
        d.saveStudyResult(u.id, '2026-2', 50, ['2026-2#1', '2026-2#2'], ['2026-2#2']);
        d.saveStudyResult(u.id, 'practice', 100, ['2026-1#3'], []);
        d.saveStudyResult(u.id, '2026-1', 80); // 뒤 두 인자 없이도 호출된다(예전 시그니처)

        const rows = d.listStudyResults(u.id, 10); // 최신 먼저
        // 문항 id 는 JSON 문자열로 보관한다 (matches.question_ids 와 같은 규약)
        assert.equal(rows[0].round, '2026-1');
        assert.equal(rows[0].question_ids, null);
        assert.equal(rows[0].wrong_ids, null);

        assert.equal(rows[1].round, 'practice');
        assert.deepEqual(JSON.parse(rows[1].question_ids), ['2026-1#3']);
        assert.deepEqual(JSON.parse(rows[1].wrong_ids), []); // 빈 배열과 "정보 없음"(null)은 다르다

        assert.equal(rows[2].round, '2026-2');
        assert.deepEqual(JSON.parse(rows[2].question_ids), ['2026-2#1', '2026-2#2']);
        assert.deepEqual(JSON.parse(rows[2].wrong_ids), ['2026-2#2']);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('재시작 후에도 데이터가 유지된다 (영속성)', () => {
      const dir = tmpDir();
      let userId;
      let matchId;
      const d1 = db.open({ dir, adapter });
      try {
        const u = d1.createUser('영속', 'hash-persist');
        userId = u.id;
        matchId = d1.saveMatch({
          roomName: '방', mode: 'round', roundIds: ['2026-2'], questionIds: ['2026-2#1'],
          timeLimitS: 600, startedAt: 't0', finishedAt: 't1', winnerUserId: u.id,
        }, [{ userId: u.id, correctCount: 1, submittedAt: 't1', answers: {} }]);
        d1.saveStudyResult(u.id, '2026-2', 95);
      } finally {
        d1.close();
      }

      const d2 = db.open({ dir, adapter });
      try {
        const u = d2.findUserByNickname('영속');
        assert.equal(u.id, userId);
        assert.equal(u.password_hash, 'hash-persist');
        assert.equal(d2.listMatches().length, 1);
        assert.equal(d2.listMatchPlayers(matchId).length, 1);
        assert.equal(d2.listStudyResults(userId, 10).length, 1);
      } finally {
        d2.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('어댑터는 raw row 를 반환한다 (집계는 호출자 몫)', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('로우', 'h');
        const row = d.findUserByNickname('로우');
        // snake_case 컬럼명을 그대로 노출한다 — ranking.js 가 이 형태를 전제한다
        assert.ok('password_hash' in row);
        assert.ok('created_at' in row);
        assert.equal(row.id, u.id);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

// sqlite 전용 — CREATE TABLE IF NOT EXISTS 는 기존 파일을 바꾸지 않으므로
// 예전 스키마로 만들어진 DB 가 재기동만으로 새 컬럼을 얻는지 따로 못박는다.
describe('db adapter: sqlite 스키마 마이그레이션', () => {
  test('question_ids / wrong_ids / match_id 없는 예전 DB 를 열면 컬럼이 생기고 데이터는 남는다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.db');
    const Database = require('better-sqlite3');

    // ① 예전 스키마 그대로 만든 DB + 기존 기록 1건
    //    study_results.user_id 는 이제 실제 FK 라 소유자 행이 있어야 한다(id 7 을 맞춰 만든다).
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE study_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      round TEXT NOT NULL,
      score INTEGER NOT NULL,
      taken_at TEXT NOT NULL
    );`);
    legacy.prepare('INSERT INTO users (id, nickname, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(7, '옛사람', '$2a$10$notarealbcrypthashvalue000000000000000000000000000000', '2020-01-01T00:00:00.000Z');
    legacy.prepare('INSERT INTO study_results (user_id, round, score, taken_at) VALUES (?, ?, ?, ?)')
      .run(7, '2026-2', 60, '2026-08-01T00:00:00.000Z');
    legacy.close();

    // ② 어댑터로 열기만 하면 마이그레이션된다
    const d = db.createSqliteAdapter(file);
    try {
      const rows = d.listStudyResults(7, 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].score, 60);            // 기존 데이터 보존
      assert.equal(rows[0].question_ids, null);   // 새 컬럼은 NULL 로 채워진다
      assert.equal(rows[0].wrong_ids, null);
      assert.equal(rows[0].match_id, null);

      // ③ 마이그레이션 후 새 저장도 정상 동작
      d.saveStudyResult(7, '2026-1', 90, ['2026-1#1'], []);
      const after = d.listStudyResults(7, 10);
      assert.deepEqual(JSON.parse(after[0].question_ids), ['2026-1#1']);

      // ④ 새로 생긴 match_id 컬럼도 곧바로 쓸 수 있다(소급 스크립트 경로)
      d.updateStudyMatchId(rows[0].id, 3);
      assert.equal(d.listStudyResults(7, 10).find(r => r.id === rows[0].id).match_id, 3);
    } finally {
      d.close();
    }

    // ⑤ 파일 자체의 스키마를 직접 확인
    const check = new Database(file);
    const cols = check.prepare('PRAGMA table_info(study_results)').all().map(c => c.name);
    check.close();
    assert.ok(cols.includes('question_ids'), cols.join(','));
    assert.ok(cols.includes('wrong_ids'), cols.join(','));
    assert.ok(cols.includes('match_id'), cols.join(','));

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- 신규 조회 계약
// listMatchNames / bestScoresByRound 는 두 어댑터가 같은 모양을 돌려줘야 한다.
for (const adapter of ADAPTERS) {
  describe(`db adapter: ${adapter} — 조회 보조 메서드`, () => {
    test('listMatchNames 는 요청한 id 의 방 이름만 id 오름차순으로 돌려준다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('이름조회', 'h');
        const mk = name => d.saveMatch({
          roomName: name, mode: 'round', roundIds: ['2026-2'], questionIds: ['2026-2#1'],
          timeLimitS: 600, startedAt: 't0', finishedAt: 't1', winnerUserId: u.id,
        }, [{ userId: u.id, correctCount: 1, submittedAt: 't1', answers: {} }]);
        const m1 = mk('첫방');
        const m2 = mk('둘째방');
        const m3 = mk('셋째방');

        assert.deepEqual(d.listMatchNames([m3, m1]), [
          { id: m1, room_name: '첫방' },
          { id: m3, room_name: '셋째방' },
        ]);
        // 없는 id 는 조용히 빠지고, 중복은 한 번만 나온다
        assert.deepEqual(d.listMatchNames([m2, m2, 99999]), [{ id: m2, room_name: '둘째방' }]);
        assert.deepEqual(d.listMatchNames([]), []);
        assert.deepEqual(d.listMatchNames(null), []);
        assert.deepEqual(d.listMatchNames(['x', -1, 0]), []);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('bestScoresByRound 는 집합 키별 최고점과 응시 횟수를 준다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const u = d.createUser('최고점', 'h');
        const other = d.createUser('남', 'h');
        d.saveStudyResult(u.id, '2026-2', 40);
        d.saveStudyResult(u.id, '2026-2', 90);
        d.saveStudyResult(u.id, '2026-2', 70);
        d.saveStudyResult(u.id, 'practice', 55);
        d.saveStudyResult(other.id, '2026-2', 100); // 남의 기록은 섞이지 않는다

        const byRound = new Map(d.bestScoresByRound(u.id).map(r => [r.round, r]));
        assert.equal(byRound.size, 2);
        assert.equal(byRound.get('2026-2').best, 90);
        assert.equal(byRound.get('2026-2').count, 3);
        assert.equal(byRound.get('practice').best, 55);
        assert.equal(byRound.get('practice').count, 1);
        assert.deepEqual(d.bestScoresByRound(99999), []);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('updatePasswordHash / bumpSessionVersion 은 그 사용자만 바꾼다', () => {
      const dir = tmpDir();
      const d = db.open({ dir, adapter });
      try {
        const a = d.createUser('해시A', 'old-hash');
        const b = d.createUser('해시B', 'keep-hash');
        assert.equal(d.findUserById(a.id).session_version, 0); // 새 계정의 세션 세대는 0

        d.updatePasswordHash(a.id, 'scrypt$salt$key');
        assert.equal(d.findUserById(a.id).password_hash, 'scrypt$salt$key');
        assert.equal(d.findUserById(b.id).password_hash, 'keep-hash');

        assert.equal(d.bumpSessionVersion(a.id), 1);
        assert.equal(d.bumpSessionVersion(a.id), 2);
        assert.equal(d.findUserById(a.id).session_version, 2);
        assert.equal(d.findUserById(b.id).session_version, 0);
      } finally {
        d.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('flushSync / close 뒤에도 디스크에 남는다 (JSON 어댑터 디바운스 안전망)', () => {
      const dir = tmpDir();
      const d1 = db.open({ dir, adapter });
      let id;
      try {
        id = d1.createUser('디바운스', 'h').id;
        d1.saveStudyResult(id, '2026-2', 77);
        d1.flushSync(); // close 하기 전에도 즉시 내려간다
      } finally {
        d1.close();
      }
      const d2 = db.open({ dir, adapter });
      try {
        assert.equal(d2.listStudyResults(id, 10).length, 1);
        assert.equal(d2.schemaVersion(), 4); // 두 어댑터가 같은 눈금을 쓴다
      } finally {
        d2.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

// ------------------------------------------------- sqlite 마이그레이션 프레임
describe('db adapter: sqlite user_version 마이그레이션', () => {
  const Database = require('better-sqlite3');

  /** user_version 0 인 예전 스키마 DB 를 만든다(FK 없음·session_version 없음). */
  function makeLegacyDb(file) {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_name TEXT NOT NULL, mode TEXT NOT NULL,
        round_ids TEXT NOT NULL, question_ids TEXT NOT NULL, time_limit_s INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, winner_user_id INTEGER);
      CREATE TABLE match_players (
        match_id INTEGER NOT NULL, user_id INTEGER NOT NULL, correct_count INTEGER NOT NULL,
        submitted_at TEXT, answers TEXT NOT NULL, PRIMARY KEY (match_id, user_id));
      CREATE TABLE study_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, round TEXT NOT NULL,
        score INTEGER NOT NULL, taken_at TEXT NOT NULL);
    `);
    legacy.prepare('INSERT INTO users (nickname, password_hash, created_at) VALUES (?, ?, ?)')
      .run('옛계정', '$2a$10$legacyhash', '2020-01-01T00:00:00.000Z');
    legacy.prepare(`INSERT INTO matches
      (room_name, mode, round_ids, question_ids, time_limit_s, started_at, finished_at, winner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('옛방', 'round', '[]', '[]', 600, 't0', 't1', 1);
    legacy.prepare('INSERT INTO match_players VALUES (?, ?, ?, ?, ?)').run(1, 1, 2, 't1', '{}');
    legacy.prepare('INSERT INTO study_results (user_id, round, score, taken_at) VALUES (?, ?, ?, ?)')
      .run(1, '2026-2', 60, '2026-08-01T00:00:00.000Z');
    assert.equal(legacy.pragma('user_version', { simple: true }), 0);
    legacy.close();
  }

  test('v0 DB 를 열면 v4 까지 올라가고 데이터는 그대로다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.db');
    makeLegacyDb(file);

    const d = db.createSqliteAdapter(file);
    try {
      assert.equal(d.schemaVersion(), 4);
      assert.equal(d.listUsers().length, 1);
      assert.equal(d.listMatches().length, 1);
      assert.equal(d.listMatchPlayers(1).length, 1);
      const rows = d.listStudyResults(1, 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].score, 60);
      assert.equal(rows[0].question_ids, null); // v1 이 더한 컬럼
      assert.equal(d.findUserById(1).session_version, 0); // v2 가 더한 컬럼
    } finally {
      d.close();
    }

    const check = new Database(file, { readonly: true });
    try {
      // v3 — 복합 인덱스
      const idx = check.pragma('index_list(study_results)').map(i => i.name);
      assert.ok(idx.includes('idx_sr_user_id'), idx.join(','));
      // v4 — 실제 FK (ON DELETE CASCADE)
      const mp = check.pragma('foreign_key_list(match_players)');
      assert.equal(mp.length, 2);
      assert.ok(mp.every(f => f.on_delete === 'CASCADE'), JSON.stringify(mp));
      const sr = check.pragma('foreign_key_list(study_results)');
      assert.equal(sr.length, 1);
      assert.equal(sr[0].table, 'users');
      assert.equal(sr[0].on_delete, 'CASCADE');
    } finally {
      check.close();
    }
  });

  test('마이그레이션 전에 app.db.bak-<시각> 백업을 남긴다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.db');
    makeLegacyDb(file);
    assert.equal(fs.readdirSync(dir).filter(n => /^app\.db\.bak-\d{8}-\d{6}$/.test(n)).length, 0);

    const d = db.createSqliteAdapter(file);
    d.close();
    const backups = fs.readdirSync(dir).filter(n => /^app\.db\.bak-\d{8}-\d{6}$/.test(n));
    assert.equal(backups.length, 1, backups.join(','));
    assert.match(backups[0], /^app\.db\.bak-\d{8}-\d{6}$/);
    // 백업은 마이그레이션 이전 모양이어야 한다
    const old = new Database(path.join(dir, backups[0]), { readonly: true });
    try {
      assert.equal(old.pragma('user_version', { simple: true }), 0);
      assert.equal(old.pragma('foreign_key_list(match_players)').length, 0);
    } finally {
      old.close();
    }

    // 이미 최신이면 다시 열어도 백업이 늘지 않는다
    const again = db.createSqliteAdapter(file);
    again.close();
    assert.equal(fs.readdirSync(dir).filter(n => /^app\.db\.bak-\d{8}-\d{6}$/.test(n)).length, 1);
  });

  test('FK 는 실제로 걸린다 — 사용자를 지우면 매치 참가·학습 기록이 함께 사라진다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.db');
    makeLegacyDb(file);
    const d = db.createSqliteAdapter(file);
    d.close();

    const conn = new Database(file);
    try {
      conn.pragma('foreign_keys = ON');
      conn.prepare('DELETE FROM users WHERE id = ?').run(1);
      assert.equal(conn.prepare('SELECT COUNT(*) c FROM match_players').get().c, 0);
      assert.equal(conn.prepare('SELECT COUNT(*) c FROM study_results').get().c, 0);
      assert.equal(conn.prepare('SELECT COUNT(*) c FROM matches').get().c, 1); // 매치 자체는 남는다
    } finally {
      conn.close();
    }
  });

  test('새로 만든 DB 도 마이그레이션을 끝낸 DB 와 같은 스키마다', () => {
    const fresh = tmpDir();
    const migrated = tmpDir();
    const freshFile = path.join(fresh, 'app.db');
    const migratedFile = path.join(migrated, 'app.db');
    makeLegacyDb(migratedFile);

    const a = db.createSqliteAdapter(freshFile);
    const b = db.createSqliteAdapter(migratedFile);
    a.close();
    b.close();
    // 새 DB 는 밀린 마이그레이션이 없으므로 백업도 만들지 않는다
    assert.equal(fs.readdirSync(fresh).filter(n => /^app\.db\.bak-\d{8}-\d{6}$/.test(n)).length, 0);

    function shape(file) {
      const c = new Database(file, { readonly: true });
      try {
        const tables = c.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).all().map(r => r.name);
        const out = { version: c.pragma('user_version', { simple: true }), tables: {} };
        for (const t of tables) {
          out.tables[t] = {
            cols: c.pragma(`table_info(${t})`).map(x => `${x.name}:${x.type}`).sort(),
            fks: c.pragma(`foreign_key_list(${t})`).map(f => `${f.from}->${f.table}.${f.to}:${f.on_delete}`).sort(),
            idx: c.pragma(`index_list(${t})`).map(i => i.name).filter(n => !n.startsWith('sqlite_')).sort(),
          };
        }
        return out;
      } finally {
        c.close();
      }
    }
    assert.deepEqual(shape(migratedFile), shape(freshFile));
  });
});

// ------------------------------------------------------ JSON 어댑터 회복 규약
describe('db adapter: json seq 복구 · schemaVersion', () => {
  test('seq 하위 키가 빠져 있어도 id 가 NaN 이 되지 않는다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.json');
    // seq 에 users 만 있고 study_results 가 없는 파일 (예전 버전이 남긴 모양)
    fs.writeFileSync(file, JSON.stringify({
      users: [{ id: 1, nickname: 'ㄱ', password_hash: 'h', created_at: 't' }],
      matches: [], match_players: [], study_results: [],
      seq: { users: 1 },
    }), 'utf8');

    const d = db.open({ dir, adapter: 'json' });
    try {
      d.saveStudyResult(1, '2026-2', 50);
      const rows = d.listStudyResults(1, 10);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 1);            // NaN 이 아니라 1
      assert.equal(Number.isInteger(rows[0].id), true);
      const u = d.createUser('ㄴ', 'h');
      assert.equal(u.id, 2);
    } finally {
      d.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('seq 가 실제 최대 id 보다 작으면 최대 id 로 끌어올린다 (id 충돌 방지)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.json');
    fs.writeFileSync(file, JSON.stringify({
      users: [{ id: 9, nickname: 'ㄱ', password_hash: 'h', created_at: 't' }],
      matches: [], match_players: [],
      study_results: [{ id: 4, user_id: 9, round: '2026-2', score: 10, taken_at: 't' }],
      seq: { users: 1, matches: 0, study_results: 0 },
    }), 'utf8');

    const d = db.open({ dir, adapter: 'json' });
    try {
      assert.equal(d.createUser('ㄴ', 'h').id, 10);
      d.saveStudyResult(9, '2026-1', 20);
      const ids = d.listStudyResults(9, 10).map(r => r.id).sort((x, y) => x - y);
      assert.deepEqual(ids, [4, 5]); // 4 를 덮어쓰지 않는다
    } finally {
      d.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('schemaVersion 없는 파일은 열면서 형태가 맞춰지고 백업이 남는다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'app.json');
    fs.writeFileSync(file, JSON.stringify({
      users: [{ id: 1, nickname: 'ㄱ', password_hash: 'h', created_at: 't' }],
      matches: [], match_players: [],
      study_results: [{ id: 1, user_id: 1, round: '2026-2', score: 10, taken_at: 't' }],
      seq: { users: 1, matches: 0, study_results: 1 },
    }), 'utf8');

    const d = db.open({ dir, adapter: 'json' });
    try {
      assert.equal(d.schemaVersion(), 4);
      assert.equal(d.findUserById(1).session_version, 0);   // v2
      const row = d.listStudyResults(1, 10)[0];
      assert.equal(row.question_ids, null);                  // v1
      assert.equal(row.wrong_ids, null);
      assert.equal(row.match_id, null);
    } finally {
      d.close();
    }
    const backups = fs.readdirSync(dir).filter(n => /^app\.json\.bak-\d{8}-\d{6}$/.test(n));
    assert.equal(backups.length, 1, backups.join(','));

    // 두 번째 기동은 이미 최신이라 백업하지 않는다
    const again = db.open({ dir, adapter: 'json' });
    again.close();
    assert.equal(fs.readdirSync(dir).filter(n => /^app\.json\.bak-\d{8}-\d{6}$/.test(n)).length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
