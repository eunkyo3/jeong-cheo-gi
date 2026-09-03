'use strict';
/**
 * boot.js — 기동 배너와 listen.
 *
 * index.js 에서 그대로 옮긴 것이고 출력 문구도 예전과 같다.
 * **배너의 마지막 줄("종료: Ctrl+C …")을 테스트가 기동 신호로 쓴다** — 문구를 바꾸면
 * `tests/*.test.mjs` 의 서버 대기 루프가 멈춘다.
 */

const os = require('node:os');

/**
 * PORT 환경변수 해석 (서버 L-7 · M-16).
 *
 *   - 미지정/빈 문자열 → `3000` (실서버 기본)
 *   - `0` → **임시 포트**. OS 가 비어 있는 포트를 골라 준다. 실제로 잡힌 번호는
 *     기동 시 `LISTEN_PORT=<n>` 한 줄로 stdout 에 찍히므로 테스트가 그 줄만 읽으면 된다
 *     (포트를 난수로 추첨하다 서로 부딪히던 문제를 없앤다).
 *   - `1`~`65535` 의 정수 → 그대로
 *   - 그 밖(`abc`, `-1`, `3000.5`, `99999`) → **던진다.** 예전에는 `Number(x) || 3000` 이라
 *     오타가 조용히 3000(실서버 포트)으로 떨어졌다.
 *
 * @param {string|number|undefined|null} raw
 * @returns {number}
 * @throws {Error} 정수가 아니거나 범위 밖일 때
 */
function parsePort(raw) {
  if (raw == null) return 3000;
  const s = String(raw).trim();
  if (s === '') return 3000;
  if (!/^\d+$/.test(s)) {
    throw new Error('PORT 값이 잘못되었습니다: "' + raw + '" — 0~65535 의 정수여야 합니다 (0 은 임시 포트).');
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n > 65535) {
    throw new Error('PORT 값이 범위를 벗어났습니다: "' + raw + '" — 0~65535 여야 합니다 (0 은 임시 포트).');
  }
  return n;
}

/** 접속 가능한 주소 목록. 100.x 는 Tailscale 로 표기한다. */
function accessUrls(port) {
  const list = [{ label: '로컬', url: 'http://localhost:' + port }];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family !== 'IPv4' && addr.family !== 4) continue;
      if (addr.internal) continue;
      // 169.254.* 는 DHCP 실패 시 붙는 link-local 자동 주소 — 접속 불가라 배너에서 뺀다
      // (scripts/setup-firewall.ps1 도 같은 대역을 건너뛴다).
      if (addr.address.startsWith('169.254.')) continue;
      const label = addr.address.split('.')[0] === '100' ? 'Tailscale' : 'LAN';
      list.push({ label: label, url: 'http://' + addr.address + ':' + port });
    }
  }
  return list;
}

/**
 * 기동 배너. 로거가 아니라 `console.log` 를 쓴다 — 타임스탬프 없는 여러 줄 블록이다.
 * @param {number} port
 * @param {{dbKind:string, roundCount:number, timeOverrideS?:number|null}} info
 */
function printBanner(port, info) {
  const urls = accessUrls(port);
  const width = urls.reduce(function (m, u) { return Math.max(m, u.label.length); }, 0);
  // 기계가 읽는 줄. `PORT=0` 으로 띄웠을 때 OS 가 실제로 잡아 준 번호를 알려 준다 —
  // 테스트·스크립트는 이 한 줄만 정규식으로 뽑으면 되고 배너 문구가 바뀌어도 영향받지 않는다.
  // 사람이 읽는 배너보다 **먼저** 나간다(파싱 쪽이 배너 전체를 기다릴 이유가 없다).
  console.log('LISTEN_PORT=' + port);
  console.log('');
  console.log('  정처기 배틀 서버 기동 (' + info.dbKind + ' 어댑터, 회차 ' + info.roundCount + '개)');
  for (const u of urls) console.log('  ' + u.label.padEnd(width + 2) + u.url);
  // 제한 시간 강제(BATTLE_TIME_OVERRIDE_S)는 스모크 테스트용이다. 켜진 채로 실서버가 뜨면
  // 모든 대전이 몇 초만에 끝나므로 눈에 띄게 알린다(서버 M-13). production 에서는 애초에 무시된다.
  if (info.timeOverrideS != null) {
    console.log('');
    console.log('  [경고] BATTLE_TIME_OVERRIDE_S=' + info.timeOverrideS
      + ' — 모든 대전의 제한 시간이 ' + info.timeOverrideS + '초로 강제됩니다 (테스트 전용).');
  }
  console.log('');
  console.log('  종료: Ctrl+C   /   다른 기기에서 접속하려면 방화벽 인바운드 허용이 필요합니다.');
  console.log('');
}

// -------------------------------------------------------------- 정상 종료

/** shutdown 이 정리를 포기하고 강제 종료하기까지의 시간. */
const SHUTDOWN_GRACE_MS = 5000;

/** 진행 중인 대전이 있으면 그 수만 경고로 남긴다. **끝내려 시도하지 않는다.** */
function warnInFlightBattles(ctx, logErr) {
  const io = ctx.battleIo;
  if (!io || typeof io.listRooms !== 'function') return 0;
  let playing = 0;
  try {
    const list = io.listRooms();
    for (let i = 0; i < list.length; i++) if (list[i].state === 'playing') playing++;
  } catch (e) {
    return 0;
  }
  if (playing > 0) {
    // 대전 상태는 메모리에만 있고 종료(finished)에서만 persist 된다 — 지금 끄면 이 방들의 전적은 없다.
    // 억지로 finish 를 밀어 넣으면 미제출자를 임의 채점하는 셈이라 사실을 왜곡한다. 그래서 경고만 한다.
    logErr('진행 중인 대전 ' + playing + '건이 있습니다 — 전적 없이 종료됩니다.');
  }
  return playing;
}

/** db 를 flush 하고 닫는다. 어댑터마다 없을 수 있는 메서드라 전부 존재 확인 후 호출한다. */
function closeDb(ctx, logErr) {
  const db = ctx.db;
  if (!db) return;
  try {
    if (typeof db.flushSync === 'function') db.flushSync();
  } catch (e) {
    logErr('종료 중 db flush 실패:', e.message);
  }
  try {
    if (typeof db.close === 'function') db.close();
  } catch (e) {
    logErr('종료 중 db close 실패:', e.message);
  }
}

/**
 * 정상 종료. 신호를 받으면 ① 새 연결 차단 → ② 소켓 전부 끊기 → ③ db flush/close → ④ exit.
 *
 * 재진입 방지 플래그는 **ctx 에** 둔다(모듈 전역이 아니라) — 테스트가 매번 새 ctx 로 부를 수 있게.
 * 5초 안에 ②가 끝나지 않으면(소켓이 붙잡고 있거나 콜백이 오지 않으면) 안전망 타이머가 그대로 끝낸다.
 * 그 타이머는 `unref` 라 정상 경로를 붙잡아 두지 않는다.
 *
 * @param {object} ctx server/db/io/logErr/battleIo 를 담은 배선 묶음
 * @param {number} code 종료 코드
 * @param {{exit?:function, graceMs?:number}} [opts] 테스트 주입용
 * @returns {boolean} 이번 호출이 실제로 종료를 시작했으면 true (이미 진행 중이면 false)
 */
function shutdown(ctx, code, opts) {
  const o = opts || {};
  const exit = typeof o.exit === 'function' ? o.exit : function (c) { process.exit(c); };
  const log = typeof ctx.log === 'function' ? ctx.log : function () {};
  const logErr = typeof ctx.logErr === 'function' ? ctx.logErr : log;
  const graceMs = o.graceMs == null ? SHUTDOWN_GRACE_MS : o.graceMs;

  if (ctx.shuttingDown) return false; // 두 번째 Ctrl+C 등 — 첫 호출이 이미 정리 중이다
  ctx.shuttingDown = true;
  log('종료 신호를 받았습니다 — 정리 후 종료합니다.');
  warnInFlightBattles(ctx, logErr);

  let done = false;
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(forced);
    closeDb(ctx, logErr);
    log('종료 완료.');
    exit(code);
  }

  const forced = setTimeout(function () {
    logErr('정리가 ' + graceMs + 'ms 안에 끝나지 않아 강제 종료합니다.');
    finish();
  }, graceMs);
  if (forced.unref) forced.unref();

  // ① 새 연결을 받지 않는다. 콜백은 기다리지 않는다 — socket.io 가 붙잡은 연결이 남아 있으면
  //    영영 오지 않을 수 있고, 실제로 끊는 일은 ②가 한다.
  try {
    if (ctx.server && typeof ctx.server.close === 'function') ctx.server.close(function () {});
  } catch (e) {
    logErr('종료 중 server.close 실패:', e.message);
  }

  // ② 소켓 전부 끊기. io.close 가 http 서버도 같이 닫으므로 그 콜백을 완료 신호로 쓴다.
  //    ①에서 이미 닫혔다는 오류가 콜백으로 올 수 있는데 무시해도 된다(원하던 상태다).
  if (ctx.io && typeof ctx.io.close === 'function') {
    try {
      ctx.io.close(finish);
    } catch (e) {
      logErr('종료 중 io.close 실패:', e.message);
      finish();
    }
  } else {
    finish();
  }
  return true;
}

/**
 * 프로세스 수준 훅. `start()` 가 한 번만 부른다(모듈을 require 만 하는 테스트에는 걸지 않는다).
 *
 * - `SIGINT`/`SIGTERM` → 정상 종료 후 exit 0
 * - `unhandledRejection` → **로그만**. 한 건 때문에 서버를 죽이지 않는다(Node 기본 동작은 죽인다).
 * - `uncaughtException` → 로그 + 정상 종료 시도 후 exit 1. 상태가 이미 미지수라 살려 두지 않는다.
 */
function installProcessHooks(ctx, opts) {
  const log = typeof ctx.log === 'function' ? ctx.log : function () {};
  const logErr = typeof ctx.logErr === 'function' ? ctx.logErr : log;
  // 같은 ctx 로 두 번 걸지 않는다 — 리스너가 쌓이면 MaxListeners 경고가 뜨고 종료가 중복 호출된다.
  if (ctx.hooksInstalled) return false;
  ctx.hooksInstalled = true;

  function onSignal(name) {
    return function () {
      log('신호 수신:', name);
      shutdown(ctx, 0, opts);
    };
  }
  process.on('SIGINT', onSignal('SIGINT'));
  process.on('SIGTERM', onSignal('SIGTERM'));

  process.on('unhandledRejection', function (reason) {
    const msg = reason && reason.stack ? reason.stack : String(reason);
    logErr('처리되지 않은 Promise 거부 (서버는 계속 실행합니다):', msg);
  });

  process.on('uncaughtException', function (err) {
    logErr('처리되지 않은 예외:', err && err.stack ? err.stack : String(err));
    shutdown(ctx, 1, opts);
  });
  return true;
}

/**
 * HTTP 서버를 띄운다. 포트 충돌·기동 오류는 사유를 찍고 즉시 종료한다.
 * @param {{server:object, db:object, rounds:object, logErr:function, PORT:number}} ctx
 * @param {number} [port] 생략하면 ctx.PORT
 * @returns {object} http 서버
 */
function start(ctx, port) {
  const server = ctx.server;
  const logErr = ctx.logErr;
  const p = port || ctx.PORT;
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      logErr('포트 ' + p + ' 이(가) 이미 사용 중입니다. 다른 프로그램을 종료하거나 PORT=' + (p + 1) + ' 로 실행하세요.');
      process.exit(1);
    }
    logErr('서버 오류:', err.message);
    process.exit(1);
  });
  installProcessHooks(ctx);
  server.listen(p, function () {
    // `PORT=0` 이면 여기서야 실제 번호를 알 수 있다 — 배너·LISTEN_PORT 는 **잡힌 포트**를 찍는다.
    let actual = p;
    try {
      const addr = server.address();
      if (addr && typeof addr === 'object' && addr.port) actual = addr.port;
    } catch (e) {
      actual = p;
    }
    ctx.PORT = actual;
    // 제한 시간 강제 여부는 대전 어댑터만 안다(production 게이트가 그쪽에 있다). 없으면 null.
    let override = null;
    try {
      if (ctx.battleIo && typeof ctx.battleIo.timeOverrideS === 'function') override = ctx.battleIo.timeOverrideS();
    } catch (e) {
      override = null;
    }
    printBanner(actual, {
      dbKind: ctx.db.kind,
      roundCount: ctx.rounds.listRounds().length,
      timeOverrideS: override,
    });
  });
  return server;
}

module.exports = {
  parsePort: parsePort,
  accessUrls: accessUrls,
  printBanner: printBanner,
  start: start,
  shutdown: shutdown,
  installProcessHooks: installProcessHooks,
  SHUTDOWN_GRACE_MS: SHUTDOWN_GRACE_MS,
};
