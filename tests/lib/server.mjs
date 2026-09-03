// tests/lib/server.mjs — 통합 테스트가 진짜 서버를 띄울 때 쓰는 공용 도우미.
//
// **이 파일은 테스트가 아니다.** `npm test` 의 글롭(`tests/*.test.mjs`)에 걸리지 않도록
// 하위 디렉터리에 두었다.
//
// 예전에는 파일마다 `3000 + random(20000)` 로 포트를 추첨했다(서버 M-16). 문제가 셋이었다.
//   ① 파일 3개가 **독립적으로** 뽑으므로 병렬 실행에서 같은 번호가 나올 수 있었다.
//   ② 실서버 포트(3000)를 뽑을 확률이 있었다.
//   ③ 이미 다른 프로그램이 쓰는 포트를 뽑으면 EADDRINUSE 로 테스트가 무작위로 깨졌다.
// 이제는 `PORT=0` 으로 띄워 **OS 가 비어 있는 포트를 고르게** 하고, 서버가 찍는
// `LISTEN_PORT=<n>` 한 줄을 읽어 실제 번호를 알아낸다. 추첨도 충돌도 없다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 서버가 실제로 잡은 포트를 알려 주는 줄. `server/boot.js` 의 printBanner 가 찍는다. */
const PORT_LINE = /LISTEN_PORT=(\d+)/;
/** 배너의 마지막 줄 — 라우트 배선까지 끝났다는 신호. */
const READY_LINE = '종료: Ctrl+C';

/**
 * 격리된 DATA_DIR 에 서버를 하나 띄우고 준비될 때까지 기다린다.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]      추가 환경변수 (PORT·DATA_DIR 은 여기서 정한다)
 * @param {string} [opts.prefix]   임시 디렉터리 이름 앞머리
 * @param {string} [opts.dataDir]  이미 있는 디렉터리를 쓸 때 (그러면 stop() 이 지우지 않는다)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{base:string, port:number, tmp:string, proc:object, log:()=>string, stop:()=>Promise<void>}>}
 */
export async function startServer(opts) {
  const o = opts || {};
  const ownsTmp = !o.dataDir;
  const tmp = o.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), o.prefix || 'jpk-test-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    // PORT=0 → 임시 포트. 아래에서 LISTEN_PORT 줄로 실제 번호를 읽는다.
    env: { ...process.env, ...(o.env || {}), PORT: '0', DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  // 자식이 살아 있는 동안 예기치 못한 종료를 붙잡아 대기 루프가 20초를 헛돌지 않게 한다.
  let exited = null;
  proc.once('exit', (code, signal) => { exited = { code, signal }; });

  const port = await new Promise((res, rej) => {
    const iv = setInterval(() => {
      const m = PORT_LINE.exec(out);
      if (m && out.includes(READY_LINE)) { done(); res(Number(m[1])); return; }
      if (/EADDRINUSE|PORT 값이/.test(out)) { done(); rej(new Error('서버 기동 실패:\n' + out)); return; }
      if (exited) { done(); rej(new Error('서버가 기동 중에 종료됐다 (code=' + exited.code + '):\n' + out)); }
    }, 25);
    const to = setTimeout(() => { done(); rej(new Error('서버 기동 타임아웃\n' + out)); }, o.timeoutMs || 20000);
    function done() { clearInterval(iv); clearTimeout(to); }
  }).catch(async (err) => {
    await stopProc(proc);
    if (ownsTmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    throw err;
  });

  return {
    base: 'http://localhost:' + port,
    port,
    tmp,
    proc,
    log: () => out,
    /** 자식이 **정말 끝날 때까지** 기다린다 — kill 만 하고 넘어가면 임시 디렉터리 삭제가 EBUSY 로 실패한다. */
    async stop() {
      await stopProc(proc);
      if (ownsTmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    },
  };
}

/** kill 후 `exit` 이벤트를 기다린다. 이미 죽었으면 즉시 반환한다. */
export function stopProc(proc) {
  if (!proc || proc.exitCode != null || proc.signalCode != null) return Promise.resolve();
  return new Promise((res) => {
    const to = setTimeout(res, 5000); // 안 죽어도 테스트를 붙잡아 두지는 않는다
    proc.once('exit', () => { clearTimeout(to); res(); });
    try { proc.kill(); } catch { clearTimeout(to); res(); }
  });
}
