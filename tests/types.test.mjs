// types.test.mjs — 문항 유형(code/sql/theory) 분류·필터·공개 계약 검증.
//
// 두 층으로 나뉜다.
//   ① 순수 단위 — rounds.js / battle.js / validate-types.mjs 를 직접 부른다.
//   ② 종단(REST) — 실서버를 임의 포트 + 격리 임시 DATA_DIR 로 띄우고 fetch 로 두드린다
//      (practice-api.test.mjs 와 같은 방식. 실제 data/ 는 건드리지 않는다).
//
// **회차별 유형 개수를 못박지 않는다.** 분류 데이터는 계속 손질되므로 테스트는 언제나
// "서버가 말하는 개수"와 "필터 결과"의 **관계**만 검증한다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { isValidType, TYPES } from '../scripts/validate-types.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rounds = require(path.join(ROOT, 'server', 'rounds.js'));
const battle = require(path.join(ROOT, 'server', 'battle.js'));

const ROUND_ID = '2026-2';

/** 유형이 붙은 문항 한 개(실제 데이터와 무관하게 성립해야 한다). */
function question(id, num, type) {
  return {
    id: id,
    num: num,
    prompt: '문제 지문',
    bodyHtml: '<p>본문</p>',
    bodyText: '본문',
    answerMode: 'ordered',
    display: '결합도',
    type: type,
    fields: [{ label: '①', accept: ['결합도'], validator: 'exact', sampleAnswer: '결합도' }],
    explanationHtml: '<p>정답은 <mark>결합도</mark>입니다.</p>',
  };
}

// ------------------------------------------------------------ ① 순수 단위

describe('유형 값 계약 — code | sql | theory 셋뿐', () => {
  test('validate-types 와 server/rounds.js 가 같은 집합을 쓴다', () => {
    assert.deepEqual([...TYPES].sort(), ['code', 'sql', 'theory']);
    assert.deepEqual([...rounds.TYPES].sort(), ['code', 'sql', 'theory']);
    assert.deepEqual([...battle.TYPES].sort(), ['code', 'sql', 'theory']);
    assert.equal(rounds.DEFAULT_TYPE, 'theory');
  });

  test('린터의 값 판정 — 대소문자·공백·비문자열은 실패', () => {
    for (const v of ['code', 'sql', 'theory']) assert.equal(isValidType(v), true, v);
    for (const v of ['CODE', 'Sql', ' code', 'code ', '', 'all', null, undefined, 1, ['code']]) {
      assert.equal(isValidType(v), false, JSON.stringify(v));
    }
  });

  test('rounds.isType / battle.normalizeType 이 같은 판정을 낸다', () => {
    for (const v of ['code', 'sql', 'theory']) {
      assert.equal(rounds.isType(v), true, v);
      assert.equal(battle.normalizeType(v), v, v);
    }
    for (const v of ['CODE', '', 'all', null, undefined, 7]) {
      assert.equal(rounds.isType(v), false, JSON.stringify(v));
      assert.equal(battle.normalizeType(v), null, JSON.stringify(v));
    }
  });

  test('typeOf 는 분류가 없거나 깨졌으면 theory 로 떨어진다', () => {
    assert.equal(rounds.typeOf({ id: 'x', type: 'sql' }), 'sql');
    assert.equal(rounds.typeOf({ id: 'x' }), 'theory');
    assert.equal(rounds.typeOf({ id: 'x', type: 'CODE' }), 'theory');
    assert.equal(rounds.typeOf(null), 'theory');
  });
});

describe('publicQuestion — type 은 나가고 정답 계열은 막힌다', () => {
  test('rounds.publicQuestion 화이트리스트에 type 이 있다', () => {
    const pub = rounds.publicQuestion(question('2026-2#1', 1, 'code'));
    assert.deepEqual(Object.keys(pub).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt', 'type']);
    assert.equal(pub.type, 'code');
    // type 이 늘어나도 정답 계열은 여전히 구조적으로 빠진다
    assert.equal(JSON.stringify(pub).includes('결합도'), false);
    assert.deepEqual(Object.keys(pub.fields[0]), ['label']);
  });

  test('battle.publicQuestion 화이트리스트에도 type 이 있다', () => {
    const pub = battle.publicQuestion(question('2026-2#1', 1, 'sql'));
    assert.deepEqual(
      Object.keys(pub).sort(),
      ['answerMode', 'bodyHtml', 'bodyText', 'fields', 'id', 'num', 'prompt', 'type']
    );
    assert.equal(pub.type, 'sql');
    assert.equal('explanationHtml' in pub, false);
    assert.equal('accept' in pub, false);
    assert.equal('sampleAnswer' in pub, false);
  });

  test('분류가 없는 문항도 공개 사본에는 theory 로 실린다', () => {
    const bare = { id: 'x#1', num: 1, prompt: 'p', bodyHtml: '', fields: [] };
    assert.equal(rounds.publicQuestion(bare).type, 'theory');
    assert.equal(battle.publicQuestion(bare).type, 'theory');
  });

  test('실제 로드된 전 문항의 type 이 유효 값이다', () => {
    let n = 0;
    for (const meta of rounds.listRounds()) {
      for (const q of rounds.getRound(meta.round).questions) {
        assert.equal(isValidType(rounds.publicQuestion(q).type), true, q.id);
        n++;
      }
    }
    assert.ok(n > 0, '문항이 하나도 로드되지 않았다');
  });
});

describe('countTypes / filterByType / questionsOfType', () => {
  const qs = [
    question('r#1', 1, 'code'),
    question('r#2', 2, 'sql'),
    question('r#3', 3, 'theory'),
    question('r#4', 4, 'code'),
    { id: 'r#5', num: 5, fields: [] }, // 미분류 → theory
  ];

  test('countTypes 합계는 언제나 문항 수와 같다', () => {
    const c = rounds.countTypes(qs);
    assert.deepEqual(c, { code: 2, sql: 1, theory: 2 });
    assert.equal(c.code + c.sql + c.theory, qs.length);
    assert.deepEqual(rounds.countTypes([]), { code: 0, sql: 0, theory: 0 });
  });

  test('filterByType 은 요청한 유형만 돌려준다', () => {
    assert.deepEqual(rounds.filterByType(qs, 'code').map((q) => q.id), ['r#1', 'r#4']);
    assert.deepEqual(rounds.filterByType(qs, 'sql').map((q) => q.id), ['r#2']);
    assert.deepEqual(rounds.filterByType(qs, 'theory').map((q) => q.id), ['r#3', 'r#5']);
  });

  test('유효하지 않은 유형·null 은 "전체"로 다룬다 (원본은 건드리지 않는다)', () => {
    for (const t of [null, undefined, '', 'all', 'CODE']) {
      const out = rounds.filterByType(qs, t);
      assert.equal(out.length, qs.length, JSON.stringify(t));
      assert.notEqual(out, qs, '사본이어야 한다');
    }
  });

  test('questionsOfType 은 회차 id 로도, 회차 객체로도 동작한다', () => {
    const round = rounds.getRound(ROUND_ID);
    assert.ok(round, `data/rounds/${ROUND_ID}.json 이 로드되어야 한다`);
    for (const t of TYPES) {
      const byId = rounds.questionsOfType(ROUND_ID, t);
      const byObj = rounds.questionsOfType(round, t);
      assert.deepEqual(byId.map((q) => q.id), byObj.map((q) => q.id), t);
      for (const q of byId) assert.equal(rounds.typeOf(q), t, q.id);
    }
    // 유형별 개수의 합 = 회차 전체 문항 수
    const sum = TYPES.reduce((a, t) => a + rounds.questionsOfType(ROUND_ID, t).length, 0);
    assert.equal(sum, round.questions.length);
    assert.deepEqual(rounds.questionsOfType('없는회차', 'code'), []);
  });

  test('listRounds 의 counts 합계가 questionCount 와 일치한다', () => {
    const list = rounds.listRounds();
    assert.ok(list.length > 0);
    for (const r of list) {
      assert.deepEqual(Object.keys(r.counts).sort(), ['code', 'sql', 'theory'], r.round);
      assert.equal(r.counts.code + r.counts.sql + r.counts.theory, r.questionCount, r.round);
    }
  });
});

describe('buildQuestionSet — 유형으로 좁힌 풀에서 출제한다', () => {
  test('좁힌 풀에서만 뽑는다 (round 모드)', () => {
    const round = rounds.getRound(ROUND_ID);
    const pool = rounds.filterByType(round.questions, 'code');
    const built = battle.buildQuestionSet({
      mode: 'round',
      rounds: [{ round: ROUND_ID, questions: pool }],
    });
    assert.equal(built.ok, true, built.error);
    assert.equal(built.questions.length, pool.length);
    for (const q of built.questions) assert.equal(rounds.typeOf(q), 'code', q.id);
  });

  test('random 모드도 좁힌 풀을 넘지 않는다', () => {
    const round = rounds.getRound(ROUND_ID);
    const pool = rounds.filterByType(round.questions, 'code');
    assert.ok(pool.length >= 2, `${ROUND_ID} 에 code 문항이 2개 이상이어야 한다 (${pool.length})`);
    const built = battle.buildQuestionSet({
      mode: 'random',
      rounds: [{ round: ROUND_ID, questions: pool }],
      questionCount: 2,
      rng: () => 0,
    });
    assert.equal(built.ok, true, built.error);
    assert.equal(built.questions.length, 2);
    for (const q of built.questions) assert.equal(rounds.typeOf(q), 'code', q.id);
  });

  test('풀이 요청 수보다 적으면 한국어 사유와 함께 실패한다', () => {
    const built = battle.buildQuestionSet({
      mode: 'random',
      rounds: [{ round: ROUND_ID, questions: [] }],
      questionCount: 5,
    });
    assert.equal(built.ok, false);
    assert.ok(/유효 문항 총합/.test(built.error), built.error);
  });
});

describe('createRoom / settingsPayload — 유형은 방 설정으로 보존된다', () => {
  function room(type) {
    return battle.createRoom({
      roomId: 'AAAAAA',
      name: 'T',
      hostUserId: 1,
      mode: 'round',
      roundIds: [ROUND_ID],
      type: type,
      timeLimitS: 600,
      questions: [question('r#1', 1, 'code')],
      at: 1000,
    }).state;
  }

  test('허용 값은 그대로, 그 밖의 값은 null(전체) 로 정규화된다', () => {
    assert.equal(room('code').type, 'code');
    assert.equal(room('sql').type, 'sql');
    assert.equal(room(undefined).type, null);
    assert.equal(room('CODE').type, null);
    assert.equal(room('all').type, null);
  });

  test('room:state settings 에 type 이 실린다', () => {
    const payload = battle.roomStatePayload(room('code'));
    assert.equal(payload.settings.type, 'code');
    assert.equal(battle.roomStatePayload(room(null)).settings.type, null);
  });

  test('이벤트를 거쳐도(state 복제) type 이 살아남는다', () => {
    const s0 = room('sql');
    const s1 = battle.applyEvent(s0, { type: 'join', userId: 1, nickname: 'A', at: 1100 }).state;
    assert.equal(s1.type, 'sql');
    assert.equal(battle.roomStatePayload(s1).settings.type, 'sql');
    // resync 페이로드에도 같은 settings 가 실린다
    const rs = battle.resyncPayload(s1, s1.players[1], 1200);
    assert.equal(rs.settings.type, 'sql');
  });
});

// ------------------------------------------------------------- ② 종단 REST

let srv = null;
let tmp = '';
let base = '';

async function api(method, p, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  const resp = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아닐 수 있다 */ }
  return { status: resp.status, json, text };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-types-'));
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

describe('GET /api/rounds — 회차마다 counts 가 실린다', () => {
  test('counts 합계 == questionCount (전 회차)', async () => {
    const r = await api('GET', '/api/rounds');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) && r.json.length > 0);
    for (const row of r.json) {
      assert.deepEqual(Object.keys(row.counts).sort(), ['code', 'sql', 'theory'], row.round);
      assert.equal(row.counts.code + row.counts.sql + row.counts.theory, row.questionCount, row.round);
    }
    const target = r.json.find((x) => x.round === ROUND_ID);
    assert.ok(target, `${ROUND_ID} 가 목록에 있어야 한다`);
    assert.equal(target.questionCount, 20, '회차는 20문항이다');
    assert.equal(target.counts.code + target.counts.sql + target.counts.theory, 20);
  });
});

describe('GET /api/rounds/:id?type=', () => {
  test('type 미지정은 전 문항, 각 문항에 type 이 붙는다', async () => {
    const r = await api('GET', `/api/rounds/${ROUND_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.type, null);
    assert.equal(r.json.questions.length, 20);
    for (const q of r.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt', 'type']);
      assert.equal(isValidType(q.type), true, q.id);
    }
  });

  test('type=code 는 code 문항만 — 개수는 /api/rounds 의 counts 와 일치한다', async () => {
    const list = await api('GET', '/api/rounds');
    const counts = list.json.find((x) => x.round === ROUND_ID).counts;

    const r = await api('GET', `/api/rounds/${ROUND_ID}?type=code`);
    assert.equal(r.status, 200);
    assert.equal(r.json.type, 'code');
    assert.equal(r.json.questions.length, counts.code);
    assert.ok(r.json.questions.length > 0 && r.json.questions.length < 20);
    for (const q of r.json.questions) assert.equal(q.type, 'code', q.id);
  });

  test('type=all / 빈 값 / 공백뿐인 값은 전체와 같다', async () => {
    // 값은 trim 후에 판정한다 (count·rounds 파라미터와 같은 규칙).
    for (const q of ['?type=all', '?type=', '?type=%20', '?type=%20all%20']) {
      const r = await api('GET', `/api/rounds/${ROUND_ID}${q}`);
      assert.equal(r.status, 200, q);
      assert.equal(r.json.questions.length, 20, q);
      assert.equal(r.json.type, null, q);
    }
    // 유형 값 주위의 공백도 같은 규칙으로 흡수된다
    const padded = await api('GET', `/api/rounds/${ROUND_ID}?type=%20code%20`);
    assert.equal(padded.status, 200);
    assert.equal(padded.json.type, 'code');
  });

  test('없는 유형은 400, 없는 회차는 404', async () => {
    for (const v of ['nope', 'CODE', 'code,sql', 'theory;']) {
      const bad = await api('GET', `/api/rounds/${ROUND_ID}?type=${encodeURIComponent(v)}`);
      assert.equal(bad.status, 400, v);
      assert.equal(bad.json.error, '유형은 code/sql/theory 중 하나여야 합니다.', v);
    }
    assert.equal((await api('GET', '/api/rounds/nope?type=code')).status, 404);
  });

  test('그 유형의 문항이 0개인 회차는 400 (있으면 검증, 없으면 건너뜀)', async () => {
    const list = await api('GET', '/api/rounds');
    let checked = 0;
    for (const row of list.json) {
      for (const t of TYPES) {
        if (row.counts[t] !== 0) continue;
        const r = await api('GET', `/api/rounds/${row.round}?type=${t}`);
        assert.equal(r.status, 400, `${row.round}/${t}`);
        assert.equal(r.json.error, '해당 유형의 문항이 없습니다.');
        checked++;
      }
    }
    // 전 회차·전 유형이 1개 이상이면 검증할 대상이 없다 — 그 자체는 실패가 아니다.
    assert.ok(checked >= 0);
  });
});

describe('POST /api/rounds/:id/grade — type 은 채점 부분집합을 정한다', () => {
  test('type=code 면 totalCount 가 code 문항 수(20이 아니다)', async () => {
    const list = await api('GET', '/api/rounds');
    const counts = list.json.find((x) => x.round === ROUND_ID).counts;

    const r = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'code', answers: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.round, ROUND_ID, 'round 는 회차 id 그대로다');
    assert.equal(r.json.type, 'code');
    assert.equal(r.json.totalCount, counts.code);
    assert.notEqual(r.json.totalCount, 20);
    assert.equal(r.json.details.length, counts.code);

    // bodyTexts·explanations 맵도 부분집합을 덮는다 (오답노트·해설 표시가 어긋나지 않도록)
    assert.equal(Object.keys(r.json.bodyTexts).length, counts.code);
    assert.equal(Object.keys(r.json.explanations).length, counts.code);

    const codeIds = new Set((await api('GET', `/api/rounds/${ROUND_ID}?type=code`)).json.questions.map((q) => q.id));
    for (const d of r.json.details) assert.ok(codeIds.has(d.questionId), d.questionId);
  });

  test('type 미지정이면 예전 그대로 전 문항 채점', async () => {
    const r = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { answers: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.type, null);
    assert.equal(r.json.totalCount, 20);
  });

  test('잘못된 type 은 400', async () => {
    const bad = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'nope', answers: {} });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '유형은 code/sql/theory 중 하나여야 합니다.');
  });
});

describe('GET /api/practice?type=', () => {
  test('type=sql 은 sql 문항만 돌려준다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=5&type=sql');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.type, 'sql');
    assert.equal(r.json.questions.length, 5);
    for (const q of r.json.questions) {
      assert.equal(q.type, 'sql', q.id);
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt', 'type']);
    }
  });

  test('type=code 도 마찬가지다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=10&type=code');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.questions.length, 10);
    for (const q of r.json.questions) assert.equal(q.type, 'code', q.id);
  });

  test('풀이 모자라면 한국어 사유와 함께 400', async () => {
    const list = await api('GET', '/api/rounds');
    const row = list.json.find((x) => x.round === ROUND_ID);
    // 한 회차의 sql 문항 수보다 많이 요청한다 (최소 요청 수 5 보다 크게 잡는다)
    const want = Math.max(5, row.counts.sql + 1);
    const r = await api('GET', `/api/practice?rounds=${ROUND_ID}&count=${want}&type=sql`);
    if (row.counts.sql < want) {
      assert.equal(r.status, 400, r.text);
      assert.ok(/유효 문항 총합/.test(r.json.error), r.json.error);
    } else {
      assert.equal(r.status, 200, r.text);
    }
  });

  test('잘못된 type 은 400', async () => {
    const bad = await api('GET', '/api/practice?rounds=all&count=10&type=nope');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '유형은 code/sql/theory 중 하나여야 합니다.');
  });
});

describe('GET /api/me/wrong?type= — 비로그인 401 은 그대로', () => {
  test('인증이 유형 검사보다 먼저다', async () => {
    assert.equal((await api('GET', '/api/me/wrong?type=code')).status, 401);
    assert.equal((await api('GET', '/api/me/wrong?type=nope')).status, 401);
  });
});

describe('POST /api/rooms?type — 로그인 전이라도 유형 검사는 인증 뒤다', () => {
  test('비로그인 방 생성은 401', async () => {
    const r = await api('POST', '/api/rooms', {
      name: 'x', mode: 'round', roundIds: [ROUND_ID], type: 'code', timeLimitS: 600,
    });
    assert.equal(r.status, 401);
  });
});
