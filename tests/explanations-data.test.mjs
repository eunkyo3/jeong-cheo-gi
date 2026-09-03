// explanations-data.test.mjs — 해설(data/explanations)의 **실데이터 회귀 검사**.
//
// `tests/explanations.test.mjs` 는 계약(마크업 린터·채점 전 비노출)을 본다. 여기서는
// **디스크에 실제로 있는 420문항이 지금 이 순간 전부 해설을 갖고 있는가**를 본다
// (프런트 리뷰 6-5 — langs.test.mjs 의 실데이터 검사 대응물).
//
// 해설이 빠진 문항은 서버가 죽지 않고 **빈 해설 패널**을 내보낸다(rounds.js 가 회차 단위 경고만 남긴다).
// 조용히 비는 그 상태를 `npm test` 가 잡아 준다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { lintHtml, MIN_LEN, MAX_LEN } from '../scripts/validate-explanations.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPLAIN_DIR = path.join(ROOT, 'data', 'explanations');
const rounds = require('../server/rounds.js');

/** data/explanations/*.json 파일 이름(확장자 제외). */
function explainFileStems() {
  return fs.readdirSync(EXPLAIN_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => path.basename(n, '.json'))
    .sort();
}

describe('실데이터 — data/explanations/*.json 은 회차 문항과 정확히 맞물린다', () => {
  test('회차마다 해설 파일이 있고 문항 id 집합이 정확히 같다 (누락·잉여 0)', () => {
    const loaded = rounds.listRounds();
    assert.ok(loaded.length > 0, '회차가 하나도 로드되지 않았다');

    for (const meta of loaded) {
      const file = path.join(EXPLAIN_DIR, meta.round + '.json');
      assert.ok(fs.existsSync(file), `data/explanations/${meta.round}.json 이 없다`);

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(doc.round, meta.round);

      const ids = rounds.getRound(meta.round).questions.map((q) => q.id);
      assert.deepEqual(Object.keys(doc.explanations).sort(), ids.slice().sort(), meta.round);
    }
  });

  test('회차가 없는 잉여 해설 파일이 없다', () => {
    const known = new Set(rounds.listRounds().map((m) => m.round));
    const orphans = explainFileStems().filter((stem) => !known.has(stem));
    assert.deepEqual(orphans, [], '회차 파일이 없는 data/explanations/*.json');
  });

  test('사이드카 디렉터리에는 회차 JSON 만 있다 (문서는 docs/explanations/)', () => {
    const strays = fs.readdirSync(EXPLAIN_DIR).filter((n) => !n.toLowerCase().endsWith('.json'));
    assert.deepEqual(strays, [], 'data/explanations/ 에 JSON 이 아닌 파일이 섞였다');
  });

  test('로드된 전 문항이 비어 있지 않은 해설을 갖는다', () => {
    const blank = [];
    for (const q of rounds.allQuestions()) {
      const html = rounds.explanationOf(q.id);
      assert.equal(typeof html, 'string', q.id);
      if (html === '') blank.push(q.id);
    }
    assert.deepEqual(blank, [], '해설이 비어 채점 후 빈 패널이 나가는 문항');
  });

  test('붙은 해설이 마크업 계약(허용 태그·길이)을 지킨다', () => {
    const bad = [];
    for (const q of rounds.allQuestions()) {
      const html = rounds.explanationOf(q.id);
      const problems = lintHtml(html);
      if (problems.length) bad.push(`${q.id}: ${problems[0]}`);
      if (html.length < MIN_LEN || html.length > MAX_LEN) {
        bad.push(`${q.id}: 길이 ${html.length} (허용 ${MIN_LEN}~${MAX_LEN})`);
      }
    }
    assert.deepEqual(bad.slice(0, 10), [], '해설 마크업 계약 위반');
  });
});
