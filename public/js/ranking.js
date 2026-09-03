'use strict';
/**
 * ranking.js — 전적 랭킹 표.
 *
 * battle.js 와 같은 단방향 규약을 따른다: 이벤트 → state 변경 → render(state) 전체 재렌더.
 * 이 화면에는 텍스트 입력이 없어 패널 분할이 필요 없다 — #view 를 통째로 다시 만든다.
 *
 * 랭킹 규칙(PROTOCOL.md): 1등 +3점, 그 외 참가 +1점, 무승부는 전원 +1점.
 * 정렬·순위는 서버(server/ranking.js)가 확정해 보낸다. 여기서는 표시만 한다.
 *
 * 의존: window.api (js/api.js), JPK.dom, JPK.nav (js/shared/*.js)
 */

(function () {
  var state = {
    me: null,
    rows: null,     // null = 로딩 중
    error: '',
    loading: true,
  };

  // DOM 헬퍼는 공용 모듈이 소유한다 (battle.js 와 같은 h/append/frag).
  var h = JPK.dom.h;
  var frag = JPK.dom.frag;

  // -------------------------------------------------------------- 조회기

  /** 참가 수. 서버가 played 를 주면 그대로, 없으면 승+무+패로 되살린다. */
  function playedOf(r) {
    if (r.played != null) return r.played;
    return (r.wins || 0) + (r.draws || 0) + (r.losses || 0);
  }

  function totalPlayed(rows) {
    var n = 0;
    for (var i = 0; i < rows.length; i++) n += playedOf(rows[i]);
    return n;
  }

  // --------------------------------------------------------------- 렌더

  /* 상세 줄(.rank-detail)은 ≤600px 에서만 펼쳐진다 — 그 폭에서만 행을 키보드로 조작할 수
     있게 하고, 데스크톱에서는 탭 순서에서 빼 둔다. 폭이 바뀌면 다시 맞춘다. */
  var narrowMq = window.matchMedia ? window.matchMedia('(max-width: 600px)') : null;

  function syncRowA11y() {
    var narrow = narrowMq ? narrowMq.matches : false;
    var rows = document.querySelectorAll('tr.rank-row');
    for (var i = 0; i < rows.length; i++) {
      if (narrow) {
        // 이 폭에서 행은 실제로 눌러서 펴는 조작 요소다. `aria-expanded` 만 붙이면
        // 보조 기술에는 "무엇을 펴는지" 가 없는 표 행으로 읽힌다 — role 도 함께 준다.
        rows[i].setAttribute('role', 'button');
        rows[i].setAttribute('tabindex', '0');
        rows[i].setAttribute('aria-expanded', rows[i].className.indexOf(' open') === -1 ? 'false' : 'true');
      } else {
        rows[i].removeAttribute('role');
        rows[i].removeAttribute('tabindex');
        rows[i].removeAttribute('aria-expanded');
      }
    }
  }

  if (narrowMq) {
    if (narrowMq.addEventListener) narrowMq.addEventListener('change', syncRowA11y);
    else if (narrowMq.addListener) narrowMq.addListener(syncRowA11y);
  }

  function render() {
    var root = document.getElementById('view');
    if (!root) return;
    root.replaceChildren(build());
    syncRowA11y();
  }

  function build() {
    var kids = [h('header', { class: 'page' }, [
      h('h1', { text: '대전 랭킹' }),
      h('p', { text: '1등 +3점 · 참가 +1점 · 무승부는 전원 +1점' }),
    ])];

    if (state.error) {
      kids.push(h('div', { class: 'banner err', text: state.error }));
      kids.push(h('div', { class: 'btnbar' }, [
        h('button', { class: 'secondary', text: '다시 시도', onclick: load }),
      ]));
      return frag(kids);
    }

    if (state.loading || state.rows == null) {
      kids.push(h('div', { class: 'card' }, [h('div', { class: 'empty', text: '불러오는 중…' })]));
      return frag(kids);
    }

    var rows = state.rows;
    if (!rows.length || totalPlayed(rows) === 0) {
      kids.push(h('div', { class: 'card' }, [
        h('div', { class: 'empty', text: '아직 대전 기록이 없습니다' }),
        h('p', { class: 'hint', text: '대전을 한 판 끝내면 이곳에 순위가 쌓입니다.' }),
      ]));
      kids.push(h('div', { class: 'btnbar' }, [
        h('button', { text: '대전하러 가기', onclick: function () { window.location.href = '/battle.html'; } }),
      ]));
      return frag(kids);
    }

    var myUserId = state.me ? state.me.id : null;
    // 폰(≤600px)에서는 승/무/패/참가 열을 접고(`.wide-only`) 행을 탭하면 바로 아래
    // `.rank-detail` 한 줄이 펼쳐진다. 데스크톱에서는 detail 이 계속 숨어 있고 표는 그대로다.
    var body = rows.map(function (r) {
      var mine = myUserId != null && r.userId === myUserId;
      // tabindex/aria-expanded 는 상세 줄이 실제로 열리는 폭에서만 붙인다(syncRowA11y).
      // 데스크톱에서 행마다 탭이 멈추고 Enter 를 눌러도 아무 변화가 없는 상태를 만들지 않기 위해서다.
      var row = h('tr', { class: 'rank-row' + (mine ? ' me' : '') }, [
        h('td', { class: 'rank' }, [
          h('span', { class: 'rankno r' + (r.rank <= 3 ? r.rank : 'n'), text: String(r.rank) }),
        ]),
        h('td', { class: 'nick' }, [
          h('span', { text: r.nickname }),
          mine ? h('span', { class: 'mine-tag', text: '나' }) : null,
        ]),
        h('td', { class: 'wide-only', text: String(r.wins || 0) }),
        h('td', { class: 'wide-only', text: String(r.draws || 0) }),
        h('td', { class: 'wide-only', text: String(r.losses || 0) }),
        h('td', { class: 'wide-only', text: String(playedOf(r)) }),
        h('td', { class: 'pts', text: String(r.points || 0) }),
      ]);
      var detail = h('tr', { class: 'rank-detail' + (mine ? ' me' : '') }, [
        h('td', {
          colspan: '7',
          text: '승 ' + (r.wins || 0) + ' · 무 ' + (r.draws || 0)
            + ' · 패 ' + (r.losses || 0) + ' · 참가 ' + playedOf(r),
        }),
      ]);

      function toggle() {
        var open = row.className.indexOf(' open') === -1;
        row.className = 'rank-row' + (mine ? ' me' : '') + (open ? ' open' : '');
        if (row.hasAttribute('aria-expanded')) row.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          toggle();
        }
      });

      return [row, detail];
    });

    kids.push(h('div', { class: 'card' }, [
      h('div', { class: 'rank-scroll' }, [
        h('table', { class: 'list rank-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '순위' }),
            h('th', { text: '닉네임' }),
            h('th', { class: 'wide-only', text: '승' }),
            h('th', { class: 'wide-only', text: '무' }),
            h('th', { class: 'wide-only', text: '패' }),
            h('th', { class: 'wide-only', text: '참가' }),
            h('th', { text: '승점' }),
          ])]),
          h('tbody', {}, body),
        ]),
      ]),
      h('p', { class: 'hint', text: '정렬: 승점 → 승수 → 닉네임. 패 = 참가 − 승 − 무.' }),
      h('p', { class: 'hint rank-tap-hint', text: '행을 탭하면 승·무·패·참가를 볼 수 있습니다.' }),
    ]));

    kids.push(h('div', { class: 'btnbar' }, [
      h('button', { text: '새로고침', onclick: load }),
      h('button', { class: 'ghost', text: '대전으로', onclick: function () { window.location.href = '/battle.html'; } }),
    ]));

    return frag(kids);
  }

  // --------------------------------------------------------------- 동작

  function load() {
    state.loading = true;
    state.error = '';
    render();
    window.api.get('/api/ranking')
      .then(function (list) {
        state.rows = Array.isArray(list) ? list : [];
        state.loading = false;
        render();
      })
      .catch(function (e) {
        state.loading = false;
        state.error = (e && e.message ? e.message : '랭킹을 불러오지 못했습니다.')
          + ' (대전 서버가 아직 준비되지 않았을 수 있습니다.)';
        render();
      });
  }

  /**
   * 상단 내비 — 다섯 화면이 같은 구조를 쓴다. 뼈대 조립과 로그인 표시는 공용 모듈이 맡는다
   * (비어 있는 `#nav` 를 채우고, 그 뒤로는 닉네임·로그아웃·로그인 세 조각만 갈아끼운다).
   * 로그아웃하면 랭킹은 볼 수 없으므로 메인으로 돌려보낸다(기본 동작).
   */
  function buildNav() {
    JPK.nav.render(state.me, { current: 'ranking' });
  }

  function boot() {
    if (!window.api) {
      var root = document.getElementById('view');
      if (root) root.replaceChildren(h('div', { class: 'banner err', text: '필수 스크립트를 불러오지 못했습니다. 새로고침해 주세요.' }));
      return;
    }
    window.api.me().then(function (res) {
      // window.api.me() 는 user 객체를 직접(또는 비로그인이면 null 을) 반환한다 — {user} 로 감싸지 않는다.
      var user = res || null;
      if (!user) {
        window.location.replace('/?msg=' + encodeURIComponent('랭킹은 로그인이 필요합니다.'));
        return;
      }
      state.me = user;
      buildNav();
      load();
    }).catch(function () {
      window.location.replace('/?msg=' + encodeURIComponent('로그인 상태를 확인하지 못했습니다.'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
