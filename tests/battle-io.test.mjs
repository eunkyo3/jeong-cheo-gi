// battle-io.test.mjs — 대전 어댑터(server/battle-io.js) 단위 검증.
//
// 진짜 express·socket.io 를 띄우지 않는다. `attach(ctx)` 가 요구하는 표면(app.get/post,
// io.use/on/to, db, rounds, auth)만 흉내 낸 가짜를 넣고, 등록된 라우트 핸들러와 소켓 핸들러를
// **직접 호출**해 어댑터의 판단(레이트리밋·상한·디바운스 취소·창구 함수)만 본다.
// 상태 전이 자체는 순수 리듀서 쪽 tests/battle.test.mjs 가 본다.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const battleIo = require('../server/battle-io.js');

// ------------------------------------------------------------------ 픽스처

function makeQuestion(num) {
  return {
    id: '2026-2#' + num,
    num: num,
    round: '2026-2',
    prompt: '문항 ' + num,
    bodyHtml: '<p>본문</p>',
    bodyText: '본문',
    answerMode: 'ordered',
    display: '가',
    fields: [{ label: '답', accept: ['가'], normalize: 'default', sampleAnswer: '가' }],
  };
}

const QUESTIONS = [makeQuestion(1), makeQuestion(2)];

/**
 * attach(ctx) 가 보는 최소 표면. 반환값으로 라우트·소켓 핸들러를 되꺼낼 수 있다.
 * @param {{db?:object, auth?:object}} [over] 일부를 진짜 모듈로 갈아끼운다(핸드셰이크 테스트용).
 */
function harness(over) {
  const o = over || {};
  const routes = new Map();      // "METHOD /path" → [미들웨어…, 핸들러]
  const roomEmits = [];          // io.to(room).emit 으로 나간 것
  const logs = [];
  const debugLogs = [];
  let onConnection = null;

  const app = {
    get: function (path) { routes.set('GET ' + path, Array.prototype.slice.call(arguments, 1)); },
    post: function (path) { routes.set('POST ' + path, Array.prototype.slice.call(arguments, 1)); },
  };
  const middlewares = [];
  const io = {
    use: function (fn) { middlewares.push(fn); },
    on: function (name, fn) { if (name === 'connection') onConnection = fn; },
    to: function (room) {
      return { emit: function (event, payload) { roomEmits.push({ room: room, event: event, payload: payload }); } };
    },
  };
  const requireAuth = function requireAuth(req, res, next) { next(); };
  const ctx = {
    app: app,
    io: io,
    db: o.db || {
      findUserById: function (id) { return { id: id, nickname: 'U' + id }; },
      saveMatch: function () { return 1; },
    },
    rounds: {
      hasRound: function (id) { return id === '2026-2'; },
      getRound: function () { return { round: '2026-2', questions: QUESTIONS }; },
      filterByType: function (qs) { return qs; },
      filterByLang: function (qs) { return qs; },
      listRounds: function () { return [{ round: '2026-2' }]; },
    },
    auth: o.auth || {
      requireAuth: requireAuth,
      publicUser: function (r) { return r; },
      readSession: function () { return null; },
      userFromCookie: function () { return null; },
    },
    log: function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); },
    logErr: function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); },
    logDebug: function () { debugLogs.push(Array.prototype.slice.call(arguments).join(' ')); },
  };

  const api = battleIo.attach(ctx);

  /** 등록된 라우트를 미들웨어까지 순서대로 태워 호출한다. res 를 돌려준다. */
  function call(key, req) {
    const chain = routes.get(key);
    assert.ok(chain, '등록되지 않은 라우트: ' + key);
    const res = {
      code: 200,
      body: null,
      status: function (c) { this.code = c; return this; },
      json: function (o) { this.body = o; return this; },
    };
    let i = 0;
    function next() {
      const fn = chain[i++];
      if (fn) fn(req, res, next);
    }
    next();
    return res;
  }

  /** 방 하나를 만들고 roomId 를 돌려준다. */
  function createRoom(userId, name) {
    const res = call('POST /api/rooms', {
      user: { id: userId, nickname: 'U' + userId },
      body: { mode: 'round', roundIds: ['2026-2'], timeLimitS: 600, name: name },
    });
    assert.equal(res.code, 200, '방 생성 실패: ' + JSON.stringify(res.body));
    return res.body.roomId;
  }

  /** 소켓 하나를 붙여 connection 핸들러를 태운다. */
  function connect(userId) {
    const handlers = new Map();
    const sent = [];
    const socket = {
      id: 'sock' + userId,
      data: { user: { id: userId, nickname: 'U' + userId } },
      on: function (ev, fn) { handlers.set(ev, fn); },
      emit: function (ev, payload) { sent.push({ event: ev, payload: payload }); },
      join: function () {}, leave: function () {}, disconnect: function () {},
      fire: function (ev, payload) {
        const fn = handlers.get(ev);
        assert.ok(fn, '핸들러 없음: ' + ev);
        fn(payload);
      },
      sent: sent,
    };
    onConnection(socket);
    return socket;
  }

  /**
   * `io.use` 로 등록된 핸드셰이크 미들웨어를 쿠키 하나로 태운다.
   * @returns {{err:Error|null, user:object|null}} err 가 있으면 socket.io 가 연결을 거절한 것이다.
   */
  function handshake(cookieHeader) {
    assert.equal(middlewares.length, 1, 'io.use 미들웨어가 1개여야 한다');
    const socket = { handshake: { headers: { cookie: cookieHeader } }, data: {} };
    let err = null;
    middlewares[0](socket, function (e) { err = e || null; });
    return { err: err, user: socket.data.user || null };
  }

  return {
    api: api, routes: routes, roomEmits: roomEmits, logs: logs, debugLogs: debugLogs,
    requireAuth: requireAuth, call: call, createRoom: createRoom, connect: connect,
    handshake: handshake,
  };
}

const now = () => Date.now();

/** 방을 playing 까지 몰고 간다. 참가자는 1·2번. */
function playingRoom(h) {
  const roomId = h.createRoom(1, '테스트방');
  h.api.dispatch(roomId, { type: 'join', userId: 1, nickname: 'U1', at: now() });
  h.api.dispatch(roomId, { type: 'join', userId: 2, nickname: 'U2', at: now() });
  h.api.dispatch(roomId, { type: 'start', userId: 1, at: now() });
  const s = h.api.dispatch(roomId, { type: 'timeout', kind: 'countdown', at: now() });
  assert.equal(s.state, 'playing');
  return roomId;
}

// ------------------------------------------------------------- 순수 함수부

describe('battle-io 순수 함수', () => {
  test('sanitizeRoomName 은 제어문자·폭 0·RTL override 를 제거한다 (보안 L-10·L-11)', () => {
    assert.equal(battleIo.sanitizeRoomName('  좋은 방  '), '좋은 방');
    // 입력에 BEL(U+0007)·ESC(U+001B)·DEL(U+007F) 을 섞었다 — 콘솔 로그 인젝션 벡터
    assert.equal(battleIo.sanitizeRoomName('방[31m'), '방[31m');
    // 입력에 ZWSP(U+200B)·RLO(U+202E)·BOM(U+FEFF) 을 섞었다 — 사칭·표시 뒤집기 벡터
    assert.equal(battleIo.sanitizeRoomName('가​나‮다﻿'), '가나다');
    // 전부 걷어내면 빈 문자열 → 호출부가 기본 이름으로 떨어뜨린다
    assert.equal(battleIo.sanitizeRoomName('​‮'), '');
    assert.equal(battleIo.sanitizeRoomName(null), '');
    assert.equal(battleIo.sanitizeRoomName(12), '12');
  });

  test('BATTLE_TIME_OVERRIDE_S 는 production 에서 무시된다 (서버 M-13)', () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOverride = process.env.BATTLE_TIME_OVERRIDE_S;
    try {
      process.env.BATTLE_TIME_OVERRIDE_S = '5';
      process.env.NODE_ENV = 'test';
      assert.equal(battleIo.timeOverrideS(), 5);
      process.env.NODE_ENV = 'production';
      assert.equal(battleIo.timeOverrideS(), null);
      process.env.NODE_ENV = 'test';
      process.env.BATTLE_TIME_OVERRIDE_S = '0';
      assert.equal(battleIo.timeOverrideS(), null); // 0 이하는 꺼진 것으로 본다
    } finally {
      if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv;
      if (prevOverride === undefined) delete process.env.BATTLE_TIME_OVERRIDE_S;
      else process.env.BATTLE_TIME_OVERRIDE_S = prevOverride;
    }
  });
});

// ----------------------------------------------------------------- 방 상한

describe('방 생성 상한 (보안 M-6)', () => {
  test('사용자당 MAX_ROOMS_PER_USER 개까지, 그다음은 429', () => {
    const h = harness();
    for (let i = 0; i < battleIo.MAX_ROOMS_PER_USER; i += 1) h.createRoom(1);
    const res = h.call('POST /api/rooms', {
      user: { id: 1, nickname: 'U1' },
      body: { mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 },
    });
    assert.equal(res.code, 429);
    assert.match(res.body.error, /3개/);
    // 다른 사용자는 영향을 받지 않는다
    assert.equal(typeof h.createRoom(2), 'string');
  });

  test('전체 방이 MAX_ROOMS_TOTAL 이면 503', () => {
    const h = harness();
    let made = 0;
    for (let user = 1; made < battleIo.MAX_ROOMS_TOTAL; user += 1) {
      for (let k = 0; k < battleIo.MAX_ROOMS_PER_USER && made < battleIo.MAX_ROOMS_TOTAL; k += 1) {
        h.createRoom(user);
        made += 1;
      }
    }
    assert.equal(h.api.roomCount(), battleIo.MAX_ROOMS_TOTAL);
    const res = h.call('POST /api/rooms', {
      user: { id: 9999, nickname: 'U9999' },
      body: { mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 },
    });
    assert.equal(res.code, 503);
  });

  test('방 이름의 제어문자는 저장 전에 제거된다', () => {
    const h = harness();
    const roomId = h.createRoom(1, '나쁜[31m방​');
    assert.equal(h.api.rooms.get(roomId).name, '나쁜[31m방');
  });

  test('이름이 전부 걸러지면 "<닉네임>의 방" 으로 떨어진다', () => {
    const h = harness();
    const roomId = h.createRoom(7, '​‮');
    assert.equal(h.api.rooms.get(roomId).name, 'U7의 방');
  });
});

// --------------------------------------------------------------- 소켓 위생

describe('battle:answer 위생 (보안 M-7)', () => {
  test('64자를 넘는 questionId 는 BAD_PAYLOAD 로 거절된다', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const socket = h.connect(1);
    socket.fire('room:join', { roomId: roomId });
    socket.sent.length = 0;

    socket.fire('battle:answer', { questionId: 'x'.repeat(battleIo.QUESTION_ID_MAX + 1), fieldIndex: 0, value: '가' });
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].event, 'error');
    assert.equal(socket.sent[0].payload.code, 'BAD_PAYLOAD');

    // 정확히 상한 길이는 통과해 리듀서까지 간다 (모르는 문항이므로 UNKNOWN_QUESTION 이 돌아온다)
    socket.sent.length = 0;
    socket.fire('battle:answer', { questionId: 'y'.repeat(battleIo.QUESTION_ID_MAX), fieldIndex: 0, value: '가' });
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].payload.code, 'UNKNOWN_QUESTION');
  });

  test('빈 questionId·비문자열도 BAD_PAYLOAD', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const socket = h.connect(1);
    socket.fire('room:join', { roomId: roomId });
    socket.sent.length = 0;
    socket.fire('battle:answer', { questionId: '', fieldIndex: 0 });
    socket.fire('battle:answer', { questionId: 123, fieldIndex: 0 });
    socket.fire('battle:answer', null);
    assert.equal(socket.sent.length, 3);
    for (const s of socket.sent) assert.equal(s.payload.code, 'BAD_PAYLOAD');
  });

  test('연속 answer 는 레이트리밋에 걸려 일부가 조용히 버려진다', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const socket = h.connect(1);
    socket.fire('room:join', { roomId: roomId });
    socket.sent.length = 0;

    // 통과한 것만 리듀서까지 가서 UNKNOWN_QUESTION 에러 1건을 만든다 —
    // 버려진 것은 에러조차 내지 않으므로 응답 수가 곧 통과 수다.
    const BURST = 60;
    for (let i = 0; i < BURST; i += 1) {
      socket.fire('battle:answer', { questionId: 'nope', fieldIndex: 0, value: '가' });
    }
    assert.ok(socket.sent.length >= 1, '최소 1건은 통과해야 한다');
    assert.ok(socket.sent.length < BURST, '전부 통과하면 리밋이 없는 것이다: ' + socket.sent.length);
    for (const s of socket.sent) assert.equal(s.payload.code, 'UNKNOWN_QUESTION');
  });

  test('창 하나 몫(20건)은 몰아서 보내도 한 건도 버려지지 않는다', () => {
    // 리밋은 `makeLimiter({windowMs:1000, max:20})` 고정 창이다 — 창이 열리자마자
    // 20건을 연달아 보내도 전부 통과한다. 최소 간격(leaky bucket)이었다면
    // **버스트의 첫 건 다음부터 조용히 사라졌을 것**이고, 그건 정상 입력을 잃는 제품 버그다.
    // e2e 가 battle:questions 직후 답안을 연달아 쏘는 것도 이 성질에 기대고 있다.
    const h = harness();
    const roomId = playingRoom(h);
    const socket = h.connect(1);
    socket.fire('room:join', { roomId: roomId });
    socket.sent.length = 0;

    for (let i = 0; i < 20; i += 1) {
      socket.fire('battle:answer', { questionId: 'nope', fieldIndex: 0, value: '가' });
    }
    assert.equal(socket.sent.length, 20, '버스트 20건 중 버려진 것이 있다: ' + socket.sent.length);
    for (const s of socket.sent) assert.equal(s.payload.code, 'UNKNOWN_QUESTION');
  });

  test('레이트리밋은 소켓마다 따로 센다', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const a = h.connect(1);
    const b = h.connect(2);
    a.fire('room:join', { roomId: roomId });
    b.fire('room:join', { roomId: roomId });
    a.sent.length = 0;
    b.sent.length = 0;
    a.fire('battle:answer', { questionId: 'nope', fieldIndex: 0, value: '가' });
    b.fire('battle:answer', { questionId: 'nope', fieldIndex: 0, value: '가' });
    // 서로의 첫 이벤트를 잡아먹지 않는다
    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 1);
  });
});

// ------------------------------------------------------- 디바운스 취소(M-1)

describe('진행 상황 디바운스 취소 (서버 M-1)', () => {
  test('제출의 즉시 방송이 같은 키로 지연 중인 answer 방송을 버린다', async () => {
    const h = harness();
    const roomId = playingRoom(h);
    h.roomEmits.length = 0;

    h.api.dispatch(roomId, {
      type: 'answer', userId: 1, questionId: '2026-2#1', fieldIndex: 0, value: '가', at: now(),
    });
    // 아직 나가지 않았다 — 400ms 뒤에 나갈 예정으로 대기열에 있다
    assert.equal(h.api.debounces.size, 1);
    assert.equal(h.roomEmits.filter((e) => e.event === 'battle:progress').length, 0);

    h.api.dispatch(roomId, { type: 'submit', userId: 1, at: now() });
    // 즉시 방송이 나가면서 대기열이 비워졌다
    assert.equal(h.api.debounces.size, 0);

    await new Promise((r) => setTimeout(r, 500));
    const progs = h.roomEmits.filter((e) => e.event === 'battle:progress');
    assert.equal(progs.length, 1, '지연분이 뒤늦게 따라 나오면 안 된다');
    assert.equal(progs[0].payload.submitted, true);
    assert.equal(progs[0].payload.userId, 1);
  });

  test('제출이 없으면 지연 방송은 정상적으로 한 번 나간다', async () => {
    const h = harness();
    const roomId = playingRoom(h);
    h.roomEmits.length = 0;
    h.api.dispatch(roomId, {
      type: 'answer', userId: 1, questionId: '2026-2#1', fieldIndex: 0, value: '가', at: now(),
    });
    await new Promise((r) => setTimeout(r, 500));
    const progs = h.roomEmits.filter((e) => e.event === 'battle:progress');
    assert.equal(progs.length, 1);
    assert.equal(progs[0].payload.submitted, undefined);
    assert.equal(h.api.debounces.size, 0);
  });
});

// -------------------------------------------------------------- 로그 레벨

describe('로그 레벨 (서버 M-12)', () => {
  test('answer·tick 은 debug 로, 상태 전이는 info 로 간다', () => {
    const h = harness();
    const roomId = playingRoom(h);
    h.logs.length = 0;
    h.debugLogs.length = 0;

    h.api.dispatch(roomId, {
      type: 'answer', userId: 1, questionId: '2026-2#1', fieldIndex: 0, value: '가', at: now(),
    });
    h.api.dispatch(roomId, { type: 'tick', at: now() });
    assert.equal(h.logs.length, 0, 'answer·tick 이 info 로 새면 안 된다');
    assert.equal(h.debugLogs.length, 2);

    h.api.dispatch(roomId, { type: 'submit', userId: 1, at: now() });
    assert.ok(h.logs.length >= 1, '제출은 info 로 남아야 한다');
  });
});

// ------------------------------------------------------------- 외부 창구

describe('attach() 반환 창구', () => {
  test('필요한 함수가 전부 열려 있다', () => {
    const h = harness();
    for (const name of ['activeBattleQuestionIds', 'roomCount', 'listRooms', 'timeOverrideS', 'dispatch']) {
      assert.equal(typeof h.api[name], 'function', name + ' 가 없다');
    }
  });

  test('activeBattleQuestionIds — playing 중 미제출자만 잡힌다 (보안 C-1)', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const ids = h.api.activeBattleQuestionIds(1);
    assert.ok(ids instanceof Set);
    assert.deepEqual(Array.from(ids).sort(), ['2026-2#1', '2026-2#2']);
    // 방에 없는 사람은 null
    assert.equal(h.api.activeBattleQuestionIds(999), null);

    // 제출하면 답안이 고정되므로 더는 막을 이유가 없다
    h.api.dispatch(roomId, { type: 'submit', userId: 1, at: now() });
    assert.equal(h.api.activeBattleQuestionIds(1), null);
    assert.ok(h.api.activeBattleQuestionIds(2) instanceof Set);
  });

  test('activeBattleQuestionIds — waiting 방은 잡히지 않는다', () => {
    const h = harness();
    const roomId = h.createRoom(1);
    h.api.dispatch(roomId, { type: 'join', userId: 1, nickname: 'U1', at: now() });
    assert.equal(h.api.activeBattleQuestionIds(1), null);
  });

  test('roomCount / listRooms', () => {
    const h = harness();
    assert.equal(h.api.roomCount(), 0);
    const a = h.createRoom(1, '가방');
    const b = h.createRoom(2, '나방');
    assert.equal(h.api.roomCount(), 2);

    const list = h.api.listRooms();
    assert.equal(list.length, 2);
    const byId = new Map(list.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId.get(a)).sort(),
      ['createdAt', 'hostUserId', 'id', 'name', 'players', 'state'].sort());
    assert.equal(byId.get(a).name, '가방');
    assert.equal(byId.get(a).hostUserId, 1);
    assert.equal(byId.get(a).state, 'waiting');
    assert.equal(byId.get(a).players, 0);
    assert.equal(byId.get(b).hostUserId, 2);

    h.api.dispatch(a, { type: 'join', userId: 1, nickname: 'U1', at: now() });
    assert.equal(h.api.listRooms().find((r) => r.id === a).players, 1);
  });

  test('listRooms 는 waiting 이 아닌 방도 보여 준다 (GET /api/rooms 와 다르다)', () => {
    const h = harness();
    const roomId = playingRoom(h);
    const list = h.api.listRooms();
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'playing');
    assert.equal(list[0].players, 2);
    // 반면 공개 목록은 waiting 만 담는다
    const res = h.call('GET /api/rooms', { user: { id: 1, nickname: 'U1' } });
    assert.deepEqual(res.body, []);
    assert.ok(roomId);
  });
});

// ------------------------------------------------------------------ 인증

describe('GET /api/rooms 인증 (보안 L-9)', () => {
  test('requireAuth 가 라우트 체인 맨 앞에 붙어 있다', () => {
    const h = harness();
    const chain = h.routes.get('GET /api/rooms');
    assert.equal(chain[0], h.requireAuth);
    assert.equal(chain.length, 2);
    // 방 생성·랭킹도 마찬가지다 (회귀 방지)
    assert.equal(h.routes.get('POST /api/rooms')[0], h.requireAuth);
    assert.equal(h.routes.get('GET /api/ranking')[0], h.requireAuth);
  });
});

// ------------------------------------------------- 소켓 핸드셰이크 세션 검증

describe('소켓 핸드셰이크 — 세션 세대 검증 (보안 M-5)', () => {
  // 여기서는 **진짜 auth 모듈**을 쓴다. 쿠키 서명·만료·세대 대조가 전부 그 안에 있고,
  // 가짜로 흉내 내면 정작 검증하려는 규칙(sv 대조)을 테스트가 스스로 구현하게 되기 때문이다.
  const auth = require('../server/auth.js');
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-io-auth-'));
  auth.loadSecret(secretDir);

  /** DB 안의 세션 세대를 마음대로 바꿀 수 있는 가짜 사용자 저장소. */
  function userStore(initialVersion) {
    const row = { id: 42, nickname: '검증이', session_version: initialVersion };
    return {
      row: row,
      db: {
        findUserById: function (id) { return id === row.id ? row : null; },
        saveMatch: function () { return 1; },
      },
    };
  }

  function cookieFor(userId, sv) {
    return auth.COOKIE_NAME + '=' + auth.makeToken(userId, sv);
  }

  test('세대가 맞으면 통과하고 socket.data.user 가 채워진다', () => {
    const store = userStore(3);
    const h = harness({ db: store.db, auth: auth });
    const r = h.handshake(cookieFor(42, 3));
    assert.equal(r.err, null);
    assert.deepEqual(r.user, { id: 42, nickname: '검증이' });
  });

  test('bumpSessionVersion 뒤의 옛 쿠키는 거절된다 — 폐기한 세션이 소켓에서 살아남지 않는다', () => {
    const store = userStore(3);
    const h = harness({ db: store.db, auth: auth });
    const oldCookie = cookieFor(42, 3);
    assert.equal(h.handshake(oldCookie).err, null); // 폐기 전에는 통과

    store.row.session_version = 4; // db.bumpSessionVersion 이 한 일과 같다
    const after = h.handshake(oldCookie);
    assert.ok(after.err instanceof Error, '거절되지 않았다');
    assert.match(after.err.message, /로그인이 필요합니다/);
    assert.equal(after.user, null);

    // 새 세대로 다시 로그인한 쿠키는 통과한다
    assert.equal(h.handshake(cookieFor(42, 4)).err, null);
  });

  test('앞선 세대 쿠키(위조·미래 값)도 거절된다 — 대조는 등호다', () => {
    const store = userStore(3);
    const h = harness({ db: store.db, auth: auth });
    assert.ok(h.handshake(cookieFor(42, 99)).err instanceof Error);
  });

  test('쿠키 없음·서명 위조·없는 사용자는 전부 거절된다', () => {
    const store = userStore(0);
    const h = harness({ db: store.db, auth: auth });
    assert.ok(h.handshake(undefined).err instanceof Error);
    assert.ok(h.handshake('').err instanceof Error);
    assert.ok(h.handshake(auth.COOKIE_NAME + '=eyJ1aWQiOjQyfQ.forged').err instanceof Error);
    assert.ok(h.handshake(cookieFor(9999, 0)).err instanceof Error); // findUserById → null
  });

  test('db 조회가 던져도 연결만 거절하고 서버는 살아 있다', () => {
    const h = harness({
      db: { findUserById: function () { throw new Error('DB 잠김'); }, saveMatch: function () { return 1; } },
      auth: auth,
    });
    const r = h.handshake(cookieFor(42, 0));
    assert.ok(r.err instanceof Error);
    assert.equal(r.user, null);
  });

  test('세대 0 계정(마이그레이션 직후)도 통과하고, 1 로 올리면 즉시 끊긴다', () => {
    const store = userStore(0);
    const h = harness({ db: store.db, auth: auth });
    assert.equal(h.handshake(cookieFor(42, 0)).err, null);
    store.row.session_version = 1;
    assert.ok(h.handshake(cookieFor(42, 0)).err instanceof Error);
  });

  after(() => { fs.rmSync(secretDir, { recursive: true, force: true }); });
});
