/**
 * shared/focus.js — 전체 재렌더를 가로지르는 포커스·캐럿 보존.
 *
 * 이 앱의 렌더 규약은 "이벤트 → state → 전체 재작성" 이다. 노드가 통째로 갈리므로
 * 그 안에 있던 포커스와 캐럿, 그리고 **조합 중인 한글**이 사라진다. 그래서 재작성 직전에
 * "어느 칸이었는지" 를 안정된 키로 적어 두고, 직후에 같은 키의 칸으로 되돌려 놓는다.
 *
 * 규약 — 되살리고 싶은 입력 요소에 `data-fkey` 를 붙인다. 키는 DOM 위치가 아니라 **내용**이어야
 * 재렌더로 순서가 바뀌어도 같은 칸을 찾는다.
 *   답안 칸   : `ans:<questionId>:<fieldIndex>`   (JPK.focus.ansKey 가 만든다)
 *   이의 제기 : `report:<questionId>`
 *
 *   JPK.focus.capture(root) → {key, start, end} | null
 *   JPK.focus.restore(root, captured)
 *   JPK.focus.ansKey(qid, fieldIndex)
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var doc = global.document;

  function ansKey(qid, fieldIndex) {
    return 'ans:' + qid + ':' + fieldIndex;
  }

  /** root 안에서 지금 포커스된 `[data-fkey]` 요소의 키와 선택 범위. 없으면 null. */
  function capture(root) {
    if (!root) return null;
    var a = doc.activeElement;
    if (!a || !root.contains(a) || !a.getAttribute) return null;
    var key = a.getAttribute('data-fkey');
    if (!key) return null;
    var out = { key: key, start: null, end: null };
    try {
      out.start = a.selectionStart;
      out.end = a.selectionEnd;
    } catch (e) { /* number/checkbox 등 선택 범위가 없는 입력 */ }
    return out;
  }

  /** capture 가 돌려준 값을 새로 만든 서브트리에 적용한다. 못 찾으면 아무것도 하지 않는다. */
  function restore(root, f) {
    if (!root || !f || !f.key) return;
    var list = root.querySelectorAll('[data-fkey]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-fkey') !== f.key) continue;
      try {
        list[i].focus();
        if (f.start != null && list[i].setSelectionRange) list[i].setSelectionRange(f.start, f.end);
      } catch (e) { /* 무시 */ }
      return;
    }
  }

  JPK.focus = {
    capture: capture,
    restore: restore,
    ansKey: ansKey,
  };
})(window);
