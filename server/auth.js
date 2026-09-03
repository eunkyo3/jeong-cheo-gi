'use strict';
/**
 * auth.js — 닉네임/비밀번호 계정 + HMAC 서명 무상태 세션 쿠키.
 *
 * 세션은 서버에 저장하지 않는다. 쿠키 값 = base64url(payload) + "." + base64url(HMAC-SHA256).
 * payload = {uid, sv, iat} — **이 세 키 말고는 하나도 허용하지 않는다**. 서명 입력에는
 * `jpk_sess.v1:` 접두사가 붙는다(같은 키를 쓰는 세트 토큰·관리자 쿠키와 섞이지 않게).
 * 서명 키는 data/secret.key 에 최초 기동 시 생성·영속한다.
 *
 * `sv` 는 `users.session_version` 사본이다. 서버에서 그 값을 올리면(`db.bumpSessionVersion`)
 * 이미 나간 쿠키가 전부 비로그인 취급된다 — 무상태 세션의 "강제 폐기 불가" 한계를 이걸로 메운다.
 * `sv` 가 없는 예전 쿠키는 0 으로 읽으므로 배포만으로 로그아웃되지 않는다.
 *
 * 비밀번호는 `node:crypto.scrypt` **비동기**로 해싱한다(`scrypt$<salt>$<key>`).
 * 예전 bcrypt 해시(`$2a$…`)는 그대로 검증하고, 로그인에 성공한 순간 scrypt 로 다시 저장한다.
 * 동기 bcrypt 는 한 번에 90ms 넘게 이벤트 루프를 세워 서버 전체를 멈추게 했다(보안 H-2).
 *
 * 평문 HTTP 로 운영하면 Secure 를 붙이지 않는다. HTTPS 앞단이 생기면 `COOKIE_SECURE=1` 로 켠다.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const logger = require('./logger.js');

const DEFAULT_SECRET_FILE = path.join(__dirname, '..', 'data', 'secret.key');
let SECRET_FILE = DEFAULT_SECRET_FILE;
const COOKIE_NAME = 'jpk_sess';
const MAX_AGE_S = 604800; // 7일 (보안 M-5 — 30일에서 줄였다)

// scrypt 파라미터. 바꾸면 기존 해시는 그대로 검증되지만(파라미터를 해시에 싣지 않으므로)
// **여기 값을 바꾸는 순간 옛 해시는 전부 검증 실패한다** — 바꿀 거면 마이그레이션이 필요하다.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_PREFIX = 'scrypt$';
const SCRYPT_OPTS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };

const NICK_MIN = 2;
const NICK_MAX = 12;
const PW_MIN = 8;  // 신규 가입·변경에만 적용된다. 기존 계정의 로그인은 길이를 보지 않는다.
const PW_MAX = 72; // 예전 bcrypt 해시와 호환되도록 상한을 유지한다(72바이트 초과분을 무시했다)

// ------------------------------------------------------------------ 서명 키

let secretKey = null;

/**
 * 서명 키를 읽거나, 없으면 32바이트를 생성해 영속한다.
 * `dataDir` 을 주면 그 아래 `secret.key` 를 쓴다(index.js 가 `DATA_DIR` 로 한 번 호출한다).
 * 주지 않으면 기본값 `<repo>/data/secret.key`. 로그에는 **실제로 쓴 경로**를 찍는다.
 */
/**
 * 키 파일을 읽는다 → 32바이트 Buffer | null(파일 없음) | INVALID_KEY(형식 불량).
 * "없음" 과 "깨짐" 을 구분해야 깨진 키를 조용히 쓰는 일이 없다.
 */
const INVALID_KEY = Symbol('invalid-secret-key');

function readKeyFile() {
  let hex;
  try {
    hex = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : INVALID_KEY;
}

function loadSecret(dataDir) {
  if (dataDir) SECRET_FILE = path.join(dataDir, 'secret.key');
  if (secretKey) return secretKey;

  const existing = readKeyFile();
  if (Buffer.isBuffer(existing)) {
    secretKey = existing;
    return secretKey;
  }

  if (existing === INVALID_KEY) {
    // 깨진 키는 **절대 그대로 쓰지 않는다.** 예전에는 여기서 새로 만들겠다고 로그만 찍고
    // 아래 'wx' 쓰기가 EEXIST 로 튕긴 뒤 그 깨진 파일을 다시 hex 로 읽었다 —
    // `Buffer.from('아무 글자', 'hex')` 는 **길이 0 버퍼**라, 모든 세션 쿠키가
    // 빈 키로 서명돼 누구나 위조할 수 있었다. 옆으로 치우고 확실히 새로 만든다.
    const aside = SECRET_FILE + '.invalid-' + Date.now();
    try {
      fs.renameSync(SECRET_FILE, aside);
    } catch (e) {
      throw new Error('서명 키 파일이 손상됐는데 치울 수도 없습니다: ' + SECRET_FILE + ' — ' + e.message);
    }
    logger.logErr('[auth] 서명 키 형식이 올바르지 않아 새로 생성합니다. 기존 세션은 무효가 됩니다:',
      SECRET_FILE, '(원본 보관:', path.basename(aside) + ')');
  }

  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  try {
    fs.writeFileSync(SECRET_FILE, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    secretKey = fresh;
    logger.log('[auth] 세션 서명 키를 새로 생성했습니다 (공유 금지):', SECRET_FILE);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 동시 기동 경합 — 그 사이 다른 프로세스가 썼다. 먼저 쓴 쪽의 키를 따른다.
    const won = readKeyFile();
    if (!Buffer.isBuffer(won)) {
      // 읽을 수 없는 키로 서버를 띄우느니 기동을 멈춘다(빈 키로 서명하는 것보다 낫다)
      throw new Error('서명 키를 읽을 수 없습니다(동시 기동 경합 중 손상): ' + SECRET_FILE);
    }
    secretKey = won;
  }
  return secretKey;
}

// -------------------------------------------------------------------- 서명

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * 서명 도메인 분리 접두사.
 *
 * 서명 키(`data/secret.key`)는 세션 쿠키·모의고사 세트 토큰·관리자 쿠키가 **모두 함께 쓴다**.
 * 접두사 없이 payload 만 서명하면 셋의 서명이 서로 유효해진다 — 실제로 세트 토큰
 * (`{uid, qs, iat}`)을 세션 쿠키 자리에 넣으면 `uid`·`iat` 가 있다는 이유로 통과했다.
 * HMAC 입력 앞에 용도 문자열을 붙여 그 혼동을 원천 차단한다.
 *
 * **접두사는 쿠키 값에 나타나지 않는다** — 서명 입력에만 들어간다. 쿠키 모양은 예전 그대로
 * `base64url(payload).base64url(sig)` 다.
 */
const SESSION_SIG_PREFIX = 'jpk_sess.v1:';

function signWith(prefix, payloadB64) {
  return b64url(crypto.createHmac('sha256', loadSecret()).update(prefix + payloadB64).digest());
}

function sign(payloadB64) {
  return signWith(SESSION_SIG_PREFIX, payloadB64);
}

/** 길이가 달라도 던지지 않는 상수시간 비교. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 길이 노출을 줄이기 위해 같은 길이로 한 번 더 비교한 뒤 실패시킨다
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** users 행(또는 로그인 결과)의 세션 세대. 컬럼이 없던 시절의 행은 0 으로 본다. */
function sessionVersionOf(row) {
  if (!row) return 0;
  const v = row.sv !== undefined ? row.sv : row.session_version;
  return Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * 세션 쿠키 값 생성.
 * @param {number} userId
 * @param {number} [sessionVersion] users.session_version. 생략하면 0.
 */
function makeToken(userId, sessionVersion) {
  const sv = Number.isInteger(sessionVersion) && sessionVersion >= 0 ? sessionVersion : 0;
  const payload = b64url(JSON.stringify({
    uid: Number(userId),
    sv: sv,
    iat: Math.floor(Date.now() / 1000),
  }));
  return payload + '.' + sign(payload);
}

// ------------------------------------------------------------------- 쿠키

/** HTTPS 앞단을 세웠다면 `COOKIE_SECURE=1` 로 Secure 를 켠다. 매 호출마다 읽으므로 기동 후 변경도 먹는다. */
function cookieSecure() {
  return process.env.COOKIE_SECURE === '1';
}

function cookieAttrs(maxAge) {
  return 'HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (cookieSecure() ? '; Secure' : '');
}

/** user 는 {id, sv} 또는 users 행({id, session_version}) 둘 다 받는다. */
function setSessionCookie(res, user) {
  res.append('Set-Cookie',
    COOKIE_NAME + '=' + makeToken(user.id, sessionVersionOf(user)) + '; ' + cookieAttrs(MAX_AGE_S));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', COOKIE_NAME + '=; ' + cookieAttrs(0));
}

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k || Object.prototype.hasOwnProperty.call(out, k)) continue;
    out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 세션 payload 의 키 집합이 **정확히** `{uid, iat}`(예전) 또는 `{uid, sv, iat}`(현재) 인가.
 *
 * 넉넉하게 받으면 안 되는 자리다. 예전 `readSession` 은 `uid`·`iat` 만 있으면 통과시켜서
 * 남는 키(`qs`·`adm` 등)를 달고 온 **다른 용도의 토큰**을 세션으로 인정했다.
 * 모르는 키가 하나라도 있으면 세션이 아니다.
 */
function isSessionPayloadShape(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.length === 2) return keys[0] === 'iat' && keys[1] === 'uid';
  if (keys.length === 3) return keys[0] === 'iat' && keys[1] === 'sv' && keys[2] === 'uid';
  return false;
}

/**
 * readSession(cookieHeader) → {uid, sv, iat} | null
 * 소켓 계층에서 socket.handshake.headers.cookie 로 그대로 호출한다.
 * `sv` 가 없는 예전 쿠키는 **0 으로 읽는다** — 배포만으로 기존 사용자가 로그아웃되지 않게.
 *
 * 서명은 두 벌을 받는다.
 *   ① `jpk_sess.v1:` 접두사 서명 — `makeToken` 이 지금 발급하는 형식.
 *   ② 접두사 없는 예전 서명 — **payload 모양이 세션의 것과 정확히 같을 때만** 본다.
 * ②는 배포 시점에 이미 브라우저에 나가 있던 쿠키를 위한 것이고, MAX_AGE_S(7일)가 지나면
 * 저절로 사라진다. 그때 ② 갈래와 `signWith('', ...)` 를 지우면 된다.
 */
function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  // 모양부터 본다 — 남의 토큰이면 예전 서명 갈래를 아예 시도하지 않는다
  if (!isSessionPayloadShape(payload)) return null;

  let ok = false;
  try {
    ok = safeEqual(sig, sign(payloadB64)) ||
      safeEqual(sig, signWith('', payloadB64)); // 접두사 도입 이전에 나간 쿠키
  } catch {
    return null;
  }
  if (!ok) return null;

  if (!Number.isInteger(payload.uid) || !Number.isFinite(payload.iat)) return null;
  // sv 키가 있으면 값도 세션 세대여야 한다 (0 으로 눙치지 않는다)
  if (payload.sv !== undefined && !(Number.isInteger(payload.sv) && payload.sv >= 0)) return null;
  if (Math.floor(Date.now() / 1000) - payload.iat > MAX_AGE_S) return null; // 서버측 만료 재확인
  return { uid: payload.uid, sv: sessionVersionOf(payload), iat: payload.iat };
}

// ------------------------------------------------------------- 비밀번호 해시

/** scrypt 해시 문자열 만들기 — `scrypt$<salt b64>$<key b64>`. */
function hashPassword(password) {
  return new Promise(function (resolve, reject) {
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
    crypto.scrypt(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS, function (err, key) {
      if (err) return reject(err);
      resolve(SCRYPT_PREFIX + salt.toString('base64') + '$' + key.toString('base64'));
    });
  });
}

/** 예전 bcrypt 해시인가(`$2a$`/`$2b$`/`$2y$`). 로그인 성공 시 재해시 대상이다. */
function isLegacyHash(stored) {
  return typeof stored === 'string' && /^\$2[aby]?\$/.test(stored);
}

function scryptVerify(password, stored) {
  return new Promise(function (resolve) {
    const parts = String(stored).split('$');
    // ['scrypt', salt, key] — 접두사 뒤 두 조각이 정확히 있어야 한다
    if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) return resolve(false);
    let expected;
    try {
      expected = Buffer.from(parts[2], 'base64');
    } catch {
      return resolve(false);
    }
    if (expected.length !== SCRYPT_KEYLEN) return resolve(false);
    crypto.scrypt(String(password), Buffer.from(parts[1], 'base64'), SCRYPT_KEYLEN, SCRYPT_OPTS,
      function (err, key) {
        if (err) return resolve(false);
        resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
      });
  });
}

function bcryptVerify(password, stored) {
  return new Promise(function (resolve) {
    try {
      bcrypt.compare(String(password), String(stored), function (err, ok) {
        resolve(!err && ok === true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** verifyPassword(평문, 저장된 해시) → Promise<boolean>. scrypt·bcrypt 둘 다 받는다. */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || stored === '') return Promise.resolve(false);
  if (stored.indexOf(SCRYPT_PREFIX) === 0) return scryptVerify(password, stored);
  if (isLegacyHash(stored)) return bcryptVerify(password, stored);
  return Promise.resolve(false);
}

/**
 * 없는 닉네임에도 해시 1회분 시간을 쓰게 해 타이밍으로 계정 존재를 알아내지 못하게 한다.
 * 더미 해시는 첫 호출에 한 번만 만들고(약 60ms) 그 뒤로는 검증 비용만 든다.
 */
let dummyHashPromise = null;
function dummyVerify(password) {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('hex')).catch(function () { return null; });
  }
  return dummyHashPromise.then(function (h) {
    return h ? verifyPassword(password, h) : false;
  }).then(function () { return false; }, function () { return false; });
}

// ---------------------------------------------------------------- 계정 조작

function publicUser(row) {
  return row ? { id: row.id, nickname: row.nickname } : null;
}

/**
 * 닉네임에 쓸 수 없는 문자인가 (코드포인트 기준).
 *
 *   U+0000..U+001F, U+007F  제어문자 — 로그와 화면을 깨뜨린다
 *   U+200B..U+200F          폭 0 문자와 좌우 표시 마크 (ZWSP·ZWNJ·ZWJ·LRM·RLM)
 *   U+202A..U+202E          양방향 재정의 (LRE·RLE·PDF·LRO·RLO)
 *   U+2060..U+206F          단어 결합자·보이지 않는 연산자·폐용 서식 문자
 *   U+FEFF                  BOM (폭 0 비분리 공백)
 *
 * 전부 **화면에 보이지 않거나 표시 순서를 뒤집는** 문자다. 그대로 두면 랭킹·대전에서
 * 남과 눈으로 구별할 수 없는 닉네임을 만들 수 있다(보안 L-11 사칭).
 *
 * 정규식 리터럴 대신 코드포인트 비교로 쓴 이유: 이 문자들을 정규식에 직접 넣으면
 * **소스 파일 안에 보이지 않는 문자가 그대로 박혀** 읽을 수도 grep 할 수도 없게 된다.
 */
function isForbiddenNickCodePoint(cp) {
  if (cp <= 0x1f || cp === 0x7f) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x206f) return true;
  if (cp === 0xfeff) return true;
  return false;
}

/** 닉네임에 금지 문자가 하나라도 섞였는가. 가입 시점에만 검사한다(기존 계정 무영향). */
function hasForbiddenNickChar(s) {
  for (const ch of String(s == null ? '' : s)) {
    if (isForbiddenNickCodePoint(ch.codePointAt(0))) return true;
  }
  return false;
}
function normalizeNickname(nickname) {
  return String(nickname == null ? '' : nickname).normalize('NFC').trim();
}

/** 코드포인트 기준 길이 (이모지·한글 조합 대응) */
function charLength(s) {
  return Array.from(s).length;
}

/**
 * signup(db, nickname, password) → Promise<{ok:true, user} | {ok:false, error}>
 * 실패는 예외가 아니라 한국어 사유 문자열로 돌려준다.
 * user = {id, nickname, sv} — `sv` 는 쿠키에 실을 세션 세대다(응답에는 `publicUser` 로 걸러서 낸다).
 */
async function signup(db, nickname, password) {
  const nick = normalizeNickname(nickname);
  const len = charLength(nick);
  if (len < NICK_MIN || len > NICK_MAX) {
    return { ok: false, error: '닉네임은 ' + NICK_MIN + '~' + NICK_MAX + '자로 입력하세요.' };
  }
  if (hasForbiddenNickChar(nick)) {
    return { ok: false, error: '닉네임에 사용할 수 없는 문자가 있습니다.' };
  }

  const pw = String(password == null ? '' : password);
  if (pw.length < PW_MIN) return { ok: false, error: '비밀번호는 ' + PW_MIN + '자 이상이어야 합니다.' };
  if (Buffer.byteLength(pw, 'utf8') > PW_MAX) {
    return { ok: false, error: '비밀번호가 너무 깁니다. (' + PW_MAX + '바이트 이하)' };
  }

  const hash = await hashPassword(pw);
  try {
    const row = db.createUser(nick, hash);
    return { ok: true, user: { id: row.id, nickname: row.nickname, sv: sessionVersionOf(row) } };
  } catch (e) {
    // sqlite / json 어댑터 모두 UNIQUE 위반을 이 형태로 던진다
    if (String(e.code || '').indexOf('SQLITE_CONSTRAINT') === 0 || /UNIQUE/i.test(e.message || '')) {
      return { ok: false, error: '이미 사용 중인 닉네임입니다.' };
    }
    throw e;
  }
}

/**
 * login(db, nickname, password) → Promise<{id, nickname, sv} | null>
 *
 * 예전 bcrypt 해시로 성공하면 그 자리에서 scrypt 로 다시 저장한다(`db.updatePasswordHash`).
 * 재해시가 실패해도 로그인 자체는 막지 않는다 — 다음 로그인에 또 시도하면 된다.
 */
async function login(db, nickname, password) {
  const nick = normalizeNickname(nickname);
  const pw = String(password == null ? '' : password);
  if (!nick) {
    await dummyVerify(pw);
    return null;
  }
  let row = null;
  try {
    row = db.findUserByNickname(nick);
  } catch {
    row = null;
  }
  if (!row) {
    // 존재하지 않는 닉네임도 해시 1회분 시간을 쓰게 해 타이밍 차이를 줄인다
    await dummyVerify(pw);
    return null;
  }

  let ok = false;
  try {
    ok = await verifyPassword(pw, row.password_hash);
  } catch {
    ok = false;
  }
  if (!ok) return null;

  if (isLegacyHash(row.password_hash) && typeof db.updatePasswordHash === 'function') {
    try {
      db.updatePasswordHash(row.id, await hashPassword(pw));
    } catch (e) {
      logger.logErr('[auth] scrypt 재해시 실패 (로그인은 진행)', '#' + row.id, '-', e.message);
    }
  }
  return { id: row.id, nickname: row.nickname, sv: sessionVersionOf(row) };
}

// ---------------------------------------------------------------- 미들웨어

/**
 * attachUser(db) → express 미들웨어.
 * 유효한 쿠키가 있으면 req.user = {id, nickname} 을 채운다. 없으면 조용히 통과.
 *
 * 쿠키의 `sv` 가 `users.session_version` 과 다르면 **비로그인 취급**한다 —
 * 서버에서 세대를 올리는 것만으로 그 사용자의 모든 기기가 로그아웃된다(보안 M-5).
 */
function attachUser(db) {
  return function (req, res, next) {
    req.user = null;
    const sess = readSession(req.headers && req.headers.cookie);
    if (sess) {
      try {
        const row = db.findUserById(sess.uid);
        if (row && sessionVersionOf(row) === sess.sv) req.user = publicUser(row);
      } catch {
        req.user = null;
      }
    }
    next();
  };
}

/**
 * 쿠키 헤더 → users 행 (소켓 계층용). 세션 세대까지 검사한다.
 * 유효하지 않으면 null.
 */
function userFromCookie(db, cookieHeader) {
  const sess = readSession(cookieHeader);
  if (!sess) return null;
  let row = null;
  try {
    row = db.findUserById(sess.uid);
  } catch {
    return null;
  }
  if (!row || sessionVersionOf(row) !== sess.sv) return null;
  return publicUser(row);
}

/** 로그인 필수 라우트용. attachUser 뒤에 놓는다. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: '로그인이 필요합니다.' });
}

module.exports = {
  COOKIE_NAME: COOKIE_NAME,
  MAX_AGE_S: MAX_AGE_S,
  NICK_MIN: NICK_MIN,
  NICK_MAX: NICK_MAX,
  PW_MIN: PW_MIN,
  PW_MAX: PW_MAX,
  SCRYPT_PREFIX: SCRYPT_PREFIX,
  signup: signup,
  login: login,
  publicUser: publicUser,
  makeToken: makeToken,
  readSession: readSession,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  attachUser: attachUser,
  userFromCookie: userFromCookie,
  requireAuth: requireAuth,
  loadSecret: loadSecret,
  SESSION_SIG_PREFIX: SESSION_SIG_PREFIX,
  isSessionPayloadShape: isSessionPayloadShape,
  hasForbiddenNickChar: hasForbiddenNickChar,
  normalizeNickname: normalizeNickname,
  hashPassword: hashPassword,
  verifyPassword: verifyPassword,
  isLegacyHash: isLegacyHash,
  sessionVersionOf: sessionVersionOf,
};
