'use strict';
/**
 * routes/auth.js — 인증 REST (`/api/auth/*`).
 *
 * 세션 규약(쿠키 이름·서명·만료)과 해시는 `server/auth.js` 소관이고 여기서는 배선만 한다.
 * `signup`/`login` 은 scrypt 로 바뀌면서 **비동기**다 — 반드시 await 하고, 던진 예외는 next 로 넘긴다.
 *
 * 브루트포스 방어(보안 M-4):
 *   로그인  닉네임+IP 로 분당 10회, 넘으면 5분 잠금.
 *   가입    IP 로 분당 5회.
 *   실패한 로그인은 `logErr` 로 남긴다 — 닉네임은 잘라서, 주소와 함께.
 *
 * @param {object} app express 앱
 * @param {{db:object, auth:object, log:function, logErr:function}} ctx
 */

const { rateLimit, remoteIp } = require('../ratelimit.js');

/** 로그에 남기는 닉네임 길이 상한 — 로그 오염을 막는다. */
const NICK_LOG_MAX = 24;

function nickForLog(v) {
  // 제어문자는 로그 인젝션의 통로다 — 물음표로 바꿔 한 줄을 유지한다
  let out = '';
  for (const ch of String(v == null ? '' : v).slice(0, NICK_LOG_MAX)) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) ? '?' : ch;
  }
  return out;
}

module.exports = function mount(app, ctx) {
  const db = ctx.db;
  const auth = ctx.auth;
  const log = ctx.log;
  const logErr = ctx.logErr;

  // 닉네임까지 키에 넣는다 — 한 주소에서 여러 계정을 훑는 것도, 한 계정을 여러 주소에서 두드리는 것도 센다
  const loginLimiter = rateLimit({
    windowMs: 60000,
    max: 10,
    lockMs: 5 * 60000,
    keyOf: req => nickForLog(req.body && req.body.nickname) + '@' + remoteIp(req),
    label: 'login',
    logErr: logErr,
  });

  const signupLimiter = rateLimit({
    windowMs: 60000,
    max: 5,
    keyOf: remoteIp,
    label: 'signup',
    logErr: logErr,
  });

  app.post('/api/auth/signup', signupLimiter, function (req, res, next) {
    const body = req.body || {};
    auth.signup(db, body.nickname, body.password).then(function (result) {
      if (!result.ok) return res.status(400).json({ error: result.error });
      auth.setSessionCookie(res, result.user);
      log('signup', result.user.nickname, '(#' + result.user.id + ')');
      res.json({ user: auth.publicUser(result.user) });
    }).catch(next);
  });

  app.post('/api/auth/login', loginLimiter, function (req, res, next) {
    const body = req.body || {};
    auth.login(db, body.nickname, body.password).then(function (user) {
      if (!user) {
        logErr('login 실패', nickForLog(body.nickname), remoteIp(req));
        return res.status(401).json({ error: '닉네임 또는 비밀번호가 올바르지 않습니다.' });
      }
      auth.setSessionCookie(res, user);
      log('login', user.nickname, '(#' + user.id + ')');
      res.json({ user: auth.publicUser(user) });
    }).catch(next);
  });

  app.post('/api/auth/logout', function (req, res) {
    auth.clearSessionCookie(res);
    if (req.user) log('logout', req.user.nickname);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', function (req, res) {
    res.json({ user: req.user || null });
  });

  // 테스트·운영 점검에서 창을 비울 수 있게 노출한다(라우트로는 열지 않는다)
  return { loginLimiter: loginLimiter, signupLimiter: signupLimiter };
};
