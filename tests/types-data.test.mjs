// types-data.test.mjs — 유형 오버레이(data/types)의 **실데이터 회귀 검사**.
//
// `tests/types.test.mjs` 는 계약(값 집합·publicQuestion·필터)을 본다. 여기서는 그 계약이 아니라
// **디스크에 실제로 있는 420문항이 지금 이 순간 전부 분류돼 있는가**를 본다
// (프런트 리뷰 6-5 — langs.test.mjs 의 "data/langs/*.json 은 회차·코드 문항과 정확히 맞물린다" 대응물).
//
// 검증기(`npm run validate:types`)와 겹치지만 겹치는 것이 목적이다: 검증기는 사람이 기억해서
// 돌려야 하고, 이 파일은 `npm test` 가 늘 돌린다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { isValidType, TYPES as VALIDATOR_TYPES } from '../scripts/validate-types.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES_DIR = path.join(ROOT, 'data', 'types');
const rounds = require('../server/rounds.js');

/** data/types/*.json 파일 이름(확장자 제외). */
function typeFileStems() {
  return fs.readdirSync(TYPES_DIR)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .map((n) => path.basename(n, '.json'))
    .sort();
}

describe('실데이터 — data/types/*.json 은 회차 문항과 정확히 맞물린다', () => {
  test('회차마다 분류 파일이 있고 문항 id 집합이 정확히 같다 (누락·잉여 0)', () => {
    const loaded = rounds.listRounds();
    assert.ok(loaded.length > 0, '회차가 하나도 로드되지 않았다');

    for (const meta of loaded) {
      const file = path.join(TYPES_DIR, meta.round + '.json');
      assert.ok(fs.existsSync(file), `data/types/${meta.round}.json 이 없다`);

      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(doc.round, meta.round);

      const ids = rounds.getRound(meta.round).questions.map((q) => q.id);
      assert.deepEqual(Object.keys(doc.types).sort(), ids.slice().sort(), meta.round);

      for (const qid of Object.keys(doc.types)) {
        assert.equal(isValidType(doc.types[qid]), true, `${qid} = ${JSON.stringify(doc.types[qid])}`);
      }
    }
  });

  test('회차가 없는 잉여 분류 파일이 없다', () => {
    const known = new Set(rounds.listRounds().map((m) => m.round));
    const orphans = typeFileStems().filter((stem) => !known.has(stem));
    assert.deepEqual(orphans, [], '회차 파일이 없는 data/types/*.json');
  });

  test('로드된 전 문항에 유효한 type 이 붙어 있다 (기본값으로 떨어진 문항 0)', () => {
    const files = new Map();
    for (const meta of rounds.listRounds()) {
      files.set(meta.round, JSON.parse(fs.readFileSync(path.join(TYPES_DIR, meta.round + '.json'), 'utf8')).types);
    }

    let checked = 0;
    const defaulted = [];
    for (const q of rounds.allQuestions()) {
      const t = rounds.typeOf(q);
      assert.equal(isValidType(t), true, `${q.id} 의 type=${JSON.stringify(t)}`);
      // 서버가 붙인 값과 파일의 값이 같아야 한다 — 사이드카가 다른 문항에 붙었는지 잡는다.
      const round = q.id.split('#')[0];
      const fromFile = (files.get(round) || {})[q.id];
      if (fromFile === undefined) defaulted.push(q.id);
      else assert.equal(t, fromFile, q.id);
      checked++;
    }
    assert.deepEqual(defaulted, [], '분류 파일이 닿지 않아 기본값으로 떨어진 문항');
    assert.equal(checked, rounds.allQuestions().length);
  });

  test('검증기와 서버가 같은 유형 집합을 쓴다', () => {
    assert.deepEqual(VALIDATOR_TYPES, rounds.TYPES);
    assert.ok(rounds.TYPES.includes(rounds.DEFAULT_TYPE));
  });
});
