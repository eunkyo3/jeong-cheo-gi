// boot.test.mjs — 기동/종료 배선(server/boot.js) 단위 검증.
//
// 대부분은 프로세스를 죽이지 않는 단위 테스트다: `shutdown(ctx, code, {exit})` 로 종료 함수를 주입해
// **정리 순서**(새 연결 차단 → 소켓 끊기 → db flush/close → exit)와 안전망 타이머를 본다.
// 마지막 한 건만 진짜 `server/index.js` 를 자식 프로세스로 띄워 전체 배선을 확인한다.
//
// **Windows 주의**: `process.kill(pid,'SIGTERM')` 은 신호로 전달되지 않고 프로세스를 즉시 죽인다
// (TerminateProcess). 그래서 통합 테스트는 자식 **안에서** `process.emit('SIGTERM')` 을 쏜다 —
// 걸린 리스너는 같으므로 검증 대상(훅이 있는가, 정리가 도는가, exit 0 인가)은 그대로다.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { startServer } from './lib/server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const boot = require('../server/boot.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ 픽스처

/**
 * shutdown 이 만지는 표면만 갖춘 가짜 ctx.
 * @param {{ioCloseCallsBack?:boolean, db?:object|null, battleIo?:object|null}} [opts]
 */
function fakeCtx(opts) {
  const o = opts || {};
  const calls = [];
  const logs = [];
  const errs = [];
  const ctx = {
    server: { close: function (cb) { calls.push('server.close'); if (cb) cb(); } },
    io: {
      close: function (cb) {
        calls.push('io.close');
        // 소켓이 붙잡고 있어 콜백이 오지 않는 상황을 흉내 낼 수 있다
        if (o.ioCloseCallsBack === false) return;
        cb();
      },
    },
    db: o.db === undefined ? {
      flushSync: function () { calls.push('db.flushSync'); },
      close: function () { calls.push('db.close'); },
    } : o.db,
    battleIo: o.battleIo === undefined ? null : o.battleIo,
    log: function () { logs.push(Array.prototype.slice.call(arguments).join(' ')); },
    logErr: function () { errs.push(Array.prototype.slice.call(arguments).join(' ')); },
  };
  return { ctx: ctx, calls: calls, logs: logs, errs: errs };
}

/** exit 호출을 모으는 스텁. */
function exitSpy() {
  const codes = [];
  const fn = function (c) { codes.push(c); };
  fn.codes = codes;
  return fn;
}

// ------------------------------------------------------------------- 종료

describe('shutdown (서버 H-5)', () => {
  test('새 연결 차단 → 소켓 끊기 → db flush/close → exit 0 순서로 진행한다', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    const started = boot.shutdown(f.ctx, 0, { exit: exit });
    assert.equal(started, true);
    assert.deepEqual(f.calls, ['server.close', 'io.close', 'db.flushSync', 'db.close']);
    assert.deepEqual(exit.codes, [0]);
  });

  test('두 번째 호출은 아무것도 하지 않는다 (Ctrl+C 연타)', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    boot.shutdown(f.ctx, 0, { exit: exit });
    const again = boot.shutdown(f.ctx, 0, { exit: exit });
    assert.equal(again, false);
    assert.deepEqual(exit.codes, [0], 'exit 이 두 번 불리면 안 된다');
    assert.equal(f.calls.filter((c) => c === 'db.close').length, 1);
  });

  test('종료 코드는 그대로 전달된다', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    boot.shutdown(f.ctx, 1, { exit: exit });
    assert.deepEqual(exit.codes, [1]);
  });

  test('io.close 콜백이 오지 않으면 유예 시간 뒤 강제로 끝낸다', async () => {
    const f = fakeCtx({ ioCloseCallsBack: false });
    const exit = exitSpy();
    boot.shutdown(f.ctx, 0, { exit: exit, graceMs: 30 });
    assert.deepEqual(exit.codes, [], '아직은 기다리는 중이어야 한다');

    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(exit.codes, [0]);
    assert.deepEqual(f.calls, ['server.close', 'io.close', 'db.flushSync', 'db.close']);
    assert.ok(f.errs.some((e) => e.includes('강제 종료')), '강제 종료 사유를 남겨야 한다');
  });

  test('db 가 없거나 flushSync/close 를 갖추지 않아도 종료한다', () => {
    const noDb = fakeCtx({ db: null });
    const exit1 = exitSpy();
    boot.shutdown(noDb.ctx, 0, { exit: exit1 });
    assert.deepEqual(exit1.codes, [0]);

    const partial = fakeCtx({ db: { close: function () { partial.calls.push('db.close'); } } });
    const exit2 = exitSpy();
    boot.shutdown(partial.ctx, 0, { exit: exit2 });
    assert.deepEqual(exit2.codes, [0]);
    assert.ok(partial.calls.includes('db.close'));
  });

  test('db.flushSync 가 던져도 close 와 exit 은 계속된다', () => {
    const f = fakeCtx({
      db: {
        flushSync: function () { throw new Error('디스크 가득'); },
        close: function () { f.calls.push('db.close'); },
      },
    });
    const exit = exitSpy();
    boot.shutdown(f.ctx, 0, { exit: exit });
    assert.ok(f.errs.some((e) => e.includes('디스크 가득')));
    assert.ok(f.calls.includes('db.close'));
    assert.deepEqual(exit.codes, [0]);
  });

  test('진행 중인 대전이 있으면 개수를 경고로 남기고 끝내려 하지 않는다', () => {
    const battleIo = {
      listRooms: function () {
        return [
          { id: 'A', state: 'playing' },
          { id: 'B', state: 'waiting' },
          { id: 'C', state: 'playing' },
        ];
      },
    };
    const f = fakeCtx({ battleIo: battleIo });
    const exit = exitSpy();
    boot.shutdown(f.ctx, 0, { exit: exit });
    const warn = f.errs.find((e) => e.includes('진행 중인 대전'));
    assert.ok(warn, '경고가 없다');
    assert.match(warn, /2건/);
    // 대전을 끝내려는 시도(persist/finish)는 없다 — 경고만이 계약이다
    assert.deepEqual(f.calls, ['server.close', 'io.close', 'db.flushSync', 'db.close']);
  });

  test('진행 중인 대전이 없으면 경고하지 않는다', () => {
    const f = fakeCtx({ battleIo: { listRooms: function () { return [{ id: 'A', state: 'waiting' }]; } } });
    boot.shutdown(f.ctx, 0, { exit: exitSpy() });
    assert.equal(f.errs.filter((e) => e.includes('진행 중인 대전')).length, 0);
  });

  test('battleIo 가 없거나 listRooms 가 던져도 종료를 막지 않는다', () => {
    const broken = fakeCtx({ battleIo: { listRooms: function () { throw new Error('망가짐'); } } });
    const exit = exitSpy();
    boot.shutdown(broken.ctx, 0, { exit: exit });
    assert.deepEqual(exit.codes, [0]);
  });
});

// ------------------------------------------------------------- 프로세스 훅

describe('installProcessHooks (서버 H-5)', () => {
  /** 훅을 걸고, 이번에 새로 붙은 리스너만 골라 돌려준다. 테스트 뒤에는 반드시 떼야 한다. */
  function withHooks(ctx, fn) {
    const names = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException'];
    const before = new Map(names.map((n) => [n, process.listeners(n).slice()]));
    boot.installProcessHooks(ctx, { exit: ctx.__exit });
    const added = new Map();
    for (const n of names) {
      const prev = before.get(n);
      added.set(n, process.listeners(n).filter((l) => prev.indexOf(l) === -1));
    }
    try {
      fn(added);
    } finally {
      for (const n of names) for (const l of added.get(n)) process.removeListener(n, l);
    }
  }

  test('SIGINT·SIGTERM·unhandledRejection·uncaughtException 을 각각 하나씩 건다', () => {
    const f = fakeCtx();
    f.ctx.__exit = exitSpy();
    withHooks(f.ctx, (added) => {
      assert.equal(added.get('SIGINT').length, 1);
      assert.equal(added.get('SIGTERM').length, 1);
      assert.equal(added.get('unhandledRejection').length, 1);
      assert.equal(added.get('uncaughtException').length, 1);
    });
  });

  test('SIGTERM 은 정상 종료 후 exit 0', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    f.ctx.__exit = exit;
    withHooks(f.ctx, (added) => {
      added.get('SIGTERM')[0]();
      assert.deepEqual(exit.codes, [0]);
      assert.deepEqual(f.calls, ['server.close', 'io.close', 'db.flushSync', 'db.close']);
      assert.ok(f.logs.some((l) => l.includes('SIGTERM')));
    });
  });

  test('SIGINT 도 같은 경로를 탄다', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    f.ctx.__exit = exit;
    withHooks(f.ctx, (added) => {
      added.get('SIGINT')[0]();
      assert.deepEqual(exit.codes, [0]);
    });
  });

  test('unhandledRejection 은 로그만 남기고 프로세스를 죽이지 않는다', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    f.ctx.__exit = exit;
    withHooks(f.ctx, (added) => {
      added.get('unhandledRejection')[0](new Error('어딘가의 await 누락'));
      assert.deepEqual(exit.codes, [], 'unhandledRejection 으로 종료하면 안 된다');
      assert.ok(f.errs.some((e) => e.includes('어딘가의 await 누락')));
      assert.deepEqual(f.calls, [], '정리 절차가 돌면 안 된다');
    });
  });

  test('uncaughtException 은 로그를 남기고 exit 1 로 종료한다', () => {
    const f = fakeCtx();
    const exit = exitSpy();
    f.ctx.__exit = exit;
    withHooks(f.ctx, (added) => {
      added.get('uncaughtException')[0](new Error('예상 못 한 오류'));
      assert.ok(f.errs.some((e) => e.includes('예상 못 한 오류')));
      assert.deepEqual(exit.codes, [1]);
    });
  });
});

// --------------------------------------------------------------- 기동 배너

describe('printBanner', () => {
  function capture(fn) {
    const lines = [];
    const orig = console.log;
    console.log = function () { lines.push(Array.prototype.slice.call(arguments).join(' ')); };
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  test('마지막 줄은 언제나 "종료: Ctrl+C …" 다 (테스트의 기동 신호)', () => {
    const plain = capture(() => boot.printBanner(3999, { dbKind: 'json', roundCount: 3 }));
    const withWarn = capture(() => boot.printBanner(3999, { dbKind: 'json', roundCount: 3, timeOverrideS: 5 }));
    for (const lines of [plain, withWarn]) {
      const meaningful = lines.filter((l) => l.trim() !== '');
      assert.match(meaningful[meaningful.length - 1], /종료: Ctrl\+C/);
    }
  });

  test('BATTLE_TIME_OVERRIDE_S 가 켜져 있으면 경고 줄이 붙는다 (서버 M-13)', () => {
    const lines = capture(() => boot.printBanner(3999, { dbKind: 'json', roundCount: 3, timeOverrideS: 7 }));
    const warn = lines.find((l) => l.includes('[경고]'));
    assert.ok(warn, '경고 줄이 없다');
    assert.match(warn, /BATTLE_TIME_OVERRIDE_S=7/);
    assert.match(warn, /7초/);
  });

  test('꺼져 있으면 경고 줄이 없다', () => {
    const lines = capture(() => boot.printBanner(3999, { dbKind: 'sqlite', roundCount: 3 }));
    assert.equal(lines.filter((l) => l.includes('[경고]')).length, 0);
    assert.ok(lines.some((l) => l.includes('sqlite 어댑터')));
  });
});

// ------------------------------------------------- 실제 기동 → 종료 통합

describe('index.js 기동 → SIGTERM → 정상 종료 (통합)', () => {
  test('신호를 받으면 미룬 쓰기를 흘리고 exit 0 으로 끝난다', async () => {
    // **Windows 주의**: `process.kill(pid,'SIGTERM')` 은 여기서 신호로 전달되지 않고
    // 프로세스를 즉시 죽인다(TerminateProcess). 그래서 자식 안에서 `process.emit('SIGTERM')`
    // 으로 같은 리스너를 태운다 — 검증 대상(훅이 걸려 있는가, 정리가 도는가)은 동일하다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-boot-'));
    // PORT=0 → OS 가 비어 있는 포트를 고른다. 예전의 4100~4399 추첨은 다른 테스트와 부딪힐 수 있었다
    // (서버 M-16). 실서버 3000 은 어느 쪽으로도 잡히지 않는다.
    const program = [
      'const index = require(' + JSON.stringify(path.join(ROOT, 'server', 'index.js')) + ');',
      'index.start(0);',
      'setTimeout(function () {',
      '  index.db.createUser("종료검증", "x".repeat(20));',
      '  process.emit("SIGTERM");',
      '}, 600);',
    ].join('\n');

    const child = spawn(process.execPath, ['-e', program], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: '0',
        DATA_DIR: dir,
        DB_ADAPTER: 'json', // 미룬 쓰기가 실제로 흘러갔는지 파일로 확인하려고 JSON 어댑터를 쓴다
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('종료되지 않았다:\n' + out)); }, 20000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    assert.equal(code, 0, '정상 종료가 아니다:\n' + out);
    assert.match(out, /종료 완료/);
    // 종료 직전의 쓰기가 디스크에 남아 있어야 한다 — flushSync 가 돌았다는 증거다
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.equal((saved.users || []).length, 1);
    assert.equal(saved.users[0].nickname, '종료검증');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('installProcessHooks 멱등성', () => {
  test('같은 ctx 로 두 번 걸어도 리스너는 한 벌만 남는다', () => {
    const f = fakeCtx();
    const names = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException'];
    const before = new Map(names.map((n) => [n, process.listeners(n).slice()]));
    try {
      assert.equal(boot.installProcessHooks(f.ctx, { exit: exitSpy() }), true);
      assert.equal(boot.installProcessHooks(f.ctx, { exit: exitSpy() }), false);
      for (const n of names) {
        const added = process.listeners(n).filter((l) => before.get(n).indexOf(l) === -1);
        assert.equal(added.length, 1, n + ' 리스너가 ' + added.length + '개다');
      }
    } finally {
      for (const n of names) {
        for (const l of process.listeners(n).filter((x) => before.get(n).indexOf(x) === -1)) {
          process.removeListener(n, l);
        }
      }
    }
  });
});

// ------------------------------------------------------- PORT 해석 (서버 L-7 · M-16)
//
// 예전에는 `Number(process.env.PORT) || 3000` 하나뿐이라 `PORT=abc` 도 `PORT=0` 도 똑같이
// **실서버 포트 3000** 으로 떨어졌다. 오타 하나가 실서버를 밀어낼 수 있었고, 반대로
// "OS 가 골라 주는 임시 포트" 를 부탁할 방법이 없어 테스트마다 난수를 뽑아야 했다.

describe('parsePort', () => {
  test('미지정·빈 문자열·공백은 실서버 기본값 3000', () => {
    assert.equal(boot.parsePort(undefined), 3000);
    assert.equal(boot.parsePort(null), 3000);
    assert.equal(boot.parsePort(''), 3000);
    assert.equal(boot.parsePort('   '), 3000);
  });

  test('정수 문자열·숫자는 그대로 (앞뒤 공백 허용)', () => {
    assert.equal(boot.parsePort('3999'), 3999);
    assert.equal(boot.parsePort(' 4711 '), 4711);
    assert.equal(boot.parsePort(8080), 8080);
    assert.equal(boot.parsePort('65535'), 65535);
    assert.equal(boot.parsePort('1'), 1);
  });

  test('0 은 "임시 포트" 라는 뜻이므로 3000 으로 떨어지지 않는다', () => {
    assert.equal(boot.parsePort('0'), 0);
    assert.equal(boot.parsePort(0), 0);
  });

  test('정수가 아니면 던진다 — 조용한 3000 폴백 없음', () => {
    for (const bad of ['abc', '3000.5', '-1', '3e3', '0x10', '80 80', 'PORT']) {
      assert.throws(() => boot.parsePort(bad), /PORT 값이/, JSON.stringify(bad));
    }
  });

  test('65535 를 넘으면 던진다', () => {
    assert.throws(() => boot.parsePort('65536'), /범위를 벗어났습니다/);
    assert.throws(() => boot.parsePort('99999'), /범위를 벗어났습니다/);
  });
});

describe('LISTEN_PORT 줄', () => {
  function capture(fn) {
    const lines = [];
    const orig = console.log;
    console.log = function () { lines.push(Array.prototype.slice.call(arguments).join(' ')); };
    try { fn(); } finally { console.log = orig; }
    return lines;
  }

  test('배너에 기계가 읽을 LISTEN_PORT=<n> 이 정확히 한 줄 있다', () => {
    const lines = capture(() => boot.printBanner(4711, { dbKind: 'json', roundCount: 3 }));
    const hits = lines.filter((l) => /^LISTEN_PORT=\d+$/.test(l));
    assert.equal(hits.length, 1, lines.join('\n'));
    assert.equal(hits[0], 'LISTEN_PORT=4711');
  });

  test('사람이 읽는 배너보다 먼저 나간다 (파싱 쪽이 배너를 기다릴 필요가 없다)', () => {
    const lines = capture(() => boot.printBanner(4711, { dbKind: 'json', roundCount: 3 }));
    const portAt = lines.findIndex((l) => l.startsWith('LISTEN_PORT='));
    const bannerAt = lines.findIndex((l) => l.includes('정처기 배틀 서버 기동'));
    assert.ok(portAt >= 0 && bannerAt >= 0);
    assert.ok(portAt < bannerAt, 'LISTEN_PORT 가 배너 뒤에 있다: ' + lines.join(' / '));
  });

  test('기동 신호("종료: Ctrl+C")는 여전히 마지막 줄이다', () => {
    const lines = capture(() => boot.printBanner(4711, { dbKind: 'json', roundCount: 3 }));
    const meaningful = lines.filter((l) => l.trim() !== '');
    assert.match(meaningful[meaningful.length - 1], /종료: Ctrl\+C/);
  });
});

describe('PORT=0 실기동 (통합)', () => {
  test('임시 포트를 잡고 LISTEN_PORT 로 알려 준다 — 그 포트로 실제 응답한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-port0-'));
    const srv = await startServer({ dataDir: dir });
    try {
      assert.ok(Number.isInteger(srv.port) && srv.port > 0, '포트 ' + srv.port);
      assert.notEqual(srv.port, 3000, '실서버 포트를 잡으면 안 된다');
      // 배너의 주소 줄도 같은 포트를 쓴다 — 사람이 보는 값과 기계가 읽는 값이 어긋나지 않는다
      assert.match(srv.log(), new RegExp('http://localhost:' + srv.port));
      const r = await fetch(srv.base + '/api/rounds');
      assert.equal(r.status, 200);
    } finally {
      await srv.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('PORT 가 정수가 아니면 3000 으로 떨어지지 않고 사유를 찍고 죽는다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-badport-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: 'abc', DATA_DIR: dir }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    const code = await new Promise((res, rej) => {
      const t = setTimeout(() => { child.kill(); rej(new Error('종료되지 않았다:\n' + out)); }, 20000);
      child.on('exit', (c) => { clearTimeout(t); res(c); });
      child.on('error', (e) => { clearTimeout(t); rej(e); });
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(code, 1, out);
    assert.match(out, /PORT 값이 잘못되었습니다/);
    assert.equal(/LISTEN_PORT=/.test(out), false, '기동해 버렸다:\n' + out);
  });
});
