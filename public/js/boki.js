/**
 * boki.js — 문항 지문의 `<div class="boki">` (보기) 블록에서 선택지를 뽑는 파서.
 *
 * 학습(study.js)과 대전(battle.js)이 같은 규칙으로 보기 칩을 만들어야 하므로 파서는 여기 하나뿐이다.
 * DOM 을 만지지 않는 순수 함수라서 headless 에서 그대로 단위 검사할 수 있다.
 *
 *   window.Boki = {
 *     parse(text)                  -> [{marker, text, raw}]   (2개 미만/20개 초과면 [])
 *     fillValue(item, promptText)  -> string                  (입력칸에 채울 값)
 *     textFromNode(node)           -> string                  (.boki 엘리먼트 → parse 에 넣을 텍스트)
 *   }
 *
 * 파싱 규칙 — 실제 데이터(보기 있는 52문항)를 보고 세 단계로 나눴다. 앞 단계가 성공하면 뒤는 보지 않는다.
 *   1) 마커: 맨 앞이 `ㄱ.` `1.` `A)` `①` `㉠` 같은 마커로 시작하고 마커가 2개 이상일 때.
 *   2) 줄: 마커가 없어도 `<br>`/`&emsp;`/줄바꿈으로 2줄 이상 갈리고 각 줄이 짧은 항목일 때.
 *   3) 구분자: 한 줄뿐이면 ` / ` 또는 `, ` 로 나눠 본다.
 * 2·3 단계는 서술형 지문(문장)이 잘려 나가지 않도록 "문장으로 끝나면(…다./…요.) 보기가 아니다"
 * 로 걸러 낸다. 걸러지면 조용히 [] — 칩 없이 지금처럼 타이핑만 하면 된다.
 */
(function (root) {
  'use strict';

  var MIN_ITEMS = 2;
  var MAX_ITEMS = 20;

  // 마커 한 개. (가) 구두점을 요구하는 글자형 (나) 그 자체로 구분되는 원문자형.
  var MARKER_PUNCT = '(?:[\\u3131-\\u314E]|[A-Za-z]|\\d{1,2}|[\\uAC00-\\uD7A3])\\s*[.)]';
  var MARKER_CIRCLE = '[\\u2460-\\u2473\\u3260-\\u327E][.)]?';
  // 줄 첫머리(또는 공백 뒤)에서만 마커로 인정한다 — 문장 끝의 "…한다." 를 마커로 오인하지 않게.
  var MARKER_RE = new RegExp('(^|\\s)(' + MARKER_CIRCLE + '|' + MARKER_PUNCT + ')(?=\\s|$)', 'g');

  // 항목 한 개의 길이 상한. 이보다 길면 보기 목록이 아니라 서술로 본다.
  var MAX_ITEM_LEN = 60;
  var MAX_PLAIN_ITEM_LEN = 40;   // 마커 없는 항목은 더 짧아야 한다

  /** "이름 : 설명" 꼴 — 이름만 답으로 쓴다. */
  var NAMED_RE = /^([^:：]{1,24}?)\s*[:：]\s+\S/;

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s
      .replace(/&emsp;/gi, ' ')
      .replace(/&ensp;/gi, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/gi, '&');
  }

  /**
   * parse 에 넣을 문자열로 다듬는다.
   * 호출자가 텍스트(textContent)를 주든 HTML 조각을 주든 같은 결과가 되게 한다 —
   * `<br>` 은 textContent 에서 사라져 항목이 붙어 버리므로 HTML 이면 먼저 줄바꿈으로 바꾼다.
   */
  function normalize(input) {
    var s = String(input == null ? '' : input);
    if (/<br\s*\/?>/i.test(s)) s = s.replace(/<br\s*\/?>/gi, '\n');
    if (/<[a-zA-Z\/!]/.test(s)) s = s.replace(/<[^>]*>/g, '');
    s = decodeEntities(s);
    // 구분자(전각 공백·탭·CR)를 전부 줄바꿈 하나로 모은다.
    s = s.replace(/\r/g, '\n')
      .replace(/[    \t]+/g, '\n')
      .replace(/[ ​]/g, ' ');
    // 앞머리의 "[보기]" 표지는 항목이 아니다.
    s = s.replace(/^\s*\[?\s*보기\s*\]?\s*/, '');
    return s;
  }

  /** 문장으로 끝나면(…다. …요. …임.) 보기 항목이 아니라 서술이다. */
  function looksLikeSentence(s) {
    return /[다요임음것오]\s*[.!?]$/.test(s) || /[.!?]\s+\S/.test(s);
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function makeItem(marker, text, raw) {
    return { marker: clean(marker), text: clean(text), raw: clean(raw) };
  }

  /** 1단계 — 마커로 자른다. 마커가 2개 이상이고 첫 마커가 맨 앞에 있어야 한다. */
  function parseByMarker(s) {
    var body = s.replace(/^\s+/, '');
    var hits = [];
    var m;
    MARKER_RE.lastIndex = 0;
    while ((m = MARKER_RE.exec(body)) !== null) {
      hits.push({ at: m.index + m[1].length, marker: m[2], end: m.index + m[0].length });
      if (m.index === MARKER_RE.lastIndex) MARKER_RE.lastIndex++;   // 빈 매치 보호
    }
    if (hits.length < MIN_ITEMS || hits.length > MAX_ITEMS) return [];
    if (hits[0].at !== 0) return [];   // 목록은 맨 앞에서 시작한다

    var seen = {};
    var items = [];
    for (var i = 0; i < hits.length; i++) {
      var stop = i + 1 < hits.length ? hits[i + 1].at : body.length;
      var marker = hits[i].marker.replace(/\s*[.)]\s*$/, '');
      // 마커가 겹치면(문장 끝을 마커로 잘못 잡은 경우) 목록이 아니다.
      if (seen[marker]) return [];
      seen[marker] = true;
      var item = makeItem(marker, body.slice(hits[i].end, stop), body.slice(hits[i].at, stop));
      if (!item.text || item.text.length > MAX_ITEM_LEN) return [];
      items.push(item);
    }
    return items;
  }

  /** 마커 없는 항목 묶음의 공통 검사 + "이름 : 설명" 처리. */
  function plainItems(parts) {
    if (parts.length < MIN_ITEMS || parts.length > MAX_ITEMS) return [];
    var named = true;
    var i;
    for (i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p.length > MAX_ITEM_LEN || looksLikeSentence(p)) return [];
      if (!NAMED_RE.test(p)) named = false;
    }
    var items = [];
    for (i = 0; i < parts.length; i++) {
      if (named) {
        items.push(makeItem('', NAMED_RE.exec(parts[i])[1], parts[i]));
      } else {
        if (parts[i].length > MAX_PLAIN_ITEM_LEN) return [];
        items.push(makeItem('', parts[i], parts[i]));
      }
    }
    return items;
  }

  function splitLines(s) {
    return s.split('\n').map(clean).filter(function (x) { return x !== ''; });
  }

  /** 3단계 — 한 줄짜리를 ` / ` 또는 `, ` 로 나눈다. */
  function parseByDelimiter(line) {
    var byslash = line.split(/\s+\/\s+/).map(clean).filter(function (x) { return x !== ''; });
    if (byslash.length >= MIN_ITEMS) {
      var slashItems = plainItems(byslash);
      if (slashItems.length) return slashItems;
    }
    var bycomma = line.split(/\s*,\s+/).map(clean).filter(function (x) { return x !== ''; });
    if (bycomma.length >= MIN_ITEMS) return plainItems(bycomma);
    return [];
  }

  /**
   * 보기 텍스트 → 선택지 배열. 보기로 볼 수 없으면 빈 배열.
   * @param {string} text `.boki` 의 텍스트(또는 HTML 조각)
   * @returns {Array<{marker:string,text:string,raw:string}>}
   */
  function parse(text) {
    var s = normalize(text);
    if (!clean(s)) return [];

    var byMarker = parseByMarker(s);
    if (byMarker.length >= MIN_ITEMS) return byMarker;

    var lines = splitLines(s);
    if (lines.length >= MIN_ITEMS) return plainItems(lines);
    if (lines.length === 1) return parseByDelimiter(lines[0]);
    return [];
  }

  /**
   * 칩을 눌렀을 때 입력칸에 채울 값.
   * 문항 prompt 에 "기호" 가 있으면 마커만(예 'ㄱ'), 아니면 마커 뒤 본문 전체를 넣는다.
   * @param {{marker:string,text:string}} item
   * @param {string} promptText 문항 prompt 의 텍스트(HTML 제거)
   */
  function fillValue(item, promptText) {
    if (!item) return '';
    var wantsMarker = String(promptText == null ? '' : promptText).indexOf('기호') >= 0;
    if (wantsMarker && item.marker) return item.marker;
    return item.text || item.marker || '';
  }

  /**
   * `.boki` 엘리먼트에서 parse 에 넣을 텍스트를 뽑는다 (`<br>` 을 줄바꿈으로 살린다).
   * DOM 이 필요한 유일한 함수라 parse 와 분리해 둔다.
   */
  function textFromNode(node) {
    if (!node) return '';
    if (typeof node.innerHTML === 'string') return node.innerHTML;
    return String(node.textContent || '');
  }

  root.Boki = { parse: parse, fillValue: fillValue, textFromNode: textFromNode };
}(typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : this)));
