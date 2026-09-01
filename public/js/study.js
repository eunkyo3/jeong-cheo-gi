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
 * 회차/오답노트만 저장한다 — 랜덤 모의고사는 문항 집합이 매번 달라 복원이 무의미하다.
 * 오답노트의 부분 보기는 키에 한정자를 덧붙인다('jpk-study:wrong:round:2024-1') — 전체 오답 풀이의
 * 저장분과 섞이면 없는 문항의 답이 되살아난다.
 */
(function () {
  'use strict';

  var PASS_SCORE = 60;
  var STORE_PREFIX = 'jpk-study:';
  var TIMER_PREF_KEY = 'jpk-study:timer';
  var SAVE_DEBOUNCE_MS = 300;
  var REPORT_DONE = '접수되었습니다. 고맙습니다!';

  // 문항 유형 — 서버 계약(data/types/*.json)의 값 셋과 화면 표기.
  var TYPE_ORDER = ['code', 'sql', 'theory'];
  var TYPE_LABEL = { code: '코드', sql: 'SQL', theory: '이론' };
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
    roundCounts: null, // {code,sql,theory} — 회차 모드에서만. 0문항 유형 칩을 비활성화하는 데 쓴다
    practiceRounds: 'all', // mode==='practice' 일 때 필터 링크를 다시 만들기 위해 보관
    practiceCount: '20',
    round: null,      // {round,title,sourceUrl,questions[]}
    answers: {},      // qid -> [string]
    result: null,     // {correctCount,totalCount,score,details[],bodyTexts{},explanations{}}
    submitting: false,
    showExplain: {},  // qid -> true (해설 펼침 — 채점 후에만 의미 있다)
    // 이의 제기 인라인 상자 (battle.js 와 같은 모양)
    reportOpen: {},   // qid -> true
    reportText: {},   // qid -> string
    reportStatus: {}, // qid -> string
    reportFocus: '',  // 재렌더 직후 포커스를 줄 qid
    // 타이머
    timerMinutes: 0,
    timerEndsAt: 0,   // epoch ms, 0 이면 정지
    timerHandle: null,
  };

  var elQuestions = document.getElementById('questions');
  var elTitle = document.getElementById('roundTitle');
  var elMeta = document.getElementById('roundMeta');
  var elBoard = document.getElementById('scoreBoard');
  var elBtnbar = document.getElementById('btnbar');
  var elSubmit = document.getElementById('submitBtn');
  var elReset = document.getElementById('resetBtn');
  var elToastWrap = document.getElementById('toastWrap');
  var elNavWho = document.getElementById('navWho');
  var elNavLogout = document.getElementById('navLogout');
  var elTools = document.getElementById('studyTools');
  var elTimerSelect = document.getElementById('timerSelect');
  var elTimerBtn = document.getElementById('timerBtn');
  var elTimerOut = document.getElementById('timerOut');
  var elRestore = document.getElementById('restoreNotice');

  // ------------------------------------------------------------- 작은 도구

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function toast(message, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    elToastWrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('leaving');
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 300);
    }, 2600);
  }

  /** jsdom·구형 브라우저·사파리 프라이빗 모드에서 던질 수 있다 — 저장은 항상 최선 노력. */
  function storeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function storeSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) { /* 용량 초과·차단 — 무시 */ }
  }
  function storeRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (e) { /* 무시 */ }
  }

  /** jsdom 은 스크롤을 구현하지 않는다 — 없으면 조용히 건너뛴다. */
  function scrollToEl(node) {
    try {
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch (e) { /* 무시 */ }
  }
  function scrollTop() {
    try {
      if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { /* 무시 */ }
  }

  /** HTML 문자열에서 사람이 읽을 텍스트만 뽑는다 (bodyText 가 비었을 때의 폴백). */
  function htmlToText(html) {
    var div = document.createElement('div');
    div.innerHTML = html == null ? '' : html;
    return (div.textContent || '').trim();
  }

  /** 좁은 화면에서 표가 카드를 밀어내지 않도록 가로 스크롤 상자로 감싼다. */
  function wrapTables(container) {
    var tables = container.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var parent = t.parentNode;
      if (parent && parent.classList && parent.classList.contains('tbl-scroll')) continue;
      var box = el('div', 'tbl-scroll');
      parent.insertBefore(box, t);
      box.appendChild(t);
    }
  }

  function queryParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function fieldLabel(label, index) {
    return label == null || label === '' ? '답' + (index + 1) : label;
  }

  /** 알 수 없는 값은 전부 '' (= 전체) 로 떨어뜨린다 — 서버에 이상한 type 을 보내지 않는다. */
  function normalizeType(value) {
    var t = String(value == null ? '' : value).trim().toLowerCase();
    return TYPE_ORDER.indexOf(t) === -1 ? '' : t;
  }

  function detailFor(questionId) {
    if (!state.result) return null;
    var list = state.result.details || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].questionId === questionId) return list[i];
    }
    return null;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /**
   * 문항 id("2026-2#3")에서 출처 회차·번호를 사람이 읽는 표기로 뽑는다.
   * "YYYY-N#num" 형태만 "YYYY년 N회 · num번" 으로 바꾸고, 그 외 형태는 '#' 앞부분을 그대로 보여준다.
   */
  function questionOrigin(qid) {
    var s = String(qid == null ? '' : qid);
    var hashIdx = s.indexOf('#');
    var prefix = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
    var num = hashIdx >= 0 ? s.slice(hashIdx + 1) : '';
    var m = /^(\d{4})-(\d+)$/.exec(prefix);
    if (!m) return prefix;
    var label = m[1] + '년 ' + m[2] + '회';
    return num ? label + ' · ' + num + '번' : label;
  }

  function formatTime(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // ---------------------------------------------------------------- 내비

  function renderNav(user) {
    elNavWho.textContent = '';
    if (!user) {
      elNavLogout.hidden = true;
      return;
    }
    elNavWho.appendChild(el('b', null, user.nickname));
    elNavWho.appendChild(document.createTextNode(' 님'));
    elNavLogout.hidden = false;
  }

  elNavLogout.addEventListener('click', function () {
    elNavLogout.disabled = true;
    api.logout().then(function () {
      elNavLogout.disabled = false;
      renderNav(null);
      toast('로그아웃했습니다.');
    }).catch(function (e) {
      elNavLogout.disabled = false;
      toast(e.message, 'bad');
    });
  });

  // ------------------------------------------------------------- 자동 저장

  var saveTimer = null;

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
   * 저장 키. 랜덤 모의고사는 매번 문항이 달라 저장하지 않는다 → null.
   * 유형 필터가 걸리면 문항 묶음 자체가 달라지므로 키도 분리한다 (전체 풀이의 저장분과 섞이지 않게).
   */
  function saveKey() {
    if (state.mode === 'practice') return null;
    if (!state.setKey) return null;
    var scope = wrongScope();
    return STORE_PREFIX + state.setKey
      + (scope ? ':' + scope : '')
      + (state.typeFilter ? ':' + state.typeFilter : '');
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

  function saveNow() {
    var key = saveKey();
    if (!key || state.result) return;
    if (!hasAnswers()) {
      storeRemove(key);
      return;
    }
    storeSet(key, JSON.stringify({ answers: state.answers, savedAt: Date.now() }));
  }

  function scheduleSave() {
    if (!saveKey() || state.result) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function clearSaved() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    var key = saveKey();
    if (key) storeRemove(key);
  }

  /**
   * 문항을 받은 직후 한 번 호출한다. 지금 세트에 실제로 있는 문항만 복원한다
   * (회차 데이터가 바뀌어 사라진 문항의 답이 남아 있어도 무시된다).
   */
  function restoreSaved() {
    var key = saveKey();
    if (!key || !state.round) return;
    var raw = storeGet(key);
    if (!raw) return;
    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      storeRemove(key);
      return;
    }
    if (!saved || !saved.answers || typeof saved.answers !== 'object') return;

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
      storeRemove(key);
      return;
    }
    showRestoreNotice(saved.savedAt);
  }

  function showRestoreNotice(savedAt) {
    if (!elRestore) return;
    elRestore.textContent = '';
    var when = typeof savedAt === 'number' && savedAt > 0 ? formatTime(savedAt) : '시각 미상';
    elRestore.appendChild(document.createTextNode('이전에 입력하던 답안을 불러왔습니다 (' + when + ').'));
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

  // 새로고침·이탈 경고 — 채점 전이고 뭔가 적어 둔 게 있을 때만.
  window.addEventListener('beforeunload', function (ev) {
    if (state.result || state.submitting) return undefined;
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

  function renderTimer() {
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
    submit();
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
    var savedMinutes = storeGet(TIMER_PREF_KEY);
    if (savedMinutes && /^(0|30|60|90)$/.test(savedMinutes)) elTimerSelect.value = savedMinutes;
    elTimerSelect.addEventListener('change', function () {
      storeSet(TIMER_PREF_KEY, String(Number(elTimerSelect.value) || 0));
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
    card.appendChild(box);
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
   * 유형 필터(전체/코드/SQL/이론). study.html 에는 자리가 없으므로 헤더의 메타 줄 뒤에 만들어 붙인다.
   * 누르면 지금 출처(회차·오답노트·모의고사)를 그대로 유지한 채 `type=` 만 바꿔 다시 로드한다.
   * 채점 후에는 전부 비활성 — "다시 풀기" 로 state.result 가 지워지면 다시 활성이 된다.
   */
  var elTypeFilter = null;
  var elBattleSub = null;
  var hasSource = false;

  /**
   * 대전 오답 보기(?set=wrong&match=)의 부제 한 줄. study.html 에는 자리가 없으므로
   * 메타 줄 바로 아래(유형 필터 위)에 만들어 붙인다.
   */
  function ensureBattleSubNode() {
    if (elBattleSub) return elBattleSub;
    if (!elMeta || !elMeta.parentNode) return null;
    elBattleSub = el('p', 'study-sub');
    elBattleSub.id = 'battleSub';
    elMeta.parentNode.insertBefore(elBattleSub, elTypeFilter || elMeta.nextSibling);
    return elBattleSub;
  }

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
    var b = state.battle;
    if (!b) {
      if (elBattleSub) {
        elBattleSub.textContent = '';
        elBattleSub.hidden = true;
      }
      return;
    }
    var node = ensureBattleSubNode();
    if (!node) return;
    node.textContent = '대전 “' + (b.roomName || '이름 없는 방') + '” · ' + battleSubText(b);
    node.hidden = false;
  }

  function ensureTypeFilterNode() {
    if (elTypeFilter) return elTypeFilter;
    if (!elMeta || !elMeta.parentNode) return null;
    elTypeFilter = el('div', 'type-filter');
    elTypeFilter.id = 'typeFilter';
    var after = elBattleSub || elMeta;   // 부제가 있으면 그 아래로
    elMeta.parentNode.insertBefore(elTypeFilter, after.nextSibling);
    return elTypeFilter;
  }

  /** 지금 출처를 그대로 두고 type 만 바꾼 학습 URL. 오답노트의 회차·대전 한정도 그대로 이어간다. */
  function studyUrlForType(type) {
    var tail = type ? '&type=' + encodeURIComponent(type) : '';
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
    if (!hasSource) return;
    var node = ensureTypeFilterNode();
    if (!node) return;
    node.textContent = '';
    node.hidden = false;

    var graded = !!state.result;
    node.appendChild(el('span', 'type-filter-label', '유형'));

    var options = [{ value: '', label: '전체' }];
    TYPE_ORDER.forEach(function (t) { options.push({ value: t, label: TYPE_LABEL[t] }); });

    options.forEach(function (opt) {
      var on = state.typeFilter === opt.value;
      var empty = typeIsEmpty(opt.value);
      var btn = el('button', 'chip' + (on ? ' on' : '') + (empty ? ' empty' : ''), opt.label);
      btn.type = 'button';
      btn.setAttribute('data-type', opt.value || 'all');
      // 이 회차에 없는 유형은 눌러 봐야 서버 400 이다 — 누르기 전에 막는다.
      btn.disabled = graded || empty;
      if (empty) btn.title = '이 회차에는 ' + opt.label + ' 문항이 없습니다.';
      btn.addEventListener('click', function () {
        if (on || state.result) return;    // 지금 보고 있는 유형이면 아무것도 하지 않는다
        window.location.href = studyUrlForType(opt.value);
      });
      node.appendChild(btn);
    });
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
      if (!found || !found.counts || typeof found.counts !== 'object') return;
      state.roundCounts = found.counts;
      renderTypeFilter();
    }).catch(function () { /* 부가 정보다 — 없으면 없는 대로 */ });
  }

  // ---------------------------------------------------------------- 렌더

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

  function renderQuestion(question) {
    var detail = detailFor(question.id);
    var graded = !!detail;

    var card = el('div', 'q');
    if (graded) card.classList.add(detail.correct ? 'correct' : 'wrong');
    card.setAttribute('data-q', question.id);

    // 우상단 뱃지 줄 — 유형(있을 때만) + 출처 회차. 회차 뱃지는 모든 모드에서 항상 표시한다.
    var badges = el('div', 'q-badges');
    var qType = normalizeType(question.type);
    if (qType) badges.appendChild(el('span', 'q-type ' + qType, TYPE_LABEL[qType]));
    badges.appendChild(el('span', 'q-origin', questionOrigin(question.id)));
    // 대전 오답 보기에서 "그때는 틀렸지만 지금은 오답이 아닌" 문항 (서버 resolvedIds).
    if (state.resolvedIds[question.id]) badges.appendChild(el('span', 'q-resolved', '이후 맞힘'));
    card.appendChild(badges);

    // 제목: 번호 + prompt(HTML 자산이므로 HTML 로 삽입)
    var title = el('div', 'qtitle');
    title.appendChild(el('span', 'num', String(question.num == null ? '' : question.num)));
    var promptSpan = document.createElement('span');
    promptSpan.innerHTML = question.prompt || '';
    title.appendChild(promptSpan);
    card.appendChild(title);

    // 지문(HTML)
    if (question.bodyHtml) {
      var body = el('div', 'qbody');
      body.innerHTML = question.bodyHtml;
      wrapTables(body);
      card.appendChild(body);
    }

    // 답안 입력
    var stored = state.answers[question.id] || [];
    (question.fields || []).forEach(function (field, index) {
      var row = el('div', 'ansrow');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'ans';
      input.id = 'ans-' + question.id + '-' + index;
      input.autocomplete = 'off';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.value = stored[index] == null ? '' : stored[index];

      var label = el('label', null, fieldLabel(field.label, index));
      label.htmlFor = input.id;
      row.appendChild(label);

      if (graded) {
        input.readOnly = true;
        var fr = (detail.fieldResults || [])[index];
        input.classList.add(fr && fr.correct ? 'ok' : 'bad');
      } else {
        input.addEventListener('input', function () {
          if (!state.answers[question.id]) {
            state.answers[question.id] = (question.fields || []).map(function () { return ''; });
          }
          state.answers[question.id][index] = input.value;
          scheduleSave();
        });
        input.addEventListener('keydown', onAnswerKeydown);
      }
      row.appendChild(input);
      card.appendChild(row);
    });

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

  function renderBoard() {
    if (!state.result) {
      elBoard.classList.remove('shown');
      return;
    }
    var r = state.result;
    elBoard.querySelector('.score').textContent = r.score + '점 / 100점';
    var passEl = elBoard.querySelector('.pass');
    var tail = ' (' + r.correctCount + '/' + r.totalCount + ' 문제 정답)';
    if (r.score >= PASS_SCORE) {
      passEl.textContent = '🎉 합격권입니다!' + tail;
      passEl.className = 'pass ok';
    } else {
      passEl.textContent = '아쉽습니다. ' + PASS_SCORE + '점 이상이 합격입니다.' + tail;
      passEl.className = 'pass no';
    }
    elBoard.classList.add('shown');
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
    return head + ' · 100점 만점 ('
      + PASS_SCORE + '점 이상 합격) — 답을 입력하고 맨 아래 제출 버튼을 누르세요'
      + (state.typeFilter ? ' · ' + TYPE_LABEL[state.typeFilter] + ' 유형만' : '');
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
    var round = state.round;
    if (!round) return;

    elTitle.textContent = round.title || round.round;
    elMeta.textContent = metaText();
    renderBattleSub();
    renderTypeFilter();

    elQuestions.textContent = '';
    if (round.questions.length === 0) {
      elQuestions.appendChild(el('p', 'muted', '이 회차에는 등록된 문항이 없습니다.'));
      elBtnbar.hidden = true;
      return;
    }
    round.questions.forEach(function (q) {
      elQuestions.appendChild(renderQuestion(q));
    });

    elBtnbar.hidden = false;
    var graded = !!state.result;
    elSubmit.hidden = graded;
    elReset.hidden = !graded;
    elSubmit.disabled = state.submitting;
    elSubmit.textContent = state.submitting ? '채점하는 중...' : '제출하고 채점하기';
    if (elTools) elTools.hidden = graded;

    renderBoard();
    renderTimer();

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
      return api.post('/api/rounds/' + encodeURIComponent(state.roundId) + '/grade', body);
    }
    // practice/wrong 세트는 이미 필터된 문항만 들고 있으므로 경로를 바꾸지 않는다.
    return api.post('/api/practice/grade', { setKey: state.setKey, answers: answers });
  }

  function submit() {
    if (state.submitting || state.result || !state.round) return;
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
        toast(e.message, 'bad');
      });
  }

  function reset() {
    state.result = null;
    state.answers = {};
    state.showExplain = {};
    state.reportOpen = {};
    state.reportText = {};
    state.reportStatus = {};
    stopTimer();
    clearSaved();
    hideRestoreNotice();
    render();
    scrollTop();
  }

  elSubmit.addEventListener('click', submit);
  elReset.addEventListener('click', reset);

  // ------------------------------------------------------------------ 시작

  function fail(message, extraLink, linkText) {
    elTitle.textContent = '학습 모드';
    elMeta.textContent = '';
    // 유형 필터로 문항이 0개면 서버가 400 을 준다 — 문구는 그대로 띄우되 필터는 남겨 둔다
    // (다른 유형이나 '전체' 로 곧바로 되돌아갈 수 있어야 한다).
    renderTypeFilter();
    elQuestions.textContent = '';
    elQuestions.appendChild(el('p', 'error-text', message));
    var back = el('p', 'hint');
    var a = document.createElement('a');
    a.href = extraLink || '/';
    a.textContent = linkText || '회차 목록으로 돌아가기';
    back.appendChild(a);
    elQuestions.appendChild(back);
    elBtnbar.hidden = true;
    if (elTools) elTools.hidden = true;
  }

  /**
   * 쿼리스트링 → 어떤 문항 묶음을 어디서 가져올지.
   * `?type=code|sql|theory` 는 세 출처 모두에 그대로 얹는다 (알 수 없는 값이면 무시 = 전체).
   */
  function parseSource() {
    var type = normalizeType(queryParam('type'));
    var typeQ = type ? '&type=' + encodeURIComponent(type) : '';
    var set = queryParam('set');
    if (set === 'wrong') {
      // 허브에서 넘어오는 한정자. 둘 다 오면 match 가 이긴다 (더 좁은 보기다).
      var wrongMatch = queryParam('match');
      var wrongRound = wrongMatch ? '' : queryParam('round');
      var parts = [];
      if (wrongMatch) parts.push('match=' + encodeURIComponent(wrongMatch));
      else if (wrongRound) parts.push('round=' + encodeURIComponent(wrongRound));
      if (type) parts.push('type=' + encodeURIComponent(type));
      return {
        mode: 'wrong',
        setKey: 'wrong',
        type: type,
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
        practiceRounds: roundsParam,
        practiceCount: count,
        url: '/api/practice?rounds=' + encodeURIComponent(roundsParam)
          + '&count=' + encodeURIComponent(count) + typeQ,
      };
    }
    var round = queryParam('round');
    if (round) {
      return {
        mode: 'round',
        setKey: round,
        roundId: round,
        type: type,
        url: '/api/rounds/' + encodeURIComponent(round)
          + (type ? '?type=' + encodeURIComponent(type) : ''),
      };
    }
    return null;
  }

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
    if (source.practiceRounds) state.practiceRounds = source.practiceRounds;
    if (source.practiceCount) state.practiceCount = source.practiceCount;
    hasSource = true;
    renderTypeFilter();
    loadRoundCounts();

    api.get(source.url)
      .then(function (data) {
        state.round = {
          round: state.setKey,
          title: data.title || data.round || state.setKey,
          sourceUrl: data.sourceUrl || '',
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
          fail('로그인이 필요합니다. 오답노트는 로그인한 사용자의 채점 기록으로 만들어집니다.');
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

  api.me().then(renderNav).catch(function () { renderNav(null); });
})();
