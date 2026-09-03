/**
 * index.js — 메인 화면 (public/index.html).
 *
 * 예전에는 index.html 안의 811줄짜리 인라인 `<script>` 였다. 인라인이라 브라우저 캐시를 타지 못하고
 * 다른 화면과 겹치는 도구들(el·countsText·유형 표 …)이 이 파일에만 또 한 벌 있었다.
 * 지금은 공용 모듈(`js/shared/*.js`, 전역 `window.JPK`)을 쓰고 이 파일에는 메인 고유 로직만 둔다.
 *
 * 그리는 것은 넷이다.
 *   내 학습   GET /api/me/history   (로그인일 때만. 구버전 서버면 조용히 생략)
 *   회차 선택 GET /api/rounds       (+ 유형·언어 칩)
 *   랜덤 모의고사                    (연도 체크박스 → /study.html?set=practice&…)
 *   계정      api.me / login / signup / logout
 *
 * 의존 (전역): window.api, window.Fmt, JPK.dom, JPK.qmeta, JPK.motion, JPK.nav
 */
(function () {
  'use strict';

  var el = JPK.dom.el;
  var pad2 = JPK.dom.pad2;
  var TYPE_ORDER = JPK.qmeta.TYPE_ORDER;
  var TYPE_LABEL = JPK.qmeta.TYPE_LABEL;
  var LANGS = JPK.qmeta.LANGS;
  var LANG_LABEL = JPK.qmeta.LANG_LABEL;
  var countsText = JPK.qmeta.countsText;
  var langsText = JPK.qmeta.langsText;

  var sessionBox = document.getElementById('sessionBox');
  var roundList = document.getElementById('roundList');
  var roundTypeFilter = document.getElementById('roundTypeFilter');
  var roundLangFilter = document.getElementById('roundLangFilter');
  var heroStart = document.getElementById('heroStart');
  var msgBanner = document.getElementById('msgBanner');
  var studySection = document.getElementById('studySection');
  var studyBox = document.getElementById('studyBox');
  var practiceBox = document.getElementById('practiceBox');

  var roundType = '';   // 회차 목록 위 유형 칩에서 고른 값 ('' = 전체)
  var practiceType = ''; // 랜덤 모의고사 유형 선택
  var roundLang = '';    // 회차 목록 위 언어 칩에서 고른 값 ('' = 전체 언어)
  var practiceLang = ''; // 랜덤 모의고사 언어 선택

  // 회차 목록과 학습 이력은 따로 도착한다. 둘 다 여기에 모아 두고,
  // 어느 쪽이 늦게 오든 그때마다 화면을 다시 그린다.
  var roundsData = null;   // /api/rounds 응답
  var historyData = null;  // /api/me/history 응답 (비로그인·구버전 서버면 계속 null)
  var currentUser = null;

  /** 서버 오류 문구는 조작 없이 나타난다 — 보조 기술이 놓치지 않도록 role="alert". */
  function errorBox() {
    var box = el('div', 'error-text');
    box.setAttribute('role', 'alert');
    return box;
  }

  // ------------------------------------------------------------- 문항 유형

  /** 회차 하나라도 counts 를 들고 있으면 유형 UI 를 켠다 (구버전 서버면 조용히 생략). */
  function hasCounts(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var c = list[i].counts;
      if (c && typeof c === 'object') return true;
    }
    return false;
  }

  /** 회차 하나라도 langs 를 들고 있으면 언어 UI 를 켠다 (구버전 서버면 조용히 생략). */
  function hasLangs(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var L = list[i].langs;
      if (L && typeof L === 'object') return true;
    }
    return false;
  }

  /** 전 회차를 합한 언어별 코드 문항 수 — 0개인 언어 칩을 비활성화하는 데 쓴다. */
  function langTotals(list) {
    var out = { c: 0, java: 0, python: 0 };
    (list || []).forEach(function (r) {
      var L = r && r.langs;
      if (!L || typeof L !== 'object') return;
      LANGS.forEach(function (l) { out[l] += Number(L[l]) || 0; });
    });
    return out;
  }

  /** 전체 언어/C/Java/Python <select>. typeSelect 와 같은 모양이다. */
  function langSelect(id, current, onPick) {
    var sel = document.createElement('select');
    if (id) sel.id = id;
    sel.className = 'type-select';
    [{ v: '', label: '전체 언어' }].concat(LANGS.map(function (l) {
      return { v: l, label: LANG_LABEL[l] };
    })).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = current || '';
    sel.addEventListener('change', function () { onPick(sel.value); });
    return sel;
  }

  /** 전체/코드/SQL/이론 <select>. 고른 값을 onPick 으로 돌려준다. */
  function typeSelect(id, current, onPick) {
    var sel = document.createElement('select');
    if (id) sel.id = id;
    sel.className = 'type-select';
    [{ v: '', label: '전체 유형' }].concat(TYPE_ORDER.map(function (t) {
      return { v: t, label: TYPE_LABEL[t] };
    })).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = current || '';
    sel.addEventListener('change', function () { onPick(sel.value); });
    return sel;
  }

  /** 링크 뒤에 붙일 `&type=…` (전체면 빈 문자열). */
  function typeTail(type) {
    return type ? '&type=' + encodeURIComponent(type) : '';
  }

  /** 링크 뒤에 붙일 언어 한정. 코드 유형이 아니면 언어는 의미가 없으므로 빈 문자열. */
  function langTail(type, lang) {
    return type === 'code' && lang ? '&lang=' + encodeURIComponent(lang) : '';
  }

  /** 회차 목록 위 유형 칩. counts 가 없으면 통째로 숨긴다. */
  function renderRoundTypeFilter() {
    if (!roundTypeFilter) return;
    roundTypeFilter.textContent = '';
    if (!hasCounts(roundsData)) {
      roundTypeFilter.hidden = true;
      return;
    }
    roundTypeFilter.hidden = false;
    roundTypeFilter.appendChild(el('span', 'type-filter-label', '유형'));
    [{ v: '', label: '전체' }].concat(TYPE_ORDER.map(function (t) {
      return { v: t, label: TYPE_LABEL[t] };
    })).forEach(function (o) {
      var on = roundType === o.v;
      var btn = el('button', 'chip' + (on ? ' on' : ''), o.label);
      btn.type = 'button';
      btn.setAttribute('data-type', o.v || 'all');
      // 칩은 켜고 끄는 토글이다 — 눌린 상태를 보조 기술에도 알린다.
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', function () {
        roundType = o.v;
        // 코드가 아닌 유형으로 옮기면 언어 한정은 의미가 없다 — 조용히 푼다.
        if (roundType !== 'code') roundLang = '';
        renderRoundTypeFilter();
        renderRounds();
      });
      roundTypeFilter.appendChild(btn);
    });
    renderRoundLangFilter();
  }

  /**
   * 회차 목록 위 언어 칩. 유형이 "코드" 이고 서버가 langs 를 줄 때만 한 줄 더 보인다.
   * 전 회차를 합해 0개인 언어는 유형 칩과 같은 방식(.empty + disabled)으로 막는다.
   */
  function renderRoundLangFilter() {
    if (!roundLangFilter) return;
    roundLangFilter.textContent = '';
    if (roundType !== 'code' || !hasLangs(roundsData)) {
      roundLangFilter.hidden = true;
      return;
    }
    roundLangFilter.hidden = false;
    roundLangFilter.appendChild(el('span', 'type-filter-label', '언어'));
    var totals = langTotals(roundsData);
    [{ v: '', label: '전체' }].concat(LANGS.map(function (l) {
      return { v: l, label: LANG_LABEL[l] };
    })).forEach(function (o) {
      var empty = !!o.v && Number(totals[o.v]) === 0;
      var on = roundLang === o.v;
      var btn = el('button', 'chip' + (on ? ' on' : '') + (empty ? ' empty' : ''), o.label);
      btn.type = 'button';
      btn.setAttribute('data-lang', o.v || 'all');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.disabled = empty;
      if (o.v) {
        btn.title = empty
          ? LANG_LABEL[o.v] + ' 코드 문항이 없습니다.'
          : LANG_LABEL[o.v] + ' 코드 문항 ' + totals[o.v] + '개';
      }
      btn.addEventListener('click', function () {
        roundLang = o.v;
        renderRoundLangFilter();
        renderRounds();
      });
      roundLangFilter.appendChild(btn);
    });
  }

  // ------------------------------------------------------------ ?msg= 안내
  // battle.js/ranking.js 는 로그인이 필요한 화면에서 /?msg=<encoded> 로 돌려보낸다.
  // 히어로 바로 아래 배너로 한 번만 그린다 — 세션 박스와 달리 다시 그려지지 않는다.
  // 새로고침해도 다시 뜨지 않도록 쿼리는 즉시 지운다.
  var redirectMsg = null;
  (function readRedirectMessage() {
    var params = new URLSearchParams(window.location.search);
    var msg = params.get('msg');
    if (!msg) return;
    redirectMsg = msg;
    msgBanner.textContent = msg;
    msgBanner.hidden = false;
    var url = new URL(window.location.href);
    url.searchParams.delete('msg');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  })();

  /**
   * `?next=` — 로그인한 뒤 되돌아갈 곳. 학습 화면이 "채점하려면 로그인이 필요합니다" 로
   * 사람을 여기까지 보낼 때 자기 주소를 실어 보낸다.
   *
   * **같은 사이트 안의 경로만** 받는다. 남이 만든 주소로 로그인 직후 튕겨 보낼 수 있으면
   * (오픈 리다이렉트) 피싱에 쓰인다. `/` 로 시작하고 `//` · `/\` 로 시작하지 않는 것만 통과시킨다.
   * `msg=` 와 달리 주소에서 지우지 않는다 — 사람이 새로고침해도 돌아갈 곳을 잃지 않아야 한다.
   */
  function safeNext(value) {
    var v = typeof value === 'string' ? value.trim() : '';
    if (!v) return '';
    if (v.charAt(0) !== '/') return '';               // 절대 URL·스킴·상대 경로 전부 거절
    if (v.charAt(1) === '/' || v.charAt(1) === '\\') return ''; // "//evil.example" = 스킴 상대 URL
    return v;
  }

  var nextUrl = safeNext(new URLSearchParams(window.location.search).get('next'));

  // 계정 섹션이 맨 아래라, 로그인이 필요해 되돌아온 사람은 거기까지 데려다 준다.
  // 세션 박스와 회차 목록은 따로 도착한다. 회차 목록이 오기 전의 페이지는 화면 한 장보다
  // 짧아서 그 시점에 스크롤해 봐야 0 근처로 잘린다 — 둘 다 그려진 뒤에 한 번만 움직인다.
  var pendingAccountScroll = !!redirectMsg;
  var sessionRendered = false;
  var roundsRendered = false;
  function maybeScrollToAccount() {
    if (!pendingAccountScroll || !sessionRendered || !roundsRendered) return;
    pendingAccountScroll = false;
    var raf = window.requestAnimationFrame || function (fn) { return window.setTimeout(fn, 16); };
    raf(function () {
      // 폼까지 데려다 준 김에 바로 칠 수 있게 — 스크롤 위치는 그 다음 줄이 정한다.
      var nick = document.getElementById('nickname');
      if (nick) nick.focus();
      var target = document.getElementById('account');
      // jsdom·구형 브라우저에는 없다 — 없으면 그냥 안 움직인다.
      if (!target || typeof target.scrollIntoView !== 'function') return;
      // 모션 축소를 켠 사람에게는 부드러운 스크롤 대신 즉시 이동한다.
      try {
        target.scrollIntoView({ behavior: JPK.motion.smoothScrollBehavior(), block: 'start' });
      } catch (e) { /* 무시 */ }
    });
  }

  /** 계정 섹션으로 내려가는 링크. 눌리면 닉네임 칸에 포커스까지 준다. */
  function accountLink(text) {
    var a = el('a', null, text);
    a.href = '#account';
    a.addEventListener('click', function () {
      var nick = document.getElementById('nickname');
      if (nick) nick.focus();
    });
    return a;
  }

  function clearSessionBox() {
    sessionBox.textContent = '';
  }

  // ---------------------------------------------------------------- 세션

  function renderNav(user) {
    // 정적 내비다 — 공용 모듈은 닉네임·로그아웃·로그인 세 조각만 갈아끼운다.
    JPK.nav.render(user, {
      current: 'study',
      onLogout: function () { renderSession(null); },
      onError: function () { /* 내비 로그아웃 실패는 계정 상자 쪽에서 다시 시도할 수 있다 */ },
    });
  }

  function renderLoggedIn(user) {
    clearSessionBox();
    var row = el('div', 'form-row');
    var msg = el('div');
    msg.appendChild(el('b', null, user.nickname));
    msg.appendChild(document.createTextNode(' 님으로 로그인 중입니다. 대전과 랭킹을 이용할 수 있습니다.'));
    row.appendChild(msg);
    sessionBox.appendChild(row);

    var actions = el('div', 'form-actions');
    var out = el('button', 'alt', '로그아웃');
    out.type = 'button';
    actions.appendChild(out);
    sessionBox.appendChild(actions);

    var errBox = errorBox();
    sessionBox.appendChild(errBox);

    out.addEventListener('click', function () {
      out.disabled = true;
      errBox.textContent = '';
      api.logout().then(function () {
        renderSession(null);
      }).catch(function (e) {
        out.disabled = false;
        errBox.textContent = e.message;
      });
    });
  }

  function renderLoggedOut() {
    clearSessionBox();

    // 진짜 <form> 이다 — 어느 칸에서든 Enter 를 치면 로그인된다.
    var form = document.createElement('form');
    form.id = 'authForm';
    form.autocomplete = 'on';

    var nickRow = el('div', 'form-row');
    var nickLabel = el('label', null, '닉네임');
    nickLabel.htmlFor = 'nickname';
    var nick = document.createElement('input');
    nick.id = 'nickname';
    nick.name = 'nickname';
    nick.type = 'text';
    nick.maxLength = 12;
    nick.placeholder = '2~12자';
    nick.autocomplete = 'username';
    nickRow.appendChild(nickLabel);
    nickRow.appendChild(nick);

    var pwRow = el('div', 'form-row');
    var pwLabel = el('label', null, '비밀번호');
    pwLabel.htmlFor = 'password';
    var pw = document.createElement('input');
    pw.id = 'password';
    pw.name = 'password';
    pw.type = 'password';
    pw.placeholder = '4자 이상';
    pw.autocomplete = 'current-password';
    pwRow.appendChild(pwLabel);
    pwRow.appendChild(pw);

    var actions = el('div', 'form-actions');
    var loginBtn = el('button', null, '로그인');
    loginBtn.type = 'submit';
    var signupBtn = el('button', 'alt', '가입');
    signupBtn.type = 'button';
    actions.appendChild(loginBtn);
    actions.appendChild(signupBtn);

    // 로그인 실패 사유는 포커스만 옮겨서는 읽히지 않는다 — role="alert" 로 문구까지 발화시킨다.
    var errBox = errorBox();
    var hint = el('div', 'hint', '학습 모드는 로그인 없이도 쓸 수 있습니다. 대전과 랭킹에는 로그인이 필요합니다.');
    // 비밀번호 재설정 수단이 없다 — 가입 화면에서 미리 알려 준다.
    hint.appendChild(el('div', null, '비밀번호는 복구할 수 없습니다 — 잊지 않을 값으로 정하세요.'));

    // 데스크톱에서는 한 줄(닉네임·비밀번호·로그인·가입), 모바일에서는 세로로 풀린다.
    var line = el('div', 'auth-line');
    line.appendChild(nickRow);
    line.appendChild(pwRow);
    line.appendChild(actions);

    form.appendChild(line);
    form.appendChild(errBox);
    form.appendChild(hint);
    sessionBox.appendChild(form);

    function submit(fn) {
      errBox.textContent = '';
      loginBtn.disabled = true;
      signupBtn.disabled = true;
      fn(nick.value, pw.value).then(function (user) {
        // 채점하려다 로그인하러 온 사람은 풀던 화면으로 돌려보낸다 (답안은 자동 저장돼 있다).
        if (nextUrl) {
          window.location.href = nextUrl;
          return;
        }
        renderSession(user);
      }).catch(function (e) {
        // 서버 문구를 그대로 보여 준다
        errBox.textContent = e.message;
        loginBtn.disabled = false;
        signupBtn.disabled = false;
        pw.focus();
      });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      submit(api.login);
    });
    signupBtn.addEventListener('click', function () {
      submit(api.signup);
    });
    // 계정 섹션이 맨 아래로 내려갔다 — 그냥 들어온 사람까지 포커스로 끌어내리면
    // 첫 화면이 계정 폼이 된다. ?msg= 로 되돌아온 경우의 포커스는 maybeScrollToAccount 가 준다.
  }

  function renderSession(user) {
    currentUser = user || null;
    renderNav(user);
    if (user) renderLoggedIn(user);
    else renderLoggedOut();
    sessionRendered = true;
    maybeScrollToAccount();
    loadHistory();
  }

  // ------------------------------------------------------------- 학습 이력

  /**
   * 로그인 상태에서만 조회한다. 404(구버전 서버)·오류는 조용히 넘긴다 —
   * 학습 이력은 부가 기능이고, 회차 목록은 이것 없이도 완전히 동작해야 한다.
   */
  function loadHistory() {
    if (!currentUser) {
      historyData = null;
      renderStudyBox();
      renderRounds();
      return;
    }
    api.get('/api/me/history').then(function (data) {
      historyData = data && typeof data === 'object' ? data : null;
      renderStudyBox();
      renderRounds();
    }).catch(function () {
      historyData = null;
      renderStudyBox();
      renderRounds();
    });
  }

  /** setKey → 사람이 읽는 이름. 회차 id 는 /api/rounds 의 title 로 바꾼다. */
  function setKeyLabel(setKey) {
    if (setKey === 'practice') return '랜덤 모의고사';
    if (setKey === 'wrong') return '오답노트';
    if (setKey === 'battle') return '대전';
    var list = roundsData || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].round === setKey) return list[i].title || list[i].round;
    }
    return setKey;
  }

  /**
   * 최근 목록 한 줄의 이름. 대전 기록은 방 이름까지 붙여 "대전 · 저녁 한 판" 으로 보여 준다
   * (roomName 이 없는 옛 기록은 그냥 "대전").
   */
  function historyLabel(r) {
    var base = setKeyLabel(r.round);
    if (r.round === 'battle' && r.roomName) return base + ' · ' + r.roomName;
    return base;
  }

  function formatDate(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatDateTime(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return formatDate(value) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /**
   * 최근 기록의 날짜 — "오늘 14:00 / 어제 14:00 / 3일 전 / 2026-08-25".
   * fmt.js 가 없는 옛 캐시에서도 화면이 비지 않게 절대 날짜로 되돌아간다.
   */
  function historyDate(li, value) {
    var span = el('span', 'h-date', '');
    var rel = window.Fmt ? window.Fmt.relativeDate(value) : '';
    span.textContent = rel || formatDate(value);
    // 상대 표기는 대략적이다 — 정확한 시각은 title 로 남긴다.
    var abs = window.Fmt ? window.Fmt.dateTime(value) : formatDateTime(value);
    if (abs) span.title = abs;
    li.appendChild(span);
  }

  function renderStudyBox() {
    studyBox.textContent = '';

    if (!currentUser) {
      // 비로그인은 보여 줄 이력이 없다 — 카드 대신 한 줄로 자리만 잡는다.
      studySection.hidden = false;
      studyBox.hidden = false;
      var out = el('div', 'study-line');
      out.appendChild(document.createTextNode('로그인하면 점수 이력과 오답노트가 저장됩니다.'));
      out.appendChild(accountLink('로그인'));
      studyBox.appendChild(out);
      return;
    }
    if (!historyData) {
      // 서버가 아직 이 API 를 모른다 — 없는 것처럼 군다
      studySection.hidden = true;
      studyBox.hidden = true;
      return;
    }

    studySection.hidden = false;
    studyBox.hidden = false;
    var card = el('div', 'card');

    var recent = (historyData.recent || []).slice(0, 5);
    if (recent.length === 0) {
      card.appendChild(el('p', 'hint', '아직 채점 기록이 없습니다. 아래에서 회차를 골라 풀어 보세요.'));
    } else {
      var list = el('ul', 'history-list');
      recent.forEach(function (r) {
        var li = document.createElement('li');
        li.appendChild(el('span', 'h-name', historyLabel(r)));
        li.appendChild(el('span', 'h-score', r.score + '점'));
        // correct/total 은 컬럼이 생기기 전 기록에서 null 이다 — 둘 다 숫자일 때만 붙인다.
        if (typeof r.correct === 'number' && typeof r.total === 'number' && r.total > 0) {
          li.appendChild(el('span', 'h-detail', r.correct + '/' + r.total));
        }
        historyDate(li, r.takenAt);
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    var wrongCount = Number(historyData.wrongCount) || 0;
    var actions = el('div', 'form-actions');
    if (wrongCount > 0) {
      // 허브(wrong.html)로 보낸다 — 유형 선택·회차별·대전별 보기가 전부 그쪽에 있다.
      var link = el('a', 'btn-link', '오답노트 (' + wrongCount + '문항)');
      link.href = '/wrong.html';
      actions.appendChild(link);
    } else {
      actions.appendChild(el('span', 'btn-link disabled', '오답노트 (0문항)'));
    }
    card.appendChild(actions);
    if (wrongCount === 0) {
      card.appendChild(el('p', 'hint', '틀린 문항이 쌓이면 오답노트가 만들어집니다. 나중에 맞히면 자동으로 빠집니다.'));
    }

    studyBox.appendChild(card);
  }

  // ---------------------------------------------------------------- 회차

  /** "2026-2" → "2026". 형식이 다르면 "기타" 로 모은다. */
  function yearOf(roundId) {
    var m = /^(\d{4})-/.exec(String(roundId));
    return m ? m[1] : '기타';
  }

  /** 회차 목록을 연도별로 묶는다. 두 화면(회차 버튼·랜덤 모의고사)이 같은 묶음을 쓴다. */
  function groupByYear(list) {
    var groups = {};
    var order = [];
    (list || []).forEach(function (r) {
      var y = yearOf(r.round);
      if (!groups[y]) { groups[y] = []; order.push(y); }
      groups[y].push(r);
    });
    // 최근 연도부터. "기타" 는 항상 맨 뒤.
    order.sort(function (a, b) {
      if (a === '기타') return 1;
      if (b === '기타') return -1;
      return Number(b) - Number(a);
    });
    return { order: order, groups: groups };
  }

  /** 서버가 준 목록을 그대로 그린다 — 회차 수를 하드코딩하지 않는다. */
  function renderRounds() {
    var list = roundsData;
    roundList.textContent = '';
    if (!list) return; // 아직 도착 전 — 로딩 문구를 지우지 않는다
    if (list.length === 0) {
      roundList.appendChild(el('p', 'muted', '등록된 회차가 없습니다. data/rounds/*.json 을 확인하세요.'));
      return;
    }

    var byYear = groupByYear(list);
    var hist = (historyData && historyData.rounds) || {};

    byYear.order.forEach(function (year) {
      var group = el('div', 'year-group');
      group.appendChild(el('h3', null, year === '기타' ? '기타' : year + '년'));
      var grid = el('div', 'grid');
      byYear.groups[year].forEach(function (r) {
        // 고른 유형이 이 회차에 0문항이면 눌러 봐야 서버 400 이다 — 링크를 아예 만들지 않는다.
        // ('전체' 선택이거나 counts 를 모르는 구버전 서버면 아무것도 막지 않는다.)
        var zeroType = !!roundType && !!r.counts && Number(r.counts[roundType]) === 0;
        // 언어까지 골랐으면 그 언어가 0개인 회차도 같은 이유로 막는다.
        var zeroLang = !zeroType && roundType === 'code' && !!roundLang
          && !!r.langs && Number(r.langs[roundLang]) === 0;
        var zero = zeroType || zeroLang;
        var zeroLabel = zeroLang ? LANG_LABEL[roundLang] : TYPE_LABEL[roundType];
        var a = el(zero ? 'span' : 'a', 'round-btn' + (zero ? ' empty' : ''));
        if (zero) {
          a.title = '이 회차에는 ' + zeroLabel + ' 문항이 없습니다.';
          a.setAttribute('aria-disabled', 'true');
        } else {
          a.href = '/study.html?round=' + encodeURIComponent(r.round)
            + typeTail(roundType) + langTail(roundType, roundLang);
        }
        a.appendChild(document.createTextNode(r.title || r.round));
        a.appendChild(el('span', 'cnt', r.questionCount + '문항'));
        // 구성 표기 — 코드 유형을 보고 있으면 언어 구성이 더 쓸모 있다 (서버가 줄 때만).
        var ct = roundType === 'code' && langsText(r.langs) ? langsText(r.langs) : countsText(r.counts);
        if (ct) a.appendChild(el('span', 'types', ct));
        // 왜 눌리지 않는지 툴팁 없이도 보이게 한 줄 적어 둔다
        if (zero) a.appendChild(el('span', 'empty-note', zeroLabel + ' 문항 없음'));
        var h = hist[r.round];
        if (h && Number(h.count) > 0) {
          a.appendChild(el('span', 'badge',
            '최근 ' + h.last + '점 · 최고 ' + h.best + '점 · ' + h.count + '회'));
        }
        grid.appendChild(a);
      });
      group.appendChild(grid);
      roundList.appendChild(group);
    });
  }

  // ------------------------------------------------------------ 랜덤 모의고사

  /**
   * 연도별 체크박스 + 문항 수 → /study.html?set=practice&rounds=…&count=N.
   * 아무것도 고르지 않으면(또는 전부 고르면) rounds=all 로 보낸다.
   */
  function renderPractice() {
    practiceBox.textContent = '';
    var list = roundsData;
    if (!list) return;
    if (list.length === 0) {
      practiceBox.appendChild(el('p', 'muted', '등록된 회차가 없어 모의고사를 만들 수 없습니다.'));
      return;
    }

    var byYear = groupByYear(list);
    var boxes = [];

    var picks = el('div', 'practice-picks');
    picks.appendChild(el('span', 'practice-label', '출제 범위'));
    byYear.order.forEach(function (year) {
      var label = el('label', 'checkline');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = year;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(year === '기타' ? '기타' : year + '년'));
      picks.appendChild(label);
      boxes.push({ year: year, input: cb });
    });
    practiceBox.appendChild(picks);

    var countRow = el('div', 'form-row');
    var countLabel = el('label', null, '문항 수');
    countLabel.htmlFor = 'practiceCount';
    var count = document.createElement('select');
    count.id = 'practiceCount';
    [10, 20, 40].forEach(function (n) {
      var o = document.createElement('option');
      o.value = String(n);
      o.textContent = n + '문항';
      count.appendChild(o);
    });
    count.value = '20';
    countRow.appendChild(countLabel);
    countRow.appendChild(count);
    practiceBox.appendChild(countRow);

    // 유형 선택 — counts 를 주는 서버에서만 보인다 (구버전이면 전체 출제 그대로).
    var typeRow = null;
    if (hasCounts(list)) {
      typeRow = el('div', 'form-row');
      var typeLabel = el('label', null, '유형');
      typeLabel.htmlFor = 'practiceType';
      typeRow.appendChild(typeLabel);
      typeRow.appendChild(typeSelect('practiceType', practiceType, function (v) {
        practiceType = v;
        // 코드가 아닌 유형에서는 언어 한정이 의미가 없다 — 줄을 걷고 값도 푼다.
        if (practiceType !== 'code') practiceLang = '';
        syncLangRow();
        syncHref();
      }));
      practiceBox.appendChild(typeRow);
    }

    // 언어 선택 — 유형이 "코드" 일 때만 유형 줄 아래에 끼워 넣는다 (서버가 langs 를 줄 때만).
    // 매번 다시 만들지 않고 붙였다 뗐다 한다 — 연도 체크박스 상태를 잃지 않기 위해서다.
    var langRow = null;
    if (hasCounts(list) && hasLangs(list)) {
      langRow = el('div', 'form-row');
      var langLabel = el('label', null, '언어');
      langLabel.htmlFor = 'practiceLang';
      langRow.appendChild(langLabel);
      langRow.appendChild(langSelect('practiceLang', practiceLang, function (v) {
        practiceLang = v;
        syncHref();
      }));
    }

    var actions = el('div', 'form-actions');
    var start = el('a', 'btn-link', '랜덤 모의고사 시작');
    start.id = 'practiceStart';
    actions.appendChild(start);
    practiceBox.appendChild(actions);

    // 랜덤 모의고사도 이제 답안을 자동 저장한다. 다만 문항 묶음이 매번 새로 뽑히므로
    // 새로고침 뒤에는 **다시 뽑힌 세트에 남아 있는 문항의 답만** 되살아난다.
    practiceBox.appendChild(el('p', 'hint',
      '연도를 고르지 않으면 전 회차에서 무작위로 출제합니다. '
      + '답안은 자동 저장되지만 문항은 매번 새로 뽑히므로, 새로고침하면 겹치는 문항의 답만 되살아납니다.'));

    function selectedRounds() {
      var picked = boxes.filter(function (b) { return b.input.checked; });
      if (picked.length === 0 || picked.length === boxes.length) return 'all';
      var ids = [];
      picked.forEach(function (b) {
        byYear.groups[b.year].forEach(function (r) { ids.push(r.round); });
      });
      return ids.length ? ids.join(',') : 'all';
    }

    /** 언어 줄을 유형 줄 바로 아래에 넣거나 뺀다 (코드 유형일 때만 보인다). */
    function syncLangRow() {
      if (!langRow) return;
      var want = practiceType === 'code';
      if (want && !langRow.parentNode) {
        practiceBox.insertBefore(langRow, actions);
        var sel = langRow.querySelector('select');
        if (sel) sel.value = practiceLang || '';
      } else if (!want && langRow.parentNode) {
        langRow.parentNode.removeChild(langRow);
      }
    }
    syncLangRow();

    function syncHref() {
      start.href = '/study.html?set=practice&rounds=' + encodeURIComponent(selectedRounds())
        + '&count=' + encodeURIComponent(count.value) + typeTail(practiceType)
        + langTail(practiceType, practiceLang);
    }
    boxes.forEach(function (b) { b.input.addEventListener('change', syncHref); });
    count.addEventListener('change', syncHref);
    syncHref();
  }

  // ------------------------------------------------------------- 히어로 CTA

  /**
   * 최신 회차. /api/rounds 는 오래된 회차부터 주므로 첫 원소가 아니라,
   * 아래 회차 목록이 맨 위에 그리는 것과 같은 순서(연도 내림차순 → 그 해의 마지막 회차)로 고른다.
   */
  function latestRound() {
    var list = roundsData || [];
    if (list.length === 0) return null;
    var byYear = groupByYear(list);
    var group = byYear.groups[byYear.order[0]] || [];
    return group[group.length - 1] || null;
  }

  /**
   * "바로 풀어보기" 는 최신 회차로 보낸다. 회차 목록이 오기 전에는 갈 곳을 모르니 비활성.
   * <a> 가 아니라 <button> 인 것은 의도다 — 회차 목록을 세는 쪽(검사·사람 눈 양쪽)에
   * 이 버튼이 22번째 회차 버튼으로 잡히면 안 된다.
   */
  function renderHeroStart() {
    if (!heroStart) return;
    var r = latestRound();
    if (!r) return;
    heroStart.disabled = false;
    heroStart.title = (r.title || r.round) + ' 풀기';
  }

  if (heroStart) {
    heroStart.addEventListener('click', function () {
      var r = latestRound();
      if (!r) return;
      window.location.href = '/study.html?round=' + encodeURIComponent(r.round);
    });
  }

  // ------------------------------------------------------------------ 시작

  api.me().then(renderSession).catch(function (e) {
    clearSessionBox();
    var box = errorBox();
    box.textContent = e.message;
    sessionBox.appendChild(box);
    // 세션을 못 읽었으면 비로그인으로 친다 — 내비의 "로그인" 링크까지 사라지면
    // 일시적 네트워크 오류 하나로 로그인 진입점이 통째로 없어진다.
    renderNav(null);
    // 세션을 못 읽었어도 안내는 계정 섹션에 떴다 — 거기까지는 데려다 준다.
    sessionRendered = true;
    maybeScrollToAccount();
  });

  api.get('/api/rounds').then(function (list) {
    roundsData = list || [];
    renderHeroStart();
    renderRoundTypeFilter();
    renderRounds();
    renderPractice();
    renderStudyBox();
    roundsRendered = true;
    maybeScrollToAccount();
  }).catch(function (e) {
    roundList.textContent = '';
    var rErr = errorBox();
    rErr.textContent = e.message;
    roundList.appendChild(rErr);
    practiceBox.textContent = '';
    var pErr = errorBox();
    pErr.textContent = e.message;
    practiceBox.appendChild(pErr);
    // 실패해도 페이지 높이는 더 자라지 않는다 — 기다릴 이유가 없다.
    roundsRendered = true;
    maybeScrollToAccount();
  });
})();
