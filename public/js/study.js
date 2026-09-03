/**
 * study.js — 학습 모드.
 *
 * 세 가지 출처(source)를 같은 화면으로 그린다. 쿼리스트링이 출처를 고른다.
 *   ?round=2026-2                       → GET  /api/rounds/:id        → POST /api/rounds/:id/grade
 *   ?set=practice&rounds=all&count=20   → GET  /api/practice?…        → POST /api/practice/grade
 *   ?set=wrong                          → GET  /api/me/wrong (로그인) → POST /api/practice/grade
 * 오답노트는 허브(wrong.html)에서 넘어오는 두 가지 부분 보기를 더 받는다 — 쿼리를 그대로 API 로 넘긴다.
 *   ?set=wrong&round=2024-1             → GET  /api/me/wrong?round=…  (그 회차의 *지금* 오답)
 *   ?set=wrong&match=12                 → GET  /api/me/wrong?match=…  (그 대전에서 틀렸던 문항 = 과거 스냅샷,
 *                                         지금은 맞힌 문항도 들어 있고 그 id 는 resolvedIds 로 온다)
 * 어느 출처든 state.round = {round:<setKey>, title, questions[]} 하나로 정규화한다.
 *
 * 렌더는 항상 `state` 로부터 전체를 다시 그린다 (부분 DOM 패치 없음).
 * 입력값은 `state.answers` 에 즉시 반영되므로 재렌더해도 사용자가 친 값이 살아남는다.
 *
 * 정답은 채점 응답에만 들어 있다 (`details[].display`). 문항 로드 응답에는 없다.
 *
 * 자동 저장: localStorage['jpk-study:<setKey>'] = {answers, savedAt}.
 * 오답노트의 부분 보기는 키에 한정자를 덧붙인다('jpk-study:wrong:round:2024-1') — 전체 오답 풀이의
 * 저장분과 섞이면 없는 문항의 답이 되살아난다.
 * 랜덤 모의고사는 문항 묶음이 매번 새로 뽑히므로 `questionIds` 까지 함께 적어 두고, 다음 로드에서
 * **다시 뽑힌 세트와 겹치는 문항의 답만** 되살린다 (서버에 "같은 세트를 다시 달라" 는 수단이 없다).
 *
 * 의존 (전역): window.api, window.copyText, window.Boki, window.CodeFmt,
 *              JPK.dom, JPK.qmeta, JPK.store, JPK.focus, JPK.qbody, JPK.motion, JPK.nav
 */
(function () {
  'use strict';

  var el = JPK.dom.el;
  var pad2 = JPK.dom.pad2;
  var htmlToText = JPK.dom.htmlToText;
  var fireInput = JPK.dom.fireInput;

  // 문항 유형·언어 표는 공용 모듈(js/shared/qmeta.js)이 소유한다 — 화면마다 다른 말이 나오지 않게.
  var TYPE_ORDER = JPK.qmeta.TYPE_ORDER;
  var TYPE_LABEL = JPK.qmeta.TYPE_LABEL;
  var LANGS = JPK.qmeta.LANGS;
  var LANG_LABEL = JPK.qmeta.LANG_LABEL;
  var normalizeType = JPK.qmeta.normalizeType;
  var normalizeLang = JPK.qmeta.normalizeLang;
  var questionOrigin = JPK.qmeta.questionOrigin;

  var PASS_SCORE = 60;
  var STORE_PREFIX = 'jpk-study:';
  var TIMER_PREF_KEY = 'jpk-study:timer';
  var TIMER_OPEN_KEY = 'jpk-study:timerOpen';
  // 필터 칩은 페이지를 통째로 옮긴다. 그 이동은 "이탈" 이 아니므로 이탈 경고를 띄우지 않는다.
  // sessionStorage 에도 남겨 두는 이유는 bfcache 복원처럼 메모리 표식이 사라진 뒤에도
  // beforeunload 가 한 번 더 도는 경우를 막기 위해서다. 다음 로드에서 즉시 지운다.
  var INTERNAL_NAV_KEY = 'jpk-study:internalNav';
  var SAVE_DEBOUNCE_MS = 300;
  var REPORT_DONE = '접수되었습니다. 고맙습니다!';

  // 오답노트 즉시 해설 — 한 번에 물어볼 수 있는 문항 수 상한 (서버 계약: ids 는 1~50개).
  var PEEK_CHUNK = 50;
  // 서버가 조용히 생략한 문항 = 그 사용자의 채점 기록에 없다 (403 이 아니라 응답에서 빠진다).
  var PEEK_DENIED = '이 문항의 해설을 볼 권한이 없습니다.';
  var WRONG_AUTH_MESSAGE = '로그인이 필요합니다. 오답노트는 로그인한 사용자의 채점 기록으로 만들어집니다.';
  // 대전 오답 보기의 부제에 쓰는 승패 표기 (battle.js 결과 화면과 같은 말).
  var RESULT_LABEL = { win: '승', lose: '패', draw: '무' };

  var state = {
    mode: 'round',    // 'round' | 'practice' | 'wrong'
    setKey: '',       // 저장 키이자 채점 응답의 round 값
    roundId: '',      // mode==='round' 일 때만 의미 있다
    wrongRound: '',   // mode==='wrong' + ?round= — 그 회차의 오답만
    wrongMatch: '',   // mode==='wrong' + ?match= — 그 대전에서 틀렸던 문항 (match 가 round 보다 우선)
    battle: null,     // match 보기에서 서버가 주는 {roomName,finishedAt,opponents,me,questionCount,result}
    resolvedIds: {},  // qid -> true (그 대전에서는 틀렸지만 지금은 오답이 아닌 문항)
    typeFilter: '',   // '' | 'code' | 'sql' | 'theory' — 쿼리스트링 ?type= 에서 온다
    langFilter: '',   // '' | 'c' | 'java' | 'python' — 쿼리스트링 ?lang= (코드 유형에서만 의미가 있다)
    roundCounts: null, // {code,sql,theory} — 회차 모드에서만. 0문항 유형 칩을 비활성화하는 데 쓴다
    roundLangs: null, // {c,java,python} — 회차 모드에서만. 0문항 언어 칩을 비활성화하는 데 쓴다
    practiceRounds: 'all', // mode==='practice' 일 때 필터 링크를 다시 만들기 위해 보관
    practiceCount: '20',
    round: null,      // {round,title,sourceUrl,questions[]}
    answers: {},      // qid -> [string]
    result: null,     // {correctCount,totalCount,score,details[],bodyTexts{},explanations{}}
    submitting: false,
    showExplain: {},  // qid -> true (해설 펼침 — 채점 후에만 의미 있다)
    // 오답노트 즉시 해설(채점 **전**) — GET /api/me/wrong/explain 으로 받아 캐시한다.
    // 여기 들어 있는 문항은 사용자가 이미 채점받은 문항뿐이다 (서버가 이력으로 권한을 검사한다).
    peek: {},         // qid -> {display, html} — 서버가 실제로 내려준 문항만 들어간다
    peekDenied: {},   // qid -> true (서버가 조용히 생략 = 채점 기록 없음). 빈 해설로 캐시하지 않는다
    peekOpen: {},     // qid -> true (그 카드의 정답·해설 펼침)
    peekLoading: {},  // qid -> true (그 카드만 불러오는 중)
    peekAllLoading: false, // "해설 모두 펼치기" 가 도는 중
    // 이의 제기 인라인 상자 (battle.js 와 같은 모양)
    reportOpen: {},   // qid -> true
    reportText: {},   // qid -> string
    reportStatus: {}, // qid -> string
    reportFocus: '',  // 재렌더 직후 포커스를 줄 qid
    // 타이머
    timerMinutes: 0,
    timerEndsAt: 0,   // epoch ms, 0 이면 정지
    timerHandle: null,
    // 타이머 컨트롤 접기 — 사람이 편 상태만 저장한다(도는 동안에는 저장값과 무관하게 항상 펼친다).
    timerOpen: false,

    // 로그인 상태 — 채점은 로그인이 필요하다(보안 C-1). 안내를 미리 띄우는 데 쓴다.
    me: null,              // {id, nickname} | null
    meLoaded: false,       // api.me() 가 한 번이라도 답했는가 (모르는 동안은 안내하지 않는다)
    gradeBlocked: '',      // '' | 'auth' — 채점이 401 로 막힌 뒤인가

    // ---- 렌더 대상이 아닌 보조 상태 (예전에는 파일 곳곳의 모듈 전역이었다) ----
    saveTimer: null,       // 자동 저장 디바운스 핸들
    hasSource: false,      // 쿼리스트링에서 무엇을 풀지 정해졌는가 (필터 줄을 그릴 조건)
    pageFailed: false,     // fail() 로 떨어진 화면인가 — 그 뒤로는 render() 도 멈춘다
    internalNav: false,    // 필터 칩이 스스로 페이지를 옮기는 중인가 (이탈 경고 억제)
    lastFocusField: {},    // qid -> fieldIndex. 보기 칩이 채울 칸(재렌더로 DOM 이 갈려도 살아남는다)
    boardCompact: false,   // 점수판이 sticky 로 붙어 축소된 상태인가
    boardTicking: false,   // 점수판 스크롤 계산이 rAF 대기 중인가
    barShown: false,       // 하단 미니바가 떠 있는가
    barTicking: false,     // 미니바 스크롤 계산이 rAF 대기 중인가
    barCountText: '',      // 미니바에 마지막으로 쓴 문구 (같으면 DOM 을 건드리지 않는다)
  };

  var elQuestions = document.getElementById('questions');
  var elTitle = document.getElementById('roundTitle');
  var elMeta = document.getElementById('roundMeta');
  var elBoard = document.getElementById('scoreBoard');
  var elBtnbar = document.getElementById('btnbar');
  var elSubmit = document.getElementById('submitBtn');
  var elReset = document.getElementById('resetBtn');
  var elAnswered = document.getElementById('answeredCount');
  var elToastWrap = document.getElementById('toastWrap');
  var elTools = document.getElementById('studyTools');
  var elTimerToggle = document.getElementById('timerToggle');
  var elTimerPanel = document.getElementById('timerPanel');
  var elTimerSelect = document.getElementById('timerSelect');
  var elTimerBtn = document.getElementById('timerBtn');
  var elTimerOut = document.getElementById('timerOut');
  var elRestore = document.getElementById('restoreNotice');
  var elStudyBar = document.getElementById('studyBar');
  var elBarCount = document.getElementById('studyBarCount');
  var elBarNext = document.getElementById('studyBarNext');
  var elBarSubmit = document.getElementById('studyBarSubmit');
  // 예전에는 스크립트가 필요할 때 만들어 끼워 넣던 네 그릇. 지금은 study.html 이 자리를 선언한다.
  var elLoginNotice = document.getElementById('loginNotice');
  var elBattleSub = document.getElementById('battleSub');
  var elTypeFilter = document.getElementById('typeFilter');
  var elLangFilter = document.getElementById('langFilter');
  var elPeekBar = document.getElementById('peekBar');

  // ------------------------------------------------------------- 작은 도구

  function toast(message, kind) {
    JPK.dom.toast(elToastWrap, message, kind);
  }

  /**
   * jsdom 은 스크롤을 구현하지 않는다 — 없으면 조용히 건너뛴다.
   * behavior 는 사용자의 모션 축소 설정을 따른다 (CSS 미디어 쿼리는 스크립트 스크롤을 막지 못한다).
   */
  function scrollToEl(node) {
    try {
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: JPK.motion.smoothScrollBehavior(), block: 'start' });
      }
    } catch (e) { /* 무시 */ }
  }
  function scrollTop() {
    try {
      if (typeof window.scrollTo === 'function') {
        window.scrollTo({ top: 0, behavior: JPK.motion.smoothScrollBehavior() });
      }
    } catch (e) { /* 무시 */ }
  }

  function queryParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function fieldLabel(label, index) {
    return label == null || label === '' ? '답' + (index + 1) : label;
  }

  function detailFor(questionId) {
    if (!state.result) return null;
    var list = state.result.details || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].questionId === questionId) return list[i];
    }
    return null;
  }

  /**
   * 카드에 찍을 문항 번호.
   * 한 회차를 그대로 푸는 경우(mode 'round' — 유형 필터가 걸려도 마찬가지)만 **원본 번호**를 쓴다.
   * 그 밖(랜덤 모의고사·오답노트)은 여러 회차가 섞여 원본 번호가 뒤죽박죽이므로 **1부터 순번**을 매긴다
   * — 원본 번호는 우상단 회차 뱃지("2025년 3회 · 16번")에 이미 있으니 중복해서 적지 않는다.
   */
  function displayNum(question, index) {
    if (state.mode === 'round') return question.num == null ? '' : String(question.num);
    return String(index + 1);
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------------------------------------------------------------- 내비

  /**
   * 정적 내비다 — 공용 모듈은 닉네임·로그아웃·로그인 세 조각만 갈아끼운다.
   * 학습 모드는 비로그인으로도 쓸 수 있으므로 로그아웃해도 페이지를 떠나지 않는다.
   */
  function renderNav(user) {
    JPK.nav.render(user, {
      current: 'study',
      onLogout: function () { toast('로그아웃했습니다.'); },
      onError: function (e) { toast(e && e.message ? e.message : '로그아웃에 실패했습니다.', 'bad'); },
    });
  }

  // --------------------------------------------------------- 채점과 로그인

  /**
   * 채점은 로그인이 필요하다 — 비로그인 채점을 열어 두면 아무나 답을 하나씩 바꿔 보내며
   * 정답을 캐낼 수 있다(정답 오라클). 서버가 두 채점 경로 모두 401 로 막는다.
   *
   * 지금 화면으로 되돌아올 주소를 `next=` 에 실어 메인의 계정 섹션으로 보낸다.
   * `msg=` 는 메인이 이미 읽어 배너로 띄우는 기존 장치다.
   */
  function loginUrl() {
    var back = window.location.pathname + window.location.search;
    return '/?msg=' + encodeURIComponent('채점하려면 로그인이 필요합니다.')
      + '&next=' + encodeURIComponent(back) + '#account';
  }

  /** 안내 안의 "로그인하러 가기". 이동 전에 답안을 확정 저장하고 이탈 경고를 끈다. */
  function loginLink(text) {
    var a = document.createElement('a');
    a.href = loginUrl();
    a.textContent = text;
    a.addEventListener('click', function () {
      saveNow();
      state.internalNav = true;
      JPK.store.sessionSet(INTERNAL_NAV_KEY, '1');
    });
    return a;
  }

  /**
   * 제출 버튼 위 한 줄. 두 가지 상태를 그린다.
   *   미리 안내 — 비로그인으로 풀고 있다 (아직 눌러 보지 않았다)
   *   막힘 안내 — 눌렀더니 401 이었다
   * 어느 쪽이든 "적어 둔 답은 남는다" 를 함께 말한다. 자동 저장이 실제로 그렇게 동작한다.
   */
  function renderLoginNotice() {
    if (!elLoginNotice) return;
    var questions = (state.round && state.round.questions) || [];
    var show = !state.pageFailed && questions.length > 0 && !state.result
      && state.meLoaded && !state.me;
    if (!show) {
      elLoginNotice.textContent = '';
      elLoginNotice.hidden = true;
      return;
    }
    elLoginNotice.textContent = '';
    elLoginNotice.appendChild(document.createTextNode(
      state.gradeBlocked === 'auth'
        ? '채점하려면 로그인이 필요합니다. 지금까지 적은 답안은 저장해 두었으니 로그인한 뒤 이어서 채점할 수 있습니다. '
        : '채점하려면 로그인이 필요합니다. 지금 적는 답안은 자동 저장되므로 나중에 로그인해도 그대로 이어집니다. '
    ));
    elLoginNotice.appendChild(loginLink('로그인하러 가기'));
    elLoginNotice.hidden = false;
  }

  // ------------------------------------------------------------- 자동 저장

  /**
   * 오답노트 부분 보기의 저장 키 한정자. 'round:2024-1' / 'match:12' / '' (전체).
   * 세 가지가 같은 setKey('wrong')를 쓰므로 이것이 없으면 저장분이 서로 섞인다.
   */
  function wrongScope() {
    if (state.mode !== 'wrong') return '';
    if (state.wrongMatch) return 'match:' + state.wrongMatch;
    if (state.wrongRound) return 'round:' + state.wrongRound;
    return '';
  }

  /**
   * 저장 키. 유형·언어 필터가 걸리면 문항 묶음 자체가 달라지므로 키도 분리한다
   * (전체 풀이의 저장분과 섞이지 않게).
   *
   * 랜덤 모의고사도 저장한다. 예전에는 "문항이 매번 달라 복원이 무의미하다" 며 저장하지 않았는데,
   * 그러면서 이탈 경고만 띄워 사람에게 "지키겠다" 고 해 놓고 60문항을 통째로 버렸다.
   * 지금은 저장하고, 다시 뽑힌 세트와 겹치는 문항만 되살린 뒤 몇 개를 되살렸는지 밝힌다.
   */
  function saveKey() {
    if (!state.setKey) return null;
    var scope = wrongScope();
    return STORE_PREFIX + state.setKey
      + (scope ? ':' + scope : '')
      + (state.typeFilter ? ':' + state.typeFilter : '')
      + (state.langFilter ? ':' + state.langFilter : '');
  }

  function hasAnswers() {
    var qids = Object.keys(state.answers);
    for (var i = 0; i < qids.length; i++) {
      var vals = state.answers[qids[i]] || [];
      for (var j = 0; j < vals.length; j++) {
        if (vals[j] != null && String(vals[j]).trim() !== '') return true;
      }
    }
    return false;
  }

  /** 지금 화면에 깔린 문항 id — 저장분에 함께 적어 두고, 복원 때 겹치는지 본다. */
  function currentQuestionIds() {
    return ((state.round && state.round.questions) || []).map(function (q) { return q.id; });
  }

  function saveNow() {
    var key = saveKey();
    if (!key || state.result) return;
    if (!hasAnswers()) {
      JPK.store.remove(key);
      return;
    }
    JPK.store.set(key, JSON.stringify({
      // 회차·오답노트는 문항 묶음이 키로 이미 정해지지만, 모의고사는 그렇지 않다.
      // 어느 문항에 대한 답이었는지 남겨 두어야 다음 로드에서 겹치는 문항을 셀 수 있다.
      questionIds: currentQuestionIds(),
      answers: state.answers,
      savedAt: Date.now(),
    }));
  }

  function scheduleSave() {
    if (!saveKey() || state.result) return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function clearSaved() {
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    var key = saveKey();
    if (key) JPK.store.remove(key);
  }

  /**
   * 문항을 받은 직후 한 번 호출한다. 지금 세트에 실제로 있는 문항만 복원한다
   * (회차 데이터가 바뀌어 사라진 문항, 모의고사에서 이번에 안 뽑힌 문항의 답은 그냥 무시된다).
   */
  function restoreSaved() {
    var key = saveKey();
    if (!key || !state.round) return;
    var raw = JPK.store.get(key);
    if (!raw) return;
    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      JPK.store.remove(key);
      return;
    }
    if (!saved || !saved.answers || typeof saved.answers !== 'object') return;

    // 저장할 때 답이 들어 있던 문항 수 — "몇 개 중 몇 개를 되살렸는지" 를 말하기 위한 분모다.
    var savedWithAnswers = Object.keys(saved.answers).filter(function (qid) {
      var vals = saved.answers[qid];
      return Array.isArray(vals) && vals.some(function (v) {
        return v != null && String(v).trim() !== '';
      });
    }).length;

    var restored = 0;
    (state.round.questions || []).forEach(function (q) {
      var vals = saved.answers[q.id];
      if (!Array.isArray(vals)) return;
      var any = false;
      var row = (q.fields || []).map(function (_f, i) {
        var v = vals[i] == null ? '' : String(vals[i]);
        if (v.trim() !== '') any = true;
        return v;
      });
      if (!any) return;
      state.answers[q.id] = row;
      restored++;
    });

    if (restored === 0) {
      JPK.store.remove(key);
      // 모의고사는 이번에 겹치는 문항이 하나도 없을 수 있다 — 조용히 사라지면 사람은
      // "저장했다더니 다 날아갔다" 고만 안다. 이유를 밝힌다.
      if (state.mode === 'practice' && savedWithAnswers > 0) {
        showRestoreNotice(saved.savedAt, 0, savedWithAnswers);
      }
      return;
    }
    showRestoreNotice(saved.savedAt, restored, savedWithAnswers);
  }

  /**
   * @param {number} [restored] 되살린 문항 수 (모의고사에서 일부만 겹칠 때 밝힌다)
   * @param {number} [savedTotal] 저장분에 답이 들어 있던 문항 수
   */
  function showRestoreNotice(savedAt, restored, savedTotal) {
    if (!elRestore) return;
    elRestore.textContent = '';
    var when = typeof savedAt === 'number' && savedAt > 0 ? formatTime(savedAt) : '시각 미상';
    var text = '이전에 입력하던 답안을 불러왔습니다 (' + when + ').';
    // 모의고사는 문항이 매번 새로 뽑힌다 — 전부 되살아나지 않았으면 그 사실을 감추지 않는다.
    if (state.mode === 'practice' && savedTotal > 0 && restored < savedTotal) {
      text = restored === 0
        ? '이전에 답을 적어 둔 ' + savedTotal + '문항이 이번 출제에 하나도 포함되지 않아 복원하지 못했습니다 ('
          + when + '). 모의고사는 풀 때마다 문항이 새로 뽑힙니다.'
        : '이전에 적어 둔 ' + savedTotal + '문항 중 이번 출제와 겹치는 ' + restored
          + '문항의 답만 불러왔습니다 (' + when + ').';
    }
    elRestore.appendChild(document.createTextNode(text));
    var drop = el('button', 'linkish', '불러온 답안 지우기');
    drop.type = 'button';
    drop.addEventListener('click', function () {
      state.answers = {};
      clearSaved();
      hideRestoreNotice();
      render();
    });
    elRestore.appendChild(drop);
    elRestore.hidden = false;
  }

  function hideRestoreNotice() {
    if (!elRestore) return;
    elRestore.textContent = '';
    elRestore.hidden = true;
  }

  /**
   * 필터 칩처럼 **이 화면이 스스로** 옮겨 가는 이동. 답안은 지금 키로 확정 저장하고,
   * 브라우저의 "이 페이지를 나가시겠습니까" 를 띄우지 않는다 — 사람이 나가려던 게 아니다.
   */
  function goInternal(url) {
    saveNow();                 // 디바운스를 기다리지 않고 확정 저장
    state.internalNav = true;
    JPK.store.sessionSet(INTERNAL_NAV_KEY, '1');
    window.location.href = url;
  }

  // 새로고침·이탈 경고 — 채점 전이고 뭔가 적어 둔 게 있을 때만.
  window.addEventListener('beforeunload', function (ev) {
    if (state.result || state.submitting) return undefined;
    // 화면이 스스로 옮겨 가는 중이면 경고하지 않는다. 메모리 표식이 사라진 뒤에도
    // (bfcache 복원 등) 세션 표식이 한 번 더 막아 준다 — 다음 로드에서 지운다.
    if (state.internalNav || JPK.store.sessionGet(INTERNAL_NAV_KEY) === '1') return undefined;
    if (!hasAnswers()) return undefined;
    saveNow(); // 디바운스를 기다리지 않고 확정 저장
    ev.preventDefault();
    ev.returnValue = '';
    return '';
  });

  // --------------------------------------------------------------- 타이머

  function remainingSeconds() {
    if (!state.timerEndsAt) return 0;
    return Math.max(0, Math.ceil((state.timerEndsAt - Date.now()) / 1000));
  }

  // 타이머 컨트롤 접기 — 헤더가 시험지보다 커 보이지 않게 기본은 접힘.
  // 사람이 편 상태만 저장한다. 타이머가 도는 동안에는 저장값과 무관하게 항상 펼친다(남은 시간을 봐야 한다).
  state.timerOpen = JPK.store.get(TIMER_OPEN_KEY) === '1';

  function syncTimerFold() {
    if (!elTimerPanel || !elTimerToggle) return;
    var open = state.timerOpen || !!state.timerEndsAt;
    elTimerPanel.hidden = !open;
    elTimerToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) elTimerToggle.classList.add('on');
    else elTimerToggle.classList.remove('on');
  }

  if (elTimerToggle) {
    elTimerToggle.addEventListener('click', function () {
      // 도는 중에 접으면 남은 시간이 사라진다 — 접기 대신 아무것도 하지 않는다.
      if (state.timerEndsAt && state.timerOpen) return;
      state.timerOpen = !state.timerOpen;
      JPK.store.set(TIMER_OPEN_KEY, state.timerOpen ? '1' : '0');
      syncTimerFold();
    });
  }

  function renderTimer() {
    syncTimerFold();
    if (!elTimerOut || !elTimerBtn || !elTimerSelect) return;
    var running = !!state.timerEndsAt;
    elTimerBtn.textContent = running ? '중지' : '시작';
    elTimerBtn.disabled = !running && Number(elTimerSelect.value) === 0;
    if (elTimerSelect) elTimerSelect.disabled = running;
    if (!running) {
      elTimerOut.textContent = '';
      elTimerOut.hidden = true;
      elTimerOut.classList.remove('urgent');
      return;
    }
    var s = remainingSeconds();
    elTimerOut.textContent = pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
    elTimerOut.hidden = false;
    if (s <= 60) elTimerOut.classList.add('urgent');
    else elTimerOut.classList.remove('urgent');
  }

  function stopTimer() {
    if (state.timerHandle) {
      clearInterval(state.timerHandle);
      state.timerHandle = null;
    }
    state.timerEndsAt = 0;
    renderTimer();
  }

  function tick() {
    if (!state.timerEndsAt) return;
    if (remainingSeconds() > 0) {
      renderTimer();
      return;
    }
    stopTimer();
    if (state.result || state.submitting) return;
    toast('시간이 끝나 자동 제출합니다.', 'bad');
    submit(true);   // 시간이 다 된 자동 제출 — 미입력 확인으로 붙잡지 않는다
  }

  function startTimer(minutes) {
    stopTimer();
    if (!minutes) return;
    state.timerMinutes = minutes;
    state.timerEndsAt = Date.now() + minutes * 60000;
    state.timerHandle = setInterval(tick, 250);
    renderTimer();
  }

  if (elTimerSelect) {
    // 마지막으로 고른 시간을 기억한다 (자동 시작은 하지 않는다 — 시작은 항상 사용자가 누른다).
    var savedMinutes = JPK.store.get(TIMER_PREF_KEY);
    if (savedMinutes && /^(0|30|60|90)$/.test(savedMinutes)) elTimerSelect.value = savedMinutes;
    elTimerSelect.addEventListener('change', function () {
      JPK.store.set(TIMER_PREF_KEY, String(Number(elTimerSelect.value) || 0));
      renderTimer();
    });
  }
  if (elTimerBtn) {
    elTimerBtn.addEventListener('click', function () {
      if (state.timerEndsAt) {
        stopTimer();
        toast('타이머를 껐습니다.');
        return;
      }
      var minutes = Number(elTimerSelect.value) || 0;
      if (!minutes) return;
      startTimer(minutes);
      toast(minutes + '분 타이머를 시작합니다.', 'ok');
    });
  }

  // ------------------------------------------------------- AI 질문 프롬프트

  /**
   * 복사 프롬프트를 조립한다. 레이아웃은 PROTOCOL.md "클립보드 방침" 에 고정돼 있다.
   *   [문제] / [내 답] / [정답] / "풀이 과정을 설명해줘"
   *
   * 지문 원문은 채점 응답의 최상위 `bodyTexts[qid]` 에서 온다
   * (details[] 안이 아니다 — 서버 응답 형태에 맞춘다).
   */
  function buildPrompt(question, detail) {
    var bodyTexts = (state.result && state.result.bodyTexts) || {};
    var bodyText = bodyTexts[question.id];
    if (!bodyText) {
      // bodyText 가 없는 문항 — 화면에 보이는 내용으로 대신한다
      bodyText = (htmlToText(question.prompt) + '\n\n' + htmlToText(question.bodyHtml)).trim();
    }

    var lines = ['[문제]', bodyText, '', '[내 답]'];
    var results = (detail && detail.fieldResults) || [];
    if (results.length === 0) {
      lines.push('(무응답)');
    } else {
      results.forEach(function (fr, i) {
        var given = fr.given == null ? '' : String(fr.given).trim();
        lines.push(fieldLabel(fr.label, i) + ': ' + (given === '' ? '(무응답)' : given));
      });
    }
    lines.push('');
    lines.push('[정답]');
    lines.push(detail && detail.display ? detail.display : '(정답 표기가 등록되어 있지 않습니다)');
    lines.push('');
    lines.push('풀이 과정을 설명해줘');
    return lines.join('\n');
  }

  function onAskAi(question, detail) {
    var text = buildPrompt(question, detail);
    copyText(text, { title: 'AI에게 붙여넣을 질문' }).then(function (how) {
      // 3단계(모달) 는 모달 자체가 안내다 — 토스트를 겹쳐 띄우지 않는다
      if (how === 'manual') return;
      toast('AI 질문 프롬프트를 복사했습니다. AI 채팅창에 붙여넣으세요.', 'ok');
    });
  }

  // ------------------------------------------------------- 이의 제기(인라인)

  /** battle.js 와 같은 동작: 토글 버튼 → textarea + 보내기, 접수 후에는 잠근다. */
  function sendReport(question, detail) {
    var qid = question.id;
    var comment = (state.reportText[qid] || '').trim();
    if (!comment) {
      // 서버도 같은 이유로 400 을 낸다 — 왕복 없이 같은 문구로 막는다
      state.reportStatus[qid] = '어떤 점이 이상한지 적어 주세요.';
      render();
      return;
    }
    var myAnswer = ((detail && detail.fieldResults) || []).map(function (fr) {
      return fr.given == null ? '' : String(fr.given);
    });
    state.reportStatus[qid] = '보내는 중…';
    render();

    api.post('/api/reports', { questionId: qid, myAnswer: myAnswer, comment: comment })
      .then(function () {
        state.reportStatus[qid] = REPORT_DONE;
        state.reportText[qid] = '';
        state.reportOpen[qid] = false;
        render();
        toast('이의 제기를 접수했습니다. 관리자가 확인합니다.', 'ok');
      })
      .catch(function (e) {
        state.reportStatus[qid] = e && e.message ? e.message : '전송에 실패했습니다.';
        render();
      });
  }

  /**
   * 문항 해설 HTML. 채점 응답의 최상위 `explanations[qid]` 에서 온다 —
   * 채점 전에는 서버가 보내지 않으므로 항상 빈 문자열이다.
   */
  function explanationOf(qid) {
    var map = (state.result && state.result.explanations) || {};
    var html = map[qid];
    return typeof html === 'string' ? html : '';
  }

  /**
   * "해설 보기" 토글 + 펼쳐진 해설 상자.
   * 정답·오답 카드 모두에 달린다. 해설이 없는 문항에는 버튼조차 만들지 않는다.
   */
  function renderExplain(question, actions, card) {
    var qid = question.id;
    var html = explanationOf(qid);
    if (!html) return;

    var open = !!state.showExplain[qid];
    var toggle = el('button', 'ghost', open ? '해설 닫기' : '해설 보기');
    toggle.type = 'button';
    toggle.setAttribute('data-explain', qid);
    toggle.addEventListener('click', function () {
      state.showExplain[qid] = !state.showExplain[qid];
      render();
    });
    actions.appendChild(toggle);

    if (!open) return;
    var box = el('div', 'explain-box');
    // 서버가 검증(validate:explain)해서 내려주는 신뢰 마크업이다 — 화이트리스트 태그만 들어 있다.
    box.innerHTML = html;
    // 해설 안의 <pre class="code"> 도 같은 규칙으로 정돈한다 — 언어는 그 문항의 것을 쓴다.
    JPK.qbody.decorate(box, question.lang);
    card.appendChild(box);
  }

  // -------------------------------------------- 오답노트 즉시 해설 (채점 전)

  /**
   * 지금 화면에서 "채점 전 정답·해설 보기" 를 쓸 수 있는가.
   * 오답노트(전체·회차·대전 하위 보기 모두)에서 **채점 전**에만 쓴다 —
   * 채점 후에는 채점 응답의 explanations 를 쓰는 기존 흐름(renderExplain)이 이긴다.
   */
  function peekEligible() {
    return !state.pageFailed && state.mode === 'wrong' && !state.result;
  }

  /**
   * 세션이 끊긴 뒤(401) 도착하는 곳. 최초 로드 실패와 **같은 화면**(로그인 안내)으로 떨어진다 —
   * 토스트만 띄우면 사용자는 왜 해설이 안 열리는지 알 수 없다.
   */
  function failWrongAuth() {
    state.peekOpen = {};
    state.peekLoading = {};
    state.peekAllLoading = false;
    fail(WRONG_AUTH_MESSAGE);
  }

  /** 지금 화면에 있는 문항 id 들 — "해설 모두 펼치기" 의 대상. */
  function visibleQuestionIds() {
    return ((state.round && state.round.questions) || []).map(function (q) { return q.id; });
  }

  /**
   * 서버는 ids 를 한 번에 1~50개만 받는다. 요청 하나에 한 덩어리씩, 차례로 보낸다.
   * 응답에서 빠진 문항(= 그 사용자의 채점 기록에 없는 문항)도 빈 값으로 캐시해 둔다 —
   * 그래야 누를 때마다 같은 요청을 되풀이하지 않는다.
   */
  function fetchPeekChunk(ids, denied) {
    var q = ids.map(function (id) { return encodeURIComponent(id); }).join(',');
    return api.get('/api/me/wrong/explain?ids=' + q).then(function (data) {
      var map = (data && data.explanations) || {};
      ids.forEach(function (qid) {
        var row = map[qid];
        if (!row || typeof row !== 'object') {
          // 서버가 조용히 생략했다 = 그 사용자의 채점 기록에 없는 문항.
          // 빈 값으로 캐시하면 "해설이 아직 없습니다" 처럼 보인다 — 권한 없음으로만 기억하고
          // (같은 요청을 되풀이하지 않도록) 부른 쪽에 알린다.
          state.peekDenied[qid] = true;
          denied.push(qid);
          return;
        }
        state.peek[qid] = {
          display: typeof row.display === 'string' ? row.display : '',
          html: typeof row.html === 'string' ? row.html : '',
        };
      });
    });
  }

  /** @returns {Promise<string[]>} 서버가 내려주지 않은(=권한 없는) 문항 id 들 */
  function loadPeek(ids) {
    var denied = [];
    var chunks = [];
    for (var i = 0; i < ids.length; i += PEEK_CHUNK) chunks.push(ids.slice(i, i + PEEK_CHUNK));
    return chunks.reduce(function (p, chunk) {
      return p.then(function () { return fetchPeekChunk(chunk, denied); });
    }, Promise.resolve()).then(function () { return denied; });
  }

  function togglePeek(qid) {
    // 일괄 펼치기가 도는 동안에는 같은 문항을 두 번 요청하지 않는다.
    if (state.peekLoading[qid] || state.peekAllLoading) return;
    if (state.peekOpen[qid]) {
      state.peekOpen[qid] = false;
      render();
      return;
    }
    if (state.peekDenied[qid]) {    // 이미 "없다" 고 답을 들은 문항 — 다시 묻지 않는다
      toast(PEEK_DENIED, 'bad');
      return;
    }
    if (state.peek[qid]) {          // 이미 받아 둔 문항 — 왕복 없이 편다
      state.peekOpen[qid] = true;
      render();
      return;
    }
    state.peekLoading[qid] = true;
    render();
    loadPeek([qid]).then(function (denied) {
      state.peekLoading[qid] = false;
      if (state.pageFailed) return;       // 그 사이 401 로 화면이 끝났다 — 늦게 온 응답은 버린다
      if (denied.length) {
        render();
        toast(PEEK_DENIED, 'bad');
        return;
      }
      state.peekOpen[qid] = true;
      render();
    }).catch(function (e) {
      state.peekLoading[qid] = false;
      if (state.pageFailed) return;       // 이미 로그인 안내 화면이다 — 그 위에 토스트를 겹치지 않는다
      // 세션이 끊겼으면 최초 로드와 같은 로그인 안내 화면으로 보낸다.
      if (e && e.status === 401) return failWrongAuth();
      render();
      toast(e && e.message ? e.message : '해설을 불러오지 못했습니다.', 'bad');
    });
  }

  /**
   * 채점 전 카드의 "정답·해설 보기" 버튼 + 펼쳐진 상자.
   * 정답 한 줄(.feedback.peek)은 채점 피드백과 구분되는 중립 톤이다 — 아직 채점한 게 아니다.
   */
  function renderPeek(question, actions, card) {
    var qid = question.id;
    var loading = !!state.peekLoading[qid];
    var open = !!state.peekOpen[qid];

    var toggle = el('button', 'ghost',
      loading ? '불러오는 중…' : (open ? '해설 닫기' : '정답·해설 보기'));
    toggle.type = 'button';
    // 일괄 펼치기가 도는 동안에는 개별 버튼도 잠가 중복 요청을 막는다.
    toggle.disabled = loading || state.peekAllLoading;
    toggle.setAttribute('data-peek', qid);
    toggle.addEventListener('click', function () { togglePeek(qid); });
    actions.appendChild(toggle);

    if (!open) return;
    var data = state.peek[qid];
    if (!data) return;

    var line = el('div', 'feedback peek');
    line.appendChild(document.createTextNode('정답: '));
    line.appendChild(el('b', null, data.display || '(정답 표기가 등록되어 있지 않습니다)'));
    card.appendChild(line);

    if (data.html) {
      var box = el('div', 'explain-box');
      // 채점 응답의 해설과 같은 신뢰 마크업이다 (서버가 validate:explain 으로 검증한다).
      box.innerHTML = data.html;
      JPK.qbody.decorate(box, question.lang);
      card.appendChild(box);
    } else {
      card.appendChild(el('p', 'muted peek-none', '해설이 아직 없습니다.'));
    }
  }

  /** 받아 둔 문항만 편다 — 권한이 없어 못 받은 문항은 빈 상자를 열지 않는다. */
  function openFetched(ids) {
    ids.forEach(function (qid) { if (state.peek[qid]) state.peekOpen[qid] = true; });
  }

  function onPeekAll(allOpen, ids) {
    if (state.peekAllLoading) return;
    if (allOpen) {
      ids.forEach(function (qid) { state.peekOpen[qid] = false; });
      render();
      return;
    }
    var missing = ids.filter(function (qid) {
      // 개별 버튼으로 이미 요청이 나간 문항은 뺀다 — 같은 id 를 두 번 묻지 않는다.
      // (그 요청이 끝나면 자기 자리에서 알아서 펼쳐진다.)
      return !state.peek[qid] && !state.peekDenied[qid] && !state.peekLoading[qid];
    });
    if (!missing.length) {
      openFetched(ids);
      render();
      // 보이는 문항이 전부 "권한 없음" 이면 화면이 아무 반응도 없는 것처럼 보인다 — 이유를 알린다.
      var knownDenied = ids.filter(function (qid) { return state.peekDenied[qid]; });
      if (knownDenied.length) {
        toast(knownDenied.length + '개 문항은 해설을 볼 권한이 없습니다.', 'bad');
      }
      return;
    }
    state.peekAllLoading = true;
    render();
    loadPeek(missing).then(function (denied) {
      state.peekAllLoading = false;
      if (state.pageFailed) return;       // 401 로 화면이 끝난 뒤 도착 — 되살리지 않는다
      openFetched(ids);
      render();
      if (denied.length) {
        toast(denied.length + '개 문항은 해설을 볼 권한이 없습니다.', 'bad');
      }
    }).catch(function (e) {
      state.peekAllLoading = false;
      if (state.pageFailed) return;
      if (e && e.status === 401) return failWrongAuth();
      render();
      toast(e && e.message ? e.message : '해설을 불러오지 못했습니다.', 'bad');
    });
  }

  function renderReport(question, detail, actions, card) {
    var qid = question.id;
    var sent = state.reportStatus[qid] === REPORT_DONE;

    var toggle = el('button', 'ghost',
      sent ? '이의 제기 접수됨' : (state.reportOpen[qid] ? '이의 제기 닫기' : '정답 이의 제기'));
    toggle.type = 'button';
    toggle.disabled = sent;
    toggle.addEventListener('click', function () {
      state.reportOpen[qid] = !state.reportOpen[qid];
      state.reportFocus = state.reportOpen[qid] ? qid : '';
      render();
    });
    actions.appendChild(toggle);

    // 상자가 닫혀 있어도(접수 완료로 자동으로 닫힌 경우 포함) 상태 문구는 보여야 한다.
    if (!state.reportOpen[qid] && state.reportStatus[qid]) {
      actions.appendChild(el('span', 'muted report-status', state.reportStatus[qid]));
    }

    if (!state.reportOpen[qid]) return;

    var box = el('div', 'report-box');
    var ta = document.createElement('textarea');
    ta.setAttribute('data-report', qid);
    // 재렌더를 가로질러 입력 중이던 글과 캐럿을 되돌린다 (대전 화면과 같은 키 규약).
    ta.setAttribute('data-fkey', 'report:' + qid);
    ta.placeholder = '어떤 점이 이상한지 적어 주세요. (예: 제 답도 인정되어야 합니다 — 근거)';
    ta.value = state.reportText[qid] || '';
    // 타이핑은 재렌더하지 않는다 (재렌더하면 포커스와 캐럿이 날아간다)
    ta.addEventListener('input', function () { state.reportText[qid] = ta.value; });
    box.appendChild(ta);

    var row = el('div', 'q-actions');
    var send = el('button', null, '보내기');
    send.type = 'button';
    send.addEventListener('click', function () { sendReport(question, detail); });
    row.appendChild(send);
    if (state.reportStatus[qid]) {
      row.appendChild(el('span', 'muted report-status', state.reportStatus[qid]));
    }
    box.appendChild(row);
    card.appendChild(box);
  }

  // ------------------------------------------------------------- 유형 필터

  /**
   * 유형 필터(전체/코드/SQL/이론). 자리는 study.html 이 `#typeFilter` 로 선언해 둔다.
   * 누르면 지금 출처(회차·오답노트·모의고사)를 그대로 유지한 채 `type=` 만 바꿔 다시 로드한다.
   * 채점 후에는 전부 비활성 — "다시 풀기" 로 state.result 가 지워지면 다시 활성이 된다.
   */

  /** "2026-08-30 · vs 상대 · 내 정답 3/10 · 승" — 없는 조각은 조용히 뺀다. */
  function battleSubText(b) {
    var bits = [];
    var d = b.finishedAt == null ? null : new Date(
      typeof b.finishedAt === 'number' || /^\d+$/.test(String(b.finishedAt))
        ? Number(b.finishedAt) : String(b.finishedAt));
    if (d && !isNaN(d.getTime())) {
      bits.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()));
    }
    var names = (b.opponents || []).map(function (o) { return o && o.nickname; })
      .filter(function (n) { return !!n; });
    if (names.length) bits.push('vs ' + names.join(', '));
    if (b.me && typeof b.me.correctCount === 'number') {
      bits.push('내 정답 ' + b.me.correctCount + '/' + (Number(b.questionCount) || '?'));
    }
    if (RESULT_LABEL[b.result]) bits.push(RESULT_LABEL[b.result]);
    return bits.join(' · ');
  }

  function renderBattleSub() {
    if (!elBattleSub) return;
    var b = state.battle;
    if (!b) {
      elBattleSub.textContent = '';
      elBattleSub.hidden = true;
      return;
    }
    elBattleSub.textContent = '대전 “' + (b.roomName || '이름 없는 방') + '” · ' + battleSubText(b);
    elBattleSub.hidden = false;
  }

  /**
   * 지금 출처를 그대로 두고 type·lang 만 바꾼 학습 URL. 오답노트의 회차·대전 한정도 그대로 이어간다.
   * `&lang=` 은 `&type=` 과 나란히 붙는다.
   */
  function studyUrl(type, lang) {
    var tail = (type ? '&type=' + encodeURIComponent(type) : '')
      + (lang ? '&lang=' + encodeURIComponent(lang) : '');
    if (state.mode === 'wrong') {
      var base = '/study.html?set=wrong';
      if (state.wrongMatch) base += '&match=' + encodeURIComponent(state.wrongMatch);
      else if (state.wrongRound) base += '&round=' + encodeURIComponent(state.wrongRound);
      return base + tail;
    }
    if (state.mode === 'practice') {
      return '/study.html?set=practice&rounds=' + encodeURIComponent(state.practiceRounds)
        + '&count=' + encodeURIComponent(state.practiceCount) + tail;
    }
    return '/study.html?round=' + encodeURIComponent(state.roundId) + tail;
  }

  /** 유형 칩 — 코드가 아닌 유형(‘전체’ 포함)으로 옮기면 언어 한정은 의미가 없으므로 버린다. */
  function studyUrlForType(type) {
    return studyUrl(type, type === 'code' ? state.langFilter : '');
  }

  /** 언어 칩 — 언어 줄은 코드 유형에서만 보이므로 type 은 항상 code 로 고정한다. */
  function studyUrlForLang(lang) {
    return studyUrl('code', lang);
  }

  /**
   * 지금 화면에 걸린 유형. `?lang=` 만 있는 주소는 코드 유형으로 본다
   * (서버 계약: lang 만 오면 type=code 로 간주). parseSource 가 이미 맞춰 두지만,
   * 판정을 한 곳에 모아 둔다.
   */
  function effectiveType() {
    return state.typeFilter || (state.langFilter ? 'code' : '');
  }

  /**
   * 이 회차에 그 유형 문항이 0개인가.
   * `state.roundCounts` 는 회차 모드에서만·서버가 counts 를 줄 때만 채워진다. 그 밖에는
   * 항상 false 를 돌려준다 — 모르는 것을 근거로 사용자의 선택지를 막지 않는다.
   * (모의고사·오답노트는 여러 회차를 합치므로 여기서 미리 판단하지 않고, 비면 서버 400 문구를 그대로 띄운다.)
   */
  function typeIsEmpty(type) {
    if (!type || !state.roundCounts) return false;
    return Number(state.roundCounts[type]) === 0;
  }

  function renderTypeFilter() {
    if (!state.hasSource) return;
    var node = elTypeFilter;
    if (!node) return;
    node.textContent = '';
    node.hidden = false;

    var graded = !!state.result;
    node.appendChild(el('span', 'type-filter-label', '유형'));

    var options = [{ value: '', label: '전체' }];
    TYPE_ORDER.forEach(function (t) { options.push({ value: t, label: TYPE_LABEL[t] }); });

    var current = effectiveType();
    options.forEach(function (opt) {
      var on = current === opt.value;
      var empty = typeIsEmpty(opt.value);
      var btn = el('button', 'chip' + (on ? ' on' : '') + (empty ? ' empty' : ''), opt.label);
      btn.type = 'button';
      btn.setAttribute('data-type', opt.value || 'all');
      // 칩은 켜고 끄는 토글이다 — 지금 어느 유형을 보고 있는지 보조 기술에도 알린다.
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      // 이 회차에 없는 유형은 눌러 봐야 서버 400 이다 — 누르기 전에 막는다.
      btn.disabled = graded || empty;
      if (empty) btn.title = '이 회차에는 ' + opt.label + ' 문항이 없습니다.';
      btn.addEventListener('click', function () {
        if (on || state.result) return;    // 지금 보고 있는 유형이면 아무것도 하지 않는다
        // 화면이 스스로 옮겨 가는 이동이다 — 답안을 확정 저장하고 이탈 경고는 띄우지 않는다.
        goInternal(studyUrlForType(opt.value));
      });
      node.appendChild(btn);
    });

    // 유형 줄 아래에 딸린 두 줄 — 언어 칩(코드일 때만)과 오답노트 해설 일괄 펼치기.
    renderLangFilter();
    renderPeekBar();
  }

  // ------------------------------------------------------------- 언어 필터

  /**
   * 이 회차에 그 언어의 코드 문항이 0개인가.
   * typeIsEmpty 와 같은 규칙 — `state.roundLangs` 는 회차 모드에서 /api/rounds 가 langs 를 줄 때만 찬다.
   */
  function langIsEmpty(lang) {
    if (!lang || !state.roundLangs) return false;
    return Number(state.roundLangs[lang]) === 0;
  }

  /**
   * 언어 필터(전체/C/Java/Python). 코드 유형을 보고 있을 때만 유형 줄 아래에 한 줄 더 붙인다.
   * 유형 칩과 같은 동작이다 — 누르면 `lang=` 만 바꿔 다시 로드하고, 채점 후에는 비활성.
   */
  function renderLangFilter() {
    if (!state.hasSource) return;
    var node = elLangFilter;
    if (!node) return;
    node.textContent = '';
    if (effectiveType() !== 'code') {   // 언어는 코드 문항에만 있는 축이다
      node.hidden = true;
      return;
    }
    node.hidden = false;

    var graded = !!state.result;
    node.appendChild(el('span', 'type-filter-label', '언어'));

    var options = [{ value: '', label: '전체' }];
    LANGS.forEach(function (l) { options.push({ value: l, label: LANG_LABEL[l] }); });

    options.forEach(function (opt) {
      var on = state.langFilter === opt.value;
      var empty = langIsEmpty(opt.value);
      var btn = el('button', 'chip' + (on ? ' on' : '') + (empty ? ' empty' : ''), opt.label);
      btn.type = 'button';
      btn.setAttribute('data-lang', opt.value || 'all');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.disabled = graded || empty;
      if (empty) btn.title = '이 회차에는 ' + opt.label + ' 코드 문항이 없습니다.';
      btn.addEventListener('click', function () {
        if (on || state.result) return;
        goInternal(studyUrlForLang(opt.value));
      });
      node.appendChild(btn);
    });
  }

  // ------------------------------------------- 오답노트 해설 일괄 펼치기 줄

  function renderPeekBar() {
    if (!state.hasSource) return;
    var node = elPeekBar;
    if (!node) return;
    node.textContent = '';

    var ids = peekEligible() ? visibleQuestionIds() : [];
    if (!ids.length) {
      node.hidden = true;
      return;
    }
    node.hidden = false;

    var allOpen = true;
    var anyOpen = false;
    for (var i = 0; i < ids.length; i++) {
      var qid = ids[i];
      if (state.peekOpen[qid]) { anyOpen = true; continue; }
      if (state.peekDenied[qid]) continue;   // 애초에 열 수 없는 문항은 세지 않는다
      allOpen = false;
    }
    allOpen = allOpen && anyOpen;

    var btn = el('button', 'chip',
      state.peekAllLoading ? '불러오는 중…' : (allOpen ? '모두 접기' : '해설 모두 펼치기'));
    btn.id = 'peekAll';
    btn.type = 'button';
    btn.disabled = state.peekAllLoading;
    btn.addEventListener('click', function () { onPeekAll(allOpen, ids); });
    node.appendChild(btn);
    node.appendChild(el('span', 'peek-hint', '이미 채점받은 문항이라 채점 전에도 정답·해설을 볼 수 있습니다.'));
  }

  /**
   * 회차 모드에서만 /api/rounds 의 counts 를 곁들여 받아 온다 (0문항 유형 칩을 비활성화하기 위함).
   * 실패·구버전 서버는 조용히 무시한다 — 필터는 counts 없이도 완전히 동작해야 한다.
   */
  function loadRoundCounts() {
    if (state.mode !== 'round' || !state.roundId) return;
    api.get('/api/rounds').then(function (list) {
      var found = null;
      (Array.isArray(list) ? list : []).forEach(function (r) {
        if (r && r.round === state.roundId) found = r;
      });
      if (!found) return;
      var any = false;
      if (found.counts && typeof found.counts === 'object') {
        state.roundCounts = found.counts;
        any = true;
      }
      // 언어별 개수도 같은 항목에 실려 온다 (구버전 서버면 없다 — 그러면 언어 칩을 막지 않는다).
      if (found.langs && typeof found.langs === 'object') {
        state.roundLangs = found.langs;
        any = true;
      }
      if (any) renderTypeFilter();
    }).catch(function () { /* 부가 정보다 — 없으면 없는 대로 */ });
  }

  // ---------------------------------------------------------------- 렌더

  // ------------------------------------------------------------- 보기 칩

  /** 칩에 적을 말. 마커가 있으면 "ㄱ. 동치분할 …" 처럼 마커를 앞세운다. */
  function chipLabel(item) {
    if (item.marker && item.text && item.marker !== item.text) return item.marker + '. ' + item.text;
    return item.text || item.marker;
  }

  /** 칩이 채울 칸: 마지막 포커스 → 첫 빈 칸 → (다 찼으면) 첫 칸. */
  function chipTargetIndex(question, inputCount) {
    var last = state.lastFocusField[question.id];
    if (last != null && last >= 0 && last < inputCount) return last;
    var blank = blankFieldIndex(question);
    return blank >= 0 && blank < inputCount ? blank : 0;
  }

  /**
   * 보기 칩 줄. `.boki` 지문이 선택지로 파싱될 때만 입력칸 바로 위에 만든다.
   * 파싱 실패·채점 후에는 아무것도 만들지 않는다 (기존처럼 직접 타이핑).
   */
  function renderBokiChips(question, card, bodyNode) {
    if (!bodyNode || !window.Boki) return;
    var box = bodyNode.querySelector('.boki');
    if (!box) return;
    var items = window.Boki.parse(window.Boki.textFromNode(box));
    if (!items.length) return;

    var promptText = htmlToText(question.prompt);
    var row = el('div', 'boki-chips');
    row.setAttribute('data-q', question.id);
    items.forEach(function (item) {
      var btn = el('button', 'chip', chipLabel(item));
      btn.type = 'button';
      btn.title = '이 보기를 답안 칸에 넣기';
      btn.addEventListener('click', function () {
        var inputs = card.querySelectorAll('input.ans');
        if (!inputs.length) return;
        var idx = chipTargetIndex(question, inputs.length);
        var input = inputs[idx];
        input.value = window.Boki.fillValue(item, promptText);
        // 값만 바꾸고 input 이벤트를 쏜다 — 타이핑으로 고칠 수 있어야 한다.
        // 여기서 포커스를 옮기거나 state.lastFocusField 를 세우지 않는다(대전 쪽과 같은 동작) —
        // 그러면 다음 칩이 같은 칸을 덮어쓴다. 사람이 직접 고른 칸이 없으면 칩은 차례로 빈 칸을 채운다.
        fireInput(input);
      });
      row.appendChild(btn);
    });
    card.appendChild(row);
  }

  /** Enter → 다음 답안 칸. 마지막 칸이면 제출 버튼으로. Shift+Enter 는 그냥 둔다. */
  function onAnswerKeydown(ev) {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return;
    ev.preventDefault();
    var all = [].slice.call(elQuestions.querySelectorAll('input.ans'));
    var i = all.indexOf(ev.target);
    var next = i >= 0 ? all[i + 1] : null;
    if (next) next.focus();
    else if (elSubmit && !elSubmit.hidden) elSubmit.focus();
  }

  function renderQuestion(question, index) {
    var detail = detailFor(question.id);
    var graded = !!detail;

    var card = el('div', 'q');
    if (graded) card.classList.add(detail.correct ? 'correct' : 'wrong');
    card.setAttribute('data-q', question.id);

    // 우상단 뱃지 줄 — 유형(있을 때만) + 언어(코드 문항에만) + 출처 회차.
    // 회차 뱃지는 모든 모드에서 항상 표시한다.
    var badges = el('div', 'q-badges');
    var qType = normalizeType(question.type);
    if (qType) badges.appendChild(el('span', 'q-type ' + qType, TYPE_LABEL[qType]));
    var qLang = normalizeLang(question.lang);
    if (qLang) badges.appendChild(el('span', 'q-lang ' + qLang, LANG_LABEL[qLang]));
    badges.appendChild(el('span', 'q-origin', questionOrigin(question.id)));
    // 대전 오답 보기에서 "그때는 틀렸지만 지금은 오답이 아닌" 문항 (서버 resolvedIds).
    if (state.resolvedIds[question.id]) badges.appendChild(el('span', 'q-resolved', '이후 맞힘'));
    card.appendChild(badges);

    // 제목: 번호 + prompt(HTML 자산이므로 HTML 로 삽입).
    // 카드 제목은 문서 구조상 진짜 제목이다 (h1 회차명 → h3 문항). 클래스는 그대로 `.qtitle` 이고
    // 그 규칙이 h3 의 기본 위쪽 여백까지 눌러 주므로 모양은 변하지 않는다.
    var title = el('h3', 'qtitle');
    title.appendChild(el('span', 'num', displayNum(question, index)));
    var promptSpan = document.createElement('span');
    promptSpan.innerHTML = question.prompt || '';
    title.appendChild(promptSpan);
    card.appendChild(title);

    // 지문(HTML)
    var body = null;
    if (question.bodyHtml) {
      body = el('div', 'qbody');
      body.innerHTML = question.bodyHtml;
      // 표는 가로 스크롤 상자로 감싸고, 탭·공백이 뒤섞인 코드 블록은 표시할 때만 정돈한다.
      // 원본 데이터는 건드리지 않는다. (채점 후 카드도 같은 renderQuestion 을 지난다.)
      JPK.qbody.decorate(body, question.lang);
      card.appendChild(body);
    }

    // 보기 칩 (채점 전에만) — 입력칸 바로 위에 온다
    if (!graded) renderBokiChips(question, card, body);

    // 답안 입력
    var stored = state.answers[question.id] || [];
    // 바깥의 `index`(문항 순번)를 가리지 않도록 칸 번호는 fieldIndex 로 받는다.
    (question.fields || []).forEach(function (field, fieldIndex) {
      var row = el('div', 'ansrow');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'ans';
      input.id = 'ans-' + question.id + '-' + fieldIndex;
      // 전체 재렌더(해설 토글 등)를 가로질러 포커스·캐럿을 되돌리기 위한 안정된 키.
      // 대전 화면과 같은 규약이다 (js/shared/focus.js).
      input.setAttribute('data-fkey', JPK.focus.ansKey(question.id, fieldIndex));
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.value = stored[fieldIndex] == null ? '' : stored[fieldIndex];

      var label = el('label', null, fieldLabel(field.label, fieldIndex));
      label.htmlFor = input.id;
      row.appendChild(label);

      if (graded) {
        input.readOnly = true;
        var fr = (detail.fieldResults || [])[fieldIndex];
        input.classList.add(fr && fr.correct ? 'ok' : 'bad');
      } else {
        input.addEventListener('input', function () {
          if (!state.answers[question.id]) {
            state.answers[question.id] = (question.fields || []).map(function () { return ''; });
          }
          state.answers[question.id][fieldIndex] = input.value;
          scheduleSave();
          // 텍스트 한 줄만 고쳐 쓴다 — 입력 이벤트에서 카드를 다시 그리면 한글 조합이 깨진다.
          renderAnsweredCount();
        });
        input.addEventListener('keydown', onAnswerKeydown);
        // 보기 칩이 "마지막으로 보던 칸" 에 값을 넣을 수 있게 기억해 둔다.
        input.addEventListener('focus', function () { state.lastFocusField[question.id] = fieldIndex; });
      }
      row.appendChild(input);
      card.appendChild(row);
    });

    // 오답노트 채점 전 — "정답·해설 보기". 이미 채점 기록이 있는 문항이라 서버가 미리 내려 준다.
    // (몰라서 틀린 문항은 풀이법을 봐야 다시 풀 수 있다.)
    if (!graded && peekEligible()) {
      var peekActions = el('div', 'q-actions');
      card.appendChild(peekActions);
      renderPeek(question, peekActions, card);
    }

    // 채점 피드백
    if (graded) {
      var fb = el('div', 'feedback');
      if (detail.correct) {
        fb.textContent = '⭕ 정답';
      } else {
        fb.appendChild(document.createTextNode('❌ 오답 — 정답: '));
        fb.appendChild(el('b', null, detail.display || '(정답 표기가 등록되어 있지 않습니다)'));
      }
      card.appendChild(fb);

      // 해설 상자는 피드백 줄 바로 아래, 버튼 줄 위에 온다.
      // (아래 insertBefore 가 actions 를 .explain-box 뒤 · .report-box 앞에 끼워 넣는다)
      var actions = el('div', 'q-actions');
      renderExplain(question, actions, card);

      if (!detail.correct) {
        var askBtn = el('button', null, 'AI에게 질문하기');
        askBtn.type = 'button';
        askBtn.addEventListener('click', function () { onAskAi(question, detail); });
        actions.appendChild(askBtn);

        renderReport(question, detail, actions, card);
      }

      if (actions.childNodes.length) card.insertBefore(actions, card.querySelector('.report-box'));
    }

    return card;
  }

  // ------------------------------------------------- 답한 문항 수 · 미입력 안내

  /**
   * 이 문항의 답이 다 찼는가. **모든 칸이 차야** 답한 것으로 센다 —
   * 대전 진행 현황·서버 집계와 같은 규칙이다 (한 칸이라도 비면 아직 덜 푼 문항).
   */
  function blankFieldIndex(question) {
    var vals = state.answers[question.id] || [];
    var fields = question.fields || [];
    for (var i = 0; i < fields.length; i++) {
      if (vals[i] == null || String(vals[i]).trim() === '') return i;
    }
    return -1;   // 빈 칸 없음 = 답한 문항
  }

  function isAnswered(question) {
    return blankFieldIndex(question) < 0;
  }

  /** 아직 빈 칸이 남은 문항들 — 화면에 보이는 순서 그대로. */
  function unansweredQuestions() {
    return ((state.round && state.round.questions) || []).filter(function (q) {
      return !isAnswered(q);
    });
  }

  /** 제출 버튼 옆 "답한 문항 17/20". 채점 뒤에는 의미가 없으므로 감춘다. */
  function renderAnsweredCount() {
    if (!elAnswered) return;
    var questions = (state.round && state.round.questions) || [];
    if (!questions.length || state.result) {
      elAnswered.textContent = '';
      elAnswered.hidden = true;
      syncStudyBar();   // 채점되면 미니바도 함께 내려간다
      return;
    }
    var done = questions.length - unansweredQuestions().length;
    elAnswered.textContent = '답한 문항 ' + done + '/' + questions.length;
    elAnswered.hidden = false;
    syncStudyBar();   // 하단 미니바도 같은 셈을 쓴다
  }

  /**
   * 미입력 안내에서 "취소" 를 눌렀을 때 — 그 문항의 **첫 빈 칸**으로 스크롤 + 포커스.
   * 순서가 중요하다: focus 가 스스로 스크롤해 버리면 뒤이은 smooth 스크롤이 취소되므로
   * preventScroll 로 포커스만 먼저 옮기고, 스크롤은 그 다음에 한 번만 한다.
   * block 은 'center' — 'start' 로 붙이면 카드 위쪽이 상단 내비에 가려 번호·뱃지가 안 보인다.
   */
  function focusFirstBlank(question) {
    var card = elQuestions.querySelector('.q[data-q="' + question.id + '"]');
    if (!card) return;
    var inputs = card.querySelectorAll('input.ans');
    var blank = blankFieldIndex(question);
    var input = inputs[blank < 0 ? 0 : blank] || inputs[0];
    if (input) {
      // preventScroll 미지원 브라우저는 인자 없는 호출로 떨어뜨린다.
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        try { input.focus(); } catch (e2) { /* 무시 */ }
      }
    }
    if (!card.scrollIntoView) return;
    try {
      // behavior 는 모션 축소 설정을 따른다 — CSS 미디어 쿼리는 스크립트 스크롤을 막지 못한다.
      card.scrollIntoView({ behavior: JPK.motion.smoothScrollBehavior(), block: 'center' });
    } catch (e) {
      card.scrollIntoView();
    }
  }

  /**
   * 빈 칸이 남은 문항이 있으면 한 번 되묻는다. 계속 제출해도 되면 true.
   * confirm 이 없는 환경(구형 웹뷰·하네스)에서는 막지 않는다 — 제출을 못 하게 되는 쪽이 더 나쁘다.
   */
  function confirmBlanks() {
    var blanks = unansweredQuestions();
    if (!blanks.length) return true;
    var ok = true;
    try {
      if (typeof window.confirm === 'function') {
        ok = window.confirm('아직 답하지 않았거나 빈칸이 남은 문항이 ' + blanks.length + '개 있습니다.\n'
          + '그대로 제출할까요?');
      }
    } catch (e) {
      ok = true;
    }
    if (ok === false) {
      focusFirstBlank(blanks[0]);
      return false;
    }
    return true;
  }

  // ------------------------------------------------- 점수판 축소(sticky compact)

  /**
   * 점수판이 sticky 로 "붙기 시작했는가" — 붙은 순간 박스의 화면 좌표 top 은 정확히 sticky top 에 고정된다.
   * 문서 맨 위(scrollY 0)는 붙었을 리 없다: 레이아웃을 계산하지 않는 환경(jsdom)에서
   * 좌표가 전부 0 으로 나와도 오탐하지 않게 막아 준다.
   * 순수 함수라 스크롤 없이도 판정을 그대로 검사할 수 있다.
   */
  function isBoardStuck(scrollY, boardRectTop, stickyTop) {
    return scrollY > 0 && boardRectTop <= stickyTop + 0.5;
  }

  /** CSS 의 sticky top 값 (반응형에서 52px → 46px 로 줄어든다). 못 읽으면 0. */
  function boardStickyTop() {
    var top = NaN;
    try {
      top = parseFloat(window.getComputedStyle(elBoard).top);
    } catch (e) { /* 계산 스타일 없음 */ }
    return isNaN(top) ? 0 : top;
  }

  function setBoardCompact(on) {
    if (on === state.boardCompact) return;   // 불리언이 바뀔 때만 DOM 을 건드린다
    state.boardCompact = on;
    if (on) elBoard.classList.add('compact');
    else elBoard.classList.remove('compact');
  }

  function syncBoardCompact() {
    if (!elBoard || !elBoard.classList.contains('shown')) {
      setBoardCompact(false);
      return;
    }
    var y = window.scrollY || window.pageYOffset || 0;
    var top = 0;
    try {
      top = elBoard.getBoundingClientRect().top;
    } catch (e) { /* 무시 */ }
    setBoardCompact(isBoardStuck(y, top, boardStickyTop()));
  }

  /** battle.js 의 onFloatScroll 과 같은 모양 — rAF 로 한 프레임에 한 번만 계산한다. */
  function onBoardScroll() {
    if (state.boardTicking) return;
    state.boardTicking = true;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
      state.boardTicking = false;
      syncBoardCompact();
    });
  }

  if (elBoard) {
    window.addEventListener('scroll', onBoardScroll, { passive: true });
    window.addEventListener('resize', onBoardScroll, { passive: true });
  }

  // ------------------------------------------------- 하단 미니바 (#studyBar)

  /**
   * 미니바를 띄울 조건 — 풀이 중(채점 전)이고 **제출 버튼이 화면 밖**일 때.
   * 순수 함수라 스크롤 없이도 판정을 그대로 검사할 수 있다.
   * 좌표가 전부 0 이면 레이아웃을 계산하지 않는 환경(jsdom)이다 — 근거 없이 띄우지 않는다.
   */
  function shouldShowBar(active, submitTop, submitBottom, viewportH) {
    if (!active) return false;
    if (submitTop === 0 && submitBottom === 0) return false;
    return submitTop >= viewportH || submitBottom <= 0;
  }

  /** 풀이 중인가 — 문항이 있고, 아직 채점 전이고, 제출 버튼 줄이 살아 있는 상태. */
  function barActive() {
    if (!elStudyBar || state.result || state.submitting) return false;
    if (!state.round || !(state.round.questions || []).length) return false;
    return !!elBtnbar && elBtnbar.hidden === false;
  }

  function renderBarText() {
    var questions = (state.round && state.round.questions) || [];
    var blanks = unansweredQuestions();
    var text = '답한 ' + (questions.length - blanks.length) + '/' + questions.length;
    if (elBarCount && text !== state.barCountText) {
      state.barCountText = text;
      elBarCount.textContent = text;
    }
    // 빈 칸이 하나도 없으면 갈 곳이 없다.
    if (elBarNext) elBarNext.disabled = blanks.length === 0;
  }

  function syncStudyBar() {
    if (!elStudyBar) return;
    var active = barActive();
    var top = 0;
    var bottom = 0;
    if (active && elSubmit) {
      try {
        var r = elSubmit.getBoundingClientRect();
        top = r.top;
        bottom = r.bottom;
      } catch (e) { /* 좌표 없음 */ }
    }
    var vh = window.innerHeight
      || (document.documentElement && document.documentElement.clientHeight) || 0;
    var show = shouldShowBar(active, top, bottom, vh);
    if (show) renderBarText();
    if (show === state.barShown) return;   // 불리언이 바뀔 때만 DOM 을 건드린다
    state.barShown = show;
    elStudyBar.hidden = !show;
    if (document.body) {
      if (show) document.body.classList.add('with-studybar');
      else document.body.classList.remove('with-studybar');
    }
  }

  function onBarScroll() {
    if (state.barTicking) return;
    state.barTicking = true;
    (window.requestAnimationFrame || function (fn) { setTimeout(fn, 16); })(function () {
      state.barTicking = false;
      syncStudyBar();
    });
  }

  if (elStudyBar) {
    window.addEventListener('scroll', onBarScroll, { passive: true });
    window.addEventListener('resize', onBarScroll, { passive: true });
  }

  if (elBarNext) {
    elBarNext.addEventListener('click', function () {
      var blanks = unansweredQuestions();
      if (!blanks.length) return;
      focusFirstBlank(blanks[0]);
    });
  }
  if (elBarSubmit) {
    // 기존 제출과 같은 경로다 — 미입력 확인도 그대로 걸린다.
    elBarSubmit.addEventListener('click', function () { submit(); });
  }

  /** 채점 결과에서 틀린 문항 id — 화면에 보이는 순서 그대로. */
  function wrongQuestionIds() {
    if (!state.result || !state.round) return [];
    var ids = [];
    (state.round.questions || []).forEach(function (q) {
      var detail = detailFor(q.id);
      if (detail && !detail.correct) ids.push(q.id);
    });
    return ids;
  }

  /**
   * 불합격 CTA 가 하는 일 — 첫 오답 카드로 데려간다.
   * 해설이 있으면 기존 "해설 보기" 토글과 같은 상태(state.showExplain)를 켜서 열어 주고,
   * 해설이 없는 문항이면 스크롤만 한다.
   */
  function goToFirstWrong() {
    var ids = wrongQuestionIds();
    if (!ids.length) return;
    var qid = ids[0];
    if (explanationOf(qid) && !state.showExplain[qid]) {
      state.showExplain[qid] = true;
      render();   // 카드를 다시 만든다 — 스크롤 대상은 재렌더 뒤에 찾아야 한다
    }
    var card = elQuestions.querySelector('.q[data-q="' + qid + '"]');
    scrollToEl(card);
    // 재렌더로 방금 누른 CTA 가 사라져 포커스가 <body> 로 떨어진다 — 키보드 사용자가
    // 문서 맨 위부터 다시 탭하지 않도록 도착한 카드로 포커스를 넘긴다.
    if (card) {
      card.setAttribute('tabindex', '-1');
      // preventScroll 미지원 브라우저는 인자 없는 호출로 떨어뜨린다.
      try {
        card.focus({ preventScroll: true });
      } catch (e) {
        try { card.focus(); } catch (e2) { /* 무시 */ }
      }
    }
  }

  function renderBoard() {
    if (!state.result) {
      elBoard.classList.remove('shown');
      setBoardCompact(false);
      return;
    }
    var r = state.result;
    elBoard.querySelector('.score').textContent = r.score + '점 / 100점';
    var passEl = elBoard.querySelector('.pass');
    var tail = ' (' + r.correctCount + '/' + r.totalCount + ' 문제 정답)';
    var passed = r.score >= PASS_SCORE;
    // 펼친 상태의 문구는 예전 그대로다 — 두 조각으로 나누기만 한다.
    // 축소(.compact) 상태에서 긴 앞말 대신 보여 줄 짧은 말은 data-short 로 넘긴다
    // (CSS 생성 콘텐츠라 textContent 에는 섞이지 않는다).
    passEl.textContent = '';
    passEl.className = 'pass ' + (passed ? 'ok' : 'no');
    passEl.setAttribute('data-short', passed ? '🎉 합격권' : '합격까지 ' + (PASS_SCORE - r.score) + '점');
    passEl.appendChild(el('span', 'pass-lead',
      passed ? '🎉 합격권입니다!' : '아쉽습니다. ' + PASS_SCORE + '점 이상이 합격입니다.'));
    passEl.appendChild(el('span', 'pass-tail', tail));
    // 불합격이면 다음 행동을 붙인다 — 첫 오답 카드로 데려가고 해설을 열어 준다.
    // 합격이거나 오답이 없으면 아예 만들지 않는다(축소 상태에서는 CSS 가 감춘다).
    if (!passed) {
      var wrongIds = wrongQuestionIds();
      if (wrongIds.length) {
        var cta = el('button', 'pass-cta', '틀린 ' + wrongIds.length + '문항 해설 보기 →');
        cta.type = 'button';
        cta.addEventListener('click', goToFirstWrong);
        passEl.appendChild(cta);
      }
    }
    elBoard.classList.add('shown');
    syncBoardCompact();
  }

  /** 헤더 아래 한 줄. 채점 전에는 안내, 채점 후에는 다음에 할 일을 말한다. */
  function metaText() {
    if (state.result) {
      var wrongN = 0;
      (state.result.details || []).forEach(function (d) { if (!d.correct) wrongN++; });
      var line = '채점 완료 — 오답 ' + wrongN + '문항. 틀린 문항에서 AI 질문 복사 / 이의 제기를 쓸 수 있습니다.';
      if (state.mode === 'wrong') line += ' 맞힌 문항은 오답노트에서 빠집니다.';
      return line;
    }
    var n = state.round.questions.length;
    // ?match= 는 과거 스냅샷, ?round= 는 현재 오답이다 — 안내에서 분명히 구분한다.
    var head = '총 ' + n + '문항';
    if (state.wrongMatch) head = '이 대전에서 틀린 ' + n + '문항 (지금은 맞힌 문항도 포함)';
    else if (state.wrongRound) head = '이 회차의 현재 오답 ' + n + '문항';
    var scope = '';
    if (state.typeFilter) scope += ' · ' + TYPE_LABEL[state.typeFilter] + ' 유형만';
    if (state.langFilter) scope += ' · ' + LANG_LABEL[state.langFilter];
    return head + ' · 100점 만점 ('
      + PASS_SCORE + '점 이상 합격) — 답을 입력하고 맨 아래 제출 버튼을 누르세요' + scope;
  }

  /**
   * 오답노트가 비었을 때 — 실패가 아니므로 fail() 이 아니라 축하하는 빈 화면을 준다.
   * 회차·대전 부분 보기는 문구도 돌아갈 곳도 허브(wrong.html)를 가리킨다.
   */
  function renderEmptyWrong() {
    var scoped = !!(state.wrongMatch || state.wrongRound);
    elTitle.textContent = (state.round && state.round.title) || '오답노트';
    elMeta.textContent = '지금은 다시 풀 오답이 없습니다.';
    renderBattleSub();
    renderTypeFilter();
    elQuestions.textContent = '';
    var box = el('div', 'card empty-state');
    if (state.wrongMatch) {
      box.appendChild(el('p', null, '🎉 이 대전에서 틀린 문항이 없습니다.'));
      box.appendChild(el('p', 'hint', '다른 대전이나 회차의 오답을 오답노트에서 골라 보세요.'));
    } else if (state.wrongRound) {
      box.appendChild(el('p', null, '🎉 이 회차의 오답은 모두 정리했습니다.'));
      box.appendChild(el('p', 'hint', '다른 회차의 오답을 오답노트에서 골라 보세요.'));
    } else {
      box.appendChild(el('p', null, '🎉 틀린 문항이 없습니다.'));
      box.appendChild(el('p', 'hint',
        '회차를 풀고 채점하면 틀린 문항이 여기에 모입니다. 나중에 맞히면 자동으로 빠집니다.'));
    }
    var back = el('p', 'hint');
    var a = document.createElement('a');
    a.href = scoped ? '/wrong.html' : '/';
    a.textContent = scoped ? '오답노트로 돌아가기' : '회차 목록으로 돌아가기';
    back.appendChild(a);
    box.appendChild(back);
    elQuestions.appendChild(box);
    elBtnbar.hidden = true;
    if (elTools) elTools.hidden = true;
  }

  function render() {
    // fail() 로 떨어진 화면은 **종결**이다. 뒤늦게 도착한 응답이나 화면에 남아 있던 버튼이
    // 문항·제출 버튼을 되살리면 로그인 안내 위로 시험지가 다시 깔린다.
    if (state.pageFailed) return;
    var round = state.round;
    if (!round) return;

    elTitle.textContent = round.title || round.round;
    elMeta.textContent = metaText();
    renderBattleSub();
    renderTypeFilter();

    // 문항 목록은 매번 통째로 다시 만든다. 해설 토글 하나에도 DOM 이 전부 갈리므로,
    // 그때 어느 칸에 무엇을 치고 있었는지(한글 조합 포함)를 잃지 않도록 키로 적어 두고 되돌린다.
    var focused = JPK.focus.capture(elQuestions);

    elQuestions.textContent = '';
    if (round.questions.length === 0) {
      elQuestions.appendChild(el('p', 'muted', '이 회차에는 등록된 문항이 없습니다.'));
      elBtnbar.hidden = true;
      renderLoginNotice();
      return;
    }
    round.questions.forEach(function (q, i) {
      elQuestions.appendChild(renderQuestion(q, i));
    });
    JPK.focus.restore(elQuestions, focused);

    elBtnbar.hidden = false;
    var graded = !!state.result;
    elSubmit.hidden = graded;
    elReset.hidden = !graded;
    elSubmit.disabled = state.submitting;
    elSubmit.textContent = state.submitting ? '채점하는 중...' : '제출하고 채점하기';
    if (elTools) elTools.hidden = graded;

    renderAnsweredCount();
    renderLoginNotice();
    renderBoard();
    renderTimer();

    // 이의 제기 상자를 **막 연** 경우에만 그리로 포커스를 옮긴다.
    // (그 밖의 재렌더에서는 위 JPK.focus.restore 가 원래 있던 칸을 지킨다.)
    if (state.reportFocus) {
      var ta = elQuestions.querySelector('textarea[data-report="' + state.reportFocus + '"]');
      state.reportFocus = '';
      if (ta) ta.focus();
    }
  }

  // ---------------------------------------------------------------- 동작

  function collectAnswers() {
    var out = {};
    (state.round.questions || []).forEach(function (q) {
      var stored = state.answers[q.id] || [];
      out[q.id] = (q.fields || []).map(function (_f, i) {
        return stored[i] == null ? '' : String(stored[i]);
      });
    });
    return out;
  }

  function gradeRequest() {
    var answers = collectAnswers();
    if (state.mode === 'round') {
      // 유형 필터가 걸린 채점은 그 부분집합만 채점한다 (총점도 부분집합 기준).
      var body = { answers: answers };
      if (state.typeFilter) body.type = state.typeFilter;
      // 언어까지 좁혀 풀었으면 채점도 같은 부분집합이어야 총점 분모가 맞는다.
      if (state.langFilter) body.lang = state.langFilter;
      return api.post('/api/rounds/' + encodeURIComponent(state.roundId) + '/grade', body);
    }
    // practice/wrong 세트는 이미 필터된 문항만 들고 있으므로 경로를 바꾸지 않는다.
    return api.post('/api/practice/grade', {
      setKey: state.setKey,
      setToken: (state.round && state.round.setToken) || '', // 서버가 채점 집합을 정한다
      answers: answers,
    });
  }

  /**
   * @param {boolean} [skipConfirm] 타이머 자동 제출처럼 사람이 누르지 않은 제출 — 되묻지 않는다.
   */
  function submit(skipConfirm) {
    if (state.submitting || state.result || !state.round) return;
    if (!skipConfirm && !confirmBlanks()) return;
    state.submitting = true;
    elSubmit.disabled = true;
    elSubmit.textContent = '채점하는 중...';

    gradeRequest()
      .then(function (result) {
        state.submitting = false;
        state.result = result;
        stopTimer();
        clearSaved();
        hideRestoreNotice();
        render();
        scrollToEl(elBoard);
      })
      .catch(function (e) {
        state.submitting = false;
        elSubmit.disabled = false;
        elSubmit.textContent = '제출하고 채점하기';
        var status = e && e.status;

        // 401 — 로그인이 필요하다. 토스트는 사라지므로 제출 버튼 옆에 남는 안내도 함께 세운다.
        // 답안을 먼저 확정 저장해 둔다: 사람이 곧 로그인하러 이 페이지를 떠난다.
        if (status === 401) {
          state.me = null;
          state.meLoaded = true;
          state.gradeBlocked = 'auth';
          saveNow();
          renderLoginNotice();
          toast('채점하려면 로그인이 필요합니다.', 'bad');
          return;
        }

        // 409(진행 중인 대전의 문항) · 429(채점 요청 과다) 는 서버 문구가 이미 이유를 말한다.
        // 둘 다 답안은 그대로 남아 있어야 하므로 화면을 되돌리지 않는다.
        toast(e && e.message ? e.message : '채점에 실패했습니다.', 'bad');
      });
  }

  function reset() {
    state.result = null;
    state.answers = {};
    state.lastFocusField = {};
    state.showExplain = {};
    // 받아 둔 정답·해설(state.peek)은 그대로 둔다 — 같은 문항이라 다시 물어볼 이유가 없다.
    // 펼침 상태만 접는다.
    state.peekOpen = {};
    state.peekLoading = {};
    state.peekAllLoading = false;
    state.reportOpen = {};
    state.reportText = {};
    state.reportStatus = {};
    stopTimer();
    clearSaved();
    hideRestoreNotice();
    render();
    scrollTop();
  }

  // 이벤트 객체가 skipConfirm 자리에 들어가지 않도록 감싼다.
  elSubmit.addEventListener('click', function () { submit(); });
  elReset.addEventListener('click', reset);

  // ------------------------------------------------------------------ 시작

  function fail(message, extraLink, linkText) {
    state.pageFailed = true;   // 이 뒤로는 문항이 없는 화면이다 — render() 도 여기서 멈춘다
    elTitle.textContent = '학습 모드';
    elMeta.textContent = '';
    // 복원 배너를 남기면 그 안의 "불러온 답안 지우기" 가 render() 를 불러 화면을 되살리려 든다.
    hideRestoreNotice();
    // 유형 필터로 문항이 0개면 서버가 400 을 준다 — 문구는 그대로 띄우되 필터는 남겨 둔다
    // (다른 유형이나 '전체' 로 곧바로 되돌아갈 수 있어야 한다).
    renderTypeFilter();
    elQuestions.textContent = '';
    // 문항 대신 뜨는 실패 안내다 — 조작 없이 나타나므로 보조 기술에도 즉시 읽혀야 한다.
    var err = el('p', 'error-text', message);
    err.setAttribute('role', 'alert');
    elQuestions.appendChild(err);
    var back = el('p', 'hint');
    var a = document.createElement('a');
    a.href = extraLink || '/';
    a.textContent = linkText || '회차 목록으로 돌아가기';
    back.appendChild(a);
    elQuestions.appendChild(back);
    elBtnbar.hidden = true;
    if (elTools) elTools.hidden = true;
    renderLoginNotice();   // 문항이 없는 화면에서는 채점 안내도 의미가 없다
  }

  /**
   * 쿼리스트링 → 어떤 문항 묶음을 어디서 가져올지.
   * `?type=code|sql|theory` 는 세 출처 모두에 그대로 얹는다 (알 수 없는 값이면 무시 = 전체).
   */
  function parseSource() {
    var type = normalizeType(queryParam('type'));
    var lang = normalizeLang(queryParam('lang'));
    // 서버 계약: lang 은 코드 문항에만 쓴다. lang 만 오면 type=code 로 간주하고,
    // 코드가 아닌 유형과 함께 오면(서버 400 감) 여기서 미리 버린다.
    if (lang && !type) type = 'code';
    if (lang && type !== 'code') lang = '';

    var qs = [];
    if (type) qs.push('type=' + encodeURIComponent(type));
    if (lang) qs.push('lang=' + encodeURIComponent(lang));
    var tail = qs.length ? '&' + qs.join('&') : '';

    var set = queryParam('set');
    if (set === 'wrong') {
      // 허브에서 넘어오는 한정자. 둘 다 오면 match 가 이긴다 (더 좁은 보기다).
      var wrongMatch = queryParam('match');
      var wrongRound = wrongMatch ? '' : queryParam('round');
      var parts = [];
      if (wrongMatch) parts.push('match=' + encodeURIComponent(wrongMatch));
      else if (wrongRound) parts.push('round=' + encodeURIComponent(wrongRound));
      parts = parts.concat(qs);
      return {
        mode: 'wrong',
        setKey: 'wrong',
        type: type,
        lang: lang,
        wrongRound: wrongRound,
        wrongMatch: wrongMatch,
        url: '/api/me/wrong' + (parts.length ? '?' + parts.join('&') : ''),
      };
    }
    if (set === 'practice') {
      var roundsParam = queryParam('rounds') || 'all';
      var count = queryParam('count') || '20';
      return {
        mode: 'practice',
        setKey: 'practice',
        type: type,
        lang: lang,
        practiceRounds: roundsParam,
        practiceCount: count,
        url: '/api/practice?rounds=' + encodeURIComponent(roundsParam)
          + '&count=' + encodeURIComponent(count) + tail,
      };
    }
    var round = queryParam('round');
    if (round) {
      return {
        mode: 'round',
        setKey: round,
        roundId: round,
        type: type,
        lang: lang,
        url: '/api/rounds/' + encodeURIComponent(round) + (qs.length ? '?' + qs.join('&') : ''),
      };
    }
    return null;
  }

  // 필터 칩이 남긴 "내부 이동" 표식은 도착과 동시에 지운다 — 그 다음 이탈은 진짜 이탈이다.
  JPK.store.sessionRemove(INTERNAL_NAV_KEY);

  var source = parseSource();
  if (!source) {
    fail('무엇을 풀지 지정되지 않았습니다. 주소에 ?round=회차id 또는 ?set=practice / ?set=wrong 이 필요합니다.');
  } else {
    state.mode = source.mode;
    state.setKey = source.setKey;
    state.roundId = source.roundId || '';
    state.wrongRound = source.wrongRound || '';
    state.wrongMatch = source.wrongMatch || '';
    state.typeFilter = source.type || '';
    state.langFilter = source.lang || '';
    if (source.practiceRounds) state.practiceRounds = source.practiceRounds;
    if (source.practiceCount) state.practiceCount = source.practiceCount;
    state.hasSource = true;
    renderTypeFilter();
    loadRoundCounts();

    api.get(source.url)
      .then(function (data) {
        state.round = {
          round: state.setKey,
          title: data.title || data.round || state.setKey,
          sourceUrl: data.sourceUrl || '',
          // 서버가 발급한 세트 토큰 — 모의고사·오답노트 채점 때 그대로 돌려보낸다(보안 C-1)
          setToken: typeof data.setToken === 'string' ? data.setToken : '',
          questions: data.questions || [],
        };
        document.title = state.round.title + ' 학습 — 정처기 배틀';

        // 대전 오답 보기의 부가 정보. 없는 서버·다른 보기에서는 그냥 비어 있다.
        state.battle = data.battle && typeof data.battle === 'object' ? data.battle : null;
        state.resolvedIds = {};
        (Array.isArray(data.resolvedIds) ? data.resolvedIds : []).forEach(function (qid) {
          state.resolvedIds[qid] = true;
        });

        if (state.mode === 'wrong' && state.round.questions.length === 0) {
          renderEmptyWrong();
          return;
        }
        restoreSaved();
        if (elTools) elTools.hidden = false;
        render();
      })
      .catch(function (e) {
        if (state.mode === 'wrong' && e.status === 401) {
          failWrongAuth();
          return;
        }
        // 회차·대전 한정 보기의 실패(없는 대전 404, 잘못된 값 400)는 허브로 되돌려 준다.
        if (state.mode === 'wrong' && (state.wrongMatch || state.wrongRound)) {
          fail(e.message, '/wrong.html', '오답노트로 돌아가기');
          return;
        }
        fail(e.message);
      });
  }

  /** 로그인 여부는 내비뿐 아니라 채점 안내도 정한다 — 한 곳에서 받아 둘 다 갱신한다. */
  function applyMe(user) {
    state.me = user || null;
    state.meLoaded = true;
    renderNav(state.me);
    renderLoginNotice();
  }

  // 조회에 실패하면 비로그인으로 단정하지 않는다 — 일시적 오류로 "로그인하세요" 를 띄우면
  // 이미 로그인한 사람에게 거짓말이 된다. meLoaded 를 세우지 않아 안내를 내지 않는다.
  api.me().then(applyMe).catch(function () { renderNav(null); });
})();
