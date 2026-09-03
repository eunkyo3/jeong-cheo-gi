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

  // 제목 id 는 문서에서 유일해야 한다 — 모달이 두 번 열려도 겹치지 않게 번호를 매긴다.
  var modalSeq = 0;

  function showManualModal(text, opts) {
    // 모달을 연 요소. 닫을 때 여기로 포커스를 돌려주지 않으면 키보드 사용자는
    // 문서 맨 위부터 다시 탭해야 한다.
    var opener = doc.activeElement;

    var backdrop = doc.createElement('div');
    backdrop.className = 'modal-backdrop';

    var modal = doc.createElement('div');
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modalSeq += 1;
    var titleId = 'modal-title-' + modalSeq;
    var h3 = doc.createElement('h3');
    h3.id = titleId;
    // `aria-modal` 만으로는 대화상자의 이름이 없다 — 제목을 그 이름으로 준다.
    modal.setAttribute('aria-labelledby', titleId);
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
      // 열었던 자리로 포커스를 돌려준다. 그 요소가 그새 사라졌으면(재렌더) 아무것도 하지 않는다.
      if (opener && doc.contains(opener) && typeof opener.focus === 'function') {
        try { opener.focus(); } catch (e) { /* 무시 */ }
      }
    }

    /** 모달 안에서 탭으로 갈 수 있는 요소들 — 순서는 DOM 순서 그대로다. */
    function tabbables() {
      return [ta, again, close].filter(function (n) { return n && !n.disabled; });
    }

    /**
     * 포커스 트랩. `aria-modal` 은 보조 기술에만 "뒤는 없는 셈 쳐라" 고 말할 뿐,
     * 실제 Tab 키는 뒤쪽 페이지로 빠져나간다 — 그러면 보이지 않는 곳을 탭하게 된다.
     * 마지막에서 Tab 은 처음으로, 처음에서 Shift+Tab 은 마지막으로 돌린다.
     */
    function trap(ev) {
      var list = tabbables();
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      var here = doc.activeElement;
      // 포커스가 모달 밖에 있으면(바깥을 클릭한 뒤 Tab 등) 무조건 안으로 데려온다.
      if (list.indexOf(here) === -1) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (!ev.shiftKey && here === last) {
        ev.preventDefault();
        first.focus();
      } else if (ev.shiftKey && here === first) {
        ev.preventDefault();
        last.focus();
      }
    }

    function onKey(ev) {
      if (ev.key === 'Escape') { dismiss(); return; }
      if (ev.key === 'Tab') trap(ev);
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
