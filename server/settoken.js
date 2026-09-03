'use strict';
/**
 * settoken.js — "이 사용자에게 서버가 실제로 내준 문제 집합" 을 증명하는 서명 토큰.
 *
 * 왜 필요한가(보안 C-1 / 서버 M-6):
 *   `/api/practice/grade` 는 회차가 고정돼 있지 않아 예전에는 **클라이언트가 보낸 answers 의 키**로
 *   채점 집합을 복원했다. 그 말은 아무 문항 id 나 적어 보내면 그 문항의 정답 표기(`display`)와
 *   해설(`explanationHtml`)을 받아낼 수 있다는 뜻이다 — 대전 중인 문항까지 포함해서.
 *   그래서 채점 집합은 **서버가 발급한 토큰** 에서만 나온다. 클라이언트의 answers 는
 *   "그 집합의 각 칸에 뭘 적었는가" 만 말할 수 있다.
 *
 * 형식: `base64url(JSON payload)` + "." + `base64url(HMAC-SHA256(payload))`
 *   payload = { uid: <number>, qs: [<문항 id>…], iat: <초 단위 epoch> }
 *
 * 키는 `auth.loadSecret()` 을 그대로 재사용한다(세션 쿠키·관리자 쿠키와 같은 키다 — 비밀은 하나면 된다).
 * **같은 키를 쓰므로 서명 대상 문자열에 용도 접두사 `jpk_set.v1:` 를 붙인다**(`admin.js` 의
 * `jpk_admin.v1:` 와 같은 규칙). 이게 없으면 한 용도의 토큰이 다른 용도로 그대로 통한다 —
 * 실제로 뚫렸다(Phase 3 재검토): 접두사가 없던 시절 `GET /api/practice` 가 준 `setToken` 을
 * `Cookie: jpk_sess=<setToken>` 으로 넣으면 세션 쿠키로 받아들여져 그 사용자로 로그인됐다.
 * payload 모양(`qs` 유무)에 기대는 방어는 **다른 모듈의 규율에 기대는 것**이라 언제든 어긋난다 —
 * 도메인 분리는 서명 자체가 해야 한다.
 *
 * **접두사는 토큰 문자열에 나타나지 않는다** — HMAC 입력에만 들어간다.
 * 토큰 모양은 그대로 `base64url(payload).base64url(sig)` 다.
 *
 * 접두사 도입 이전에 나간 토큰은 **받지 않는다**(수용 갈래를 두면 구멍이 그대로 남는다).
 * 최대 6시간짜리라 영향은 "그 순간 풀던 세트를 다시 불러와야 한다" 가 전부다.
 *
 * 만료 6시간. 모의고사 한 세트를 푸는 시간으로는 넉넉하고, 유출된 토큰의 수명은 짧게 잡았다.
 * 실패는 예외가 아니라 전부 `null` 이다(라우트가 400 으로 바꾼다).
 */

const crypto = require('node:crypto');
const auth = require('./auth.js');

const MAX_AGE_S = 6 * 3600;   // 6시간
const MAX_IDS = 200;          // routes/study.js 의 PRACTICE_GRADE_MAX 와 같은 상한
const MAX_ID_LEN = 64;        // 문항 id 는 "2026-2#13" 꼴이다 — 넉넉히 잡은 위생 상한

/**
 * HMAC 입력 앞에 붙는 용도 문자열. 같은 키를 쓰는 세션 쿠키(`jpk_sess.v1:`)·관리자 쿠키
 * (`jpk_admin.v1:`)와 서명 도메인을 가른다. **바꾸면 발급된 토큰이 전부 무효가 된다.**
 */
const SIGN_PREFIX = 'jpk_set.v1:';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payloadB64) {
  return b64url(crypto.createHmac('sha256', auth.loadSecret()).update(SIGN_PREFIX + payloadB64).digest());
}

/** 길이가 달라도 던지지 않는 상수시간 비교 (auth.js 와 같은 규칙). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // 길이 노출을 줄이려고 같은 길이로 한 번 더 비교한 뒤 실패시킨다
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * signSet(userId, questionIds) → 토큰 문자열
 * 문항 id 는 문자열로 강제하고 중복은 제거한다(집합의 크기 = 채점 분모라 중복이 들어가면 안 된다).
 * 순서는 발급 순서 그대로 — 채점 결과의 문항 순서가 화면 순서와 같아야 한다.
 */
function signSet(userId, questionIds) {
  const seen = new Set();
  const qs = [];
  for (const raw of Array.isArray(questionIds) ? questionIds : []) {
    const id = String(raw == null ? '' : raw);
    if (id === '' || id.length > MAX_ID_LEN || seen.has(id)) continue;
    seen.add(id);
    qs.push(id);
    if (qs.length >= MAX_IDS) break;
  }
  const payload = b64url(JSON.stringify({
    uid: Number(userId),
    qs: qs,
    iat: Math.floor(Date.now() / 1000),
  }));
  return payload + '.' + sign(payload);
}

/**
 * verifySet(token, userId) → 문항 id 배열 | null
 * null 이 되는 경우: 형식 불량 · 서명 불일치 · 다른 사용자 · 6시간 초과 · 빈 집합.
 */
function verifySet(token, userId) {
  if (typeof token !== 'string' || token === '') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return null;
  }
  if (!safeEqual(token.slice(dot + 1), expected)) return null;

  let payload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (!Number.isInteger(payload.uid) || payload.uid !== Number(userId)) return null;
  if (!Number.isFinite(payload.iat)) return null;
  // 시계가 뒤로 갔더라도(iat 이 미래) 만료로만 다룬다 — 음수 경과는 그냥 유효다.
  if (Math.floor(Date.now() / 1000) - payload.iat > MAX_AGE_S) return null;
  if (!Array.isArray(payload.qs) || payload.qs.length === 0) return null;
  if (payload.qs.length > MAX_IDS) return null;
  for (const id of payload.qs) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_LEN) return null;
  }
  return payload.qs.slice();
}

module.exports = {
  MAX_AGE_S: MAX_AGE_S,
  MAX_IDS: MAX_IDS,
  signSet: signSet,
  verifySet: verifySet,
};
