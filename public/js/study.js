/**
 * study.js — 학습 모드.
 *
 * 세 가지 출처(source)를 같은 화면으로 그린다. 쿼리스트링이 출처를 고른다.
 *   ?round=2026-2                       → GET  /api/rounds/:id        → POST /api/rounds/:id/grade
 *   ?set=practice&rounds=all&count=20   → GET  /api/practice?…        → POST /api/practice/grade
 *   ?set=wrong                          → GET  /api/me/wrong (로그인) → POST /api/practice/grade
 * 어느 출처든 state.round = {round:<setKey>, title, questions[]} 하나로 정규화한다.
 *
 * 렌더는 항상 `state` 로부터 전체를 다시 그린다 (부분 DOM 패치 없음).
 * 입력값은 `state.answers` 에 즉시 반영되므로 재렌더해도 사용자가 친 값이 살아남는다.
 *
 * 정답은 채점 응답에만 들어 있다 (`details[].display`). 문항 로드 응답에는 없다.
 *
 * 자동 저장: localStorage['jpk-study:<setKey>'] = {answers, savedAt}.
 * 회차/오답노트만 저장한다 — 랜덤 모의고사는 문항 집합이 매번 달라 복원이 무의미하다.
 */
(function () {
  'use strict';

  var PASS_SCORE = 60;
  var STORE_PREFIX = 'jpk-study:';
  var TIMER_PREF_KEY = 'jpk-study:timer';
  var SAVE_DEBOUNCE_MS = 300;
  var REPORT_DONE = '접수되었습니다. 고맙습니다!';

  var state = {
    mode: 'round',    // 'round' | 'practice' | 'wrong'
    setKey: '',       // 저장 키이자 채점 응답의 round 값
    roundId: '',      // mode==='round' 일 때만 의미 있다
    round: null,      // {round,title,sourceUrl,questions[]}
    answers: {},      // qid -> [string]
    result: null,     // {correctCount,totalCount,score,details[],bodyTexts{}}
    submitting: false,
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

  /** 저장 키. 랜덤 모의고사는 매번 문항이 달라 저장하지 않는다 → null. */
  function saveKey() {
    if (state.mode === 'practice') return null;
    if (!state.setKey) return null;
    return STORE_PREFIX + state.setKey;
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

    // 출처 회차 뱃지 — 우상단, 모든 모드(회차/모의고사/오답노트)에서 항상 표시
    card.appendChild(el('span', 'q-origin', questionOrigin(question.id)));

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

      if (!detail.correct) {
        var actions = el('div', 'q-actions');

        var askBtn = el('button', null, 'AI에게 질문하기');
        askBtn.type = 'button';
        askBtn.addEventListener('click', function () { onAskAi(question, detail); });
        actions.appendChild(askBtn);

        renderReport(question, detail, actions, card);
        card.insertBefore(actions, card.querySelector('.report-box'));
      }
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
    return '총 ' + state.round.questions.length + '문항 · 100점 만점 ('
      + PASS_SCORE + '점 이상 합격) — 답을 입력하고 맨 아래 제출 버튼을 누르세요';
  }

  /** 오답노트가 비었을 때 — 실패가 아니므로 fail() 이 아니라 축하하는 빈 화면을 준다. */
  function renderEmptyWrong() {
    elTitle.textContent = '오답노트';
    elMeta.textContent = '지금은 다시 풀 오답이 없습니다.';
    elQuestions.textContent = '';
    var box = el('div', 'card empty-state');
    box.appendChild(el('p', null, '🎉 틀린 문항이 없습니다.'));
    box.appendChild(el('p', 'hint',
      '회차를 풀고 채점하면 틀린 문항이 여기에 모입니다. 나중에 맞히면 자동으로 빠집니다.'));
    var back = el('p', 'hint');
    var a = document.createElement('a');
    a.href = '/';
    a.textContent = '회차 목록으로 돌아가기';
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
      return api.post('/api/rounds/' + encodeURIComponent(state.roundId) + '/grade', { answers: answers });
    }
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

  function fail(message, extraLink) {
    elTitle.textContent = '학습 모드';
    elMeta.textContent = '';
    elQuestions.textContent = '';
    elQuestions.appendChild(el('p', 'error-text', message));
    var back = el('p', 'hint');
    var a = document.createElement('a');
    a.href = extraLink || '/';
    a.textContent = '회차 목록으로 돌아가기';
    back.appendChild(a);
    elQuestions.appendChild(back);
    elBtnbar.hidden = true;
    if (elTools) elTools.hidden = true;
  }

  /** 쿼리스트링 → 어떤 문항 묶음을 어디서 가져올지. */
  function parseSource() {
    var set = queryParam('set');
    if (set === 'wrong') {
      return { mode: 'wrong', setKey: 'wrong', url: '/api/me/wrong' };
    }
    if (set === 'practice') {
      var roundsParam = queryParam('rounds') || 'all';
      var count = queryParam('count') || '20';
      return {
        mode: 'practice',
        setKey: 'practice',
        url: '/api/practice?rounds=' + encodeURIComponent(roundsParam)
          + '&count=' + encodeURIComponent(count),
      };
    }
    var round = queryParam('round');
    if (round) {
      return {
        mode: 'round',
        setKey: round,
        roundId: round,
        url: '/api/rounds/' + encodeURIComponent(round),
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

    api.get(source.url)
      .then(function (data) {
        state.round = {
          round: state.setKey,
          title: data.title || data.round || state.setKey,
          sourceUrl: data.sourceUrl || '',
          questions: data.questions || [],
        };
        document.title = state.round.title + ' 학습 — 정처기 배틀';

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
        fail(e.message);
      });
  }

  api.me().then(renderNav).catch(function () { renderNav(null); });
})();
