'use strict';
/**
 * battle.js — 대전 화면 (로비 · 대기실 · 대전 · 결과) 단일 스크립트.
 *
 * ── 아키텍처 (PROTOCOL.md "프런트는 이벤트 → state → render(state) 전체 재렌더 단방향만 허용")
 *
 *   모든 소켓 이벤트와 모든 사용자 조작은 `state` 를 바꾼 뒤 `render()` 하나만 호출한다.
 *   `render()` 는 노드를 **절대 제자리에서 고치지 않는다**. 화면은 몇 개의 *패널* 로 나뉘고,
 *   패널은 순수 빌더 `build(state) → DocumentFragment` 로 **통째로 다시 만들어** 교체된다.
 *   부분 DOM 패치(특정 노드의 textContent/class 만 갈아끼우기)는 이 파일 어디에도 없다.
 *
 *   패널을 나눈 이유는 성능이 아니라 **한글 입력(IME)** 이다. 답안 입력 도중 다른 참가자의
 *   `battle:progress` 나 10초 주기 `battle:tick` 이 도착하는데, 그때마다 문항 목록 전체를
 *   다시 만들면 조합 중인 한글이 날아간다. 그래서
 *     - 텍스트 입력을 품은 패널의 key 는 **입력값이 아니라 구조**(문항 id 목록·제출 여부 등)로 잡고,
 *       입력값은 빌드 시점에 `state` 에서 주입한다 → 타이핑은 재빌드를 유발하지 않는다.
 *     - 조작 요소가 없는 패널(타이머·진행현황·방 목록)은 내용으로 key 를 잡아 자유롭게 갱신한다.
 *   key 가 같으면 render() 는 그 패널을 건드리지 않는다. key 가 다르면 서브트리 전체를 새로 만든다.
 *   (battle.css 의 `.timerbar` 주석 "250ms 주기로 통째 재작성되므로 조작 요소를 두지 않는다" 와 같은 전제다.)
 *
 *   디바운스 타이머·`performance.now()` 기준점 등 렌더 대상이 아닌 값도 전부 `state` 에 산다.
 *   DOM 을 상태 저장소로 쓰는 곳은 없다.
 *
 * ── 의존 (전역)
 *   window.api        : api.get / api.post / api.me      (js/api.js)
 *   window.copyText   : 3단 폴백 클립보드                (js/clipboard.js)
 *   window.io         : socket.io 클라이언트             (/socket.io/socket.io.js)
 */

(function () {
  // ------------------------------------------------------------------ 상수

  var COUNTDOWN_MS = 3000;      // server/battle.js COUNTDOWN_MS 와 동일해야 한다
  var ANSWER_DEBOUNCE_MS = 400; // PROTOCOL.md "battle.html 문항 UI 모델"
  var ROOMS_POLL_MS = 5000;
  var BATTLE_TICK_MS = 250;
  var TOAST_MS = 5000;
  var FLOAT_SCROLL_THRESHOLD = 260; // 대전 화면 상단 'live' 패널을 대략 지나치는 스크롤량(요구 1)

  var MODE_LABEL = { round: '회차 전체', random: '랜덤' };
  // 문항 유형 — 서버 계약(data/types/*.json)의 값 셋과 화면 표기.
  var TYPE_ORDER = ['code', 'sql', 'theory'];
  var TYPE_LABEL = { code: '코드', sql: 'SQL', theory: '이론' };
  var TIME_CHOICES = [
    { v: 600, label: '10분' },
    { v: 1200, label: '20분' },
    { v: 1800, label: '30분' },
  ];
  var COUNT_CHOICES = [5, 10, 20];

  // ------------------------------------------------------------------ 상태

  var state = {
    me: null,             // {id, nickname}
    online: false,        // 소켓 연결 여부
    everConnected: false, // 한 번이라도 붙은 적이 있는가 (첫 연결 전 경고 배너 방지)
    disconnectReason: null, // socket.io 의 마지막 disconnect 사유 — 서버가 끊었는지(재연결 안 함) 구분
    toast: null,          // {kind:'err'|'info'|'warn', text, seq}
    toastSeq: 0,

    // 로비
    rooms: [],
    roomsError: '',
    roundList: [],        // [{round,title,questionCount}]
    roundsError: '',
    // form.type: '' = 전체 유형 (POST /api/rooms 에 아예 싣지 않는다)
    form: { name: '', mode: 'round', roundIds: [], questionCount: 10, timeLimitS: 1200, type: '' },
    createError: '',
    creating: false,
    joiningRoomId: null,
    joinCode: '',          // 방 코드로 참여 입력값 (B1)
    invite: null,          // {roomId, name, fromUserId, fromNickname, settings} — 재대전 초대 배너 (C1)
    rematching: false,     // POST /api/rooms(재대전) 대기 중

    // 방 (대기실 · 대전 · 결과 공통)
    room: null,           // room:state 페이로드 {state, players[], settings}
    ignoreRoomId: null,   // 나간 방의 뒤늦은 room:state 를 무시하기 위한 표식
    countdownEndsAt: null,// 서버가 보내지 않는 값 — 클라이언트에서 근사한다(아래 주석 참조)

    // 대전
    questions: [],        // battle:questions / battle:resync 의 공개 문항
    myAnswers: {},        // {qid: [string]}
    progress: {},         // {userId: answeredCount} — battle:progress 누적
    submitted: false,
    submitPending: false, // battle:submit 을 쏘고 서버 확인을 기다리는 동안
    timer: { remainingMs: null, receivedAt: null }, // performance.now() 감산용
    pending: {},          // {"qid#fieldIndex": {t, qid, fi, value}} — 400ms 디바운스
    marks: [],             // battle:marks 최신 스냅샷 — [{userId, nickname, marks:{qid:bool}}], 제출자에게만 옴(요구 2)
    floatVisible: false,   // 스크롤이 상단 'live' 패널을 지나쳤는가 — 플로팅 현황 패널 노출 여부(요구 1)

    // 결과
    result: null,         // {results[], winnerUserId, details[], reason, explanations{}}
    showExplain: {},      // {qid: true} — 결과 카드의 해설 펼침
    reportOpen: {},       // {qid: true}
    reportText: {},       // {qid: string}
    reportStatus: {},     // {qid: '...'}
    copied: {},           // {qid: 'clipboard'|'execCommand'|'manual'}
  };

  var socket = null;
  var mounted = { view: null, panels: {} }; // 붙어 있는 패널: name → {wrap, key}
  var intervals = { rooms: null, tick: null };

  // ------------------------------------------------------------ DOM 헬퍼

  function append(parent, kids) {
    if (kids == null || kids === false || kids === true) return;
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) append(parent, kids[i]);
      return;
    }
    parent.appendChild(kids.nodeType ? kids : document.createTextNode(String(kids)));
  }

  /** h('div', {class:'x', onclick:fn, text:'…'}, [children]) */
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') e.textContent = String(v);
        else if (k === 'html') e.innerHTML = String(v); // 서버가 만든 문항 마크업 전용
        else if (k === 'class') e.className = v;
        else if (k === 'value') e.value = v;
        else if (k === 'disabled' || k === 'readOnly' || k === 'checked') e[k] = !!v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, String(v));
      }
    }
    append(e, kids);
    return e;
  }

  function frag(kids) {
    var f = document.createDocumentFragment();
    append(f, kids);
    return f;
  }

  // ------------------------------------------------------------ 포맷터

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /**
   * 남은 시간 mm:ss. 음수는 00:00.
   * 내림이 아니라 **올림**이다 — 10분 타이머가 시작하자마자 09:59 로 보이면 안 되고,
   * 0 초는 실제로 deadline 에 닿았을 때만 나와야 한다.
   */
  function fmtClock(ms) {
    var s = Math.max(0, Math.ceil((ms == null ? 0 : ms) / 1000));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }

  function fmtTime(epochMs) {
    if (epochMs == null) return '미제출';
    var d = new Date(epochMs);
    if (isNaN(d.getTime())) return '미제출';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function roundTitle(id) {
    for (var i = 0; i < state.roundList.length; i++) {
      if (state.roundList[i].round === id) return state.roundList[i].title || id;
    }
    return id;
  }

  /** 회차 id "2026-2" → "2026" 처럼 연도만 뽑는다(전체 선택 퀵 토글용, A4). */
  function roundYear(id) { return String(id).split('-')[0]; }

  /** state.roundList 에 등장하는 순서 그대로 연도를 한 번씩만 뽑는다. */
  function yearsInRoundList() {
    var years = [];
    var seen = {};
    for (var i = 0; i < state.roundList.length; i++) {
      var y = roundYear(state.roundList[i].round);
      if (!seen[y]) { seen[y] = true; years.push(y); }
    }
    return years;
  }

  /** 알 수 없는 값은 '' (= 전체) 로 떨어뜨린다 — 서버에 이상한 type 을 보내지 않는다. */
  function normalizeType(value) {
    var t = String(value == null ? '' : value).trim().toLowerCase();
    return TYPE_ORDER.indexOf(t) === -1 ? '' : t;
  }

  /** 유형 뱃지 (없는 유형이면 null → 뱃지 생략). */
  function typeBadge(type) {
    var t = normalizeType(type);
    return t ? h('span', { class: 'q-type ' + t, text: TYPE_LABEL[t] }) : null;
  }

  function roundIdsOfYear(y) {
    var out = [];
    for (var i = 0; i < state.roundList.length; i++) {
      if (roundYear(state.roundList[i].round) === y) out.push(state.roundList[i].round);
    }
    return out;
  }

  // ------------------------------------------------------------ 상태 조회기

  function myId() { return state.me ? state.me.id : null; }

  function players() { return (state.room && state.room.players) || []; }

  function settings() { return (state.room && state.room.settings) || null; }

  function myPlayer() {
    var list = players();
    for (var i = 0; i < list.length; i++) if (list[i].userId === myId()) return list[i];
    return null;
  }

  function isHost() {
    var s = settings();
    return !!(s && myId() != null && s.hostUserId === myId());
  }

  function iAmSubmitted() {
    var p = myPlayer();
    if (p && p.submitted) return true;
    return state.submitted || state.submitPending;
  }

  function totalQuestions() {
    if (state.questions.length) return state.questions.length;
    var s = settings();
    return s && s.questionCount ? s.questionCount : 0;
  }

  function answeredCountOf(p) {
    if (Object.prototype.hasOwnProperty.call(state.progress, p.userId)) return state.progress[p.userId];
    return p.answeredCount || 0;
  }

  /** 남은 시간: 마지막 tick 값에서 그 뒤 흐른 실제 시간을 뺀다(절전·지연 보정). */
  function remainingMs() {
    var t = state.timer;
    if (t.remainingMs == null || t.receivedAt == null) return null;
    return Math.max(0, t.remainingMs - (performance.now() - t.receivedAt));
  }

  function setTimer(ms) {
    if (ms == null) { state.timer = { remainingMs: null, receivedAt: null }; return; }
    state.timer = { remainingMs: Number(ms) || 0, receivedAt: performance.now() };
  }

  function countdownSeconds() {
    if (state.countdownEndsAt == null) return 0;
    return Math.max(0, Math.ceil((state.countdownEndsAt - Date.now()) / 1000));
  }

  function currentView() {
    if (!state.room) return 'lobby';
    var s = state.room.state;
    if (s === 'waiting' || s === 'countdown') return 'room';
    if (s === 'playing') return 'battle';
    if (s === 'finished') return state.result ? 'result' : 'battle';
    return 'lobby'; // abandoned — room:state 핸들러가 방을 이미 비웠어야 한다
  }

  function questionById(id) {
    for (var i = 0; i < state.questions.length; i++) {
      if (state.questions[i].id === id) return state.questions[i];
    }
    return null;
  }

  // ------------------------------------------------------- 플로팅 패널 스크롤(요구 1)

  /**
   * 대전 화면에서 스크롤이 상단 'live' 패널을 대략 지나치면 state.floatVisible 을 세운다.
   * boolean 이 실제로 뒤집힐 때만 render() 한다 — 스크롤마다 재렌더하면 낭비다.
   * rAF 로 스로틀링해 스크롤 이벤트 폭주를 흡수한다.
   */
  var floatScrollTicking = false;
  function onFloatScroll() {
    if (floatScrollTicking) return;
    floatScrollTicking = true;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
      floatScrollTicking = false;
      if (currentView() !== 'battle') return;
      var visible = (window.scrollY || window.pageYOffset || 0) > FLOAT_SCROLL_THRESHOLD;
      if (visible !== state.floatVisible) {
        state.floatVisible = visible;
        render();
      }
    });
  }

  // ------------------------------------------------------------ 알림(토스트)

  var toastTimer = null;
  function toast(kind, text) {
    state.toastSeq += 1;
    state.toast = { kind: kind, text: String(text == null ? '' : text), seq: state.toastSeq };
    if (toastTimer) clearTimeout(toastTimer);
    var seq = state.toastSeq;
    toastTimer = setTimeout(function () {
      if (state.toast && state.toast.seq === seq) { state.toast = null; render(); }
    }, TOAST_MS);
    render();
  }

  // ------------------------------------------------------------ 소켓 전송

  function emit(event, payload) {
    if (!socket || !socket.connected) {
      toast('err', '서버와 연결되어 있지 않습니다. 잠시 후 다시 시도해 주세요.');
      return false;
    }
    socket.emit(event, payload || {});
    return true;
  }

  // --------------------------------------------------- 답안 디바운스 전송

  function pendingKey(qid, fi) { return qid + '#' + fi; }

  function flushOne(key) {
    var p = state.pending[key];
    if (!p) return;
    clearTimeout(p.t);
    delete state.pending[key];
    if (socket && socket.connected) {
      socket.emit('battle:answer', { questionId: p.qid, fieldIndex: p.fi, value: p.value });
    }
  }

  function flushAllAnswers() {
    var keys = Object.keys(state.pending);
    for (var i = 0; i < keys.length; i++) flushOne(keys[i]);
  }

  function scheduleAnswer(qid, fi, value) {
    var key = pendingKey(qid, fi);
    if (state.pending[key]) clearTimeout(state.pending[key].t);
    var t = setTimeout(function () { flushOne(key); }, ANSWER_DEBOUNCE_MS);
    state.pending[key] = { t: t, qid: qid, fi: fi, value: value };
  }

  // ------------------------------------------------------------ 렌더 엔진

  /**
   * 패널 계획: [{name, key, build}]
   * key 가 이전과 같으면 그 패널은 그대로 둔다. 다르면 서브트리를 통째로 새로 만든다.
   */
  var PLANS = {
    lobby: planLobby,
    room: planRoom,
    battle: planBattle,
    result: planResult,
  };

  function captureFocus(root) {
    var a = document.activeElement;
    if (!a || !root.contains(a) || !a.getAttribute) return null;
    var key = a.getAttribute('data-fkey');
    if (!key) return null;
    var out = { key: key, start: null, end: null };
    try { out.start = a.selectionStart; out.end = a.selectionEnd; } catch (e) { /* number 등 미지원 */ }
    return out;
  }

  function restoreFocus(root, f) {
    if (!f) return;
    var list = root.querySelectorAll('[data-fkey]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-fkey') !== f.key) continue;
      try {
        list[i].focus();
        if (f.start != null && list[i].setSelectionRange) list[i].setSelectionRange(f.start, f.end);
      } catch (e) { /* 무시 */ }
      return;
    }
  }

  function render() {
    renderNotice();

    var view = currentView();
    var plan = PLANS[view]();
    var root = document.getElementById('view');
    if (!root) return;

    if (mounted.view !== view) {
      root.replaceChildren();
      mounted = { view: view, panels: {} };
      for (var i = 0; i < plan.length; i++) {
        var p = plan[i];
        var wrap = h('div', { class: 'panel panel-' + p.name });
        wrap.appendChild(p.build());
        root.appendChild(wrap);
        mounted.panels[p.name] = { wrap: wrap, key: p.key };
      }
    } else {
      for (var j = 0; j < plan.length; j++) {
        var q = plan[j];
        var m = mounted.panels[q.name];
        if (!m || m.key === q.key) continue;
        var focus = captureFocus(m.wrap);
        m.wrap.replaceChildren(q.build());
        m.key = q.key;
        restoreFocus(m.wrap, focus);
      }
    }

    syncIntervals(view);
  }

  /** 상단 알림 영역. 조작 요소가 없어 매 렌더마다 통째로 다시 만든다. */
  function renderNotice() {
    var el = document.getElementById('notice');
    if (!el) return;
    var kids = [];
    // 최초 연결 전에는 경고하지 않는다 — 붙은 적이 있는데 끊긴 경우만 알린다.
    if (state.everConnected && !state.online) {
      // 서버가 이 소켓을 강제로 끊은 경우(다른 탭에서 재접속 등) 클라이언트는 자동 재연결하지 않는다.
      var text = state.disconnectReason === 'io server disconnect'
        ? '다른 곳에서 접속하여 이 연결은 종료되었습니다. 이 탭을 닫거나 새로고침하세요.'
        : '서버와 연결이 끊겼습니다. 자동으로 다시 연결합니다…';
      kids.push(h('div', { class: 'banner warn', text: text }));
    }
    if (state.toast) {
      kids.push(h('div', { class: 'banner ' + (state.toast.kind || 'info'), text: state.toast.text }));
    }
    // 재대전 초대 배너 (C1) — 로비·결과 화면에서만 보인다. 대기실·대전 화면에서는 조작을 방해하지 않는다.
    if (state.invite) {
      var view = currentView();
      if (view === 'lobby' || view === 'result') {
        var inv = state.invite;
        kids.push(h('div', { class: 'banner invite' }, [
          h('div', { text: (inv.fromNickname || '상대') + ' 님이 재대전을 신청했습니다 — ' + (inv.name || '') }),
          h('div', { class: 'qactions' }, [
            h('button', { class: 'btn sm', text: '참여', onclick: function () { joinRoom(inv.roomId); } }),
            h('button', { class: 'btn ghost sm', text: '무시', onclick: function () { state.invite = null; render(); } }),
          ]),
        ]));
      }
    }
    el.replaceChildren(frag(kids));
  }

  function syncIntervals(view) {
    // 로비에서만 방 목록을 5초마다 갱신한다.
    if (view === 'lobby' && !intervals.rooms) {
      intervals.rooms = setInterval(loadRooms, ROOMS_POLL_MS);
    } else if (view !== 'lobby' && intervals.rooms) {
      clearInterval(intervals.rooms); intervals.rooms = null;
    }

    // 카운트다운·타이머 표시를 위한 주기 렌더. 패널 key 가 같으면 실제 재빌드는 일어나지 않는다.
    var wantTick = (view === 'room' && state.room && state.room.state === 'countdown') || view === 'battle';
    if (wantTick && !intervals.tick) {
      intervals.tick = setInterval(render, BATTLE_TICK_MS);
    } else if (!wantTick && intervals.tick) {
      clearInterval(intervals.tick); intervals.tick = null;
    }
  }

  // ============================================================== 로비 화면

  function planLobby() {
    return [
      {
        name: 'rooms',
        key: JSON.stringify(state.rooms) + '|' + state.roomsError + '|' + state.joiningRoomId + '|' + state.online,
        build: buildRoomList,
      },
      {
        name: 'create',
        key: [
          state.form.mode,
          state.form.roundIds.join(','),
          state.form.questionCount,
          state.form.timeLimitS,
          state.form.type,
          state.roundList.length,
          state.roundsError,
          state.createError,
          state.creating ? 1 : 0,
        ].join('|'),
        build: buildCreateForm,
      },
    ];
  }

  function buildRoomList() {
    var kids = [h('h2', { text: '대전방 목록' })];

    if (state.roomsError) {
      kids.push(h('div', { class: 'banner err', text: state.roomsError }));
    }

    if (!state.rooms.length) {
      kids.push(h('div', { class: 'empty', text: '열려 있는 대전방이 없습니다. 아래에서 새로 만들어 보세요.' }));
    } else {
      var rows = state.rooms.map(function (r) {
        var host = r.host && typeof r.host === 'object' ? (r.host.nickname || '') : (r.host || '');
        var meta = ['방장 ' + host, (r.playerCount || 0) + '명', MODE_LABEL[r.mode] || r.mode || ''];
        if (r.questionCount) meta.push(r.questionCount + '문항');
        // 유형 필터가 걸린 방만 표기한다 (없으면 전체 출제 — 굳이 적지 않는다).
        var rType = normalizeType(r.type || (r.settings && r.settings.type));
        if (rType) meta.push(TYPE_LABEL[rType]);
        if (r.timeLimitS) meta.push(Math.round(r.timeLimitS / 60) + '분');
        return h('div', { class: 'room' }, [
          h('span', { class: 'rname', text: r.name || '(이름 없음)' }),
          h('span', { class: 'rmeta', text: meta.join(' · ') }),
          h('button', {
            class: 'btn sm',
            disabled: state.joiningRoomId != null || !state.online,
            text: state.joiningRoomId === r.roomId ? '참여 중…' : '참여',
            onclick: function () { joinRoom(r.roomId); },
          }),
        ]);
      });
      kids.push(h('div', { class: 'roomlist' }, rows));
    }

    kids.push(h('div', { class: 'qactions' }, [
      h('button', { class: 'btn ghost sm', text: '목록 새로고침', onclick: loadRooms }),
    ]));

    // 방 코드로 참여 (A3) — 목록에 없는 방(예: 곧 시작되어 목록에서 빠진 방)도 코드만 알면 들어간다.
    kids.push(h('div', { class: 'codejoin' }, [
      h('input', {
        type: 'text',
        class: 'codeinput',
        'data-fkey': 'join:code',
        maxlength: '6',
        placeholder: '방 코드 6자리',
        value: state.joinCode || '',
        // 타이핑은 재렌더하지 않는다(IME 보호). 대문자화는 state 값 자체를 정규화한다.
        oninput: function (e) { state.joinCode = e.target.value.toUpperCase(); },
      }),
      h('button', {
        class: 'btn sm',
        disabled: state.joiningRoomId != null || !state.online,
        text: '코드로 참여',
        onclick: function () {
          var code = (state.joinCode || '').trim().toUpperCase();
          if (!code) { toast('err', '방 코드를 입력해 주세요.'); return; }
          joinRoom(code);
        },
      }),
    ]));

    return frag(h('section', { class: 'card' }, kids));
  }

  function buildCreateForm() {
    var f = state.form;
    var isRandom = f.mode === 'random';

    var modeRow = h('div', { class: 'radiorow' }, ['round', 'random'].map(function (m) {
      return h('label', { class: 'chip' + (f.mode === m ? ' on' : '') }, [
        h('input', {
          type: 'radio', name: 'mode', checked: f.mode === m,
          onchange: function () {
            f.mode = m;
            // 회차 전체 모드는 단일 선택이다 — 여러 개 골라 둔 상태였다면 첫 개만 남긴다.
            if (m === 'round' && f.roundIds.length > 1) f.roundIds = [f.roundIds[0]];
            state.createError = '';
            render();
          },
        }),
        h('span', { text: MODE_LABEL[m] }),
      ]);
    }));

    var roundKids;
    if (state.roundsError) {
      roundKids = h('div', { class: 'banner err', text: state.roundsError });
    } else if (!state.roundList.length) {
      roundKids = h('div', { class: 'empty', text: '불러올 회차가 없습니다.' });
    } else {
      roundKids = h('div', { class: 'chips' }, state.roundList.map(function (r) {
        var on = f.roundIds.indexOf(r.round) !== -1;
        return h('label', { class: 'chip' + (on ? ' on' : '') }, [
          h('input', {
            type: isRandom ? 'checkbox' : 'radio',
            name: isRandom ? 'round-' + r.round : 'round',
            checked: on,
            onchange: function () {
              if (!isRandom) {
                f.roundIds = [r.round];
              } else if (on) {
                f.roundIds = f.roundIds.filter(function (x) { return x !== r.round; });
              } else {
                f.roundIds = f.roundIds.concat([r.round]);
              }
              state.createError = '';
              render();
            },
          }),
          h('span', { text: r.title || r.round }),
          h('span', { class: 'cnt', text: (r.questionCount || 0) + '문항' }),
        ]);
      }));
    }

    var yearControls = null;
    if (isRandom && state.roundList.length) {
      var allIds = state.roundList.map(function (r) { return r.round; });
      var years = yearsInRoundList();
      yearControls = h('div', { class: 'yearrow' }, [
        h('div', { class: 'radiorow' }, [
          h('button', {
            type: 'button', class: 'btn ghost sm', text: '전체 선택',
            onclick: function () { f.roundIds = allIds.slice(); state.createError = ''; render(); },
          }),
          h('button', {
            type: 'button', class: 'btn ghost sm', text: '전체 해제',
            onclick: function () { f.roundIds = []; state.createError = ''; render(); },
          }),
          years.map(function (y) {
            var ids = roundIdsOfYear(y);
            var allOn = ids.length > 0 && ids.every(function (id) { return f.roundIds.indexOf(id) !== -1; });
            return h('button', {
              type: 'button',
              class: 'btn ghost sm year-toggle' + (allOn ? ' on' : ''),
              text: y + '년',
              onclick: function () {
                if (allOn) {
                  f.roundIds = f.roundIds.filter(function (id) { return ids.indexOf(id) === -1; });
                } else {
                  var next = f.roundIds.slice();
                  for (var k = 0; k < ids.length; k++) if (next.indexOf(ids[k]) === -1) next.push(ids[k]);
                  f.roundIds = next;
                }
                state.createError = '';
                render();
              },
            });
          }),
        ]),
        h('div', { class: 'muted', text: f.roundIds.length + '개 회차 선택' }),
      ]);
    }

    var fields = [
      h('div', { class: 'field' }, [
        h('span', { class: 'flabel', text: '방 이름' }),
        h('input', {
          type: 'text', 'data-fkey': 'form:name', maxlength: '40',
          placeholder: '예) 실기 스피드런', value: f.name,
          oninput: function (e) { f.name = e.target.value; }, // 타이핑은 재렌더하지 않는다(IME 보호)
        }),
      ]),
      h('div', { class: 'field' }, [h('span', { class: 'flabel', text: '모드' }), modeRow]),
      h('div', { class: 'field' }, [
        h('span', { class: 'flabel', text: isRandom ? '회차 선택 (여러 개)' : '회차 선택 (하나)' }),
        roundKids,
        yearControls,
      ]),
    ];

    if (isRandom) {
      fields.push(h('div', { class: 'field' }, [
        h('span', { class: 'flabel', text: '문항 수' }),
        h('div', { class: 'radiorow' }, COUNT_CHOICES.map(function (n) {
          return h('label', { class: 'chip' + (f.questionCount === n ? ' on' : '') }, [
            h('input', {
              type: 'radio', name: 'qcount', checked: f.questionCount === n,
              onchange: function () { f.questionCount = n; state.createError = ''; render(); },
            }),
            h('span', { text: n + '문항' }),
          ]);
        })),
      ]));
    }

    // 문항 유형 — 방 생성 시 1회만 적용된다(진행 중 변경 없음). 전체면 서버에 싣지 않는다.
    fields.push(h('div', { class: 'field' }, [
      h('span', { class: 'flabel', text: '문항 유형' }),
      h('div', { class: 'radiorow' }, [{ v: '', label: '전체' }].concat(TYPE_ORDER.map(function (t) {
        return { v: t, label: TYPE_LABEL[t] };
      })).map(function (o) {
        return h('label', { class: 'chip' + (f.type === o.v ? ' on' : ''), 'data-type': o.v || 'all' }, [
          h('input', {
            type: 'radio', name: 'qtype', checked: f.type === o.v,
            onchange: function () { f.type = o.v; state.createError = ''; render(); },
          }),
          h('span', { text: o.label }),
        ]);
      })),
    ]));

    fields.push(h('div', { class: 'field' }, [
      h('span', { class: 'flabel', text: '제한 시간' }),
      h('div', { class: 'radiorow' }, TIME_CHOICES.map(function (c) {
        return h('label', { class: 'chip' + (f.timeLimitS === c.v ? ' on' : '') }, [
          h('input', {
            type: 'radio', name: 'tlimit', checked: f.timeLimitS === c.v,
            onchange: function () { f.timeLimitS = c.v; state.createError = ''; render(); },
          }),
          h('span', { text: c.label }),
        ]);
      })),
    ]));

    var kids = [h('h2', { text: '새 대전방 만들기' }), h('div', { class: 'formgrid' }, fields)];

    if (state.createError) kids.push(h('div', { class: 'banner err', text: state.createError }));

    kids.push(h('div', { class: 'qactions' }, [
      h('button', {
        class: 'btn',
        disabled: state.creating || !state.online,
        text: state.creating ? '만드는 중…' : '방 만들기',
        onclick: createRoom,
      }),
    ]));
    kids.push(h('p', { class: 'muted', text: '방을 만들면 자동으로 입장합니다. 2명 이상 모이면 방장이 시작할 수 있습니다.' }));

    return frag(h('section', { class: 'card' }, kids));
  }

  // ============================================================ 대기실 화면

  function planRoom() {
    var counting = state.room.state === 'countdown';
    return [{
      name: 'room',
      key: [
        state.room.state,
        counting ? countdownSeconds() : '',
        JSON.stringify(state.room.players),
        JSON.stringify(state.room.settings),
        state.online,
        state.copied.roomcode || '',
      ].join('|'),
      build: buildRoom,
    }];
  }

  function buildRoom() {
    var s = settings() || {};
    var counting = state.room.state === 'countdown';
    var kids = [];

    if (counting) {
      var n = countdownSeconds();
      kids.push(h('section', { class: 'card' }, [
        h('div', { class: 'timerbar' }, [
          h('div', { class: 'timer urgent', text: n > 0 ? String(n) : '시작!' }),
          h('div', { class: 'tlabel', text: '곧 시작합니다' }),
        ]),
      ]));
    }

    var roundText = (s.roundIds || []).map(roundTitle).join(', ') || '-';
    kids.push(h('section', { class: 'card' }, [
      h('h2', { text: s.name || '대기실' }),
      h('div', { class: 'roomcode' }, [
        h('span', { class: 'code-text', text: '방 코드 ' + (s.roomId || '-') + ' — 친구에게 알려 주세요' }),
        h('button', { class: 'btn ghost sm', text: '코드 복사', onclick: function () { copyRoomCode(s.roomId); } }),
        state.copied.roomcode
          ? h('span', { class: 'copied', text: state.copied.roomcode === 'manual' ? '복사 창을 열었습니다' : '복사했습니다' })
          : null,
      ]),
      h('div', { class: 'setting-list' }, [
        h('div', {}, [h('b', { text: '모드 ' }), MODE_LABEL[s.mode] || s.mode || '-']),
        h('div', {}, [h('b', { text: '회차 ' }), roundText]),
        h('div', {}, [h('b', { text: '문항 수 ' }), (s.questionCount || 0) + '문항']),
        h('div', {}, [h('b', { text: '문항 유형 ' }), TYPE_LABEL[normalizeType(s.type)] || '전체']),
        h('div', {}, [h('b', { text: '제한 시간 ' }), Math.round((s.timeLimitS || 0) / 60) + '분']),
      ]),
    ]));

    var list = players();
    kids.push(h('section', { class: 'card' }, [
      h('h2', { text: '참가자 ' + list.length + '명' }),
      h('div', { class: 'playerlist' }, list.map(function (p) {
        var badges = [];
        if (s.hostUserId === p.userId) badges.push(h('span', { class: 'badge host', text: '방장' }));
        if (p.userId === myId()) badges.push(h('span', { class: 'badge me', text: '나' }));
        badges.push(h('span', {
          class: 'badge ' + (p.connected ? 'on' : 'off'),
          text: p.connected ? '접속중' : '끊김',
        }));
        return h('div', { class: 'player' }, [h('span', { class: 'pname', text: p.nickname }), badges]);
      })),
      list.length < 2
        ? h('p', { class: 'muted', text: '2명 이상이어야 시작할 수 있습니다.' })
        : null,
      h('div', { class: 'qactions' }, [
        isHost()
          ? h('button', {
            class: 'btn',
            disabled: counting || list.length < 2 || !state.online,
            text: counting ? '시작 중…' : '시작',
            onclick: startBattle,
          })
          : h('span', { class: 'muted', text: counting ? '곧 시작합니다.' : '방장이 시작하기를 기다리는 중입니다.' }),
        h('button', { class: 'btn ghost', text: '나가기', onclick: leaveRoom }),
      ]),
    ]));

    return frag(kids);
  }

  // ============================================================== 대전 화면

  function planBattle() {
    var ro = iAmSubmitted() || state.room.state !== 'playing';
    var showMarks = iAmSubmitted() && state.room.state === 'playing';
    return [
      {
        // 조작 요소가 없는 패널 — 남은 시간(초)·진행 현황이 바뀔 때마다 통째로 다시 만든다.
        name: 'live',
        key: [
          fmtClock(remainingMs()),
          JSON.stringify(state.progress),
          JSON.stringify(players()),
          ro ? 1 : 0,
          state.online,
        ].join('|'),
        build: buildLive,
      },
      {
        // 제출자끼리만 보이는 상호 정오 현황(요구 2) — question list 배너보다 위에 둔다.
        name: 'marks',
        key: [
          showMarks ? 1 : 0,
          JSON.stringify(state.marks),
        ].join('|'),
        build: buildMarksCard,
      },
      {
        // 입력을 품은 패널 — key 에 입력값을 넣지 않는다. 타이핑 중 재빌드가 없어야 한글 조합이 산다.
        name: 'questions',
        key: [
          state.questions.map(function (q) { return q.id; }).join(','),
          ro ? 1 : 0,
        ].join('|'),
        build: buildQuestions,
      },
      {
        // 스크롤 시 나타나는 플로팅 현황 패널(요구 1) — 조작 요소 없음(맨 위로 버튼 제외).
        name: 'float',
        key: [
          state.floatVisible ? 1 : 0,
          fmtClock(remainingMs()),
          JSON.stringify(state.progress),
          JSON.stringify(players()),
          JSON.stringify(state.marks),
          state.online,
        ].join('|'),
        build: buildFloat,
      },
    ];
  }

  function buildLive() {
    var rm = remainingMs();
    var total = totalQuestions();
    var urgent = rm != null && rm < 60000;

    var rows = players().map(function (p) {
      var n = answeredCountOf(p);
      var pct = total > 0 ? Math.round((n / total) * 100) : 0;
      var marks = [];
      if (p.submitted) marks.push(h('span', { class: 'badge me', text: '제출' }));
      if (!p.connected) marks.push(h('span', { class: 'pdc', text: p.left ? '이탈' : '끊김' }));
      return h('div', { class: 'prow' }, [
        h('span', { class: 'pn' + (p.userId === myId() ? ' self' : ''), text: p.nickname }),
        h('span', { class: 'ptrack' }, [h('span', { class: 'pfill', style: 'width:' + pct + '%' })]),
        h('span', { class: 'pnum', text: n + '/' + total }),
        marks,
      ]);
    });

    return frag(h('div', { class: 'timerbar' }, [
      h('div', { class: 'timer' + (urgent ? ' urgent' : ''), text: rm == null ? '--:--' : fmtClock(rm) }),
      h('div', { class: 'tlabel', text: '남은 시간 · 진행 현황(정답 여부는 공개되지 않습니다)' }),
      h('div', { class: 'progresslist' }, rows.length ? rows : h('div', { class: 'muted', text: '참가자 정보를 기다리는 중입니다.' })),
    ]));
  }

  /**
   * 제출한 사람끼리만 보이는 상호 정오 현황(요구 2). state.marks 는 battle:marks 로만 채워지며,
   * 미제출자에게는 서버가 애초에 보내지 않는다 — 그래도 iAmSubmitted() 를 다시 확인해 방어한다.
   */
  function buildMarksCard() {
    if (!iAmSubmitted() || !state.room || state.room.state !== 'playing') return frag();
    if (!state.marks || !state.marks.length) return frag();

    var qs = state.questions;
    var rows = state.marks.map(function (m) {
      var marksById = m.marks || {};
      var chips = qs.map(function (q, idx) {
        var v = marksById[q.id];
        var cls = 'mark-chip' + (v === true ? ' ok' : (v === false ? ' bad' : ''));
        var sym = v === true ? '○' : (v === false ? '✕' : '·');
        return h('span', { class: cls, title: (q.num == null ? idx + 1 : q.num) + '번', text: sym });
      });
      return h('div', { class: 'marks-row' }, [
        h('span', { class: 'marks-name' + (m.userId === myId() ? ' self' : ''), text: m.nickname }),
        h('div', { class: 'marks-chips' }, chips),
      ]);
    });

    return frag(h('section', { class: 'card marks-card' }, [
      h('h2', { text: '채점 현황' }),
      h('div', { class: 'marks-list' }, rows),
      h('p', { class: 'muted', text: '제출한 사람끼리만 서로 보입니다. 답 내용은 공개되지 않습니다.' }),
    ]));
  }

  function buildQuestions() {
    var ro = iAmSubmitted() || state.room.state !== 'playing';
    var kids = [];

    if (!state.questions.length) {
      kids.push(h('section', { class: 'card' }, [h('div', { class: 'empty', text: '문항을 받는 중입니다…' })]));
      return frag(kids);
    }

    if (ro) {
      kids.push(h('div', {
        class: 'banner info',
        text: '제출이 완료되었습니다. 모든 참가자가 제출하거나 제한 시간이 끝나면 결과가 나옵니다.',
      }));
    }

    for (var i = 0; i < state.questions.length; i++) {
      kids.push(buildQuestionCard(state.questions[i], ro));
    }

    if (!ro) {
      kids.push(h('div', { class: 'btnbar' }, [
        h('button', { class: 'btn', text: '제출하기', disabled: !state.online, onclick: submitBattle }),
        h('p', { class: 'muted', text: '제출은 되돌릴 수 없습니다. 제출 후에는 답안을 고칠 수 없습니다.' }),
      ]));
      kids.push(h('div', { class: 'qactions' }, [
        h('button', { class: 'btn ghost sm', text: '포기하고 제출 후 나가기', onclick: leaveRoom }),
      ]));
    }

    return frag(kids);
  }

  function buildQuestionCard(q, readOnly) {
    var fields = q.fields || [];
    var answers = state.myAnswers[q.id] || [];

    var rows = fields.map(function (f, idx) {
      return h('div', { class: 'ansrow' }, [
        h('label', { text: (f.label || '답') + ':' }),
        h('input', {
          class: 'ans',
          type: 'text',
          'data-fkey': 'ans:' + q.id + ':' + idx,
          value: answers[idx] == null ? '' : answers[idx],
          readOnly: readOnly,
          maxlength: '500',
          autocomplete: 'off',
          autocapitalize: 'off',
          spellcheck: 'false',
          placeholder: readOnly ? '' : '답을 입력하세요',
          oninput: function (e) { onAnswerInput(q, idx, e.target.value); },
        }),
      ]);
    });

    var badge = typeBadge(q.type);
    return h('div', { class: 'q' + (readOnly ? ' readonly' : '') }, [
      badge ? h('div', { class: 'q-badges' }, [badge]) : null,
      h('div', { class: 'qtitle' }, [
        h('span', { class: 'num', text: String(q.num == null ? '' : q.num) }),
        h('span', { html: q.prompt || '' }), // 서버 자산의 신뢰 마크업
      ]),
      q.bodyHtml ? h('div', { html: q.bodyHtml }) : null,
      rows,
    ]);
  }

  function onAnswerInput(q, idx, value) {
    var fields = q.fields || [];
    var arr = state.myAnswers[q.id];
    if (!arr) { arr = []; state.myAnswers[q.id] = arr; }
    while (arr.length < fields.length) arr.push('');
    arr[idx] = value;
    scheduleAnswer(q.id, idx, value);
    // 의도적으로 render() 하지 않는다. 이 입력의 DOM 값은 이미 render(state) 결과와 같고,
    // 재빌드하면 한글 조합이 끊긴다. 내 answeredCount 는 서버의 battle:progress 로 되돌아온다.
  }

  /**
   * 스크롤 시 나타나는 플로팅 현황 패널(요구 1). state.floatVisible 이 아니면 빈 프래그먼트를
   * 반환해 아무것도 그리지 않는다 — 조작 요소는 "맨 위로" 버튼뿐이라 재빌드해도 안전하다.
   */
  function buildFloat() {
    if (!state.floatVisible) return frag();

    var rm = remainingMs();
    var total = totalQuestions();
    var urgent = rm != null && rm < 60000;

    var rows = players().map(function (p) {
      var n = answeredCountOf(p);
      var badges = [];
      if (p.submitted) badges.push(h('span', { class: 'badge me', text: '제출' }));
      if (!p.connected) badges.push(h('span', { class: 'pdc', text: p.left ? '이탈' : '끊김' }));
      return h('div', { class: 'fprow' }, [
        h('span', { class: 'fpn' + (p.userId === myId() ? ' self' : ''), text: p.nickname }),
        h('span', { class: 'fpnum', text: n + '/' + total }),
        badges,
      ]);
    });

    var kids = [
      h('div', { class: 'ftime' + (urgent ? ' urgent' : ''), text: rm == null ? '--:--' : fmtClock(rm) }),
      h('div', { class: 'fprows' }, rows),
    ];

    // 제출자 요약 한 줄(요구 2, 선택) — state.marks 에서 문항별 정오 개수를 가볍게 센다.
    if (iAmSubmitted() && state.marks && state.marks.length) {
      var summary = state.marks.map(function (m) {
        var marksById = m.marks || {};
        var keys = Object.keys(marksById);
        var correct = 0;
        for (var i = 0; i < keys.length; i++) if (marksById[keys[i]] === true) correct += 1;
        var label = m.userId === myId() ? '나' : m.nickname;
        return label + ' ' + correct + '/' + (keys.length || total);
      }).join(' · ');
      kids.push(h('div', { class: 'fsummary', text: summary }));
    }

    kids.push(h('button', {
      class: 'btn ghost sm ftop',
      text: '맨 위로',
      onclick: function () { if (window.scrollTo) window.scrollTo(0, 0); },
    }));

    return frag(h('div', { class: 'floatpanel' }, kids));
  }

  // ============================================================== 결과 화면

  function planResult() {
    return [{
      name: 'result',
      key: [
        state.result ? state.result.winnerUserId : '',
        state.result ? state.result.results.length : 0,
        JSON.stringify(state.showExplain),
        JSON.stringify(state.reportOpen),
        JSON.stringify(state.reportStatus),
        JSON.stringify(state.copied),
        state.rematching ? 1 : 0,
        state.online,
      ].join('|'),
      build: buildResult,
    }];
  }

  function buildResult() {
    var r = state.result;
    var kids = [];

    var mine = null;
    var rows = (r.results || []).slice().sort(function (a, b) {
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
      var sa = a.effectiveSubmittedAt == null ? Infinity : a.effectiveSubmittedAt;
      var sb = b.effectiveSubmittedAt == null ? Infinity : b.effectiveSubmittedAt;
      return sa - sb;
    });
    for (var i = 0; i < rows.length; i++) if (rows[i].userId === myId()) mine = rows[i];

    var draw = r.winnerUserId == null;
    var iWon = !draw && r.winnerUserId === myId();
    var verdictClass = draw ? 'verdict draw' : (iWon ? 'verdict' : 'verdict lose');
    var verdictText = draw ? '무승부' : (iWon ? '승리!' : '패배');

    kids.push(h('section', { class: 'card result-head' }, [
      h('div', { class: verdictClass, text: verdictText }),
      h('div', {
        class: 'muted',
        text: mine
          ? mine.correctCount + '/' + (mine.totalCount || totalQuestions()) + '문항 정답 · ' + mine.score + '점'
          : '결과를 불러왔습니다.',
      }),
      draw ? h('div', { class: 'muted', text: '정답 수·제출 시각·마지막 입력 시각이 모두 같아 승자가 없습니다.' }) : null,
      r.reason === 'deadline' ? h('div', { class: 'muted', text: '제한 시간이 끝나 종료되었습니다.' }) : null,
    ]));

    kids.push(h('section', { class: 'card' }, [
      h('h2', { text: '최종 결과' }),
      h('div', { class: 'tablewrap' }, [
        h('table', { class: 'res' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '닉네임' }),
            h('th', { text: '정답 수' }),
            h('th', { text: '점수' }),
            h('th', { text: '제출 시각' }),
          ])]),
          h('tbody', {}, rows.map(function (row) {
            var cls = [];
            if (!draw && row.userId === r.winnerUserId) cls.push('win');
            if (row.userId === myId()) cls.push('self');
            return h('tr', { class: cls.join(' ') }, [
              h('td', { text: row.nickname + (row.left ? ' (이탈)' : '') }),
              h('td', { text: row.correctCount + '/' + (row.totalCount || totalQuestions()) }),
              h('td', { text: row.score + '점' }),
              h('td', { text: fmtTime(row.submittedAt) }),
            ]);
          })),
        ]),
      ]),
      draw ? h('p', { class: 'muted', text: '무승부 — 승점은 전원 +1점입니다.' }) : null,
    ]));

    var details = r.details || [];
    kids.push(h('h2', { class: 'section', text: '문항별 채점 (' + details.length + '문항)' }));
    for (var d = 0; d < details.length; d++) kids.push(buildDetailCard(details[d]));

    kids.push(h('div', { class: 'btnbar' }, [
      h('button', {
        class: 'btn',
        disabled: state.rematching || !state.online,
        text: state.rematching ? '만드는 중…' : '한 판 더 (같은 설정)',
        onclick: rematch,
      }),
      h('button', { class: 'btn ghost', text: '로비로', onclick: backToLobby }),
    ]));

    return frag(kids);
  }

  /** 재대전 (C1) — 같은 설정으로 새 방을 만들고, 이번 판 다른 참가자들을 초대한다. */
  function rematch() {
    var s = settings();
    var r = state.result;
    if (!s || !r) {
      toast('err', '이전 방 설정을 찾을 수 없습니다.');
      return;
    }
    var others = (r.results || [])
      .map(function (row) { return row.userId; })
      .filter(function (id) { return id != null && id !== myId(); });

    var body = {
      name: s.name,
      mode: s.mode,
      roundIds: (s.roundIds || []).slice(),
      timeLimitS: s.timeLimitS,
      inviteUserIds: others,
    };
    if (s.mode === 'random') body.questionCount = s.questionCount;
    // 같은 설정으로 다시 — 유형 필터도 그대로 이어간다.
    if (normalizeType(s.type)) body.type = normalizeType(s.type);

    state.rematching = true;
    render();

    window.api.post('/api/rooms', body)
      .then(function (res) {
        state.rematching = false;
        if (!res || !res.roomId) {
          toast('err', '방 생성 응답이 올바르지 않습니다.');
          render();
          return;
        }
        render();
        joinRoom(res.roomId);
      })
      .catch(function (e) {
        state.rematching = false;
        toast('err', e && e.message ? e.message : '재대전 방을 만들지 못했습니다.');
        render();
      });
  }

  /**
   * 문항 해설 HTML. battle:finished 페이로드의 최상위 `explanations[qid]` 에서 온다 —
   * battle:questions / battle:resync 에는 들어 있지 않으므로 대전 중에는 항상 빈 문자열이다.
   */
  function explanationOf(qid) {
    var map = (state.result && state.result.explanations) || {};
    var html = map[qid];
    return typeof html === 'string' ? html : '';
  }

  function buildDetailCard(detail) {
    var q = questionById(detail.questionId);
    var qid = detail.questionId;
    var fieldResults = detail.fieldResults || [];

    var rows = fieldResults.map(function (fr) {
      return h('div', { class: 'ansrow' }, [
        h('label', { text: (fr.label || '답') + ':' }),
        h('input', {
          class: 'ans ' + (fr.correct ? 'ok' : 'bad'),
          type: 'text',
          value: fr.given || '',
          disabled: true,
        }),
      ]);
    });

    var typeChip = typeBadge(q && q.type);
    var kids = [
      typeChip ? h('div', { class: 'q-badges' }, [typeChip]) : null,
      h('div', { class: 'qtitle' }, [
        h('span', { class: 'num', text: q ? String(q.num) : '?' }),
        h('span', { html: q ? (q.prompt || '') : qid }),
      ]),
      q && q.bodyHtml ? h('div', { html: q.bodyHtml }) : null,
      rows,
      h('div', { class: 'feedback' }, [
        h('div', { text: detail.correct ? '정답입니다.' : '오답입니다.' }),
        h('div', { class: 'answer-line', text: '정답: ' + (detail.display || '(표기 없음)') }),
      ]),
    ];

    // 해설 — 정답·오답 카드 모두. 피드백 줄 바로 아래, 버튼 줄 위에 온다.
    var explainHtml = explanationOf(qid);
    if (explainHtml && state.showExplain[qid]) {
      // 서버가 검증(validate:explain)해서 내려주는 신뢰 마크업이다 — 화이트리스트 태그만 들어 있다.
      kids.push(h('div', { class: 'explain-box', html: explainHtml }));
    }

    var actions = [];
    if (explainHtml) {
      actions.push(h('button', {
        class: 'btn ghost sm',
        'data-explain': qid,
        text: state.showExplain[qid] ? '해설 닫기' : '해설 보기',
        onclick: function () {
          state.showExplain[qid] = !state.showExplain[qid];
          render();
        },
      }));
    }
    if (!detail.correct) {
      actions.push(h('button', {
        class: 'btn ghost sm',
        text: 'AI 질문 복사',
        onclick: function () { copyAiPrompt(detail); },
      }));
      if (state.copied[qid]) {
        actions.push(h('span', {
          class: 'copied',
          text: state.copied[qid] === 'manual' ? '복사 창을 열었습니다' : '복사했습니다',
        }));
      }
    }
    // 접수 완료 후에는 다시 열 수 없게 잠근다(study.js 와 동일 동작).
    var reportSent = state.reportStatus[qid] === '접수되었습니다. 고맙습니다!';
    actions.push(h('button', {
      class: 'btn ghost sm',
      disabled: reportSent,
      text: reportSent ? '이의 제기 접수됨' : (state.reportOpen[qid] ? '이의 제기 닫기' : '정답 이의 제기'),
      onclick: function () {
        state.reportOpen[qid] = !state.reportOpen[qid];
        render();
      },
    }));
    // 상자가 닫혀 있어도(접수 완료로 자동으로 닫힌 경우 포함) 상태 문구는 보여야 한다.
    if (!state.reportOpen[qid] && state.reportStatus[qid]) {
      actions.push(h('span', { class: 'muted', text: state.reportStatus[qid] }));
    }
    kids.push(h('div', { class: 'qactions' }, actions));

    if (state.reportOpen[qid]) {
      kids.push(h('div', { class: 'reportbox' }, [
        h('textarea', {
          'data-fkey': 'report:' + qid,
          placeholder: '어떤 점이 이상한지 적어 주세요. (예: 제 답도 인정되어야 합니다 — 근거)',
          value: state.reportText[qid] || '',
          oninput: function (e) { state.reportText[qid] = e.target.value; }, // 타이핑은 재렌더하지 않는다
        }),
        h('div', { class: 'qactions' }, [
          h('button', { class: 'btn sm', text: '보내기', onclick: function () { sendReport(detail); } }),
          state.reportStatus[qid] ? h('span', { class: 'muted', text: state.reportStatus[qid] }) : null,
        ]),
      ]));
    }

    return h('div', { class: 'q ' + (detail.correct ? 'correct' : 'wrong') }, kids);
  }

  /** 학습 모드와 동일한 4단 프롬프트: [문제] / [내 답] / [정답] / 풀이 요청. */
  function buildAiPrompt(detail) {
    var q = questionById(detail.questionId);
    // bodyText 는 battle:questions 의 publicQuestion 에 포함되어 있다(server/battle.js).
    // 없으면 prompt 로 대체한다.
    var body = q ? (q.bodyText || q.prompt || '') : '';
    var fieldResults = detail.fieldResults || [];
    var mine = fieldResults.map(function (fr) {
      var v = (fr.given || '').trim();
      var label = fr.label ? fr.label + ': ' : '';
      return label + (v === '' ? '(미입력)' : v);
    }).join('\n');
    return [
      '[문제]',
      body,
      '',
      '[내 답]',
      mine || '(미입력)',
      '',
      '[정답]',
      detail.display || '(표기 없음)',
      '',
      '풀이 과정을 설명해줘',
    ].join('\n');
  }

  /** 대기실 방 코드 복사 (A3) — 결과 화면 copyAiPrompt 와 동일한 3단 폴백·표시 규칙. */
  function copyRoomCode(code) {
    var copy = window.copyText;
    if (typeof copy !== 'function') {
      toast('err', '복사 기능을 불러오지 못했습니다.');
      return;
    }
    copy(code || '').then(function (mode) {
      state.copied.roomcode = mode || 'clipboard';
      render();
      setTimeout(function () {
        if (!state.copied.roomcode) return;
        delete state.copied.roomcode;
        render();
      }, 2500);
    }).catch(function () {
      toast('err', '복사에 실패했습니다.');
    });
  }

  function copyAiPrompt(detail) {
    var qid = detail.questionId;
    var text = buildAiPrompt(detail);
    var copy = window.copyText;
    if (typeof copy !== 'function') {
      toast('err', '복사 기능을 불러오지 못했습니다.');
      return;
    }
    copy(text).then(function (mode) {
      state.copied[qid] = mode || 'clipboard';
      render();
      setTimeout(function () {
        if (!state.copied[qid]) return;
        delete state.copied[qid];
        render();
      }, 2500);
    }).catch(function () {
      toast('err', '복사에 실패했습니다.');
    });
  }

  function sendReport(detail) {
    var qid = detail.questionId;
    var comment = (state.reportText[qid] || '').trim();
    if (!comment) {
      state.reportStatus[qid] = '내용을 적어 주세요.';
      render();
      return;
    }
    var myAnswer = (detail.fieldResults || []).map(function (fr) { return fr.given || ''; });
    state.reportStatus[qid] = '보내는 중…';
    render();
    window.api.post('/api/reports', { questionId: qid, myAnswer: myAnswer, comment: comment })
      .then(function () {
        state.reportStatus[qid] = '접수되었습니다. 고맙습니다!';
        state.reportText[qid] = '';
        state.reportOpen[qid] = false;
        render();
      })
      .catch(function (e) {
        state.reportStatus[qid] = e && e.message ? e.message : '전송에 실패했습니다.';
        render();
      });
  }

  function backToLobby() {
    state.room = null;
    state.result = null;
    state.questions = [];
    state.myAnswers = {};
    state.progress = {};
    state.submitted = false;
    state.submitPending = false;
    state.showExplain = {};
    state.reportOpen = {};
    state.reportText = {};
    state.reportStatus = {};
    state.copied = {};
    state.rematching = false;
    state.marks = [];
    state.floatVisible = false;
    setTimer(null);
    render();
    loadRooms();
  }

  // ============================================================== 사용자 동작

  function loadRooms() {
    window.api.get('/api/rooms')
      .then(function (list) {
        state.rooms = Array.isArray(list) ? list : [];
        state.roomsError = '';
        render();
      })
      .catch(function (e) {
        state.rooms = [];
        state.roomsError = (e && e.message ? e.message : '방 목록을 불러오지 못했습니다.')
          + ' (대전 서버가 아직 준비되지 않았을 수 있습니다.)';
        render();
      });
  }

  function loadRounds() {
    window.api.get('/api/rounds')
      .then(function (list) {
        // 최신 회차가 위로 오도록 뒤집는다(서버는 연도 오름차순으로 준다).
        state.roundList = (Array.isArray(list) ? list : []).slice().reverse();
        state.roundsError = '';
        render();
      })
      .catch(function (e) {
        state.roundList = [];
        state.roundsError = e && e.message ? e.message : '회차 목록을 불러오지 못했습니다.';
        render();
      });
  }

  function createRoom() {
    var f = state.form;
    if (!f.roundIds.length) {
      state.createError = '회차를 하나 이상 선택해 주세요.';
      render();
      return;
    }
    var body = {
      name: f.name.trim() || (state.me.nickname + '의 대전방'),
      mode: f.mode,
      roundIds: f.roundIds.slice(),
      timeLimitS: f.timeLimitS,
    };
    if (f.mode === 'random') body.questionCount = f.questionCount;
    // 전체 유형이면 아예 싣지 않는다 (구버전 서버와도 그대로 호환된다).
    if (normalizeType(f.type)) body.type = normalizeType(f.type);

    state.creating = true;
    state.createError = '';
    render();

    window.api.post('/api/rooms', body)
      .then(function (res) {
        state.creating = false;
        if (!res || !res.roomId) {
          state.createError = '방 생성 응답이 올바르지 않습니다.';
          render();
          return;
        }
        render();
        joinRoom(res.roomId);
      })
      .catch(function (e) {
        state.creating = false;
        state.createError = e && e.message ? e.message : '방을 만들지 못했습니다.'; // 서버 400 사유를 그대로 노출
        render();
      });
  }

  function joinRoom(roomId) {
    state.ignoreRoomId = null;
    state.joiningRoomId = roomId;
    state.invite = null; // 어떤 방이든 참여하면 남아 있던 재대전 초대 배너는 지운다
    render();
    if (!emit('room:join', { roomId: roomId })) {
      state.joiningRoomId = null;
      render();
      return;
    }
    // 서버가 room:state 를 돌려주지 않으면(에러 등) 참여 표시가 영원히 남지 않도록 풀어 준다.
    setTimeout(function () {
      if (state.joiningRoomId !== roomId) return;
      state.joiningRoomId = null;
      render();
    }, 6000);
  }

  function leaveRoom() {
    var playing = state.room && state.room.state === 'playing';
    var msg = playing
      ? '대전 도중 나가면 지금까지 입력한 답안이 그대로 제출·채점되며, 다시 들어올 수 없습니다.\n나갈까요?'
      : '대기실에서 나갈까요?';
    if (!window.confirm(msg)) return;
    var s = settings();
    state.ignoreRoomId = s ? s.roomId : null;
    flushAllAnswers();
    emit('room:leave', {});
    backToLobby();
  }

  function startBattle() {
    emit('room:start', {});
  }

  function submitBattle() {
    if (!window.confirm('제출하면 되돌릴 수 없습니다.\n남은 시간이 있어도 답안을 고칠 수 없습니다.\n제출할까요?')) return;
    flushAllAnswers();
    if (!emit('battle:submit', {})) return;
    state.submitPending = true;
    render();
  }

  // ============================================================== 소켓 연결

  function connectSocket() {
    socket = window.io({ path: '/socket.io', withCredentials: true });

    socket.on('connect', function () {
      state.online = true;
      state.everConnected = true;
      state.disconnectReason = null;
      // 재접속 시 서버가 멤버십을 보고 battle:resync 를 자동으로 보낸다 (room:join 불필요).
      render();
    });

    socket.on('disconnect', function (reason) {
      state.online = false;
      state.disconnectReason = reason || null;
      render();
    });

    socket.on('connect_error', function (err) {
      state.online = false;
      toast('err', '연결 실패: ' + (err && err.message ? err.message : '알 수 없는 오류'));
    });

    socket.on('error', function (p) {
      var msg = p && p.message ? p.message : '오류가 발생했습니다.';
      state.joiningRoomId = null;
      toast('err', msg);
    });

    socket.on('room:state', function (p) {
      if (!p || !p.settings) return;
      if (state.ignoreRoomId && p.settings.roomId === state.ignoreRoomId) return; // 내가 나간 방의 잔여 방송
      state.ignoreRoomId = null;
      state.joiningRoomId = null;

      if (p.state === 'abandoned') {
        state.room = null;
        toast('warn', '모든 참가자가 연결을 잃어 대전이 취소되었습니다. 전적은 기록되지 않습니다.');
        backToLobby();
        return;
      }

      var prev = state.room ? state.room.state : null;
      state.room = p;
      // 서버 room:state 는 countdownEndsAt 을 싣지 않는다. countdown 진입을 처음 본 시점에서
      // COUNTDOWN_MS(3초) 를 더해 근사한다 — 표시 전용이며 실제 시작은 서버 timeout 이 결정한다.
      if (p.state === 'countdown' && prev !== 'countdown') state.countdownEndsAt = Date.now() + COUNTDOWN_MS;
      if (p.state !== 'countdown') state.countdownEndsAt = null;
      if (p.state === 'waiting') {
        state.questions = []; state.result = null; setTimer(null);
        state.marks = []; state.floatVisible = false; // 요구 1·2 — 새 대기실로 돌아오면 이전 대전 흔적을 지운다
      }
      var me = myPlayer();
      if (me && me.submitted) state.submitted = true;
      render();
    });

    socket.on('battle:questions', function (p) {
      state.questions = (p && p.questions) || [];
      state.myAnswers = {};
      state.progress = {};
      state.submitted = false;
      state.submitPending = false;
      state.result = null;
      state.countdownEndsAt = null;
      state.marks = []; // 새 대전 시작 — 이전 판 채점 현황을 지운다(요구 2)
      state.floatVisible = false; // 새 화면이니 스크롤 전 상태로(요구 1)
      setTimer(p && p.deadlineInfo ? p.deadlineInfo.remainingMs : null);
      render();
    });

    socket.on('battle:progress', function (p) {
      if (!p || p.userId == null) return;
      state.progress[p.userId] = p.answeredCount || 0;
      if (p.submitted && p.userId === myId()) state.submitted = true;
      render();
    });

    // 제출 완료자에게만 개별 발송되는 상호 정오 현황(요구 2, PROTOCOL 계약).
    // 답 내용·display 는 절대 담기지 않는다 — 문항별 true/false 만.
    socket.on('battle:marks', function (p) {
      state.marks = (p && p.players) || [];
      render();
    });

    socket.on('battle:tick', function (p) {
      setTimer(p ? p.remainingMs : null);
      render();
    });

    socket.on('battle:resync', function (p) {
      // 스냅샷 1회 — 이벤트 재생 없이 state 를 통째로 갈아끼운다.
      if (!p) return;
      state.ignoreRoomId = null;
      state.joiningRoomId = null;
      state.room = { state: p.state, players: p.players || [], settings: p.settings || {} };
      state.questions = p.questions || [];
      state.myAnswers = p.myAnswers || {};
      state.progress = {};
      state.submitted = !!p.submitted;
      state.submitPending = false;
      // 계약: 제출 상태 + playing 일 때만 최상위 marks 를 싣는다. 그 외엔 없거나 null.
      state.marks = p.marks || [];
      if (p.state !== 'finished') state.result = null;
      state.countdownEndsAt = p.state === 'countdown' ? Date.now() + COUNTDOWN_MS : null;
      var rm = p.remainingMs;
      if (rm == null && p.deadlineInfo) rm = p.deadlineInfo.remainingMs;
      setTimer(rm);
      // 대기 중이던 디바운스 전송은 스냅샷과 어긋날 수 있으므로 버린다.
      var keys = Object.keys(state.pending);
      for (var i = 0; i < keys.length; i++) { clearTimeout(state.pending[keys[i]].t); delete state.pending[keys[i]]; }
      render();
    });

    socket.on('room:invite', function (p) {
      if (!p || !p.roomId) return;
      // 지금 대전 중(playing/countdown)이면 조작을 방해하지 않게 조용히 버린다 — 도달 실패는 알림 없음.
      if (state.room && (state.room.state === 'playing' || state.room.state === 'countdown')) return;
      state.invite = p;
      render();
    });

    socket.on('battle:finished', function (p) {
      if (!p) return;
      state.result = {
        results: p.results || [],
        winnerUserId: p.winnerUserId == null ? null : p.winnerUserId,
        details: p.details || [],
        reason: p.reason || '',
        explanations: p.explanations && typeof p.explanations === 'object' ? p.explanations : {},
      };
      state.showExplain = {};
      state.submitPending = false;
      state.marks = []; // 결과 화면이 대체한다 — 채점 현황 카드·플로팅 요약은 더 이상 안 보인다(요구 2)
      state.floatVisible = false;
      setTimer(null);
      if (state.room) state.room = Object.assign({}, state.room, { state: 'finished' });
      render();
      if (window.scrollTo) window.scrollTo(0, 0);
    });
  }

  // ================================================================== 부팅

  function buildNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    nav.replaceChildren(frag(h('div', { class: 'wrap' }, [
      h('a', { class: 'brand', href: '/', text: '정처기 배틀' }),
      h('a', { href: '/', text: '학습' }),
      h('a', { href: '/battle.html', text: '대전' }),
      h('a', { href: '/ranking.html', text: '랭킹' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'whoami' }, [state.me ? state.me.nickname : '']),
      h('button', {
        text: '로그아웃',
        onclick: function () {
          window.api.post('/api/auth/logout', {})
            .then(function () { window.location.href = '/'; })
            .catch(function () { window.location.href = '/'; });
        },
      }),
    ])));
  }

  function boot() {
    if (!window.api || !window.io) {
      var root = document.getElementById('view');
      if (root) {
        root.replaceChildren(h('div', { class: 'banner err', text: '필수 스크립트를 불러오지 못했습니다. 새로고침해 주세요.' }));
      }
      return;
    }

    window.api.me().then(function (res) {
      // window.api.me() 는 user 객체를 직접(또는 비로그인이면 null 을) 반환한다 — {user} 로 감싸지 않는다.
      var user = res || null;
      if (!user) {
        window.location.replace('/?msg=' + encodeURIComponent('대전은 로그인이 필요합니다.'));
        return;
      }
      state.me = user;
      buildNav();
      render();
      loadRounds();
      loadRooms();
      connectSocket();
    }).catch(function () {
      window.location.replace('/?msg=' + encodeURIComponent('로그인 상태를 확인하지 못했습니다.'));
    });

    // 탭을 닫거나 숨길 때 디바운스 대기 중인 답안을 흘려보낸다(DOM 은 건드리지 않는다).
    window.addEventListener('pagehide', flushAllAnswers);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushAllAnswers();
    });

    // 플로팅 현황 패널(요구 1) — 부팅 시 한 번만 등록. 대전 화면이 아닐 때는 onFloatScroll 내부에서 무시한다.
    window.addEventListener('scroll', onFloatScroll, { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
