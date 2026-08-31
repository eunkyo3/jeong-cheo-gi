'use strict';
/**
 * battle.js — 대전 상태 머신 (순수 리듀서, Phase 4 동결 계약)
 *
 *   applyEvent(state, event) → { state, effects: [] }
 *
 * 규약 (PROTOCOL.md "리듀서 계약"):
 *   - 순수 함수. I/O·타이머·소켓 접근 금지. **Date.now() 호출 금지.**
 *     시간은 오직 `event.at` (epoch ms) 으로 주입된다.
 *   - `at = Math.max(event.at, state.lastAt)` 클램프로 시계 역행을 방어한다.
 *   - 입력 state 를 절대 변형하지 않는다. 항상 새 객체를 반환한다("무시" 셀도 포함 —
 *     lastAt 클램프는 반드시 전진해야 하기 때문).
 *   - effects 4종(broadcast / persist / schedule / cancel) 만 반환한다.
 *     영속화·타이머 결정까지 리듀서가 담당하며 battle-io 는 1:1 위임만 한다.
 *
 * 상태×이벤트 60셀 전수 표는 `docs/battle-state-grid.md` 에 있다.
 *
 * require 는 grader.js 하나뿐이다 — 순수 함수 모듈이라 리듀서의 순수성을 깨지 않는다.
 */

const { gradeSet } = require('./grader.js');

// --------------------------------------------------------------- 상수

const STATES = ['waiting', 'countdown', 'playing', 'finished', 'abandoned'];
const EVENTS = ['join', 'leave', 'start', 'answer', 'submit', 'disconnect', 'connect', 'tick', 'timeout'];
const TIMEOUT_KINDS = ['countdown', 'deadline', 'abandon', 'roomGc'];

const COUNTDOWN_MS = 3000;      // waiting → playing 사이 카운트다운
const ABANDON_GRACE_MS = 60000; // playing 중 전원 끊김 유예
const ROOM_GC_MS = 60000;       // 빈 waiting 방 삭제 유예
const PROGRESS_DEBOUNCE_MS = 400;

// --------------------------------------------------------- effect 생성기

function timerKey(state, kind) {
  return state.roomId + ':' + kind;
}

function fxBroadcast(state, event, payload, to) {
  const e = { type: 'broadcast', room: state.roomId, event: event, payload: payload };
  if (to !== undefined && to !== null) e.to = to;
  return e;
}

function fxSchedule(state, kind, at) {
  return {
    type: 'schedule',
    key: timerKey(state, kind),
    at: at,
    timeout: { kind: kind, roomId: state.roomId },
  };
}

function fxCancel(state, kind) {
  return { type: 'cancel', key: timerKey(state, kind) };
}

// ------------------------------------------------------------ 상태 복제

function cloneAnswers(answers) {
  const out = {};
  const keys = Object.keys(answers || {});
  for (let i = 0; i < keys.length; i++) out[keys[i]] = (answers[keys[i]] || []).slice();
  return out;
}

/** marks 는 { [questionId]: boolean } — 정오 불리언만. 답 내용·display 는 절대 담지 않는다. */
function cloneMarks(m) {
  if (m == null) return null;
  const out = {};
  const keys = Object.keys(m);
  for (let i = 0; i < keys.length; i++) out[keys[i]] = !!m[keys[i]];
  return out;
}

function clonePlayer(p) {
  return {
    userId: p.userId,
    nickname: p.nickname,
    connected: p.connected,
    left: p.left,
    joinedAt: p.joinedAt,
    answers: cloneAnswers(p.answers),
    lastAnswerAt: p.lastAnswerAt,
    submittedAt: p.submittedAt,
    marks: cloneMarks(p.marks),
  };
}

function cloneState(s) {
  const players = {};
  for (let i = 0; i < s.playerOrder.length; i++) {
    const id = s.playerOrder[i];
    players[id] = clonePlayer(s.players[id]);
  }
  return {
    roomId: s.roomId,
    name: s.name,
    hostUserId: s.hostUserId,
    mode: s.mode,
    roundIds: s.roundIds.slice(),
    questionCount: s.questionCount,
    timeLimitS: s.timeLimitS,
    questions: s.questions,        // 불변 데이터 — 참조 공유
    questionIds: s.questionIds.slice(),
    state: s.state,
    players: players,
    playerOrder: s.playerOrder.slice(),
    createdAt: s.createdAt,
    lastAt: s.lastAt,
    countdownEndsAt: s.countdownEndsAt,
    startedAt: s.startedAt,
    deadline: s.deadline,
    finishedAt: s.finishedAt,
    result: s.result,
  };
}

// --------------------------------------------------------------- 조회기

function playerList(s) {
  return s.playerOrder.map(function (id) { return s.players[id]; });
}

function connectedCount(s) {
  let n = 0;
  const list = playerList(s);
  for (let i = 0; i < list.length; i++) if (list[i].connected) n++;
  return n;
}

function questionById(s, id) {
  for (let i = 0; i < s.questions.length; i++) if (s.questions[i].id === id) return s.questions[i];
  return null;
}

/** 클라이언트로 나가는 문항에서 정답 계열 필드를 전부 제거한다(치팅 방어 1차선). */
function publicQuestion(q) {
  return {
    id: q.id,
    num: q.num,
    prompt: q.prompt,
    bodyHtml: q.bodyHtml,
    bodyText: q.bodyText, // 결과 화면 "AI에게 질문하기" 프롬프트용 — 정답 정보가 아니므로 허용 (PROTOCOL 치팅 방어 참조)
    // explanationHtml 은 화이트리스트에 없다 — 정답을 그대로 담고 있어 battle:finished 에서만 나간다.

    answerMode: q.answerMode === 'unordered' ? 'unordered' : 'ordered',
    fields: (q.fields || []).map(function (f) { return { label: f.label == null ? null : f.label }; }),
  };
}

/** answeredCount = 모든 필드가 비어 있지 않은 문항 수. */
function answeredCount(s, p) {
  let n = 0;
  for (let i = 0; i < s.questions.length; i++) {
    const q = s.questions[i];
    const fields = q.fields || [];
    if (fields.length === 0) continue;
    const a = p.answers[q.id];
    if (!a) continue;
    let all = true;
    for (let f = 0; f < fields.length; f++) {
      if (a[f] == null || String(a[f]).trim() === '') { all = false; break; }
    }
    if (all) n++;
  }
  return n;
}

function playersPayload(s) {
  return playerList(s).map(function (p) {
    return {
      userId: p.userId,
      nickname: p.nickname,
      connected: p.connected,
      left: p.left,
      submitted: p.submittedAt != null,
      answeredCount: answeredCount(s, p),
    };
  });
}

/**
 * 제출 확정 시 그 참가자의 보관 답안을 한 번 채점해 문항별 정오만 남긴다.
 * `gradeSet` 은 순수 함수라 리듀서 안에서 불러도 계약(순수성)을 깨지 않는다.
 */
function marksOf(s, p) {
  const details = gradeSet(s.questions, p.answers).details;
  const out = {};
  for (let i = 0; i < details.length; i++) out[details[i].questionId] = !!details[i].correct;
  return out;
}

/** 지금까지 제출을 마친 참가자들의 정오표(playerOrder 순). 미제출자는 목록에 없다. */
function marksList(s) {
  const out = [];
  const list = playerList(s);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.submittedAt == null) continue;
    out.push({ userId: p.userId, nickname: p.nickname, marks: cloneMarks(p.marks) });
  }
  return out;
}

function settingsPayload(s) {
  return {
    roomId: s.roomId,
    name: s.name,
    hostUserId: s.hostUserId,
    mode: s.mode,
    roundIds: s.roundIds.slice(),
    questionCount: s.questionIds.length,
    timeLimitS: s.timeLimitS,
  };
}

function roomStatePayload(s) {
  return { state: s.state, players: playersPayload(s), settings: settingsPayload(s) };
}

function remainingMs(s, at) {
  if (s.deadline == null) return null;
  return Math.max(0, s.deadline - at);
}

function deadlineInfo(s, at) {
  return {
    startedAt: s.startedAt,
    deadline: s.deadline,
    timeLimitS: s.timeLimitS,
    remainingMs: remainingMs(s, at),
  };
}

function resyncPayload(s, p, at) {
  const showQuestions = s.state === 'playing' || s.state === 'finished';
  const payload = {
    state: s.state,
    questions: showQuestions ? s.questions.map(publicQuestion) : [],
    myAnswers: cloneAnswers(p.answers),
    remainingMs: remainingMs(s, at),
    players: playersPayload(s),
    settings: settingsPayload(s),
    submitted: p.submittedAt != null,
    deadlineInfo: s.deadline == null ? null : deadlineInfo(s, at),
  };
  // 제출자에게만 정오표를 되돌려 준다 — 미제출자에게는 필드 자체가 없다(누출 방지).
  if (s.state === 'playing' && p.submittedAt != null) payload.marks = marksList(s);
  return payload;
}

// ------------------------------------------------------------ 방 생성

/**
 * createRoom(opts) → { state, effects }
 * questions 는 호출자(index.js)가 rounds.js + buildQuestionSet 으로 미리 확정해 넘긴다.
 * 리듀서 안에서 RNG 를 돌리지 않기 위한 분리다.
 */
function createRoom(opts) {
  const o = opts || {};
  const at = Number(o.at) || 0;
  const questions = (o.questions || []).slice();
  const state = {
    roomId: String(o.roomId),
    name: String(o.name == null ? '' : o.name),
    hostUserId: o.hostUserId,
    mode: o.mode === 'random' ? 'random' : 'round',
    roundIds: (o.roundIds || []).slice(),
    questionCount: o.questionCount == null ? null : Number(o.questionCount),
    timeLimitS: Number(o.timeLimitS),
    questions: questions,
    questionIds: questions.map(function (q) { return q.id; }),
    state: 'waiting',
    players: {},
    playerOrder: [],
    createdAt: at,
    lastAt: at,
    countdownEndsAt: null,
    startedAt: null,
    deadline: null,
    finishedAt: null,
    result: null,
  };
  // 빈 방으로 태어나므로 GC 타이머부터 건다. 방장 join 이 곧바로 취소한다.
  return { state: state, effects: [fxSchedule(state, 'roomGc', at + ROOM_GC_MS)] };
}

function isDisposed(state) {
  return state.state === 'finished' || state.state === 'abandoned';
}

// ------------------------------------------------------------ 공통 동작

function errorTo(ctx, s, userId, code, message) {
  if (userId == null) return;
  ctx.effects.push(fxBroadcast(s, 'error', { code: code, message: message }, userId));
}

function pushRoomState(ctx, s) {
  ctx.effects.push(fxBroadcast(s, 'room:state', roomStatePayload(s)));
}

function pushResync(ctx, s, p) {
  ctx.effects.push(fxBroadcast(s, 'battle:resync', resyncPayload(s, p, ctx.at), p.userId));
}

/**
 * 새 제출이 나올 때마다 **제출 완료자 전원에게만** 최신 정오표 전체 목록을 개별 발송한다.
 * 절대 room 브로드캐스트를 쓰지 않는다 — 미제출자에게 새어 나가면 치팅이 된다.
 * (종료 이벤트에서는 부르지 않는다: 결과 화면이 정오표를 대체한다.)
 */
function pushMarks(ctx, s) {
  const list = playerList(s);
  for (let i = 0; i < list.length; i++) {
    if (list[i].submittedAt == null) continue;
    ctx.effects.push(fxBroadcast(s, 'battle:marks', { players: marksList(s) }, list[i].userId));
  }
}

function addPlayer(s, userId, nickname, at) {
  s.players[userId] = {
    userId: userId,
    nickname: nickname == null ? String(userId) : String(nickname),
    connected: true,
    left: false,
    joinedAt: at,
    answers: {},
    lastAnswerAt: null,
    submittedAt: null,
    marks: null, // 제출 확정 시 한 번 채점해 채운다
  };
  s.playerOrder.push(userId);
}

function removePlayer(s, userId) {
  delete s.players[userId];
  const i = s.playerOrder.indexOf(userId);
  if (i !== -1) s.playerOrder.splice(i, 1);
  if (s.hostUserId === userId) s.hostUserId = s.playerOrder.length ? s.playerOrder[0] : null;
}

// ------------------------------------------------------- playing 진입/종료

function beginPlaying(s, ctx) {
  const at = ctx.at;
  s.state = 'playing';
  s.countdownEndsAt = null;
  s.startedAt = at;
  s.deadline = at + s.timeLimitS * 1000;
  ctx.effects.push(fxCancel(s, 'roomGc'));
  ctx.effects.push(fxSchedule(s, 'deadline', s.deadline));
  pushRoomState(ctx, s);
  ctx.effects.push(fxBroadcast(s, 'battle:questions', {
    questions: s.questions.map(publicQuestion),
    deadlineInfo: deadlineInfo(s, at),
  }));
  // 카운트다운 도중 전원이 끊겼다면 곧바로 유예 타이머를 건다.
  if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'abandon', at + ABANDON_GRACE_MS));
}

/** 승자 판정 체인 ①정답수 ②제출시각 ③마지막 answer 시각 ④무승부(null) */
function pickWinner(rows) {
  if (rows.length === 0) return null;
  const chain = [
    function (a, b) { return b.correctCount - a.correctCount; },
    function (a, b) { return a.effectiveSubmittedAt - b.effectiveSubmittedAt; },
    function (a, b) { return a.effectiveLastAnswerAt - b.effectiveLastAnswerAt; },
  ];
  let pool = rows.slice();
  for (let i = 0; i < chain.length; i++) {
    const cmp = chain[i];
    pool = pool.slice().sort(cmp);
    const best = pool[0];
    pool = pool.filter(function (r) { return cmp(best, r) === 0; });
    if (pool.length === 1) return pool[0].userId;
  }
  return null; // 전부 동률 → 무승부
}

function isoOrNull(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

function finish(s, ctx, reason) {
  const at = ctx.at;
  const deadline = s.deadline == null ? at : s.deadline;
  s.state = 'finished';
  s.finishedAt = at;

  const rows = [];
  const detailsByUser = {};
  const list = playerList(s);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const g = gradeSet(s.questions, p.answers);
    detailsByUser[p.userId] = g.details;
    const wrongIds = [];
    for (let k = 0; k < g.details.length; k++) {
      if (g.details[k].correct === false) wrongIds.push(g.details[k].questionId);
    }
    rows.push({
      userId: p.userId,
      nickname: p.nickname,
      correctCount: g.correctCount,
      totalCount: g.totalCount,
      score: g.score,
      wrongIds: wrongIds,
      submittedAt: p.submittedAt,                                              // 실제 제출 시각(미제출 null, 이탈자는 이탈 시각)
      effectiveSubmittedAt: p.submittedAt == null ? deadline : p.submittedAt,   // 판정용 — 미제출자(끊김 후 미복귀)만 deadline
      effectiveLastAnswerAt: p.lastAnswerAt == null ? deadline : p.lastAnswerAt,
      left: p.left,
      answers: p.answers,
    });
  }

  // 채점이 끝났으므로 해설을 내보내도 된다. 수신자와 무관하게 같은 맵이다(순수성 유지 —
  // 필요한 데이터는 이미 s.questions 에 있다). battle:questions / resync / marks 에는 절대 싣지 않는다.
  const explanations = {};
  for (let i = 0; i < s.questions.length; i++) {
    const q = s.questions[i];
    explanations[q.id] = q.explanationHtml == null ? '' : q.explanationHtml;
  }

  const winnerUserId = pickWinner(rows);
  const publicResults = rows.map(function (r) {
    return {
      userId: r.userId,
      nickname: r.nickname,
      correctCount: r.correctCount,
      totalCount: r.totalCount,
      score: r.score,
      submittedAt: r.submittedAt,
      effectiveSubmittedAt: r.effectiveSubmittedAt,
      left: r.left,
    };
  });
  s.result = { results: publicResults, winnerUserId: winnerUserId, reason: reason };

  ctx.effects.push(fxCancel(s, 'deadline'));
  ctx.effects.push(fxCancel(s, 'abandon'));
  ctx.effects.push(fxCancel(s, 'countdown'));
  ctx.effects.push(fxCancel(s, 'roomGc'));
  pushRoomState(ctx, s);

  for (let i = 0; i < rows.length; i++) {
    ctx.effects.push(fxBroadcast(s, 'battle:finished', {
      results: publicResults,
      winnerUserId: winnerUserId,
      details: detailsByUser[rows[i].userId],
      reason: reason,
      explanations: explanations,
    }, rows[i].userId));
  }

  ctx.effects.push({
    type: 'persist',
    op: 'saveMatch',
    match: {
      roomName: s.name,
      mode: s.mode,
      roundIds: s.roundIds.slice(),
      questionIds: s.questionIds.slice(),
      timeLimitS: s.timeLimitS,
      startedAt: isoOrNull(s.startedAt),
      finishedAt: isoOrNull(at),
      winnerUserId: winnerUserId,
    },
    // score/questionIds/wrongIds 는 db.saveMatch 가 같은 트랜잭션에서 study_results(round='battle')
    // 1행을 쓰기 위해 필요하다 — 대전 기록도 학습 이력·오답노트에 그대로 합류한다.
    players: rows.map(function (r) {
      return {
        userId: r.userId,
        correctCount: r.correctCount,
        score: r.score,
        submittedAt: isoOrNull(r.submittedAt), // 미제출은 NULL 로 남긴다(사실 기록). 이탈자는 이탈 시각이 들어간다
        answers: r.answers,
        questionIds: s.questionIds.slice(),
        wrongIds: r.wrongIds.slice(),
      };
    }),
  });
}

function allSubmitted(s) {
  const list = playerList(s);
  if (list.length === 0) return false;
  for (let i = 0; i < list.length; i++) if (list[i].submittedAt == null) return false;
  return true;
}

// ------------------------------------------------------------- 상태 핸들러

function handleWaiting(s, ev, ctx) {
  const at = ctx.at;
  const uid = ev.userId;
  switch (ev.type) {
    case 'join': {
      if (uid == null) return;
      const existing = s.players[uid];
      if (existing) {
        existing.connected = true;
        existing.left = false;
      } else {
        addPlayer(s, uid, ev.nickname, at);
      }
      // 전원이 나가 방장이 비어 있던 방(GC 유예 중)에 들어오면 입장자가 방장이 된다 —
      // 그렇지 않으면 아무도 start 를 못 하는 방이 된다.
      if (s.hostUserId == null) s.hostUserId = uid;
      ctx.effects.push(fxCancel(s, 'roomGc'));
      pushRoomState(ctx, s);
      return;
    }
    case 'leave': {
      if (!s.players[uid]) return; // 무시(비참가자)
      removePlayer(s, uid);
      pushRoomState(ctx, s);
      if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'roomGc', at + ROOM_GC_MS));
      return;
    }
    case 'start': {
      if (uid !== s.hostUserId) {
        errorTo(ctx, s, uid, 'NOT_HOST', '방장만 시작할 수 있습니다.');
        return;
      }
      if (s.playerOrder.length < 2) {
        errorTo(ctx, s, uid, 'NEED_TWO_PLAYERS', '2인 이상이어야 시작할 수 있습니다.');
        return;
      }
      s.state = 'countdown';
      s.countdownEndsAt = at + COUNTDOWN_MS;
      ctx.effects.push(fxCancel(s, 'roomGc'));
      ctx.effects.push(fxSchedule(s, 'countdown', s.countdownEndsAt));
      pushRoomState(ctx, s);
      return;
    }
    case 'answer':
    case 'submit':
      errorTo(ctx, s, uid, 'NOT_PLAYING', '대전이 시작되지 않았습니다.');
      return;
    case 'disconnect': {
      const p = s.players[uid];
      if (!p) return;
      p.connected = false;
      pushRoomState(ctx, s);
      if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'roomGc', at + ROOM_GC_MS));
      return;
    }
    case 'connect': {
      const p = s.players[uid];
      if (!p) return; // 무시(멤버십 없음)
      p.connected = true;
      ctx.effects.push(fxCancel(s, 'roomGc'));
      pushRoomState(ctx, s);
      pushResync(ctx, s, p);
      return;
    }
    case 'tick':
      return; // 무시(대기실에는 남은 시간 개념이 없다)
    case 'timeout': {
      if (ev.kind !== 'roomGc') return; // countdown/deadline/abandon 은 stale
      if (connectedCount(s) > 0) return; // 누군가 돌아왔다 → stale
      s.state = 'abandoned';
      s.finishedAt = at;
      ctx.effects.push(fxCancel(s, 'roomGc'));
      ctx.effects.push(fxCancel(s, 'countdown'));
      ctx.effects.push(fxCancel(s, 'deadline'));
      ctx.effects.push(fxCancel(s, 'abandon'));
      return;
    }
    default:
      return;
  }
}

function handleCountdown(s, ev, ctx) {
  const at = ctx.at;
  const uid = ev.userId;
  switch (ev.type) {
    case 'join':
      errorTo(ctx, s, uid, 'ROOM_NOT_JOINABLE', '이미 시작 준비 중인 방입니다.');
      return;
    case 'leave': {
      if (!s.players[uid]) return;
      removePlayer(s, uid);
      if (s.playerOrder.length < 2) {
        ctx.effects.push(fxCancel(s, 'countdown'));
        s.state = 'waiting';
        s.countdownEndsAt = null;
        pushRoomState(ctx, s);
        if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'roomGc', at + ROOM_GC_MS));
        return;
      }
      pushRoomState(ctx, s);
      return;
    }
    case 'start':
      errorTo(ctx, s, uid, 'ALREADY_STARTED', '이미 시작되었습니다.');
      return;
    case 'answer':
    case 'submit':
      errorTo(ctx, s, uid, 'NOT_PLAYING', '아직 문항이 배포되지 않았습니다.');
      return;
    case 'disconnect': {
      const p = s.players[uid];
      if (!p) return;
      p.connected = false;
      pushRoomState(ctx, s); // 명부는 그대로 → 카운트다운 유지
      return;
    }
    case 'connect': {
      const p = s.players[uid];
      if (!p) return;
      p.connected = true;
      pushRoomState(ctx, s);
      pushResync(ctx, s, p);
      return;
    }
    case 'tick':
      return; // 무시(3초 구간)
    case 'timeout': {
      if (ev.kind !== 'countdown') return; // deadline/abandon/roomGc 는 stale
      beginPlaying(s, ctx);
      return;
    }
    default:
      return;
  }
}

function handlePlaying(s, ev, ctx) {
  const at = ctx.at;
  const uid = ev.userId;
  switch (ev.type) {
    case 'join':
      errorTo(ctx, s, uid, 'ROOM_NOT_JOINABLE', '진행 중인 대전에는 참여할 수 없습니다.');
      return;
    case 'leave': {
      const p = s.players[uid];
      if (!p) return;
      // playing 중 이탈 = **즉시 제출 간주**(비가역). 보관 답안 그대로 채점되고, 판정용 제출 시각은
      // 이탈 시각이 된다. 명부에는 남지만 `left=true` 라 재입장은 어댑터가 막는다.
      let justSubmitted = false;
      if (p.submittedAt == null) {
        p.submittedAt = at;
        p.marks = marksOf(s, p); // 보관 답안 그대로 1회 채점 — 이후 답안이 바뀌지 않으므로 재채점 없음
        justSubmitted = true;
        ctx.effects.push(fxBroadcast(s, 'battle:progress', {
          userId: p.userId,
          answeredCount: answeredCount(s, p),
          submitted: true,
        }));
      }
      p.left = true;
      p.connected = false;
      pushRoomState(ctx, s);
      // 이탈로 명부 전원이 제출을 마칠 수 있다 → leave 도 종료 트리거다.
      if (allSubmitted(s)) { finish(s, ctx, 'allSubmitted'); return; }
      // 이탈=제출도 새 제출이다 → 제출 완료자 전원에게 정오표를 다시 뿌린다.
      if (justSubmitted) pushMarks(ctx, s);
      if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'abandon', at + ABANDON_GRACE_MS));
      return;
    }
    case 'start':
      errorTo(ctx, s, uid, 'ALREADY_STARTED', '이미 진행 중입니다.');
      return;
    case 'answer': {
      const p = s.players[uid];
      if (!p) { errorTo(ctx, s, uid, 'NOT_IN_ROOM', '이 방의 참가자가 아닙니다.'); return; }
      if (p.submittedAt != null) {
        errorTo(ctx, s, uid, 'ALREADY_SUBMITTED', '이미 제출했습니다. 답안을 바꿀 수 없습니다.');
        return;
      }
      const q = questionById(s, ev.questionId);
      if (!q) { errorTo(ctx, s, uid, 'UNKNOWN_QUESTION', '알 수 없는 문항입니다.'); return; }
      const fields = q.fields || [];
      const idx = Number(ev.fieldIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= fields.length) {
        errorTo(ctx, s, uid, 'BAD_FIELD', '알 수 없는 입력 칸입니다.');
        return;
      }
      let arr = p.answers[q.id];
      if (!arr) {
        arr = new Array(fields.length).fill('');
        p.answers[q.id] = arr;
      }
      while (arr.length < fields.length) arr.push('');
      arr[idx] = String(ev.value == null ? '' : ev.value);
      p.lastAnswerAt = at;
      const progress = fxBroadcast(s, 'battle:progress', {
        userId: p.userId,
        answeredCount: answeredCount(s, p),
      });
      progress.debounceMs = PROGRESS_DEBOUNCE_MS;
      progress.debounceKey = s.roomId + ':progress:' + p.userId;
      ctx.effects.push(progress);
      return;
    }
    case 'submit': {
      const p = s.players[uid];
      if (!p) { errorTo(ctx, s, uid, 'NOT_IN_ROOM', '이 방의 참가자가 아닙니다.'); return; }
      if (p.submittedAt != null) {
        errorTo(ctx, s, uid, 'ALREADY_SUBMITTED', '이미 제출했습니다.');
        return;
      }
      p.submittedAt = at;
      p.marks = marksOf(s, p); // 제출은 비가역 — 이 시점 답안이 최종이라 여기서 한 번만 채점한다
      ctx.effects.push(fxBroadcast(s, 'battle:progress', {
        userId: p.userId,
        answeredCount: answeredCount(s, p),
        submitted: true,
      }));
      pushRoomState(ctx, s);
      if (allSubmitted(s)) { finish(s, ctx, 'allSubmitted'); return; }
      pushMarks(ctx, s);
      return;
    }
    case 'disconnect': {
      const p = s.players[uid];
      if (!p) return;
      p.connected = false;
      pushRoomState(ctx, s);
      if (connectedCount(s) === 0) ctx.effects.push(fxSchedule(s, 'abandon', at + ABANDON_GRACE_MS));
      return;
    }
    case 'connect': {
      const p = s.players[uid];
      if (!p) return;
      p.connected = true;
      ctx.effects.push(fxCancel(s, 'abandon'));
      pushRoomState(ctx, s);
      pushResync(ctx, s, p);
      return;
    }
    case 'tick': {
      if (at >= s.deadline) { finish(s, ctx, 'deadline'); return; }
      ctx.effects.push(fxBroadcast(s, 'battle:tick', { remainingMs: remainingMs(s, at) }));
      return;
    }
    case 'timeout': {
      if (ev.kind === 'deadline') {
        if (at < s.deadline) {
          // 타이머가 이르게 깨어났다 — 재예약하고 무시
          ctx.effects.push(fxSchedule(s, 'deadline', s.deadline));
          return;
        }
        finish(s, ctx, 'deadline');
        return;
      }
      if (ev.kind === 'abandon') {
        if (connectedCount(s) > 0) return; // 누군가 돌아왔다 → stale
        s.state = 'abandoned';
        s.finishedAt = at;
        ctx.effects.push(fxCancel(s, 'deadline'));
        ctx.effects.push(fxCancel(s, 'abandon'));
        pushRoomState(ctx, s);
        return; // persist 없음 — 전적 미기록
      }
      return; // countdown/roomGc 는 stale
    }
    default:
      return;
  }
}

/** finished / abandoned — 방은 파기 대상. 모든 이벤트를 조용히 무시한다. */
function handleTerminal(_s, _ev, _ctx) {
  return;
}

const HANDLERS = {
  waiting: handleWaiting,
  countdown: handleCountdown,
  playing: handlePlaying,
  finished: handleTerminal,
  abandoned: handleTerminal,
};

// ----------------------------------------------------------------- 리듀서

/**
 * applyEvent(state, event) → { state, effects }
 * event: { type, at, ...payload }
 *   type: join | leave | start | answer | submit | disconnect | connect | tick | timeout
 *   timeout 은 kind: countdown | deadline | abandon | roomGc
 */
function applyEvent(state, event) {
  const ev = event || {};
  const rawAt = Number(ev.at);
  const at = Math.max(Number.isFinite(rawAt) ? rawAt : state.lastAt, state.lastAt); // 시계 역행 클램프
  const next = cloneState(state);
  next.lastAt = at;
  const ctx = { at: at, effects: [] };
  const handler = HANDLERS[state.state];
  if (!handler) throw new Error('unknown battle state: ' + state.state);
  handler(next, ev, ctx);
  return { state: next, effects: ctx.effects };
}

// ------------------------------------------------------- 랜덤 출제 빌더

function roundOf(q) {
  if (q.round) return q.round;
  const i = String(q.id).indexOf('#');
  return i === -1 ? String(q.id) : String(q.id).slice(0, i);
}

/** 복원추출 없이 n개를 뽑는다. rng() → [0,1) */
function pickRandom(pool, n, rng) {
  const arr = pool.slice();
  const out = [];
  const take = Math.min(n, arr.length);
  for (let i = 0; i < take; i++) {
    let idx = Math.floor(rng() * arr.length);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    if (idx >= arr.length) idx = arr.length - 1;
    out.push(arr.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * buildQuestionSet({ mode, rounds, questionCount, rng }) → { ok, questions } | { ok:false, error }
 *
 * rounds: [{ round, questions: [...] }]  — 선택 순서 유지
 * mode 'round'  : 선택 회차의 전 문항(순서 유지, 중복 id 제거)
 * mode 'random' : **회차별 균등 배분 + 나머지는 전체 풀에서 무작위**, 동일 문항 중복 금지.
 *                 유효 문항 총합 < questionCount 이면 { ok:false, error } (호출자가 400 으로 변환).
 * rng 는 주입 가능(테스트 결정성). 미지정 시 Math.random.
 */
function buildQuestionSet(opts) {
  const o = opts || {};
  const mode = o.mode === 'random' ? 'random' : 'round';
  const rounds = (o.rounds || []).map(function (r) {
    return { round: r.round, questions: (r.questions || []).slice() };
  });
  if (rounds.length === 0) return { ok: false, error: '회차를 하나 이상 선택해야 합니다.' };

  // 전체 풀 — 회차 선택 순서를 유지하며 중복 id 제거
  const seen = new Set();
  const pool = [];
  for (let i = 0; i < rounds.length; i++) {
    const qs = rounds[i].questions;
    for (let j = 0; j < qs.length; j++) {
      if (seen.has(qs[j].id)) continue;
      seen.add(qs[j].id);
      pool.push(qs[j]);
    }
  }

  if (mode === 'round') {
    if (pool.length === 0) return { ok: false, error: '선택한 회차에 유효한 문항이 없습니다.' };
    return { ok: true, questions: pool };
  }

  const n = Number(o.questionCount);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '문항 수가 올바르지 않습니다.' };
  if (pool.length < n) {
    return {
      ok: false,
      error: '선택 회차의 유효 문항 총합(' + pool.length + ')이 요청 문항 수(' + n + ')보다 적습니다.',
    };
  }

  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const per = Math.floor(n / rounds.length);
  const picked = new Set();
  const chosen = [];

  // ① 회차별 균등 배분
  if (per > 0) {
    for (let i = 0; i < rounds.length; i++) {
      const avail = rounds[i].questions.filter(function (q) { return !picked.has(q.id); });
      const got = pickRandom(avail, per, rng);
      for (let k = 0; k < got.length; k++) { picked.add(got[k].id); chosen.push(got[k]); }
    }
  }

  // ② 나머지는 전체 풀에서 무작위 (회차가 모자라 못 채운 몫도 여기서 흡수한다)
  const rest = pool.filter(function (q) { return !picked.has(q.id); });
  const got = pickRandom(rest, n - chosen.length, rng);
  for (let k = 0; k < got.length; k++) { picked.add(got[k].id); chosen.push(got[k]); }

  if (chosen.length < n) {
    return { ok: false, error: '문항을 충분히 뽑지 못했습니다.' }; // 위 길이 검사로 도달 불가하지만 방어
  }

  // 표시 순서: 회차 선택 순서 → 문항 번호
  const order = new Map();
  for (let i = 0; i < rounds.length; i++) order.set(rounds[i].round, i);
  chosen.sort(function (a, b) {
    const ra = order.has(roundOf(a)) ? order.get(roundOf(a)) : 1e9;
    const rb = order.has(roundOf(b)) ? order.get(roundOf(b)) : 1e9;
    if (ra !== rb) return ra - rb;
    return (Number(a.num) || 0) - (Number(b.num) || 0);
  });

  return { ok: true, questions: chosen };
}

module.exports = {
  applyEvent: applyEvent,
  createRoom: createRoom,
  isDisposed: isDisposed,
  buildQuestionSet: buildQuestionSet,
  publicQuestion: publicQuestion,
  answeredCount: answeredCount,
  pickWinner: pickWinner,
  roomStatePayload: roomStatePayload,
  resyncPayload: resyncPayload,
  STATES: STATES,
  EVENTS: EVENTS,
  TIMEOUT_KINDS: TIMEOUT_KINDS,
  COUNTDOWN_MS: COUNTDOWN_MS,
  ABANDON_GRACE_MS: ABANDON_GRACE_MS,
  ROOM_GC_MS: ROOM_GC_MS,
  PROGRESS_DEBOUNCE_MS: PROGRESS_DEBOUNCE_MS,
};
