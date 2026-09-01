// practice-api.test.mjs — 학습 이력 · 오답노트 · 랜덤 모의고사 REST 종단 검증.
//
// 실서버를 임의 포트 + 격리된 임시 DATA_DIR 로 띄우고 fetch 로 두드린다(실제 data/ 는 건드리지 않는다).
// 회차 JSON 은 항상 repo 의 data/rounds 를 읽으므로 sampleAnswer 를 그대로 정답으로 쓸 수 있다.
// 테스트는 위에서 아래로 이어지는 하나의 시나리오다(가입 → 채점 → 이력 → 오답노트 → 오답 정리).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-practice-'));
  const port = 3000 + Math.floor(Math.random() * 20000);
  base = 'http://localhost:' + port;
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  await new Promise((res, rej) => {
    const iv = setInterval(() => {
      if (out.includes('종료: Ctrl+C')) { clearInterval(iv); clearTimeout(to); res(); }
      else if (/EADDRINUSE/.test(out)) { clearInterval(iv); clearTimeout(to); rej(new Error('server: ' + out)); }
    }, 100);
    const to = setTimeout(() => { clearInterval(iv); rej(new Error('server start timeout\n' + out)); }, 20000);
  });
});

after(() => {
  try { srv.kill(); } catch { /* 이미 종료 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
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

describe('POST /api/practice/grade', () => {
  test('정답 2문항이면 100점 + bodyTexts 동봉', async () => {
    const [a, b] = ROUND.questions;
    const r = await api('POST', '/api/practice/grade', {
      setKey: 'practice',
      answers: { [a.id]: sampleAnswerOf(a), [b.id]: sampleAnswerOf(b) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.round, 'practice');
    assert.equal(r.json.correctCount, 2);
    assert.equal(r.json.totalCount, 2);
    assert.equal(r.json.score, 100);
    assert.equal(r.json.details.length, 2);
    // 채점 후에는 지문 원문을 내보낸다 (AI 질문 프롬프트 조립용)
    assert.ok(r.json.bodyTexts[a.id].length > 0);
    assert.ok(r.json.bodyTexts[b.id].length > 0);
  });

  test('모르는 setKey / 실존 문항 0개는 400', async () => {
    const badKey = await api('POST', '/api/practice/grade', { setKey: 'nope', answers: {} });
    assert.equal(badKey.status, 400);

    const empty = await api('POST', '/api/practice/grade', {
      setKey: 'practice', answers: { '없는문항#9': ['x'] },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, '채점할 문항이 없습니다.');
  });
});

// ------------------------------------------------------- 이력 · 오답노트

describe('학습 이력 · 오답노트', () => {
  test('비로그인 /api/me/history 는 401', async () => {
    assert.equal(jar.size, 0);
    const r = await api('GET', '/api/me/history');
    assert.equal(r.status, 401);
    assert.equal((await api('GET', '/api/me/wrong')).status, 401);
  });

  test('가입 → 1문항만 맞혀 채점 → 이력에 집계된다', async () => {
    const up = await api('POST', '/api/auth/signup', { nickname: '이력테스터', password: 'pw1234' });
    assert.equal(up.status, 200, up.text);

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
  });

  test('오답노트는 틀린 문항만 담고, 다시 맞히면 빠진다', async () => {
    const w = await api('GET', '/api/me/wrong');
    assert.equal(w.status, 200);
    assert.equal(w.json.setKey, 'wrong');
    assert.equal(w.json.title, '오답노트');
    assert.equal(w.json.questions.length, TOTAL - 1);
    assert.ok(!w.json.questions.some((q) => q.id === ROUND.questions[0].id)); // 맞힌 문항은 빠진다
    for (const q of w.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    }

    // 오답노트를 전부 맞히면 비워진다
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const q of w.json.questions) answers[q.id] = sampleAnswerOf(byId.get(q.id));
    const g = await api('POST', '/api/practice/grade', { setKey: 'wrong', answers });
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
    if (!sqliteMode) return;
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

  test('summary — 회차별·대전별 집계가 서로 어긋나지 않는다', async (t) => {
    if (!sqliteMode) return t.skip('json 어댑터 폴백 환경 — 대전 적재 시나리오를 쓸 수 없다');
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

  test('?round= — 그 회차의 현재 오답만, 없는 회차는 400', async (t) => {
    if (!sqliteMode) return t.skip('json 어댑터 폴백 환경 — 대전 적재 시나리오를 쓸 수 없다');
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

  test('?match= — 그 대전에서 틀린 문항 전부, 남의 매치는 404', async (t) => {
    if (!sqliteMode) return t.skip('json 어댑터 폴백 환경 — 대전 적재 시나리오를 쓸 수 없다');
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

  test('history recent 의 대전 행에는 matchId·roomName 이 실린다', async (t) => {
    if (!sqliteMode) return t.skip('json 어댑터 폴백 환경 — 대전 적재 시나리오를 쓸 수 없다');
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

  test('다시 맞히면 ?match= 에는 남고 resolvedIds·stillWrong 으로만 표시된다', async (t) => {
    if (!sqliteMode) return t.skip('json 어댑터 폴백 환경 — 대전 적재 시나리오를 쓸 수 없다');
    const g = await api('POST', '/api/practice/grade', {
      setKey: 'wrong', answers: { [WRONG_A.id]: sampleAnswerOf(WRONG_A) },
    });
    assert.equal(g.status, 200);
    assert.equal(g.json.correctCount, 1);

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
