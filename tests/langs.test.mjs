// langs.test.mjs — 코드 문항 언어 오버레이(data/langs) 단위 + REST 종단 검증.
//
// 앞부분은 순수 모듈(server/rounds.js · server/battle.js · scripts/validate-langs.mjs) 단위 검사,
// 뒷부분은 practice-api.test.mjs 와 같은 방식으로 실서버를 임시 포트(PORT=0) + 격리된 임시 DATA_DIR 로
// 띄우고 fetch 로 두드린다(실제 data/ 는 건드리지 않는다. 회차·유형·언어 JSON 은 repo 것을 읽는다).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startServer } from './lib/server.mjs';

import { isValidLang, LANGS as VALIDATOR_LANGS } from '../scripts/validate-langs.mjs';
import { io as ioClient } from 'socket.io-client';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rounds = require('../server/rounds.js');
const battle = require('../server/battle.js');

const ROUND_ID = '2026-2'; // c 3 · java 2 · python 2 (세 언어가 모두 있는 회차)
const ROUND = require(`../data/rounds/${ROUND_ID}.json`);
const TOTAL = ROUND.questions.length;

/** 문항의 sampleAnswer 를 채점 API 가 받는 문자열 배열로. */
function sampleAnswerOf(q) {
  return (q.fields || []).map((f) => (f.sampleAnswer == null ? '' : String(f.sampleAnswer)));
}

// ================================================================= 단위 검사

describe('언어 상수·조회기 (server/rounds.js)', () => {
  test('LANGS 는 c/java/python 동결 집합이고 검증기와 같다', () => {
    assert.deepEqual(rounds.LANGS, ['c', 'java', 'python']);
    assert.deepEqual(VALIDATOR_LANGS, rounds.LANGS);
    assert.deepEqual(battle.LANGS, rounds.LANGS);
  });

  test('isLang / isValidLang 은 같은 값만 통과시킨다', () => {
    for (const v of ['c', 'java', 'python']) {
      assert.equal(rounds.isLang(v), true, v);
      assert.equal(isValidLang(v), true, v);
      assert.equal(battle.normalizeLang(v), v, v);
    }
    for (const v of ['C', 'Java', 'PYTHON', 'js', 'sql', '', ' c', null, undefined, 3, {}, ['c']]) {
      assert.equal(rounds.isLang(v), false, String(v));
      assert.equal(isValidLang(v), false, String(v));
      assert.equal(battle.normalizeLang(v), null, String(v));
    }
  });

  test('langOf 는 코드 문항에만 값을 주고, 그 밖에는 전부 null', () => {
    let code = 0;
    let nonCode = 0;
    for (const q of rounds.allQuestions()) {
      const lang = rounds.langOf(q);
      if (rounds.typeOf(q) === 'code') {
        code += 1;
        assert.ok(lang === null || rounds.isLang(lang), q.id + ' → ' + lang);
      } else {
        nonCode += 1;
        assert.equal(lang, null, q.id + ' 는 코드가 아닌데 lang 이 붙었다: ' + lang);
      }
    }
    assert.ok(code > 0 && nonCode > 0);

    // 유형이 code 가 아니면 lang 필드가 붙어 있어도 무시한다(오버레이가 잘못돼도 새지 않는다)
    assert.equal(rounds.langOf({ id: 'x', type: 'theory', lang: 'java' }), null);
    assert.equal(rounds.langOf({ id: 'x', type: 'code', lang: 'java' }), 'java');
    assert.equal(rounds.langOf({ id: 'x', type: 'code', lang: 'ruby' }), null);
    assert.equal(rounds.langOf({ id: 'x', type: 'code' }), null);
    assert.equal(rounds.langOf(null), null);
  });

  test('전 회차 코드 문항이 모두 분류돼 있다 (139문항)', () => {
    const code = rounds.allQuestions().filter((q) => rounds.typeOf(q) === 'code');
    const unclassified = code.filter((q) => rounds.langOf(q) === null).map((q) => q.id);
    assert.deepEqual(unclassified, [], '언어 미분류 코드 문항: ' + unclassified.join(', '));
    assert.equal(code.length, 139);
  });

  test('filterByLang — 언어별로 좁히고, 값이 없으면 전체', () => {
    const all = rounds.getRound(ROUND_ID).questions;
    assert.equal(rounds.filterByLang(all, null).length, all.length);
    assert.equal(rounds.filterByLang(all, 'nope').length, all.length); // 허용값 밖 = 전체(=필터 없음)
    assert.notEqual(rounds.filterByLang(all, null), all); // 사본이다

    for (const lang of rounds.LANGS) {
      const got = rounds.filterByLang(all, lang);
      for (const q of got) {
        assert.equal(rounds.typeOf(q), 'code');
        assert.equal(rounds.langOf(q), lang);
      }
    }
    // 유형 필터와 순서를 바꿔도 결과가 같다 (언어는 코드 문항에만 있으므로)
    assert.deepEqual(
      rounds.filterByLang(rounds.filterByType(all, 'code'), 'java').map((q) => q.id),
      rounds.filterByLang(all, 'java').map((q) => q.id)
    );
    assert.equal(rounds.filterByLang(rounds.filterByType(all, 'sql'), 'java').length, 0);
  });

  test('countLangs 합계는 countTypes.code 를 넘지 않는다', () => {
    for (const meta of rounds.listRounds()) {
      const qs = rounds.getRound(meta.round).questions;
      const langs = rounds.countLangs(qs);
      const sum = rounds.LANGS.reduce((a, l) => a + langs[l], 0);
      assert.deepEqual(Object.keys(langs).sort(), ['c', 'java', 'python']);
      assert.ok(sum <= rounds.countTypes(qs).code, meta.round);
      for (const l of rounds.LANGS) {
        assert.equal(langs[l], rounds.filterByLang(qs, l).length, meta.round + '/' + l);
      }
    }
    assert.deepEqual(rounds.countLangs([]), { c: 0, java: 0, python: 0 });
    assert.deepEqual(rounds.countLangs(null), { c: 0, java: 0, python: 0 });
  });

  test('publicQuestion 에 lang 이 실리고 정답 계열은 여전히 막힌다', () => {
    const java = rounds.filterByLang(rounds.getRound(ROUND_ID).questions, 'java')[0];
    const pub = rounds.publicQuestion(java);
    assert.deepEqual(Object.keys(pub).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    assert.equal(pub.lang, 'java');
    assert.equal(pub.type, 'code');

    const theory = rounds.getRound(ROUND_ID).questions.find((q) => rounds.typeOf(q) !== 'code');
    assert.equal(rounds.publicQuestion(theory).lang, null); // 키는 있고 값만 null

    // battle 쪽 사본도 같은 규칙이다
    const bpub = battle.publicQuestion(java);
    assert.equal(bpub.lang, 'java');
    assert.equal(battle.publicQuestion(theory).lang, null);
    assert.equal(bpub.explanationHtml, undefined);
    assert.equal(bpub.sampleAnswer, undefined);
    assert.equal(bpub.display, undefined);
  });

  test('data/langs/*.json 은 회차·코드 문항과 정확히 맞물린다', () => {
    for (const meta of rounds.listRounds()) {
      const file = path.join(ROOT, 'data', 'langs', meta.round + '.json');
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(doc.round, meta.round);
      const codeIds = rounds.getRound(meta.round).questions
        .filter((q) => rounds.typeOf(q) === 'code').map((q) => q.id);
      assert.deepEqual(Object.keys(doc.langs).sort(), codeIds.slice().sort(), meta.round);
      for (const qid of Object.keys(doc.langs)) assert.equal(isValidLang(doc.langs[qid]), true, qid);
    }
  });
});

// ================================================================ REST 종단

let srv = null;
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
  // PORT=0 → OS 가 비어 있는 포트를 고른다. 포트 추첨·충돌 없음 (서버 M-16).
  // BATTLE_COUNTDOWN_MS 로 3초 카운트다운을 80ms 로 줄인다 — 아래 대전 시나리오 2건이
  // 벽시계로 3초씩 자던 것을 없앤다(`server/battle.js` 의 envMs, production 에서는 무시된다).
  srv = await startServer({ prefix: 'jpk-langs-', env: { BATTLE_COUNTDOWN_MS: '80' } });
  base = srv.base;
});

after(async () => {
  // 자식이 정말 끝난 뒤에 임시 디렉터리를 지운다 — kill 만 하고 넘어가면 Windows 에서 EBUSY 가 난다.
  await srv.stop();
});

describe('GET /api/rounds — 회차 목록의 langs 집계', () => {
  test('모든 항목에 langs 가 있고 합계가 counts.code 와 맞는다', async () => {
    const r = await api('GET', '/api/rounds');
    assert.equal(r.status, 200);
    assert.ok(r.json.length >= 21);
    for (const item of r.json) {
      assert.deepEqual(Object.keys(item.langs).sort(), ['c', 'java', 'python'], item.round);
      const sum = item.langs.c + item.langs.java + item.langs.python;
      // 코드 문항이 전부 분류돼 있으므로 정확히 같다(미분류가 생기면 sum < code 가 된다)
      assert.equal(sum, item.counts.code, item.round);
    }
  });
});

describe('GET /api/rounds/:id?lang=', () => {
  test('lang=java 는 java 코드 문항만, type 은 code 로 에코된다', async () => {
    const r = await api('GET', `/api/rounds/${ROUND_ID}?lang=java`);
    assert.equal(r.status, 200);
    assert.equal(r.json.lang, 'java');
    assert.equal(r.json.type, 'code'); // lang 만 와도 type=code 로 간주한다(C3)
    assert.ok(r.json.questions.length > 0);
    assert.ok(r.json.questions.length < TOTAL);
    for (const q of r.json.questions) {
      assert.equal(q.lang, 'java');
      assert.equal(q.type, 'code');
      assert.deepEqual(Object.keys(q).sort(), ['bodyHtml', 'fields', 'id', 'lang', 'num', 'prompt', 'type']);
    }
  });

  test('type=code&lang=c 는 허용, type=sql&lang=java 는 400', async () => {
    const ok = await api('GET', `/api/rounds/${ROUND_ID}?type=code&lang=c`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.lang, 'c');
    for (const q of ok.json.questions) assert.equal(q.lang, 'c');

    const bad = await api('GET', `/api/rounds/${ROUND_ID}?type=sql&lang=java`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');

    const bad2 = await api('GET', `/api/rounds/${ROUND_ID}?type=theory&lang=c`);
    assert.equal(bad2.status, 400);
    assert.equal(bad2.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');
  });

  test('허용값 밖의 lang 은 400, 빈 값·all 은 전체', async () => {
    const bad = await api('GET', `/api/rounds/${ROUND_ID}?lang=ruby`);
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '언어는 c/java/python 중 하나여야 합니다.');

    for (const q of ['', 'lang=', 'lang=all']) {
      const r = await api('GET', `/api/rounds/${ROUND_ID}?${q}`);
      assert.equal(r.status, 200, q);
      assert.equal(r.json.lang, null, q);
      assert.equal(r.json.questions.length, TOTAL, q);
    }
  });
});

describe('GET /api/practice?lang=', () => {
  test('lang=python 이면 전 문항이 python 이다', async () => {
    const r = await api('GET', '/api/practice?rounds=all&count=10&lang=python');
    assert.equal(r.status, 200);
    assert.equal(r.json.lang, 'python');
    assert.equal(r.json.type, 'code');
    assert.equal(r.json.questions.length, 10);
    for (const q of r.json.questions) {
      assert.equal(q.lang, 'python');
      assert.equal(q.type, 'code');
    }
  });

  test('type=theory&lang=python 은 400', async () => {
    const bad = await api('GET', '/api/practice?rounds=all&count=10&type=theory&lang=python');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');
  });
});

describe('GET /api/me/wrong/explain (C5 — 채점 전 해설 예외)', () => {
  const graded = [];   // 채점 기록이 생긴 문항 id
  let ungraded = '';   // 같은 회차이지만 채점하지 않은 문항 id

  test('비로그인은 401', async () => {
    assert.equal(jar.size, 0);
    const r = await api('GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(ROUND.questions[0].id));
    assert.equal(r.status, 401);
  });

  test('가입 → 코드 문항만 채점해 이력을 만든다', async () => {
    const up = await api('POST', '/api/auth/signup', { nickname: '언어테스터', password: 'pw12345678' });
    assert.equal(up.status, 200, up.text);

    // 유형을 걸어 채점하면 question_ids 도 그 부분집합이다 — 권한 경계를 만들기 좋다
    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'code', answers: {} });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.type, 'code');
    assert.equal(g.json.lang, null);

    // 유형은 오버레이라 원본 JSON 이 아니라 로더(server/rounds.js)에게 물어야 한다
    for (const q of rounds.getRound(ROUND_ID).questions) {
      if (rounds.typeOf(q) === 'code') graded.push(q.id);
      else if (!ungraded) ungraded = q.id;
    }
    assert.equal(g.json.totalCount, graded.length);
    assert.ok(ungraded);
  });

  test('채점 기록이 있는 문항은 display + html 을 준다', async () => {
    const r = await api('GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(graded[0]));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json), ['explanations']);
    const e = r.json.explanations[graded[0]];
    assert.ok(e, graded[0] + ' 가 빠졌다');
    assert.deepEqual(Object.keys(e).sort(), ['display', 'html']);
    assert.equal(typeof e.display, 'string');
    assert.equal(typeof e.html, 'string');
    // repo 데이터의 실제 값과 같아야 한다
    const src = ROUND.questions.find((q) => q.id === graded[0]);
    assert.equal(e.display, src.display == null ? '' : src.display);
    assert.ok(e.html.length > 0, '해설이 비었다');
  });

  test('채점 기록이 없는 문항·없는 문항 id 는 조용히 생략한다(403 아님)', async () => {
    const ids = [graded[0], ungraded, '없는회차#999'].join(',');
    const r = await api('GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(ids));
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.explanations), [graded[0]]);
  });

  test('ids 가 없거나 비면 400, 51개를 넘으면 400', async () => {
    assert.equal((await api('GET', '/api/me/wrong/explain')).status, 400);
    assert.equal((await api('GET', '/api/me/wrong/explain?ids=')).status, 400);
    assert.equal((await api('GET', '/api/me/wrong/explain?ids=,,%20,')).status, 400);

    const fifty = Array.from({ length: 50 }, (_, i) => 'x#' + i).join(',');
    assert.equal((await api('GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(fifty))).status, 200);

    const fiftyOne = Array.from({ length: 51 }, (_, i) => 'x#' + i).join(',');
    const over = await api('GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(fiftyOne));
    assert.equal(over.status, 400);
    assert.ok(over.json.error.includes('50'), over.json.error);
  });
});

describe('GET /api/me/wrong?lang=', () => {
  test('오답노트 전체 뷰가 언어로 좁혀지고 lang 을 에코한다', async () => {
    const all = await api('GET', '/api/me/wrong');
    assert.equal(all.status, 200);
    assert.equal(all.json.lang, null);
    assert.ok(all.json.questions.length > 0);
    assert.ok(all.json.questions.every((q) => q.type === 'code')); // 코드만 채점했다

    for (const lang of ['c', 'java', 'python']) {
      const r = await api('GET', '/api/me/wrong?lang=' + lang);
      assert.equal(r.status, 200);
      assert.equal(r.json.lang, lang);
      assert.equal(r.json.type, 'code');
      for (const q of r.json.questions) assert.equal(q.lang, lang);
      assert.equal(
        r.json.questions.length,
        all.json.questions.filter((q) => q.lang === lang).length,
        lang
      );
    }
  });

  test('회차 하위 뷰에서도 언어 필터가 걸린다', async () => {
    const r = await api('GET', `/api/me/wrong?round=${ROUND_ID}&lang=java`);
    assert.equal(r.status, 200);
    assert.equal(r.json.round, ROUND_ID);
    assert.equal(r.json.lang, 'java');
    assert.ok(r.json.questions.length > 0);
    for (const q of r.json.questions) {
      assert.equal(q.lang, 'java');
      assert.ok(q.id.startsWith(ROUND_ID + '#'));
    }
  });

  test('type=sql&lang=java 는 400', async () => {
    const bad = await api('GET', '/api/me/wrong?type=sql&lang=java');
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');
  });

  test('허브 요약의 회차 항목에도 langs 집계가 붙는다', async () => {
    const r = await api('GET', '/api/me/wrong/summary');
    assert.equal(r.status, 200);
    const mine = r.json.byRound.find((x) => x.round === ROUND_ID);
    assert.ok(mine);
    assert.deepEqual(Object.keys(mine.langs).sort(), ['c', 'java', 'python']);
    assert.equal(mine.langs.c + mine.langs.java + mine.langs.python, mine.counts.code);
  });

  test('언어를 지정해 채점하면 그 부분집합만 채점된다', async () => {
    const wrongJava = await api('GET', '/api/me/wrong?lang=java');
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const q of wrongJava.json.questions) answers[q.id] = sampleAnswerOf(byId.get(q.id));

    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { lang: 'java', answers });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.lang, 'java');
    assert.equal(g.json.type, 'code');
    assert.equal(g.json.totalCount, wrongJava.json.questions.length);
    assert.equal(g.json.score, 100);

    // java 오답만 정리되고 다른 언어는 그대로 남는다
    const after = await api('GET', '/api/me/wrong?lang=java');
    assert.equal(after.json.questions.length, 0);
    assert.ok((await api('GET', '/api/me/wrong?lang=c')).json.questions.length > 0);
  });
});

// ------------------------------------------------- 대전 방 언어 옵션 (C4)

describe('POST /api/rooms — 방 언어 옵션', () => {
  const sockets = [];

  /** 쿠키를 물고 붙는 소켓. 접속이 끝나면 resolve. */
  function connect() {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    return new Promise((res, rej) => {
      const sk = ioClient(base, { extraHeaders: { cookie }, transports: ['websocket'] });
      sockets.push(sk);
      const to = setTimeout(() => rej(new Error('socket connect timeout')), 10000);
      sk.on('connect', () => { clearTimeout(to); res(sk); });
      sk.on('connect_error', (e) => { clearTimeout(to); rej(e); });
    });
  }

  /** 이벤트 하나를 기다린다. */
  function once(sk, name) {
    return new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(name + ' 대기 시간 초과')), 10000);
      sk.once(name, (p) => { clearTimeout(to); res(p); });
    });
  }

  after(() => { for (const sk of sockets) { try { sk.close(); } catch { /* 이미 닫힘 */ } } });

  test('lang=python 방은 문항 풀이 python 코드 문항으로 좁혀진다', async () => {
    const langs = rounds.countLangs(rounds.getRound(ROUND_ID).questions);
    assert.ok(langs.python > 0);

    const r = await api('POST', '/api/rooms', {
      name: '파이썬방', mode: 'round', roundIds: [ROUND_ID], lang: 'python', timeLimitS: 600,
    });
    assert.equal(r.status, 200, r.text);

    const sk = await connect();
    const state = once(sk, 'room:state');
    sk.emit('room:join', { roomId: r.json.roomId });
    const payload = await state;

    assert.equal(payload.settings.lang, 'python');
    assert.equal(payload.settings.type, 'code'); // lang 만 보내도 type 은 code 로 고정된다
    assert.equal(payload.settings.questionCount, langs.python); // 회차 20문항이 아니라 python 문항 수

    // 방 목록 요약에도 lang 이 실린다
    const list = await api('GET', '/api/rooms');
    const mine = list.json.find((x) => x.roomId === r.json.roomId);
    assert.ok(mine, '방 목록에 없다');
    assert.equal(mine.lang, 'python');
    assert.equal(mine.type, 'code');
    assert.equal(mine.questionCount, langs.python);

    sk.emit('room:leave', { roomId: r.json.roomId });
    sk.close();
  });

  test('lang 없는 방은 lang=null 로 나간다', async () => {
    const r = await api('POST', '/api/rooms', {
      name: '전체방', mode: 'round', roundIds: [ROUND_ID], timeLimitS: 600,
    });
    assert.equal(r.status, 200, r.text);
    const sk = await connect();
    const state = once(sk, 'room:state');
    sk.emit('room:join', { roomId: r.json.roomId });
    const payload = await state;
    assert.equal(payload.settings.lang, null);
    assert.ok(Object.prototype.hasOwnProperty.call(payload.settings, 'lang'));
    assert.equal(payload.settings.questionCount, TOTAL);
    sk.emit('room:leave', { roomId: r.json.roomId });
    sk.close();
  });

  test('type 이 code 가 아닌데 lang 을 주면 400, 허용값 밖도 400', async () => {
    const combo = await api('POST', '/api/rooms', {
      name: 'x', mode: 'round', roundIds: [ROUND_ID], type: 'sql', lang: 'java', timeLimitS: 600,
    });
    assert.equal(combo.status, 400);
    assert.equal(combo.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');

    const bad = await api('POST', '/api/rooms', {
      name: 'x', mode: 'round', roundIds: [ROUND_ID], lang: 'ruby', timeLimitS: 600,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '언어는 c/java/python 중 하나여야 합니다.');

    // type=code 와 함께면 통과한다
    const ok = await api('POST', '/api/rooms', {
      name: 'x', mode: 'round', roundIds: [ROUND_ID], type: 'code', lang: 'java', timeLimitS: 600,
    });
    assert.equal(ok.status, 200, ok.text);
  });

  test('그 회차에 없는 언어를 고르면 "해당 언어의 문항이 없습니다."', async () => {
    // 코드 문항이 없거나 특정 언어가 0개인 회차를 찾아 쓴다
    const empty = rounds.listRounds().find((m) => m.langs.python === 0);
    if (!empty) return; // 전 회차에 python 이 있으면 검사할 수 없다(데이터가 늘면 자연히 건너뛴다)
    const r = await api('POST', '/api/rooms', {
      name: 'x', mode: 'round', roundIds: [empty.round], lang: 'python', timeLimitS: 600,
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '해당 언어의 문항이 없습니다.');
  });
});

// ------------------------- 언어 부분집합 채점 (C3 — 채점 분모가 어긋나지 않는다)

describe('POST /api/rounds/:id/grade — body.lang', () => {
  const qs = rounds.getRound(ROUND_ID).questions;
  const LANG_COUNTS = rounds.countLangs(qs);
  const TYPE_COUNTS = rounds.countTypes(qs);

  test('lang=java 로 채점하면 분모가 그 회차 java 문항 수다', async () => {
    // 언어 분모가 코드 전체·회차 전체와 실제로 달라야 이 검사가 의미를 갖는다
    assert.ok(LANG_COUNTS.java > 0);
    assert.notEqual(LANG_COUNTS.java, TYPE_COUNTS.code);
    assert.notEqual(LANG_COUNTS.java, TOTAL);

    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { lang: 'java', answers: {} });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.round, ROUND_ID); // 언어를 걸어도 회차 id 그대로다(이력 집계 키)
    assert.equal(g.json.lang, 'java');
    assert.equal(g.json.type, 'code');    // lang 만 보내도 code 로 간주해 에코된다
    assert.equal(g.json.totalCount, LANG_COUNTS.java);
    assert.equal(g.json.details.length, LANG_COUNTS.java);
    for (const d of g.json.details) {
      assert.equal(rounds.langOf(rounds.getQuestion(d.questionId)), 'java', d.questionId);
    }
    // 채점 후 부가 자산도 같은 부분집합만 덮는다
    assert.deepEqual(Object.keys(g.json.explanations).sort(),
      rounds.filterByLang(qs, 'java').map((q) => q.id).sort());
    assert.deepEqual(Object.keys(g.json.bodyTexts).sort(), Object.keys(g.json.explanations).sort());
  });

  test('오답노트도 그 부분집합만 반영한다 (분모가 어긋나지 않는다)', async () => {
    // 바로 앞 채점에서 java 문항을 전부 무응답 처리했으므로 java 만 오답으로 남는다
    const w = await api('GET', '/api/me/wrong?lang=java');
    assert.equal(w.status, 200);
    assert.equal(w.json.questions.length, LANG_COUNTS.java);

    // 정답으로 다시 채점하면 그만큼만 정리된다
    const byId = new Map(ROUND.questions.map((q) => [q.id, q]));
    const answers = {};
    for (const q of w.json.questions) answers[q.id] = sampleAnswerOf(byId.get(q.id));
    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { lang: 'java', answers });
    assert.equal(g.json.totalCount, LANG_COUNTS.java);
    assert.equal(g.json.score, 100);
    assert.equal((await api('GET', '/api/me/wrong?lang=java')).json.questions.length, 0);
  });

  test('type=code&lang=c 는 허용되고 분모는 c 문항 수다', async () => {
    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'code', lang: 'c', answers: {} });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.lang, 'c');
    assert.equal(g.json.totalCount, LANG_COUNTS.c);
  });

  test('lang 을 안 보내면 예전과 같다 — type=code 는 코드 전체', async () => {
    const g = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'code', answers: {} });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.lang, null);
    assert.equal(g.json.totalCount, TYPE_COUNTS.code);

    const plain = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { answers: {} });
    assert.equal(plain.json.type, null);
    assert.equal(plain.json.lang, null);
    assert.equal(plain.json.totalCount, TOTAL);
  });

  test('type 이 code 가 아닌데 lang 을 주면 400, 허용값 밖도 400', async () => {
    const combo = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'sql', lang: 'java', answers: {} });
    assert.equal(combo.status, 400);
    assert.equal(combo.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');

    const theory = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { type: 'theory', lang: 'c', answers: {} });
    assert.equal(theory.status, 400);
    assert.equal(theory.json.error, 'lang 은 코드 문항에만 쓸 수 있습니다.');

    const bad = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { lang: 'ruby', answers: {} });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, '언어는 c/java/python 중 하나여야 합니다.');

    // 빈 값·all 은 전체(= 언어 필터 없음)
    for (const lang of ['', 'all']) {
      const r = await api('POST', `/api/rounds/${ROUND_ID}/grade`, { lang: lang, answers: {} });
      assert.equal(r.status, 200, lang);
      assert.equal(r.json.lang, null, lang);
      assert.equal(r.json.totalCount, TOTAL, lang);
    }
  });

  test('그 회차에 없는 언어면 "해당 언어의 문항이 없습니다."', async () => {
    const empty = rounds.listRounds().find((m) => m.langs.python === 0);
    if (!empty) return; // 전 회차에 python 이 있으면 검사할 수 없다
    const r = await api('POST', `/api/rounds/${empty.round}/grade`, { lang: 'python', answers: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, '해당 언어의 문항이 없습니다.');
  });
});

// ------------------- C5 권한 = "그 사용자의" 채점 이력 (교차 사용자 · 대전 경로)

describe('/api/me/wrong/explain — 권한 경계', () => {
  const BATTLE_ROUND_ID = '2023-3'; // A 가 학습 모드로 채점한 적 없는 회차
  let cookieA = '';
  let cookieB = '';
  const sockets = [];

  /** 공유 jar 를 건드리지 않고 **지정한 쿠키로** 두드린다(사용자 두 명을 동시에 다뤄야 한다). */
  async function as(cookie, method, p, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    if (cookie) headers.cookie = cookie;
    const resp = await fetch(base + p, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = (resp.headers.getSetCookie ? resp.headers.getSetCookie() : []).map((l) => l.split(';')[0]);
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아닐 수 있다 */ }
    return { status: resp.status, json, text, cookie: set[0] || cookie };
  }

  function connectAs(cookie) {
    return new Promise((res, rej) => {
      const sk = ioClient(base, { extraHeaders: { cookie }, transports: ['websocket'] });
      sockets.push(sk);
      const to = setTimeout(() => rej(new Error('socket connect timeout')), 10000);
      sk.on('connect', () => { clearTimeout(to); res(sk); });
      sk.on('connect_error', (e) => { clearTimeout(to); rej(e); });
    });
  }

  function waitFor(sk, name, pred, ms) {
    const ok = pred || (() => true);
    return new Promise((res, rej) => {
      const to = setTimeout(() => { sk.off(name, h); rej(new Error(name + ' 대기 시간 초과')); }, ms || 10000);
      function h(p) {
        if (!ok(p)) return;
        clearTimeout(to);
        sk.off(name, h);
        res(p);
      }
      sk.on(name, h);
    });
  }

  after(() => { for (const sk of sockets) { try { sk.close(); } catch { /* 이미 닫힘 */ } } });

  test('남이 채점한 문항은 내 explain 에서 생략된다 (401 도 403 도 아닌 조용한 생략)', async () => {
    cookieA = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const mine = ROUND.questions[0].id; // A 가 앞선 테스트에서 회차 전체를 채점했다

    const forA = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(mine));
    assert.equal(forA.status, 200);
    assert.ok(forA.json.explanations[mine], 'A 는 자기 채점 문항을 볼 수 있어야 한다');

    // 다른 사용자로 가입해 **같은 id** 를 요청한다
    const up = await as('', 'POST', '/api/auth/signup', { nickname: '교차테스터', password: 'pw12345678' });
    assert.equal(up.status, 200, up.text);
    cookieB = up.cookie;
    assert.ok(cookieB && cookieB !== cookieA);

    const forB = await as(cookieB, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(mine));
    assert.equal(forB.status, 200); // 인증은 됐다 — 401 이 아니다
    assert.deepEqual(forB.json.explanations, {}, 'B 에게 A 의 채점 문항이 새면 안 된다');

    // A 의 세션은 그대로다(쿠키가 서로 섞이지 않았다)
    const again = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(mine));
    assert.ok(again.json.explanations[mine]);
  });

  test('대전으로 쌓인 채점 이력(round=battle)도 권한이 된다', async () => {
    // 대전 전: A 는 이 회차를 채점한 적이 없으므로 생략된다
    const probe = rounds.getRound(BATTLE_ROUND_ID).questions[0].id;
    const before = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(probe));
    assert.equal(before.status, 200);
    assert.deepEqual(before.json.explanations, {}, '대전 전에는 권한이 없어야 한다');

    // A(방장) + B 로 그 회차 대전을 한 판 끝낸다
    const room = await as(cookieA, 'POST', '/api/rooms', {
      name: 'peek대전', mode: 'round', roundIds: [BATTLE_ROUND_ID], timeLimitS: 600,
    });
    assert.equal(room.status, 200, room.text);
    const roomId = room.json.roomId;

    const sA = await connectAs(cookieA);
    const sB = await connectAs(cookieB);
    sA.emit('room:join', { roomId });
    await waitFor(sA, 'room:state', (p) => p.players.length === 1);
    sB.emit('room:join', { roomId });
    await waitFor(sA, 'room:state', (p) => p.players.length === 2);

    sA.emit('room:start', {});
    // 카운트다운은 BATTLE_COUNTDOWN_MS=80 으로 줄여 뒀다(before 참조) — 벽시계로 3초를 자지 않는다.
    const qs = await waitFor(sA, 'battle:questions', null, 15000);
    assert.ok(qs.questions.length > 0);

    sA.emit('battle:submit', {});
    sB.emit('battle:submit', {});
    await waitFor(sA, 'battle:finished', null, 15000);

    // 대전 종료로 study_results(round='battle') 1행이 적재됐다 → 그 문항들이 권한 집합에 든다
    const qid = qs.questions[0].id;
    const after = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(qid));
    assert.equal(after.status, 200);
    const e = after.json.explanations[qid];
    assert.ok(e, '대전에서 푼 문항인데 권한이 없다: ' + qid);
    assert.deepEqual(Object.keys(e).sort(), ['display', 'html']);
    const src = rounds.getQuestion(qid);
    assert.equal(e.display, src.display == null ? '' : src.display);
    assert.equal(e.html, rounds.explanationOf(qid));

    // 그 대전에 참여하지 않은 회차 문항은 여전히 생략된다(대전이 백지수표가 아니다)
    const other = rounds.getRound('2020-1').questions[0].id;
    const still = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(other));
    assert.deepEqual(still.json.explanations, {});
  });

  test('ids 상한은 중복 제거 전에 걸린다 — 같은 id 를 51번 보내도 400', async () => {
    const dup = new Array(51).fill(ROUND.questions[0].id).join(',');
    const r = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(dup));
    assert.equal(r.status, 400);
    assert.ok(r.json.error.includes('50'), r.json.error);

    // 50개(중복 포함)는 통과하고, 중복 제거 결과 1건만 나간다
    const fifty = new Array(50).fill(ROUND.questions[0].id).join(',');
    const ok = await as(cookieA, 'GET', '/api/me/wrong/explain?ids=' + encodeURIComponent(fifty));
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.json.explanations), [ROUND.questions[0].id]);
  });
});
