/**
 * codefmt.js — 문항 본문의 `<pre class="code">` 블록을 **표시 시점에** 정규화하는 들여쓰기 포매터.
 *
 * 원본 데이터(`data/rounds/*.json`)는 손대지 않는다(계약 C9). 기출 원문이 탭·공백을 섞어 쓰고
 * 닫는 중괄호가 제멋대로라(2020~2021 회차가 특히 심하다) 화면에 뿌리기 직전에 여기서 다듬는다.
 *
 *   window.CodeFmt = {
 *     LANGS,                          // ['c','java','python']
 *     detect(codeText)   -> lang|null // 코드 텍스트만 보고 언어 추정
 *     normalize(text, lang) -> string // 정규화된 코드 텍스트
 *     applyTo(rootEl, lang) -> number // root 아래 pre.code 를 제자리 교체, 바뀐 개수
 *   }
 *
 * 정규화 규칙 (계약 C6)
 *   공통 — CRLF→LF, 탭→공백(탭 정지 4칸 기준의 **열 인식** 확장), 줄 끝 공백 제거,
 *          앞뒤 빈 줄 제거, 비어 있지 않은 줄들의 공통 선행 들여쓰기 제거.
 *   c/java — 위에 더해 중괄호 깊이 기준 4칸 재들여쓰기. 문자열/문자 리터럴/`//`/`/* *\/` 안의
 *          괄호·중괄호는 세지 않는다(블록 주석은 줄을 넘어가도 상태를 이어 간다).
 *          단 **여는 중괄호가 하나도 없는 블록은 건드리지 않는다** — 코드 문항 안에도
 *          `pre.code` 로 들어온 ASCII 순서도가 있고(2025-1#15 둘째 블록), 재들여쓰면 무너진다.
 *   python / 미분류 — **줄 구조를 절대 바꾸지 않는다.** 위의 공통 정규화만.
 *
 * 오분류의 대가가 가장 큰 쪽이 python 이라 detect 는 **가린 사본에서, python 을 먼저** 본다.
 *
 * 멱등: normalize(normalize(x, lang), lang) === normalize(x, lang).
 * DOM 을 쓰는 함수는 applyTo 하나뿐이라 나머지는 node 에서 그대로 단위 검사할 수 있다.
 */
(function (root) {
  'use strict';

  var LANGS = ['c', 'java', 'python'];
  var TAB_WIDTH = 4;
  var INDENT_UNIT = '    ';

  // ---------------------------------------------------------------- 작은 도구들

  function repeat(s, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += s;
    return out;
  }

  function isLang(v) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i] === v) return true;
    return false;
  }

  /** 탭을 **열 기준**으로 편다. 무턱대고 4칸으로 바꾸면 원문의 정렬이 어긋난다. */
  function expandTabs(line) {
    if (line.indexOf('\t') < 0) return line;
    var out = '';
    var col = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (ch === '\t') {
        var pad = TAB_WIDTH - (col % TAB_WIDTH);
        out += repeat(' ', pad);
        col += pad;
      } else {
        out += ch;
        col++;
      }
    }
    return out;
  }

  function isBlank(line) {
    return /^\s*$/.test(line);
  }

  function leadingSpaces(line) {
    var n = 0;
    while (n < line.length && line.charAt(n) === ' ') n++;
    return n;
  }

  /** 비어 있지 않은 줄들의 공통 선행 공백을 걷어낸다. */
  function stripCommonIndent(lines) {
    var min = -1;
    var i;
    for (i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      var n = leadingSpaces(lines[i]);
      if (min < 0 || n < min) min = n;
    }
    if (min <= 0) return lines;
    var out = [];
    for (i = 0; i < lines.length; i++) {
      out.push(isBlank(lines[i]) ? '' : lines[i].slice(min));
    }
    return out;
  }

  /** 앞뒤의 빈 줄을 잘라낸다. */
  function trimBlankEdges(lines) {
    var a = 0;
    var b = lines.length;
    while (a < b && isBlank(lines[a])) a++;
    while (b > a && isBlank(lines[b - 1])) b--;
    return lines.slice(a, b);
  }

  /** 공통 정규화 — 여기까지는 어떤 언어든 똑같이 한다. */
  function baseLines(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var raw = src.split('\n');
    var lines = [];
    for (var i = 0; i < raw.length; i++) {
      lines.push(expandTabs(raw[i]).replace(/[ \t]+$/, ''));
    }
    return stripCommonIndent(trimBlankEdges(lines));
  }

  // ------------------------------------------------------- C/Java 어휘 스캐너

  /**
   * 한 줄에서 문자열·문자 리터럴·주석을 공백으로 덮은 사본을 만든다.
   * 중괄호/괄호 세기와 키워드 판정은 전부 이 "가린 줄" 위에서만 한다.
   * @param {string} line
   * @param {{inBlock:boolean}} state 블록 주석 진행 여부 (호출 간 이어진다)
   */
  function maskLine(line, state) {
    var out = '';
    var i = 0;
    var n = line.length;
    while (i < n) {
      var ch = line.charAt(i);
      if (state.inBlock) {
        if (ch === '*' && line.charAt(i + 1) === '/') {
          state.inBlock = false;
          out += '  ';
          i += 2;
        } else {
          out += ' ';
          i++;
        }
        continue;
      }
      if (ch === '/' && line.charAt(i + 1) === '/') {
        while (i < n) { out += ' '; i++; }
        break;
      }
      if (ch === '/' && line.charAt(i + 1) === '*') {
        state.inBlock = true;
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'") {
        var quote = ch;
        out += ' ';
        i++;
        while (i < n) {
          var c2 = line.charAt(i);
          if (c2 === '\\') {
            out += ' ';
            i++;
            if (i < n) { out += ' '; i++; }
            continue;
          }
          out += ' ';
          i++;
          if (c2 === quote) break;
        }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  /** 줄 배열을 통째로 가린다 (블록 주석 상태를 줄 사이로 이어 가며). */
  function maskAllLines(lines) {
    var state = { inBlock: false };
    var out = [];
    for (var i = 0; i < lines.length; i++) out.push(maskLine(lines[i], state));
    return out;
  }

  /** 가린 줄 전체(여러 줄)를 한 번에 만든다 — detect 와 코드 판정용. */
  function maskAll(text) {
    return maskAllLines(String(text).replace(/\r\n?/g, '\n').split('\n')).join('\n');
  }

  var CTRL_HEAD_RE = /^(?:\}\s*)?(?:else\s+if|if|for|while)\s*\(/;

  /**
   * 중괄호 없는 제어문 머리(`if (...)`, `else`, `for (...)`, `while (...)`, `do`)인가.
   *
   * 핵심은 **조건 괄호를 닫은 뒤에 아무것도 없어야** 한다는 것. 기출에는
   * `if (input == 0) break` (2023-1#9, 세미콜론 누락) 처럼 몸통이 같은 줄에 붙은 채
   * 끝나는 줄이 있어서, 단순히 "`;` 로 안 끝난다" 로만 보면 다음 줄까지 밀려 버린다.
   */
  function isBracelessHeader(code) {
    if (!code) return false;
    if (code.charAt(0) === '#') return false;
    if (/[{};,]$/.test(code)) return false;
    if (/^(?:\}\s*)?else$/.test(code)) return true;
    if (/^do$/.test(code)) return true;

    var m = CTRL_HEAD_RE.exec(code);
    if (!m) return false;
    var depth = 0;
    for (var i = m[0].length - 1; i < code.length; i++) {
      var c = code.charAt(i);
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i === code.length - 1;   // 닫는 괄호가 줄의 마지막 글자여야 한다
      }
    }
    return false;   // 괄호가 안 닫혔다 = 이어지는 줄이지 머리가 아니다
  }

  /** `{` 없이 끝나는 클래스/인터페이스 머리인가 (원본에서 여는 중괄호가 빠진 경우). */
  var CLASS_HEAD_RE =
    /^(?:(?:public|private|protected|static|final|abstract)\s+)*(?:class|interface)\s+\w/;

  function isClassHeader(code) {
    return CLASS_HEAD_RE.test(code);
  }

  /** `case …:` / `default:` 라벨인가. */
  function isCaseLabel(code) {
    return /^case\b[^;]*:/.test(code) || /^default\s*:/.test(code);
  }

  /**
   * 정말 중괄호 문법의 코드인가.
   *
   * 코드 문항 안에도 `pre.code` 로 들어온 **ASCII 순서도**(2025-1#15 둘째 블록 같은)가 있다.
   * 문항 언어가 c/java 라고 그걸 깊이 기준으로 다시 들여쓰면 그림이 무너진다.
   * 세미콜론은 기준이 못 된다 — 의사코드 순서도에도 `PRINT X;` 같은 줄이 나온다.
   * **여는 중괄호가 하나도 없으면** 재들여쓰기할 깊이 자체가 없으므로 손대지 않는다.
   * (리터럴·주석 안의 `{` 는 세지 않으려고 가린 사본에서 본다.)
   */
  function looksLikeBraceCode(maskedLines) {
    for (var i = 0; i < maskedLines.length; i++) {
      if (maskedLines[i].indexOf('{') >= 0) return true;
    }
    return false;
  }

  // Python 임이 강하게 드러나는 줄 모양. 가린 사본에서만 본다.
  var PY_STRONG = [
    /^[ \t]*def\s+\w/,
    /^[ \t]*class\s+\w[\w.,()\[\] ]*:[ \t]*$/,
    /^[ \t]*(?:if|for|while|elif|else)\b.*:[ \t]*$/,
    /^[ \t]*print\s*\(/
  ];

  /**
   * 분류가 c/java 라고 되어 있어도 소스가 사실은 Python 인가.
   *
   * `data/langs` 는 사람이 손보는 오버레이라 언젠가 틀릴 수 있는데, Python 을
   * 중괄호 깊이로 다시 들여쓰면 **줄 구조가 곧 의미인 코드가 파괴된다**(되돌릴 수도 없다).
   * 그래서 마지막 봉인을 하나 둔다 — Python 특유의 줄이 둘 이상이고 `;` 로 끝나는 줄이
   * 하나도 없으면(진짜 C/Java 블록에는 거의 언제나 있다) 재들여쓰기를 포기한다.
   */
  function looksLikePython(maskedLines) {
    var strong = 0;
    var i, j;
    for (i = 0; i < maskedLines.length; i++) {
      var line = maskedLines[i];
      if (/^\s*$/.test(line)) continue;
      if (/;[ \t]*$/.test(line)) return false;   // C/Java 의 확실한 표식
      for (j = 0; j < PY_STRONG.length; j++) {
        if (PY_STRONG[j].test(line)) { strong++; break; }
      }
    }
    return strong >= 2;
  }

  function countChar(s, ch) {
    var n = 0;
    for (var i = 0; i < s.length; i++) if (s.charAt(i) === ch) n++;
    return n;
  }

  // ------------------------------------------------------- C/Java 재들여쓰기

  /**
   * 중괄호 깊이로 다시 들여쓴다.
   *
   * 블록마다 프레임을 쌓아 두 값을 들고 있다.
   *   indent     — 그 블록 **안** 문장의 들여쓰기 칸수
   *   openIndent — 그 블록을 **연 줄**의 들여쓰기 칸수 (닫는 `}` 가 설 자리)
   * 덕분에 switch 의 `case` 가 더한 한 칸이 중첩 블록에는 따라가면서도,
   * 블록을 닫는 `}` 는 언제나 연 줄과 같은 열에 정확히 선다.
   */
  function reindentBraces(lines) {
    var stack = [{ indent: 0, openIndent: 0, isSwitch: false, caseOpen: false, virtual: false }];
    var mask = { inBlock: false };
    var parenDepth = 0;   // 이전 줄에서 안 닫힌 괄호
    var pending = 0;      // 중괄호 없는 제어문 머리가 다음 줄에 얹는 칸수
    var blockOrigBase = 0;
    var blockOutBase = 0;
    var out = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (isBlank(line)) { out.push(''); continue; }

      var origIndent = leadingSpaces(line);
      var body = line.replace(/^\s+/, '');
      var wasInBlock = mask.inBlock;
      var parenAtStart = parenDepth;
      var masked = maskLine(line, mask).replace(/^\s+/, '').replace(/\s+$/, '');

      // ① 블록 주석 이어지는 줄 — 주석 본문은 다시 흘리지 않고 상대 들여쓰기만 유지한다.
      if (wasInBlock) {
        var rel = blockOutBase + (origIndent - blockOrigBase);
        if (rel < 0) rel = 0;
        out.push(repeat(' ', rel) + body);
        parenDepth += countChar(masked, '(') - countChar(masked, ')');
        if (parenDepth < 0) parenDepth = 0;
        continue;
      }

      // ② 전처리기 — 언제나 0열, 상태에는 손대지 않는다.
      if (body.charAt(0) === '#') {
        out.push(body);
        if (mask.inBlock) { blockOrigBase = origIndent; blockOutBase = 0; }
        continue;
      }

      // ③ 주석/공백뿐인 줄 — 현재 깊이로만 맞추고 pending 은 건드리지 않는다.
      var codeOnly = masked;
      var top = stack[stack.length - 1];

      if (codeOnly === '') {
        var cbase = top.indent + (top.isSwitch && top.caseOpen ? 1 : 0) + pending;
        if (parenAtStart > 0) cbase += 1;
        if (cbase < 0) cbase = 0;
        out.push(repeat(INDENT_UNIT, cbase) + body);
        if (mask.inBlock) { blockOrigBase = origIndent; blockOutBase = cbase * 4; }
        continue;
      }

      // ④ 여는 중괄호가 빠진 클래스 머리(2020-2#5)를 위해 세워 둔 가상 프레임 정리.
      //    Allman 의 홀로 선 `{` 나 다음 클래스 머리를 만나면 가상 프레임은 역할이 끝난다.
      if (codeOnly.charAt(0) === '{' || isClassHeader(codeOnly)) {
        while (stack.length > 1 && stack[stack.length - 1].virtual) stack.pop();
      }

      // ⑤ 닫는 중괄호로 시작하면 먼저 내어쓴다 (`}` `};` `} else {` `} while (…);`).
      //    이 줄은 **블록을 연 줄과 같은 열**에 선다 — case 보정도 이어지는 괄호도 얹지 않는다.
      var lead = 0;
      var closes = 0;
      var reopen = 0;
      while (lead < codeOnly.length && (codeOnly.charAt(lead) === '}' || codeOnly.charAt(lead) === ' ')) {
        if (codeOnly.charAt(lead) === '}') {
          closes++;
          reopen = stack.length > 1 ? stack.pop().openIndent : 0;
        }
        lead++;
      }
      top = stack[stack.length - 1];

      // ⑥ 이 줄의 들여쓰기 계산
      if (closes > 0 || codeOnly.charAt(0) === '{') pending = 0;
      var label = isCaseLabel(codeOnly);
      var caseExtra = (closes === 0 && top.isSwitch && top.caseOpen && !label) ? 1 : 0;
      var baseIndent = closes > 0 ? reopen : top.indent + caseExtra + pending;
      if (baseIndent < 0) baseIndent = 0;
      var renderIndent = baseIndent + ((closes === 0 && parenAtStart > 0) ? 1 : 0);
      out.push(repeat(INDENT_UNIT, renderIndent) + body);
      if (mask.inBlock) { blockOrigBase = origIndent; blockOutBase = renderIndent * 4; }

      if (label && top.isSwitch) top.caseOpen = true;

      // ⑦ 남은 중괄호 처리 — `{` 마다 한 칸씩 더 쌓는다(`if (a) { if (b) {` 처럼 한 줄에 둘일 수도).
      var opensSwitch = /\bswitch\s*\(/.test(codeOnly);
      var running = baseIndent;
      var pushedBrace = false;
      var markedSwitch = false;
      for (var k = lead; k < codeOnly.length; k++) {
        var c = codeOnly.charAt(k);
        if (c === '{') {
          running += 1;
          var frame = {
            indent: running,
            // 한 줄에 `{` 가 여럿이면 안쪽 블록은 바깥 블록의 몸통 열에서 닫혀야 한다.
            openIndent: running - 1,
            isSwitch: false,
            caseOpen: false,
            virtual: false
          };
          if (opensSwitch && !markedSwitch) { frame.isSwitch = true; markedSwitch = true; }
          stack.push(frame);
          pushedBrace = true;
        } else if (c === '}') {
          if (stack.length > 1) stack.pop();
          running -= 1;
          if (running < baseIndent) running = baseIndent;
        }
      }

      // ⑧ 다음 줄로 넘길 상태
      // 블록을 연 줄에서는 괄호 연속 상태를 끊는다 — `list.forEach(x -> {` 다음 줄이
      // 블록 본문(+1)이지 인자 이어쓰기(+2)가 아니기 때문.
      parenDepth = pushedBrace
        ? 0
        : parenAtStart + countChar(codeOnly, '(') - countChar(codeOnly, ')');
      if (parenDepth < 0) parenDepth = 0;

      if (parenAtStart === 0 && parenDepth === 0 && isBracelessHeader(codeOnly)) {
        pending = pending + 1;
      } else {
        pending = 0;
        // `{` 없이 끝난 클래스 머리 — 아래 멤버들이 0열로 평탄해지지 않게 가상 블록을 연다.
        if (!pushedBrace && closes === 0 && parenDepth === 0 &&
            isClassHeader(codeOnly) && !/[{};]$/.test(codeOnly)) {
          stack.push({
            indent: baseIndent + 1,
            openIndent: baseIndent,
            isSwitch: false,
            caseOpen: false,
            virtual: true
          });
        }
      }
    }

    return stripCommonIndent(out);
  }

  // -------------------------------------------------------------- 공개 API

  var JAVA_RE = /System\s*\.\s*out|public\s+static\s+void|public\s+class\b|String\s*\[\s*\]/;
  var C_RE = /#include|printf\s*\(|scanf\s*\(|\bint\s+main\b|\bvoid\s+main\b/;
  var PY_RE = new RegExp(
    '^[ \\t]*(' + [
      'def\\s+\\w',
      'class\\s+\\w[\\w.,()\\[\\] ]*:\\s*$',
      'print\\s*\\(',
      'import\\s+\\w',
      'from\\s+\\w[\\w.]*\\s+import\\b',
      'for\\s+.+\\s+in\\s+.+:\\s*$',
      'while\\s+.+:\\s*$',
      'elif\\s+.+:\\s*$',
      'else\\s*:\\s*$',
      'if\\s+.+:\\s*$'
    ].join('|') + ')',
    'm'
  );

  /**
   * 코드 텍스트만 보고 언어를 추정한다. 확신이 없으면 null.
   *
   * 두 가지를 지킨다.
   *   ① **가린 사본**에서 본다 — Python 문자열 안의 `"System.out"` 이나 `"printf("` 가
   *      Java·C 신호로 새면 그 블록이 중괄호 재들여쓰기를 타서 파괴된다.
   *   ② **Python 을 먼저** 본다 — Python 은 줄 구조가 곧 의미라 오판의 대가가 가장 크다.
   *      (남은 둘 사이에서는 Java 가 C 보다 먼저다. C 에 `System.out` 은 안 나오지만
   *      Java 에 `printf` 는 흔하다.)
   * @param {string} codeText
   * @returns {'c'|'java'|'python'|null}
   */
  function detect(codeText) {
    var s = String(codeText == null ? '' : codeText);
    if (!s) return null;
    var masked = maskAll(s);
    if (PY_RE.test(masked)) return 'python';
    if (JAVA_RE.test(masked)) return 'java';
    if (C_RE.test(masked)) return 'c';
    return null;
  }

  /**
   * 코드 텍스트를 정규화한다.
   * @param {string} text `pre.code` 의 textContent
   * @param {'c'|'java'|'python'|null} [lang] 없으면 detect 로 추정
   * @returns {string}
   */
  function normalize(text, lang) {
    var src = String(text == null ? '' : text);
    if (!src) return '';
    var lines = baseLines(src);
    if (!lines.length) return '';

    var use = isLang(lang) ? lang : detect(src);
    if (use === 'c' || use === 'java') {
      var masked = maskAllLines(lines);
      // 여는 중괄호가 있고(= 다시 들여쓸 깊이가 있고), Python 으로 보이지 않을 때만 손댄다.
      if (looksLikeBraceCode(masked) && !looksLikePython(masked)) lines = reindentBraces(lines);
    }

    return lines.join('\n');
  }

  /** `pre.code` 이고 자식 엘리먼트가 없는가. */
  function isPlainCodePre(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (tag !== 'pre') return false;
    var cls = typeof el.className === 'string' ? el.className : String((el.getAttribute && el.getAttribute('class')) || '');
    if (!/(^|\s)code(\s|$)/.test(cls)) return false;
    var kids = el.children;
    if (kids && typeof kids.length === 'number') return kids.length === 0;
    var nodes = el.childNodes || [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) return false;
    return true;
  }

  /**
   * root 아래(root 자신 포함) 의 `pre.code` 텍스트를 정규화 결과로 바꾼다.
   * 자식 엘리먼트가 있는 블록은 마크업이 날아가므로 건너뛴다.
   * @param {Element} rootEl
   * @param {'c'|'java'|'python'|null} [lang]
   * @returns {number} 실제로 바뀐 블록 수
   */
  function applyTo(rootEl, lang) {
    if (!rootEl || typeof rootEl !== 'object') return 0;
    var targets = [];
    if (isPlainCodePre(rootEl)) targets.push(rootEl);
    if (typeof rootEl.querySelectorAll === 'function') {
      var list = rootEl.querySelectorAll('pre.code');
      for (var i = 0; i < list.length; i++) {
        if (isPlainCodePre(list[i])) targets.push(list[i]);
      }
    }
    var changed = 0;
    for (var j = 0; j < targets.length; j++) {
      var el = targets[j];
      var before = String(el.textContent == null ? '' : el.textContent);
      var after = normalize(before, lang);
      if (after !== before) {
        el.textContent = after;
        changed++;
      }
    }
    return changed;
  }

  root.CodeFmt = {
    LANGS: LANGS,
    detect: detect,
    normalize: normalize,
    applyTo: applyTo
  };
}(typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : this)));
