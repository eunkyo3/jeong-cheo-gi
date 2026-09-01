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
  COUNTDOWN_MS, ABANDON_GRACE_MS, ROOM_GC_MS,
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
