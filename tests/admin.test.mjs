// admin.test.mjs — 관리자 페이지 REST(`/api/admin/*`) 종단 검증.
//
// 실서버를 임시 포트(PORT=0 — 실운영 3000 은 절대 쓰지 않는다) + 격리된 임시 DATA_DIR 로
// 띄우고 fetch 로 두드린다. 어댑터 2종(sqlite/json)에 같은 시나리오를 돌린다.
// 레이트리밋 테스트만 카운터가 깨끗한 **전용 서버**를 따로 띄운다.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer as spawnServer } from './lib/server.mjs';

const require = createRequire(import.meta.url);

const ADMIN_ID = 'admin';
const ADMIN_PW = 'qwer1234!';
const COOKIE = 'jpk_admin';

/** 쿠키 없이도 401 이어야 하는 관리자 GET 전부. */
const GUARDED_GETS = [
  '/api/admin/me',
  '/api/admin/stats',
  '/api/admin/users',
  '/api/admin/matches',
  '/api/admin/reports',
  '/api/admin/rooms',
  '/api/admin/study',
];

// ------------------------------------------------------------ 서버 기동

// 포트 추첨을 없앴다(서버 M-16). `PORT=0` 으로 띄우면 OS 가 비어 있는 포트를 고르고
// 서버가 `LISTEN_PORT=<n>` 을 찍어 준다 — 실운영 포트(3000)를 뽑을 일도, 다른 테스트와
// 부딪힐 일도 없다. 공용 도우미는 tests/lib/server.mjs 에 있다.
async function startServer(extraEnv) {
  return spawnServer({ prefix: 'jpk-admin-', env: extraEnv || {} });
}

/** 쿠키 항아리를 따로 쓰는 최소 클라이언트. 클라이언트마다 세션이 격리된다. */
function makeClient(base) {
  const jar = new Map();
  async function call(method, p, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const resp = await fetch(base + p, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    for (const line of setCookies) {
      const kv = line.split(';')[0];
      const i = kv.indexOf('=');
      const name = kv.slice(0, i).trim();
      const value = kv.slice(i + 1);
      if (value === '') jar.delete(name); else jar.set(name, value);
    }
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아닐 수 있다 */ }
    return { status: resp.status, json, text, setCookies, headers: resp.headers };
  }
  call.jar = jar;
  return call;
}

// ------------------------------------------------------- 어댑터별 시나리오

const adapters = ['json'];
try {
  require('better-sqlite3');
  adapters.unshift('sqlite');
} catch {
  // 빌드 도구가 없는 환경 — json 폴백만 검증한다
}

for (const adapter of adapters) {
  describe(`관리자 API (${adapter} 어댑터)`, () => {
    let srv = null;
    let admin = null;   // 관리자 세션을 물고 다니는 클라이언트
    let anon = null;    // 쿠키가 없는 클라이언트
    let member = null;  // 일반 사용자 세션

    before(async () => {
      srv = await startServer({ DB_ADAPTER: adapter });
      admin = makeClient(srv.base);
      anon = makeClient(srv.base);
      member = makeClient(srv.base);
    });

    after(async () => { if (srv) await srv.stop(); });

    test('DB 어댑터가 의도한 것으로 떴다', async () => {
      // 통계는 로그인 뒤에 본다 — 여기서는 서버가 뜬 것만 확인한다
      const r = await anon('GET', '/api/rounds');
      assert.equal(r.status, 200);
    });

    test('쿠키 없이는 관리자 GET 이 전부 401', async () => {
      for (const p of GUARDED_GETS) {
        const r = await anon('GET', p);
        assert.equal(r.status, 401, p + ' → ' + r.status);
        assert.equal(r.json.error, '관리자 로그인이 필요합니다.');
      }
      assert.equal(anon.jar.size, 0);
    });

    test('아이디는 맞고 비밀번호가 틀리면 401 · 쿠키를 주지 않는다', async () => {
      const r = await admin('POST', '/api/admin/login', { id: ADMIN_ID, password: 'wrong-password' });
      assert.equal(r.status, 401, r.text);
      assert.equal(r.json.error, '아이디 또는 비밀번호가 올바르지 않습니다.');
      assert.equal(admin.jar.has(COOKIE), false);
    });

    test('아이디가 틀려도 같은 401 문구 (계정 존재 여부를 흘리지 않는다)', async () => {
      const r = await admin('POST', '/api/admin/login', { id: 'root', password: ADMIN_PW });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, '아이디 또는 비밀번호가 올바르지 않습니다.');
      assert.equal(admin.jar.has(COOKIE), false);
    });

    test('올바른 자격증명이면 jpk_admin 쿠키가 발급된다', async () => {
      const r = await admin('POST', '/api/admin/login', { id: ADMIN_ID, password: ADMIN_PW });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.id, ADMIN_ID);

      const line = r.setCookies.find((c) => c.startsWith(COOKIE + '='));
      assert.ok(line, r.setCookies.join(' | '));
      assert.match(line, /HttpOnly/);
      assert.match(line, /SameSite=Lax/);
      assert.match(line, /Path=\//);
      assert.match(line, /Max-Age=43200/);      // 12시간
      assert.equal(/;\s*Secure/.test(line), false); // COOKIE_SECURE 를 주지 않았다
      assert.ok(admin.jar.get(COOKIE).includes('.'), '토큰은 payload.signature 꼴이다');
    });

    test('GET me — 로그인한 관리자 정보', async () => {
      const r = await admin('GET', '/api/admin/me');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.id, ADMIN_ID);
      assert.equal(r.json.maxAgeS, 43200);
      assert.ok(Number.isFinite(r.json.since));
    });

    test('망가진 쿠키는 통하지 않는다', async () => {
      const forged = makeClient(srv.base);
      forged.jar.set(COOKIE, admin.jar.get(COOKIE).slice(0, -2) + 'xx');
      assert.equal((await forged('GET', '/api/admin/me')).status, 401);

      const junk = makeClient(srv.base);
      junk.jar.set(COOKIE, 'not-a-token');
      assert.equal((await junk('GET', '/api/admin/me')).status, 401);
    });

    test('GET stats — 통계 모양', async () => {
      const r = await admin('GET', '/api/admin/stats');
      assert.equal(r.status, 200, r.text);
      const s = r.json;
      assert.deepEqual(Object.keys(s).sort(), ['battle', 'content', 'db', 'server']);
      assert.equal(s.db.adapter, adapter);
      assert.equal(s.db.available, true);
      assert.equal(typeof s.db.users, 'number');
      assert.equal(typeof s.db.matches, 'number');
      assert.equal(typeof s.db.studyResults, 'number');
      assert.ok(s.content.rounds > 0, '회차가 하나 이상 로드돼야 한다');
      assert.ok(s.content.questions > 0);
      assert.ok(s.battle.activeRooms === null || typeof s.battle.activeRooms === 'number');
      assert.equal(s.server.node, process.version);
      assert.equal(typeof s.server.pid, 'number');
      assert.ok(Number.isFinite(Date.parse(s.server.startedAt)));
    });

    test('GET users — 가입한 사용자가 보이고 password_hash 는 절대 없다', async () => {
      const up = await member('POST', '/api/auth/signup', { nickname: '관리자테스트', password: 'pw123456785678' });
      assert.equal(up.status, 200, up.text);

      const r = await admin('GET', '/api/admin/users');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.limit, 20);
      assert.equal(r.json.offset, 0);
      assert.equal(r.json.total, 1);
      assert.equal(r.json.items.length, 1);

      const u = r.json.items[0];
      assert.equal(u.nickname, '관리자테스트');
      assert.ok(Number.isInteger(u.id));
      assert.ok(u.created_at);
      assert.equal(u.match_count, 0);
      assert.equal(u.last_study_at, null);
      // 비밀번호 계열은 필드 이름으로도 값으로도 나가면 안 된다
      assert.deepEqual(Object.keys(u).sort(),
        ['created_at', 'id', 'last_study_at', 'match_count', 'nickname']);
      assert.equal(/password|hash|scrypt|\$2[aby]\$/i.test(r.text), false, r.text);
    });

    test('GET users?q= — 닉네임 검색과 페이지 상한', async () => {
      const hit = await admin('GET', '/api/admin/users?q=' + encodeURIComponent('관리자'));
      assert.equal(hit.status, 200);
      assert.equal(hit.json.total, 1);

      const miss = await admin('GET', '/api/admin/users?q=' + encodeURIComponent('없는닉네임'));
      assert.equal(miss.status, 200);
      assert.equal(miss.json.total, 0);
      assert.deepEqual(miss.json.items, []);

      // LIKE 메타문자는 이스케이프된다 — '%' 하나로 전부 긁히면 안 된다
      const meta = await admin('GET', '/api/admin/users?q=%25');
      assert.equal(meta.status, 200);
      assert.equal(meta.json.total, 0);

      // limit 은 100 을 넘지 않는다
      const big = await admin('GET', '/api/admin/users?limit=9999');
      assert.equal(big.json.limit, 100);
      const zero = await admin('GET', '/api/admin/users?limit=0&offset=-5');
      assert.equal(zero.json.limit, 20);
      assert.equal(zero.json.offset, 0);
    });

    test('GET study — 채점하면 학습 기록이 잡힌다', async () => {
      const before0 = await admin('GET', '/api/admin/study');
      assert.equal(before0.status, 200);
      assert.equal(before0.json.total, 0);

      const rounds = await member('GET', '/api/rounds');
      const roundId = rounds.json[0].round;
      const g = await member('POST', `/api/rounds/${roundId}/grade`, { answers: {} });
      assert.equal(g.status, 200, g.text);

      const r = await admin('GET', '/api/admin/study');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.total, 1);
      const s = r.json.items[0];
      assert.equal(s.round, roundId);
      assert.equal(s.nickname, '관리자테스트');
      assert.equal(typeof s.score, 'number');
      assert.ok(s.question_count > 0);
      assert.ok(s.wrong_count > 0);
      assert.ok(s.taken_at);
      assert.deepEqual(Object.keys(s).sort(),
        ['id', 'match_id', 'nickname', 'question_count', 'round', 'score', 'taken_at', 'user_id', 'wrong_count']);

      // userId 필터
      const mine = await admin('GET', '/api/admin/study?userId=' + s.user_id);
      assert.equal(mine.json.total, 1);
      const other = await admin('GET', '/api/admin/study?userId=999999');
      assert.equal(other.json.total, 0);
      assert.equal((await admin('GET', '/api/admin/study?userId=abc')).status, 400);
      assert.equal((await admin('GET', '/api/admin/study?userId=0')).status, 400);
    });

    test('GET matches — 대전이 없으면 빈 목록', async () => {
      const r = await admin('GET', '/api/admin/matches');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.total, 0);
      assert.deepEqual(r.json.items, []);
    });

    test('GET reports — 신고를 넣으면 최신순으로 보인다', async () => {
      const empty = await admin('GET', '/api/admin/reports');
      assert.equal(empty.status, 200, empty.text);
      assert.equal(empty.json.total, 0);

      const rounds = await member('GET', '/api/rounds');
      const round = await member('GET', '/api/rounds/' + rounds.json[0].round);
      const qid = round.json.questions[0].id;
      const posted = await member('POST', '/api/reports', { questionId: qid, comment: '정답이 이상합니다.' });
      assert.equal(posted.status, 200, posted.text);

      const r = await admin('GET', '/api/admin/reports');
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.total, 1);
      assert.equal(r.json.items[0].questionId, qid);
      assert.equal(r.json.items[0].comment, '정답이 이상합니다.');
    });

    test('GET rooms — 열린 방이 없다', async () => {
      const r = await admin('GET', '/api/admin/rooms');
      assert.equal(r.status, 200, r.text);
      assert.ok(Array.isArray(r.json.items));
      assert.equal(r.json.items.length, 0);
    });

    test('일반 사용자 세션으로는 관리자 API 에 들어갈 수 없다', async () => {
      const me = await member('GET', '/api/auth/me');
      assert.equal(me.status, 200);
      assert.ok(me.json.user, '일반 사용자로 로그인된 상태여야 한다');
      for (const p of GUARDED_GETS) {
        assert.equal((await member('GET', p)).status, 401, p);
      }
    });

    test('관리자 쿠키로는 일반 사용자 API 에 들어갈 수 없다', async () => {
      assert.equal((await admin('GET', '/api/me/history')).status, 401);
      const who = await admin('GET', '/api/auth/me');
      assert.equal(who.status, 200);
      assert.equal(who.json.user, null);
    });

    test('POST logout — 쿠키가 지워지고 이후 조회는 401', async () => {
      const r = await admin('POST', '/api/admin/logout');
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      const line = r.setCookies.find((c) => c.startsWith(COOKIE + '='));
      assert.ok(line, r.setCookies.join(' | '));
      assert.match(line, /Max-Age=0/);
      assert.equal(admin.jar.has(COOKIE), false);

      assert.equal((await admin('GET', '/api/admin/me')).status, 401);
      assert.equal((await admin('GET', '/api/admin/stats')).status, 401);
    });

    test('로그인 상태가 아니어도 logout 은 200', async () => {
      assert.equal((await anon('POST', '/api/admin/logout')).status, 200);
    });
  });
}

// ------------------------------------------------------------- 레이트리밋
//
// 카운터가 깨끗한 전용 서버가 필요하다 — 위 시나리오가 이미 로그인 시도를 여러 번 썼기 때문이다.

describe('관리자 로그인 레이트리밋 (IP 당 1분 5회)', () => {
  let srv = null;
  let c = null;

  before(async () => {
    srv = await startServer({ DB_ADAPTER: 'json' });
    c = makeClient(srv.base);
  });

  after(async () => { if (srv) await srv.stop(); });

  test('5회까지는 401, 6회째부터 429 + Retry-After', async () => {
    for (let i = 1; i <= 5; i += 1) {
      const r = await c('POST', '/api/admin/login', { id: ADMIN_ID, password: 'nope' });
      assert.equal(r.status, 401, `${i}번째 시도는 아직 401 이어야 한다 (실제 ${r.status})`);
    }
    const blocked = await c('POST', '/api/admin/login', { id: ADMIN_ID, password: 'nope' });
    assert.equal(blocked.status, 429, blocked.text);
    assert.match(blocked.json.error, /너무 많습니다/);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);

    // 창이 열려 있는 동안은 올바른 비밀번호도 막힌다 (브루트포스 지연이 목적)
    const evenRight = await c('POST', '/api/admin/login', { id: ADMIN_ID, password: ADMIN_PW });
    assert.equal(evenRight.status, 429);
    assert.equal(evenRight.setCookies.some((l) => l.startsWith(COOKIE + '=')), false);
  });
});

// ------------------------------------------------------- 로그 인젝션 (보안 N5)
//
// 실패한 로그인 시도의 아이디가 그대로 로그에 실리면, 개행을 섞어 **가짜 로그 줄**을 만들 수
// 있다. 운영자가 로그로 사고를 판단하는 경로가 오염되므로 제어문자는 물음표로 바꿔 한 줄을
// 유지한다(`routes/auth.js` 의 `nickForLog` 와 같은 규약).

describe('관리자 로그인 실패 로그 — 제어문자 주입 차단 (보안 N5)', () => {
  let srv = null;
  let stderr = '';

  before(async () => {
    srv = await startServer({ DB_ADAPTER: 'json' });
    // 공용 도우미는 stdout·stderr 를 합쳐 두므로, stderr 만 따로 받아 본다.
    srv.proc.stderr.on('data', (d) => { stderr += d; });
  });

  after(async () => { if (srv) await srv.stop(); });

  test('개행·ESC 를 섞은 아이디는 401 이고 로그는 한 줄로 남는다', async () => {
    const c = makeClient(srv.base);
    // 41 코드포인트 — 40 상한도 함께 확인된다
    const evil = 'admin\n[00:00:00] admin 로그인 성공\u001b[31mFAKE\r위조';
    const r = await c('POST', '/api/admin/login', { id: evil, password: 'nope' });
    assert.equal(r.status, 401, r.text);

    await new Promise((res) => { setTimeout(res, 300); }); // 로그가 흘러나올 틈

    const failLines = stderr.split('\n').filter((l) => l.includes('admin 로그인 실패'));
    assert.equal(failLines.length, 1, JSON.stringify(stderr));

    const line = failLines[0];
    // 제어문자가 한 글자도 남지 않는다 (개행은 split 으로 이미 갈렸으므로 \r·ESC 가 대상)
    assert.equal(/[\u0000-\u001f\u007f]/.test(line), false, JSON.stringify(line));
    assert.equal(line.includes('\u001b'), false, JSON.stringify(line));
    // 제어문자 자리에는 물음표가 들어간다
    assert.match(line, /id=admin\?\[00:00:00\] admin 로그인 성공\?\[31mFAKE\?/);

    // 위조된 "성공" 줄이 **독립된 로그 줄로** 생기지 않는다
    const forged = stderr.split('\n').filter((l) => /^\[\d\d:\d\d:\d\d\] admin 로그인 성공/.test(l));
    assert.deepEqual(forged, [], JSON.stringify(stderr));

    // 40 코드포인트로 잘린다 — 마지막 '조' 는 실리지 않는다
    const logged = line.slice(line.indexOf('id=') + 3);
    assert.equal(Array.from(logged).length, 40, JSON.stringify(logged));
    assert.equal(logged.endsWith('위'), true, JSON.stringify(logged));
  });
});

// -------------------------------------------------------------- 정적 페이지

describe('/admin.html', () => {
  let srv = null;

  before(async () => { srv = await startServer({ DB_ADAPTER: 'json' }); });
  after(async () => { if (srv) await srv.stop(); });

  test('관리자 페이지가 서빙되고 로그인 폼을 담고 있다', async () => {
    const resp = await fetch(srv.base + '/admin.html');
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/html/);
    const html = await resp.text();
    assert.match(html, /<title>정처기 배틀 관리자<\/title>/);
    assert.match(html, /lang="ko"/);
    assert.match(html, /id="loginForm"/);
    assert.match(html, /role="alert"/);
    assert.match(html, /<main/);
    assert.match(html, /<h1>/);
    assert.match(html, /\/js\/admin\.js/);
    assert.match(html, /\/css\/admin\.css/);
  });

  test('일반 페이지 내비에는 관리자 링크가 없다', async () => {
    for (const page of ['/index.html', '/study.html', '/battle.html', '/ranking.html', '/wrong.html']) {
      const resp = await fetch(srv.base + page);
      if (resp.status !== 200) continue;
      const html = await resp.text();
      assert.equal(/href="\/admin\.html"/.test(html), false, page + ' 에 관리자 링크가 있다');
    }
    const navJs = await (await fetch(srv.base + '/js/shared/nav.js')).text().catch(() => '');
    assert.equal(/admin\.html/.test(navJs), false, 'nav.js 에 관리자 링크가 있다');
  });
});
