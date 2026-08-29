// practice-api.test.mjs — 학습 이력 · 오답노트 · 랜덤 모의고사 REST 종단 검증.
//
// 실서버를 임의 포트 + 격리된 임시 DATA_DIR 로 띄우고 fetch 로 두드린다(실제 data/ 는 건드리지 않는다).
// 회차 JSON 은 항상 repo 의 data/rounds 를 읽으므로 sampleAnswer 를 그대로 정답으로 쓸 수 있다.
// 테스트는 위에서 아래로 이어지는 하나의 시나리오다(가입 → 채점 → 이력 → 오답노트 → 오답 정리).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUND_ID = '2026-2';
const ROUND = require(`../data/rounds/${ROUND_ID}.json`);
const TOTAL = ROUND.questions.length;

/** 문항의 sampleAnswer 를 채점 API 가 받는 문자열 배열로. */
function sampleAnswerOf(q) {
  return (q.fields || []).map((f) => (f.sampleAnswer == null ? '' : String(f.sampleAnswer)));
}

// ------------------------------------------------------------ 서버 + 쿠키

let srv = null;
let tmp = '';
let base = '';
const jar = new Map();

/** 쿠키 항아리를 물고 다니는 최소 API 클라이언트. */
async function api(method, p, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
  if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const resp = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of resp.headers.getSetCookie ? resp.headers.getSetCookie() : []) {
    const kv = line.split(';')[0];
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON 이 아닐 수 있다 */ }
  return { status: resp.status, json, text };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-practice-'));
  const port = 3000 + Math.floor(Math.random() * 20000);
  base = 'http://localhost:' + port;
  srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  await new Promise((res, rej) => {
    const iv = setInterval(() => {
      if (out.includes('종료: Ctrl+C')) { clearInterval(iv); clearTimeout(to); res(); }
      else if (/EADDRINUSE/.test(out)) { clearInterval(iv); clearTimeout(to); rej(new Error('server: ' + out)); }
    }, 100);
    const to = setTimeout(() => { clearInterval(iv); rej(new Error('server start timeout\n' + out)); }, 20000);
  });
});

after(() => {
  try { srv.kill(); } catch { /* 이미 종료 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

// --------------------------------------------------------------- 모의고사

describe('GET /api/practice', () => {
  test('rounds=all&count=10 — 여러 회차에서 10문항, 정답 계열 필드는 없다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=10');
    assert.equal(r.status, 200);
    assert.equal(r.json.setKey, 'practice');
    assert.equal(r.json.questions.length, 10);
    assert.ok(r.json.title.includes('10문항'), r.json.title);
    assert.ok(Array.isArray(r.json.roundIds) && r.json.roundIds.length > 1);

    // 전 회차 풀에서 뽑으므로 한 회차에서만 10문항이 나올 일은 사실상 없다
    const usedRounds = new Set(r.json.questions.map((q) => q.id.split('#')[0]));
    assert.ok(usedRounds.size >= 2, [...usedRounds].join(','));

    for (const q of r.json.questions) {
      // 공개 문항의 키 집합을 못박는다 — accept/sampleAnswer/validator/display/bodyText 유출 차단
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt']);
      for (const f of q.fields) assert.deepEqual(Object.keys(f), ['label']);
    }
  });

  test('count 범위 밖 / 없는 회차는 400', async () => {
    assert.equal((await api('GET', '/api/practice?rounds=all&count=3')).status, 400);
    assert.equal((await api('GET', '/api/practice?rounds=all&count=61')).status, 400);
    assert.equal((await api('GET', '/api/practice?rounds=all&count=abc')).status, 400);

    const bad = await api('GET', '/api/practice?rounds=nope&count=10');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '없는 회차입니다: nope');
  });
});

describe('POST /api/practice/grade', () => {
  test('정답 2문항이면 100점 + bodyTexts 동봉', async () => {
    const [a, b] = ROUND.questions;
    const r = await api('POST', '/api/practice/grade', {
      setKey: 'practice',
      answers: { [a.id]: sampleAnswerOf(a), [b.id]: sampleAnswerOf(b) },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.round, 'practice');
    assert.equal(r.json.correctCount, 2);
    assert.equal(r.json.totalCount, 2);
    assert.equal(r.json.score, 100);
    assert.equal(r.json.details.length, 2);
    // 채점 후에는 지문 원문을 내보낸다 (AI 질문 프롬프트 조립용)
    assert.ok(r.json.bodyTexts[a.id].length > 0);
    assert.ok(r.json.bodyTexts[b.id].length > 0);
  });

  test('모르는 setKey / 실존 문항 0개는 400', async () => {
    const badKey = await api('POST', '/api/practice/grade', { setKey: 'nope', answers: {} });
    assert.equal(badKey.status, 400);

    const empty = await api('POST', '/api/practice/grade', {
      setKey: 'practice', answers: { '없는문항#9': ['x'] },
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, '채점할 문항이 없습니다.');
  });
});

// ------------------------------------------------------- 이력 · 오답노트

describe('학습 이력 · 오답노트', () => {
  test('비로그인 /api/me/history 는 401', async () => {
    assert.equal(jar.size, 0);
    const r = await api('GET', '/api/me/history');
    assert.equal(r.status, 401);
    assert.equal((await api('GET', '/api/me/wrong')).status, 401);
  });

  test('가입 → 1문항만 맞혀 채점 → 이력에 집계된다', async () => {
    const up = await api('POST', '/api/auth/signup', { nickname: '이력테스터', password: 'pw1234' });
    assert.equal(up.status, 200, up.text);

    const first = ROUND.questions[0];
    const graded = await api('POST', `/api/rounds/${ROUND_ID}/grade`, {
      answers: { [first.id]: sampleAnswerOf(first) }, // 나머지 문항은 무응답 = 오답
    });
    assert.equal(graded.status, 200);
    assert.equal(graded.json.correctCount, 1);
    assert.equal(graded.json.totalCount, TOTAL);

    const h = await api('GET', '/api/me/history');
    assert.equal(h.status, 200);
    assert.equal(h.json.rounds[ROUND_ID].count, 1);
    assert.equal(h.json.rounds[ROUND_ID].best, graded.json.score);
    assert.equal(h.json.rounds[ROUND_ID].last, graded.json.score);
    assert.ok(h.json.rounds[ROUND_ID].lastAt);
    assert.equal(h.json.recent[0].round, ROUND_ID);
    assert.equal(h.json.recent[0].total, TOTAL);
    assert.equal(h.json.recent[0].correct, 1);
    assert.equal(h.json.wrongCount, TOTAL - 1);
  });

  test('오답노트는 틀린 문항만 담고, 다시 맞히면 빠진다', async () => {
    const w = await api('GET', '/api/me/wrong');
    assert.equal(w.status, 200);
    assert.equal(w.json.setKey, 'wrong');
    assert.equal(w.json.title, '오답노트');
    assert.equal(w.json.questions.length, TOTAL - 1);
    assert.ok(!w.json.questions.some((q) => q.id === ROUND.questions[0].id)); // 맞힌 문항은 빠진다
    for (const q of w.json.questions) {
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'num', 'prompt']);
    }

    // 오답노트를 전부 맞히면 비워진다
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const q of w.json.questions) answers[q.id] = sampleAnswerOf(byId.get(q.id));
    const g = await api('POST', '/api/practice/grade', { setKey: 'wrong', answers });
    assert.equal(g.status, 200);
    assert.equal(g.json.round, 'wrong');
    assert.equal(g.json.totalCount, TOTAL - 1);
    assert.equal(g.json.score, 100);

    const after = await api('GET', '/api/me/wrong');
    assert.equal(after.json.questions.length, 0);

    const h = await api('GET', '/api/me/history');
    assert.equal(h.json.wrongCount, 0);
    assert.equal(h.json.rounds.wrong.count, 1);   // 'wrong' 도 하나의 집합으로 집계된다
    assert.equal(h.json.rounds.wrong.best, 100);
    assert.equal(h.json.recent[0].round, 'wrong'); // 최신 먼저
    assert.equal(h.json.recent[0].correct, TOTAL - 1);
  });
});
