// ranking.test.mjs — computeRanking 을 인메모리(임시 디렉터리) json 어댑터 위에서 검증한다.
// json 어댑터를 쓰는 이유: 네이티브 빌드 없이 어디서나 돌고, db 어댑터가 raw row 만
// 돌려준다는 계약(집계는 ranking.js 담당)을 실제로 통과시키기 때문이다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbmod = require('../server/db.js');
const { computeRanking } = require('../server/ranking.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-rank-'));
}

/** 임시 json 어댑터를 열고 fn 에 넘긴 뒤 반드시 정리한다. */
function withDb(fn) {
  const dir = tmpDir();
  const d = dbmod.open({ dir, adapter: 'json' });
  try {
    return fn(d);
  } finally {
    d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** saveMatch 보일러플레이트를 줄이는 헬퍼. winnerUserId=null 이면 무승부 매치. */
function saveMatch(d, winnerUserId, userIds) {
  return d.saveMatch(
    {
      roomName: '테스트방',
      mode: 'round',
      roundIds: ['2026-2'],
      questionIds: ['2026-2#1'],
      timeLimitS: 600,
      startedAt: '2026-08-28T00:00:00.000Z',
      finishedAt: '2026-08-28T00:10:00.000Z',
      winnerUserId,
    },
    userIds.map(id => ({ userId: id, correctCount: 0, submittedAt: null, answers: {} }))
  );
}

/** 닉네임으로 행을 찾는다. */
function row(rank, nickname) {
  const r = rank.find(x => x.nickname === nickname);
  assert.ok(r, `${nickname} 행이 랭킹에 없다`);
  return r;
}

describe('computeRanking', () => {
  test('매치가 없으면 전 사용자가 0전 0점으로 나온다', () => {
    withDb(d => {
      d.createUser('가나', 'h');
      d.createUser('나다', 'h');
      const rank = computeRanking(d);
      assert.equal(rank.length, 2);
      for (const r of rank) {
        assert.deepEqual(
          { wins: r.wins, draws: r.draws, losses: r.losses, points: r.points, played: r.played },
          { wins: 0, draws: 0, losses: 0, points: 0, played: 0 }
        );
      }
      // 전부 동률이므로 순위는 모두 1위, 표시 순서는 닉네임 오름차순.
      assert.deepEqual(rank.map(r => r.nickname), ['가나', '나다']);
      assert.deepEqual(rank.map(r => r.rank), [1, 1]);
    });
  });

  test('사용자도 매치도 없으면 빈 배열이며 크래시하지 않는다', () => {
    withDb(d => {
      assert.deepEqual(computeRanking(d), []);
    });
  });

  test('1:1 승리 — 승자 +3, 패자 +1', () => {
    withDb(d => {
      const a = d.createUser('가나', 'h');
      const b = d.createUser('나다', 'h');
      saveMatch(d, a.id, [a.id, b.id]);

      const rank = computeRanking(d);
      const winner = row(rank, '가나');
      const loser = row(rank, '나다');

      assert.deepEqual(
        { rank: winner.rank, wins: winner.wins, draws: winner.draws, losses: winner.losses, points: winner.points, played: winner.played },
        { rank: 1, wins: 1, draws: 0, losses: 0, points: 3, played: 1 }
      );
      assert.deepEqual(
        { rank: loser.rank, wins: loser.wins, draws: loser.draws, losses: loser.losses, points: loser.points, played: loser.played },
        { rank: 2, wins: 0, draws: 0, losses: 1, points: 1, played: 1 }
      );
      assert.equal(winner.userId, a.id);
      assert.equal(loser.userId, b.id);
    });
  });

  test('3인 매치 — 1등 +3, 나머지 각 +1', () => {
    withDb(d => {
      const a = d.createUser('가나', 'h');
      const b = d.createUser('나다', 'h');
      const c = d.createUser('다라', 'h');
      saveMatch(d, b.id, [a.id, b.id, c.id]);

      const rank = computeRanking(d);
      assert.equal(row(rank, '나다').points, 3);
      assert.equal(row(rank, '나다').wins, 1);
      assert.equal(row(rank, '가나').points, 1);
      assert.equal(row(rank, '다라').points, 1);

      // 패 = 참가 − 승 − 무
      for (const nick of ['가나', '다라']) {
        const r = row(rank, nick);
        assert.equal(r.losses, r.played - r.wins - r.draws);
        assert.equal(r.losses, 1);
        assert.equal(r.draws, 0);
      }
      assert.equal(row(rank, '나다').losses, 0);

      // 1등만 1위, 나머지는 승점·승수가 같으므로 공동 2위.
      assert.equal(row(rank, '나다').rank, 1);
      assert.equal(row(rank, '가나').rank, 2);
      assert.equal(row(rank, '다라').rank, 2);
    });
  });

  test('무승부 매치 — 전원 +1, 승 0, 무 1, 패 0', () => {
    withDb(d => {
      const a = d.createUser('가나', 'h');
      const b = d.createUser('나다', 'h');
      const c = d.createUser('다라', 'h');
      saveMatch(d, null, [a.id, b.id, c.id]);

      const rank = computeRanking(d);
      for (const nick of ['가나', '나다', '다라']) {
        const r = row(rank, nick);
        assert.deepEqual(
          { wins: r.wins, draws: r.draws, losses: r.losses, points: r.points, played: r.played },
          { wins: 0, draws: 1, losses: 0, points: 1, played: 1 }
        );
        assert.equal(r.rank, 1); // 전원 동률
      }
    });
  });

  test('여러 매치 누계 — 승/무/패와 승점이 함께 쌓인다', () => {
    withDb(d => {
      const a = d.createUser('가나', 'h');
      const b = d.createUser('나다', 'h');
      saveMatch(d, a.id, [a.id, b.id]); // a 승
      saveMatch(d, null, [a.id, b.id]); // 무승부
      saveMatch(d, b.id, [a.id, b.id]); // b 승

      const rank = computeRanking(d);
      for (const nick of ['가나', '나다']) {
        const r = row(rank, nick);
        assert.deepEqual(
          { wins: r.wins, draws: r.draws, losses: r.losses, points: r.points, played: r.played },
          { wins: 1, draws: 1, losses: 1, points: 5, played: 3 }
        );
      }
    });
  });

  test('정렬: 승점 desc → 승수 desc → 닉네임 asc', () => {
    withDb(d => {
      // 승점 3, 1승  — 최상위
      const win = d.createUser('힘찬', 'h');
      const foe = d.createUser('상대', 'h');
      saveMatch(d, win.id, [win.id, foe.id]);

      // 승점 3, 0승 (무승부 3회) — 같은 승점이지만 승수가 적어 아래
      const drawA = d.createUser('무승부가', 'h');
      const drawB = d.createUser('무승부나', 'h');
      saveMatch(d, null, [drawA.id, drawB.id]);
      saveMatch(d, null, [drawA.id, drawB.id]);
      saveMatch(d, null, [drawA.id, drawB.id]);

      // 승점 0 — 무기록 사용자 둘. 닉네임 오름차순으로만 갈린다.
      d.createUser('가장먼저', 'h');
      d.createUser('나중에', 'h');

      const rank = computeRanking(d);

      assert.deepEqual(rank.map(r => r.nickname), [
        '힘찬',        // 3점 1승
        '무승부가',    // 3점 0승 (닉네임 asc: 가 < 나)
        '무승부나',    // 3점 0승
        '상대',        // 1점 0승
        '가장먼저',    // 0점
        '나중에',      // 0점
      ]);

      // 동순위 번호는 건너뛴다: 1, 2, 2, 4, 5, 5
      assert.deepEqual(rank.map(r => r.rank), [1, 2, 2, 4, 5, 5]);
      assert.deepEqual(rank.map(r => r.points), [3, 3, 3, 1, 0, 0]);
    });
  });

  test('winner_user_id 가 참가자가 아니면 1등 가산 없이 참가만 인정한다', () => {
    withDb(d => {
      const a = d.createUser('가나', 'h');
      const b = d.createUser('나다', 'h');
      const outsider = d.createUser('제3자', 'h');
      saveMatch(d, outsider.id, [a.id, b.id]);

      const rank = computeRanking(d);
      for (const nick of ['가나', '나다']) {
        const r = row(rank, nick);
        assert.equal(r.points, 1);
        assert.equal(r.wins, 0);
        assert.equal(r.draws, 0);
        assert.equal(r.losses, 1);
      }
      assert.equal(row(rank, '제3자').played, 0);
    });
  });
});
