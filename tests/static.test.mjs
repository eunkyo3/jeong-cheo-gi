// static.test.mjs — 정적 서빙 계층의 보안 계약 검증 (보안 N3 · N7).
//
// 둘을 본다.
//   ① HTML 캐시 상한 — 없는 `.html` 이름을 아무리 두드려도 `htmlCache` 는 **실재 파일 수**를 넘지 않는다.
//      캐시 크기는 HTTP 로 알 수 없으므로 이 파일만 `server/index.js` 를 **같은 프로세스에서**
//      require 해 `htmlCacheStats()` 를 직접 읽는다(node --test 는 파일마다 별도 프로세스를 쓴다).
//      `boot.start()` 대신 `server.listen()` 을 직접 불러 종료 훅(SIGINT/uncaughtException)이
//      테스트 프로세스에 걸리지 않게 한다.
//   ② 보안 헤더 — 모든 응답(정적·API·404)에 nosniff/DENY/Referrer-Policy/CSP 가 붙는다.
//      CSP 의 `script-src 'self'` 가 성립하려면 public/ 에 인라인 스크립트가 없어야 하므로
//      그 전제도 여기서 함께 못박는다(누가 인라인 `<script>` 를 넣으면 이 테스트가 먼저 깨진다).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// require 보다 **먼저** 정해야 한다 — index.js 가 로드 시점에 읽는다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-static-'));
process.env.DATA_DIR = tmp;
process.env.PORT = '0';

const srv = require(path.join(ROOT, 'server', 'index.js'));

/** public/ 아래 실재하는 `.html` 파일 절대 경로 (서버와 독립적으로 디스크에서 센다). */
function realHtmlFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...realHtmlFiles(full));
    else if (ent.isFile() && /\.html$/i.test(ent.name)) out.push(full);
  }
  return out;
}

const HTML_FILES = realHtmlFiles(PUBLIC_DIR);
/** 서버가 받아들이는 URL 경로 ("/study.html"). public/ 기준 상대 경로다. */
const HTML_PATHS = HTML_FILES.map((f) => '/' + path.relative(PUBLIC_DIR, f).split(path.sep).join('/'));

let base = '';

before(async () => {
  await new Promise((res) => srv.server.listen(0, '127.0.0.1', res));
  base = 'http://127.0.0.1:' + srv.server.address().port;
});

after(async () => {
  await new Promise((res) => srv.io.close(res)); // http 서버까지 같이 닫는다
  try { srv.db.close(); } catch { /* 이미 닫혔을 수 있다 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 없는 `.html` 이름 n 개를 동시에 두드린다. 경로 문자는 16진수뿐이라 순회 시도가 아니다. */
async function knockMissing(n) {
  const statuses = new Set();
  const BATCH = 50;
  for (let i = 0; i < n; i += BATCH) {
    const batch = [];
    for (let k = 0; k < BATCH && i + k < n; k++) {
      const name = 'ghost-' + Math.random().toString(16).slice(2) + '-' + (i + k) + '.html';
      batch.push(fetch(base + '/' + name).then((r) => { statuses.add(r.status); return r.text(); }));
    }
    await Promise.all(batch);
  }
  return statuses;
}

// ------------------------------------------------- ① HTML 캐시 상한 (보안 N3)

describe('HTML 캐시는 실재 파일 수를 넘지 않는다 (보안 N3)', () => {
  test('전제 — public/ 에 .html 이 있고 서버도 같은 수를 셌다', () => {
    assert.ok(HTML_FILES.length > 0, 'public/ 에 .html 이 하나도 없다');
    assert.equal(srv.htmlCacheStats().files, HTML_FILES.length);
  });

  test('없는 이름 500개를 두드려도 캐시가 늘지 않는다', async () => {
    const before = srv.htmlCacheStats().cached;
    const statuses = await knockMissing(500);
    assert.deepEqual([...statuses], [404], '없는 HTML 은 전부 404 여야 한다');
    assert.equal(srv.htmlCacheStats().cached, before, '없는 이름이 캐시에 들어갔다');
  });

  test('실재 파일을 전부 받으면 캐시가 딱 그 수만큼 찬다', async () => {
    for (const p of HTML_PATHS) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      const body = await r.text();
      // 이 핸들러를 탄 응답만 `?v=` 캐시 버스팅이 붙는다
      assert.ok(!/\s(?:src|href)="\/(?:js|css)\/[^"?]+\.(?:js|css)"/.test(body),
        p + ' 의 자산 참조에 ?v= 가 붙지 않았다');
    }
    const s = srv.htmlCacheStats();
    assert.equal(s.cached, s.files);
    assert.equal(s.cached, HTML_FILES.length);
  });

  test('그 뒤로 없는 이름 500개를 더 두드려도 상한 그대로다', async () => {
    await knockMissing(500);
    const s = srv.htmlCacheStats();
    assert.equal(s.cached, s.files, '캐시가 실재 파일 수를 넘었다 — 무한 증가 회귀');
  });

  test('`/` 와 `/index.html` 은 같은 칸을 쓴다', async () => {
    const before = srv.htmlCacheStats().cached;
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/index.html')).status, 200);
    assert.equal(srv.htmlCacheStats().cached, before);
  });

  test('public/ 밖으로 나가는 .html 은 404 이고 캐시도 그대로다', async () => {
    const before = srv.htmlCacheStats().cached;
    for (const p of ['/%2e%2e/%2e%2e/README.html', '/..%2f..%2fpackage.html', '/sub/../../outside.html']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 404, p);
      await r.text();
    }
    assert.equal(srv.htmlCacheStats().cached, before);
  });
});

// ------------------------------------------------------ ② 보안 헤더 (보안 N7)

const EXPECTED = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

describe('보안 헤더는 모든 응답에 붙는다 (보안 N7)', () => {
  for (const p of ['/', '/admin.html', '/js/api.js', '/css/app.css', '/api/rounds', '/api/nope', '/없는페이지']) {
    test('GET ' + p, async () => {
      const r = await fetch(base + p);
      await r.text();
      for (const [name, value] of Object.entries(EXPECTED)) {
        assert.equal(r.headers.get(name), value, p + ' 의 ' + name);
      }
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp, p + ' 에 CSP 가 없다');
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /base-uri 'none'/);
    });
  }

  test("CSP 의 script-src 는 'self' 뿐이다 — 'unsafe-inline'·'unsafe-eval' 금지", async () => {
    const r = await fetch(base + '/');
    await r.text();
    const csp = r.headers.get('content-security-policy');
    const scriptSrc = (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) || '');
    assert.equal(scriptSrc, "script-src 'self'");
    const styleSrc = (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('style-src')) || '');
    assert.equal(styleSrc, "style-src 'self'", "style-src 도 'self' 뿐이다 — 인라인 <style>/style= 은 index.css·qbody.js 로 뺐다");
    assert.ok(!/unsafe-eval/.test(csp), 'CSP 어디에도 unsafe-eval 이 있으면 안 된다');
  });

  test('socket.io 웹소켓이 connect-src 에 허용돼 있다', async () => {
    const r = await fetch(base + '/');
    await r.text();
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self' ws: wss:/);
  });
});

describe("script-src 'self' 의 전제 — public/ 에 인라인 스크립트가 없다", () => {
  test('인라인 <script>·on*= 핸들러·javascript: 링크가 0건이다', () => {
    const offenders = [];
    for (const file of HTML_FILES) {
      const name = path.relative(ROOT, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      for (const tag of text.match(/<script\b[^>]*>/gi) || []) {
        if (!/\ssrc\s*=/i.test(tag)) offenders.push(name + ' — 인라인 <script>: ' + tag);
      }
      for (const attr of text.match(/\son[a-z]+\s*=/gi) || []) {
        offenders.push(name + ' — 이벤트 핸들러 속성:' + attr.trim());
      }
      for (const href of text.match(/(?:href|src)\s*=\s*["']\s*javascript:/gi) || []) {
        offenders.push(name + ' — javascript: 링크: ' + href);
      }
      // style-src 'self' 의 전제 — 인라인 <style> 블록과 style= 속성도 0건
      for (const tag of text.match(/<style\b[^>]*>/gi) || []) offenders.push(name + ' — 인라인 <style>: ' + tag);
      for (const attr of text.match(/\sstyle\s*=/gi) || []) offenders.push(name + ' — style= 속성:' + attr.trim());
    }
    // JS 가 setAttribute('style', …) 로 인라인 style 을 만들면 CSP 에 막힌다 (el.style.x = … 는 허용)
    const jsDir = path.join(ROOT, 'public', 'js');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
    for (const file of walk(jsDir)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/setAttribute\(\s*['"]style['"]/.test(text) || /\sstyle="/.test(text)) {
        offenders.push(path.relative(ROOT, file) + ' — setAttribute("style") 또는 style=" 문자열');
      }
    }
    assert.deepEqual(offenders, [],
      "인라인 스크립트가 생기면 CSP script-src 'self' 가 그 페이지를 깨뜨린다");
  });
});
