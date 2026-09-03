'use strict';
/**
 * admin.js — 관리자 로그인·세션.
 *
 * 일반 사용자 계정(users 테이블)과 **완전히 분리된** 단일 관리자 계정이다.
 * 자격증명은 코드에 하드코딩한다(운영자 지시). `ADMIN_PASSWORD` 환경변수가 있으면
 * 그쪽이 우선한다 — 기본값 그대로 뜨면 기동 로그에 경고 한 줄을 남긴다.
 *
 * 세션은 auth.js 와 같은 방식의 무상태 서명 쿠키다.
 *   쿠키 이름 : jpk_admin
 *   값        : base64url({adm:1, iat}) + "." + base64url(HMAC-SHA256)
 *   서명 키   : auth.loadSecret() — data/secret.key 를 그대로 재사용한다.
 *   유효기간  : 12시간 (쿠키 Max-Age + 서버측 iat 재확인)
 *
 * 서명 대상 문자열에 `jpk_admin.v1:` 접두를 붙여 세션 쿠키와 도메인을 분리한다.
 * 같은 키를 쓰더라도 한쪽 토큰을 다른 쪽에 밀어 넣을 수 없다.
 */

const crypto = require('node:crypto');
const auth = require('./auth.js');

// ------------------------------------------------------------------ 자격증명

/** 하드코딩 관리자 아이디. */
const ADMIN_ID = 'admin';
/** 하드코딩 관리자 비밀번호. env ADMIN_PASSWORD 가 있으면 그쪽이 우선한다. */
const ADMIN_PASSWORD = 'qwer1234!';

const COOKIE_NAME = 'jpk_admin';
const MAX_AGE_S = 12 * 60 * 60; // 12시간

/** 실제로 검사에 쓰는 비밀번호. env 가 우선. */
function adminPassword() {
  const env = process.env.ADMIN_PASSWORD;
  return typeof env === 'string' && env !== '' ? env : ADMIN_PASSWORD;
}

/** 코드에 박힌 기본 비밀번호로 돌고 있는가. */
function usingDefaultPassword() {
  return adminPassword() === ADMIN_PASSWORD;
}

/**
 * 기동 배너용 경고 한 줄. 기본 비밀번호일 때만 찍고 true 를 돌려준다.
 * @param {function} logFn 없으면 logger.log
 */
function warnDefaultPassword(logFn) {
  if (!usingDefaultPassword()) return false;
  const out = typeof logFn === 'function' ? logFn : require('./logger.js').log;
  out('[admin] 경고: 관리자 비밀번호가 코드 기본값입니다. 공개망에 노출하지 마세요 (ADMIN_PASSWORD 환경변수로 바꿀 수 있습니다).');
  return true;
}

// -------------------------------------------------------------------- 비교

/**
 * 길이가 달라도 던지지 않는 상수시간 비교.
 * 양쪽을 sha256 으로 32바이트에 맞춘 뒤 timingSafeEqual 한다 — 길이 차이가 새지 않는다.
 */
function constEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * login(id, password) → boolean
 * 아이디·비밀번호 비교를 **둘 다 끝낸 뒤** 결합한다. 단축 평가로 시간차를 만들지 않는다.
 */
function login(id, password) {
  const okId = constEqual(id, ADMIN_ID);
  const okPw = constEqual(password, adminPassword());
  return okId && okPw;
}

// -------------------------------------------------------------------- 서명

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 세션 쿠키와 도메인을 가르는 접두. 키가 같아도 토큰을 서로 옮겨 쓸 수 없다. */
const SIGN_PREFIX = 'jpk_admin.v1:';

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', auth.loadSecret()).update(SIGN_PREFIX + payloadB64).digest());
}

/** 길이가 달라도 던지지 않는 상수시간 문자열 비교(서명 대조용). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // 길이 노출을 줄이기 위해 한 번 더 돌린 뒤 실패시킨다
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** 관리자 쿠키 값 생성. */
function makeAdminToken() {
  const payload = b64url(JSON.stringify({ adm: 1, iat: Math.floor(Date.now() / 1000) }));
  return payload + '.' + sign(payload);
}

/** 토큰 검증 → {adm:1, iat} | null */
function verifyAdminToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;

  const payloadB64 = raw.slice(0, dot);
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return null; // 서명 키를 아직 읽지 못한 상태
  }
  if (!safeEqual(raw.slice(dot + 1), expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.adm !== 1 || !Number.isFinite(payload.iat)) return null;
  if (Math.floor(Date.now() / 1000) - payload.iat > MAX_AGE_S) return null; // 서버측 만료 재확인
  return { adm: 1, iat: payload.iat };
}

// -------------------------------------------------------------------- 쿠키

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

/** COOKIE_SECURE=1 로 띄우면 Secure 를 붙인다(HTTPS 뒤에 둘 때). */
function cookieAttrs(maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return 'HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + secure;
}

function setAdminCookie(res) {
  res.append('Set-Cookie', COOKIE_NAME + '=' + makeAdminToken() + '; ' + cookieAttrs(MAX_AGE_S));
}

function clearAdminCookie(res) {
  res.append('Set-Cookie', COOKIE_NAME + '=; ' + cookieAttrs(0));
}

/** readAdmin(req) → {adm:1, iat} | null */
function readAdmin(req) {
  const header = req && req.headers ? req.headers.cookie : null;
  return verifyAdminToken(parseCookies(header)[COOKIE_NAME]);
}

// ---------------------------------------------------------------- 미들웨어

/** 관리자 전용 라우트 앞에 놓는다. 실패는 401 JSON. */
function requireAdmin(req, res, next) {
  const sess = readAdmin(req);
  if (!sess) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  req.admin = { id: ADMIN_ID, iat: sess.iat };
  next();
}

// ------------------------------------------------------------- 레이트리밋

/** 관리자 로그인 시도 제한 — IP 당 1분에 5회. */
const LOGIN_WINDOW_MS = 60000;
const LOGIN_MAX = 5;

/**
 * makeLoginLimiter(logErr) → express 미들웨어
 * 레인 A 의 ratelimit.js 가 있으면 그것을 쓰고, 없으면 같은 규칙의 최소 구현으로 대신한다.
 */
function makeLoginLimiter(logErr) {
  let rl = null;
  try {
    rl = require('./ratelimit.js');
  } catch {
    rl = null;
  }
  if (rl && typeof rl.rateLimit === 'function') {
    return rl.rateLimit({
      windowMs: LOGIN_WINDOW_MS,
      max: LOGIN_MAX,
      label: 'admin-login',
      message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
      logErr: logErr,
    });
  }

  // --- 폴백: 고정 윈도우 카운터 (ratelimit.js 가 아직 없을 때만)
  const hits = new Map();
  function key(req) {
    const sock = req.socket || req.connection;
    return (sock && sock.remoteAddress) || '-';
  }
  function middleware(req, res, next) {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.resetAt <= now) {
      if (hits.size > 5000) hits.clear();
      hits.set(k, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return next();
    }
    if (e.count >= LOGIN_MAX) {
      res.set('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      if (typeof logErr === 'function') logErr('rate limit admin-login key=' + k);
      return res.status(429).json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' });
    }
    e.count += 1;
    next();
  }
  middleware.reset = function (k) { if (k === undefined) hits.clear(); else hits.delete(String(k)); };
  middleware.size = function () { return hits.size; };
  return middleware;
}

module.exports = {
  ADMIN_ID: ADMIN_ID,
  COOKIE_NAME: COOKIE_NAME,
  MAX_AGE_S: MAX_AGE_S,
  LOGIN_WINDOW_MS: LOGIN_WINDOW_MS,
  LOGIN_MAX: LOGIN_MAX,
  adminPassword: adminPassword,
  usingDefaultPassword: usingDefaultPassword,
  warnDefaultPassword: warnDefaultPassword,
  login: login,
  makeAdminToken: makeAdminToken,
  verifyAdminToken: verifyAdminToken,
  readAdmin: readAdmin,
  setAdminCookie: setAdminCookie,
  clearAdminCookie: clearAdminCookie,
  requireAdmin: requireAdmin,
  makeLoginLimiter: makeLoginLimiter,
};
