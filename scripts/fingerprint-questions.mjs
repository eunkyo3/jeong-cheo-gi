#!/usr/bin/env node
/**
 * fingerprint-questions.mjs — 문항 지문 서명 (`data/.qfingerprint.json`)
 *
 * **무엇을 막는가.** 검증기 3종(types·langs·explanations)은 사이드카와 회차의 **id 집합**이
 * 정확히 일치하는지만 본다. 그래서 회차 중간 문항을 지우고 뒤 문항을 **재번호**하면
 * (`#5` 삭제 → `#6`~`#20` 을 한 칸씩 당김) id 집합은 그대로인데 각 id 가 가리키는 문항이
 * 통째로 밀린다 — 해설·유형·언어가 전부 다른 문항에 붙는데 **아무 검증기도 실패하지 않는다.**
 * 이 스크립트가 그 유일한 무성 오염을 잡는다.
 *
 * **규칙 (SCHEMA.md · data/RESTORE_GUIDE.md 와 같은 문구):**
 *   문항 id 불변 · 삭제 대신 tombstone · 추가는 append only.
 *
 * 서명 = `sha1( prompt 앞 200자 + "|" + fields.length + "|" + 본문 앞 200자 )`.
 *   정규화 = NFC → HTML 태그 제거 → 연속 공백 1칸 → trim. 본문은 `bodyText`, 없으면 `bodyHtml`.
 *   지문 전문이 아니라 앞 200자만 보는 이유: 오탈자 교정 같은 정상 편집까지 실패로 만들지 않으면서
 *   "다른 문항으로 바뀌었다" 는 사실은 거의 예외 없이 앞부분에서 드러나기 때문이다.
 *   `fields.length` 를 붙이는 이유: 발문이 비슷한 이웃 문항끼리 답 칸 수가 다른 경우를 갈라내려고.
 *   **본문을 함께 넣은 이유**: prompt 만으로는 420문항 중 64개가 서로 같은 서명이 된다
 *   ("다음 설명에서 괄호 안에 들어갈 알맞은 용어를 쓰시오." 같은 정형 발문이 많다).
 *   같은 회차의 이웃 문항끼리 겹치는 경우도 있어(2020-1#13 ≡ #14) 재번호 한 칸 밀림을
 *   놓칠 수 있었다. 본문 앞 200자를 더하면 420문항 전부 고유하다.
 *
 * 사용법:
 *   node scripts/fingerprint-questions.mjs            # 검증 (기본) — 어긋나면 exit 1
 *   node scripts/fingerprint-questions.mjs --write    # 재생성 (문항을 정당하게 추가·수정한 뒤에만)
 *
 * 회차가 늘어나도 그대로 동작해야 하므로 회차 목록은 **디스크에서 읽는다**.
 * 생성 파일 `data/.qfingerprint.json` 은 **커밋 대상**이다(.gitignore 금지).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DATA_DIR = path.join(ROOT, 'data');
const ROUNDS_DIR = path.join(DATA_DIR, 'rounds');
const FINGERPRINT_FILE = path.join(DATA_DIR, '.qfingerprint.json');

/** 서명에 넣는 지문 앞부분의 길이. */
const PROMPT_CHARS = 200;

// ------------------------------------------------------------------ 서명

/** prompt 정규화 — NFC → 태그 제거 → 공백 접기 → trim. */
function normalizePrompt(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 문항 하나의 서명(sha1 hex 40자). 단위 테스트가 직접 부를 수 있도록 순수 함수다. */
function fingerprintOf(question) {
  const q = question && typeof question === 'object' ? question : {};
  const head = normalizePrompt(q.prompt).slice(0, PROMPT_CHARS);
  const fieldCount = Array.isArray(q.fields) ? q.fields.length : 0;
  const bodyRaw = typeof q.bodyText === 'string' && q.bodyText !== '' ? q.bodyText : q.bodyHtml;
  const body = normalizePrompt(bodyRaw).slice(0, PROMPT_CHARS);
  return crypto.createHash('sha1')
    .update(head + '|' + fieldCount + '|' + body, 'utf8')
    .digest('hex');
}

// ------------------------------------------------------------- 디스크 판독

/** data/rounds/*.json 의 회차 id 목록(파일명 기준, 정렬). */
function roundIds() {
  return fs
    .readdirSync(ROUNDS_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => path.basename(n, '.json'))
    .sort();
}

/**
 * 전 회차를 읽어 `{ "<qid>": "<sha1>" }` 을 만든다.
 * 읽지 못한 회차는 errors 에 남기고 건너뛰지 않는다(검증 실패로 이어진다).
 * @returns {{ map: Record<string,string>, errors: string[], rounds: number }}
 */
function buildFingerprints() {
  const map = Object.create(null);
  const errors = [];
  const rounds = roundIds();

  for (const round of rounds) {
    const file = path.join(ROUNDS_DIR, round + '.json');
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`data/rounds/${round}.json 을 읽을 수 없습니다: ${e.message}`);
      continue;
    }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.questions)) {
      errors.push(`data/rounds/${round}.json 의 questions 가 배열이 아닙니다.`);
      continue;
    }
    for (const q of doc.questions) {
      const id = q && typeof q.id === 'string' ? q.id : '';
      if (!id) {
        errors.push(`data/rounds/${round}.json 에 id 가 없는 문항이 있습니다.`);
        continue;
      }
      if (id in map) {
        errors.push(`문항 id 중복: ${id}`);
        continue;
      }
      map[id] = fingerprintOf(q);
    }
  }

  return { map, errors, rounds: rounds.length };
}

/** 저장된 서명 파일. 없으면 null, 형식이 깨졌으면 Error 를 던진다. */
function readStored() {
  let text;
  try {
    text = fs.readFileSync(FINGERPRINT_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('최상위가 { "<문항 id>": "<sha1>" } 객체가 아닙니다.');
  }
  return doc;
}

/** 키 순서를 고정해(정렬) 쓴다 — 재생성해도 diff 가 흔들리지 않는다. */
function writeFingerprints(map) {
  const sorted = {};
  for (const id of Object.keys(map).sort()) sorted[id] = map[id];
  fs.writeFileSync(FINGERPRINT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  return Object.keys(sorted).length;
}

/** 목록이 길면 앞의 몇 개만 보여 준다. */
function head(list, n) {
  return list.length <= n ? list.join(', ') : list.slice(0, n).join(', ') + ` … (+${list.length - n})`;
}

// ------------------------------------------------------------------- 본문

const RULE_TEXT = [
  '  규칙: 문항 id 불변 · 삭제 대신 tombstone · 추가는 append only.',
  '  회차 중간 문항을 지우고 뒤 문항을 당겨 **재번호**하면 id 집합은 그대로인데',
  '  해설(data/explanations)·유형(data/types)·언어(data/langs)가 전부 다른 문항에 붙습니다.',
  '  검증기 3종은 id 집합만 보므로 이 오염을 잡지 못합니다 — 그래서 이 서명이 있습니다.',
  '',
  '  문항을 정당하게 고쳤다면(오탈자 교정·지문 보강·회차 추가):',
  '    node scripts/fingerprint-questions.mjs --write',
  '  로 서명을 갱신하고, 사이드카 3종이 여전히 옳은 문항을 가리키는지 눈으로 확인하십시오.',
].join('\n');

function main(argv = process.argv.slice(2)) {
  if (!fs.existsSync(ROUNDS_DIR)) {
    console.error(`[FAIL] 라운드 디렉터리가 없다: ${ROUNDS_DIR}`);
    process.exit(1);
  }

  const write = argv.includes('--write');
  const built = buildFingerprints();

  for (const e of built.errors) console.log(`  (오류) ${e}`);

  if (built.errors.length > 0) {
    console.log('');
    console.error('FINGERPRINT FAILED — 회차 파일을 읽지 못했습니다. 먼저 `npm run validate` 를 통과시키십시오.');
    process.exit(1);
  }

  const current = Object.keys(built.map);

  if (write) {
    const n = writeFingerprints(built.map);
    console.log(`회차 ${built.rounds}개, 문항 ${n}개의 서명을 data/.qfingerprint.json 에 기록했습니다.`);
    console.log('');
    console.log('FINGERPRINT WRITTEN');
    return;
  }

  let stored;
  try {
    stored = readStored();
  } catch (e) {
    console.error('[FAIL] data/.qfingerprint.json 을 읽을 수 없습니다: ' + e.message);
    console.log('');
    console.log(RULE_TEXT);
    process.exit(1);
  }

  if (stored === null) {
    console.error('[FAIL] data/.qfingerprint.json 이 없습니다. 이 파일은 커밋 대상입니다.');
    console.log('');
    console.log('  최초 생성: node scripts/fingerprint-questions.mjs --write');
    console.log('');
    console.log(RULE_TEXT);
    process.exit(1);
  }

  const storedIds = Object.keys(stored);
  const have = new Set(storedIds);
  const want = new Set(current);

  const missing = current.filter((id) => !have.has(id));   // 회차에는 있는데 서명에 없다
  const extra = storedIds.filter((id) => !want.has(id));   // 서명에는 있는데 회차에서 사라졌다
  const changed = current.filter((id) => have.has(id) && stored[id] !== built.map[id]);

  console.log(`회차 ${built.rounds}개, 문항 ${current.length}개 — 저장된 서명 ${storedIds.length}개`);

  if (missing.length === 0 && extra.length === 0 && changed.length === 0) {
    console.log('');
    console.log('FINGERPRINT OK');
    return;
  }

  console.log('');
  console.log(`--- 불일치 상세 (변경 ${changed.length} · 누락 ${missing.length} · 잉여 ${extra.length}) ---`);
  if (changed.length) {
    console.log(`  [변경] 서명이 달라진 문항 ${changed.length}개: ${head(changed, 20)}`);
    console.log('         → 지문 앞 200자나 답 칸 수가 바뀌었습니다. **재번호로 문항이 밀린 것인지 먼저 의심하십시오.**');
  }
  if (missing.length) {
    console.log(`  [누락] 서명에 없는 문항 ${missing.length}개: ${head(missing, 20)}`);
    console.log('         → 문항이 새로 추가됐다면 --write 로 갱신하면 됩니다(append only).');
  }
  if (extra.length) {
    console.log(`  [잉여] 회차에서 사라진 문항 ${extra.length}개: ${head(extra, 20)}`);
    console.log('         → **문항 삭제는 금지입니다.** 지우지 말고 tombstone 으로 남기십시오.');
  }
  console.log('');
  console.log(RULE_TEXT);
  console.log('');
  console.error('FINGERPRINT FAILED');
  process.exit(1);
}

// `node -e` 나 테스트에서 import 할 때 argv[1] 이 없을 수 있다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { main, fingerprintOf, normalizePrompt, buildFingerprints, PROMPT_CHARS, FINGERPRINT_FILE };
