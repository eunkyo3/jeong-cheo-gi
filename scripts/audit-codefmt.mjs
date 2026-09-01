#!/usr/bin/env node
// audit-codefmt.mjs — 전 회차의 `<pre class="code">` 블록에 CodeFmt.normalize 를 돌려 보고
// "무엇이 얼마나 바뀌는지" 를 눈으로 확인하는 감사 도구.
//
// **data/ 는 절대 쓰지 않는다**(계약 C9 — 읽기 전용). 화면 출력만 한다.
//
//   node scripts/audit-codefmt.mjs              요약표
//   node scripts/audit-codefmt.mjs --show 2020-1#12   그 문항의 before/after 나란히 보기
//   node scripts/audit-codefmt.mjs --all        바뀐 블록 전부 나란히 보기
//   node scripts/audit-codefmt.mjs --round 2020-1     회차 한정
//
// 종료 코드는 언제나 0 — 감사지 게이트가 아니다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUNDS_DIR = path.join(ROOT, 'data', 'rounds');
const LANGS_DIR = path.join(ROOT, 'data', 'langs');

// codefmt.js 는 브라우저용 IIFE 라 globalThis 에 붙는다.
require(path.join(ROOT, 'public', 'js', 'codefmt.js'));
const CodeFmt = globalThis.CodeFmt;

// ------------------------------------------------------------------ 인자

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const SHOW = flagValue('--show');
const ONLY_ROUND = flagValue('--round');
const SHOW_ALL = argv.includes('--all');

// ------------------------------------------------------------------ 추출

const PRE_RE = /<pre class="code">([\s\S]*?)<\/pre>/g;

/** HTML 엔티티를 텍스트로 되돌린다 (브라우저의 textContent 와 같은 값이 되도록). */
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** data/langs/<round>.json 이 있으면 {qid: lang} 을, 없으면 빈 맵을. */
function langMapOf(round) {
  const j = readJson(path.join(LANGS_DIR, `${round}.json`));
  return j && j.langs && typeof j.langs === 'object' ? j.langs : null;
}

const roundFiles = fs.existsSync(ROUNDS_DIR)
  ? fs.readdirSync(ROUNDS_DIR).filter((f) => f.endsWith('.json')).sort()
  : [];

/** @type {{round:string,qid:string,label:string,lang:string|null,langSrc:string,before:string,after:string,base:string}[]} */
const blocks = [];
let langFilesFound = 0;

for (const file of roundFiles) {
  const round = file.replace(/\.json$/, '');
  if (ONLY_ROUND && round !== ONLY_ROUND) continue;
  const data = readJson(path.join(ROUNDS_DIR, file));
  if (!data || !Array.isArray(data.questions)) continue;
  const langs = langMapOf(round);
  if (langs) langFilesFound++;

  for (const q of data.questions) {
    const html = String(q.bodyHtml || '');
    PRE_RE.lastIndex = 0;
    const found = [];
    let m;
    while ((m = PRE_RE.exec(html)) !== null) found.push(decodeEntities(m[1]));
    if (!found.length) continue;

    for (let k = 0; k < found.length; k++) {
      const before = found[k];
      let lang = langs && typeof langs[q.id] === 'string' ? langs[q.id] : null;
      let langSrc = lang ? 'langs' : '';
      if (!lang) {
        lang = CodeFmt.detect(before);
        langSrc = lang ? 'detect' : 'none';
      }
      blocks.push({
        round,
        qid: q.id,
        label: found.length > 1 ? `${q.id}[${k + 1}]` : q.id,
        lang,
        langSrc,
        before,
        after: CodeFmt.normalize(before, lang),
        // 언어 재들여쓰기를 뺀 "공통 정규화만" 한 값 — 구조 변경 여부를 가르는 기준선.
        base: CodeFmt.normalize(before, 'python'),
      });
    }
  }
}

// ------------------------------------------------------------------ 출력

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** before/after 를 나란히 찍는다 (줄 번호 + 선행 공백 수). */
function sideBySide(b) {
  const L = b.before.replace(/\r\n?/g, '\n').split('\n');
  const R = b.after.split('\n');
  const w = Math.min(64, Math.max(24, ...L.map((x) => x.replace(/\t/g, '····').length)));
  const head = `── ${b.label}  (${b.round}, lang=${b.lang || 'null'} via ${b.langSrc}) `;
  console.log('\n' + head + '─'.repeat(Math.max(0, 100 - head.length)));
  console.log(pad('BEFORE (탭=····)', w + 6) + '│ AFTER');
  console.log('─'.repeat(w + 6) + '┼' + '─'.repeat(40));
  const n = Math.max(L.length, R.length);
  for (let i = 0; i < n; i++) {
    const l = L[i] === undefined ? '' : L[i].replace(/\t/g, '····');
    const r = R[i] === undefined ? '' : R[i];
    const lm = L[i] === undefined ? '  ' : String(L[i].search(/\S|$/)).padStart(2);
    const rm = R[i] === undefined ? '  ' : String(R[i].search(/\S|$/)).padStart(2);
    console.log(pad(`${lm}│${l}`, w + 6) + `│${rm}│${r}`);
  }
}

const changed = blocks.filter((b) => b.after !== b.before);
const structural = blocks.filter((b) => b.after !== b.base);   // 중괄호 재들여쓰기가 실제로 손댄 블록

if (SHOW) {
  const hits = blocks.filter((b) => b.qid === SHOW || b.label === SHOW);
  if (!hits.length) {
    console.log(`(문항 ${SHOW} 의 코드 블록을 찾지 못했습니다)`);
  } else {
    for (const b of hits) sideBySide(b);
  }
  process.exit(0);
}

console.log('=== codefmt 감사 ===');
console.log(`회차 파일        : ${roundFiles.length}개${ONLY_ROUND ? ` (필터: ${ONLY_ROUND})` : ''}`);
console.log(`data/langs 적용  : ${langFilesFound}개 파일${langFilesFound ? '' : ' (없음 → detect 폴백)'}`);
console.log(`코드 블록 총계   : ${blocks.length}`);
console.log(`정규화로 바뀜    : ${changed.length}`);
console.log(`  · 구조(재들여쓰기)까지 바뀜 : ${structural.length}`);
console.log(`  · 탭/끝공백/공통들여쓰기만  : ${changed.length - structural.length}`);

const byLang = {};
for (const b of blocks) {
  const k = `${b.lang || 'null'}/${b.langSrc}`;
  byLang[k] = byLang[k] || { total: 0, changed: 0, structural: 0 };
  byLang[k].total++;
  if (b.after !== b.before) byLang[k].changed++;
  if (b.after !== b.base) byLang[k].structural++;
}
console.log('\n언어별');
console.log(pad('lang/출처', 16) + pad('블록', 6) + pad('변경', 6) + '구조변경');
for (const k of Object.keys(byLang).sort()) {
  const v = byLang[k];
  console.log(pad(k, 16) + pad(String(v.total), 6) + pad(String(v.changed), 6) + String(v.structural));
}

console.log('\n회차별');
console.log(pad('회차', 10) + pad('블록', 6) + pad('변경', 6) + pad('구조변경', 10) + '바뀐 블록');
const rounds = [...new Set(blocks.map((b) => b.round))].sort();
for (const r of rounds) {
  const rows = blocks.filter((b) => b.round === r);
  const ch = rows.filter((b) => b.after !== b.before);
  const st = rows.filter((b) => b.after !== b.base);
  console.log(
    pad(r, 10) +
    pad(String(rows.length), 6) +
    pad(String(ch.length), 6) +
    pad(String(st.length), 10) +
    ch.map((b) => b.label).join(' ')
  );
}

if (structural.length) {
  console.log('\n구조가 바뀐 블록(중괄호 재들여쓰기가 손댄 것) — 눈으로 확인할 대상');
  console.log('  ' + structural.map((b) => `${b.label}(${b.lang})`).join(' '));
}

if (SHOW_ALL) {
  for (const b of changed) sideBySide(b);
} else if (changed.length) {
  console.log(`\n(자세히 보려면: node scripts/audit-codefmt.mjs --show ${changed[0].label.replace(/\[\d+\]$/, '')} · 전부 보려면 --all)`);
}

process.exit(0);
