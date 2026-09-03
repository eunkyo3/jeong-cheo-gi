/**
 * wrong.js — 오답노트 허브 (public/wrong.html).
 *
 * 한 번의 GET /api/me/wrong/summary 로 전부 그린다.
 *   { total, byRound:[{round,count,counts}], byBattle:[{matchId,roomName,finishedAt,…,wrongQuestions[]}] }
 *
 * 두 가지 보기를 탭으로 나눈다 — 어느 쪽이든 실제 풀이는 study.html 로 넘긴다.
 *   회차별 → /study.html?set=wrong&round=<회차id>   (지금 오답)
 *   대전별 → /study.html?set=wrong&match=<matchId>  (그 대전에서 틀렸던 문항 = 과거 스냅샷)
 *
 * 렌더는 study.js·battle.js 와 같은 규약이다: 이벤트 → state → render() 전체 재작성.
 * 부분 DOM 패치는 하지 않는다.
 *
 * 의존 (전역): window.api, window.Fmt, JPK.dom, JPK.qmeta, JPK.store, JPK.nav
 */
(function () {
  'use strict';

  var TAB_KEY = 'jpk-wrong:tab';

  var el = JPK.dom.el;
  var pad2 = JPK.dom.pad2;
  var htmlToText = JPK.dom.htmlToText;
  var srOnly = JPK.dom.srOnly;

  // 문항 유형·언어 표는 공용 모듈(js/shared/qmeta.js)이 소유한다 — 화면마다 다른 말이 나오지 않게.
  var TYPE_ORDER = JPK.qmeta.TYPE_ORDER;
  var TYPE_LABEL = JPK.qmeta.TYPE_LABEL;
  var LANGS = JPK.qmeta.LANGS;
  var LANG_LABEL = JPK.qmeta.LANG_LABEL;
  var normalizeType = JPK.qmeta.normalizeType;
  var normalizeLang = JPK.qmeta.normalizeLang;
  var questionOrigin = JPK.qmeta.questionOrigin;
  var countsText = JPK.qmeta.countsText;
  var langsText = JPK.qmeta.langsText;

  var RESULT_LABEL = { win: '승', lose: '패', draw: '무' };

  var state = {
    data: null,        // /api/me/wrong/summary 응답
    error: null,       // {kind:'auth'|'missing'|'other', message}
    tab: 'round',      // 'round' | 'battle'
    typeFilter: '',    // '' | 'code' | 'sql' | 'theory'
    langFilter: '',    // '' | 'c' | 'java' | 'python' (유형이 코드일 때만 쓴다)
    expanded: {},      // matchId -> true (틀린 문항 목록 펼침)
  };

  var elTitle = document.getElementById('wrongTitle');
  var elMeta = document.getElementById('wrongMeta');
  var elSummary = document.getElementById('wrongSummary');
  var elTabs = document.getElementById('wrongTabs');
  var elBody = document.getElementById('wrongBody');
  var elToastWrap = document.getElementById('toastWrap');

  // ------------------------------------------------------------- 작은 도구

  function toast(message, kind) {
    JPK.dom.toast(elToastWrap, message, kind);
  }

  /** epoch ms · 숫자 문자열 · ISO 문자열을 모두 받아 준다 (서버 표기가 바뀌어도 깨지지 않게). */
  function toDate(value) {
    if (value == null || value === '') return null;
    var d;
    if (typeof value === 'number') d = new Date(value);
    else if (/^\d+$/.test(String(value))) d = new Date(Number(value));
    else d = new Date(String(value));
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDateTime(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** "오늘 14:00 / 어제 14:00 / 3일 전 / 2026-08-25". fmt.js 가 없으면 ''. */
  function relativeDate(value) {
    return window.Fmt ? window.Fmt.relativeDate(value) : '';
  }

  /** "2024-1" → "2024년 1회". 형식이 다르면 그대로 보여 준다. */
  function roundLabel(id) {
    var m = /^(\d{4})-(\d+)$/.exec(String(id == null ? '' : id));
    return m ? m[1] + '년 ' + m[2] + '회' : String(id == null ? '' : id);
  }

  /**
   * 지금 링크에 언어 한정이 실리는가. langTail 과 **같은 조건**이어야 한다 —
   * 화면에 적는 문항 수와 그 링크가 여는 study 화면의 문항 수가 어긋나면 안 된다.
   */
  function langActive() {
    return state.typeFilter === 'code' && !!state.langFilter;
  }

  /**
   * 목록 한 줄에 적을 오답 수. 필터가 걸려 있으면 **그 필터의 문항 수**를 적는다 —
   * "오답 16" 을 눌렀는데 5문항이 열리는 일이 없도록.
   * 서버가 counts/langs 를 안 주는 구버전이면 전체 수 그대로다.
   */
  function scopedCount(row) {
    var all = Number(row.count) || 0;
    if (langActive() && row.langs && typeof row.langs === 'object') {
      return Number(row.langs[state.langFilter]) || 0;
    }
    if (state.typeFilter && row.counts && typeof row.counts === 'object') {
      return Number(row.counts[state.typeFilter]) || 0;
    }
    return all;
  }

  function typeTail() {
    return state.typeFilter ? '&type=' + encodeURIComponent(state.typeFilter) : '';
  }

  /** 언어 한정. 유형이 코드가 아니면 의미가 없으므로 빈 문자열 (서버 400 을 미리 막는다). */
  function langTail() {
    return state.typeFilter === 'code' && state.langFilter
      ? '&lang=' + encodeURIComponent(state.langFilter) : '';
  }

  function allUrl() { return '/study.html?set=wrong' + typeTail() + langTail(); }
  function roundUrl(id) {
    return '/study.html?set=wrong&round=' + encodeURIComponent(id) + typeTail() + langTail();
  }
  // 대전별은 "그 대전에서 틀린 문항" 전부가 대상이다 — 유형으로 다시 자르지 않는다.
  // 다만 언어를 고른 경우는 이어 준다 (lang 만 오면 서버가 type=code 로 간주한다).
  function matchUrl(id) {
    return '/study.html?set=wrong&match=' + encodeURIComponent(id) + langTail();
  }

  /** index.html 과 같은 전체/코드/SQL/이론 <select>. */
  function typeSelect(current, onPick) {
    var sel = document.createElement('select');
    sel.id = 'wrongType';
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
    sel.addEventListener('change', function () { onPick(normalizeType(sel.value)); });
    return sel;
  }

  /** typeSelect 와 같은 모양의 언어 <select>. 유형이 "코드" 일 때만 만든다. */
  function langSelect(current, onPick) {
    var sel = document.createElement('select');
    sel.id = 'wrongLang';
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
    sel.addEventListener('change', function () { onPick(normalizeLang(sel.value)); });
    return sel;
  }

  // ---------------------------------------------------------------- 내비

  /**
   * 정적 내비다 — 공용 모듈은 닉네임·로그아웃·로그인 세 조각만 갈아끼운다.
   * 오답노트는 로그인 사용자의 기록이므로 로그아웃하면 화면도 안내로 되돌린다(페이지 이동은 없다).
   */
  function renderNav(user) {
    JPK.nav.render(user, {
      current: 'study',
      onLogout: function () {
        toast('로그아웃했습니다.');
        state.data = null;
        state.error = { kind: 'auth', message: '로그인이 필요합니다.' };
        render();
      },
      onError: function (e) { toast(e && e.message ? e.message : '로그아웃에 실패했습니다.', 'bad'); },
    });
  }

  // ---------------------------------------------------------------- 렌더

  function clear(node) {
    if (node) node.textContent = '';
  }

  function backLink(href, text) {
    var p = el('p', 'hint');
    var a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    p.appendChild(a);
    return p;
  }

  function renderError() {
    var e = state.error;
    elTitle.textContent = '오답노트';
    elMeta.textContent = '';
    elSummary.hidden = true;
    elTabs.hidden = true;
    clear(elBody);

    var card = el('div', 'card empty-state');
    if (e.kind === 'auth') {
      card.appendChild(el('p', null, '로그인이 필요합니다.'));
      card.appendChild(el('p', 'hint', '오답노트는 로그인한 사용자의 채점 기록으로 만들어집니다.'));
      card.appendChild(backLink('/', '메인으로 가서 로그인하기'));
    } else if (e.kind === 'missing') {
      card.appendChild(el('p', null, '이 서버는 아직 오답노트 허브를 지원하지 않습니다.'));
      card.appendChild(el('p', 'hint', '서버를 최신 버전으로 올리면 회차별·대전별로 나눠 볼 수 있습니다. 지금은 전체 오답을 한 번에 풀 수 있습니다.'));
      card.appendChild(backLink('/study.html?set=wrong', '오답 전체 풀기'));
      card.appendChild(backLink('/', '메인으로 돌아가기'));
    } else {
      card.appendChild(el('p', null, '오답노트를 불러오지 못했습니다.'));
      card.appendChild(el('p', 'hint', e.message || ''));
      card.appendChild(backLink('/', '메인으로 돌아가기'));
    }
    elBody.appendChild(card);
  }

  function renderEmpty() {
    elMeta.textContent = '지금은 다시 풀 오답이 없습니다.';
    elSummary.hidden = true;
    elTabs.hidden = true;
    clear(elBody);

    var card = el('div', 'card empty-state');
    card.appendChild(el('p', null, '🎉 틀린 문항이 없습니다.'));
    card.appendChild(el('p', 'hint',
      '회차를 풀거나 대전을 하고 채점하면 틀린 문항이 여기에 모입니다. 나중에 맞히면 자동으로 빠집니다.'));
    card.appendChild(backLink('/', '회차 목록으로 돌아가기'));
    elBody.appendChild(card);
  }

  function renderSummary() {
    var total = Number(state.data.total) || 0;
    clear(elSummary);
    elSummary.hidden = false;

    elSummary.appendChild(el('span', 'wn-total', '총 ' + total + '문항'));

    var actions = el('div', 'form-actions');
    var link = el('a', 'btn-link', '전체 풀기');
    link.id = 'wrongAll';
    link.href = allUrl();
    actions.appendChild(link);
    actions.appendChild(typeSelect(state.typeFilter, function (v) {
      state.typeFilter = v;
      // 코드가 아닌 유형으로 옮기면 언어 한정은 의미가 없다 — 조용히 푼다.
      if (v !== 'code') state.langFilter = '';
      render();
    }));
    // 언어는 코드 문항에만 있는 축이다 — 유형이 "코드" 일 때만 한 칸 더 낸다.
    if (state.typeFilter === 'code') {
      actions.appendChild(langSelect(state.langFilter, function (v) {
        state.langFilter = v;
        render();
      }));
    }
    elSummary.appendChild(actions);
  }

  function renderTabs() {
    clear(elTabs);
    elTabs.hidden = false;

    var byRound = state.data.byRound || [];
    var byBattle = state.data.byBattle || [];
    [
      { key: 'round', label: '회차별 (' + byRound.length + ')' },
      { key: 'battle', label: '대전별 (' + byBattle.length + ')' },
    ].forEach(function (t) {
      var on = state.tab === t.key;
      var btn = el('button', 'chip' + (on ? ' on' : ''), t.label);
      btn.type = 'button';
      btn.setAttribute('data-tab', t.key);
      // 두 탭은 켜고 끄는 토글이다 — 지금 어느 쪽을 보고 있는지 보조 기술에도 알린다.
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', function () {
        if (state.tab === t.key) return;
        state.tab = t.key;
        JPK.store.set(TAB_KEY, t.key);
        render();
      });
      elTabs.appendChild(btn);
    });
  }

  /**
   * 지금 보고 있는 탭의 제목. 화면에는 탭 칩이 이미 그 말을 하고 있으므로 눈에는 감추고
   * 문서 구조에만 남긴다 — 이게 없으면 h1(오답노트) 다음이 곧바로 h3(방 이름)이라 단계가 끊긴다.
   */
  function tabHeading(text) {
    return srOnly(el('h2', 'wn-tab-title', text));
  }

  function renderRoundTab() {
    elBody.appendChild(tabHeading('회차별 오답'));
    var rows = state.data.byRound || [];
    if (rows.length === 0) {
      elBody.appendChild(el('p', 'muted', '회차로 묶을 오답이 없습니다.'));
      return;
    }
    var card = el('div', 'card');
    var list = el('ul', 'history-list wn-rounds');
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var shown = scopedCount(r);
      // 고른 유형·언어가 이 회차에 0문항이면 눌러 봐야 빈 화면이다 — 링크를 아예 만들지 않는다.
      var zero = shown === 0 && (state.typeFilter || langActive());
      var label = langActive() ? LANG_LABEL[state.langFilter] : TYPE_LABEL[state.typeFilter];
      var a = el(zero ? 'span' : 'a', 'h-name' + (zero ? ' empty' : ''), roundLabel(r.round));
      if (zero) {
        a.title = '이 회차에는 ' + label + ' 오답이 없습니다.';
        a.setAttribute('aria-disabled', 'true');
      } else {
        a.href = roundUrl(r.round);
      }
      li.appendChild(a);
      li.appendChild(el('span', 'h-score', '오답 ' + shown));
      // 구성 표기 — 코드 유형을 보고 있으면 언어 구성이 더 쓸모 있다 (서버가 줄 때만).
      var detail = state.typeFilter === 'code' && langsText(r.langs)
        ? langsText(r.langs) : countsText(r.counts);
      if (detail) li.appendChild(el('span', 'h-detail', detail));
      list.appendChild(li);
    });
    card.appendChild(list);
    card.appendChild(el('p', 'hint', '회차를 누르면 그 회차의 현재 오답만 다시 풉니다.'));
    elBody.appendChild(card);
  }

  /** 대전 카드에서 펼쳐지는 "틀린 문항" 목록. prompt 는 텍스트로만 보여 준다. */
  function buildWrongList(questions) {
    var list = el('ul', 'wn-qlist');
    (questions || []).forEach(function (q) {
      var li = el('li', 'wn-q');

      var head = el('div', 'wn-qhead');
      head.appendChild(el('span', 'num', String(q.num == null ? '?' : q.num)));
      var origin = questionOrigin(q.id);
      if (origin) head.appendChild(el('span', 'q-origin', origin));
      var qType = normalizeType(q.type);
      if (qType) head.appendChild(el('span', 'q-type ' + qType, TYPE_LABEL[qType]));
      var qLang = normalizeLang(q.lang);
      if (qLang) head.appendChild(el('span', 'q-lang ' + qLang, LANG_LABEL[qLang]));
      if (q.stillWrong === false) head.appendChild(el('span', 'q-resolved', '이후 맞힘'));
      li.appendChild(head);

      li.appendChild(el('div', 'wn-qtext', htmlToText(q.prompt)));
      list.appendChild(li);
    });
    return list;
  }

  function buildBattleCard(b) {
    var card = el('div', 'card wn-battle');
    var matchId = b.matchId;

    var head = el('div', 'wn-bhead');
    head.appendChild(el('h3', 'wn-bname', b.roomName || '이름 없는 방'));
    // 카드를 훑을 때는 "언제쯤" 이면 충분하다 — 정확한 시각은 title 로 남긴다.
    var abs = formatDateTime(b.finishedAt);
    var when = relativeDate(b.finishedAt) || abs;
    if (when) {
      var dateEl = el('span', 'wn-bdate', when);
      if (abs) dateEl.title = abs;
      head.appendChild(dateEl);
    }
    card.appendChild(head);

    // vs 상대 · 내 정답 x/총 · 승/패/무
    var bits = [];
    var opponents = (b.opponents || []).map(function (o) { return o && o.nickname; })
      .filter(function (n) { return !!n; });
    if (opponents.length) bits.push('vs ' + opponents.join(', '));
    var total = Number(b.questionCount) || 0;
    if (b.me && typeof b.me.correctCount === 'number') {
      bits.push('내 정답 ' + b.me.correctCount + '/' + (total || '?'));
    }
    if (RESULT_LABEL[b.result]) bits.push(RESULT_LABEL[b.result]);
    if (bits.length) card.appendChild(el('p', 'wn-bmeta', bits.join(' · ')));

    // matchUrl 은 언어만 이어 간다(유형으로는 자르지 않는다) — 여기 적는 수도 같은 규칙이어야
    // 링크가 여는 study 화면의 문항 수와 맞는다.
    var listed = b.wrongQuestions || [];
    var scoped = langActive()
      ? listed.filter(function (q) { return normalizeLang(q.lang) === state.langFilter; })
      : listed;
    var wrongCount = langActive() ? scoped.length : (Number(b.wrongCount) || 0);
    var stillWrong = langActive()
      ? scoped.filter(function (q) { return q.stillWrong !== false; }).length
      : (Number(b.stillWrongCount) || 0);
    card.appendChild(el('p', 'wn-bwrong',
      '틀린 ' + wrongCount + '문항 (지금도 오답 ' + stillWrong + ')'
      + (langActive() ? ' · ' + LANG_LABEL[state.langFilter] + '만' : '')));

    var open = !!state.expanded[matchId];
    var actions = el('div', 'form-actions wn-bactions');
    if (wrongCount > 0) {
      var toggle = el('button', 'chip', open ? '틀린 문항 접기' : '틀린 문항 보기');
      toggle.type = 'button';
      toggle.setAttribute('data-expand', String(matchId));
      toggle.addEventListener('click', function () {
        state.expanded[matchId] = !state.expanded[matchId];
        render();
      });
      actions.appendChild(toggle);

      var again = el('a', 'btn-link', '이 대전 오답 다시 풀기');
      again.href = matchUrl(matchId);
      actions.appendChild(again);
    } else {
      actions.appendChild(el('span', 'btn-link disabled', '틀린 문항 없음'));
    }
    card.appendChild(actions);

    if (open) card.appendChild(buildWrongList(scoped));
    return card;
  }

  function renderBattleTab() {
    elBody.appendChild(tabHeading('대전별 오답'));
    var rows = state.data.byBattle || [];
    if (rows.length === 0) {
      var card = el('div', 'card');
      card.appendChild(el('p', 'hint',
        '대전으로 묶을 오답이 없습니다. 대전을 하고 결과가 나오면 방 이름으로 모아 보여 줍니다.'));
      card.appendChild(backLink('/battle.html', '대전하러 가기'));
      elBody.appendChild(card);
      return;
    }
    rows.forEach(function (b) { elBody.appendChild(buildBattleCard(b)); });
  }

  function render() {
    if (state.error) {
      renderError();
      return;
    }
    if (!state.data) return;

    var total = Number(state.data.total) || 0;
    elTitle.textContent = '오답노트';
    if (total === 0) {
      renderEmpty();
      return;
    }

    elMeta.textContent = '틀린 문항을 회차별·대전별로 모아 둡니다. 나중에 맞히면 자동으로 빠집니다.';
    renderSummary();
    renderTabs();

    clear(elBody);
    if (state.tab === 'battle') renderBattleTab();
    else renderRoundTab();
  }

  // ------------------------------------------------------------------ 시작

  var savedTab = JPK.store.get(TAB_KEY);
  if (savedTab === 'round' || savedTab === 'battle') state.tab = savedTab;

  api.get('/api/me/wrong/summary')
    .then(function (data) {
      state.data = data && typeof data === 'object' ? data : { total: 0, byRound: [], byBattle: [] };
      render();
    })
    .catch(function (e) {
      if (e.status === 401) state.error = { kind: 'auth', message: e.message };
      else if (e.status === 404) state.error = { kind: 'missing', message: e.message };
      else state.error = { kind: 'other', message: e.message };
      render();
    });

  api.me().then(renderNav).catch(function () { renderNav(null); });
  if (JPK.net) JPK.net.bindNotice(document.getElementById('offlineNotice'));
})();
