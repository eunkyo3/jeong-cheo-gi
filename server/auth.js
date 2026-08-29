'use strict';
/**
 * auth.js — 닉네임/비밀번호 계정 + HMAC 서명 무상태 세션 쿠키.
 *
 * 세션은 서버에 저장하지 않는다. 쿠키 값 = base64url(payload) + "." + base64url(HMAC-SHA256).
 * payload = {uid, iat}. 서명 키는 data/secret.key 에 최초 기동 시 생성·영속한다.
 *
 * 한계(README "계정과 세션"): 발급된 쿠키를 서버에서 강제 만료시킬 수 없다.
 * 로그아웃은 브라우저 쿠키 삭제다. 지인 간 사용을 전제한 수용.
 *
 * HTTP 로 운영하므로 Secure 플래그는 붙이지 않는다.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const DEFAULT_SECRET_FILE = path.join(__dirname, '..', 'data', 'secret.key');
let SECRET_FILE = DEFAULT_SECRET_FILE;
const COOKIE_NAME = 'jpk_sess';
const MAX_AGE_S = 2592000; // 30일
const BCRYPT_COST = 10;

// 존재하지 않는 계정에 대한 타이밍 평준화용 더미 해시 (비밀번호는 알 수 없는 랜덤값)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

const NICK_MIN = 2;
const NICK_MAX = 12;
const PW_MIN = 4;
const PW_MAX = 72; // bcrypt 는 72바이트 초과분을 무시하므로 명시적으로 막는다

// ------------------------------------------------------------------ 서명 키

let secretKey = null;

/** data/secret.key 를 읽거나, 없으면 32바이트를 생성해 영속한다. */
function loadSecret(dataDir) {
  if (dataDir) SECRET_FILE = path.join(dataDir, 'secret.key');
  if (secretKey) return secretKey;
  try {
    const hex = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      secretKey = Buffer.from(hex, 'hex');
      return secretKey;
    }
    console.warn('[auth] data/secret.key 형식이 올바르지 않아 새로 생성합니다. 기존 세션은 무효가 됩니다.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const fresh = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  try {
    fs.writeFileSync(SECRET_FILE, fresh.toString('hex'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    secretKey = fresh;
    console.log('[auth] 세션 서명 키를 새로 생성했습니다: data/secret.key (공유 금지)');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 동시 기동 경합 — 먼저 쓴 쪽의 키를 따른다
    secretKey = Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
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

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', loadSecret()).update(payloadB64).digest());
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

/** 세션 쿠키 값 생성. */
function makeToken(userId) {
  const payload = b64url(JSON.stringify({ uid: Number(userId), iat: Math.floor(Date.now() / 1000) }));
  return payload + '.' + sign(payload);
}

// ------------------------------------------------------------------- 쿠키

function cookieAttrs(maxAge) {
  // Secure 없음 — 평문 HTTP 로 운영한다 (README "보안 범위")
  return 'HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}

function setSessionCookie(res, user) {
  res.append('Set-Cookie', COOKIE_NAME + '=' + makeToken(user.id) + '; ' + cookieAttrs(MAX_AGE_S));
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
 * readSession(cookieHeader) → {uid, iat} | null
 * 소켓 계층에서 socket.handshake.headers.cookie 로 그대로 호출한다.
 */
function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !Number.isInteger(payload.uid) || !Number.isFinite(payload.iat)) return null;
  if (Math.floor(Date.now() / 1000) - payload.iat > MAX_AGE_S) return null; // 서버측 만료 재확인
  return { uid: payload.uid, iat: payload.iat };
}

// ---------------------------------------------------------------- 계정 조작

function publicUser(row) {
  return row ? { id: row.id, nickname: row.nickname } : null;
}

function normalizeNickname(nickname) {
  return String(nickname == null ? '' : nickname).normalize('NFC').trim();
}

/** 코드포인트 기준 길이 (이모지·한글 조합 대응) */
function charLength(s) {
  return Array.from(s).length;
}

/**
 * signup(db, nickname, password) → {ok:true, user} | {ok:false, error}
 * 실패는 예외가 아니라 한국어 사유 문자열로 돌려준다.
 */
function signup(db, nickname, password) {
  const nick = normalizeNickname(nickname);
  const len = charLength(nick);
  if (len < NICK_MIN || len > NICK_MAX) {
    return { ok: false, error: '닉네임은 ' + NICK_MIN + '~' + NICK_MAX + '자로 입력하세요.' };
  }
  if (/[\u0000-\u001f\u007f]/.test(nick)) {
    return { ok: false, error: '닉네임에 사용할 수 없는 문자가 있습니다.' };
  }

  const pw = String(password == null ? '' : password);
  if (pw.length < PW_MIN) return { ok: false, error: '비밀번호는 ' + PW_MIN + '자 이상이어야 합니다.' };
  if (Buffer.byteLength(pw, 'utf8') > PW_MAX) {
    return { ok: false, error: '비밀번호가 너무 깁니다. (' + PW_MAX + '바이트 이하)' };
  }

  const hash = bcrypt.hashSync(pw, BCRYPT_COST);
  try {
    return { ok: true, user: publicUser(db.createUser(nick, hash)) };
  } catch (e) {
    // sqlite / json 어댑터 모두 UNIQUE 위반을 이 형태로 던진다
    if (String(e.code || '').indexOf('SQLITE_CONSTRAINT') === 0 || /UNIQUE/i.test(e.message || '')) {
      return { ok: false, error: '이미 사용 중인 닉네임입니다.' };
    }
    throw e;
  }
}

/** login(db, nickname, password) → {id,nickname} | null */
function login(db, nickname, password) {
  const nick = normalizeNickname(nickname);
  if (!nick) return null;
  const row = db.findUserByNickname(nick);
  if (!row) {
    // 존재하지 않는 닉네임도 해시 1회분 시간을 쓰게 해 타이밍 차이를 줄인다
    try { bcrypt.compareSync(String(password == null ? '' : password), DUMMY_HASH); } catch { /* noop */ }
    return null;
  }
  let ok = false;
  try {
    ok = bcrypt.compareSync(String(password == null ? '' : password), row.password_hash);
  } catch {
    ok = false;
  }
  return ok ? publicUser(row) : null;
}

// ---------------------------------------------------------------- 미들웨어

/**
 * attachUser(db) → express 미들웨어.
 * 유효한 쿠키가 있으면 req.user = {id, nickname} 을 채운다. 없으면 조용히 통과.
 */
function attachUser(db) {
  return function (req, res, next) {
    req.user = null;
    const sess = readSession(req.headers && req.headers.cookie);
    if (sess) {
      try {
        req.user = publicUser(db.findUserById(sess.uid));
      } catch {
        req.user = null;
      }
    }
    next();
  };
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
  signup: signup,
  login: login,
  publicUser: publicUser,
  makeToken: makeToken,
  readSession: readSession,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  attachUser: attachUser,
  requireAuth: requireAuth,
  loadSecret: loadSecret,
};
