/**
 * clipboard.js — 3단 폴백 복사. 전역 `window.copyText` 하나만 노출한다.
 *
 * http://<IP> 원격 접속은 secure context 가 아니어서 `navigator.clipboard` 가 없다.
 * 즉 2·3단계가 예외 경로가 아니라 **일상 경로**다 (PROTOCOL.md "클립보드 방침").
 *
 *   1) navigator.clipboard.writeText() — **호출 성공 여부**로 분기한다.
 *      존재 검사를 하지 않고 **속성 접근까지 try/catch 로 감싼다.**
 *      비보안 컨텍스트에서 객체만 노출하고 동기 TypeError 를 던지는 브라우저도 2단계로 흘린다.
 *   2) 화면 밖 textarea + select() + document.execCommand('copy')
 *   3) 전문 textarea 모달을 전체 선택 상태로 열고 기기별 안내를 보여 준다.
 *
 * copyText(text, opts) → Promise<'clipboard' | 'execCommand' | 'manual'>
 *   opts.title  모달 제목 (기본 "복사할 내용")
 *   opts.guide  기기별 안내 대신 쓸 문구 (기본: 데스크톱/모바일 자동 판별)
 */
(function (global) {
  'use strict';

  var doc = global.document;

  /**
   * 터치 기기인가 — 3단계 안내 문구("Ctrl+C" vs "길게 눌러")를 고르는 데만 쓴다.
   *
   * 판정 순서가 중요하다. `'ontouchstart' in window` 는 **터치스크린 노트북에서도 참**이라
   * 단독으로 쓰면 마우스를 쓰는 사용자에게 "길게 눌러" 를 보여 준다.
   * 그래서 주 포인터 종류(pointer 미디어 쿼리)를 먼저 믿고,
   * 그 정보가 없는 구형 브라우저에서만 maxTouchPoints → ontouchstart 로 내려간다.
   */
  function isTouchDevice() {
    try {
      if (global.matchMedia) {
        if (global.matchMedia('(pointer: coarse)').matches) return true;  // 폰·태블릿
        if (global.matchMedia('(pointer: fine)').matches) return false;   // 마우스(터치 노트북 포함)
      }
    } catch (e) { /* matchMedia 미지원 — 아래로 내려간다 */ }
    try {
      var maxTouch = global.navigator && global.navigator.maxTouchPoints;
      if (typeof maxTouch === 'number') return maxTouch > 0;
    } catch (e) { /* navigator 접근 실패 — 아래로 내려간다 */ }
    try {
      if ('ontouchstart' in global) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  // --------------------------------------------------------------- 1단계

  function tryAsyncClipboard(text) {
    var promise;
    try {
      // 속성 접근 자체가 던질 수 있다 — 그래서 접근까지 try 안에 둔다
      promise = navigator.clipboard.writeText(text);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!promise || typeof promise.then !== 'function') {
      return Promise.reject(new Error('writeText 가 Promise 를 돌려주지 않았습니다.'));
    }
    return promise.then(function () { return 'clipboard'; });
  }

  // --------------------------------------------------------------- 2단계

  function tryExecCommand(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.setAttribute('aria-hidden', 'true');
    // 화면 밖 + 스크롤 점프 방지. display:none 이면 select() 가 동작하지 않는다.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';

    var ok = false;
    doc.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length); // iOS 는 select() 만으로는 부족하다
      ok = doc.execCommand('copy');
    } catch (e) {
      ok = false;
    } finally {
      doc.body.removeChild(ta);
    }
    return ok;
  }

  // --------------------------------------------------------------- 3단계

  function showManualModal(text, opts) {
    var backdrop = doc.createElement('div');
    backdrop.className = 'modal-backdrop';

    var modal = doc.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    var h3 = doc.createElement('h3');
    h3.textContent = (opts && opts.title) || '복사할 내용';

    var guide = doc.createElement('p');
    guide.className = 'guide';
    guide.textContent = (opts && opts.guide) ||
      (isTouchDevice()
        ? '아래 내용이 전체 선택되어 있습니다. 길게 눌러 복사하세요.'
        : '아래 내용이 전체 선택되어 있습니다. Ctrl+C 를 눌러 복사하세요.');

    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.spellcheck = false;

    var actions = doc.createElement('div');
    actions.className = 'modal-actions';
    var again = doc.createElement('button');
    again.type = 'button';
    again.className = 'alt';
    again.textContent = '다시 전체 선택';
    var close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    actions.appendChild(again);
    actions.appendChild(close);

    modal.appendChild(h3);
    modal.appendChild(guide);
    modal.appendChild(ta);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    doc.body.appendChild(backdrop);

    function selectAll() {
      try {
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
      } catch (e) { /* 포커스 실패는 치명적이지 않다 */ }
    }

    function dismiss() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      doc.removeEventListener('keydown', onKey);
    }

    function onKey(ev) {
      if (ev.key === 'Escape') dismiss();
    }

    close.addEventListener('click', dismiss);
    again.addEventListener('click', selectAll);
    backdrop.addEventListener('mousedown', function (ev) {
      if (ev.target === backdrop) dismiss(); // 바깥 클릭으로 닫기
    });
    doc.addEventListener('keydown', onKey);

    selectAll();
    return dismiss;
  }

  // ----------------------------------------------------------------- 진입

  function copyText(text, opts) {
    var value = text == null ? '' : String(text);
    return tryAsyncClipboard(value).catch(function () {
      if (tryExecCommand(value)) return 'execCommand';
      showManualModal(value, opts);
      return 'manual';
    });
  }

  global.copyText = copyText;
})(window);
