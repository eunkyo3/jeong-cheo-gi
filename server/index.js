'use strict';
/**
 * index.js — HTTP + socket.io 서버 엔트리. **배선만** 한다.
 *
 * 실제 일은 전부 옆 모듈에 있다.
 *   logger.js     log / logErr / logDebug (형식의 단일 출처)
 *   qtypes.js     유형·언어 동결 집합 + 공개 화이트리스트
 *   filters.js    유형·언어 파라미터 해석, 답안 정리
 *   wrongnote.js  학습 이력·오답노트 집계
 *   routes/*.js   `module.exports = function mount(app, ctx)` — auth / study / me / reports
 *   boot.js       기동 배너 + listen
 *   battle-io.js  대전·랭킹 라우트와 소켓 핸들러 (없어도 서버는 학습 모드로 뜬다)
 *
 * **라우트 등록 순서가 계약이다.**
 *   compression → json → attachUser        (파일시스템을 건드리지 않는 미들웨어)
 *   → auth → study(회차·모의고사) → me(이력·오답노트) → reports → 소켓 로깅 → battle-io → admin
 *   → HTML 캐시버스팅 → express.static     (**API 라우트 뒤**)
 *   → 404/에러 핸들러                       (언제나 마지막)
 *
 * 정적 미들웨어가 API 라우트보다 앞에 있으면 `GET /api/*` 마다 없는 파일에 `fs.stat` 을 치고,
 * 그 stat 이 libuv 스레드풀에서 로그인 scrypt 뒤에 줄을 서서 응답이 초 단위로 밀린다
 * (Phase 3 계측: 로그인 40건 동시 → `GET /api/rounds` 최대 1.2초). 순서를 바꾸면 안 된다.
 *
 * battle-io.js 연결 규약:
 *   module.exports = function (ctx) { ... }  또는  module.exports = { attach(ctx) { ... } }
 *   또는 require('./index.js') 로 순환 참조해 스스로 붙는 형태(그 시점에 exports 는 이미 채워져 있다).
 *   attach 가 돌려주는 객체는 `ctx.battleIo` 로 라우트 계층에 노출된다.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');

const logger = require('./logger.js');
const dbModule = require('./db.js');
const rounds = require('./rounds.js');
const auth = require('./auth.js');
const wrongnoteModule = require('./wrongnote.js');
const boot = require('./boot.js');

const log = logger.log;
const logErr = logger.logErr;
const logDebug = logger.logDebug;

// PORT 해석은 boot.js 가 한다(서버 L-7 / M-16). `PORT=0` 은 임시 포트, 잘못된 값은 조용한
// 3000 폴백 대신 기동 실패다 — 오타 하나로 실서버 포트를 빼앗는 일을 막는다.
let PORT;
try {
  PORT = boot.parsePort(process.env.PORT);
} catch (e) {
  logErr(e.message);
  process.exit(1);
}
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// DATA_DIR env 로 데이터 디렉터리를 옮길 수 있다 (E2E 테스트가 격리된 임시 디렉터리를 쓴다). 회차 JSON 은 항상 repo 의 data/rounds 에서 읽는다.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

/** 캐시 버스팅 쿼리 값. 기동 시각 ms — 서버를 다시 띄우면 정적 자산 URL 이 통째로 바뀐다. */
const ASSET_VERSION = Date.now();

// ---------------------------------------------------------------- 부팅 준비

const db = dbModule.open({ dir: DATA_DIR });
auth.loadSecret(DATA_DIR); // 최초 기동 시 {DATA_DIR}/secret.key 생성

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io' });

/** 모든 하위 모듈이 공유하는 배선 묶음. 라우트도 battle-io 도 이 한 객체만 받는다. */
const ctx = {
  app: app,
  server: server,
  io: io,
  db: db,
  rounds: rounds,
  auth: auth,
  log: log,
  logErr: logErr,
  logDebug: logDebug,
  DATA_DIR: DATA_DIR,
  PUBLIC_DIR: PUBLIC_DIR,
  PORT: PORT,
  wrongnote: null, // 아래에서 채운다
  battleIo: null,  // battle-io.attach() 반환값 — 붙지 않았으면 null
};
ctx.wrongnote = wrongnoteModule.create({ db: db, logErr: logErr });

function start(port) {
  return boot.start(ctx, port);
}

// battle-io.js 가 순환 require 로 들어와도 채워진 exports 를 보도록 먼저 공개한다
module.exports = {
  app: app, server: server, io: io, db: db, rounds: rounds, auth: auth,
  log: log, logErr: logErr, logDebug: logDebug, ctx: ctx, start: start,
};

// ---------------------------------------------------------------- 미들웨어

app.disable('x-powered-by');

// ------------------------------------------------------------------ 보안 헤더
//
// **맨 앞이다** — API·정적 자산·404·에러 응답까지 전부 이 헤더를 달고 나간다 (보안 L-8 / N7).
// 예전에 있던 비표준 `Charset` 헤더를 지운 자리를 실제로 효과가 있는 헤더로 채운 셈이다.
//
// CSP 값은 짐작이 아니라 `public/` 실측에 근거해 좁혔다.
//   script-src 'self'          인라인 `<script>`·`on*=` 핸들러·`javascript:` 링크가 **0건**이라
//                              'unsafe-inline' 없이 잠글 수 있다. 이 상태를 tests/static.test.mjs 가 지킨다.
//   style-src  'unsafe-inline' `public/index.html` 에 그 페이지 전용 `<style>` 블록이 하나 있다.
//                              그 블록을 `/css/index.css` 로 빼면 이 예외도 지울 수 있다(프런트 레인 몫).
//   connect-src ws: wss:       socket.io 가 같은 오리진으로 웹소켓을 연다.
//   img-src data:              아이콘·인라인 SVG 여지. 외부 이미지는 어차피 'self' 로 막힌다.
//   frame-ancestors 'none'     X-Frame-Options 의 CSP 판(둘 다 보낸다 — 구형 브라우저 대비).
//   base-uri 'none'            `<base>` 주입으로 상대 경로를 통째로 돌리는 수법을 막는다.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

app.use(function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy', CSP);
  next();
});

app.use(express.json({ limit: '256kb' }));
app.use(auth.attachUser(db));

// -------------------------------------------------------------------- 라우트
//
// **정적 미들웨어(compression·serveHtml·express.static)보다 먼저 붙인다.**
// 이유는 하나다: `/api/*` 응답 경로에서 **libuv 스레드풀 작업을 완전히 없애기** 위해서다.
// 로그인은 scrypt(N=16384) 를 스레드풀에서 돌리고 기본 풀 크기는 4다 — 로그인이 몰리면
// 풀이 1~2초 동안 꽉 찬다. 그동안 스레드풀을 쓰는 다른 일은 전부 그 뒤에 줄을 선다.
//   · `express.static` 이 앞에 있으면 없는 파일에 대한 `fs.stat` 1회
//   · `compression` 이 앞에 있으면 응답 gzip 1회  ← 실측상 이쪽이 지배적이었다
// Phase 3 계측(로그인 40건 동시, `GET /api/rounds` 순차 프로브 30회):
//   static·compression 이 앞  → p95 141ms, 최대 1216ms
//   라우트만 앞으로            → p95 286ms, 최대 1143ms  (거의 그대로)
//   둘 다 라우트 뒤로(현재)    → p95 17~31ms, 최대는 폭주 시작 순간의 첫 프로브뿐
// 남는 `express.json`·`attachUser` 는 스레드풀을 쓰지 않는다(동기 파싱 + HMAC 검증).
//
// 이 순서를 뒤집으면 API JSON 이 다시 gzip 되지만(응답 13KB → 몇 KB) 위 지연이 돌아온다.
// 압축이 실제로 필요했던 160~190KB 페이지 자산은 그대로 압축된다 — 아래 정적 절 참조.

require('./routes/auth.js')(app, ctx);      // /api/auth/*
require('./routes/study.js')(app, ctx);     // /api/rounds*, /api/practice*
require('./routes/me.js')(app, ctx);        // /api/me/*  (summary·explain 이 /wrong 보다 먼저)
require('./routes/reports.js')(app, ctx);   // /api/reports

// -------------------------------------------------------------- 소켓 로깅

io.on('connection', function (socket) {
  const who = socket.data && socket.data.user ? socket.data.user.nickname : '(미인증)';
  log('socket connect', socket.id, who);
  socket.on('disconnect', function (reason) {
    log('socket disconnect', socket.id, who, reason);
  });
});

// ---------------------------------------------------- battle-io 연결(선택)

function attachBattleIo() {
  let mod;
  try {
    mod = require('./battle-io.js');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && /battle-io/.test(e.message)) {
      log('battle-io.js 없음 — 학습 모드만 제공합니다.');
      return null;
    }
    logErr('battle-io.js 로드 실패 — 학습 모드만 제공합니다:', e.message);
    return null;
  }
  try {
    let api = null;
    if (typeof mod === 'function') api = mod(ctx);
    else if (mod && typeof mod.attach === 'function') api = mod.attach(ctx);
    ctx.battleIo = api || null; // 라우트 계층이 대전 상태를 물어볼 수 있는 유일한 창구
    log('battle-io.js 연결 완료');
    return ctx.battleIo;
  } catch (e) {
    logErr('battle-io.js 초기화 실패 — 학습 모드만 제공합니다:', e.message);
    return null;
  }
}

const battleIo = attachBattleIo();
module.exports.battleIo = battleIo;

require('./routes/admin.js')(app, ctx);     // /api/admin/* (관리자 페이지 — 일반 내비에는 링크 없음)

// ------------------------------------------------------------- 정적 자산
//
// API 라우트 **뒤**, 404 핸들러 **앞**이다. 정적 요청만 여기까지 내려온다.
//
// compression 도 여기서야 붙는다. gzip 은 libuv 스레드풀 작업이라, API 응답까지 압축하면
// 로그인 scrypt 가 스레드풀을 채운 동안 `GET /api/rounds` 가 그 뒤에 줄을 선다
// (Phase 3 계측: 압축을 앞에 두면 최대 1.1초, 여기로 내리면 20ms 아래). 압축이 실제로
// 필요했던 것은 160~190KB 페이지 자산이고(프런트 3-1), 그건 전부 이 아래에서 나간다.
//
// HTML 은 **항상 no-cache**(재검증)로, 그 밖의 자산은 **1년 불변**으로 준다.
// 그 둘이 모순되지 않는 이유는 캐시 버스팅이다: HTML 안의 `/js/*.js`·`/css/*.css` 참조에
// `?v=<기동 시각 ms>` 를 붙여 내보내므로, 서버를 다시 띄우면 URL 이 바뀌어 브라우저가
// 새로 받아 간다. HTML 파일 자체는 손대지 않는다(치환은 전송 직전에만 일어난다).

app.use(compression()); // 무압축 160~190KB 페이지가 그대로 나가던 것을 gzip 으로 (프런트 3-1)

/**
 * 캐시 키. Windows 는 파일시스템이 대소문자를 가리지 않으므로 `/Study.html` 과 `/study.html` 이
 * 같은 파일이다 — 키를 소문자로 접어 한 파일이 한 칸만 쓰게 한다.
 */
function htmlKey(fullPath) {
  return process.platform === 'win32' ? fullPath.toLowerCase() : fullPath;
}

/**
 * 부팅 시 PUBLIC_DIR 아래 실재하는 `.html` 파일 목록(정규화 키).
 * **캐시의 화이트리스트이자 상한이다** (보안 N3): 이 집합에 없는 이름은 읽지도, 캐시에 넣지도 않는다.
 * 없는 이름 50만 개를 두드려도 `htmlCache` 는 여기 든 파일 수를 넘지 못한다.
 *
 * 기동 후에 추가된 HTML 은 이 핸들러를 타지 못하고 `express.static` 이 원본 그대로 내보낸다
 * (`?v=` 가 안 붙는다). 배포하면 서버를 다시 띄우므로 실사용에서는 문제가 되지 않는다 —
 * `ASSET_VERSION` 도 어차피 기동 시각이다.
 */
function listHtmlFiles(dir) {
  const out = new Set();
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (e) {
      logErr('정적 디렉터리를 읽을 수 없습니다', cur, '-', e.message);
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && /\.html$/i.test(ent.name)) out.add(htmlKey(full));
    }
  }
  return out;
}

/** @type {Set<string>} 실재하는 HTML 파일(정규화 키) — 캐시 상한 */
const HTML_FILES = listHtmlFiles(PUBLIC_DIR);

/** @type {Map<string, string|null>} 정규화 키 → 치환이 끝난 HTML (기동당 파일 1회 읽기) */
const htmlCache = new Map();

/** 테스트·점검용. 캐시가 실재 파일 수를 넘지 않는지 확인한다(보안 N3 회귀 방지). */
function htmlCacheStats() {
  return { cached: htmlCache.size, files: HTML_FILES.size };
}
module.exports.htmlCacheStats = htmlCacheStats; // tests/static.test.mjs 가 이 값을 본다

/** `src="/js/x.js"` · `href="/css/x.css"` → `…?v=<기동 ms>`. 이미 쿼리가 붙은 것은 건드리지 않는다. */
function withAssetVersion(html) {
  return html.replace(
    /(\s(?:src|href)=")(\/(?:js|css)\/[^"?#]+\.(?:js|css))"/gi,
    function (_m, head, url) { return head + url + '?v=' + ASSET_VERSION + '"'; }
  );
}

/** 치환이 끝난 HTML 문자열. 읽을 수 없으면 null(= 이 미들웨어가 처리하지 않는다). */
function htmlBody(fullPath, key) {
  if (htmlCache.has(key)) return htmlCache.get(key);
  let body = null;
  try {
    body = withAssetVersion(fs.readFileSync(fullPath, 'utf8'));
  } catch (e) {
    // 부팅 목록에 있던 파일이 사라졌거나 읽을 수 없다 — 정적 미들웨어에 넘긴다
    logErr('HTML 읽기 실패', fullPath, '-', e.message);
  }
  // 키는 HTML_FILES 안에 있는 것만 들어온다 → 캐시 크기는 실재 파일 수를 넘지 못한다 (보안 N3)
  htmlCache.set(key, body);
  return body;
}

app.use(function serveHtml(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const raw = req.path === '/' ? '/index.html' : req.path;
  if (!/\.html$/i.test(raw)) return next();

  let rel;
  try {
    rel = decodeURIComponent(raw);
  } catch (e) {
    return next(); // 깨진 퍼센트 인코딩 — 정적 미들웨어에 맡긴다
  }
  if (rel.indexOf('\0') !== -1) return next();

  // public/ 밖으로 나가는 경로는 여기서 끝낸다 (`..` 순회 차단)
  const full = path.join(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) return next();

  // **실재하는 파일만** 통과시킨다 (보안 N3). 없는 이름은 읽지도 캐시에 넣지도 않으므로
  // 임의의 `.html` 이름을 무한히 두드려 메모리를 불릴 수 없다.
  const key = htmlKey(full);
  if (!HTML_FILES.has(key)) return next(); // 404 핸들러 몫이다

  const body = htmlBody(full, key);
  if (body == null) return next(); // 부팅 뒤 사라진 파일 — 정적/404 에 맡긴다

  res.set('Cache-Control', 'no-cache'); // 매번 재검증 — 배포 직후 옛 화면이 남지 않게
  res.type('text/html; charset=utf-8');
  res.send(body);
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: '1y',   // `?v=` 로 URL 이 바뀌므로 안전하다
  etag: true,
  setHeaders: function (res, filePath) {
    // 한국어 데이터 — 텍스트 응답은 항상 utf-8 로 못박는다
    if (/\.html$/i.test(filePath)) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-cache'); // 위 핸들러를 못 거친 HTML 도 캐시되지 않게
    } else if (/\.css$/i.test(filePath)) res.set('Content-Type', 'text/css; charset=utf-8');
    else if (/\.js$/i.test(filePath)) res.set('Content-Type', 'text/javascript; charset=utf-8');
  },
}));

// ------------------------------------------------- 마무리 핸들러 (항상 마지막)

app.use('/api', function (req, res) {
  res.status(404).json({ error: '없는 API 경로입니다: ' + req.method + ' ' + req.originalUrl });
});

app.use(function (req, res) {
  res.status(404).type('text/plain; charset=utf-8').send('404 — 페이지를 찾을 수 없습니다.');
});

// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
  logErr('요청 처리 오류', req.method, req.originalUrl, '-', err.message);
  if (res.headersSent) return;
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status === 400 ? '요청 형식이 올바르지 않습니다.'
    : status === 413 ? '요청 본문이 너무 큽니다. (256KB 이하)'
      : '서버 오류가 발생했습니다.';
  res.status(status).json({ error: message });
});

// -------------------------------------------------------------------- 기동

if (require.main === module) start();
