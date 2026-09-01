#!/usr/bin/env node
/**
 * classify-langs.mjs — data/langs/*.json 생성기 (코드 문항의 프로그래밍 언어 분류)
 *
 * `data/types/<round>.json` 에서 유형이 `code` 인 문항만 골라 언어(`c` | `java` | `python`)를 붙이고
 * `data/langs/<round>.json` 으로 쓴다. `data/rounds/*.json` · `data/types/*.json` 은 **절대 건드리지 않는다**.
 *
 *   node scripts/classify-langs.mjs            # 분류 결과를 출력만 한다(미리보기)
 *   node scripts/classify-langs.mjs --write    # data/langs/*.json 을 쓴다
 *   node scripts/classify-langs.mjs --verbose  # 문항별 판정 근거까지 출력
 *
 * ── 분류 근거 (강한 것부터)
 *   0) 수동 재정의 OVERRIDES — 휴리스틱이 갈리는 소수 문항을 손으로 못박는다.
 *   1) bodyText 의 펜스 태그(```java / ```c / ```python) — 스크랩 단계에서 원문 코드 블록에
 *      붙은 언어 표시라 사실상 정답에 가깝다.
 *   2) prompt 의 언어 이름 (java|자바 / python|파이썬 / C언어|C 언어|C++)
 *   3) 본문 코드의 문법 지문 (System.out|public static void / print(|def |self / #include|printf|scanf)
 *
 * 1~3 이 서로 어긋나면 경고를 찍고 1 을 따른다. 어느 것도 못 맞히면 "미분류"로 출력해
 * 사람이 눈으로 보고 OVERRIDES 에 적을 수 있게 한다(빈 값으로 파일에 쓰지 않는다).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');
const TYPES_DIR = path.join(DATA_DIR, 'types');
const LANGS_DIR = path.join(DATA_DIR, 'langs');

/** 동결 값 집합. server/rounds.js · scripts/validate-langs.mjs 의 LANGS 와 반드시 같아야 한다. */
const LANGS = ['c', 'java', 'python'];

/**
 * 손으로 못박는 문항.
 * · 2025-1#15 — `int Main(...)` 문장 커버리지 문제. 대문자 Main 이라 자바처럼 보이지만 C 다
 *   (팀 handoff "애매 1건" 지정).
 */
const OVERRIDES = {
  '2025-1#15': 'c',
};

// ------------------------------------------------------------------ 휴리스틱

/** 코드 블록 텍스트만 뽑는다(bodyHtml 의 <pre class="code">…</pre> 안쪽). */
function codeBlocks(bodyHtml) {
  const out = [];
  const re = /<pre[^>]*class="code"[^>]*>([\s\S]*?)<\/pre>/g;
  let m;
  while ((m = re.exec(String(bodyHtml || '')))) out.push(unescapeHtml(m[1]));
  return out;
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** ① bodyText 의 마크다운 펜스 태그. 서로 다른 언어 태그가 섞이면 null. */
function fromFence(bodyText) {
  const found = new Set();
  for (const m of String(bodyText || '').matchAll(/```([a-zA-Z0-9+#]+)/g)) {
    const tag = m[1].toLowerCase();
    if (LANGS.indexOf(tag) !== -1) found.add(tag);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** ② 발문의 언어 이름. 여러 언어가 같이 나오면 null. */
function fromPrompt(prompt) {
  const p = String(prompt || '');
  const hits = new Set();
  if (/java|자바/i.test(p)) hits.add('java');
  if (/python|파이썬/i.test(p)) hits.add('python');
  // 홑글자 `\bC\b` 는 쓰지 않는다 — 보기 기호(가/나/C), 규격·회사 이름 등 한국어 발문 어디서나
  // 튀어나와 오탐이 크다. "C언어" / "C코드"(2025-3 회차 표기) / "C++" 처럼 명시적인 것만 본다.
  if (/C\s*언어|C\s*코드|\bC\+\+/.test(p)) hits.add('c');
  return hits.size === 1 ? [...hits][0] : null;
}

/** ③ 코드 본문의 문법 지문. 여러 언어가 잡히면 히트 수가 가장 많은 하나(동점이면 null). */
function fromBody(code) {
  const c = String(code || '');
  const score = { c: 0, java: 0, python: 0 };
  if (/System\.out/.test(c)) score.java += 2;
  if (/public\s+static\s+void/.test(c)) score.java += 2;
  if (/\bclass\s+\w+\s*\{/.test(c)) score.java += 1;
  if (/^\s*print\s*\(/m.test(c)) score.python += 2;
  if (/^\s*def\s+\w+/m.test(c)) score.python += 2;
  if (/\bself\b/.test(c)) score.python += 2;
  if (/#include/.test(c)) score.c += 2;
  if (/\bprintf\s*\(/.test(c)) score.c += 2;
  if (/\bscanf\s*\(/.test(c)) score.c += 2;

  let best = null;
  let bestScore = 0;
  let tie = false;
  for (const l of LANGS) {
    if (score[l] > bestScore) { best = l; bestScore = score[l]; tie = false; }
    else if (score[l] === bestScore && bestScore > 0) tie = true;
  }
  return bestScore === 0 || tie ? null : best;
}

/**
 * 문항 하나의 언어. 근거를 함께 돌려준다.
 * @returns {{ lang: string|null, source: string, votes: {fence:string|null, prompt:string|null, body:string|null} }}
 */
function classify(q) {
  const votes = {
    fence: fromFence(q.bodyText),
    prompt: fromPrompt(q.prompt),
    body: fromBody(codeBlocks(q.bodyHtml).join('\n') || q.bodyText),
  };
  if (Object.prototype.hasOwnProperty.call(OVERRIDES, q.id)) {
    return { lang: OVERRIDES[q.id], source: 'override', votes };
  }
  for (const key of ['fence', 'prompt', 'body']) {
    if (votes[key]) return { lang: votes[key], source: key, votes };
  }
  return { lang: null, source: 'none', votes };
}

// ------------------------------------------------------------------ 본문

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const verbose = argv.includes('--verbose');

  const roundIds = fs
    .readdirSync(ROUNDS_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => path.basename(n, '.json'))
    .sort();

  const totals = { c: 0, java: 0, python: 0 };
  const unclassified = [];
  const disagreements = [];
  let codeTotal = 0;

  for (const round of roundIds) {
    const doc = readJson(path.join(ROUNDS_DIR, round + '.json'));
    let types = {};
    try {
      types = readJson(path.join(TYPES_DIR, round + '.json')).types || {};
    } catch {
      console.warn(`[warn] data/types/${round}.json 을 읽을 수 없다 — 이 회차의 코드 문항이 없다고 본다.`);
    }

    const langs = {};
    const counts = { c: 0, java: 0, python: 0 };
    for (const q of doc.questions) {
      if (types[q.id] !== 'code') continue;
      codeTotal += 1;
      const r = classify(q);
      if (verbose) {
        console.log(`  ${q.id.padEnd(12)} → ${String(r.lang).padEnd(7)} (${r.source})` +
          `  fence=${r.votes.fence} prompt=${r.votes.prompt} body=${r.votes.body}`);
      }
      // 근거가 서로 어긋나면(둘 다 값이 있고 다를 때) 눈으로 볼 수 있게 모아 둔다.
      const said = ['fence', 'prompt', 'body'].map((k) => r.votes[k]).filter(Boolean);
      if (new Set(said).size > 1) {
        disagreements.push({ id: q.id, chosen: r.lang, source: r.source, votes: r.votes, prompt: q.prompt || '' });
      }
      if (!r.lang) {
        unclassified.push({ id: q.id, prompt: (q.prompt || '').slice(0, 70) });
        continue;
      }
      langs[q.id] = r.lang;
      counts[r.lang] += 1;
      totals[r.lang] += 1;
    }

    const sum = counts.c + counts.java + counts.python;
    console.log(`${round}  code=${sum}  c=${counts.c} java=${counts.java} python=${counts.python}`);

    if (write) {
      fs.mkdirSync(LANGS_DIR, { recursive: true });
      const outFile = path.join(LANGS_DIR, round + '.json');
      fs.writeFileSync(outFile, JSON.stringify({ round, langs }, null, 2) + '\n', 'utf8');
    }
  }

  if (disagreements.length) {
    console.log('');
    console.log(`--- 근거 불일치 (${disagreements.length}건 — 채택값은 fence>prompt>body 순) ---`);
    for (const d of disagreements) {
      console.log(`  ${d.id} → ${d.chosen} (${d.source})  fence=${d.votes.fence} prompt=${d.votes.prompt} body=${d.votes.body}`);
      console.log(`      "${d.prompt.slice(0, 80)}"`);
    }
  }

  if (unclassified.length) {
    console.log('');
    console.log(`--- 분류 실패 (${unclassified.length}건 — 손으로 OVERRIDES 에 적어야 한다) ---`);
    for (const u of unclassified) console.log(`  ${u.id}  "${u.prompt}"`);
  }

  console.log('');
  console.log('--- 요약 ---');
  console.log(`  코드 문항 ${codeTotal}개 중 ${codeTotal - unclassified.length}개 분류`);
  console.log(`  언어별 합계: c ${totals.c} · java ${totals.java} · python ${totals.python}`);
  console.log(write ? `  data/langs/*.json ${roundIds.length}개 파일을 썼다.` : '  (미리보기 — 쓰려면 --write)');

  if (unclassified.length) {
    console.log('');
    console.log('CLASSIFY INCOMPLETE');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { main, classify, fromFence, fromPrompt, fromBody, LANGS, OVERRIDES };
