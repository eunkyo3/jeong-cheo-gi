// battle.test.mjs — 순수 리듀서(server/battle.js) 계약 검증.
//
// 소켓도 실제 타이머도 쓰지 않는다. `applyEvent` 를 **합성 at 값**으로 직접 몰아
// PROTOCOL.md 의 상태 머신 / 승자 판정 체인 / 랜덤 출제 규칙을 확인한다.
// 리듀서가 CommonJS 이므로 createRequire 로 가져온다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const battle = require('../server/battle.js');
const {
  applyEvent, createRoom, isDisposed, buildQuestionSet,
  COUNTDOWN_MS, ABANDON_GRACE_MS, ROOM_GC_MS, MAX_PLAYERS,
} = battle;

// ------------------------------------------------------------------ 픽스처

const T0 = 1_800_000_000_000; // 고정 기준 시각 — 테스트는 전부 상대 오프셋으로 쓴다
const TIME_LIMIT_S = 600;

/** 한 필드짜리 ordered 문항. accept[0] 을 정답 표기(display)로 쓴다. */
function makeQuestion(round, num, accept) {
  return {
    id: round + '#' + num,
    num: num,
    prompt: '문항 ' + num,
    bodyHtml: '<p>본문 ' + num + '</p>',
    bodyText: '본문 ' + num,
    sourceImages: [],
    answerMode: 'ordered',
    display: accept[0],
    fields: [{ label: '답', accept: accept, normalize: 'default', sampleAnswer: accept[0] }],
  };
}

const QUESTIONS = [
  makeQuestion('2026-2', 1, ['동치분할']),
  makeQuestion('2026-2', 2, ['캡슐화']),
];

function newRoom(opts) {
  const o = opts || {};
  const created = createRoom({
    roomId: 'ROOM1',
    name: '테스트방',
    hostUserId: 1,
    mode: 'round',
    roundIds: ['2026-2'],
    questionCount: null,
    timeLimitS: o.timeLimitS == null ? TIME_LIMIT_S : o.timeLimitS,
    questions: o.questions || QUESTIONS,
    at: T0,
  });
  return created;
}

/** 이벤트 목록을 순서대로 흘려보내고 최종 state 와 **누적** 이펙트를 돌려준다. */
function drive(state, events) {
  let s = state;
  const effects = [];
  for (const ev of events) {
    const r = applyEvent(s, ev);
    s = r.state;
    for (const fx of r.effects) effects.push(fx);
  }
  return { state: s, effects: effects };
}

const ev = {
  join: (userId, nickname, at) => ({ type: 'join', userId, nickname, at }),
  leave: (userId, at) => ({ type: 'leave', userId, at }),
  start: (userId, at) => ({ type: 'start', userId, at }),
  answer: (userId, questionId, value, at) => ({ type: 'answer', userId, questionId, fieldIndex: 0, value, at }),
  submit: (userId, at) => ({ type: 'submit', userId, at }),
  connect: (userId, at) => ({ type: 'connect', userId, at }),
  disconnect: (userId, at) => ({ type: 'disconnect', userId, at }),
  tick: (at) => ({ type: 'tick', at }),
  timeout: (kind, at) => ({ type: 'timeout', kind, at }),
};

const broadcasts = (fx, name) => fx.filter((f) => f.type === 'broadcast' && f.event === name);
const persists = (fx) => fx.filter((f) => f.type === 'persist');
const cancels = (fx, key) => fx.filter((f) => f.type === 'cancel' && f.key === key);
const schedules = (fx, key) => fx.filter((f) => f.type === 'schedule' && f.key === key);
const errors = (fx) => fx.filter((f) => f.type === 'broadcast' && f.event === 'error');

/** 2인 참가 → 카운트다운 종료까지 몰아 playing 상태를 만든다. */
function playingRoom(opts) {
  const created = newRoom(opts);
  const r = drive(created.state, [
    ev.join(1, '가나', T0 + 10),
    ev.join(2, '다라', T0 + 20),
    ev.start(1, T0 + 30),
    ev.timeout('countdown', T0 + 30 + COUNTDOWN_MS),
  ]);
  assert.equal(r.state.state, 'playing');
  return r;
}

// ------------------------------------------------------------------- 대기실

describe('waiting', () => {
  test('createRoom 은 waiting 으로 태어나고 roomGc 타이머를 건다', () => {
    const created = newRoom();
    assert.equal(created.state.state, 'waiting');
    assert.equal(created.state.playerOrder.length, 0);
    assert.equal(schedules(created.effects, 'ROOM1:roomGc').length, 1);
    assert.equal(schedules(created.effects, 'ROOM1:roomGc')[0].at, T0 + ROOM_GC_MS);
  });

  test('방장이 아니면 start 가 거부된다 (NOT_HOST)', () => {
    const created = newRoom();
    const r = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.start(2, T0 + 30), // 방장은 1번
    ]);
    assert.equal(r.state.state, 'waiting');
    const errs = errors(r.effects);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.code, 'NOT_HOST');
    assert.equal(errs[0].to, 2);
    assert.equal(schedules(r.effects, 'ROOM1:countdown').length, 0);
  });

  test('전원 퇴장으로 방장이 비면 다음 입장자가 방장이 되어 start 할 수 있다', () => {
    const base = newRoom();
    const emptied = drive(base.state, [ev.join(1, 'A', T0 + 1), ev.leave(1, T0 + 2)]);
    assert.equal(emptied.state.state, 'waiting');
    assert.equal(emptied.state.playerOrder.length, 0);
    assert.equal(emptied.state.hostUserId, null);

    const refilled = drive(emptied.state, [ev.join(2, 'B', T0 + 3), ev.join(3, 'C', T0 + 4)]);
    assert.equal(refilled.state.hostUserId, 2);   // 첫 입장자가 방장
    const r = applyEvent(refilled.state, ev.start(2, T0 + 5));
    assert.equal(r.state.state, 'countdown');     // NOT_HOST 없이 시작
    assert.equal(r.effects.filter((fx) => fx.event === 'error').length, 0);
  });

  test('1인일 때 start 가 거부된다 (NEED_TWO_PLAYERS)', () => {
    const created = newRoom();
    const r = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.start(1, T0 + 20),
    ]);
    assert.equal(r.state.state, 'waiting');
    const errs = errors(r.effects);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.code, 'NEED_TWO_PLAYERS');
  });
});

// ---------------------------------------------------------------- 카운트다운

describe('countdown', () => {
  test('카운트다운 중 1인이 되면 취소하고 waiting 으로 돌아간다', () => {
    const created = newRoom();
    const upto = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.start(1, T0 + 30),
    ]);
    assert.equal(upto.state.state, 'countdown');
    assert.equal(schedules(upto.effects, 'ROOM1:countdown').length, 1);

    const r = applyEvent(upto.state, ev.leave(2, T0 + 40));
    assert.equal(r.state.state, 'waiting');
    assert.equal(r.state.countdownEndsAt, null);
    assert.equal(r.state.playerOrder.length, 1);
    assert.equal(cancels(r.effects, 'ROOM1:countdown').length, 1);
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
  });
});

// -------------------------------------------------------------------- 진행

describe('playing', () => {
  test('2인 정상 진행 → 전원 제출 → finished', () => {
    const base = playingRoom();
    const deadline = base.state.deadline;
    assert.equal(deadline, T0 + 30 + COUNTDOWN_MS + TIME_LIMIT_S * 1000);
    assert.equal(broadcasts(base.effects, 'battle:questions').length, 1);

    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.answer(1, '2026-2#2', '캡슐화', T0 + 6000),
      ev.answer(2, '2026-2#1', '동치분할', T0 + 7000),
      ev.submit(1, T0 + 8000),
      ev.submit(2, T0 + 9000),
    ]);

    assert.equal(r.state.state, 'finished');
    assert.equal(isDisposed(r.state), true);
    assert.equal(r.state.result.reason, 'allSubmitted');
    assert.equal(r.state.result.winnerUserId, 1); // 2문항 정답 vs 1문항 정답

    const results = r.state.result.results;
    assert.equal(results.length, 2);
    assert.equal(results.find((x) => x.userId === 1).correctCount, 2);
    assert.equal(results.find((x) => x.userId === 2).correctCount, 1);
    assert.equal(results.find((x) => x.userId === 1).score, 100);
  });

  test('제출 이후의 answer 는 에러 이펙트 + 상태 불변', () => {
    const base = playingRoom();
    const afterSubmit = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.submit(1, T0 + 6000),
    ]).state;

    const r = applyEvent(afterSubmit, ev.answer(1, '2026-2#1', '경계값분석', T0 + 7000));
    const errs = errors(r.effects);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.code, 'ALREADY_SUBMITTED');
    assert.equal(errs[0].to, 1);
    // 보관 답안·제출 시각·마지막 입력 시각 어느 것도 움직이지 않는다
    assert.deepEqual(r.state.players[1].answers, afterSubmit.players[1].answers);
    assert.equal(r.state.players[1].submittedAt, afterSubmit.players[1].submittedAt);
    assert.equal(r.state.players[1].lastAnswerAt, afterSubmit.players[1].lastAnswerAt);
    assert.equal(r.state.state, 'playing');
    assert.equal(broadcasts(r.effects, 'battle:progress').length, 0);
  });

  test('deadline 타임아웃이 자동으로 종료시킨다', () => {
    const base = playingRoom();
    const deadline = base.state.deadline;
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.timeout('deadline', deadline),
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.reason, 'deadline');
    assert.equal(r.state.result.winnerUserId, 1);
    assert.equal(persists(r.effects).length, 1);
  });

  test('종료 시 battle:finished 브로드캐스트와 saveMatch persist 를 함께 낸다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.submit(1, T0 + 6000),
      ev.submit(2, T0 + 7000),
    ]);

    const finished = broadcasts(r.effects, 'battle:finished');
    assert.equal(finished.length, 2); // 참가자 1명당 1건 (details 는 본인 것만)
    assert.deepEqual(finished.map((f) => f.to).sort(), [1, 2]);
    for (const f of finished) {
      assert.equal(f.payload.winnerUserId, 1);
      assert.equal(f.payload.details.length, QUESTIONS.length);
      assert.ok(Object.prototype.hasOwnProperty.call(f.payload.details[0], 'display'));
    }

    const ps = persists(r.effects);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].op, 'saveMatch');
    assert.equal(ps[0].match.winnerUserId, 1);
    assert.equal(ps[0].match.mode, 'round');
    assert.deepEqual(ps[0].match.roundIds, ['2026-2']);
    assert.equal(ps[0].players.length, 2);
    assert.equal(ps[0].players.find((p) => p.userId === 1).correctCount, 1);
    assert.equal(typeof ps[0].match.finishedAt, 'string'); // ISO 문자열
  });
});

// ------------------------------------------------------------ 이탈 / 재접속

describe('이탈과 재접속', () => {
  test('playing 중 전원 끊김 → abandon 타임아웃 → abandoned, persist 없음', () => {
    const base = playingRoom();
    const t = T0 + 5000;
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', t),
      ev.disconnect(1, t + 100),
      ev.disconnect(2, t + 200),
    ]);
    // 마지막 접속자가 끊긴 시점에 유예 타이머가 걸린다
    const sch = schedules(r.effects, 'ROOM1:abandon');
    assert.equal(sch.length, 1);
    assert.equal(sch[0].at, t + 200 + ABANDON_GRACE_MS);

    const done = applyEvent(r.state, ev.timeout('abandon', t + 200 + ABANDON_GRACE_MS));
    assert.equal(done.state.state, 'abandoned');
    assert.equal(isDisposed(done.state), true);
    // 전적 미기록 — 전 구간 어디에도 persist 이펙트가 없어야 한다
    assert.equal(persists(r.effects).length, 0);
    assert.equal(persists(done.effects).length, 0);
  });

  test('playing 중 이탈은 즉시 제출로 간주되고 이탈 시각이 제출 시각이 된다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(2, '2026-2#1', '동치분할', T0 + 4000),
      ev.leave(2, T0 + 5000),                         // 이탈 = 즉시 제출(비가역), 명부에는 남는다
      ev.answer(1, '2026-2#1', '동치분할', T0 + 6000),
      ev.submit(1, T0 + 7000),
      // deadline 타임아웃 없이 여기서 끝나야 한다 — 이탈자가 제출자로 세어지기 때문
    ]);

    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.reason, 'allSubmitted');
    assert.equal(r.state.players[2].left, true);
    assert.equal(r.state.players[2].submittedAt, T0 + 5000);

    const left = r.state.result.results.find((x) => x.userId === 2);
    assert.equal(left.left, true);
    assert.equal(left.correctCount, 1);                        // 보관 답안으로 채점됨
    assert.equal(left.submittedAt, T0 + 5000);                 // 이탈 시각이 곧 제출 시각
    assert.equal(left.effectiveSubmittedAt, T0 + 5000);        // 판정용도 동일 — deadline 이 아니다
    // 정답 수는 1:1 동률 → 체인 ②(제출 시각)에서 이탈자 2번(T0+5000)이 1번(T0+7000)보다 앞선다
    assert.equal(r.state.result.winnerUserId, 2);

    // 이탈 순간에 submitted:true 진행 방송이 나간다 (디바운스 없음)
    const progs = broadcasts(r.effects, 'battle:progress').filter((f) => f.payload.userId === 2);
    assert.equal(progs.length, 2);                             // answer 1건 + leave 1건
    assert.equal(progs[1].payload.submitted, true);
    assert.equal(progs[1].payload.answeredCount, 1);
    assert.equal(progs[1].debounceMs, undefined);

    const ps = persists(r.effects);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].match.winnerUserId, 2);
    assert.equal(ps[0].players.find((p) => p.userId === 2).submittedAt, new Date(T0 + 5000).toISOString());
  });

  test('이미 제출한 유저의 이탈은 제출 시각을 바꾸지 않고 progress 도 다시 내지 않는다', () => {
    const base = playingRoom();
    const before = drive(base.state, [
      ev.answer(2, '2026-2#1', '동치분할', T0 + 4000),
      ev.submit(2, T0 + 5000),
    ]);
    assert.equal(before.state.state, 'playing'); // 1번이 아직 미제출

    const after = applyEvent(before.state, ev.leave(2, T0 + 6000)); // 이탈 이펙트만 격리해서 본다
    assert.equal(after.state.state, 'playing');
    assert.equal(after.state.players[2].left, true);
    assert.equal(after.state.players[2].connected, false);
    assert.equal(after.state.players[2].submittedAt, T0 + 5000);    // 이탈 시각으로 덮어쓰지 않는다
    assert.equal(broadcasts(after.effects, 'battle:progress').length, 0);
    assert.equal(broadcasts(after.effects, 'room:state').length, 1);
    assert.equal(persists(after.effects).length, 0);
    // 1번이 아직 접속 중 → 유예 타이머 없음
    assert.equal(schedules(after.effects, 'ROOM1:abandon').length, 0);
  });

  test('둘 다 이탈하면 두 번째 이탈에서 곧바로 finished + persist', () => {
    const base = playingRoom();
    const first = applyEvent(base.state, ev.leave(2, T0 + 5000));
    assert.equal(first.state.state, 'playing');                    // 1번이 남았다 → 아직 종료 아님
    assert.equal(persists(first.effects).length, 0);

    const second = applyEvent(first.state, ev.leave(1, T0 + 6000));
    assert.equal(second.state.state, 'finished');
    assert.equal(second.state.result.reason, 'allSubmitted');
    assert.equal(second.state.players[1].left, true);
    assert.equal(second.state.players[2].left, true);
    assert.equal(second.state.result.results.every((x) => x.left === true), true);
    assert.equal(persists(second.effects).length, 1);
    // 종료로 끝났으므로 abandon 유예를 새로 걸지 않는다 (오히려 cancel 이 나간다)
    assert.equal(schedules(second.effects, 'ROOM1:abandon').length, 0);
    assert.equal(cancels(second.effects, 'ROOM1:abandon').length, 1);
  });

  // 어댑터 층(room:join 재부착 차단 — battle-io.js 의 `players[uid].left` 검사)은 여기서 다루지 않는다.
  // 소켓 멤버십이 얽혀 순수 리듀서 테스트로 재현할 수 없어 scripts/e2e-battle.js 가 담당한다.

  test('끊긴 뒤 connect 하면 보관 답안을 담은 battle:resync 가 본인에게만 간다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.disconnect(1, T0 + 6000),
    ]);
    assert.equal(r.state.players[1].connected, false);

    const back = applyEvent(r.state, ev.connect(1, T0 + 7000));
    assert.equal(back.state.players[1].connected, true);

    const resyncs = broadcasts(back.effects, 'battle:resync');
    assert.equal(resyncs.length, 1);
    assert.equal(resyncs[0].to, 1);
    assert.deepEqual(resyncs[0].payload.myAnswers, { '2026-2#1': ['동치분할'] });
    assert.equal(resyncs[0].payload.state, 'playing');
    assert.equal(resyncs[0].payload.questions.length, QUESTIONS.length);
    assert.equal(resyncs[0].payload.remainingMs, base.state.deadline - (T0 + 7000));
    // 재접속은 abandon 유예를 취소한다
    assert.equal(cancels(back.effects, 'ROOM1:abandon').length, 1);
    // 스냅샷 1회 — 문항에 정답 계열 필드가 섞이지 않는다
    const f = resyncs[0].payload.questions[0].fields[0];
    assert.deepEqual(Object.keys(f), ['label']);
  });
});

// ---------------------------------------------------------- 승자 판정 체인

describe('승자 판정 체인', () => {
  test('① 동률이면 ② 먼저 제출한 쪽이 이긴다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 4000),
      ev.answer(2, '2026-2#1', '동치분할', T0 + 4100),
      ev.submit(2, T0 + 5000), // 2번이 먼저 제출
      ev.submit(1, T0 + 6000),
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.results.every((x) => x.correctCount === 1), true);
    assert.equal(r.state.result.winnerUserId, 2);
  });

  test('아무도 제출하지 않으면 ③ 마지막 answer 시각이 가른다', () => {
    const base = playingRoom();
    const deadline = base.state.deadline;
    const r = drive(base.state, [
      ev.answer(2, '2026-2#1', '동치분할', T0 + 4000), // 2번이 더 이른 마지막 입력
      ev.answer(1, '2026-2#1', '동치분할', T0 + 9000),
      ev.timeout('deadline', deadline),
    ]);
    assert.equal(r.state.state, 'finished');
    const rows = r.state.result.results;
    assert.equal(rows.every((x) => x.correctCount === 1), true);
    assert.equal(rows.every((x) => x.effectiveSubmittedAt === deadline), true); // ② 동률
    assert.equal(r.state.result.winnerUserId, 2);
  });

  test('④ 전부 동률이면 무승부(winnerUserId === null)', () => {
    const base = playingRoom();
    const deadline = base.state.deadline;
    const r = drive(base.state, [
      ev.timeout('deadline', deadline), // 아무도 답하지도 제출하지도 않았다
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.results.every((x) => x.correctCount === 0), true);
    assert.equal(r.state.result.winnerUserId, null);
    assert.equal(persists(r.effects)[0].match.winnerUserId, null);
  });
});

// ------------------------------------------------------------- 시계 역행

describe('시계 역행 클램프', () => {
  test('at 이 lastAt 보다 이르면 lastAt 은 뒤로 가지 않는다', () => {
    const base = playingRoom();
    const forward = applyEvent(base.state, ev.answer(1, '2026-2#1', '동치분할', T0 + 50000));
    assert.equal(forward.state.lastAt, T0 + 50000);

    const rewound = applyEvent(forward.state, ev.answer(1, '2026-2#2', '캡슐화', T0 + 10000));
    assert.equal(rewound.state.lastAt, T0 + 50000);              // 전진만 한다
    assert.equal(rewound.state.players[1].lastAnswerAt, T0 + 50000); // 클램프된 at 이 쓰인다
    assert.deepEqual(rewound.state.players[1].answers['2026-2#2'], ['캡슐화']);
  });

  test('무시되는 셀에서도 lastAt 은 갱신되고 입력 state 는 불변이다', () => {
    const created = newRoom();
    const before = created.state;
    const r = applyEvent(before, ev.tick(T0 + 1234)); // waiting 의 tick 은 무시 셀
    assert.equal(r.effects.length, 0);
    assert.equal(r.state.lastAt, T0 + 1234);
    assert.equal(before.lastAt, T0); // 원본 훼손 없음
    assert.notEqual(r.state, before);
  });
});

// ------------------------------------------------------------ 랜덤 출제

describe('buildQuestionSet', () => {
  /** 결정적 LCG — 테스트가 흔들리지 않도록 rng 를 주입한다. */
  function lcg(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function roundFixture(id, n) {
    const questions = [];
    for (let i = 1; i <= n; i++) questions.push(makeQuestion(id, i, ['정답' + id + i]));
    return { round: id, questions: questions };
  }

  test('random: 회차별 균등 배분 + 중복 없음', () => {
    const rounds = [roundFixture('2024-1', 8), roundFixture('2024-2', 8), roundFixture('2024-3', 8)];
    const r = buildQuestionSet({ mode: 'random', rounds, questionCount: 9, rng: lcg(42) });
    assert.equal(r.ok, true);
    assert.equal(r.questions.length, 9);

    const ids = r.questions.map((q) => q.id);
    assert.equal(new Set(ids).size, 9, '동일 문항 중복 금지');

    const perRound = {};
    for (const q of r.questions) {
      const round = q.id.split('#')[0];
      perRound[round] = (perRound[round] || 0) + 1;
    }
    assert.deepEqual(perRound, { '2024-1': 3, '2024-2': 3, '2024-3': 3 });
  });

  test('random: 나머지 몫은 전체 풀에서 채운다 (3회차 10문항 = 3/3/3 + 1)', () => {
    const rounds = [roundFixture('2024-1', 8), roundFixture('2024-2', 8), roundFixture('2024-3', 8)];
    const r = buildQuestionSet({ mode: 'random', rounds, questionCount: 10, rng: lcg(7) });
    assert.equal(r.ok, true);
    assert.equal(r.questions.length, 10);
    assert.equal(new Set(r.questions.map((q) => q.id)).size, 10);

    const perRound = {};
    for (const q of r.questions) {
      const round = q.id.split('#')[0];
      perRound[round] = (perRound[round] || 0) + 1;
    }
    for (const round of ['2024-1', '2024-2', '2024-3']) assert.ok(perRound[round] >= 3);
    assert.equal(Object.values(perRound).reduce((a, b) => a + b, 0), 10);
  });

  test('random: 같은 seed 면 같은 결과(결정성)', () => {
    const rounds = [roundFixture('2024-1', 8), roundFixture('2024-2', 8)];
    const a = buildQuestionSet({ mode: 'random', rounds, questionCount: 5, rng: lcg(99) });
    const b = buildQuestionSet({ mode: 'random', rounds, questionCount: 5, rng: lcg(99) });
    assert.deepEqual(a.questions.map((q) => q.id), b.questions.map((q) => q.id));
  });

  test('random: 유효 문항 총합이 요청 수보다 적으면 실패 사유를 돌려준다', () => {
    const rounds = [roundFixture('2024-1', 3)];
    const r = buildQuestionSet({ mode: 'random', rounds, questionCount: 5, rng: lcg(1) });
    assert.equal(r.ok, false);
    assert.match(r.error, /총합\(3\)/);
    assert.match(r.error, /5/);
  });

  test('round: 선택 회차의 전 문항을 순서대로 준다', () => {
    const rounds = [roundFixture('2024-1', 4), roundFixture('2024-2', 2)];
    const r = buildQuestionSet({ mode: 'round', rounds });
    assert.equal(r.ok, true);
    assert.deepEqual(r.questions.map((q) => q.id), [
      '2024-1#1', '2024-1#2', '2024-1#3', '2024-1#4', '2024-2#1', '2024-2#2',
    ]);
  });

  test('회차를 하나도 고르지 않으면 실패한다', () => {
    const r = buildQuestionSet({ mode: 'random', rounds: [], questionCount: 5 });
    assert.equal(r.ok, false);
    assert.match(r.error, /회차/);
  });
});

// ------------------------------------------------- 제출자 간 정오 공유 (battle:marks)

describe('battle:marks — 제출자끼리만 정오 공유', () => {
  /** 3인 playing 방. playerOrder = [1,2,3]. */
  function playing3() {
    const created = newRoom();
    const r = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.join(3, '마바', T0 + 30),
      ev.start(1, T0 + 40),
      ev.timeout('countdown', T0 + 40 + COUNTDOWN_MS),
    ]);
    assert.equal(r.state.state, 'playing');
    assert.equal(r.state.playerOrder.length, 3);
    return r.state;
  }

  test('첫 제출자에게만 자기 정오표가 간다 (미제출자는 한 건도 못 받는다)', () => {
    const base = playingRoom();
    const answered = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),   // 정답
      ev.answer(1, '2026-2#2', '엉뚱한답', T0 + 5100),   // 오답
    ]).state;

    const r = applyEvent(answered, ev.submit(1, T0 + 6000));
    assert.equal(r.state.state, 'playing');             // 2번이 아직 미제출

    const marks = broadcasts(r.effects, 'battle:marks');
    assert.equal(marks.length, 1);
    assert.equal(marks[0].to, 1);                        // 반드시 개별 발송 — room 브로드캐스트 금지
    assert.equal(marks[0].room, 'ROOM1');
    assert.equal(marks.filter((f) => f.to === 2).length, 0);

    const rows = marks[0].payload.players;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 1);
    assert.equal(rows[0].nickname, '가나');
    // 정오 불리언만 — 답 내용·display 계열 필드가 섞이면 치팅이 된다
    assert.deepEqual(Object.keys(rows[0]).sort(), ['marks', 'nickname', 'userId']);
    assert.deepEqual(Object.keys(rows[0].marks), QUESTIONS.map((q) => q.id));
    assert.deepEqual(rows[0].marks, { '2026-2#1': true, '2026-2#2': false });

    // 제출 시점에 state 에도 정오표가 확정 보관된다
    assert.deepEqual(r.state.players[1].marks, { '2026-2#1': true, '2026-2#2': false });
    assert.equal(r.state.players[2].marks, null);
  });

  test('마지막 제출로 종료되는 이벤트에서는 marks 를 내지 않고 persist 가 학습 기록 재료를 싣는다', () => {
    const base = playingRoom();
    const answered = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 5000),
      ev.answer(1, '2026-2#2', '엉뚱한답', T0 + 5100),
    ]).state;
    const afterA = applyEvent(answered, ev.submit(1, T0 + 6000));

    const fin = applyEvent(afterA.state, ev.submit(2, T0 + 7000)); // 2번은 무응답
    assert.equal(fin.state.state, 'finished');
    assert.equal(fin.state.result.reason, 'allSubmitted');
    // 결과 화면이 정오표를 대체한다 — 종료 이벤트에는 marks 가 없다
    assert.equal(broadcasts(fin.effects, 'battle:marks').length, 0);

    const ps = persists(fin.effects);
    assert.equal(ps.length, 1);
    const pa = ps[0].players.find((p) => p.userId === 1);
    const pb = ps[0].players.find((p) => p.userId === 2);
    assert.equal(pa.score, 50);
    assert.equal(pa.correctCount, 1);
    assert.deepEqual(pa.questionIds, ['2026-2#1', '2026-2#2']);
    assert.deepEqual(pa.wrongIds, ['2026-2#2']);         // 맞힌 1번은 빠진다
    assert.equal(pb.score, 0);
    assert.deepEqual(pb.questionIds, ['2026-2#1', '2026-2#2']);
    assert.deepEqual(pb.wrongIds, ['2026-2#1', '2026-2#2']);
  });

  test('3인: 제출자가 늘 때마다 제출 완료자 전원에게 최신 전체 목록이 재발송된다', () => {
    const base = playing3();

    const s1 = applyEvent(base, ev.submit(1, T0 + 5000));
    const m1 = broadcasts(s1.effects, 'battle:marks');
    assert.equal(m1.length, 1);
    assert.equal(m1[0].to, 1);
    assert.equal(m1[0].payload.players.length, 1);

    const s2 = applyEvent(s1.state, ev.submit(2, T0 + 6000));
    assert.equal(s2.state.state, 'playing');             // 3번이 남았다
    const m2 = broadcasts(s2.effects, 'battle:marks');
    assert.equal(m2.length, 2);
    assert.deepEqual(m2.map((f) => f.to).sort(), [1, 2]);
    assert.equal(m2.filter((f) => f.to === 3).length, 0); // 미제출자 3번은 수신 금지
    for (const f of m2) {
      assert.deepEqual(f.payload.players.map((p) => p.userId), [1, 2]); // playerOrder 순
      assert.deepEqual(f.payload.players.map((p) => p.nickname), ['가나', '다라']);
    }
  });

  test('이탈(=즉시 제출)도 제출로 세어져 정오표를 다시 뿌린다', () => {
    const base = playing3();
    const s1 = applyEvent(base, ev.submit(1, T0 + 5000));

    const s2 = applyEvent(s1.state, ev.leave(3, T0 + 6000)); // 이탈 = 즉시 제출
    assert.equal(s2.state.state, 'playing');                 // 2번이 미제출이라 아직 진행 중
    assert.deepEqual(s2.state.players[3].marks, { '2026-2#1': false, '2026-2#2': false });
    const m = broadcasts(s2.effects, 'battle:marks');
    assert.equal(m.length, 2);
    assert.deepEqual(m.map((f) => f.to).sort(), [1, 3]);
    for (const f of m) assert.deepEqual(f.payload.players.map((p) => p.userId), [1, 3]);

    // 이미 제출한 유저의 이탈은 새 제출이 아니다 → 재발송 없음
    const s3 = applyEvent(s2.state, ev.leave(1, T0 + 7000));
    assert.equal(s3.state.state, 'playing');
    assert.equal(broadcasts(s3.effects, 'battle:marks').length, 0);
  });

  test('resync: 제출자에게만 marks 배열이 실리고 미제출자에게는 필드가 없다', () => {
    const base = playingRoom();
    const submitted = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 4000),
      ev.submit(1, T0 + 5000),
      ev.disconnect(1, T0 + 6000),
    ]).state;

    const back = applyEvent(submitted, ev.connect(1, T0 + 7000));
    const rs = broadcasts(back.effects, 'battle:resync');
    assert.equal(rs.length, 1);
    assert.equal(rs[0].to, 1);
    assert.equal(rs[0].payload.submitted, true);
    assert.ok(Array.isArray(rs[0].payload.marks));
    assert.equal(rs[0].payload.marks.length, 1);
    assert.equal(rs[0].payload.marks[0].userId, 1);
    assert.deepEqual(rs[0].payload.marks[0].marks, { '2026-2#1': true, '2026-2#2': false });

    const gone = applyEvent(submitted, ev.disconnect(2, T0 + 6500));
    const back2 = applyEvent(gone.state, ev.connect(2, T0 + 7000));
    const rs2 = broadcasts(back2.effects, 'battle:resync');
    assert.equal(rs2.length, 1);
    assert.equal(rs2[0].payload.submitted, false);
    assert.equal(Object.prototype.hasOwnProperty.call(rs2[0].payload, 'marks'), false);
  });

  test('waiting 방의 resync 에는 marks 필드가 없다', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]).state;
    const back = applyEvent(joined, ev.connect(1, T0 + 20));
    const rs = broadcasts(back.effects, 'battle:resync');
    assert.equal(rs.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(rs[0].payload, 'marks'), false);
  });
});

// ------------------------------- 결과 화면 상대 답안 (battle:finished 전용 맵)

describe('battle:finished — answersByUser / marksByUser', () => {
  const Q1 = '2026-2#1', Q2 = '2026-2#2';

  /** 종료 전 이벤트에 답안 맵이 한 조각도 실리지 않았는지 검사한다(치팅 방어). */
  function assertNoAnswerMaps(fx, eventName) {
    const list = broadcasts(fx, eventName);
    assert.ok(list.length > 0, eventName + ' 이 한 건도 없어 검사가 무의미하다');
    for (const f of list) {
      assert.equal(Object.prototype.hasOwnProperty.call(f.payload, 'answersByUser'), false,
        eventName + ' 에 answersByUser 가 있으면 안 된다');
      assert.equal(Object.prototype.hasOwnProperty.call(f.payload, 'marksByUser'), false,
        eventName + ' 에 marksByUser 가 있으면 안 된다');
      assert.equal(/answersByUser|marksByUser/.test(JSON.stringify(f.payload)), false,
        eventName + ' 페이로드 어디에도 답안 맵 흔적이 없어야 한다');
    }
  }

  /** 1번은 1문항 정답·1문항 오답, 2번은 2번 문항만 정답인 playing 상태. */
  function answered() {
    const base = playingRoom();
    return drive(base.state, [
      ev.answer(1, Q1, '동치분할', T0 + 5000),   // 정답
      ev.answer(1, Q2, '엉뚱한답', T0 + 5100),   // 오답
      ev.answer(2, Q2, '캡슐화', T0 + 5200),     // 정답 (Q1 은 미입력)
    ]).state;
  }

  test('전원 제출 종료: 수신자와 무관하게 같은 answersByUser/marksByUser 가 실린다', () => {
    const r = drive(answered(), [ev.submit(1, T0 + 6000), ev.submit(2, T0 + 7000)]);
    assert.equal(r.state.state, 'finished');

    const finished = broadcasts(r.effects, 'battle:finished');
    assert.equal(finished.length, 2);
    for (const f of finished) {
      // 미입력 칸은 '' 로 채워 전 문항 × 전 필드 모양을 유지한다
      assert.deepEqual(f.payload.answersByUser, {
        1: { [Q1]: ['동치분할'], [Q2]: ['엉뚱한답'] },
        2: { [Q1]: [''], [Q2]: ['캡슐화'] },
      });
      assert.deepEqual(f.payload.marksByUser, {
        1: { [Q1]: true, [Q2]: false },
        2: { [Q1]: false, [Q2]: true },
      });
    }
    // 두 수신자가 받는 맵은 완전히 같은 내용이다(details 만 본인 것)
    assert.deepEqual(finished[0].payload.answersByUser, finished[1].payload.answersByUser);
    assert.deepEqual(finished[0].payload.marksByUser, finished[1].payload.marksByUser);
    assert.notDeepEqual(finished[0].payload.details, finished[1].payload.details);
  });

  test('이탈(=즉시 제출)로 끝난 종료에도 이탈자의 답안이 그대로 실린다', () => {
    const r = drive(answered(), [
      ev.leave(2, T0 + 6000),    // 이탈 = 즉시 제출, 보관 답안 확정
      ev.submit(1, T0 + 7000),   // 이탈자가 제출자로 세어져 여기서 종료
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.reason, 'allSubmitted');

    const finished = broadcasts(r.effects, 'battle:finished');
    assert.equal(finished.length, 2);
    for (const f of finished) {
      assert.deepEqual(f.payload.answersByUser[2], { [Q1]: [''], [Q2]: ['캡슐화'] });
      assert.deepEqual(f.payload.marksByUser[2], { [Q1]: false, [Q2]: true });
    }
  });

  test('deadline 타임아웃 종료에도 두 맵이 실린다 (미제출자 포함)', () => {
    const base = playingRoom();
    const deadline = base.state.deadline;
    const r = drive(base.state, [
      ev.answer(1, Q1, '동치분할', T0 + 5000),
      ev.timeout('deadline', deadline),
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.result.reason, 'deadline');

    const finished = broadcasts(r.effects, 'battle:finished');
    assert.equal(finished.length, 2);
    for (const f of finished) {
      assert.deepEqual(f.payload.answersByUser, {
        1: { [Q1]: ['동치분할'], [Q2]: [''] },
        2: { [Q1]: [''], [Q2]: [''] },   // 한 글자도 입력하지 않은 미제출자
      });
      assert.deepEqual(f.payload.marksByUser, {
        1: { [Q1]: true, [Q2]: false },
        2: { [Q1]: false, [Q2]: false },
      });
    }
  });

  test('종료 전 이벤트에는 절대 실리지 않는다 — questions / progress / marks / resync / room:state', () => {
    // battle:questions + room:state (countdown 종료 = playing 진입)
    const created = newRoom();
    const started = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.start(1, T0 + 30),
      ev.timeout('countdown', T0 + 30 + COUNTDOWN_MS),
    ]);
    assertNoAnswerMaps(started.effects, 'battle:questions');
    assertNoAnswerMaps(started.effects, 'room:state');

    // battle:progress (입력 방송)
    const prog = drive(started.state, [
      ev.answer(1, Q1, '동치분할', T0 + 5000),
      ev.answer(1, Q2, '엉뚱한답', T0 + 5100),
      ev.answer(2, Q2, '캡슐화', T0 + 5200),
    ]);
    assertNoAnswerMaps(prog.effects, 'battle:progress');

    // battle:marks (제출자 간 정오 공유)
    const submitted = applyEvent(prog.state, ev.submit(1, T0 + 6000));
    assert.equal(submitted.state.state, 'playing');
    assertNoAnswerMaps(submitted.effects, 'battle:marks');

    // battle:resync (제출자 재접속 — marks 가 실리는 경로)
    const back = drive(submitted.state, [ev.disconnect(1, T0 + 6500), ev.connect(1, T0 + 7000)]);
    assertNoAnswerMaps(back.effects, 'battle:resync');
    assert.ok(Array.isArray(broadcasts(back.effects, 'battle:resync')[0].payload.marks));

    // 종료 시 함께 나가는 room:state 에도 없다 — 결과는 battle:finished 로만 간다
    const fin = applyEvent(back.state, ev.submit(2, T0 + 8000));
    assert.equal(fin.state.state, 'finished');
    assertNoAnswerMaps(fin.effects, 'room:state');
    const f0 = broadcasts(fin.effects, 'battle:finished')[0];
    assert.ok(f0.payload.answersByUser && f0.payload.marksByUser);
  });
});

// ------------------------------------------------- 방 언어 옵션 (lang, C4)

describe('방 언어 옵션 — lang', () => {
  /** 유형·언어 오버레이가 붙은 코드 문항. 실제 데이터에서는 rounds.js 가 붙여 준다. */
  function codeQuestion(num, accept, lang) {
    return Object.assign(makeQuestion('2026-2', num, accept), { type: 'code', lang: lang });
  }

  const CODE_QUESTIONS = [
    codeQuestion(1, ['동치분할'], 'java'),
    codeQuestion(2, ['캡슐화'], 'java'),
  ];

  test('createRoom 이 lang 을 정규화해 방 상태에 보존한다', () => {
    assert.equal(newRoom().state.lang, null); // 미지정 = 전체
    assert.equal(createRoom({ roomId: 'R', hostUserId: 1, timeLimitS: TIME_LIMIT_S, questions: [], lang: 'java', at: T0 }).state.lang, 'java');
    assert.equal(createRoom({ roomId: 'R', hostUserId: 1, timeLimitS: TIME_LIMIT_S, questions: [], lang: 'ruby', at: T0 }).state.lang, null);
    assert.equal(createRoom({ roomId: 'R', hostUserId: 1, timeLimitS: TIME_LIMIT_S, questions: [], lang: '', at: T0 }).state.lang, null);
  });

  test('공개 방 요약(settings)에 lang 이 나간다', () => {
    const created = createRoom({
      roomId: 'ROOM1', name: '자바방', hostUserId: 1, mode: 'round', roundIds: ['2026-2'],
      questionCount: null, type: 'code', lang: 'java', timeLimitS: TIME_LIMIT_S,
      questions: CODE_QUESTIONS, at: T0,
    });
    const r = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    const rs = broadcasts(r.effects, 'room:state');
    assert.ok(rs.length > 0);
    for (const f of rs) {
      assert.equal(f.payload.settings.lang, 'java');
      assert.equal(f.payload.settings.type, 'code');
    }
    // 전체 언어 방은 null 로 나간다(키 자체는 있다)
    const plain = drive(newRoom().state, [ev.join(1, '가나', T0 + 10)]);
    const ps = broadcasts(plain.effects, 'room:state');
    assert.equal(ps[0].payload.settings.lang, null);
    assert.ok(Object.prototype.hasOwnProperty.call(ps[0].payload.settings, 'lang'));
  });

  test('battle:questions · resync 의 문항에 lang 이 실리고 정답 계열은 없다', () => {
    const created = createRoom({
      roomId: 'ROOM1', name: '자바방', hostUserId: 1, mode: 'round', roundIds: ['2026-2'],
      questionCount: null, type: 'code', lang: 'java', timeLimitS: TIME_LIMIT_S,
      questions: CODE_QUESTIONS, at: T0,
    });
    const started = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.start(1, T0 + 30),
      ev.timeout('countdown', T0 + 30 + COUNTDOWN_MS),
    ]);
    const qs = broadcasts(started.effects, 'battle:questions');
    assert.equal(qs.length, 1);
    for (const q of qs[0].payload.questions) {
      assert.deepEqual(Object.keys(q).sort(),
        ['answerMode', 'bodyHtml', 'bodyText', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
      assert.equal(q.lang, 'java');
      assert.equal(q.type, 'code');
      for (const f of q.fields) assert.deepEqual(Object.keys(f), ['label']);
    }
    // 정답 계열 흔적이 페이로드 어디에도 없어야 한다
    assert.equal(/accept|sampleAnswer|validator|display|explanationHtml/.test(JSON.stringify(qs[0].payload)), false);

    const back = drive(started.state, [ev.disconnect(1, T0 + 5000), ev.connect(1, T0 + 6000)]);
    const rsync = broadcasts(back.effects, 'battle:resync')[0];
    assert.equal(rsync.payload.settings.lang, 'java');
    for (const q of rsync.payload.questions) assert.equal(q.lang, 'java');
  });

  test('publicQuestion 의 lang 은 코드 문항에만 붙는다', () => {
    assert.equal(battle.publicQuestion(CODE_QUESTIONS[0]).lang, 'java');
    // 유형이 코드가 아니면 lang 필드가 있어도 무시한다
    assert.equal(battle.publicQuestion(Object.assign(makeQuestion('2026-2', 3, ['x']), { type: 'sql', lang: 'java' })).lang, null);
    // 유형 미지정(=theory 기본값)도 마찬가지
    assert.equal(battle.publicQuestion(makeQuestion('2026-2', 4, ['x'])).lang, null);
    // 허용값 밖의 언어는 null
    assert.equal(battle.publicQuestion(Object.assign(makeQuestion('2026-2', 5, ['x']), { type: 'code', lang: 'ruby' })).lang, null);
  });

  test('lang 은 진행 중에 바뀌지 않는다 (방 생성 시 1회)', () => {
    const created = createRoom({
      roomId: 'ROOM1', name: '자바방', hostUserId: 1, mode: 'round', roundIds: ['2026-2'],
      questionCount: null, type: 'code', lang: 'java', timeLimitS: TIME_LIMIT_S,
      questions: CODE_QUESTIONS, at: T0,
    });
    const r = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.join(2, '다라', T0 + 20),
      ev.start(1, T0 + 30),
      ev.timeout('countdown', T0 + 30 + COUNTDOWN_MS),
      ev.submit(1, T0 + 5000),
      ev.submit(2, T0 + 6000),
    ]);
    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.lang, 'java');
  });
});

// ------------------------------------------------ 방 정원 · 디바운스 키 · 조용한 파기

describe('방 정원 (ROOM_FULL)', () => {
  test('MAX_PLAYERS 명까지 들어오고 그 다음 신규 입장은 ROOM_FULL 로 거부된다', () => {
    const created = newRoom();
    const events = [];
    for (let i = 1; i <= MAX_PLAYERS; i += 1) events.push(ev.join(i, '유저' + i, T0 + i));
    const full = drive(created.state, events);
    assert.equal(full.state.playerOrder.length, MAX_PLAYERS);
    assert.equal(errors(full.effects).length, 0);          // 정원까지는 에러 0건

    const over = applyEvent(full.state, ev.join(MAX_PLAYERS + 1, '초과', T0 + 100));
    assert.equal(over.state.playerOrder.length, MAX_PLAYERS); // 명부가 늘지 않는다
    assert.equal(over.state.players[MAX_PLAYERS + 1], undefined);
    const errs = errors(over.effects);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].payload.code, 'ROOM_FULL');
    assert.equal(errs[0].to, MAX_PLAYERS + 1);
    // 거부된 join 은 방 상태를 바꾸지 않으므로 room:state 도 나가지 않는다
    assert.equal(broadcasts(over.effects, 'room:state').length, 0);
  });

  test('정원이 찼어도 이미 명부에 있는 사람의 복귀는 통과한다', () => {
    const created = newRoom();
    const events = [];
    for (let i = 1; i <= MAX_PLAYERS; i += 1) events.push(ev.join(i, '유저' + i, T0 + i));
    events.push(ev.disconnect(3, T0 + 50));
    const full = drive(created.state, events);
    assert.equal(full.state.players[3].connected, false);

    const back = applyEvent(full.state, ev.join(3, '유저3', T0 + 60));
    assert.equal(errors(back.effects).length, 0);            // ROOM_FULL 아님
    assert.equal(back.state.players[3].connected, true);
    assert.equal(back.state.playerOrder.length, MAX_PLAYERS); // 정원은 그대로
  });

  test('leave 로 자리가 나면 다시 들어올 수 있다', () => {
    const created = newRoom();
    const events = [];
    for (let i = 1; i <= MAX_PLAYERS; i += 1) events.push(ev.join(i, '유저' + i, T0 + i));
    events.push(ev.leave(2, T0 + 50));
    const freed = drive(created.state, events);
    assert.equal(freed.state.playerOrder.length, MAX_PLAYERS - 1);

    const joined = applyEvent(freed.state, ev.join(99, '새사람', T0 + 60));
    assert.equal(errors(joined.effects).length, 0);
    assert.equal(joined.state.playerOrder.length, MAX_PLAYERS);
  });
});

describe('battle:progress 디바운스 키 (서버 M-1)', () => {
  test('answer 는 debounceMs 와 debounceKey 를 함께 단다', () => {
    const base = playingRoom();
    const r = applyEvent(base.state, ev.answer(1, '2026-2#1', '동치분할', T0 + 4000));
    const progs = broadcasts(r.effects, 'battle:progress');
    assert.equal(progs.length, 1);
    assert.equal(progs[0].debounceMs, battle.PROGRESS_DEBOUNCE_MS);
    assert.equal(progs[0].debounceKey, 'ROOM1:progress:1');
  });

  test('submit 의 즉시 방송은 같은 debounceKey 를 달되 debounceMs 는 달지 않는다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(1, '2026-2#1', '동치분할', T0 + 4000),
      ev.submit(1, T0 + 4100),
    ]);
    const progs = broadcasts(r.effects, 'battle:progress');
    assert.equal(progs.length, 2);
    // 두 방송의 키가 같아야 어댑터가 지연 중인 앞의 것을 버릴 수 있다
    assert.equal(progs[0].debounceKey, progs[1].debounceKey);
    assert.equal(progs[1].debounceMs, undefined);
    assert.equal(progs[1].payload.submitted, true);
  });

  test('playing 중 leave 의 즉시 방송도 같은 규칙을 따른다', () => {
    const base = playingRoom();
    const r = drive(base.state, [
      ev.answer(2, '2026-2#1', '동치분할', T0 + 4000),
      ev.leave(2, T0 + 4100),
    ]);
    const progs = broadcasts(r.effects, 'battle:progress').filter((f) => f.payload.userId === 2);
    assert.equal(progs.length, 2);
    assert.equal(progs[0].debounceKey, 'ROOM1:progress:2');
    assert.equal(progs[1].debounceKey, 'ROOM1:progress:2');
    assert.equal(progs[1].debounceMs, undefined);
  });
});

describe('격자표 정합 — playing + timeout(abandon) 은 아무것도 방송하지 않는다', () => {
  test('abandoned 전이에는 broadcast 이펙트가 0건이다 (서버 L-11 drift)', () => {
    const base = playingRoom();
    const t = T0 + 5000;
    const dropped = drive(base.state, [ev.disconnect(1, t), ev.disconnect(2, t + 10)]);
    const gone = applyEvent(dropped.state, ev.timeout('abandon', t + 10 + ABANDON_GRACE_MS));

    assert.equal(gone.state.state, 'abandoned');
    // 접속자가 0명인 것이 전제인 셀이라 받을 사람이 없다 — cancel 두 건만 남는다
    assert.equal(gone.effects.filter((f) => f.type === 'broadcast').length, 0);
    assert.equal(persists(gone.effects).length, 0);
    assert.deepEqual(
      gone.effects.map((f) => f.type + ':' + (f.key || '')).sort(),
      ['cancel:ROOM1:abandon', 'cancel:ROOM1:deadline']
    );
  });
});

// ==================================================================
// 격자표 전수 (서버 H-6)
//
// `docs/battle-state-grid.md` 는 상태 5 × 이벤트 12 = **60셀**을 전부 정의한다.
// 위쪽 describe 들은 "실제로 일어나는 일"(정상 진행·이탈·승자 판정)을 검증하고,
// 여기서는 그 격자를 **셀 단위로** 훑는다 — 특히 아무 일도 일어나지 않아야 하는 셀들.
// 리듀서가 순수 함수라 셀 하나가 3~5줄이면 끝나고, 표와 코드가 어긋나면 여기가 먼저 깨진다.
// ==================================================================

/** 격자표의 이벤트 12종을 그 순서대로. `uid` 는 명부에 있는 참가자여야 하는 이벤트에 쓴다. */
function gridEvents(at, uid) {
  const u = uid == null ? 1 : uid;
  return [
    ['join', ev.join(99, '난입자', at)],
    ['leave', ev.leave(u, at)],
    ['start', ev.start(u, at)],
    ['answer', ev.answer(u, QUESTIONS[0].id, 'zzz', at)],
    ['submit', ev.submit(u, at)],
    ['disconnect', ev.disconnect(u, at)],
    ['connect', ev.connect(u, at)],
    ['tick', ev.tick(at)],
    ['timeout(countdown)', ev.timeout('countdown', at)],
    ['timeout(deadline)', ev.timeout('deadline', at)],
    ['timeout(abandon)', ev.timeout('abandon', at)],
    ['timeout(roomGc)', ev.timeout('roomGc', at)],
  ];
}

const T_LATE = T0 + 9_000_000; // 어떤 픽스처의 lastAt 보다도 확실히 뒤

/** 2인 방을 전원 제출로 끝낸 `finished` state. */
function finishedState() {
  const r = playingRoom();
  const done = drive(r.state, [ev.submit(1, T0 + 100), ev.submit(2, T0 + 110)]);
  assert.equal(done.state.state, 'finished');
  return done.state;
}

/** 아무도 들어오지 않은 빈 방이 GC 된 `abandoned` state. */
function abandonedState() {
  const created = newRoom();
  const gone = drive(created.state, [ev.timeout('roomGc', T0 + ROOM_GC_MS)]);
  assert.equal(gone.state.state, 'abandoned');
  return gone.state;
}

/** 2인이 준비를 마치고 카운트다운 중인 state. */
function countdownState(extraJoins) {
  const created = newRoom();
  const evs = [ev.join(1, '가나', T0 + 10), ev.join(2, '다라', T0 + 20)];
  for (const pair of extraJoins || []) evs.push(ev.join(pair[0], pair[1], T0 + 25));
  evs.push(ev.start(1, T0 + 30));
  const r = drive(created.state, evs);
  assert.equal(r.state.state, 'countdown');
  return r.state;
}

// ------------------------------------------------ finished / abandoned (24셀)
//
// 표: "리듀서에 늦게 도착한 이벤트는 전부 무시하고 이펙트를 내지 않는다 —
//      **에러 이벤트조차 내지 않는다**(종료 브로드캐스트 뒤에 에러가 따라붙으면 결과 화면을 망친다)."
// 그래서 셀마다 ① 상태 불변 ② 이펙트 0건 ③ 입력 state 불변 ④ lastAt 만 전진 을 본다.

for (const pair of [['finished', finishedState], ['abandoned', abandonedState]]) {
  const label = pair[0];
  const make = pair[1];
  describe('격자표 ' + label + ' — 12 이벤트 전부 무시, 이펙트 0건', () => {
    for (const cell of gridEvents(T_LATE)) {
      const name = cell[0];
      const event = cell[1];
      test(label + ' + ' + name, () => {
        const s0 = make();
        const before = JSON.stringify(s0);
        const r = applyEvent(s0, event);

        assert.equal(r.state.state, label, '상태가 바뀌었다');
        assert.deepEqual(r.effects, [], '이펙트를 냈다: ' + JSON.stringify(r.effects));
        assert.equal(JSON.stringify(s0), before, '입력 state 가 변형됐다');
        assert.notEqual(r.state, s0, '새 객체를 돌려줘야 한다');
        assert.equal(r.state.lastAt, T_LATE, 'lastAt 은 전진해야 한다');
        // 종료 시각·결과는 늦게 온 이벤트가 덮어쓰지 않는다
        assert.equal(r.state.finishedAt, s0.finishedAt);
      });
    }
  });
}

// --------------------------------------------------- timeout(roomGc) 5상태

describe('격자표 timeout(roomGc) — 5상태 전부', () => {
  test('waiting + 접속자 0 → abandoned (persist·broadcast 없음, 타이머 4종 정리)', () => {
    const created = newRoom();
    const at = T0 + ROOM_GC_MS;
    const r = applyEvent(created.state, ev.timeout('roomGc', at));

    assert.equal(r.state.state, 'abandoned');
    assert.equal(r.state.finishedAt, at);
    assert.equal(isDisposed(r.state), true);
    assert.deepEqual(persists(r.effects), [], '전적을 남기면 안 된다');
    assert.deepEqual(r.effects.filter((f) => f.type === 'broadcast'), [], '수신자가 0명이므로 방송하지 않는다');
    assert.deepEqual(
      r.effects.map((f) => f.key).sort(),
      ['ROOM1:abandon', 'ROOM1:countdown', 'ROOM1:deadline', 'ROOM1:roomGc']
    );
  });

  test('waiting + 접속자가 남아 있으면 stale — 아무 일도 없다', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    const r = applyEvent(joined.state, ev.timeout('roomGc', T0 + ROOM_GC_MS));

    assert.equal(r.state.state, 'waiting');
    assert.deepEqual(r.effects, []);
  });

  test('waiting + 전원 끊김(명부는 남음) → abandoned', () => {
    // disconnect 는 명부를 줄이지 않는다 — 접속자만 0이 된다. 그래도 GC 대상이다.
    const created = newRoom();
    const r0 = drive(created.state, [
      ev.join(1, '가나', T0 + 10),
      ev.disconnect(1, T0 + 20),
    ]);
    assert.equal(r0.state.playerOrder.length, 1);
    const r = applyEvent(r0.state, ev.timeout('roomGc', T0 + 20 + ROOM_GC_MS));
    assert.equal(r.state.state, 'abandoned');
  });

  test('countdown + roomGc 는 stale (start 에서 cancel 됐다)', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.timeout('roomGc', T0 + 100));
    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.effects, []);
  });

  test('playing + roomGc 는 stale', () => {
    const s = playingRoom().state;
    const r = applyEvent(s, ev.timeout('roomGc', T0 + 100));
    assert.equal(r.state.state, 'playing');
    assert.deepEqual(r.effects, []);
  });

  test('finished / abandoned + roomGc 는 아무것도 하지 않는다', () => {
    for (const s of [finishedState(), abandonedState()]) {
      const r = applyEvent(s, ev.timeout('roomGc', T_LATE));
      assert.equal(r.state.state, s.state);
      assert.deepEqual(r.effects, []);
    }
  });
});

// --------------------------------------------- playing + tick / timeout(deadline)

describe('격자표 playing + tick', () => {
  test('마감 전이면 battle:tick 만 내고 상태는 그대로', () => {
    const s = playingRoom().state;
    const at = s.startedAt + 5000;
    const r = applyEvent(s, ev.tick(at));

    assert.equal(r.state.state, 'playing');
    const ticks = broadcasts(r.effects, 'battle:tick');
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].payload.remainingMs, s.deadline - at);
    assert.equal(ticks[0].to, undefined, '방 전체 방송이다');
    assert.deepEqual(persists(r.effects), []);
  });

  test('at >= deadline 이면 tick 이 곧바로 종료시킨다 (절전 복귀 방어)', () => {
    // deadline 타이머가 잠든 사이 지나가 버렸어도 tick 한 번으로 서버가 재검증해 끝낸다.
    const s = playingRoom().state;
    const r = applyEvent(s, ev.tick(s.deadline));

    assert.equal(r.state.state, 'finished');
    assert.equal(r.state.finishedAt, s.deadline);
    assert.equal(persists(r.effects).length, 1, '전적은 저장된다');
    assert.equal(broadcasts(r.effects, 'battle:finished').length, 2, '참가자 수만큼 간다');
    assert.equal(broadcasts(r.effects, 'battle:tick').length, 0, '마감 뒤에는 tick 을 내지 않는다');
    assert.equal(broadcasts(r.effects, 'battle:marks').length, 0, '종료 이벤트는 정오표를 내지 않는다');
    const fin = broadcasts(r.effects, 'battle:finished')[0];
    assert.equal(fin.payload.reason, 'deadline');
  });

  test('deadline 을 한참 넘긴 tick 도 같은 경로로 끝난다', () => {
    const s = playingRoom().state;
    const r = applyEvent(s, ev.tick(s.deadline + 60000));
    assert.equal(r.state.state, 'finished');
    assert.equal(persists(r.effects).length, 1);
  });
});

describe('격자표 playing + timeout(deadline)', () => {
  test('타이머가 이르게 깨어나면 무시하고 같은 시각으로 재예약한다', () => {
    const s = playingRoom().state;
    const early = s.deadline - 1500;
    const r = applyEvent(s, ev.timeout('deadline', early));

    assert.equal(r.state.state, 'playing', '이르게 끝내면 안 된다');
    assert.deepEqual(persists(r.effects), []);
    const again = schedules(r.effects, 'ROOM1:deadline');
    assert.equal(again.length, 1, '재예약이 없으면 대전이 영영 안 끝난다');
    assert.equal(again[0].at, s.deadline);
    assert.deepEqual(r.effects.filter((f) => f.type === 'broadcast'), []);
  });

  test('재예약된 타이머가 제때 오면 정상 종료한다', () => {
    const s = playingRoom().state;
    const early = applyEvent(s, ev.timeout('deadline', s.deadline - 1500));
    const onTime = applyEvent(early.state, ev.timeout('deadline', s.deadline));

    assert.equal(onTime.state.state, 'finished');
    assert.equal(persists(onTime.effects).length, 1);
    assert.equal(broadcasts(onTime.effects, 'battle:finished')[0].payload.reason, 'deadline');
  });
});

// ---------------------------------------------------------- countdown 12셀

describe('격자표 countdown — 12셀', () => {
  test('join → ROOM_NOT_JOINABLE, 명부는 늘지 않는다', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.join(9, '난입자', T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.state.playerOrder, [1, 2]);
    assert.equal(r.state.players[9], undefined);
    assert.equal(r.effects.length, 1);
    assert.equal(errors(r.effects)[0].payload.code, 'ROOM_NOT_JOINABLE');
    assert.equal(errors(r.effects)[0].to, 9, '거절당한 본인에게만 간다');
  });

  test('leave 로도 2인이 남으면 카운트다운을 유지한다', () => {
    const s = countdownState([[3, '마바']]);
    const r = applyEvent(s, ev.leave(3, T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.state.playerOrder, [1, 2]);
    assert.equal(r.state.countdownEndsAt, s.countdownEndsAt, '카운트다운 시각은 그대로다');
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
    assert.deepEqual(cancels(r.effects, 'ROOM1:countdown'), [], '취소하면 안 된다');
  });

  test('방장이 나가면 남은 사람이 방장을 승계한다 (카운트다운 유지)', () => {
    const s = countdownState([[3, '마바']]);
    const r = applyEvent(s, ev.leave(1, T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.equal(r.state.hostUserId, 2);
  });

  test('비참가자의 leave 는 무시된다', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.leave(77, T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.state.playerOrder, [1, 2]);
    assert.deepEqual(r.effects, []);
  });

  test('start 중복은 ALREADY_STARTED', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.start(1, T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.equal(r.effects.length, 1);
    assert.equal(errors(r.effects)[0].payload.code, 'ALREADY_STARTED');
  });

  test('answer / submit 은 NOT_PLAYING — 문항이 아직 배포되지 않았다', () => {
    const s = countdownState();
    const cases = [
      ['answer', ev.answer(1, QUESTIONS[0].id, 'x', T0 + 40)],
      ['submit', ev.submit(1, T0 + 40)],
    ];
    for (const c of cases) {
      const r = applyEvent(s, c[1]);
      assert.equal(r.state.state, 'countdown', c[0]);
      assert.equal(r.effects.length, 1, c[0]);
      assert.equal(errors(r.effects)[0].payload.code, 'NOT_PLAYING', c[0]);
      assert.equal(errors(r.effects)[0].to, 1, c[0]);
      // 답안이 보관되면 안 된다
      assert.deepEqual(r.state.players[1].answers, {}, c[0]);
      assert.equal(r.state.players[1].submittedAt, null, c[0]);
    }
  });

  test('disconnect 는 카운트다운을 취소하지 않는다 (명부가 그대로이므로)', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.disconnect(2, T0 + 40));

    assert.equal(r.state.state, 'countdown');
    assert.equal(r.state.players[2].connected, false);
    assert.deepEqual(r.state.playerOrder, [1, 2], '명부는 줄지 않는다');
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
    assert.deepEqual(cancels(r.effects, 'ROOM1:countdown'), []);
    assert.deepEqual(schedules(r.effects, 'ROOM1:roomGc'), [], 'countdown 에는 GC 를 걸지 않는다');
  });

  test('전원이 끊겨도 카운트다운은 계속된다', () => {
    const s = countdownState();
    const r = drive(s, [ev.disconnect(1, T0 + 40), ev.disconnect(2, T0 + 41)]);

    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(schedules(r.effects, 'ROOM1:roomGc'), []);
    assert.deepEqual(cancels(r.effects, 'ROOM1:countdown'), []);
  });

  test('connect 는 room:state 와 본인에게만 가는 battle:resync 를 낸다', () => {
    const s = countdownState();
    const off = applyEvent(s, ev.disconnect(2, T0 + 40));
    const r = applyEvent(off.state, ev.connect(2, T0 + 41));

    assert.equal(r.state.state, 'countdown');
    assert.equal(r.state.players[2].connected, true);
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
    const resync = broadcasts(r.effects, 'battle:resync');
    assert.equal(resync.length, 1);
    assert.equal(resync[0].to, 2);
    // 아직 문항이 배포되기 전이라 정오표가 실릴 수 없다
    assert.equal('marks' in resync[0].payload, false);
  });

  test('비참가자의 connect 는 무시된다 (멤버십 없음)', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.connect(77, T0 + 40));
    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.effects, []);
  });

  test('tick 은 무시된다 (3초 구간은 클라이언트 로컬 애니메이션)', () => {
    const s = countdownState();
    const r = applyEvent(s, ev.tick(T0 + 40));
    assert.equal(r.state.state, 'countdown');
    assert.deepEqual(r.effects, []);
  });

  test('timeout(countdown) → playing: roomGc 취소 · deadline 예약 · 문항 배포', () => {
    const s = countdownState();
    const at = s.countdownEndsAt;
    const r = applyEvent(s, ev.timeout('countdown', at));

    assert.equal(r.state.state, 'playing');
    assert.equal(r.state.startedAt, at);
    assert.equal(r.state.deadline, at + s.timeLimitS * 1000);
    assert.equal(r.state.countdownEndsAt, null);

    assert.equal(cancels(r.effects, 'ROOM1:roomGc').length, 1);
    const dl = schedules(r.effects, 'ROOM1:deadline');
    assert.equal(dl.length, 1);
    assert.equal(dl[0].at, r.state.deadline);
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);

    const qs = broadcasts(r.effects, 'battle:questions');
    assert.equal(qs.length, 1);
    assert.equal(qs[0].to, undefined, '방 전체에 같은 문항이 간다');
    assert.equal(qs[0].payload.questions.length, QUESTIONS.length);
    // 문항은 공개 사본이어야 한다 — 정답 계열이 한 톨도 없다
    assert.equal(/accept|sampleAnswer|validator|display|explanationHtml/.test(JSON.stringify(qs[0].payload)), false);
    // 접속자가 있으므로 abandon 유예는 걸지 않는다
    assert.deepEqual(schedules(r.effects, 'ROOM1:abandon'), []);
  });

  test('전원이 끊긴 채 카운트다운이 끝나면 abandon 유예까지 함께 건다', () => {
    const s = countdownState();
    const off = drive(s, [ev.disconnect(1, T0 + 40), ev.disconnect(2, T0 + 41)]);
    const r = applyEvent(off.state, ev.timeout('countdown', off.state.countdownEndsAt));

    assert.equal(r.state.state, 'playing');
    const ab = schedules(r.effects, 'ROOM1:abandon');
    assert.equal(ab.length, 1);
    assert.equal(ab[0].at, r.state.startedAt + ABANDON_GRACE_MS);
  });

  test('timeout(deadline) / timeout(abandon) 은 stale — 무시', () => {
    const s = countdownState();
    for (const kind of ['deadline', 'abandon']) {
      const r = applyEvent(s, ev.timeout(kind, T0 + 40));
      assert.equal(r.state.state, 'countdown', kind);
      assert.deepEqual(r.effects, [], kind);
    }
  });
});

// -------------------------------------------- playing + answer 거절 사유 3종

describe('격자표 playing + answer — 거절 사유', () => {
  test('모르는 문항 id 는 UNKNOWN_QUESTION, 답안은 보관되지 않는다', () => {
    const s = playingRoom().state;
    const r = applyEvent(s, ev.answer(1, '없는회차#99', '아무말', T0 + 100));

    assert.equal(r.state.state, 'playing');
    assert.equal(r.effects.length, 1);
    assert.equal(errors(r.effects)[0].payload.code, 'UNKNOWN_QUESTION');
    assert.equal(errors(r.effects)[0].to, 1);
    assert.deepEqual(r.state.players[1].answers, {});
    assert.equal(r.state.players[1].lastAnswerAt, null, '거절된 입력은 마지막 입력 시각도 남기지 않는다');
    assert.deepEqual(broadcasts(r.effects, 'battle:progress'), []);
  });

  test('프로토타입 키(constructor 등)도 UNKNOWN_QUESTION 이다', () => {
    // 문항 색인은 Map 이라 `constructor`·`__proto__` 같은 키가 문항으로 둔갑하지 않는다.
    const s = playingRoom().state;
    for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const r = applyEvent(s, ev.answer(1, bad, 'x', T0 + 100));
      assert.equal(r.effects.length, 1, bad);
      assert.equal(errors(r.effects)[0].payload.code, 'UNKNOWN_QUESTION', bad);
    }
  });

  test('범위 밖 fieldIndex 는 BAD_FIELD', () => {
    const s = playingRoom().state;
    const at = s.lastAt + 100;
    const qid = QUESTIONS[0].id; // fields 1칸짜리
    for (const idx of [1, 2, -1, 1.5, NaN, undefined, 'abc', {}, true]) {
      const r = applyEvent(s, {
        type: 'answer', userId: 1, questionId: qid, fieldIndex: idx, value: 'x', at: at,
      });
      const label = 'fieldIndex=' + String(idx);
      assert.equal(r.state.state, 'playing', label);
      assert.equal(r.effects.length, 1, label);
      assert.equal(errors(r.effects)[0].payload.code, 'BAD_FIELD', label);
      assert.deepEqual(r.state.players[1].answers, {}, label);
    }
  });

  test('fieldIndex 는 Number() 로 강제 변환된다 — "0" · null · [] 은 0번 칸으로 들어간다', () => {
    // 관대한 쪽으로 굳어져 있는 실제 동작을 그대로 못박는다. `Number('0')`·`Number(null)`·
    // `Number([])` 은 모두 0 이라 유효한 칸 번호가 된다. 정답 정보가 새지 않고 자기 답안만
    // 바뀌므로 위험은 없지만, 나중에 엄격해진다면 이 테스트가 먼저 깨져 알려 줄 것이다.
    const s = playingRoom().state;
    const at = s.lastAt + 100;
    for (const idx of ['0', null, []]) {
      const r = applyEvent(s, {
        type: 'answer', userId: 1, questionId: QUESTIONS[0].id, fieldIndex: idx, value: '동치분할', at: at,
      });
      const label = 'fieldIndex=' + String(idx);
      assert.deepEqual(errors(r.effects), [], label);
      assert.deepEqual(r.state.players[1].answers[QUESTIONS[0].id], ['동치분할'], label);
    }
  });

  test('명부에 없는 사용자의 answer / submit 은 NOT_IN_ROOM', () => {
    // 격자표는 이 방어 분기를 따로 적지 않지만(참가자만 이벤트를 보낸다는 전제),
    // 어댑터를 우회한 이벤트가 들어와도 명부를 오염시키지 않는다는 것을 못박는다.
    const s = playingRoom().state;
    const cases = [
      ['answer', ev.answer(77, QUESTIONS[0].id, 'x', T0 + 100)],
      ['submit', ev.submit(77, T0 + 100)],
    ];
    for (const c of cases) {
      const r = applyEvent(s, c[1]);
      assert.equal(r.state.state, 'playing', c[0]);
      assert.equal(errors(r.effects)[0].payload.code, 'NOT_IN_ROOM', c[0]);
      assert.equal(r.state.players[77], undefined, c[0]);
      assert.deepEqual(r.state.playerOrder, [1, 2], c[0]);
    }
  });

  test('정상 answer 는 답안을 보관하고 정오를 흘리지 않는다', () => {
    const s = playingRoom().state;
    const at = s.lastAt + 100; // 리듀서는 lastAt 보다 이른 at 을 클램프한다
    const r = applyEvent(s, ev.answer(1, QUESTIONS[0].id, '동치분할', at));

    assert.deepEqual(r.state.players[1].answers[QUESTIONS[0].id], ['동치분할']);
    assert.equal(r.state.players[1].lastAnswerAt, at);
    const prog = broadcasts(r.effects, 'battle:progress');
    assert.equal(prog.length, 1);
    assert.deepEqual(Object.keys(prog[0].payload).sort(), ['answeredCount', 'userId']);
    assert.equal(prog[0].payload.answeredCount, 1);
    assert.equal(/correct|mark|accept/.test(JSON.stringify(prog[0].payload)), false, '정오를 흘리면 안 된다');
  });
});

// ------------------------------------------------------- playing 나머지 셀
//
// `join` / `start` / `timeout(countdown)` 세 셀은 60셀 훑기(맨 아래)에서 "던지지 않는다" 까지만
// 봤고, **어떤 에러 코드를 내는지·명부를 건드리지 않는지**는 아무도 보지 않았다. 여기서 채운다.

describe('격자표 playing — 나머지 셀', () => {
  test('join → ROOM_NOT_JOINABLE, 명부는 늘지 않는다 (진행 중 난입 금지)', () => {
    const s = playingRoom().state;
    const r = applyEvent(s, ev.join(99, '난입자', T0 + 100));

    assert.equal(r.state.state, 'playing');
    assert.equal(r.effects.length, 1);
    assert.equal(errors(r.effects)[0].payload.code, 'ROOM_NOT_JOINABLE');
    assert.equal(errors(r.effects)[0].to, 99);
    assert.deepEqual(Object.keys(r.state.players).sort(), ['1', '2'], '명부가 늘었다');
    assert.equal(r.state.playerOrder.includes(99), false);
  });

  test('start 중복은 ALREADY_STARTED — 문항도 마감도 다시 정해지지 않는다', () => {
    const s = playingRoom().state;
    const r = applyEvent(s, ev.start(1, T0 + 100));

    assert.equal(r.state.state, 'playing');
    assert.equal(r.effects.length, 1);
    assert.equal(errors(r.effects)[0].payload.code, 'ALREADY_STARTED');
    assert.equal(errors(r.effects)[0].to, 1);
    assert.equal(r.state.deadline, s.deadline, '마감이 밀렸다');
    assert.equal(r.state.startedAt, s.startedAt);
    assert.deepEqual(broadcasts(r.effects, 'battle:questions'), [], '문항을 다시 배포하면 안 된다');
  });

  test('timeout(countdown) 은 stale — 조용히 무시한다 (에러조차 내지 않는다)', () => {
    // 내부 이벤트라 보낼 대상이 없다. 카운트다운은 이미 이 방을 playing 으로 만들고 끝났다.
    const s = playingRoom().state;
    const r = applyEvent(s, ev.timeout('countdown', T0 + 100));

    assert.equal(r.state.state, 'playing');
    assert.deepEqual(r.effects, [], '이펙트를 냈다: ' + JSON.stringify(r.effects));
    assert.equal(r.state.deadline, s.deadline);
    assert.notEqual(r.state, s, '새 객체를 돌려줘야 한다');
  });
});

// ------------------------------------------------------- waiting 나머지 셀

describe('격자표 waiting — 나머지 셀', () => {
  test('방장이 나가면 playerOrder[0] 이 방장을 승계한다 (명부가 남은 경우)', () => {
    // 표 `waiting + leave`: "방장이 나가면 playerOrder[0] 로 방장 승계".
    // 전원 퇴장(hostUserId=null) 경로는 위에서 봤고, 여기서는 **남은 사람이 있는** 경로다.
    const created = newRoom();
    const joined = drive(created.state, [
      ev.join(1, '가나', T0 + 10), ev.join(2, '다라', T0 + 20), ev.join(3, '마바', T0 + 30),
    ]);
    const r = applyEvent(joined.state, ev.leave(1, T0 + 40));

    assert.equal(r.state.state, 'waiting');
    assert.equal(r.state.hostUserId, 2, 'playerOrder 의 첫 사람이 방장이 된다');
    assert.deepEqual(r.state.playerOrder, [2, 3]);
    assert.equal(r.state.players[1], undefined, 'waiting 의 leave 는 명부에서 지운다');
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
    assert.deepEqual(schedules(r.effects, 'ROOM1:roomGc'), [], '아직 사람이 남아 GC 를 걸지 않는다');
  });

  test('answer / submit 은 NOT_PLAYING (대전 시작 전)', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    const cases = [
      ['answer', ev.answer(1, QUESTIONS[0].id, 'x', T0 + 20)],
      ['submit', ev.submit(1, T0 + 20)],
    ];
    for (const c of cases) {
      const r = applyEvent(joined.state, c[1]);
      assert.equal(r.state.state, 'waiting', c[0]);
      assert.equal(r.effects.length, 1, c[0]);
      assert.equal(errors(r.effects)[0].payload.code, 'NOT_PLAYING', c[0]);
    }
  });

  test('tick 은 무시된다 (대기실에는 남은 시간 개념이 없다)', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    const r = applyEvent(joined.state, ev.tick(T0 + 20));
    assert.equal(r.state.state, 'waiting');
    assert.deepEqual(r.effects, []);
  });

  test('countdown / deadline / abandon 타임아웃은 전부 stale', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    for (const kind of ['countdown', 'deadline', 'abandon']) {
      const r = applyEvent(joined.state, ev.timeout(kind, T0 + 20));
      assert.equal(r.state.state, 'waiting', kind);
      assert.deepEqual(r.effects, [], kind);
    }
  });

  test('leave 로 0명이 되면 GC 를 예약하고, 비참가자의 leave 는 무시된다', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);

    const stranger = applyEvent(joined.state, ev.leave(77, T0 + 20));
    assert.deepEqual(stranger.effects, [], '비참가자');
    assert.deepEqual(stranger.state.playerOrder, [1]);

    const gone = applyEvent(joined.state, ev.leave(1, T0 + 20));
    assert.deepEqual(gone.state.playerOrder, []);
    assert.equal(gone.state.hostUserId, null, '방장이 비워진다');
    assert.equal(broadcasts(gone.effects, 'room:state').length, 1);
    const gc = schedules(gone.effects, 'ROOM1:roomGc');
    assert.equal(gc.length, 1);
    assert.equal(gc[0].at, T0 + 20 + ROOM_GC_MS);
  });

  test('disconnect 로 접속자가 0이 되면 GC 를 예약한다 (명부는 그대로)', () => {
    const created = newRoom();
    const joined = drive(created.state, [ev.join(1, '가나', T0 + 10)]);
    const r = applyEvent(joined.state, ev.disconnect(1, T0 + 20));

    assert.equal(r.state.players[1].connected, false);
    assert.deepEqual(r.state.playerOrder, [1], '명부를 줄이는 것은 leave 뿐이다');
    assert.equal(schedules(r.effects, 'ROOM1:roomGc').length, 1);

    const stranger = applyEvent(joined.state, ev.disconnect(77, T0 + 20));
    assert.deepEqual(stranger.effects, [], '비참가자의 disconnect 는 무시');
  });

  test('connect 는 GC 를 취소하고 resync 를 본인에게만 보낸다', () => {
    const created = newRoom();
    const off = drive(created.state, [ev.join(1, '가나', T0 + 10), ev.disconnect(1, T0 + 20)]);
    const r = applyEvent(off.state, ev.connect(1, T0 + 30));

    assert.equal(r.state.players[1].connected, true);
    assert.equal(cancels(r.effects, 'ROOM1:roomGc').length, 1);
    assert.equal(broadcasts(r.effects, 'room:state').length, 1);
    const resync = broadcasts(r.effects, 'battle:resync');
    assert.equal(resync.length, 1);
    assert.equal(resync[0].to, 1);
    assert.equal('marks' in resync[0].payload, false);

    const stranger = applyEvent(off.state, ev.connect(77, T0 + 30));
    assert.deepEqual(stranger.effects, [], '비참가자의 connect 는 무시');
  });

  test('userId 없는 join 은 조용히 무시된다 (명부 오염 방지)', () => {
    const created = newRoom();
    const r = applyEvent(created.state, { type: 'join', nickname: '이름만', at: T0 + 10 });
    assert.deepEqual(r.state.playerOrder, []);
    assert.deepEqual(r.effects, []);
  });
});

// ------------------------------------------- 격자 60셀 — 미정의 전이 0건

describe('격자표 60셀 — 미정의 전이 0건', () => {
  test('5상태 × 12이벤트 어느 조합에서도 던지지 않고 항상 새 state 를 돌려준다', () => {
    const fixtures = [
      ['waiting', drive(newRoom().state, [ev.join(1, '가나', T0 + 10), ev.join(2, '다라', T0 + 20)]).state],
      ['countdown', countdownState()],
      ['playing', playingRoom().state],
      ['finished', finishedState()],
      ['abandoned', abandonedState()],
    ];
    let cells = 0;
    for (const fx of fixtures) {
      const label = fx[0];
      const s0 = fx[1];
      assert.equal(s0.state, label);
      const before = JSON.stringify(s0);
      for (const cell of gridEvents(T_LATE)) {
        const where = label + ' + ' + cell[0];
        const r = applyEvent(s0, cell[1]);
        assert.ok(r && r.state && Array.isArray(r.effects), where);
        assert.notEqual(r.state, s0, where + ': 입력 state 를 그대로 돌려줬다');
        assert.equal(r.state.lastAt, T_LATE, where + ': lastAt 클램프');
        assert.ok(['waiting', 'countdown', 'playing', 'finished', 'abandoned'].includes(r.state.state), where);
        assert.equal(JSON.stringify(s0), before, where + ': 입력 state 가 변형됐다');
        cells += 1;
      }
    }
    assert.equal(cells, 60, '격자표는 5 × 12 = 60셀이다');
  });
});
