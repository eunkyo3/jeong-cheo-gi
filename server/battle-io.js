'use strict';
/**
 * battle-io.js — 대전 어댑터 (소켓 + 대전/랭킹 REST).
 *
 * `server/battle.js` 의 순수 리듀서를 바깥 세계에 연결하는 **무논리 어댑터**다.
 * PROTOCOL.md "리듀서 계약":
 *
 *   broadcast → socket emit        persist  → db 호출
 *   schedule  → setTimeout         cancel   → clearTimeout
 *
 * 규칙(자체 분기 금지)을 지키기 위해 이 파일이 스스로 판단하는 것은 딱 넷뿐이다.
 *   ① `isDisposed(state)` — 리듀서가 제공하는 유일한 술어. 레지스트리 제거 판단.
 *   ② `battle:tick` 10초 주기 — 이펙트가 아니라 어댑터의 관심사(PROTOCOL "타이머").
 *   ③ 멤버십 장부(userId → socket/roomId) — 소켓 계층에만 존재하는 개념.
 *   ④ `room:invite` 배달 — 방 생성 REST 안에서 멤버십 장부만 조회해 접속 중인 초대 대상에게
 *      1회 emit 한다. **상태를 만들지 않는다**: 리듀서도 방 state 도 초대를 모르고,
 *      받은 쪽이 `room:join` 을 보내야 비로소 리듀서가 개입한다(도달 실패는 그냥 알림 없음).
 * 그 밖의 모든 전이·에러·타이머 결정은 리듀서가 내리고 여기서는 배달만 한다.
 *
 * index.js 연결 규약: `module.exports = function ({app, server, io, db, rounds, auth, log})`.
 */

const crypto = require('node:crypto');
const battle = require('./battle.js');
const ranking = require('./ranking.js');

// ------------------------------------------------------------------- 상수

const TICK_MS = 10000;                  // battle:tick 재동기 주기 (PROTOCOL)
const QUESTION_COUNTS = [5, 10, 20];    // random 모드 허용 문항 수
const TIME_LIMITS = [600, 1200, 1800];  // 허용 제한 시간(초)
const ROOM_NAME_MAX = 30;
const ANSWER_VALUE_MAX = 500;           // index.js sanitizeAnswers 와 동일한 상한
const MAX_ROUND_IDS = 32;
const MAX_INVITES = 8;                  // 방 생성 시 한 번에 보낼 수 있는 초대 수
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O/1/I 제외 (구두 전달용)

// ------------------------------------------------------------ 남용 방어 상수
//
// 보안 리뷰 M-6 "방 무제한 생성" / M-7 "소켓 레이트리밋 없음". 지인 간 LAN 사용이라도
// 실수로 도는 루프 하나가 메모리와 타이머를 무한히 늘릴 수 있어 상한을 못박는다.
// 방당 인원 상한(MAX_PLAYERS=8)은 리듀서(`battle.js`)가 집행한다 — 명부를 늘리는 길은 join 뿐이다.

const MAX_ROOMS_TOTAL = 200;      // 전체 동시 방 수 (초과 시 503)
const MAX_ROOMS_PER_USER = 3;     // 한 사용자가 방장인 동시 방 수 (초과 시 429)
const ANSWER_MIN_INTERVAL_MS = 50; // battle:answer 최소 간격 (ratelimit.js 가 없을 때의 폴백)
const ANSWER_RATE = { windowMs: 1000, max: 20 }; // ratelimit.makeLimiter 용 — 초당 20건
const QUESTION_ID_MAX = 64;       // 소켓 questionId 길이 상한 (실제 id 는 "2026-2#1" 꼴)

/**
 * 레인 A 의 `server/ratelimit.js` 가 있으면 그 `makeLimiter` 를 쓰고, 없으면 null.
 * 대전 어댑터는 그 모듈 없이도 떠야 하므로(학습 모드 단독 기동과 같은 이유) 실패를 삼킨다.
 */
function loadMakeLimiter() {
  try {
    const rl = require('./ratelimit.js');
    return rl && typeof rl.makeLimiter === 'function' ? rl.makeLimiter : null;
  } catch (e) {
    return null;
  }
}

/**
 * BATTLE_TIME_OVERRIDE_S — 설정 시 요청의 timeLimitS 대신 이 값을 쓴다(스모크 테스트용).
 *
 * **production 에서는 무시한다**(서버 M-13): 실서버에 env 가 새어 들어가면 모든 대전이
 * 몇 초짜리로 시작돼 조용히 망가진다. 개발·테스트에서 켜져 있으면 기동 배너가 경고한다.
 */
function timeOverrideS() {
  if (process.env.NODE_ENV === 'production') return null;
  const v = Number(process.env.BATTLE_TIME_OVERRIDE_S);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * 방 이름 정리. 닉네임과 같은 기준으로 제어문자를 걷어내고(보안 L-10 — 콘솔 로그 인젝션),
 * 폭 0 문자·양방향 재정의 문자도 함께 지운다(보안 L-11 — 방 이름으로 남을 사칭·표시 뒤집기).
 * **거절이 아니라 제거**다: 이름은 선택 입력이라 비면 기본값("<닉네임>의 방")으로 떨어지면 그만이고,
 * 400 으로 막으면 사용자가 원인을 알 수 없는 실패만 본다.
 */
function sanitizeRoomName(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')                        // 제어문자
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') // 폭 0 · RTL override · BOM
    .trim();
}

// -------------------------------------------------------------------- 부착

function attach(ctx) {
  const app = ctx.app;
  const io = ctx.io;
  const db = ctx.db;
  const rounds = ctx.rounds;
  const auth = ctx.auth;
  const log = typeof ctx.log === 'function' ? ctx.log : function () {};
  const logErr = typeof ctx.logErr === 'function' ? ctx.logErr : log;
  // LOG_LEVEL=debug 일 때만 찍힌다. 없으면 조용히 버린다(대전은 로거 없이도 떠야 한다).
  const logDebug = typeof ctx.logDebug === 'function' ? ctx.logDebug : function () {};
  const makeLimiter = loadMakeLimiter();

  /** @type {Map<string, object>} roomId → 리듀서 state */
  const rooms = new Map();
  /** @type {Map<string, NodeJS.Timeout>} 이펙트 timer key("roomId:kind") → 타이머 */
  const timers = new Map();
  /** @type {Map<string, NodeJS.Timeout>} roomId → tick 인터벌 (어댑터 소관) */
  const ticks = new Map();
  /** @type {Map<number, {socket:object|null, roomId:string|null}>} userId → 멤버십 */
  const members = new Map();
  /** @type {Map<string, {timer:NodeJS.Timeout, fx:object}>} debounceKey → 지연 중인 broadcast */
  const debounces = new Map();

  // ------------------------------------------------------------ 멤버십 장부

  /**
   * 멤버십을 갱신한다. roomId=null 이면 방에서 뗀다.
   * socket.io room 가입/탈퇴를 장부와 항상 같이 움직여 브로드캐스트 대상이 어긋나지 않게 한다.
   */
  function setRoom(socket, userId, roomId) {
    const m = members.get(userId) || { socket: null, roomId: null };
    if (m.roomId && m.roomId !== roomId) {
      if (m.socket) m.socket.leave(m.roomId);
      if (socket && socket !== m.socket) socket.leave(m.roomId);
    }
    m.socket = socket;
    m.roomId = roomId == null ? null : roomId;
    if (m.roomId && socket) socket.join(m.roomId);
    if (!m.socket && !m.roomId) members.delete(userId);
    else members.set(userId, m);
  }

  function roomIdOf(userId) {
    const m = members.get(userId);
    return m ? m.roomId : null;
  }

  // -------------------------------------------------------------- 이펙트 배달

  /** 키 하나에 걸려 있는 지연 방송을 버린다(발송하지 않는다). 없으면 no-op. */
  function dropDebounced(key) {
    const prev = debounces.get(key);
    if (!prev) return false;
    clearTimeout(prev.timer);
    debounces.delete(key);
    return true;
  }

  function deliver(fx) {
    // 같은 키로 지연 중인 방송이 있으면 **버린다**. 즉시 방송(제출·이탈)이 더 새로운 사실이라
    // 400ms 뒤 도착할 옛 진행 상황이 "제출 완료" 뱃지를 지우는 경합을 여기서 끊는다(서버 M-1).
    if (fx.debounceKey) dropDebounced(fx.debounceKey);
    if (fx.to !== undefined && fx.to !== null) {
      const m = members.get(fx.to);
      if (m && m.socket) m.socket.emit(fx.event, fx.payload);
      return;
    }
    io.to(fx.room).emit(fx.event, fx.payload);
  }

  /** 리듀서가 debounceKey/debounceMs 를 달아 보낸 broadcast 는 emit 경계에서 트레일링 디바운스한다. */
  function deliverDebounced(fx) {
    const key = fx.debounceKey;
    const prev = debounces.get(key);
    if (prev) clearTimeout(prev.timer);
    const entry = { fx: fx, timer: null };
    entry.timer = setTimeout(function () {
      debounces.delete(key);
      deliver(entry.fx);
    }, Math.max(0, Number(fx.debounceMs) || 0));
    if (entry.timer.unref) entry.timer.unref();
    debounces.set(key, entry);
  }

  function doPersist(fx) {
    if (fx.op !== 'saveMatch') {
      logErr('battle', '알 수 없는 persist op:', fx.op);
      return;
    }
    try {
      const id = db.saveMatch(fx.match, fx.players);
      log('battle persist saveMatch #' + id, fx.match.roomName,
        '승자=' + (fx.match.winnerUserId == null ? '무승부' : '#' + fx.match.winnerUserId));
    } catch (e) {
      logErr('battle persist 실패', fx.match && fx.match.roomName, '-', e.message);
    }
  }

  function doSchedule(fx) {
    doCancel(fx);
    const delay = Math.max(0, Number(fx.at) - Date.now());
    const t = setTimeout(function () {
      timers.delete(fx.key);
      dispatch(fx.timeout.roomId, { type: 'timeout', kind: fx.timeout.kind, at: Date.now() });
    }, delay);
    if (t.unref) t.unref();
    timers.set(fx.key, t);
  }

  function doCancel(fx) {
    const t = timers.get(fx.key);
    if (!t) return;
    clearTimeout(t);
    timers.delete(fx.key);
  }

  function runEffects(effects) {
    for (let i = 0; i < effects.length; i++) {
      const fx = effects[i];
      switch (fx.type) {
        case 'broadcast':
          // 지연 여부는 **debounceMs 로만** 정한다. debounceKey 는 즉시 방송에도 붙어 오는데
          // 그건 "같은 키로 지연 중인 것을 버려라" 는 뜻이다(deliver 참조).
          if (fx.debounceMs) deliverDebounced(fx);
          else deliver(fx);
          break;
        case 'persist': doPersist(fx); break;
        case 'schedule': doSchedule(fx); break;
        case 'cancel': doCancel(fx); break;
        default: logErr('battle', '알 수 없는 effect:', fx.type);
      }
    }
  }

  // ------------------------------------------------------------- tick 타이머

  function startTick(roomId) {
    if (ticks.has(roomId)) return;
    const iv = setInterval(function () {
      const s = rooms.get(roomId);
      if (!s) { stopTick(roomId); return; }
      const now = Date.now();
      // PROTOCOL "종료 판정은 서버가 Date.now() >= deadline 을 재검증" —
      // 절전 복귀 등으로 마감이 지나 있으면 tick 대신 deadline 타임아웃을 넣어 리듀서가 재검증하게 한다.
      if (s.deadline != null && now >= s.deadline) {
        dispatch(roomId, { type: 'timeout', kind: 'deadline', at: now });
      } else {
        dispatch(roomId, { type: 'tick', at: now });
      }
    }, TICK_MS);
    if (iv.unref) iv.unref();
    ticks.set(roomId, iv);
  }

  function stopTick(roomId) {
    const iv = ticks.get(roomId);
    if (!iv) return;
    clearInterval(iv);
    ticks.delete(roomId);
  }

  // --------------------------------------------------------------- 방 파기

  /** 파기된 방에 매달린 어댑터 자원(타이머·디바운스·멤버십)을 전부 회수한다. */
  function disposeRoom(roomId) {
    rooms.delete(roomId);
    stopTick(roomId);
    const prefix = roomId + ':';
    for (const key of Array.from(timers.keys())) {
      if (key.indexOf(prefix) === 0) doCancel({ key: key });
    }
    for (const key of Array.from(debounces.keys())) {
      if (key.indexOf(prefix) !== 0) continue;
      clearTimeout(debounces.get(key).timer);
      debounces.delete(key);
    }
    for (const entry of Array.from(members.entries())) {
      if (entry[1].roomId !== roomId) continue;
      setRoom(entry[1].socket, entry[0], null);
    }
  }

  // ---------------------------------------------------------------- 디스패치

  /** 리듀서 1회 적용 → 이펙트 배달 → 방 수명 정리. 방이 없으면 조용히 무시(늦게 온 타이머). */
  function dispatch(roomId, event) {
    const before = rooms.get(roomId);
    if (!before) return null;

    let result;
    try {
      result = battle.applyEvent(before, event);
    } catch (e) {
      logErr('battle 리듀서 오류', roomId, event.type, '-', e.message);
      return null;
    }

    rooms.set(roomId, result.state);
    runEffects(result.effects);

    const label = event.type === 'timeout' ? 'timeout:' + event.kind : event.type;
    // answer·tick 은 대전 1회에 수백~수천 건이 나오고 Windows TTY 의 stdout 은 동기라
    // 그대로 찍으면 이벤트 루프를 잡아먹는다(서버 M-12). 이 둘만 debug 레벨로 내리고
    // **상태 전이(join/leave/start/submit/connect/disconnect/timeout)는 info 로 남긴다** — 사후 추적의 근거다.
    const line = event.type === 'answer' || event.type === 'tick' ? logDebug : log;
    line('battle', roomId, label,
      event.userId == null ? '-' : '#' + event.userId,
      before.state + '→' + result.state.state,
      'fx=' + result.effects.length);

    if (battle.isDisposed(result.state)) {
      disposeRoom(roomId);
      log('battle', roomId, '방 파기 (' + result.state.state + ')');
      return result.state;
    }
    if (result.state.state === 'playing') startTick(roomId);
    else stopTick(roomId);
    return result.state;
  }

  // ------------------------------------------------------------- 소켓 인증

  // 세션 판정은 **전부 auth.userFromCookie 한 곳**에 맡긴다 — 쿠키 서명·만료뿐 아니라
  // `sv`(session_version)까지 대조하므로 `bumpSessionVersion` 으로 폐기한 세션이 소켓에서만
  // 살아 있던 구멍이 닫힌다(보안 M-5, 레인 A 요청 1번). 조회 실패는 그 함수가 삼키고 null 을 준다 —
  // 여기서 사유를 나눠 봐야 클라이언트에 줄 답("로그인이 필요합니다")이 같아 의미가 없다.
  io.use(function (socket, next) {
    let user = null;
    try {
      user = auth.userFromCookie(db, socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie);
    } catch (e) {
      logErr('socket 인증 실패', '-', e.message);
      user = null;
    }
    if (!user) return next(new Error('로그인이 필요합니다.'));
    socket.data.user = user;
    next();
  });

  // ------------------------------------------------------------ 소켓 핸들러

  io.on('connection', function (socket) {
    const user = socket.data.user;
    if (!user) return; // io.use 가 막았어야 하는 경우 — 방어

    const uid = user.id;
    const prev = members.get(uid);
    const prevRoomId = prev ? prev.roomId : null;

    // 동일 유저 다중 탭: 최신 소켓만 유효 (PROTOCOL "이전 강제 종료")
    if (prev && prev.socket && prev.socket !== socket) {
      const old = prev.socket;
      old.emit('error', { code: 'SESSION_REPLACED', message: '다른 곳에서 접속하여 이 연결을 종료합니다.' });
      old.disconnect(true); // 아래 disconnect 핸들러가 소켓만 떼고 roomId 는 남긴다
    }

    setRoom(socket, uid, prevRoomId);

    // 재접속: room:join 없이 서버가 멤버십을 조회해 resync 를 낸다 (리듀서의 connect 이펙트)
    if (prevRoomId) dispatch(prevRoomId, { type: 'connect', userId: uid, at: Date.now() });

    function fail(code, message) {
      socket.emit('error', { code: code, message: message });
    }

    // battle:answer 레이트리밋 — **소켓 하나에 하나씩**이라 연결이 끊기면 같이 사라진다(보안 M-7).
    // 레인 A 의 ratelimit.makeLimiter 가 있으면 초당 20건 창을 쓰고, 없으면 50ms 최소 간격으로 떨어진다.
    // 사람 타자 속도(빨라야 10회/초)의 두 배라 정상 입력은 걸리지 않는다.
    const answerLimiter = makeLimiter ? makeLimiter(ANSWER_RATE) : null;
    let lastAnswerAt = 0;
    function answerAllowed() {
      if (answerLimiter) return answerLimiter.allow(socket.id);
      const now = Date.now();
      if (now - lastAnswerAt < ANSWER_MIN_INTERVAL_MS) return false;
      lastAnswerAt = now;
      return true;
    }

    socket.on('room:join', function (payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      const roomId = typeof p.roomId === 'string' ? p.roomId.trim() : '';
      if (!roomId) return fail('BAD_PAYLOAD', 'roomId 가 필요합니다.');
      if (!rooms.has(roomId)) return fail('NO_ROOM', '없는 방입니다.');

      const current = roomIdOf(uid);
      if (current && current !== roomId) {
        dispatch(current, { type: 'leave', userId: uid, at: Date.now() });
        setRoom(socket, uid, null);
      }

      // 에러 이펙트(to=userId)가 배달되도록 멤버십을 먼저 붙이고 던진다.
      setRoom(socket, uid, roomId);
      const next = dispatch(roomId, {
        type: 'join', userId: uid, nickname: user.nickname, at: Date.now(),
      });
      // 리듀서가 명부에 넣지 않았거나(= 거부) 이미 이탈한 자리로 남아 있다면 멤버십을 되돌린다.
      // 판단은 전적으로 리듀서의 명부 + `left` 플래그를 따른다 — playing 중 이탈은 즉시 제출 간주라
      // 명부에는 남지만 재입장은 없다(반쪽 재부착 차단).
      if (!next || !next.players[uid] || next.players[uid].left) setRoom(socket, uid, null);
    });

    socket.on('room:leave', function () {
      const roomId = roomIdOf(uid);
      if (!roomId) return;
      dispatch(roomId, { type: 'leave', userId: uid, at: Date.now() });
      setRoom(socket, uid, null);
    });

    socket.on('room:start', function () {
      const roomId = roomIdOf(uid);
      if (!roomId) return fail('NO_ROOM', '참여 중인 방이 없습니다.');
      dispatch(roomId, { type: 'start', userId: uid, at: Date.now() });
    });

    socket.on('battle:answer', function (payload) {
      const roomId = roomIdOf(uid);
      if (!roomId) return fail('NO_ROOM', '참여 중인 방이 없습니다.');
      const p = payload && typeof payload === 'object' ? payload : {};
      if (typeof p.questionId !== 'string' || p.questionId === '' || p.questionId.length > QUESTION_ID_MAX) {
        return fail('BAD_PAYLOAD', 'questionId 가 필요합니다.');
      }
      // 상한을 넘긴 입력은 **조용히 버린다**. 에러를 되돌리면 초당 수천 건의 error 방송이 되어
      // 리밋의 목적(부하 차단)을 스스로 깬다 — 남는 건 debug 로그 한 줄뿐이다.
      if (!answerAllowed()) {
        logDebug('battle', roomId, 'answer 레이트리밋 초과 — 버림', socket.id);
        return;
      }
      const value = typeof p.value === 'string' ? p.value.slice(0, ANSWER_VALUE_MAX) : '';
      dispatch(roomId, {
        type: 'answer',
        userId: uid,
        questionId: p.questionId,
        fieldIndex: Number(p.fieldIndex),
        value: value,
        at: Date.now(),
      });
    });

    socket.on('battle:submit', function () {
      const roomId = roomIdOf(uid);
      if (!roomId) return fail('NO_ROOM', '참여 중인 방이 없습니다.');
      dispatch(roomId, { type: 'submit', userId: uid, at: Date.now() });
    });

    socket.on('disconnect', function () {
      const m = members.get(uid);
      if (!m || m.socket !== socket) return; // 이미 새 소켓으로 교체됨 — 무시
      m.socket = null;                        // roomId 는 남긴다(재접속 시 resync 근거)
      if (!m.roomId) { members.delete(uid); return; }
      members.set(uid, m);
      dispatch(m.roomId, { type: 'disconnect', userId: uid, at: Date.now() });
    });
  });

  // ---------------------------------------------------------------- REST

  function newRoomId() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const bytes = crypto.randomBytes(6);
      let id = '';
      for (let i = 0; i < 6; i++) id += ROOM_ID_ALPHABET[bytes[i] % ROOM_ID_ALPHABET.length];
      if (!rooms.has(id)) return id;
    }
    return 'R' + Date.now().toString(36).toUpperCase();
  }

  function hostNickname(state) {
    if (state.hostUserId == null) return '';
    const p = state.players[state.hostUserId];
    if (p) return p.nickname;
    try {
      const row = db.findUserById(state.hostUserId);
      if (row) return row.nickname;
    } catch (e) {
      logErr('방장 닉네임 조회 실패', '-', e.message);
    }
    return '사용자#' + state.hostUserId;
  }

  /** 지금 살아 있는 방 중 이 사용자가 방장인 것의 수. 파기된 방은 레지스트리에 없다. */
  function roomsHostedBy(userId) {
    let n = 0;
    for (const s of rooms.values()) if (s.hostUserId === userId) n++;
    return n;
  }

  app.post('/api/rooms', auth.requireAuth, function (req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // 남용 방어(보안 M-6). 검증보다 **먼저** 본다 — 상한에 걸린 요청에 문항 풀을 구성해 줄 이유가 없다.
    // 503 = 서버 전체 용량, 429 = 이 사용자 몫. 둘의 원인이 다르므로 코드도 다르게 준다.
    if (rooms.size >= MAX_ROOMS_TOTAL) {
      logErr('battle 방 생성 거절 — 전체 상한', rooms.size + '/' + MAX_ROOMS_TOTAL, 'by ' + req.user.nickname);
      return res.status(503).json({ error: '지금은 방이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }
    if (roomsHostedBy(req.user.id) >= MAX_ROOMS_PER_USER) {
      return res.status(429).json({
        error: '동시에 만들 수 있는 방은 ' + MAX_ROOMS_PER_USER + '개까지입니다. 기존 방을 정리해 주세요.',
      });
    }

    const mode = body.mode === 'random' ? 'random' : body.mode === 'round' ? 'round' : null;
    if (!mode) return res.status(400).json({ error: '출제 방식은 round 또는 random 이어야 합니다.' });

    if (!Array.isArray(body.roundIds) || body.roundIds.length === 0) {
      return res.status(400).json({ error: '회차를 하나 이상 선택해야 합니다.' });
    }
    if (body.roundIds.length > MAX_ROUND_IDS) {
      return res.status(400).json({ error: '회차는 최대 ' + MAX_ROUND_IDS + '개까지 선택할 수 있습니다.' });
    }
    const roundIds = [];
    for (const raw of body.roundIds) {
      const id = typeof raw === 'string' ? raw : '';
      if (!rounds.hasRound(id)) return res.status(400).json({ error: '없는 회차입니다: ' + id });
      if (roundIds.indexOf(id) === -1) roundIds.push(id);
    }

    let questionCount = null;
    if (mode === 'random') {
      questionCount = Number(body.questionCount);
      if (QUESTION_COUNTS.indexOf(questionCount) === -1) {
        return res.status(400).json({ error: '문항 수는 ' + QUESTION_COUNTS.join('/') + ' 중에서 고르세요.' });
      }
    }

    // 유형 필터(선택). 방 생성 시 1회만 적용되고 settings.type 으로 보존된다 —
    // 대전은 양쪽이 같은 문항을 봐야 하므로 진행 중 변경은 없다(handoff "리스크").
    let type = null;
    if (body.type != null && body.type !== '' && body.type !== 'all') {
      type = battle.normalizeType(body.type);
      if (type == null) {
        return res.status(400).json({ error: '유형은 ' + battle.TYPES.join('/') + ' 중 하나여야 합니다.' });
      }
    }

    // 언어 필터(선택). 언어는 코드 문항에만 있으므로 유형은 생략이거나 code 여야 한다(handoff C3).
    // 언어만 오면 유형을 code 로 간주한다 — 아래 풀 구성이 유형 필터를 그대로 쓴다.
    let lang = null;
    if (body.lang != null && body.lang !== '' && body.lang !== 'all') {
      lang = battle.normalizeLang(body.lang);
      if (lang == null) {
        return res.status(400).json({ error: '언어는 ' + battle.LANGS.join('/') + ' 중 하나여야 합니다.' });
      }
      if (type != null && type !== 'code') {
        return res.status(400).json({ error: 'lang 은 코드 문항에만 쓸 수 있습니다.' });
      }
      type = 'code';
    }

    const override = timeOverrideS();
    let timeLimitS = Number(body.timeLimitS);
    if (override != null) {
      timeLimitS = override; // 스모크 테스트용 강제 (요청값 무시)
    } else if (TIME_LIMITS.indexOf(timeLimitS) === -1) {
      return res.status(400).json({ error: '제한 시간은 ' + TIME_LIMITS.join('/') + '초 중에서 고르세요.' });
    }

    const pools = roundIds.map(function (id) {
      const r = rounds.getRound(id);
      return { round: r.round, questions: rounds.filterByLang(rounds.filterByType(r.questions, type), lang) };
    });
    if ((type || lang) && pools.every(function (p) { return p.questions.length === 0; })) {
      return res.status(400).json({ error: lang ? '해당 언어의 문항이 없습니다.' : '해당 유형의 문항이 없습니다.' });
    }

    const built = battle.buildQuestionSet({
      mode: mode,
      rounds: pools,
      questionCount: questionCount,
    });
    // 유효 문항 총합 < questionCount 등 — 리듀서가 만든 한국어 사유를 그대로 400 으로 옮긴다
    if (!built.ok) return res.status(400).json({ error: built.error });

    // 재대전 초대(선택) — 정수가 아닌 값과 생성자 자신은 버리고 앞에서부터 MAX_INVITES 명까지만 본다.
    const inviteUserIds = [];
    if (Array.isArray(body.inviteUserIds)) {
      for (const raw of body.inviteUserIds) {
        if (inviteUserIds.length >= MAX_INVITES) break;
        if (!Number.isInteger(raw) || raw === req.user.id) continue;
        if (inviteUserIds.indexOf(raw) === -1) inviteUserIds.push(raw);
      }
    }

    // 제어문자·폭 0·RTL override 를 걷어낸 뒤 남는 게 없으면 기본 이름으로 떨어진다(보안 L-10·L-11).
    const rawName = sanitizeRoomName(body.name);
    const name = (rawName || req.user.nickname + '의 방').slice(0, ROOM_NAME_MAX);

    const roomId = newRoomId();
    const created = battle.createRoom({
      roomId: roomId,
      name: name,
      hostUserId: req.user.id,
      mode: mode,
      roundIds: roundIds,
      questionCount: questionCount,
      type: type,
      lang: lang,
      timeLimitS: timeLimitS,
      questions: built.questions,
      at: Date.now(),
    });
    rooms.set(roomId, created.state);
    runEffects(created.effects);
    log('battle', roomId, '방 생성', name, mode, (type || '전체') + (lang ? '/' + lang : ''),
      built.questions.length + '문항', timeLimitS + '초', 'by ' + req.user.nickname);

    if (inviteUserIds.length > 0) {
      // 지금 소켓이 붙어 있는 대상에게만 도달한다 — 오프라인 초대는 보관하지 않는다(배달만).
      const payload = {
        roomId: roomId,
        name: name,
        fromUserId: req.user.id,
        fromNickname: req.user.nickname,
        settings: {
          mode: mode,
          roundIds: roundIds,
          questionCount: built.questions.length,
          type: type,
          lang: lang,
          timeLimitS: timeLimitS,
        },
      };
      let sent = 0;
      for (const id of inviteUserIds) {
        const m = members.get(id);
        if (!m || !m.socket) continue;
        m.socket.emit('room:invite', payload);
        sent++;
      }
      log('battle', roomId, '초대 발송', sent + '/' + inviteUserIds.length + '명 (접속 중인 대상만)');
    }

    res.json({ roomId: roomId });
  });

  // 로그인 필수 — 방 이름과 방장 닉네임이 실리므로 비로그인 열거를 막는다(보안 L-9).
  // 어차피 방에 들어가려면 로그인이 필요하고(소켓 io.use), 목록만 미인증으로 열려 있을 이유가 없다.
  app.get('/api/rooms', auth.requireAuth, function (req, res) {
    const list = [];
    for (const state of rooms.values()) {
      if (state.state !== 'waiting') continue; // PROTOCOL: waiting 방만
      if (state.playerOrder.length === 0) continue; // 전원 퇴장 후 GC 유예 중인 빈 방은 숨긴다
      list.push({
        roomId: state.roomId,
        name: state.name,
        host: hostNickname(state),
        playerCount: state.playerOrder.length,
        mode: state.mode,
        state: state.state,
        questionCount: state.questionIds.length,
        type: state.type == null ? null : state.type,
        lang: state.lang == null ? null : state.lang,
        timeLimitS: state.timeLimitS,
      });
    }
    list.sort(function (a, b) { return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0; });
    res.json(list);
  });

  app.get('/api/ranking', auth.requireAuth, function (req, res) {
    res.json(ranking.computeRanking(db));
  });

  // ------------------------------------------------- 다른 계층에 여는 창구

  /**
   * 지금 이 사용자가 **풀고 있는** 대전 문항 id 집합. 없으면 null.
   *
   * 학습 채점 API(`/api/rounds/:id/grade`·`/api/practice/grade`)가 정답 오라클로 쓰이는 것을
   * 막기 위한 것이다(보안 C-1) — 대전 중인 문항이 섞여 있으면 라우트가 409 로 거절한다.
   * **제출을 마쳤으면 제외한다**: 답안이 비가역으로 고정된 뒤라 정답을 알아내도 자기 점수는 못 바꾼다.
   * `playing` 만 본다 — countdown 이전에는 문항이 배포되지 않아 클라이언트가 id 를 모른다.
   */
  function activeBattleQuestionIds(userId) {
    let out = null;
    for (const s of rooms.values()) {
      if (s.state !== 'playing') continue;
      const p = s.players[userId];
      if (!p || p.submittedAt != null) continue;
      if (!out) out = new Set();
      for (let i = 0; i < s.questionIds.length; i++) out.add(s.questionIds[i]);
    }
    return out;
  }

  /** 살아 있는 방 수(waiting·countdown·playing 전부). 파기된 방은 세지 않는다. */
  function roomCount() {
    return rooms.size;
  }

  /** 관리자 화면용 방 목록. `GET /api/rooms` 와 달리 **모든 상태**의 방을 그대로 준다. */
  function listRooms() {
    const out = [];
    for (const s of rooms.values()) {
      out.push({
        id: s.roomId,
        name: s.name,
        state: s.state,
        hostUserId: s.hostUserId,
        players: s.playerOrder.length,
        createdAt: s.createdAt,
      });
    }
    out.sort(function (a, b) { return a.createdAt - b.createdAt; });
    return out;
  }

  // 테스트/진단용 내부 핸들 — 라우트나 프로토콜의 일부가 아니다.
  return {
    rooms: rooms, members: members, timers: timers, ticks: ticks, debounces: debounces,
    dispatch: dispatch,
    activeBattleQuestionIds: activeBattleQuestionIds,
    roomCount: roomCount,
    listRooms: listRooms,
    timeOverrideS: timeOverrideS,
  };
}

module.exports = attach;
module.exports.attach = attach;
module.exports.TICK_MS = TICK_MS;
module.exports.QUESTION_COUNTS = QUESTION_COUNTS;
module.exports.TIME_LIMITS = TIME_LIMITS;
module.exports.MAX_ROOMS_TOTAL = MAX_ROOMS_TOTAL;
module.exports.MAX_ROOMS_PER_USER = MAX_ROOMS_PER_USER;
module.exports.QUESTION_ID_MAX = QUESTION_ID_MAX;
module.exports.ANSWER_MIN_INTERVAL_MS = ANSWER_MIN_INTERVAL_MS;
module.exports.timeOverrideS = timeOverrideS;
module.exports.sanitizeRoomName = sanitizeRoomName;
