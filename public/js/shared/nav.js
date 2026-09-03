/**
 * shared/nav.js — 다섯 화면이 같은 상단 내비를 쓰게 하는 한 벌.
 *
 * 내비 마크업은 두 가지 방식으로 존재한다.
 *   정적 (index/study/wrong) : HTML 에 `<nav class="topnav">` 가 이미 있다. 스크립트 없이도 보인다.
 *   동적 (battle/ranking)    : HTML 에는 빈 `<nav class="topnav" id="nav">` 만 있고 여기서 채운다.
 * 어느 쪽이든 **같은 태그·클래스·순서**여야 app.css 의 `.topnav` 한 벌이 전부 같은 모양을 낸다.
 * 그래서 render() 하나가 둘을 다 맡는다 — 비어 있으면 뼈대를 만들고, 있으면 사용자 표시만 갱신한다.
 *
 *   JPK.nav.render(user, opts)
 *     user            {id, nickname} | null
 *     opts.current    'study' | 'battle' | 'ranking'  — 뼈대를 만들 때 aria-current 를 줄 항목
 *     opts.onLogout   로그아웃 성공 뒤 (없으면 '/' 로 이동)
 *     opts.onError    로그아웃 실패 뒤 (없으면 '/' 로 이동 — 세션 상태를 알 수 없으니 메인이 안전하다)
 *
 * 의존: window.api (js/api.js), JPK.dom
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var doc = global.document;
  var h = JPK.dom.h;

  var NAV_LINKS = [
    { key: 'study', href: '/', text: '학습' },
    { key: 'battle', href: '/battle.html', text: '대전' },
    { key: 'ranking', href: '/ranking.html', text: '랭킹' },
  ];

  /** 정적 내비와 **같은 구조**. 순서가 어긋나면 두 화면의 내비가 서로 달라 보인다. */
  function buildSkeleton(current) {
    var kids = [h('a', { class: 'brand', href: '/', text: '정처기 배틀' })];
    NAV_LINKS.forEach(function (l) {
      kids.push(h('a', {
        href: l.href,
        'data-nav': l.key,
        'aria-current': l.key === current ? 'page' : null,
        text: l.text,
      }));
    });
    kids.push(h('span', { class: 'spacer' }));
    kids.push(h('span', { class: 'who', id: 'navWho' }));
    kids.push(h('button', { type: 'button', class: 'nav-logout', id: 'navLogout', hidden: 'hidden', text: '로그아웃' }));
    kids.push(h('a', { class: 'nav-login', id: 'navLogin', href: '/#account', hidden: 'hidden', text: '로그인' }));
    return h('div', { class: 'wrap' }, kids);
  }

  /** 로그인 여부에 따라 닉네임·로그아웃·로그인 세 조각만 갈아끼운다. */
  function syncUser(user) {
    var who = doc.getElementById('navWho');
    var out = doc.getElementById('navLogout');
    var login = doc.getElementById('navLogin');
    if (who) {
      who.textContent = '';
      if (user) {
        who.appendChild(h('b', { text: user.nickname }));
        who.appendChild(doc.createTextNode(' 님'));
      }
    }
    if (out) out.hidden = !user;
    if (login) login.hidden = !!user;
  }

  /**
   * 로그아웃 버튼 배선 — 화면당 한 번만 건다.
   * `api.logout()` 은 세션 쿠키를 지우고 api.js 의 me() 캐시까지 무효화한다.
   */
  function bindLogout(opts) {
    var out = doc.getElementById('navLogout');
    if (!out || out.getAttribute('data-bound') === '1') return;
    out.setAttribute('data-bound', '1');
    out.addEventListener('click', function () {
      out.disabled = true;
      global.api.logout().then(function () {
        out.disabled = false;
        syncUser(null);
        if (opts.onLogout) opts.onLogout();
        else global.location.href = '/';
      }).catch(function (e) {
        out.disabled = false;
        if (opts.onError) opts.onError(e);
        else global.location.href = '/';
      });
    });
  }

  function render(user, opts) {
    opts = opts || {};
    var host = doc.getElementById('nav');
    // 동적 내비(battle/ranking)의 빈 그릇 — 처음 한 번만 채운다. 정적 내비에는 #nav 가 없다.
    if (host && !host.querySelector('.wrap')) host.replaceChildren(buildSkeleton(opts.current));
    syncUser(user || null);
    bindLogout(opts);
  }

  JPK.nav = {
    render: render,
    syncUser: syncUser,
  };
})(window);
