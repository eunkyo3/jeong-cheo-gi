/**
 * api.js — 서버 REST 호출 래퍼. 전역 `window.api` 하나만 노출한다.
 *
 * 모듈이 아니라 평범한 스크립트다. 모든 페이지가 <script src="/js/api.js"> 로 먼저 읽는다.
 *
 * 규약:
 *   - 세션 쿠키를 위해 항상 same-origin credentials 를 붙인다.
 *   - 요청·응답 모두 JSON.
 *   - 2xx 가 아니면 서버가 준 {error} 문자열을 그대로 `Error.message` 로 던진다.
 *     (PROTOCOL.md 의 에러 규약 — 사용자에게 서버 문구를 그대로 보여 주기 위함)
 *   - `api.me()` 는 최초 1회만 네트워크를 타고 캐시한다. 로그인/가입/로그아웃이 캐시를 무효화한다.
 */
(function (global) {
  'use strict';

  // undefined = 아직 조회 안 함, null = 비로그인, object = 로그인
  var cachedUser;
  var meInflight = null;

  /** 본문이 비었거나 JSON 이 아니어도 죽지 않는다. */
  function readBody(res) {
    return res.text().then(function (text) {
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return { error: text.slice(0, 300) };
      }
    });
  }

  function request(method, path, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    return fetch(path, opts).then(
      function (res) {
        return readBody(res).then(function (data) {
          if (res.ok) return data;
          var msg = data && typeof data.error === 'string' && data.error
            ? data.error
            : '요청이 실패했습니다. (HTTP ' + res.status + ')';
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        });
      },
      function (netErr) {
        // 서버가 꺼져 있거나 네트워크가 끊긴 경우 — 브라우저 기본 문구는 쓸모가 없다
        var err = new Error('서버에 연결할 수 없습니다. 서버가 켜져 있는지 확인하세요.');
        err.status = 0;
        err.cause = netErr;
        throw err;
      }
    );
  }

  function get(path) {
    return request('GET', path);
  }

  function post(path, body) {
    return request('POST', path, body === undefined ? {} : body);
  }

  // ------------------------------------------------------------------ 세션

  function setUser(user) {
    cachedUser = user || null;
    return cachedUser;
  }

  /**
   * me(force) → Promise<{id,nickname}|null>
   * 동시 호출은 한 번의 요청으로 합친다.
   */
  function me(force) {
    if (!force && cachedUser !== undefined) return Promise.resolve(cachedUser);
    if (meInflight) return meInflight;
    meInflight = get('/api/auth/me')
      .then(function (data) {
        meInflight = null;
        return setUser(data && data.user ? data.user : null);
      })
      .catch(function (e) {
        meInflight = null;
        // 세션 조회 실패는 "비로그인" 으로 취급하되 캐시하지는 않는다
        cachedUser = undefined;
        throw e;
      });
    return meInflight;
  }

  function signup(nickname, password) {
    return post('/api/auth/signup', { nickname: nickname, password: password })
      .then(function (data) { return setUser(data.user); });
  }

  function login(nickname, password) {
    return post('/api/auth/login', { nickname: nickname, password: password })
      .then(function (data) { return setUser(data.user); });
  }

  function logout() {
    return post('/api/auth/logout').then(function () { return setUser(null); });
  }

  /** 캐시만 버린다 (다음 me() 가 다시 조회한다). */
  function invalidateMe() {
    cachedUser = undefined;
    meInflight = null;
  }

  global.api = {
    get: get,
    post: post,
    me: me,
    signup: signup,
    login: login,
    logout: logout,
    invalidateMe: invalidateMe,
  };
})(window);
