// fingerprint.test.mjs — 문항 지문 서명(data/.qfingerprint.json) 회귀 검사.
//
// 서명이 막는 사고: 회차 중간 문항을 지우고 뒤 문항을 **재번호**하면 id 집합은 그대로인데
// 해설·유형·언어가 전부 다른 문항에 붙는다. 검증기 3종은 id 집합만 보므로 못 잡는다
// (프런트 리뷰 6-2). 규칙: **문항 id 불변 · 삭제 대신 tombstone · 추가는 append only.**
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { fingerprintOf, normalizePrompt, buildFingerprints } from '../scripts/fingerprint-questions.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', '.qfingerprint.json');
const rounds = require('../server/rounds.js');

describe('문항 지문 서명 — data/.qfingerprint.json', () => {
  test('파일이 있고 전 문항을 정확히 덮는다 (누락·잉여 0)', () => {
    assert.ok(fs.existsSync(FILE),
      'data/.qfingerprint.json 이 없다 — node scripts/fingerprint-questions.mjs --write');
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const ids = rounds.allQuestions().map((q) => q.id).sort();
    assert.deepEqual(Object.keys(stored).sort(), ids);
  });

  test('저장된 서명이 지금 디스크의 문항과 일치한다', () => {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const built = buildFingerprints();
    assert.deepEqual(built.errors, []);
    const changed = Object.keys(built.map).filter((id) => stored[id] !== built.map[id]);
    assert.deepEqual(changed, [],
      '문항 내용이 서명과 어긋난다 — 재번호로 밀린 것이 아닌지 먼저 확인할 것');
  });

  test('한 회차 안에서는 서명이 전부 다르다 (한 칸 밀림을 반드시 잡는다)', () => {
    for (const meta of rounds.listRounds()) {
      const qs = rounds.getRound(meta.round).questions;
      const seen = new Set(qs.map((q) => fingerprintOf(q)));
      assert.equal(seen.size, qs.length, `${meta.round} 안에 같은 서명의 문항이 있다`);
    }
  });

  test('서명은 지문 앞부분·답 칸 수·본문에 반응한다', () => {
    const base = { prompt: '다음 빈칸을 채우시오.', fields: [{ label: '답' }], bodyText: 'A = 1;' };
    const same = { prompt: ' 다음   빈칸을 채우시오. ', fields: [{ label: '다른 라벨' }], bodyHtml: '<p>A = 1;</p>' };
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base }));
    // 공백 접기·태그 제거·라벨 무관 — 같은 문항으로 본다
    assert.equal(fingerprintOf(base), fingerprintOf({ ...same, bodyText: 'A = 1;' }));
    // 답 칸 수가 늘면 다른 서명
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, fields: [{ label: '답' }, { label: '답2' }] }));
    // 지문이 바뀌면 다른 서명
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, prompt: '다음 코드의 출력을 쓰시오.' }));
    // 본문이 바뀌면 다른 서명 (정형 발문끼리 갈라내는 부분)
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, bodyText: 'A = 2;' }));
  });

  test('normalizePrompt 는 NFC·태그 제거·공백 접기를 한다', () => {
    assert.equal(normalizePrompt('<p>가  나\n다</p>'), '가 나 다');
    assert.equal(normalizePrompt(null), '');
    assert.equal(normalizePrompt(undefined), '');
  });
});
