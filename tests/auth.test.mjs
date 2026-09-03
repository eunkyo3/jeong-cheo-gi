// auth.test.mjs — 비밀번호 해시(scrypt), 세션 세대, 레이트리밋, 신고 적재 단위 테스트.
// 서버를 띄우지 않는 순수 단위 테스트다(포트를 쓰지 않는다).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const auth = require('../server/auth.js');
const db = require('../server/db.js');
const { rateLimit, makeLimiter } = require('../server/ratelimit.js');
const reports = require('../server/reports.js');
const bcrypt = require('bcryptjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-auth-'));
}

// 서명 키는 프로세스당 한 번만 읽힌다 — 격리 디렉터리로 먼저 못박는다
const SECRET_DIR = tmpDir();
before(() => { auth.loadSecret(SECRET_DIR); });

// ------------------------------------------------------------- 토큰 위조 도구
// 서버가 쓰는 것과 같은 키로 임의의 payload 를 서명한다. "남의 토큰이 세션으로 통하는가" 를
// 물으려면 공격자가 실제로 만들 수 있는 것과 같은 물건을 만들어 넣어 봐야 한다.

const nowS = () => Math.floor(Date.now() / 1000);

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** prefix 를 HMAC 입력 앞에 붙여 서명한 `payload.sig` 토큰. */
function forge(prefix, payloadObj) {
  const crypto = require('node:crypto');
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = b64url(crypto.createHmac('sha256', auth.loadSecret()).update(prefix + payload).digest());
  return payload + '.' + sig;
}

/** 접두사 도입 이전 방식(= settoken·예전 세션 쿠키와 같은 방식). */
const forgeUnprefixed = payloadObj => forge('', payloadObj);
/** 지금 makeToken 이 쓰는 방식. */
const forgePrefixed = payloadObj => forge(auth.SESSION_SIG_PREFIX, payloadObj);

// -------------------------------------------------------------- 서명 키 파일
// loadSecret 은 모듈 전역에 키를 캐시하므로, 이미 키가 잡힌 이 프로세스에서는
// 자식 프로세스를 띄워 "처음 기동" 을 재현한다.

/** 격리 디렉터리에서 loadSecret 을 한 번 부르는 자식 프로세스. → {stdout, stderr, status} */
function runLoadSecret(dir) {
  const code = [
    'const auth = require(' + JSON.stringify(path.resolve('server/auth.js')) + ');',
    'const key = auth.loadSecret(' + JSON.stringify(dir) + ');',
    'process.stdout.write("KEYLEN=" + key.length);',
  ].join('\n');
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
}

describe('secret.key 파일 취급', () => {
  test('키가 없으면 32바이트를 만들고 로그에 실제 경로를 찍는다 (DATA_DIR 반영)', () => {
    const dir = tmpDir();
    const r = runLoadSecret(dir);
    assert.equal(r.status, 0, r.stderr);
    // stdout 에는 기동 로그도 함께 실린다 — 표식만 확인한다
    assert.ok(r.stdout.includes('KEYLEN=32'), r.stdout);

    const file = path.join(dir, 'secret.key');
    assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
    // 로그가 'data/secret.key' 로 고정돼 있으면 DATA_DIR 을 옮겼을 때 거짓말이 된다
    assert.ok(r.stdout.includes(file) || r.stderr.includes(file),
      '로그에 실제 경로가 없다: ' + r.stdout + r.stderr);
    assert.equal(/data[\\/]secret\.key/.test(r.stdout + r.stderr), false, '경로가 하드코딩돼 있다');
  });

  test('이미 있는 정상 키는 그대로 쓴다 (재생성하지 않는다)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secret.key');
    const fixed = 'a'.repeat(64);
    fs.writeFileSync(file, fixed, 'utf8');

    const r = runLoadSecret(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('KEYLEN=32'), r.stdout);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), fixed); // 건드리지 않았다
    assert.equal(fs.readdirSync(dir).length, 1);               // .invalid- 도 만들지 않았다
  });

  test('형식이 깨진 키는 실제로 새로 만든다 (빈 키로 서명하지 않는다)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'secret.key');
    fs.writeFileSync(file, 'not-a-hex-key', 'utf8');

    const r = runLoadSecret(dir);
    assert.equal(r.status, 0, r.stderr);
    // 예전에는 여기서 길이 0 버퍼가 나왔다 — 빈 키로 모든 쿠키를 서명하던 자리다
    assert.ok(r.stdout.includes('KEYLEN=32'), r.stdout);
    assert.equal(r.stdout.includes('KEYLEN=0'), false);
    assert.match(fs.readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);

    // 깨진 원본은 지우지 않고 옆으로 치워 둔다
    const aside = fs.readdirSync(dir).filter(n => n.startsWith('secret.key.invalid-'));
    assert.equal(aside.length, 1, fs.readdirSync(dir).join(','));
    assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), 'not-a-hex-key');
  });
});

// ------------------------------------------------------------ 비밀번호 해시

describe('비밀번호 해시 — scrypt', () => {
  test('hashPassword 는 scrypt$<salt>$<key> 모양이고 매번 다른 소금을 쓴다', async () => {
    const a = await auth.hashPassword('비밀번호12');
    const b = await auth.hashPassword('비밀번호12');
    assert.match(a, /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.notEqual(a, b);                       // 같은 비밀번호라도 해시는 달라야 한다
    assert.equal(a.split('$').length, 3);
    // key 는 32바이트
    assert.equal(Buffer.from(a.split('$')[2], 'base64').length, 32);
  });

  test('verifyPassword 는 맞는 비밀번호만 통과시킨다', async () => {
    const h = await auth.hashPassword('correct horse');
    assert.equal(await auth.verifyPassword('correct horse', h), true);
    assert.equal(await auth.verifyPassword('correct horsE', h), false);
    assert.equal(await auth.verifyPassword('', h), false);
  });

  test('깨진 해시·빈 해시는 조용히 false (예외를 던지지 않는다)', async () => {
    assert.equal(await auth.verifyPassword('x', ''), false);
    assert.equal(await auth.verifyPassword('x', null), false);
    assert.equal(await auth.verifyPassword('x', 'scrypt$'), false);
    assert.equal(await auth.verifyPassword('x', 'scrypt$abc'), false);
    assert.equal(await auth.verifyPassword('x', '알 수 없는 형식'), false);
  });

  test('예전 bcrypt 해시도 그대로 검증된다', async () => {
    const legacy = bcrypt.hashSync('옛비밀번호', 10);
    assert.equal(auth.isLegacyHash(legacy), true);
    assert.equal(auth.isLegacyHash(await auth.hashPassword('x')), false);
    assert.equal(await auth.verifyPassword('옛비밀번호', legacy), true);
    assert.equal(await auth.verifyPassword('틀린비밀번호', legacy), false);
  });
});

// ------------------------------------------------------------ 가입 / 로그인

describe('signup / login', () => {
  test('PW_MIN 은 8 이고 그보다 짧으면 가입이 거절된다', async () => {
    assert.equal(auth.PW_MIN, 8);
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      const short = await auth.signup(d, '짧은비번', '1234567');
      assert.equal(short.ok, false);
      assert.match(short.error, /8자 이상/);
      const ok = await auth.signup(d, '짧은비번', '12345678');
      assert.equal(ok.ok, true);
      assert.equal(ok.user.nickname, '짧은비번');
      assert.equal(ok.user.sv, 0);
    } finally {
      d.close();
    }
  });

  test('가입한 비밀번호는 scrypt 로 저장되고 그 비밀번호로 로그인된다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      const r = await auth.signup(d, '가입자', 'password!23');
      assert.equal(r.ok, true);
      const row = d.findUserByNickname('가입자');
      assert.match(row.password_hash, /^scrypt\$/);

      const ok = await auth.login(d, '가입자', 'password!23');
      assert.equal(ok.id, r.user.id);
      assert.equal(ok.sv, 0);
      assert.equal(await auth.login(d, '가입자', 'password!24'), null);
      assert.equal(await auth.login(d, '없는사람', 'password!23'), null);
      assert.equal(await auth.login(d, '', 'password!23'), null);
    } finally {
      d.close();
    }
  });

  // 보안 L-11 — 폭 0 문자와 양방향 재정의로 남과 똑같아 보이는 닉네임을 만들 수 없게 한다.
  // 테스트 문자열에 그 문자를 직접 적으면 **테스트 소스가 읽을 수 없게 되므로** 코드포인트로 만든다.
  const ch = cp => String.fromCharCode(cp);

  test('폭 0·양방향 문자가 섞인 닉네임은 가입이 거절된다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      const 막히는것 = [
        ['ZWSP', 0x200b], ['ZWNJ', 0x200c], ['ZWJ', 0x200d], ['LRM', 0x200e], ['RLM', 0x200f],
        ['LRE', 0x202a], ['RLE', 0x202b], ['PDF', 0x202c], ['LRO', 0x202d], ['RLO', 0x202e],
        ['WJ', 0x2060], ['U+206F', 0x206f], ['BOM', 0xfeff], ['제어문자', 0x07],
      ];
      for (const [name, cp] of 막히는것) {
        const r = await auth.signup(d, '홍' + ch(cp) + '길동', 'password12');
        assert.equal(r.ok, false, name + ' 이 통과했다');
        assert.equal(r.error, '닉네임에 사용할 수 없는 문자가 있습니다.', name);
      }
      // 하나도 만들어지지 않았다
      assert.equal(d.listUsers().length, 0);
    } finally {
      d.close();
    }
  });

  test('보통 문자는 그대로 통과한다 (범위 경계를 넘겨 막지 않는다)', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      // 금지 범위 바로 바깥 — 하이픈(U+2010)·따옴표(U+201A)·위첨자 0(U+2070)
      for (const [i, cp] of [0x2010, 0x201a, 0x2070].entries()) {
        const r = await auth.signup(d, '가' + ch(cp) + '나' + i, 'password12');
        assert.equal(r.ok, true, 'U+' + cp.toString(16) + ' 이 막혔다: ' + r.error);
      }
      assert.equal((await auth.signup(d, '홍길동', 'password12')).ok, true);
      assert.equal((await auth.signup(d, 'alice', 'password12')).ok, true);
    } finally {
      d.close();
    }
  });

  test('hasForbiddenNickChar 는 네 범위와 제어문자만 잡는다', () => {
    for (const cp of [0x00, 0x1f, 0x7f, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0xfeff]) {
      assert.equal(auth.hasForbiddenNickChar('a' + ch(cp) + 'b'), true, 'U+' + cp.toString(16));
    }
    for (const cp of [0x20, 0x41, 0x7e, 0x200a, 0x2010, 0x2029, 0x202f, 0x205f, 0x2070, 0xfefe]) {
      assert.equal(auth.hasForbiddenNickChar('a' + ch(cp) + 'b'), false, 'U+' + cp.toString(16));
    }
    assert.equal(auth.hasForbiddenNickChar(''), false);
    assert.equal(auth.hasForbiddenNickChar(null), false);
  });

  test('중복 닉네임은 한국어 사유로 거절한다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      assert.equal((await auth.signup(d, '중복닉', 'password12')).ok, true);
      const dup = await auth.signup(d, '중복닉', 'password34');
      assert.equal(dup.ok, false);
      assert.equal(dup.error, '이미 사용 중인 닉네임입니다.');
    } finally {
      d.close();
    }
  });

  test('bcrypt 계정은 로그인에 성공한 그 자리에서 scrypt 로 다시 저장된다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      // 예전 방식으로 직접 만든 계정 (짧은 비밀번호 — 기존 사용자는 길이 검사를 받지 않는다)
      const legacyHash = bcrypt.hashSync('pw12', 10);
      const row = d.createUser('옛사용자', legacyHash);
      assert.match(d.findUserById(row.id).password_hash, /^\$2/);

      const ok = await auth.login(d, '옛사용자', 'pw12');
      assert.equal(ok.id, row.id);
      // 재해시 완료 — 다음 로그인부터는 scrypt 경로만 탄다
      assert.match(d.findUserById(row.id).password_hash, /^scrypt\$/);
      assert.equal((await auth.login(d, '옛사용자', 'pw12')).id, row.id);
      assert.equal(await auth.login(d, '옛사용자', 'pw13'), null);
    } finally {
      d.close();
    }
  });

  test('실패한 로그인은 해시를 다시 쓰지 않는다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      const legacyHash = bcrypt.hashSync('올바른비번', 10);
      const row = d.createUser('안바뀜', legacyHash);
      assert.equal(await auth.login(d, '안바뀜', '틀린비번'), null);
      assert.equal(d.findUserById(row.id).password_hash, legacyHash);
    } finally {
      d.close();
    }
  });
});

// ------------------------------------------------------------- 세션 토큰

describe('세션 토큰 — session_version', () => {
  test('MAX_AGE_S 는 7일이다', () => {
    assert.equal(auth.MAX_AGE_S, 7 * 24 * 3600);
  });

  test('makeToken → readSession 왕복에서 uid·sv 가 보존된다', () => {
    const s = auth.readSession('jpk_sess=' + auth.makeToken(42, 3));
    assert.equal(s.uid, 42);
    assert.equal(s.sv, 3);
    assert.ok(Number.isFinite(s.iat));
  });

  test('sv 없는 예전 토큰은 sv 0 으로 읽힌다 (배포만으로 로그아웃되지 않는다)', () => {
    // 접두사 도입 이전에 발급된 쿠키 그대로 — payload {uid, iat}, 접두사 없는 서명
    const s = auth.readSession('jpk_sess=' + forgeUnprefixed({ uid: 7, iat: nowS() }));
    assert.equal(s.uid, 7);
    assert.equal(s.sv, 0);
  });

  test('sv 가 있는 예전 서명 쿠키도 계속 통한다 (접두사 배포 직전에 나간 것)', () => {
    const s = auth.readSession('jpk_sess=' + forgeUnprefixed({ uid: 8, sv: 4, iat: nowS() }));
    assert.equal(s.uid, 8);
    assert.equal(s.sv, 4);
  });

  test('makeToken 은 접두사 서명으로 발급한다 (접두사 없는 서명으로는 만들지 않는다)', () => {
    const crypto = require('node:crypto');
    const token = auth.makeToken(11, 2);
    const [payloadB64, sig] = token.split('.');
    const b64url = buf => Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const withPrefix = b64url(crypto.createHmac('sha256', auth.loadSecret())
      .update(auth.SESSION_SIG_PREFIX + payloadB64).digest());
    const withoutPrefix = b64url(crypto.createHmac('sha256', auth.loadSecret())
      .update(payloadB64).digest());

    assert.equal(auth.SESSION_SIG_PREFIX, 'jpk_sess.v1:');
    assert.equal(sig, withPrefix);
    assert.notEqual(sig, withoutPrefix);
    // 접두사는 서명 입력에만 들어간다 — 쿠키 값에는 나타나지 않는다
    assert.equal(token.includes('jpk_sess.v1:'), false);
    assert.deepEqual(auth.readSession('jpk_sess=' + token), { uid: 11, sv: 2, iat: JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).iat });
  });

  test('키가 같아도 다른 용도의 토큰은 세션이 아니다 (세트 토큰 혼동 차단)', () => {
    // settoken.signSet 과 똑같은 방식으로 만든 payload — 같은 키, 접두사 없음, uid·iat 있음.
    // 예전 readSession 은 이걸 세션으로 인정했다.
    const foreign = forgeUnprefixed({ uid: 5, qs: ['2026-2#1', '2026-2#2'], iat: nowS() });
    assert.equal(auth.readSession('jpk_sess=' + foreign), null);

    // 관리자 payload 모양도 마찬가지
    assert.equal(auth.readSession('jpk_sess=' + forgeUnprefixed({ uid: 5, adm: true, iat: nowS() })), null);
    // uid·sv·iat 에 키가 하나라도 더 붙으면 거절
    assert.equal(auth.readSession('jpk_sess=' + forgeUnprefixed({ uid: 5, sv: 0, iat: nowS(), extra: 1 })), null);
    // 접두사 서명이어도 모양이 어긋나면 거절한다 (양쪽 갈래 모두 막힌다)
    assert.equal(auth.readSession('jpk_sess=' + forgePrefixed({ uid: 5, qs: ['x'], iat: nowS() })), null);
  });

  test('isSessionPayloadShape 는 정확히 두 모양만 인정한다', () => {
    assert.equal(auth.isSessionPayloadShape({ uid: 1, iat: 2 }), true);
    assert.equal(auth.isSessionPayloadShape({ uid: 1, sv: 0, iat: 2 }), true);
    assert.equal(auth.isSessionPayloadShape({ iat: 2, sv: 0, uid: 1 }), true); // 키 순서는 무관
    assert.equal(auth.isSessionPayloadShape({ uid: 1 }), false);
    assert.equal(auth.isSessionPayloadShape({ uid: 1, iat: 2, qs: [] }), false);
    assert.equal(auth.isSessionPayloadShape({ uid: 1, sv: 0, iat: 2, adm: 1 }), false);
    assert.equal(auth.isSessionPayloadShape(null), false);
    assert.equal(auth.isSessionPayloadShape([]), false);
    assert.equal(auth.isSessionPayloadShape('x'), false);
  });

  test('sv 키가 있는데 값이 세션 세대가 아니면 거절한다 (0 으로 눙치지 않는다)', () => {
    assert.equal(auth.readSession('jpk_sess=' + forgePrefixed({ uid: 1, sv: 'x', iat: nowS() })), null);
    assert.equal(auth.readSession('jpk_sess=' + forgePrefixed({ uid: 1, sv: -1, iat: nowS() })), null);
    assert.equal(auth.readSession('jpk_sess=' + forgePrefixed({ uid: 1, sv: 1.5, iat: nowS() })), null);
  });

  test('만료된 쿠키는 접두사·레거시 양쪽 모두 거절한다', () => {
    const old = nowS() - auth.MAX_AGE_S - 60;
    assert.equal(auth.readSession('jpk_sess=' + forgePrefixed({ uid: 1, sv: 0, iat: old })), null);
    assert.equal(auth.readSession('jpk_sess=' + forgeUnprefixed({ uid: 1, iat: old })), null);
  });

  test('서명이 틀리거나 쿠키가 없으면 null', () => {
    assert.equal(auth.readSession(''), null);
    assert.equal(auth.readSession('other=1'), null);
    assert.equal(auth.readSession('jpk_sess=abc'), null);
    assert.equal(auth.readSession('jpk_sess=' + auth.makeToken(1, 0) + 'x'), null);
  });

  test('attachUser 는 sv 가 어긋난 쿠키를 비로그인으로 본다', async () => {
    const dir = tmpDir();
    const d = db.open({ dir, adapter: 'json' });
    try {
      const r = await auth.signup(d, '세션주인', 'password12');
      const mw = auth.attachUser(d);
      const run = token => {
        const req = { headers: { cookie: 'jpk_sess=' + token } };
        let called = false;
        mw(req, {}, () => { called = true; });
        assert.equal(called, true);
        return req.user;
      };

      const good = auth.makeToken(r.user.id, 0);
      assert.deepEqual(run(good), { id: r.user.id, nickname: '세션주인' });

      // 서버에서 세대를 올리면 이미 나간 쿠키가 전부 죽는다
      assert.equal(d.bumpSessionVersion(r.user.id), 1);
      assert.equal(run(good), null);
      // 새로 발급한 쿠키는 다시 통한다
      assert.deepEqual(run(auth.makeToken(r.user.id, 1)), { id: r.user.id, nickname: '세션주인' });
      // 없는 사용자
      assert.equal(run(auth.makeToken(99999, 0)), null);
    } finally {
      d.close();
    }
  });

  test('COOKIE_SECURE=1 이면 Set-Cookie 에 Secure 가 붙는다', () => {
    const headers = [];
    const res = { append: (k, v) => headers.push(v) };
    const before = process.env.COOKIE_SECURE;
    try {
      delete process.env.COOKIE_SECURE;
      auth.setSessionCookie(res, { id: 1, sv: 0 });
      assert.equal(/Secure/.test(headers[0]), false, headers[0]);
      assert.match(headers[0], /HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800/);

      process.env.COOKIE_SECURE = '1';
      auth.setSessionCookie(res, { id: 1, sv: 0 });
      assert.match(headers[1], /; Secure$/);
    } finally {
      if (before === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = before;
    }
  });
});

// -------------------------------------------------------------- 레이트리밋

describe('ratelimit', () => {
  /** rateLimit 미들웨어를 부르고 {status, body} 로 정리해 준다. */
  function call(mw, req) {
    let status = 200;
    let body = null;
    let passed = false;
    const res = {
      set() { return res; },
      status(s) { status = s; return res; },
      json(b) { body = b; return res; },
    };
    mw(req, res, () => { passed = true; });
    return { passed, status, body };
  }

  test('창 안에서 max 회까지 통과하고 그 뒤로 429 를 준다', () => {
    const mw = rateLimit({ windowMs: 60000, max: 3, keyOf: r => r.key, logErr() {} });
    const req = { key: 'a', socket: { remoteAddress: '1.1.1.1' } };
    for (let i = 0; i < 3; i += 1) assert.equal(call(mw, req).passed, true, 'i=' + i);
    const blocked = call(mw, req);
    assert.equal(blocked.passed, false);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    // 다른 키는 영향을 받지 않는다
    assert.equal(call(mw, { key: 'b', socket: { remoteAddress: '1.1.1.1' } }).passed, true);
  });

  test('lockMs 를 주면 창이 끝나도 잠금이 유지된다', () => {
    const lim = makeLimiter({ windowMs: 20, max: 2, lockMs: 10000 });
    assert.equal(lim.allow('k'), true);
    assert.equal(lim.allow('k'), true);
    assert.equal(lim.allow('k'), false); // 여기서 10초 잠금이 걸린다
    const until = Date.now() + 60;
    while (Date.now() < until) { /* 창(20ms)이 지나기를 기다린다 */ }
    assert.equal(lim.allow('k'), false, '창이 지나도 잠금은 남아 있어야 한다');
  });

  test('lockMs 없이 창이 지나면 다시 열린다', () => {
    const lim = makeLimiter({ windowMs: 20, max: 1 });
    assert.equal(lim.allow('k'), true);
    assert.equal(lim.allow('k'), false);
    const until = Date.now() + 60;
    while (Date.now() < until) { /* 창이 지나기를 기다린다 */ }
    assert.equal(lim.allow('k'), true);
  });

  test('키 수는 상한(5000)을 넘지 않는다', () => {
    const lim = makeLimiter({ windowMs: 600000, max: 1 });
    for (let i = 0; i < 5200; i += 1) lim.allow('k' + i);
    assert.ok(lim.size() <= 5000, String(lim.size()));
  });

  test('로그인 리미터는 닉네임+IP 를 키로 쓴다 (한쪽만 달라도 별개)', () => {
    const mw = rateLimit({
      windowMs: 60000,
      max: 2,
      keyOf: req => String(req.body.nickname) + '@' + req.socket.remoteAddress,
      logErr() {},
    });
    const mk = (nick, ip) => ({ body: { nickname: nick }, socket: { remoteAddress: ip } });
    assert.equal(call(mw, mk('철수', '1.1.1.1')).passed, true);
    assert.equal(call(mw, mk('철수', '1.1.1.1')).passed, true);
    assert.equal(call(mw, mk('철수', '1.1.1.1')).passed, false);
    assert.equal(call(mw, mk('철수', '2.2.2.2')).passed, true); // IP 가 다르면 별개
    assert.equal(call(mw, mk('영희', '1.1.1.1')).passed, true); // 닉네임이 다르면 별개
  });
});

// ------------------------------------------------------------- 신고 적재

describe('reports — JSONL 적재', () => {
  const entry = (i) => ({ at: new Date().toISOString(), questionId: '2026-2#' + i, myAnswer: [], comment: 'c' + i, byUserId: 1 });

  test('append 는 한 줄씩 쌓이고 listReports 는 최신순으로 준다', () => {
    const dir = tmpDir();
    reports.appendReport(entry(1), dir);
    reports.appendReport(entry(2), dir);
    reports.appendReport(entry(3), dir);

    const raw = fs.readFileSync(path.join(dir, 'reports.jsonl'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 3);

    const all = reports.listReports({ dir });
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map(r => r.questionId), ['2026-2#3', '2026-2#2', '2026-2#1']);

    const page = reports.listReports({ dir, limit: 1, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.items.map(r => r.questionId), ['2026-2#2']);
    assert.equal(reports.countReports(dir), 3);
  });

  test('파일이 없으면 빈 목록이다 (예외 아님)', () => {
    const dir = tmpDir();
    assert.deepEqual(reports.listReports({ dir }), { total: 0, offset: 0, limit: 50, items: [] });
    assert.equal(reports.countReports(dir), 0);
  });

  test('깨진 줄은 건너뛰고 나머지는 읽힌다', () => {
    const dir = tmpDir();
    reports.appendReport(entry(1), dir);
    fs.appendFileSync(path.join(dir, 'reports.jsonl'), '{깨진 줄\n', 'utf8');
    reports.appendReport(entry(2), dir);
    assert.equal(reports.listReports({ dir }).total, 2);
  });

  test('8MB 상한을 넘기려는 append 는 REPORTS_FULL 로 거절된다', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'reports.jsonl');
    // 상한 바로 아래까지 채운다
    fs.writeFileSync(file, 'x'.repeat(reports.MAX_BYTES - 10), 'utf8');
    assert.throws(() => reports.appendReport(entry(1), dir), (e) => e.code === 'REPORTS_FULL');
    // 거절된 요청은 파일을 늘리지 않는다
    assert.equal(fs.statSync(file).size, reports.MAX_BYTES - 10);
  });

  test('예전 reports.json 배열은 한 번만 JSONL 로 옮겨지고 .migrated 로 남는다', () => {
    const dir = tmpDir();
    const legacy = path.join(dir, 'reports.json');
    fs.writeFileSync(legacy, JSON.stringify([
      { at: 't1', questionId: '2020-4#12', myAnswer: ['삽입'], comment: '옛 신고', byUserId: 3 },
      { at: 't2', questionId: '2020-4#13', myAnswer: [], comment: '옛 신고2', byUserId: 3 },
    ]), 'utf8');

    const moved = reports.migrateLegacy(dir, () => {});
    assert.deepEqual(moved, { moved: 2 });
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.existsSync(legacy + '.migrated'), true);

    const list = reports.listReports({ dir });
    assert.equal(list.total, 2);
    assert.equal(list.items[0].comment, '옛 신고2'); // 최신이 앞

    // 두 번째 호출은 할 일이 없다 — 기존 신고가 다시 복제되지 않는다
    assert.equal(reports.migrateLegacy(dir, () => {}), null);
    assert.equal(reports.listReports({ dir }).total, 2);
  });

  test('이관 후에도 새 신고는 같은 파일에 이어 쌓인다', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'reports.json'), JSON.stringify([{ at: 't1', questionId: 'q', comment: '옛것' }]), 'utf8');
    reports.migrateLegacy(dir, () => {});
    reports.appendReport(entry(9), dir);
    const list = reports.listReports({ dir });
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map(r => r.comment), ['c9', '옛것']);
  });
});
