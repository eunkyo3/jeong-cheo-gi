'use strict';
/**
 * ratelimit.js — 프로세스 메모리 안에서만 도는 고정 윈도우 레이트 리미터.
 *
 * 외부 저장소(redis 등)를 두지 않는다. 단일 프로세스로 운영하는 앱이고
 * 재기동하면 카운터가 사라져도 되는 성격의 방어이기 때문이다(브루트포스 지연이 목적).
 *
 * 두 가지 얼굴을 제공한다.
 *   rateLimit(opts)    → express 미들웨어. 초과하면 429 + 한국어 사유.
 *   makeLimiter(opts)  → { allow(key) : boolean }. 소켓 계층처럼 req/res 가 없는 곳용.
 *
 * 공통 옵션
 *   windowMs  창 길이(ms). 이 창 안에서 max 회까지 허용한다.
 *   max       창당 허용 횟수.
 *   lockMs    (선택) 창을 넘긴 키를 이만큼 잠근다. 0/미지정이면 창이 끝날 때까지만 막는다.
 *
 * 키 개수는 MAX_KEYS 로 묶는다 — 임의의 IP/닉네임으로 맵을 불려 메모리를 먹는 공격을 막는다.
 * 상한에 닿으면 먼저 만료분을 청소하고, 그래도 모자라면 가장 오래된 항목부터 밀어낸다.
 */

const logger = require('./logger.js');

/** 동시에 추적하는 최대 키 수. 넘으면 만료분 청소 → 오래된 것 축출. */
const MAX_KEYS = 5000;

const TOO_MANY = '시도가 너무 많습니다. 잠시 후 다시 시도하세요.';

/** 창/잠금이 모두 지난 항목인가. */
function isExpired(entry, now) {
  return entry.lockedUntil <= now && entry.resetAt <= now;
}

/**
 * 카운터 저장소. rateLimit / makeLimiter 가 공유한다.
 * @param {{windowMs:number, max:number, lockMs?:number}} opts
 */
function createStore(opts) {
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : 60000;
  const max = Number(opts.max) > 0 ? Number(opts.max) : 10;
  const lockMs = Number(opts.lockMs) > 0 ? Number(opts.lockMs) : 0;
  /** @type {Map<string, {count:number, resetAt:number, lockedUntil:number}>} */
  const hits = new Map();

  /** 만료된 항목을 걷어낸다. 상한에 닿았을 때만 부른다(평소에는 O(1) 경로). */
  function prune(now) {
    for (const pair of hits) {
      if (isExpired(pair[1], now)) hits.delete(pair[0]);
    }
  }

  /** 새 키를 넣기 전에 자리를 만든다. */
  function makeRoom(now) {
    if (hits.size < MAX_KEYS) return;
    prune(now);
    // Map 은 삽입 순서를 유지한다 — 앞쪽이 가장 오래 전에 처음 본 키다
    while (hits.size >= MAX_KEYS) {
      const oldest = hits.keys().next();
      if (oldest.done) break;
      hits.delete(oldest.value);
    }
  }

  /**
   * hit(key) → { ok:true } | { ok:false, retryAfterS:number, locked:boolean }
   * 허용이면 카운터를 올리고, 거부면 올리지 않는다(거부 자체가 카운터를 더 밀지 않도록).
   */
  function hit(key) {
    const k = String(key == null ? '' : key);
    const now = Date.now();
    let e = hits.get(k);

    if (e && isExpired(e, now)) {
      hits.delete(k);
      e = undefined;
    }
    if (!e) {
      makeRoom(now);
      hits.set(k, { count: 1, resetAt: now + windowMs, lockedUntil: 0 });
      return { ok: true };
    }
    if (e.lockedUntil > now) {
      return { ok: false, retryAfterS: Math.ceil((e.lockedUntil - now) / 1000), locked: true };
    }
    if (e.resetAt <= now) {
      // 잠금은 풀렸는데 창만 지난 경우 — 새 창으로 다시 센다
      e.count = 1;
      e.resetAt = now + windowMs;
      return { ok: true };
    }
    if (e.count >= max) {
      if (lockMs > 0) e.lockedUntil = now + lockMs;
      const until = e.lockedUntil > now ? e.lockedUntil : e.resetAt;
      return { ok: false, retryAfterS: Math.ceil((until - now) / 1000), locked: e.lockedUntil > now };
    }
    e.count += 1;
    return { ok: true };
  }

  return {
    hit: hit,
    /** 테스트·운영 점검용. 특정 키만 지우거나(인자 있음) 전부 비운다. */
    reset(key) { if (key === undefined) hits.clear(); else hits.delete(String(key)); },
    size() { return hits.size; },
    windowMs: windowMs,
    max: max,
    lockMs: lockMs,
  };
}

/** 프록시 없이 직접 노출되는 서버라 소켓 주소를 그대로 쓴다(X-Forwarded-For 는 신뢰하지 않는다). */
function remoteIp(req) {
  const sock = req.socket || req.connection;
  return (sock && sock.remoteAddress) || (req.ip ? String(req.ip) : '') || '-';
}

/**
 * rateLimit({windowMs, max, lockMs, keyOf, message, label, logErr}) → express 미들웨어
 *
 * keyOf(req) 가 세는 단위를 정한다. 기본값은 원격 IP.
 * 초과하면 429 + `{error}` 를 돌려주고 `logErr` 로 남긴다(운영에서 공격을 눈으로 보라고).
 * 반환된 미들웨어에는 `reset()` / `size()` 가 붙어 있다 — 테스트에서 창을 비울 때 쓴다.
 */
function rateLimit(options) {
  const opts = options || {};
  const store = createStore(opts);
  const keyOf = typeof opts.keyOf === 'function' ? opts.keyOf : remoteIp;
  const message = typeof opts.message === 'string' && opts.message ? opts.message : TOO_MANY;
  const label = opts.label ? String(opts.label) : 'ratelimit';
  const logErr = typeof opts.logErr === 'function' ? opts.logErr : logger.logErr;

  function middleware(req, res, next) {
    let key;
    try {
      key = keyOf(req);
    } catch (e) {
      key = remoteIp(req);
    }
    const verdict = store.hit(key);
    if (verdict.ok) return next();
    res.set('Retry-After', String(verdict.retryAfterS));
    logErr('rate limit', label, 'key=' + String(key).slice(0, 80),
      verdict.locked ? '잠금' : '초과', verdict.retryAfterS + 's', remoteIp(req));
    res.status(429).json({ error: message });
  }

  middleware.reset = store.reset;
  middleware.size = store.size;
  return middleware;
}

/**
 * makeLimiter({windowMs, max, lockMs}) → { allow(key):boolean, reset(key?), size() }
 *
 * 소켓 이벤트처럼 HTTP 응답을 낼 수 없는 자리에서 쓴다. 거부는 boolean 으로만 알린다.
 */
function makeLimiter(options) {
  const store = createStore(options || {});
  return {
    allow(key) { return store.hit(key).ok === true; },
    reset(key) { store.reset(key); },
    size() { return store.size(); },
  };
}

module.exports = {
  rateLimit: rateLimit,
  makeLimiter: makeLimiter,
  remoteIp: remoteIp,
  MAX_KEYS: MAX_KEYS,
  TOO_MANY: TOO_MANY,
};
