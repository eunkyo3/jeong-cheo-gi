#!/usr/bin/env node
/**
 * audit-round.mjs — 회차 감사 워크시트 생성기
 *
 *   node scripts/audit-round.mjs <round> [--seed N] [--out <path>] [--force] [--stdout]
 *
 * `data/RESTORE_GUIDE.md` 의 "감사 규약" 을 그대로 기계화한다.
 *   - 20%(최소 4문항) 결정적 무작위 표본
 *   - validator / 다필드 / 코드 출력 문항은 표본과 무관하게 100% 감사
 *   - 산출물: data/audits/<round>-audit.md  (판정란이 비어 있는 서식)
 *
 * 이 스크립트는 **판정을 만들지 않는다.** 회차 JSON 의 accept / sampleAnswer / display /
 * validator 상세는 워크시트에 절대 싣지 않는다 — 감사자는 raw 원본에서 먼저 답을 도출한 뒤
 * JSON 과 대조해야 하므로, 워크시트가 답을 미리 알려주면 감사가 무의미해진다.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join('/');
const ROOT = path.resolve(HERE, '..').split(path.sep).join('/');

const SAMPLE_RATIO = 0.2;
const SAMPLE_MIN = 4;
const EXCERPT_MAX_LINES = 240;

/** 문항이 "출력값을 묻는가" 판정용 어휘 (prompt + bodyText 대상) */
const OUTPUT_QUESTION_RE = /출력값|출력\s*값|출력되는|출력하시오|결과값|결과\s*값/;

// ------------------------------------------------------------------- PRNG

/** FNV-1a 32bit — 회차 id 로부터 안정적인 기본 시드를 만든다. */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — 작고 결정적인 PRNG. Math.random() 은 재현 불가라 쓰지 않는다. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 시드 고정 Fisher-Yates. 같은 시드 → 항상 같은 순열. */
function seededShuffle(items, seed) {
  const rnd = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// -------------------------------------------------------------- 위험 분류

/**
 * 문항별 고위험 사유 목록을 돌려준다(빈 배열이면 일반 문항).
 * 규약(RESTORE_GUIDE "감사 규약"):
 *   validator    — validator 가 붙은 필드가 하나라도 있는 문항
 *   multi-field  — 필드가 2개 이상인 문항
 *   code-output  — keepSpace 필드가 있거나, <pre class="code"> 를 포함하는 모든 문항 (2021-2#7 누락 사례 이후 조건 완화: 코드가 있으면 트레이스 오독 위험이 있다)
 */
export function riskTags(q) {
  const tags = [];
  const fields = q.fields || [];
  if (fields.some((f) => f.validator != null)) tags.push('validator');
  if (fields.length > 1) tags.push('multi-field');

  const hasKeepSpace = fields.some((f) => f.normalize === 'keepSpace');
  const hasCodeBlock = /<pre class="code">/.test(q.bodyHtml || '');
  const asksOutput = OUTPUT_QUESTION_RE.test(String(q.prompt || '') + '\n' + String(q.bodyText || ''));
  if (hasKeepSpace || hasCodeBlock) tags.push('code-output');

  return tags;
}

// --------------------------------------------------- page.txt 발췌 탐색

/**
 * page.txt 에서 문항 헤더 위치를 찾는다.
 * 헤더는 `N.` 또는 `N. ` 로 시작한다. 그런데 `더보기` 아래 정답 목록(`1. 50`)이나
 * `6.5ms` 같은 줄도 같은 모양이라, **문항 번호가 1부터 순서대로 올라간다**는 성질과
 * "번호 뒤 본문이 충분히 길다"는 조건으로 걸러낸다.
 *
 * → Map<number, {start, end}> (1-based 줄 번호, end 는 다음 헤더 직전)
 */
export function locateQuestionLines(pageText) {
  const lines = pageText.split(/\r?\n/);
  const headers = [];
  let expected = 1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d{1,2})\.\s*(\S.*)$/);
    if (!m) continue;
    const num = Number(m[1]);
    if (num !== expected) continue;
    if (m[2].trim().length < 10) continue; // "5ms", "50" 같은 정답 줄 배제
    headers.push({ num, line: i + 1 });
    expected++;
  }
  const map = new Map();
  for (let k = 0; k < headers.length; k++) {
    const start = headers[k].line;
    const end = k + 1 < headers.length ? headers[k + 1].line - 1 : lines.length;
    map.set(headers[k].num, { start, end });
  }
  return map;
}

/** 발췌 본문. 연속 빈 줄만 1줄로 압축한다(티스토리 평문화 잡음). */
function excerpt(pageText, range) {
  const lines = pageText.split(/\r?\n/).slice(range.start - 1, range.end);
  const squashed = [];
  let blank = false;
  for (const l of lines) {
    if (l.trim() === '') {
      if (blank) continue;
      blank = true;
    } else {
      blank = false;
    }
    squashed.push(l);
  }
  let truncated = false;
  let body = squashed;
  if (body.length > EXCERPT_MAX_LINES) {
    body = body.slice(0, EXCERPT_MAX_LINES);
    truncated = true;
  }
  return { text: body.join('\n'), truncated };
}

/** 발췌 안의 백틱 런보다 긴 펜스를 고른다. */
function fenceFor(text) {
  let longest = 0;
  const m = text.match(/`+/g);
  if (m) for (const run of m) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// ------------------------------------------------------------ 워크시트

const HEADER_DOC = `## 감사 방법 (읽고 시작할 것)

1. **JSON 을 먼저 보지 않는다.** \`sourceImages\` 의 이미지와 \`data/raw/<회차>/\` 원본
   (\`page.txt\`, \`article.html\`, \`imgNN\`)만 보고 **독립적으로 재판독**한다.
2. 재판독이 끝난 뒤에야 \`data/rounds/<회차>.json\` 을 열어 대조한다.
3. 문항마다 아래 **판정 / 등급 / 근거** 3칸을 채운다. 빈칸이 남으면 감사 미완료다.

### 불일치 등급 (RESTORE_GUIDE "감사 규약")

| 등급 | 정의 | 조치 |
|---|---|---|
| **A급** | 채점 영향 또는 지문 내용 변경 — \`bodyHtml\`/\`bodyText\` 의 수치·식별자·코드 리터럴·표 셀 값, \`accept\`·\`validator\`·\`sampleAnswer\`·필드 수·정답 자체 | **A급 1건 이상이면 해당 회차 전 문항 재감사** |
| **B급** | 순수 표시 서식 — 줄바꿈·정렬·클래스·공백 | 수정 후 기록만 |

> 감사는 표본 검사이므로 완전 보증이 아니다. 운영 중 "정답 이의 제기" 버튼이 상시 신고 경로다.

### 판정 기입 규칙

- \`판정\` — \`일치\` / \`불일치\` / \`판독불가\` 중 하나.
- \`등급\` — 불일치일 때만 \`A\` 또는 \`B\`. 일치면 \`-\`.
- \`근거\` — 무엇을 어디서 보고 그렇게 판단했는지(이미지 파일명, page.txt 줄 번호 등).
  "확인함" 같은 서술은 근거가 아니다.
`;

const REASON_LABEL = {
  sample: '무작위 표본',
  validator: '고위험: validator 문항',
  'multi-field': '고위험: 다필드 문항',
  'code-output': '고위험: 코드 출력 문항',
};

function buildWorksheet(ctx) {
  const {
    round, roundId, seed, seedSource, sampleSize, sampleNums,
    riskByNum, selected, coverage, pageText, lineMap, pageTxtRel, missingImages,
  } = ctx;

  const out = [];
  out.push(`# ${roundId} 감사 워크시트`);
  out.push('');
  out.push(`> 생성: \`node scripts/audit-round.mjs ${roundId} --seed ${seed}\``);
  out.push('> 이 파일은 **빈 서식**이다. 생성기는 어떤 판정도 채우지 않는다.');
  out.push('');

  out.push('## 표본 추출 근거 (재현 가능)');
  out.push('');
  out.push('| 항목 | 값 |');
  out.push('|---|---|');
  out.push(`| 회차 | ${roundId} (${round.title}) |`);
  out.push(`| 총 문항 | ${round.questions.length} |`);
  out.push(`| 시드 | \`${seed}\` (${seedSource}) |`);
  out.push(`| 표본 크기 | ${sampleSize} (20%, 최소 ${SAMPLE_MIN}) |`);
  out.push(`| 표본 문항 | ${sampleNums.length ? sampleNums.join(', ') + '번' : '(없음)'} |`);
  out.push(`| 고위험 문항 | ${ctx.riskNums.length ? ctx.riskNums.join(', ') + '번' : '(없음)'} |`);
  out.push(`| 감사 대상 (표본 ∪ 고위험) | ${selected.length}문항 |`);
  out.push(`| **실효 커버리지** | **${coverage}%** |`);
  out.push('');
  out.push('고위험 분류 내역:');
  out.push('');
  out.push('| 분류 | 문항 |');
  out.push('|---|---|');
  for (const tag of ['validator', 'multi-field', 'code-output']) {
    const nums = [...riskByNum.entries()].filter(([, t]) => t.includes(tag)).map(([n]) => n);
    out.push(`| \`${tag}\` | ${nums.length ? nums.join(', ') + '번' : '(없음)'} |`);
  }
  out.push('');
  out.push('> 시드가 같으면 표본은 항상 같다. 다른 사람이 위 명령을 그대로 실행해 표본을 재현할 수 있다.');
  out.push('');
  out.push(HEADER_DOC);

  if (missingImages.length) {
    out.push('## ⚠ 존재하지 않는 sourceImages');
    out.push('');
    for (const mi of missingImages) out.push(`- ${mi.id}: \`${mi.rel}\``);
    out.push('');
    out.push('경로가 틀렸거나 파일이 없다. 감사 전에 회차 담당자에게 확인할 것.');
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('## 문항별 감사');
  out.push('');

  for (const q of selected) {
    const reasons = [];
    if (sampleNums.includes(q.num)) reasons.push('sample');
    for (const t of riskByNum.get(q.num) || []) reasons.push(t);

    out.push(`### ${q.id} — ${q.num}번`);
    out.push('');
    out.push(`- **선정 사유**: ${reasons.map((r) => REASON_LABEL[r]).join(' / ')}`);
    const imgs = q.sourceImages || [];
    out.push(`- **판독 근거 이미지**: ${imgs.length ? imgs.map((p) => `\`data/${p}\``).join(', ') : '(없음 — 평문만으로 판독)'}`);
    out.push(`- **필드 수**: ${(q.fields || []).length}`);

    const range = lineMap.get(q.num);
    if (range) {
      out.push(`- **원본 위치**: \`${pageTxtRel}\` ${range.start}–${range.end}행`);
    } else {
      out.push(`- **원본 위치**: 자동 탐색 실패 — \`${pageTxtRel}\` 에서 ${q.num}번 문항을 직접 찾을 것`);
    }
    out.push('');

    if (range) {
      const ex = excerpt(pageText, range);
      const fence = fenceFor(ex.text);
      out.push(`<details><summary>page.txt 원문 발췌 (${range.start}–${range.end}행, 연속 빈 줄 압축)</summary>`);
      out.push('');
      out.push(fence + 'text');
      out.push(ex.text);
      if (ex.truncated) out.push(`… (${EXCERPT_MAX_LINES}행에서 잘림 — 나머지는 원본 파일을 볼 것)`);
      out.push(fence);
      out.push('');
      out.push('</details>');
      out.push('');
    }

    out.push('| 항목 | 기입 |');
    out.push('|---|---|');
    out.push('| 판정 |  |');
    out.push('| 등급 |  |');
    out.push('| 근거 |  |');
    out.push('');
    out.push('---');
    out.push('');
  }

  out.push('## 종합');
  out.push('');
  out.push('| 항목 | 기입 |');
  out.push('|---|---|');
  out.push(`| 감사 대상 문항 수 | ${selected.length} |`);
  out.push('| 일치 |  |');
  out.push('| 불일치 A급 |  |');
  out.push('| 불일치 B급 |  |');
  out.push('| 판독불가 |  |');
  out.push('| 감사자 |  |');
  out.push('| 감사일 |  |');
  out.push('');
  out.push('**A급이 1건 이상이면 이 회차는 전 문항 재감사 대상이다.** A급 처리 절차: ① JSON 수정 → ② `node scripts/validate-data.mjs` + `npm test` 재통과');
  out.push('→ ③ 이 파일에 before/after 기록 → ④ 표본 밖 문항까지 전 문항 재감사 → ⑤ 그 후에만 `data/PROGRESS.md` 감사통과 체크 + team-lead 에 한 줄 보고.');
  out.push('(2026-2 는 골든 기준선이므로 A급은 수정 전에 team-lead 에게 먼저 보고한다.)');
  out.push('');

  return out.join('\n');
}

// ------------------------------------------------------------------ main

function parseArgs(argv) {
  const opts = { round: null, seed: null, out: null, force: false, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error('--seed 는 0 이상의 정수여야 합니다.');
      opts.seed = v >>> 0;
    } else if (a === '--out') {
      opts.out = argv[++i];
      if (!opts.out) throw new Error('--out 뒤에 경로가 필요합니다.');
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--stdout') {
      opts.stdout = true;
    } else if (a.startsWith('--')) {
      throw new Error('알 수 없는 옵션: ' + a);
    } else if (opts.round === null) {
      opts.round = a;
    } else {
      throw new Error('인자가 너무 많습니다: ' + a);
    }
  }
  if (!opts.round) throw new Error('회차 id 가 필요합니다. 예: node scripts/audit-round.mjs 2026-2');
  if (!/^\d{4}-\d+$/.test(opts.round)) throw new Error('회차 id 형식 오류: ' + opts.round);
  return opts;
}

export function generate(opts, root = ROOT) {
  const roundId = opts.round;
  const roundPath = path.posix.join(root, 'data/rounds', roundId + '.json');
  if (!existsSync(roundPath)) throw new Error('회차 JSON 이 없습니다: ' + roundPath);
  const round = JSON.parse(readFileSync(roundPath, 'utf8'));
  const questions = round.questions || [];
  if (questions.length === 0) throw new Error('문항이 없습니다: ' + roundPath);

  const seedSource = opts.seed === null ? `기본값 — fnv1a32("${roundId}")` : '--seed 로 지정';
  const seed = opts.seed === null ? fnv1a32(roundId) : opts.seed;

  const total = questions.length;
  const sampleSize = Math.min(total, Math.max(SAMPLE_MIN, Math.ceil(total * SAMPLE_RATIO)));
  const sampleNums = seededShuffle(questions.map((q) => q.num), seed)
    .slice(0, sampleSize)
    .sort((a, b) => a - b);

  const riskByNum = new Map();
  for (const q of questions) {
    const tags = riskTags(q);
    if (tags.length) riskByNum.set(q.num, tags);
  }
  const riskNums = [...riskByNum.keys()].sort((a, b) => a - b);

  const selectedNums = new Set([...sampleNums, ...riskNums]);
  const selected = questions.filter((q) => selectedNums.has(q.num)).sort((a, b) => a.num - b.num);
  const coverage = Math.round((selected.length / total) * 100);

  const pageTxtRel = `data/raw/${roundId}/page.txt`;
  const pageTxtPath = path.posix.join(root, pageTxtRel);
  const pageText = existsSync(pageTxtPath) ? readFileSync(pageTxtPath, 'utf8') : '';
  const lineMap = pageText ? locateQuestionLines(pageText) : new Map();

  const missingImages = [];
  for (const q of questions) {
    for (const rel of q.sourceImages || []) {
      if (!existsSync(path.posix.join(root, 'data', rel))) {
        missingImages.push({ id: q.id, rel: 'data/' + rel });
      }
    }
  }

  const markdown = buildWorksheet({
    round, roundId, seed, seedSource, sampleSize, sampleNums,
    riskByNum, riskNums, selected, coverage, pageText, lineMap, pageTxtRel, missingImages,
  });

  return {
    markdown, seed, seedSource, sampleSize, sampleNums, riskByNum, riskNums,
    selected, coverage, total, lineMapSize: lineMap.size, missingImages,
    pageTextFound: pageText.length > 0,
  };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[audit] ' + err.message);
    console.error('usage: node scripts/audit-round.mjs <round> [--seed N] [--out <path>] [--force] [--stdout]');
    process.exit(2);
  }

  let r;
  try {
    r = generate(opts);
  } catch (err) {
    console.error('[audit] 실패: ' + err.message);
    process.exit(1);
  }

  if (opts.stdout) {
    process.stdout.write(r.markdown);
    return;
  }

  const outPath = opts.out
    ? opts.out.split(path.sep).join('/')
    : path.posix.join(ROOT, 'data/audits', opts.round + '-audit.md');

  if (existsSync(outPath) && !opts.force) {
    console.error(`[audit] 이미 존재합니다: ${outPath}`);
    console.error('        진행 중인 감사를 덮어쓰지 않습니다. --force 로 덮어쓰거나 --out 으로 다른 경로를 쓰세요.');
    process.exit(1);
  }

  mkdirSync(path.posix.dirname(outPath), { recursive: true });
  writeFileSync(outPath, r.markdown, 'utf8');

  console.log(`[audit] ${outPath}`);
  console.log(`  회차 ${opts.round}: 총 ${r.total}문항`);
  console.log(`  시드 ${r.seed}  (${r.seedSource})  ← 이 시드를 워크시트에 기록했다. 같은 시드면 표본이 재현된다.`);
  console.log(`  표본 ${r.sampleSize}문항: ${r.sampleNums.join(', ')}`);
  console.log(`  고위험 ${r.riskNums.length}문항: ${r.riskNums.join(', ') || '(없음)'}`);
  for (const tag of ['validator', 'multi-field', 'code-output']) {
    const nums = [...r.riskByNum.entries()].filter(([, t]) => t.includes(tag)).map(([n]) => n);
    console.log(`    - ${tag.padEnd(11)} ${nums.join(', ') || '(없음)'}`);
  }
  console.log(`  감사 대상 ${r.selected.length}문항 → 실효 커버리지 ${r.coverage}%`);
  if (!r.pageTextFound) console.log('  (주의) page.txt 를 찾지 못해 원문 발췌를 넣지 못했습니다.');
  else console.log(`  page.txt 문항 헤더 탐색: ${r.lineMapSize}개`);
  if (r.missingImages.length) console.log(`  (주의) 존재하지 않는 sourceImages ${r.missingImages.length}건 — 워크시트 상단에 표시`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).split(path.sep).join('/').endsWith('scripts/audit-round.mjs');
if (invokedDirectly) main();
