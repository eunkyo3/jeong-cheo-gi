/**
 * shared/qbody.js — 문항 본문(bodyHtml)·해설(explanationHtml)을 화면에 넣기 직전의 손질.
 *
 * 원본 데이터(data/rounds/*.json)는 **절대 건드리지 않는다**. 표시할 때만 두 가지를 한다.
 *
 *   wrapTables   : `<table>` 을 `.tbl-scroll` 가로 스크롤 상자로 감싼다.
 *                  `table.tbl` 은 `th{white-space:nowrap}` 이라 스스로 줄어들지 못한다 —
 *                  감싸지 않으면 표가 든 문항(전체의 14.5%)이 좁은 화면에서 카드를 밀어낸다.
 *   applyCodeFmt : 탭·공백이 뒤섞인 `pre.code` 들여쓰기를 codefmt.js 로 정규화한다.
 *                  스크립트가 없거나 던지면 조용히 원문을 그대로 둔다(표시 실패는 무해하다).
 *
 * 예전에는 학습 화면에만 wrapTables 가 있고 대전 화면에는 없었다. 두 화면이 같은 문항을 그리므로
 * 손질도 한 함수(`decorate`)로 묶어 둔다 — 새 화면이 생겨도 한쪽만 빠지지 않는다.
 *
 *   JPK.qbody.decorate(node, lang) → node   (wrapTables + applyCodeFmt)
 *   JPK.qbody.wrapTables(node)
 *   JPK.qbody.applyCodeFmt(node, lang) → node
 */
(function (global) {
  'use strict';

  var JPK = global.JPK = global.JPK || {};
  var doc = global.document;

  /** 좁은 화면에서 표가 카드를 밀어내지 않도록 가로 스크롤 상자로 감싼다. */
  function wrapTables(container) {
    if (!container || !container.querySelectorAll) return container;
    var tables = container.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      var parent = t.parentNode;
      if (!parent) continue;
      if (parent.classList && parent.classList.contains('tbl-scroll')) continue;
      var box = doc.createElement('div');
      box.className = 'tbl-scroll';
      parent.insertBefore(box, t);
      box.appendChild(t);
    }
    return container;
  }

  /**
   * 코드 블록 들여쓰기 정규화. **카드를 만드는 시점에만** 부른다 —
   * 입력 이벤트에서 카드를 다시 만들지 않는다는 규칙(한글 IME 보호)은 그대로다.
   */
  function applyCodeFmt(node, lang) {
    if (!node || !global.CodeFmt || typeof global.CodeFmt.applyTo !== 'function') return node;
    try {
      global.CodeFmt.applyTo(node, JPK.qmeta.normalizeLang(lang) || null);
    } catch (e) { /* 표시용 정규화다 — 실패하면 원문을 그대로 둔다 */ }
    return node;
  }

  /** 문항 본문·해설 노드에 두 손질을 한 번에. 표를 먼저 감싸고 코드를 정돈한다. */
  function decorate(node, lang) {
    wrapTables(node);
    return applyCodeFmt(node, lang);
  }

  JPK.qbody = {
    wrapTables: wrapTables,
    applyCodeFmt: applyCodeFmt,
    decorate: decorate,
  };
})(window);
