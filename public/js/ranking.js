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
 * 의존: window.api (js/api.js)
 */

(function () {
  var state = {
    me: null,
    rows: null,     // null = 로딩 중
    error: '',
    loading: true,
  };

  // ------------------------------------------------------------ DOM 헬퍼

  function append(parent, kids) {
    if (kids == null || kids === false || kids === true) return;
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) append(parent, kids[i]);
      return;
    }
    parent.appendChild(kids.nodeType ? kids : document.createTextNode(String(kids)));
  }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'text') e.textContent = String(v);
        else if (k === 'class') e.className = v;
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

  function render() {
    var root = document.getElementById('view');
    if (!root) return;
    root.replaceChildren(build());
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
    var body = rows.map(function (r) {
      var mine = myUserId != null && r.userId === myUserId;
      return h('tr', { class: mine ? 'me' : '' }, [
        h('td', { class: 'rank' }, [
          h('span', { class: 'rankno r' + (r.rank <= 3 ? r.rank : 'n'), text: String(r.rank) }),
        ]),
        h('td', { class: 'nick' }, [
          h('span', { text: r.nickname }),
          mine ? h('span', { class: 'mine-tag', text: '나' }) : null,
        ]),
        h('td', { text: String(r.wins || 0) }),
        h('td', { text: String(r.draws || 0) }),
        h('td', { text: String(r.losses || 0) }),
        h('td', { text: String(playedOf(r)) }),
        h('td', { class: 'pts', text: String(r.points || 0) }),
      ]);
    });

    kids.push(h('div', { class: 'card' }, [
      h('div', { class: 'rank-scroll' }, [
        h('table', { class: 'list rank-table' }, [
          h('thead', {}, [h('tr', {}, [
            h('th', { text: '순위' }),
            h('th', { text: '닉네임' }),
            h('th', { text: '승' }),
            h('th', { text: '무' }),
            h('th', { text: '패' }),
            h('th', { text: '참가' }),
            h('th', { text: '승점' }),
          ])]),
          h('tbody', {}, body),
        ]),
      ]),
      h('p', { class: 'hint', text: '정렬: 승점 → 승수 → 닉네임. 패 = 참가 − 승 − 무.' }),
    ]));

    kids.push(h('div', { class: 'btnbar' }, [
      h('button', { text: '새로고침', onclick: load }),
      h('button', { class: 'secondary', text: '대전으로', onclick: function () { window.location.href = '/battle.html'; } }),
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

  function buildNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    nav.replaceChildren(frag(h('div', { class: 'wrap' }, [
      h('a', { class: 'brand', href: '/', text: '정처기 배틀' }),
      h('a', { href: '/', text: '학습' }),
      h('a', { href: '/battle.html', text: '대전' }),
      h('a', { href: '/ranking.html', text: '랭킹' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'who' }, [h('b', { text: state.me ? state.me.nickname : '' })]),
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
