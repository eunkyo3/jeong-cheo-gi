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
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE study_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      round TEXT NOT NULL,
      score INTEGER NOT NULL,
      taken_at TEXT NOT NULL
    );`);
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
