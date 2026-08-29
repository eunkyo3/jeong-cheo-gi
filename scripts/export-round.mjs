#!/usr/bin/env node
/**
 * export-round.mjs — 회차 JSON → 자기완결(offline) 단일 HTML 파일
 *
 *   npm run export:round -- 2026-2
 *   node scripts/export-round.mjs 2026-2
 *
 * 출력: dist/<round>.html
 *
 * 원칙
 *  - 채점 로직은 손으로 다시 쓰지 않는다. `server/grader.js` 원문을 그대로 읽어
 *    `module.exports` 블록만 잘라내고 IIFE 로 감싸 브라우저에 삽입한다.
 *    (두 번째 구현이 생기면 서버/내보내기 판정이 갈라진다 — 금지.)
 *  - 스타일은 원본 자산(정보처리기사_실기_2026년_2회.html)에서 그대로 뽑아
 *    scripts/export-assets/exam.css 로 보관한 것을 인라인한다.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join('/');
const ROOT = path.resolve(HERE, '..').split(path.sep).join('/');

const BANNER_TEXT = '개인 학습용 · 대전 사용 금지';

/**
 * prompt 에 허용하는 인라인 태그(소문자 표기만).
 * `<A>` `<B>` `<학생>` 처럼 "테이블 이름"으로 쓰인 꺾쇠는 태그가 아니므로 이스케이프한다.
 * `a`(링크)는 발문에 필요 없으므로 의도적으로 제외한다.
 */
const INLINE_TAG_ALLOWLIST = new Set([
  'b', 'br', 'code', 'em', 'i', 'small', 'span', 'strong', 'sub', 'sup', 'u',
]);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 발문(prompt) 정제: 허용 인라인 태그는 통과, 그 외 `<...>` 는 화면에 보이도록 이스케이프.
 * 엔티티(&nbsp; 등)는 원본 자산과 동일하게 살려 둔다.
 */
function sanitizePrompt(html) {
  return String(html == null ? '' : html).replace(/<[^>]*>|</g, (tok) => {
    if (tok === '<') return '&lt;';
    const m = tok.match(/^<\/?([A-Za-z][A-Za-z0-9]*)\s*\/?>$/);
    if (m && INLINE_TAG_ALLOWLIST.has(m[1])) return tok;
    return tok.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
}

/** <script> 안에 JSON 을 안전하게 심는다(</script>, U+2028/9 차단). */
function embedJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, function (ch) {
    return '\\u' + ('000' + ch.charCodeAt(0).toString(16)).slice(-4);
  });
}



/** server/grader.js 원문 → 브라우저용 IIFE 본문 (module.exports 이후만 제거) */
export function graderBrowserSource(graderSrc) {
  const marker = graderSrc.indexOf('module.exports');
  if (marker === -1) throw new Error('grader.js: module.exports 블록을 찾지 못했습니다.');
  const body = graderSrc.slice(0, marker).replace(/'use strict';\s*/, '');
  if (body.indexOf('</script') !== -1) throw new Error('grader.js: </script 시퀀스 포함 — 삽입 불가');
  return body;
}

const EXTRA_CSS = `
  .banner {
    background: #7f1d1d;
    color: #fff;
    border-radius: 10px;
    padding: 10px 16px;
    margin-bottom: 14px;
    text-align: center;
    font-weight: bold;
    letter-spacing: 0.02em;
  }
  .attrib {
    text-align: center;
    font-size: 0.82rem;
    color: #667;
    margin: 4px 0 20px;
  }
  .attrib a { color: #1e3a2f; }
  footer.attrib { margin: 26px 0 0; }
`;

function renderQuestion(q) {
  const rows = (q.fields || []).map((f, i) => {
    const label = escapeHtml(f.label == null ? '답' : f.label);
    return `  <div class="ansrow"><label>${label}:</label><input class="ans" data-f="${i}" autocomplete="off"></div>`;
  }).join('\n');

  return `<!-- Q${q.num} -->
<div class="q" data-qid="${escapeHtml(q.id)}" data-q="${q.num}">
  <div class="qtitle"><span class="num">${q.num}</span>${sanitizePrompt(q.prompt)}</div>
${q.bodyHtml || ''}
${rows}
  <div class="feedback"></div>
</div>`;
}

export function buildHtml(round, graderSrc, css) {
  const questions = round.questions || [];
  const total = questions.length;
  const title = `정보처리기사 실기 ${round.title} 복원 문제`;
  const sourceUrl = round.sourceUrl || '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} 모의 채점</title>
<style>
${css}${EXTRA_CSS}</style>
</head>
<body>
<div class="wrap">
<div class="banner">${BANNER_TEXT}</div>
<header>
  <h1>정보처리기사 실기 &mdash; ${escapeHtml(round.title)} 복원 문제</h1>
  <p>총 ${total}문항 &middot; 100점 만점 (60점 이상 합격) &mdash; 답을 입력하고 맨 아래 제출 버튼을 누르세요</p>
</header>
<div class="attrib">출처: <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a></div>

<div id="scoreBoard">
  <div class="score"></div>
  <div class="pass"></div>
</div>

${questions.map(renderQuestion).join('\n\n')}

<div class="btnbar">
  <button id="submitBtn">제출하기</button>
  <button id="resetBtn">다시 풀기</button>
</div>

<footer class="attrib">${BANNER_TEXT} &middot; 채점 로직은 server/grader.js 원문을 그대로 삽입한 것입니다.</footer>
</div>

<script>
// ==== server/grader.js 원문 삽입 (module.exports 제외) — 손으로 고치지 말 것 ====
var Grader = (function () {
${graderSrc}
  return {
    gradeQuestion: gradeQuestion,
    gradeSet: gradeSet,
    normalizeValue: normalizeValue,
    fieldAccepts: fieldAccepts,
    runValidator: runValidator,
    ipToInt: ipToInt,
    NORMALIZE_MODES: NORMALIZE_MODES,
    VALIDATOR_TYPES: VALIDATOR_TYPES
  };
})();
// ==== /grader.js ====

var ROUND = ${embedJson(round)};

var qElsByIdList = Array.prototype.slice.call(document.querySelectorAll('.q'));

function inputsOf(qEl) {
  return Array.prototype.slice.call(qEl.querySelectorAll('input.ans'));
}

document.getElementById('submitBtn').addEventListener('click', function () {
  var answersMap = {};
  qElsByIdList.forEach(function (qEl) {
    answersMap[qEl.getAttribute('data-qid')] = inputsOf(qEl).map(function (inp) { return inp.value; });
  });

  var result = Grader.gradeSet(ROUND.questions, answersMap);
  var byId = {};
  result.details.forEach(function (d) { byId[d.questionId] = d; });

  qElsByIdList.forEach(function (qEl) {
    var d = byId[qEl.getAttribute('data-qid')];
    if (!d) return;
    inputsOf(qEl).forEach(function (inp, i) {
      var ok = !!(d.fieldResults[i] && d.fieldResults[i].correct);
      inp.classList.remove('ok', 'bad');
      inp.classList.add(ok ? 'ok' : 'bad');
      inp.readOnly = true;
    });
    qEl.classList.remove('correct', 'wrong');
    qEl.classList.add(d.correct ? 'correct' : 'wrong');
    var fb = qEl.querySelector('.feedback');
    fb.innerHTML = d.correct
      ? '\\u2B55 정답입니다!'
      : '\\u274C 오답입니다.<br><b>정답:</b> ' + d.display;
  });

  var board = document.getElementById('scoreBoard');
  board.style.display = 'block';
  board.querySelector('.score').textContent = result.score + '점 / 100점';
  var passEl = board.querySelector('.pass');
  var tally = ' (' + result.correctCount + '/' + result.totalCount + ' 문제 정답)';
  if (result.score >= 60) {
    passEl.textContent = '\\uD83C\\uDF89 합격권입니다!' + tally;
    passEl.className = 'pass ok';
  } else {
    passEl.textContent = '아쉽습니다. 60점 이상이 합격입니다.' + tally;
    passEl.className = 'pass no';
  }

  document.getElementById('submitBtn').style.display = 'none';
  document.getElementById('resetBtn').style.display = 'inline-block';
  board.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('resetBtn').addEventListener('click', function () {
  qElsByIdList.forEach(function (qEl) {
    qEl.classList.remove('correct', 'wrong');
    qEl.querySelector('.feedback').innerHTML = '';
  });
  document.querySelectorAll('input.ans').forEach(function (inp) {
    inp.value = '';
    inp.readOnly = false;
    inp.classList.remove('ok', 'bad');
  });
  document.getElementById('scoreBoard').style.display = 'none';
  document.getElementById('submitBtn').style.display = 'inline-block';
  document.getElementById('resetBtn').style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
</script>
</body>
</html>
`;
}

export function exportRound(roundId, root = ROOT) {
  if (!roundId || !/^[0-9]{4}-[0-9]+$/.test(roundId)) {
    throw new Error('round id 형식이 올바르지 않습니다 (예: 2026-2): ' + roundId);
  }
  const roundPath = path.posix.join(root, 'data/rounds', roundId + '.json');
  const round = JSON.parse(readFileSync(roundPath, 'utf8'));
  if (round.round !== roundId) {
    throw new Error(`round 필드(${round.round})가 파일명(${roundId})과 다릅니다.`);
  }

  const graderSrc = graderBrowserSource(readFileSync(path.posix.join(root, 'server/grader.js'), 'utf8'));
  const css = readFileSync(path.posix.join(root, 'scripts/export-assets/exam.css'), 'utf8');

  const html = buildHtml(round, graderSrc, css);
  const outDir = path.posix.join(root, 'dist');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.posix.join(outDir, roundId + '.html');
  writeFileSync(outPath, html, 'utf8');
  return { outPath, questionCount: round.questions.length, bytes: Buffer.byteLength(html, 'utf8') };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).split(path.sep).join('/').endsWith('scripts/export-round.mjs');

if (invokedDirectly) {
  const roundId = process.argv[2];
  if (!roundId) {
    console.error('usage: node scripts/export-round.mjs <round>   (예: 2026-2)');
    process.exit(2);
  }
  try {
    const r = exportRound(roundId);
    console.log(`[export] ${r.outPath}  (${r.questionCount}문항, ${r.bytes} bytes)`);
  } catch (err) {
    console.error('[export] 실패:', err.message);
    process.exit(1);
  }
}
