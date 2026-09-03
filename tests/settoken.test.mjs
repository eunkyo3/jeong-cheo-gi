// settoken.test.mjs — 채점 세트 토큰(server/settoken.js) 단위 검증.
//
// 이 토큰이 하는 일은 하나다: "이 사용자에게 서버가 실제로 내준 문항 집합" 을 증명한다.
// 그러니 검증도 그 한 문장이 깨지는 경우만 본다 — 위조·다른 사용자·만료·형식 불량.
//
// 서명 키는 격리된 임시 DATA_DIR 에 만든다(실제 data/secret.key 는 건드리지 않는다).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-settoken-'));
const auth = require(path.join(ROOT, 'server', 'auth.js'));
auth.loadSecret(tmp); // settoken 이 require 되기 전에 키를 격리 디렉터리로 못박는다
const settoken = require(path.join(ROOT, 'server', 'settoken.js'));

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

const IDS = ['2026-2#1', '2026-2#2', '2024-1#7'];

// 서명 도메인 접두사. **테스트가 일부러 상수를 베껴 든다** — 여기 값이 바뀌면 발급된 토큰이
// 전부 무효가 되므로, 코드를 import 해서 따라가는 게 아니라 wire 형식을 못박아야 한다.
const SIGN_PREFIX = 'jpk_set.v1:';

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** settoken 과 같은 규칙으로 payload 를 직접 서명한다(만료·위조 시나리오를 만들기 위해). */
function forge(payload, prefix = SIGN_PREFIX) {
  const b64 = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', auth.loadSecret()).update(prefix + b64).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64 + '.' + sig;
}

const nowS = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ 왕복

describe('signSet / verifySet 왕복', () => {
  test('발급한 사용자가 열면 같은 id 목록이 순서 그대로 나온다', () => {
    const t = settoken.signSet(7, IDS);
    assert.equal(typeof t, 'string');
    assert.deepEqual(settoken.verifySet(t, 7), IDS);
  });

  test('중복 id 는 한 번만 담긴다 (집합 크기 = 채점 분모)', () => {
    const t = settoken.signSet(7, ['a#1', 'a#1', 'a#2']);
    assert.deepEqual(settoken.verifySet(t, 7), ['a#1', 'a#2']);
  });

  test('빈 문자열·null·과도하게 긴 id 는 빠진다', () => {
    const t = settoken.signSet(7, ['', null, undefined, 'x'.repeat(65), 'a#1']);
    assert.deepEqual(settoken.verifySet(t, 7), ['a#1']);
  });

  test('id 가 하나도 남지 않으면 검증도 실패한다 (채점할 게 없다)', () => {
    assert.equal(settoken.verifySet(settoken.signSet(7, []), 7), null);
    assert.equal(settoken.verifySet(settoken.signSet(7, ['', null]), 7), null);
  });

  test('MAX_IDS 를 넘겨 발급하면 상한에서 잘린다', () => {
    const many = Array.from({ length: settoken.MAX_IDS + 50 }, (_v, i) => 'q#' + i);
    const ids = settoken.verifySet(settoken.signSet(7, many), 7);
    assert.equal(ids.length, settoken.MAX_IDS);
  });

  test('userId 는 문자열로 들어와도 같은 숫자면 열린다 (라우트가 넘기는 값이 섞일 수 있다)', () => {
    assert.deepEqual(settoken.verifySet(settoken.signSet(7, IDS), '7'), IDS);
  });
});

// ------------------------------------------------------------- 실패 경로

describe('verifySet 이 null 을 내는 경우', () => {
  test('다른 사용자의 토큰은 열리지 않는다', () => {
    const t = settoken.signSet(7, IDS);
    assert.equal(settoken.verifySet(t, 8), null);
    assert.equal(settoken.verifySet(t, 0), null);
  });

  test('페이로드를 고치면 서명이 깨진다 (문항을 끼워 넣을 수 없다)', () => {
    const t = settoken.signSet(7, IDS);
    const sig = t.slice(t.indexOf('.') + 1);
    const tampered = Buffer.from(JSON.stringify({ uid: 7, qs: ['훔친문항#1'], iat: nowS() }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(settoken.verifySet(tampered + '.' + sig, 7), null);
  });

  test('서명 한 글자만 바꿔도 실패한다', () => {
    const t = settoken.signSet(7, IDS);
    const flipped = t.slice(0, -1) + (t.slice(-1) === 'A' ? 'B' : 'A');
    assert.equal(settoken.verifySet(flipped, 7), null);
  });

  test('6시간을 넘긴 토큰은 만료다', () => {
    const fresh = forge({ uid: 7, qs: IDS, iat: nowS() - (settoken.MAX_AGE_S - 60) });
    assert.deepEqual(settoken.verifySet(fresh, 7), IDS);

    const stale = forge({ uid: 7, qs: IDS, iat: nowS() - (settoken.MAX_AGE_S + 60) });
    assert.equal(settoken.verifySet(stale, 7), null);
  });

  test('서명은 맞지만 내용이 계약을 벗어난 페이로드도 거절한다', () => {
    assert.equal(settoken.verifySet(forge({ uid: 7, iat: nowS() }), 7), null, 'qs 없음');
    assert.equal(settoken.verifySet(forge({ uid: 7, qs: 'a#1', iat: nowS() }), 7), null, 'qs 가 배열이 아님');
    assert.equal(settoken.verifySet(forge({ uid: 7, qs: [1, 2], iat: nowS() }), 7), null, 'id 가 문자열이 아님');
    assert.equal(settoken.verifySet(forge({ uid: 7, qs: ['x'.repeat(65)], iat: nowS() }), 7), null, 'id 가 너무 김');
    assert.equal(settoken.verifySet(forge({ uid: 7.5, qs: IDS, iat: nowS() }), 7.5), null, 'uid 가 정수가 아님');
    assert.equal(settoken.verifySet(forge({ uid: 7, qs: IDS }), 7), null, 'iat 없음');
    assert.equal(
      settoken.verifySet(forge({ uid: 7, qs: Array.from({ length: settoken.MAX_IDS + 1 }, (_v, i) => 'q#' + i), iat: nowS() }), 7),
      null, 'MAX_IDS 초과',
    );
  });

  test('형식이 아닌 값은 전부 null (던지지 않는다)', () => {
    for (const bad of ['', '.', 'abc', 'abc.', '.abc', 'a.b.c', null, undefined, 42, {}, []]) {
      assert.equal(settoken.verifySet(bad, 7), null, JSON.stringify(bad));
    }
  });
});

// ------------------------------- 서명 도메인 분리 (Phase 3 재검토)
//
// 세트 토큰·세션 쿠키·관리자 쿠키는 **같은 키**(auth.loadSecret)로 서명한다. 서명 대상 문자열에
// 용도 접두사를 붙이지 않으면 한 용도의 토큰이 다른 용도로 그대로 통한다 — 실제로 뚫렸다:
// 접두사가 없던 시절 `GET /api/practice` 가 준 setToken 을 `Cookie: jpk_sess=<setToken>` 으로
// 넣으면 세션 쿠키로 받아들여져 그 사용자로 로그인됐다(/api/auth/me 200, 소켓 handshake 통과).
//
// payload 모양(qs 유무)에 기대는 방어는 다른 모듈의 규율에 기대는 것이라 언제든 어긋난다.
// 그래서 두 방향을 **양쪽 모듈의 공개 함수로** 못박는다.

describe('서명 도메인 — 세트 토큰과 세션 쿠키는 서로 통하지 않는다', () => {
  test('세트 토큰을 세션 쿠키 자리에 넣으면 auth.readSession 이 거절한다', () => {
    const setTok = settoken.signSet(7, IDS);
    assert.equal(auth.readSession('jpk_sess=' + setTok), null);
    // 쿠키가 여러 개 섞여 있어도 마찬가지다
    assert.equal(auth.readSession('other=1; jpk_sess=' + setTok + '; x=2'), null);
  });

  test('세션 쿠키를 세트 토큰 자리에 넣으면 verifySet 이 거절한다', () => {
    const sess = auth.makeToken(7, 0);
    assert.equal(settoken.verifySet(sess, 7), null);
    assert.equal(settoken.verifySet(auth.makeToken(7), 7), null); // sv 없는 형태도
  });

  test('접두사 없이 서명한 세트 토큰은 거절한다 (도메인 접두사 회귀)', () => {
    const raw = forge({ uid: 7, qs: IDS, iat: nowS() }, '');
    assert.equal(settoken.verifySet(raw, 7), null);
    // 접두사를 붙여 서명하면 같은 payload 가 통과한다 — 차이는 접두사 하나뿐이다
    assert.deepEqual(settoken.verifySet(forge({ uid: 7, qs: IDS, iat: nowS() }), 7), IDS);
  });

  test('다른 용도의 접두사로 서명해도 통하지 않는다', () => {
    for (const p of ['jpk_sess.v1:', 'jpk_admin.v1:', 'jpk_set.v2:', 'JPK_SET.V1:']) {
      assert.equal(settoken.verifySet(forge({ uid: 7, qs: IDS, iat: nowS() }, p), 7), null, p);
    }
  });

  test('세션 payload 모양을 세트 토큰 키로 서명해도 세션이 되지 않는다', () => {
    // "settoken 이 세션처럼 생긴 payload 를 발급하도록 유도" 하는 경로가 생기더라도 막힌다
    const looksLikeSession = forge({ uid: 7, sv: 0, iat: nowS() });
    assert.equal(auth.readSession('jpk_sess=' + looksLikeSession), null);
  });
});
