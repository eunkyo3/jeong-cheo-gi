/**
 * shared/dom.js — 다섯 화면이 함께 쓰는 DOM 조립 도구.
 *
 * 무빌드 규약: ES 모듈이 아니라 평범한 스크립트다. 페이지가 `<script src>` 로 먼저 읽고,
 * 모든 공용 모듈은 전역 네임스페이스 `window.JPK` 아래 한 칸씩 차지한다.
 *
 *   JPK.dom.el(tag, className, text)   study/wrong/index 계열의 짧은 생성기
 *   JPK.dom.h(tag, attrs, kids)        battle/ranking 계열의 속성·자식 생성기
 *   JPK.dom.append(parent, kids)       배열·노드·문자열을 한 번에 붙인다
 *   JPK.dom.frag(kids)                 DocumentFragment 로 묶는다
 *   JPK.dom.htmlToText(html)           신뢰 마크업에서 텍스트만 (공백 접기 + 트림)
 *   JPK.dom.pad2(n)                    "07"
 *   JPK.dom.fireInput(node)            구형 웹뷰까지 안전한 input 이벤트 발사
 *   JPK.dom.toast(wrap, message, kind) .toast-wrap 을 쓰는 화면의 토스트 한 장
 *   JPK.dom.srOnly(node)               눈에는 안 보이고 보조 기술에는 남는 요소로 만든다
 *
 * 이 파일은 다른 JPK 모듈에 의존하지 않는다 — 항상 가장 먼저 읽혀도 된다.
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var doc = global.document;

  // 토스트가 화면에 머무는 시간 / 사라지는 전환 시간 (study.js·wrong.js 가 쓰던 값 그대로).
  var TOAST_MS = 2600;
  var TOAST_LEAVE_MS = 300;

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function append(parent, kids) {
    if (kids == null || kids === false || kids === true) return;
    if (Array.isArray(kids)) {
      for (var i = 0; i < kids.length; i++) append(parent, kids[i]);
      return;
    }
    parent.appendChild(kids.nodeType ? kids : doc.createTextNode(String(kids)));
  }

  /** h('div', {class:'x', onclick:fn, text:'…'}, [children]) */
  function h(tag, attrs, kids) {
    var e = doc.createElement(tag);
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
    var f = doc.createDocumentFragment();
    append(f, kids);
    return f;
  }

  /**
   * 신뢰 마크업(문항 prompt·bodyHtml)에서 사람이 읽을 텍스트만 뽑는다.
   *
   * 예전에는 세 파일이 세 가지 공백 정책(트림만 / 공백 접기+트림 / 아무것도 안 함)을 갖고 있었다.
   * **공백 접기 + 트림** 하나로 통일한다 — 목록 미리보기·보기 칩 판정 어느 쪽에도 맞고,
   * 유일하게 여러 줄이 아쉬운 곳(AI 프롬프트의 bodyText 폴백)은 서버가 bodyText 를 항상 실어 주므로
   * 실제로는 거의 지나지 않는 길이다.
   */
  function htmlToText(html) {
    var div = doc.createElement('div');
    div.innerHTML = html == null ? '' : html;
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /** ES5/구형 웹뷰까지 안전한 input 이벤트 발사 — 자동 저장·진행 표시가 전부 이 이벤트로 돈다. */
  function fireInput(node) {
    var ev;
    if (typeof global.Event === 'function') {
      ev = new global.Event('input', { bubbles: true });
    } else {
      ev = doc.createEvent('Event');
      ev.initEvent('input', true, false);
    }
    node.dispatchEvent(ev);
  }

  /** `.toast-wrap` 한 장. 컨테이너가 없으면(대전 화면 등) 조용히 아무것도 하지 않는다. */
  function toast(wrap, message, kind) {
    if (!wrap) return;
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    wrap.appendChild(t);
    global.setTimeout(function () {
      t.classList.add('leaving');
      global.setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, TOAST_LEAVE_MS);
    }, TOAST_MS);
    return t;
  }

  /**
   * 눈에는 보이지 않지만 스크린 리더에는 남는 요소.
   *
   * 문서 구조를 바로잡기 위한 제목(빠진 `<h1>`·건너뛴 `<h2>`)은 화면에 새 글자를 더하지 않아야
   * 기존 레이아웃이 그대로 남는다. `display:none`·`visibility:hidden` 은 보조 기술에서도 사라지므로
   * 쓸 수 없다 — app.css 의 `.visually-hidden` 이 표준 clip 기법을 갖고 있다.
   *
   * 색을 인라인으로 주면 다크 모드에서 흰 조각이 남으므로, 모양은 전부 클래스에 맡긴다.
   */
  var SR_ONLY_CLASS = 'visually-hidden';

  function srOnly(node) {
    if (node) node.classList.add(SR_ONLY_CLASS);
    return node;
  }

  JPK.dom = {
    srOnly: srOnly,
    el: el,
    h: h,
    append: append,
    frag: frag,
    htmlToText: htmlToText,
    pad2: pad2,
    fireInput: fireInput,
    toast: toast,
  };
})(window);
