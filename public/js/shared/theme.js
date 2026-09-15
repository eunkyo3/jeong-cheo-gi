/**
 * shared/theme.js — 라이트 / 다크 테마 전환 한 벌 (전 화면 공통).
 *
 * 여섯 화면 모두 `<head>` 에서 **CSS 보다 먼저, 동기로** 읽는다. 첫 페인트 전에
 * `<html data-theme="light|dark">` 를 박아야 저장해 둔 다크 설정이 있는 사람에게
 * 흰 화면이 번쩍이지 않는다. 그래서 이 파일은 다른 shared/*.js(JPK.dom·JPK.store)에
 * 기대지 않고 혼자 돈다 — 그것들은 `<body>` 끝에서야 읽힌다.
 *
 * 색은 전부 app.css 의 토큰이다. 다크 팔레트는 `:root[data-theme="dark"]` 한 블록이므로
 * 이 속성 하나를 바꾸면 화면이 **즉시** 뒤집힌다(새로고침 없음).
 *
 * 설정은 세 가지다: 'light' · 'dark' 는 localStorage("jpk:theme") 에 남고,
 * 'system'(기기 설정 따르기) 은 키를 지운 상태다. 저장을 못 하는 환경(사파리 프라이빗 등)에서는
 * 이번 화면에서 고른 값을 메모리에만 들고 있다 — 클릭은 그대로 먹고, 다음 로드는 기기 설정으로 간다.
 *
 * 버튼: `.nav-theme` 클래스만 붙이면 어디 있든(정적 내비·동적 내비·관리자 헤더) 이 파일이
 * 문서 단위 클릭 위임으로 받고, 아이콘·설명(aria-label·title)을 현재 상태로 맞춘다.
 * 누를 때마다  기기 설정 → (기기와 반대쪽) → (기기와 같은 쪽, 고정) → 기기 설정  순으로 돈다 —
 * "자동" 상태에서 첫 클릭은 반드시 눈에 보이는 변화를 만든다.
 *
 *   JPK.theme.get()        'light' | 'dark' | 'system'   저장된 설정
 *   JPK.theme.effective()  'light' | 'dark'              지금 화면에 적용된 쪽
 *   JPK.theme.set(v)       설정 저장 + 즉시 적용
 *   JPK.theme.cycle()      다음 설정으로
 *   JPK.theme.sync()       `.nav-theme` 버튼 표시 갱신 (동적 내비가 버튼을 만든 뒤 부른다)
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var doc = global.document;
  var root = doc.documentElement;
  var KEY = 'jpk:theme';
  var QUERY = '(prefers-color-scheme: dark)';

  // 저장소가 막힌 환경의 대비책 — set() 이 고른 값을 여기 들고 있다가 read() 가 저장소 대신 돌려준다.
  var memory = null;

  function read() {
    if (memory !== null) return memory;
    try {
      var v = global.localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }

  function write(v) {
    memory = null;
    try {
      if (v === 'system') global.localStorage.removeItem(KEY);
      else global.localStorage.setItem(KEY, v);
    } catch (e) {
      memory = v;   // 저장 불가 — 이번 화면에서는 이 값으로, 다음 로드는 기기 설정으로
    }
  }

  // matchMedia 가 없는 환경(구형 웹뷰 등)은 라이트로 본다. jsdom(npm run headless)은 matchMedia 가
  // 있지만 prefers-color-scheme 에 늘 false 를 돌려주므로 결과는 같다.
  function mediaQuery() {
    return typeof global.matchMedia === 'function' ? global.matchMedia(QUERY) : null;
  }

  function systemTheme() {
    var m = mediaQuery();
    return m && m.matches ? 'dark' : 'light';
  }

  function effective(pref) {
    pref = pref || read();
    return pref === 'system' ? systemTheme() : pref;
  }

  /** 다음 설정. 자동 → 기기와 반대쪽 → 기기와 같은 쪽(고정) → 자동. */
  function next(pref) {
    var sys = systemTheme();
    var opposite = sys === 'dark' ? 'light' : 'dark';
    if (pref === 'system') return opposite;
    if (pref === opposite) return sys;
    return 'system';
  }

  function nameOf(t) { return t === 'dark' ? '다크' : '라이트'; }

  function describe(pref, eff) {
    var now = pref === 'system' ? '자동(기기 설정 · 지금은 ' + nameOf(eff) + ')' : nameOf(eff) + ' 고정';
    var to = next(pref);
    var toText = to === 'system' ? '기기 설정 따르기' : nameOf(to) + '로';
    return '테마: ' + now + ' — 누르면 ' + toText;
  }

  function syncButtons(pref, eff) {
    if (!doc.body) return;   // <head> 단계 — 버튼은 아직 없다
    var btns = doc.querySelectorAll('.nav-theme');
    var label = describe(pref, eff);
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.textContent = eff === 'dark' ? '🌙' : '☀️';
      b.setAttribute('aria-label', label);
      b.title = label;
      b.setAttribute('data-pref', pref);
      b.setAttribute('data-effective', eff);
    }
  }

  var listeners = [];

  // 스크린 리더용 알림 자리 — 버튼의 이름만 바뀌면 활성화 결과가 읊어지지 않으므로 별도 status 로 알린다.
  var live = null;
  function announce(text) {
    if (!doc.body) return;
    if (!live) {
      live = doc.createElement('span');
      live.className = 'visually-hidden';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      doc.body.appendChild(live);
    }
    live.textContent = '';
    live.textContent = text;
  }

  function apply() {
    var pref = read();
    var eff = effective(pref);
    root.setAttribute('data-theme', eff);
    // data-theme-pref 는 CSS 가 읽지 않는다 — 검사(npm run headless)·디버깅용 표식이다.
    root.setAttribute('data-theme-pref', pref);
    // 스타일시트가 아직 안 왔을 때도 캔버스 색이 맞도록 UA 에 직접 알린다 (CSSOM 쓰기 — CSP 에 걸리지 않는다).
    root.style.colorScheme = eff;
    syncButtons(pref, eff);
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](eff, pref); } catch (e) { /* 한 리스너의 실패가 테마를 막지 않는다 */ }
    }
  }

  function set(v) {
    write(v === 'light' || v === 'dark' ? v : 'system');
    apply();
    var pref = read();
    announce(pref === 'system'
      ? '기기 설정을 따릅니다 — 지금은 ' + nameOf(effective(pref)) + ' 모드'
      : nameOf(pref) + ' 모드로 바꿨습니다');
  }

  function cycle() { set(next(read())); }

  // 첫 페인트 전 적용.
  apply();

  // 자동 모드일 때 기기 설정이 바뀌면 따라간다.
  var mq = mediaQuery();
  if (mq) {
    var onMedia = function () { if (read() === 'system') apply(); };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMedia);
    else if (typeof mq.addListener === 'function') mq.addListener(onMedia);
  }

  // 다른 탭에서 바꾸면 이 탭도 따라간다 (key === null 은 storage.clear()).
  global.addEventListener('storage', function (ev) {
    if (!ev || ev.key === KEY || ev.key === null) apply();
  });

  // 버튼은 문서 단위 위임 — 정적 내비·동적 내비·관리자 헤더 어디에 있어도 같은 길.
  doc.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== doc && !(t.classList && t.classList.contains('nav-theme'))) t = t.parentNode;
    if (!t || t === doc) return;
    ev.preventDefault();
    cycle();
  });

  // 정적 내비의 버튼은 파싱이 끝나야 있다.
  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { syncButtons(read(), effective()); });
  } else {
    syncButtons(read(), effective());
  }

  JPK.theme = {
    KEY: KEY,
    get: read,
    effective: function () { return effective(read()); },
    next: function () { return next(read()); },
    set: set,
    cycle: cycle,
    sync: function () { syncButtons(read(), effective()); },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
  };
})(window);
