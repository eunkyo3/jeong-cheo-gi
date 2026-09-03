// practice-api.test.mjs — 학습 이력 · 오답노트 · 랜덤 모의고사 REST 종단 검증.
//
// 실서버를 임시 포트(PORT=0) + 격리된 임시 DATA_DIR 로 띄우고 fetch 로 두드린다(실제 data/ 는 건드리지 않는다).
// 회차 JSON 은 항상 repo 의 data/rounds 를 읽으므로 sampleAnswer 를 그대로 정답으로 쓸 수 있다.
// 테스트는 위에서 아래로 이어지는 하나의 시나리오다(가입 → 채점 → 이력 → 오답노트 → 오답 정리).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';

const require = createRequire(import.meta.url);
const ROUND_ID = '2026-2';
const ROUND = require(`../data/rounds/${ROUND_ID}.json`);
const TOTAL = ROUND.questions.length;

/** 문항의 sampleAnswer 를 채점 API 가 받는 문자열 배열로. */
function sampleAnswerOf(q) {
  return (q.fields || []).map((f) => (f.sampleAnswer == null ? '' : String(f.sampleAnswer)));
}

// ------------------------------------------------------------ 서버 + 쿠키

let srv = null;
let tmp = '';
let base = '';
const jar = new Map();

/** 쿠키 항아리를 물고 다니는 최소 API 클라이언트. */
async function api(method, p, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const resp = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of resp.headers.getSetCookie ? resp.headers.getSetCookie() : []) {
    const kv = line.split(';')[0];
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
  return { status: resp.status, json, text };
}

before(async () => {
  // PORT=0 → OS 가 비어 있는 포트를 고른다. 포트 추첨·충돌 없음 (서버 M-16).
  srv = await startServer({ prefix: 'jpk-practice-' });
  tmp = srv.tmp;
  base = srv.base;
});

after(async () => {
  // 자식이 정말 끝난 뒤에 임시 디렉터리를 지운다 — kill 만 하고 넘어가면 Windows 에서 EBUSY 가 난다.
  await srv.stop();
});

// --------------------------------------------------------------- 모의고사

describe('GET /api/practice', () => {
  test('rounds=all&count=10 — 여러 회차에서 10문항, 정답 계열 필드는 없다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=10');
    assert.equal(r.status, 200);
    assert.equal(r.json.setKey, 'practice');
    assert.equal(r.json.questions.length, 10);
    assert.ok(r.json.title.includes('10문항'), r.json.title);
    assert.ok(Array.isArray(r.json.roundIds) && r.json.roundIds.length > 1);

    // 전 회차 풀에서 뽑으므로 한 회차에서만 10문항이 나올 일은 사실상 없다
    const usedRounds = new Set(r.json.questions.map((q) => q.id.split('#')[0]));
    assert.ok(usedRounds.size >= 2, [...usedRounds].join(','));

    for (const q of r.json.questions) {
      // 공개 문항의 키 집합을 못박는다 — accept/sampleAnswer/validator/display/bodyText 유출 차단
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
      for (const f of q.fields) assert.deepEqual(Object.keys(f), ['label']);
    }
  });

  test('count 범위 밖 / 없는 회차는 400', async () => {
    assert.equal((await api('GET', '/api/practice?rounds=all&count=3')).status, 400);
    assert.equal((await api('GET', '/api/practice?rounds=all&count=61')).status, 400);
    assert.equal((await api('GET', '/api/practice?rounds=all&count=abc')).status, 400);

    const bad = await api('GET', '/api/practice?rounds=nope&count=10');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '없는 회차입니다: nope');
  });
});

// ------------------------------------------------- 채점은 로그인 필수 (보안 C-1)
//
// 채점 응답에는 정답 표기(display)와 해설이 들어 있다. 무인증으로 열려 있으면 문항 id 만 알면
// 정답을 받아낼 수 있는 오라클이 된다 — 대전 중인 문항까지 포함해서. 그래서 두 채점 경로는
// 로그인 필수이고, 채점 집합은 클라이언트가 아니라 **서버가 발급한 세트 토큰**이 정한다.

describe('채점 오라클 차단 — 비로그인', () => {
  test('두 채점 경로 모두 401 이고, 본문 검증보다 인증이 먼저다', async () => {
    assert.equal(jar.size, 0);

    const round = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { answers: {} });
    assert.equal(round.status, 401);
    assert.equal(round.json.error, '로그인이 필요합니다.');

    // setKey 가 엉망이어도 401 이다(인증이 먼저 걸린다 — 400 이면 라우트 순서가 뒤집힌 것)
    assert.equal((await api('POST', '/api/practice/grade', { setKey: 'nope' })).status, 401);
    assert.equal((await api('POST', '/api/rounds/없는회차/grade', { answers: {} })).status, 401);

    assert.equal((await api('GET', '/api/me/history')).status, 401);
    assert.equal((await api('GET', '/api/me/wrong')).status, 401);
  });

  test('비로그인 /api/practice 는 문항만 주고 세트 토큰은 주지 않는다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=5');
    assert.equal(r.status, 200);
    assert.equal(r.json.setToken, '');
  });

  test('가입 — 이 뒤로는 로그인 상태다', async () => {
    const up = await api('POST', '/api/auth/signup', { nickname: '이력테스터', password: 'pw1234567856' });
    assert.equal(up.status, 200, up.text);
    assert.ok(jar.size > 0);
  });
});

describe('POST /api/practice/grade — 채점 집합은 세트 토큰이 정한다', () => {
  let setToken = '';
  let setIds = [];

  test('로그인하면 /api/practice 가 세트 토큰을 준다', async () => {
    const r = await api('GET', `/api/practice?rounds=${ROUND_ID}&count=5`);
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.setToken, 'string');
    assert.ok(r.json.setToken.length > 0);
    setToken = r.json.setToken;
    setIds = r.json.questions.map((q) => q.id);
    assert.equal(setIds.length, 5);
  });

  test('토큰이 없거나 위조되면 400 — 채점도 해설도 없다', async () => {
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const id of setIds) answers[id] = sampleAnswerOf(byId.get(id));

    const noToken = await api('POST', '/api/practice/grade', { setKey: 'practice', answers });
    assert.equal(noToken.status, 400);
    assert.equal(noToken.json.error, '문제 세트 정보가 없거나 만료되었습니다. 문제를 다시 불러온 뒤 채점하세요.');
    assert.equal(noToken.json.details, undefined);
    assert.equal(noToken.json.explanations, undefined);

    const forged = setToken.slice(0, -1) + (setToken.slice(-1) === 'A' ? 'B' : 'A');
    const bad = await api('POST', '/api/practice/grade', { setKey: 'practice', setToken: forged, answers });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.details, undefined);
  });

  test('모르는 setKey 는 400 (토큰이 유효해도)', async () => {
    const r = await api('POST', '/api/practice/grade', { setKey: 'nope', setToken, answers: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '알 수 없는 문제 집합입니다.');
  });

  test('토큰이 정한 세트가 분모다 — 만점 + bodyTexts 동봉', async () => {
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const id of setIds) answers[id] = sampleAnswerOf(byId.get(id));

    const r = await api('POST', '/api/practice/grade', { setKey: 'practice', setToken, answers });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.round, 'practice');
    assert.equal(r.json.correctCount, 5);
    assert.equal(r.json.totalCount, 5);
    assert.equal(r.json.score, 100);
    assert.equal(r.json.details.length, 5);
    // 채점 후에는 지문 원문을 내보낸다 (AI 질문 프롬프트 조립용)
    for (const id of setIds) assert.ok(r.json.bodyTexts[id].length > 0, id);
  });

  test('토큰 밖 문항은 답안을 끼워 넣어도 채점되지 않는다 (오라클 차단)', async () => {
    const outsider = ROUND.questions.find((q) => !setIds.includes(q.id));
    assert.ok(outsider, '세트 밖 문항이 있어야 한다');

    const answers = { [outsider.id]: sampleAnswerOf(outsider) };
    const r = await api('POST', '/api/practice/grade', { setKey: 'practice', setToken, answers });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.totalCount, 5, '분모는 토큰의 세트다');
    assert.ok(!r.json.details.some((d) => d.questionId === outsider.id));
    assert.equal(r.json.bodyTexts[outsider.id], undefined);
    assert.equal(r.json.explanations[outsider.id], undefined);
    // 끼워 넣은 답안은 버려졌으므로 그 문항의 정답 표기(display)도 새어 나가지 않는다
    if (typeof outsider.display === 'string' && outsider.display !== '') {
      assert.ok(!JSON.stringify(r.json).includes(outsider.display), outsider.display);
    }
  });
});

// ------------------------------------------------------- 이력 · 오답노트

describe('학습 이력 · 오답노트', () => {
  test('1문항만 맞혀 채점 → 이력에 집계된다', async () => {
    const first = ROUND.questions[0];
    const graded = await api('POST', `/api/rounds/${ROUND_ID}/grade`, {
      answers: { [first.id]: sampleAnswerOf(first) }, // 나머지 문항은 무응답 = 오답
    });
    assert.equal(graded.status, 200);
    assert.equal(graded.json.correctCount, 1);
    assert.equal(graded.json.totalCount, TOTAL);

    const h = await api('GET', '/api/me/history');
    assert.equal(h.status, 200);
    assert.equal(h.json.rounds[ROUND_ID].count, 1);
    assert.equal(h.json.rounds[ROUND_ID].best, graded.json.score);
    assert.equal(h.json.rounds[ROUND_ID].last, graded.json.score);
    assert.ok(h.json.rounds[ROUND_ID].lastAt);
    assert.equal(h.json.recent[0].round, ROUND_ID);
    assert.equal(h.json.recent[0].total, TOTAL);
    assert.equal(h.json.recent[0].correct, 1);
    assert.equal(h.json.wrongCount, TOTAL - 1);
    // 스캔 상한에 닿지 않았으므로 집계는 잘리지 않았다 (서버 M-10)
    assert.equal(h.json.truncated, false);
  });

  test('오답노트는 틀린 문항만 담고, 다시 맞히면 빠진다', async () => {
    const w = await api('GET', '/api/me/wrong');
    assert.equal(w.status, 200);
    assert.equal(w.json.setKey, 'wrong');
    assert.equal(w.json.title, '오답노트');
    assert.equal(w.json.questions.length, TOTAL - 1);
    assert.ok(!w.json.questions.some((q) => q.id === ROUND.questions[0].id)); // 맞힌 문항은 빠진다
    assert.ok(typeof w.json.setToken === 'string' && w.json.setToken.length > 0, '오답 세트에도 토큰이 붙는다');
    for (const q of w.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    }

    // 오답노트를 전부 맞히면 비워진다
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const q of w.json.questions) answers[q.id] = sampleAnswerOf(byId.get(q.id));
    const g = await api('POST', '/api/practice/grade', { setKey: 'wrong', setToken: w.json.setToken, answers });
    assert.equal(g.status, 200);
    assert.equal(g.json.round, 'wrong');
    assert.equal(g.json.totalCount, TOTAL - 1);
    assert.equal(g.json.score, 100);

    const after = await api('GET', '/api/me/wrong');
    assert.equal(after.json.questions.length, 0);

    const h = await api('GET', '/api/me/history');
    assert.equal(h.json.wrongCount, 0);
    assert.equal(h.json.rounds.wrong.count, 1);   // 'wrong' 도 하나의 집합으로 집계된다
    assert.equal(h.json.rounds.wrong.best, 100);
    assert.equal(h.json.recent[0].round, 'wrong'); // 최신 먼저
    assert.equal(h.json.recent[0].correct, TOTAL - 1);
  });
});

// -------------------------------------------------- 오답노트 허브 (회차별 / 대전별)
//
// 대전은 소켓 시나리오로만 생기므로(그건 scripts/e2e-battle.js 담당), 여기서는 서버가 쓰고 있는
// **같은 DB 파일**에 `db.saveMatch` 로 매치를 직접 적재해 시나리오를 만든다. sqlite 어댑터는 WAL 이라
// 다른 커넥션의 커밋을 서버가 바로 읽는다. json 어댑터로 폴백한 환경에서는 서버가 메모리 사본을 들고
// 있어 같은 방법을 쓸 수 없으므로(그쪽 계약은 tests/db-adapter.test.mjs 가 검증한다) 건너뛴다.

const WRONG_A = ROUND.questions[2]; // theory
const WRONG_B = ROUND.questions[1]; // code — 유형 필터 검증용
const BATTLE_QIDS = ROUND.questions.slice(0, 4).map((q) => q.id);
let battleMatchId = 0;
let foreignMatchId = 0;
let sqliteMode = false;

describe('오답노트 허브 — GET /api/me/wrong/summary · ?round= · ?match=', () => {
  before(() => {
    sqliteMode = fs.existsSync(path.join(tmp, 'app.db'));
    // better-sqlite3 는 package.json 의 정식 의존성이다. json 어댑터로 떨어졌다는 것은 네이티브
    // 모듈이 깨졌다는 뜻이고, 예전에는 그때 아래 5건이 **조용히 skip** 되어 오답노트 허브 계약이
    // 통째로 미검증인 채 초록불이 켜졌다(서버 M-16). 이제는 여기서 크게 실패한다.
    assert.ok(sqliteMode,
      'sqlite 어댑터로 뜨지 않았다 (json 폴백) — 오답노트 허브 시나리오를 검증할 수 없다. '
      + '`npm rebuild better-sqlite3` 로 네이티브 모듈을 복구하라.');
    const dbModule = require('../server/db.js');
    const d = dbModule.open({ dir: tmp, adapter: 'sqlite' });
    try {
      const me = d.findUserByNickname('이력테스터');
      const rival = d.createUser('대전상대', 'hash');
      const stranger = d.createUser('생판남', 'hash');
      // 내가 진 대전 — 4문항 중 2문항 오답
      battleMatchId = d.saveMatch({
        roomName: '오답노트 대전방', mode: 'round', roundIds: [ROUND_ID], questionIds: BATTLE_QIDS,
        timeLimitS: 600,
        startedAt: '2026-08-31T00:00:00.000Z',
        finishedAt: '2026-08-31T00:10:00.000Z',
        winnerUserId: rival.id,
      }, [
        { userId: me.id, correctCount: 2, score: 50, submittedAt: '2026-08-31T00:09:00.000Z', answers: {}, questionIds: BATTLE_QIDS, wrongIds: [WRONG_A.id, WRONG_B.id] },
        { userId: rival.id, correctCount: 4, score: 100, submittedAt: '2026-08-31T00:08:00.000Z', answers: {}, questionIds: BATTLE_QIDS, wrongIds: [] },
      ]);
      // 내가 끼지 않은 대전 — 남의 매치 id 로 조회하면 404 여야 한다
      foreignMatchId = d.saveMatch({
        roomName: '남의 대전방', mode: 'round', roundIds: [ROUND_ID], questionIds: BATTLE_QIDS,
        timeLimitS: 600,
        startedAt: '2026-08-31T01:00:00.000Z',
        finishedAt: '2026-08-31T01:10:00.000Z',
        winnerUserId: stranger.id,
      }, [
        { userId: rival.id, correctCount: 0, score: 0, submittedAt: null, answers: {}, questionIds: BATTLE_QIDS, wrongIds: BATTLE_QIDS },
        { userId: stranger.id, correctCount: 4, score: 100, submittedAt: null, answers: {}, questionIds: BATTLE_QIDS, wrongIds: [] },
      ]);
    } finally {
      d.close();
    }
  });

  test('summary — 회차별·대전별 집계가 서로 어긋나지 않는다', async () => {
    const s = await api('GET', '/api/me/wrong/summary');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.total, 2); // 앞 시나리오에서 오답 0 이 됐고, 대전에서 2문항이 새로 틀렸다

    assert.equal(s.json.byRound.length, 1);
    const r0 = s.json.byRound[0];
    assert.equal(r0.round, ROUND_ID);
    assert.equal(r0.count, 2);
    assert.equal(r0.counts.code + r0.counts.sql + r0.counts.theory, 2); // counts 합계 == count

    assert.equal(s.json.byBattle.length, 1); // 내가 참가한 대전만
    const b0 = s.json.byBattle[0];
    assert.equal(b0.matchId, battleMatchId);
    assert.equal(b0.roomName, '오답노트 대전방');
    assert.equal(b0.finishedAt, '2026-08-31T00:10:00.000Z');
    assert.equal(b0.mode, 'round');
    assert.deepEqual(b0.roundIds, [ROUND_ID]);
    assert.equal(b0.questionCount, 4);
    assert.equal(b0.result, 'lose');
    assert.deepEqual(b0.me, { correctCount: 2, score: 50 });
    assert.deepEqual(b0.opponents, [{ nickname: '대전상대', correctCount: 4 }]);
    assert.equal(b0.wrongCount, 2);
    assert.equal(b0.stillWrongCount, 2);
    assert.equal(b0.wrongQuestions.length, 2);
    for (const q of b0.wrongQuestions) {
      // 요약에도 정답 계열 필드는 없다 — 공개 필드 + 정오 이력뿐이다
      assert.deepEqual(Object.keys(q).sort(), ['id', 'lang', 'num', 'prompt', 'stillWrong', 'type']);
      assert.equal(q.stillWrong, true);
    }
  });

  test('?round= — 그 회차의 현재 오답만, 없는 회차는 400', async () => {
    const w = await api('GET', `/api/me/wrong?round=${ROUND_ID}`);
    assert.equal(w.status, 200);
    assert.equal(w.json.setKey, 'wrong');
    assert.equal(w.json.title, '오답노트 · 2026년 2회');
    assert.equal(w.json.round, ROUND_ID);
    assert.equal(w.json.questions.length, 2);
    for (const q of w.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    }

    // 유형 필터는 그 위에 겹쳐 걸린다
    const code = await api('GET', `/api/me/wrong?round=${ROUND_ID}&type=code`);
    assert.equal(code.status, 200);
    assert.deepEqual(code.json.questions.map((q) => q.id), [WRONG_B.id]);

    // 오답이 없는 회차는 빈 목록(200), 없는 회차 id 는 400
    const other = await api('GET', '/api/me/wrong?round=2020-1');
    assert.equal(other.status, 200);
    assert.equal(other.json.questions.length, 0);
    const bad = await api('GET', '/api/me/wrong?round=nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '없는 회차입니다: nope');
    assert.equal((await api('GET', `/api/me/wrong?round=${ROUND_ID}&type=nope`)).status, 400);
    assert.equal((await api('GET', `/api/me/wrong?round=${ROUND_ID}&match=${battleMatchId}`)).status, 400);
  });

  test('?match= — 그 대전에서 틀린 문항 전부, 남의 매치는 404', async () => {
    const w = await api('GET', `/api/me/wrong?match=${battleMatchId}`);
    assert.equal(w.status, 200, w.text);
    assert.equal(w.json.setKey, 'wrong');
    assert.equal(w.json.title, '오답노트 · 대전 오답노트 대전방');
    assert.equal(w.json.match, battleMatchId);
    assert.deepEqual(w.json.resolvedIds, []); // 아직 아무것도 다시 맞히지 않았다
    assert.deepEqual(w.json.questions.map((q) => q.id).sort(), [WRONG_A.id, WRONG_B.id].sort());
    assert.equal(w.json.battle.roomName, '오답노트 대전방');
    assert.equal(w.json.battle.result, 'lose');
    assert.deepEqual(w.json.battle.opponents, [{ nickname: '대전상대', correctCount: 4 }]);
    for (const q of w.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    }

    // 유형 필터
    const code = await api('GET', `/api/me/wrong?match=${battleMatchId}&type=code`);
    assert.deepEqual(code.json.questions.map((q) => q.id), [WRONG_B.id]);

    // 남의 매치 / 없는 매치는 404, 정수가 아닌 값은 400
    const foreign = await api('GET', `/api/me/wrong?match=${foreignMatchId}`);
    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(foreign.json.error, '없는 대전입니다.');
    assert.equal((await api('GET', '/api/me/wrong?match=99999')).status, 404);
    assert.equal((await api('GET', '/api/me/wrong?match=abc')).status, 400);
    assert.equal((await api('GET', '/api/me/wrong?match=-1')).status, 400);
  });

  test('history recent 의 대전 행에는 matchId·roomName 이 실린다', async () => {
    const h = await api('GET', '/api/me/history');
    assert.equal(h.status, 200);
    assert.equal(h.json.wrongCount, 2);
    assert.equal(h.json.rounds.battle.count, 1);
    const row = h.json.recent.find((r) => r.round === 'battle');
    assert.ok(row, JSON.stringify(h.json.recent));
    assert.equal(row.matchId, battleMatchId);
    assert.equal(row.roomName, '오답노트 대전방');
    assert.equal(row.total, 4);
    assert.equal(row.correct, 2);
    // 대전이 아닌 행에는 붙지 않는다
    assert.ok(h.json.recent.filter((r) => r.round !== 'battle').every((r) => r.matchId === undefined));
  });

  test('다시 맞히면 ?match= 에는 남고 resolvedIds·stillWrong 으로만 표시된다', async () => {
    // 지금 오답 세트(WRONG_A·WRONG_B)를 받아 그중 하나만 맞힌다 — 채점 집합은 토큰이 정한다
    const set = await api('GET', '/api/me/wrong');
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.questions.length, 2);

    const g = await api('POST', '/api/practice/grade', {
      setKey: 'wrong',
      setToken: set.json.setToken,
      answers: { [WRONG_A.id]: sampleAnswerOf(WRONG_A) }, // WRONG_B 는 무응답 = 그대로 오답
    });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.correctCount, 1);
    assert.equal(g.json.totalCount, 2);

    // 대전 오답노트는 **과거 스냅샷** — 문항은 그대로 2개고, 맞힌 문항만 resolvedIds 로 나온다
    const w = await api('GET', `/api/me/wrong?match=${battleMatchId}`);
    assert.equal(w.json.questions.length, 2);
    assert.deepEqual(w.json.resolvedIds, [WRONG_A.id]);

    // 회차별은 **현재 상태** — 맞힌 문항이 빠진다
    const byRound = await api('GET', `/api/me/wrong?round=${ROUND_ID}`);
    assert.deepEqual(byRound.json.questions.map((q) => q.id), [WRONG_B.id]);

    const s = await api('GET', '/api/me/wrong/summary');
    assert.equal(s.json.total, 1);
    assert.equal(s.json.byRound[0].count, 1);
    const b0 = s.json.byBattle[0];
    assert.equal(b0.wrongCount, 2);       // 그 대전에서 틀린 수는 변하지 않는다
    assert.equal(b0.stillWrongCount, 1);  // 그중 지금도 오답인 수만 줄어든다
    assert.equal(b0.wrongQuestions.find((q) => q.id === WRONG_A.id).stillWrong, false);
    assert.equal(b0.wrongQuestions.find((q) => q.id === WRONG_B.id).stillWrong, true);
  });
});

// ------------------------------- 대전 잠금(409) · 레이트리밋(429)
//
// 둘 다 "누가 요청했는가" 에만 달려 있고 DB·소켓 상태가 필요 없다. 그래서 실서버 대신
// `routes/study.js` 를 가짜 ctx 로 직접 마운트한다 — 대전 한 판을 실제로 돌리지 않고도
// `ctx.battleIo.activeBattleQuestionIds` 계약이 지켜지는지 볼 수 있다.

describe('채점 방어벽 — 대전 잠금 · 레이트리밋', () => {
  const LOCK_USER = 42;
  const LOCKED = ROUND.questions.slice(0, 3).map((q) => q.id);
  const FREE = ROUND.questions.slice(10, 13).map((q) => q.id);

  let srv2 = null;
  let base2 = '';
  let settoken = null;

  before(async () => {
    const express = require('express');
    const roundsMod = require('../server/rounds.js');
    settoken = require('../server/settoken.js');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: LOCK_USER, nickname: '대전중' }; next(); });
    require('../server/routes/study.js')(app, {
      db: { saveStudyResult() { /* 이력은 이 테스트의 관심사가 아니다 */ } },
      rounds: roundsMod,
      auth: { requireAuth(_req, _res, next) { next(); } },
      battleIo: { activeBattleQuestionIds() { return new Set(LOCKED); } },
      log() {}, logErr() {},
    });

    srv2 = app.listen(0);
    await new Promise((res) => srv2.once('listening', res));
    base2 = 'http://localhost:' + srv2.address().port;
  });

  after(() => { try { srv2.close(); } catch { /* 이미 닫힘 */ } });

  async function grade(body) {
    const r = await fetch(base2 + '/api/practice/grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아닐 수 있다 */ }
    return { status: r.status, json, text };
  }

  test('진행 중인 대전의 문항이 섞여 있으면 409 — 정답도 해설도 나가지 않는다', async () => {
    const token = settoken.signSet(LOCK_USER, [FREE[0], LOCKED[0]]);
    const r = await grade({ setKey: 'practice', setToken: token, answers: {} });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error, '진행 중인 대전의 문항은 채점할 수 없습니다.');
    assert.equal(r.json.details, undefined);
    assert.equal(r.json.explanations, undefined);
  });

  test('대전과 겹치지 않는 세트는 그대로 채점된다', async () => {
    const r = await grade({ setKey: 'practice', setToken: settoken.signSet(LOCK_USER, FREE), answers: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.totalCount, FREE.length);
  });

  test('사용자당 분당 20회를 넘기면 429', async () => {
    const token = settoken.signSet(LOCK_USER, FREE);
    const seen = [];
    // 앞선 두 테스트가 이미 2회를 썼다 — 상한(20)을 확실히 넘기도록 넉넉히 두드린다.
    for (let i = 0; i < 25; i++) seen.push((await grade({ setKey: 'practice', setToken: token, answers: {} })).status);
    assert.ok(seen.includes(429), seen.join(','));
    assert.equal(seen[seen.length - 1], 429, '한 번 걸리면 창이 끝날 때까지 계속 막힌다');
    assert.ok(seen.filter((s) => s === 200).length <= 20, seen.join(','));
  });
});

// ------------------- 오답노트 해설 조회의 대전 잠금 (Phase 3 재검토)
//
// `GET /api/me/wrong/explain` 은 "이미 채점받은 문항이면 정답·해설을 다시 보여 줘도 새로 새는
// 정보가 없다" 는 전제로 채점 이력만 봤다. 그 전제는 **대전 중에는 성립하지 않는다** —
// 예전에 학습 모드로 채점해 둔 회차로 대전을 시작하면, 채점 라우트는 409 로 막는데
// 이 경로로는 같은 문항의 display 가 그대로 나왔다. 채점 라우트와 같은 잠금을 건다.

describe('GET /api/me/wrong/explain — 대전 중 문항은 해설도 막힌다', () => {
  const GRADED = ROUND.questions.slice(0, 4);          // 예전에 학습 모드로 채점해 둔 문항
  const LOCKED = GRADED.slice(0, 2);                   // 그중 지금 대전에 걸린 문항
  const OPEN = GRADED.slice(2);                        // 대전과 무관한 문항
  const USER = { id: 77, nickname: '대전중' };

  let srv3 = null;
  let base3 = '';
  let activeSet = null; // 이 값이 곧 battle-io 의 activeBattleQuestionIds 응답이다

  before(async () => {
    const express = require('express');
    const roundsMod = require('../server/rounds.js');
    const wrongnoteMod = require('../server/wrongnote.js');

    // 저장소만 가짜다 — 집계(gradedIdsOf 등)는 실제 wrongnote.js 를 그대로 태운다.
    const fakeDb = {
      listStudyResults() {
        return [{
          round: '2026-2',
          score: 20,
          taken_at: '2026-09-01T00:00:00.000Z',
          question_ids: JSON.stringify(GRADED.map((q) => q.id)),
          wrong_ids: JSON.stringify(GRADED.map((q) => q.id)),
          match_id: null,
        }];
      },
      listMatchesByUser() { return []; },
      bestScoresByRound() { return []; },
      listMatchNames() { return []; },
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    require('../server/routes/me.js')(app, {
      db: fakeDb,
      rounds: roundsMod,
      auth: { requireAuth(_req, _res, next) { next(); } },
      wrongnote: wrongnoteMod.create({ db: fakeDb, logErr() {} }),
      battleIo: { activeBattleQuestionIds() { return activeSet; } },
      log() {}, logErr() {},
    });

    srv3 = app.listen(0);
    await new Promise((res) => srv3.once('listening', res));
    base3 = 'http://localhost:' + srv3.address().port;
  });

  after(() => { try { srv3.close(); } catch { /* 이미 닫힘 */ } });

  async function explain(ids) {
    const r = await fetch(base3 + '/api/me/wrong/explain?ids=' + encodeURIComponent(ids.join(',')));
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아닐 수 있다 */ }
    return { status: r.status, json, text };
  }

  test('대전이 없으면 채점 기록이 있는 문항 전부에 display + 해설이 나온다 (전제 확인)', async () => {
    activeSet = null;
    const r = await explain(GRADED.map((q) => q.id));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.explanations).sort(), GRADED.map((q) => q.id).sort());
    for (const q of GRADED) assert.equal(r.json.explanations[q.id].display, q.display);
  });

  test('대전 중이면 그 문항만 조용히 빠진다 — display 가 본문 어디에도 없다', async () => {
    activeSet = new Set(LOCKED.map((q) => q.id));
    const r = await explain(GRADED.map((q) => q.id));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.explanations).sort(), OPEN.map((q) => q.id).sort());
    for (const q of LOCKED) {
      assert.equal(r.json.explanations[q.id], undefined, q.id);
      assert.ok(!r.text.includes(q.display), q.id + ' 의 display 가 새고 있다: ' + q.display);
    }
    // 대전과 무관한 문항은 그대로 나온다 — 잠금이 오답노트 전체를 죽이지 않는다
    for (const q of OPEN) assert.equal(r.json.explanations[q.id].display, q.display);
  });

  test('전부 대전 중이면 빈 맵이다 (403·409 가 아니라 조용한 생략)', async () => {
    activeSet = new Set(GRADED.map((q) => q.id));
    const r = await explain(GRADED.map((q) => q.id));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.explanations, {});
    for (const q of GRADED) assert.ok(!r.text.includes(q.display), q.id);
  });

  test('대전이 끝나면 다시 나온다 (제출·종료 뒤 activeBattleQuestionIds 가 비는 경우)', async () => {
    activeSet = new Set();
    const r = await explain(GRADED.map((q) => q.id));
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.json.explanations).sort(), GRADED.map((q) => q.id).sort());
  });

  test('battle-io 가 던져도 조회는 살아 있다 (잠금은 부가 방어벽이다)', async () => {
    activeSet = null;
    const boom = { activeBattleQuestionIds() { throw new Error('battle-io 고장'); } };
    const express = require('express');
    const roundsMod = require('../server/rounds.js');
    const wrongnoteMod = require('../server/wrongnote.js');
    const fakeDb = {
      listStudyResults() {
        return [{
          round: '2026-2', score: 20, taken_at: '2026-09-01T00:00:00.000Z',
          question_ids: JSON.stringify(GRADED.map((q) => q.id)),
          wrong_ids: JSON.stringify(GRADED.map((q) => q.id)),
          match_id: null,
        }];
      },
      listMatchesByUser() { return []; },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = USER; next(); });
    require('../server/routes/me.js')(app, {
      db: fakeDb,
      rounds: roundsMod,
      auth: { requireAuth(_req, _res, next) { next(); } },
      wrongnote: wrongnoteMod.create({ db: fakeDb, logErr() {} }),
      battleIo: boom,
      log() {}, logErr() {},
    });
    const s = app.listen(0);
    await new Promise((res) => s.once('listening', res));
    try {
      const r = await fetch('http://localhost:' + s.address().port
        + '/api/me/wrong/explain?ids=' + encodeURIComponent(GRADED[0].id));
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.explanations[GRADED[0].id]);
    } finally {
      s.close();
    }
  });
});
