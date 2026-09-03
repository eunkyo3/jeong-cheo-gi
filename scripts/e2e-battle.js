#!/usr/bin/env node
// e2e-battle.js — 실서버 2인 대전 종단 검증.
// 격리된 임시 DATA_DIR + 임의 포트로 서버를 띄우고 소켓 시나리오를 돌린 뒤 정리한다. 실제 data/ 는 건드리지 않는다.
//   npm run e2e
'use strict';
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
// 포트는 **추첨하지 않는다**. `PORT=0` 으로 띄우고 OS 가 잡아 준 번호를 `LISTEN_PORT=<n>` 줄에서
// 읽는다. 그래야 ① 실서버 포트 3000 과 부딪힐 길이 아예 없고 ② 병렬 실행이 서로를 밀어내지 않는다.
const T0 = Date.now();
const log = (...a) => console.log('[' + String(Date.now() - T0).padStart(5) + 'ms]', ...a);

/**
 * 격리 서버 하나를 띄운다. `env` 로 상수 백도어(BATTLE_*)를 주입할 수 있다.
 * 반환된 `base` 를 `req`/`sock` 의 마지막 인자로 넘기면 그 서버에 대고 시나리오를 돌린다.
 * 띄운 서버는 전부 `extras` 에 모아 두고 `shutdown` 이 한꺼번에 정리한다.
 */
function spawnServer(env, label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-e2e-'));
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: '0', DATA_DIR: tmp, ...(env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const box = { proc: proc, port: null, tmp: tmp, base: '', log: '', label: label || 'srv' };
  proc.stdout.on('data', d => { box.log += d; });
  proc.stderr.on('data', d => { box.log += d; });
  box.ready = new Promise((res, rej) => {
    const t = setInterval(() => {
      // 준비 신호는 **`LISTEN_PORT=<n>`** 다 — boot.js 가 `server.listen` 콜백 안에서 찍는다.
      // `battle-io.js 연결 완료` 는 listen **이전**(index.js 로드 중)에 나온다. 그걸 신호로 쓰면
      // 아직 듣지 않는 포트에 접속해 빈 메시지 AggregateError(ECONNREFUSED ×2)로 죽는다 —
      // 폴링 간격이 짧을수록 잘 터진다(실측 1/12).
      const m = /LISTEN_PORT=(\d+)/.exec(box.log);
      if (m && box.log.includes('battle-io.js 연결 완료')) {
        clearInterval(t);
        box.port = Number(m[1]);
        box.base = 'http://localhost:' + box.port;
        res(box);
      } else if (/EADDRINUSE|battle-io\.js 없음|로드 실패/.test(box.log)) {
        clearInterval(t); rej(new Error(box.label + ': ' + box.log));
      }
    }, 50);
    setTimeout(() => { clearInterval(t); rej(new Error(box.label + ' start timeout\n' + box.log)); }, 20000);
  });
  return box;
}

const extras = [];
function stopServer(box) {
  try { box.proc.kill(); } catch (_) { /* already gone */ }
  try { fs.rmSync(box.tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

const main = spawnServer({}, 'main');
const TMP = main.tmp;
let BASE = ''; // LISTEN_PORT 를 읽은 뒤 채워진다 — req/sock 의 기본 대상
const ready = main.ready.then(() => { BASE = main.base; });

function shutdown(code) {
  stopServer(main);
  for (const box of extras) stopServer(box);
  process.exit(code);
}

function req(method, p, body, cookie, base) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (data) headers['content-length'] = data.length;
    if (cookie) headers.cookie = cookie;
    const r = http.request((base || BASE) + p, { method, headers }, resp => {
      let s = '';
      resp.on('data', c => { s += c; });
      resp.on('end', () => res({ status: resp.statusCode, json: s ? JSON.parse(s) : null, cookie: (resp.headers['set-cookie'] || [])[0]?.split(';')[0] }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

const sock = (cookie, name, base) => new Promise((res, rej) => {
  const s = io(base || BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
  // 연결 직후(서버 connect 핸들러)에서 날아오는 battle:resync 를 놓치지 않으려면
  // 리스너를 소켓 생성 시점에 붙여 두고 이름만 기록해 둔다.
  s.__seen = [];
  // battle:finished 이전(=종료 전) 페이로드에 상대 답안 맵이 섞이면 치팅이다. 받는 즉시 훑어 기록한다.
  s.__answerLeaks = [];
  // ---- 접속 직후 폭주분(burst) 보관 ----
  // 서버는 `connection` 핸들러 안에서 곧바로 room:state·battle:resync 를 쏜다. 그 프레임들은
  // 클라이언트가 'connect' 를 내는 것과 **같은 동기 구간**에서 파싱되므로, `await sock()` 뒤에
  // (= 마이크로태스크에서) 리스너를 다는 호출자는 이미 지나간 이벤트를 영영 보지 못한다.
  // 부하를 걸고 35회 돌려 2회 재현했다 — 로그에는 `B2 <- battle:resync` 가 찍혀 있는데
  // waitFor 만 5초 뒤 타임아웃했다. **배달은 됐고 리스너가 늦었다.**
  // 그래서 connect 직후 한 틱 동안 도착한 것을 여기 담아 두고 waitFor 가 먼저 이걸 뒤진다.
  // 창은 **소켓 생성 시점부터** 열어 둔다 — socket.io 는 handshake 이전에 받아 둔 패킷을
  // `emitBuffered()` 로 'connect' **보다 먼저** 흘리기도 한다. 그 경로까지 같이 덮는다.
  s.__burst = [];
  let burstOpen = true;
  s.on('connect', () => {
    log(name, 'socket connected');
    setTimeout(() => { burstOpen = false; }, 0); // 같은 동기 구간이 끝나면 닫는다
    res(s);
  });
  s.on('connect_error', e => rej(new Error(name + ' connect_error: ' + e.message)));
  // 에러는 이름만으로는 무엇이 왔는지 알 수 없다 — 코드까지 남겨야 사후에 단언할 수 있다
  // (예: 같은 계정이 새 소켓으로 붙었을 때 옛 소켓이 받는 SESSION_REPLACED).
  s.__errors = [];
  s.onAny((ev, p) => {
    if (burstOpen) s.__burst.push({ ev: ev, p: p });
    if (ev === 'error') s.__errors.push(p);
    s.__seen.push(ev);
    if (ev !== 'battle:finished' && /answersByUser|marksByUser/.test(JSON.stringify(p === undefined ? null : p))) {
      s.__answerLeaks.push(ev);
    }
    if (ev === 'battle:tick' || ev === 'battle:progress') return;
    const extra = ev === 'battle:questions' ? `(${p.questions.length} q)`
      : ev === 'room:state' ? p.state + ' ' + p.players.map(x => x.nickname + (x.connected ? '' : '(x)')).join(',')
      : ev === 'error' ? JSON.stringify(p) : '';
    log(name, '<-', ev, extra);
  });
});

/**
 * `ev` 가 `pred` 를 만족하며 올 때까지 기다린다.
 *
 * 먼저 **접속 직후 폭주분**(`sock` 의 `__burst`)을 뒤진다. 리스너를 달기 전에 이미 지나간
 * 이벤트를 여기서 건진다. 한 번 훑고 나면 폭주분은 비운다 — 뒤늦은 느슨한 조건
 * (`() => true` 짜리 error 대기 등)이 옛 이벤트에 잘못 걸리지 않게 하기 위해서다.
 * 타임아웃·성공 어느 쪽이든 리스너를 뗀다(대전 시나리오가 길어 리스너가 쌓인다).
 */
const waitFor = (s, ev, pred = () => true, ms = 15000) => new Promise((res, rej) => {
  const burst = s.__burst || [];
  for (let i = 0; i < burst.length; i++) {
    let ok = false;
    if (burst[i].ev === ev) { try { ok = pred(burst[i].p); } catch (_) { ok = false; } }
    if (ok) { const p = burst[i].p; burst.length = 0; return res(p); }
  }
  burst.length = 0;
  const t = setTimeout(() => { s.off(ev, onEvent); rej(new Error('timeout waiting ' + ev)); }, ms);
  function onEvent(p) {
    if (!pred(p)) return;
    clearTimeout(t);
    s.off(ev, onEvent);
    res(p);
  }
  s.on(ev, onEvent);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 실패하면 던진다 — 바깥 catch 가 E2E ERROR 로 잡아 exit 1 한다. */
function check(cond, msg) {
  log(cond ? 'OK  ' : 'FAIL', msg);
  if (!cond) throw new Error('check failed: ' + msg);
}

/**
 * 격리 DATA_DIR 의 DB 를 직접 읽어 study_results 전 행을 돌려준다(읽기 전용).
 * 서버가 어느 어댑터로 떴는지 모르므로 파일 존재로 판별한다 — sqlite(app.db) / json(app.json).
 */
function readStudyResults() {
  const sqliteFile = path.join(TMP, 'app.db');
  if (fs.existsSync(sqliteFile)) {
    const Database = require('better-sqlite3');
    const conn = new Database(sqliteFile, { readonly: true });
    try {
      return conn.prepare('SELECT * FROM study_results ORDER BY id').all();
    } finally {
      conn.close();
    }
  }
  const jsonFile = path.join(TMP, 'app.json');
  if (!fs.existsSync(jsonFile)) return [];
  return JSON.parse(fs.readFileSync(jsonFile, 'utf8')).study_results || [];
}

(async () => {
  await ready; log("server up on", main.port, "DATA_DIR", TMP);
  const uA = 'e2eA' + (T0 % 10000), uB = 'e2eB' + (T0 % 10000);
  const a = await req('POST', '/api/auth/signup', { nickname: uA, password: 'pw12345678' });
  const b = await req('POST', '/api/auth/signup', { nickname: uB, password: 'pw12345678' });
  log('signup', a.status, b.status, 'ids', a.json.user.id, b.json.user.id);
  const room = await req('POST', '/api/rooms', { name: 'e2e', mode: 'random', roundIds: ['2026-2', '2023-3'], questionCount: 5, timeLimitS: 600 }, a.cookie);
  log('POST /api/rooms', room.status, JSON.stringify(room.json));
  const bad = await req('POST', '/api/rooms', { name: 'x', mode: 'random', roundIds: ['2026-2'], questionCount: 20, timeLimitS: 600 }, a.cookie);
  log('pool check: 20 q from 1 round of 20 ->', bad.status, '(expect 201/200; pool == count is allowed)');
  const bad2 = await req('POST', '/api/rooms', { name: 'x', mode: 'round', roundIds: ['2026-2'], timeLimitS: 999 }, a.cookie);
  log('bad timeLimit ->', bad2.status, bad2.json && bad2.json.error);
  const noauth = await req('POST', '/api/rooms', { name: 'x', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 });
  log('no-auth create ->', noauth.status);

  const sA = await sock(a.cookie, 'A'), sB = await sock(b.cookie, 'B');
  const rid = room.json.roomId;
  sA.emit('room:join', { roomId: rid });
  await waitFor(sA, 'room:state', p => p.players.length === 1);
  const list = await req('GET', '/api/rooms', null, b.cookie);
  log('GET /api/rooms ->', JSON.stringify(list.json));
  sB.emit('room:join', { roomId: rid });
  await waitFor(sA, 'room:state', p => p.players.length === 2);
  sB.emit('room:start', {}); // non-host
  const err = await waitFor(sB, 'error', () => true, 3000).catch(() => null);
  log('non-host start ->', err ? 'rejected: ' + err.code : 'NO ERROR (bug)');
  sA.emit('room:start', {});
  const qs = await waitFor(sB, 'battle:questions');
  log('questions received by B:', qs.questions.length, '| leak check:', JSON.stringify(Object.keys(qs.questions[0])), '| field keys:', JSON.stringify(Object.keys(qs.questions[0].fields[0])));
  const leak = qs.questions.some(q => q.accept || q.sampleAnswer || q.display || q.sourceImages || q.fields.some(f => f.accept || f.validator || f.sampleAnswer));
  log('ANSWER LEAK:', leak ? 'YES — FAIL' : 'none');
  // 해설은 정답을 그대로 담고 있다 — 대전 중 페이로드에는 흔적조차 없어야 한다(PROTOCOL "채점 전 비노출").
  check(!/explanationHtml|"explanations"/.test(JSON.stringify(qs)),
    'battle:questions 에 explanationHtml/explanations 없음');
  // A answers 2 questions (values unknown -> just fill), B answers 1
  const q0 = qs.questions[0], q1 = qs.questions[1];
  sA.emit('battle:answer', { questionId: q0.id, fieldIndex: 0, value: 'x' });
  sA.emit('battle:answer', { questionId: q1.id, fieldIndex: 0, value: 'y' });
  sB.emit('battle:answer', { questionId: q0.id, fieldIndex: 0, value: 'B-typed-this' });
  const prog = await waitFor(sB, 'battle:progress', p => p.answeredCount >= 1, 5000);
  log('B sees A progress:', JSON.stringify(prog), '| has correctness field?', 'correct' in prog ? 'YES — FAIL' : 'no');
  // reconnect B
  sB.disconnect(); log('B disconnected');
  await waitFor(sA, 'room:state', p => p.players.some(x => !x.connected), 5000);
  const sB2 = await sock(b.cookie, 'B2');
  const rs = await waitFor(sB2, 'battle:resync', () => true, 5000);
  const restored = rs.myAnswers && rs.myAnswers[q0.id] && rs.myAnswers[q0.id][0]; log('B2 resync:', rs.state, 'questions', rs.questions.length, 'remainingMs', rs.remainingMs, '| restored answer:', JSON.stringify(restored), restored === 'B-typed-this' ? 'OK' : 'FAIL — not restored');
  check(!/explanationHtml|"explanations"/.test(JSON.stringify(rs)),
    'battle:resync 에 explanationHtml/explanations 없음');

  // ------------------------------- 제출자 간 정오 공유 (battle:marks, 제출자 전용 개별 발송)
  // A 만 제출한 시점: A 는 자기 정오표를 받고, 미제출자 B 는 한 건도 받지 못해야 한다.
  const pMarksA = waitFor(sA, 'battle:marks', () => true, 5000);
  sA.emit('battle:submit', {});
  const marksA = await pMarksA;
  check(marksA.players.length === 1 && marksA.players[0].userId === a.json.user.id,
    'A 제출 → A 에게 battle:marks (제출자 1명): ' + JSON.stringify(marksA.players.map(p => [p.userId, p.nickname])));
  check(JSON.stringify(Object.keys(marksA.players[0]).sort()) === JSON.stringify(['marks', 'nickname', 'userId']),
    'battle:marks 행은 {userId,nickname,marks} 뿐 — 답 내용·display 누출 없음: ' + JSON.stringify(Object.keys(marksA.players[0])));
  const mkA = marksA.players[0].marks;
  check(Object.keys(mkA).length === qs.questions.length && Object.keys(mkA).every(k => typeof mkA[k] === 'boolean'),
    'marks 는 전 문항의 정오 불리언: ' + JSON.stringify(mkA));
  await sleep(500); // 미제출자에게 늦게라도 새어 나가지 않는지 확인할 여유
  check(!sB2.__seen.includes('battle:marks'),
    '미제출자 B 는 battle:marks 를 한 건도 받지 않는다 (수신: ' + JSON.stringify(sB2.__seen.filter(e => e.startsWith('battle:'))) + ')');

  sA.emit('battle:answer', { questionId: q0.id, fieldIndex: 0, value: 'late' });
  const e2 = await waitFor(sA, 'error', () => true, 3000).catch(() => null);
  log('post-submit answer ->', e2 ? 'rejected: ' + e2.code : 'NO ERROR (bug)');
  sB2.emit('battle:submit', {});
  const fin = await waitFor(sA, 'battle:finished');
  log('FINISHED winner', fin.winnerUserId, 'results', JSON.stringify(fin.results.map(r => [r.userId, r.correctCount, r.score])), 'details', fin.details ? fin.details.length : 'none');

  // ---- 해설: 채점이 끝난 battle:finished 에서만 나간다 (전 문항 키 존재, 값은 집필 진행에 따라 빈 문자열일 수 있다)
  check(fin.explanations && typeof fin.explanations === 'object',
    'battle:finished 에 최상위 explanations 맵이 있다: ' + typeof fin.explanations);
  const exKeys = Object.keys(fin.explanations || {});
  check(exKeys.length === qs.questions.length && qs.questions.every(q => q.id in fin.explanations),
    'explanations 는 출제 전 문항 id 를 키로 갖는다 (' + exKeys.length + '/' + qs.questions.length + ')');
  check(exKeys.every(k => typeof fin.explanations[k] === 'string'),
    'explanations 값은 전부 문자열이다');
  // 해설 데이터가 이미 집필됐다면 실제로 실려 나오는지까지 본다(집필 전에는 건너뛴다).
  const EXPLAIN_2026_2 = path.join(ROOT, 'data', 'explanations', '2026-2.json');
  if (fs.existsSync(EXPLAIN_2026_2)) {
    const wrote = JSON.parse(fs.readFileSync(EXPLAIN_2026_2, 'utf8')).explanations || {};
    const someQid = qs.questions.map(q => q.id).find(id => typeof wrote[id] === 'string' && wrote[id] !== '');
    check(!!someQid && fin.explanations[someQid] === wrote[someQid],
      'battle:finished 가 data/explanations/2026-2.json 의 해설을 그대로 싣는다 (' + someQid + ')');
  } else {
    log('SKIP', 'data/explanations/2026-2.json 미작성 — 해설 실체 검사 건너뜀');
  }
  // ---- 상대 답안: 종료 전에는 어디에도 없고, battle:finished 에만 전원 답안·정오 맵이 실린다
  const noLeak = s => s.__answerLeaks.length === 0;
  check(noLeak(sA) && noLeak(sB2),
    '종료 전 어떤 페이로드에도 answersByUser/marksByUser 가 없다 (A ' +
    JSON.stringify(sA.__answerLeaks) + ' / B2 ' + JSON.stringify(sB2.__answerLeaks) + ')');
  check(!!fin.answersByUser && !!fin.marksByUser,
    'battle:finished 에 answersByUser·marksByUser 가 있다: ' + JSON.stringify(Object.keys(fin)));
  const ids = [a.json.user.id, b.json.user.id];
  check(ids.every(id => fin.answersByUser[id] && fin.marksByUser[id]),
    '두 맵이 참가자 전원(' + ids.join(',') + ')을 덮는다: ' + JSON.stringify(Object.keys(fin.answersByUser)));
  check(ids.every(id => qs.questions.every(q => Array.isArray(fin.answersByUser[id][q.id]) &&
      fin.answersByUser[id][q.id].length === q.fields.length)),
    'answersByUser 는 전 문항 × 전 필드 배열이다 (미입력은 빈 문자열)');
  check(ids.every(id => qs.questions.every(q => typeof fin.marksByUser[id][q.id] === 'boolean')),
    'marksByUser 는 전 문항의 정오 불리언이다');
  // A 가 받은 맵에서 상대(B)가 실제로 친 값이 그대로 보인다
  check(fin.answersByUser[b.json.user.id][q0.id][0] === 'B-typed-this',
    'A 의 결과 페이로드에 상대 B 가 입력한 값이 그대로 실린다: ' +
    JSON.stringify(fin.answersByUser[b.json.user.id][q0.id]));
  check(fin.answersByUser[a.json.user.id][q1.id][0] === 'y',
    '내 답안도 같은 맵에 들어 있다: ' + JSON.stringify(fin.answersByUser[a.json.user.id][q1.id]));

  await sleep(300);
  const marksCount = s => s.__seen.filter(e => e === 'battle:marks').length;
  check(marksCount(sA) === 1, '종료 이벤트에는 marks 를 내지 않는다 — A 의 battle:marks 누계 1건 (실제 ' + marksCount(sA) + ')');
  check(marksCount(sB2) === 0, 'B 는 마지막 제출자였으므로 marks 를 한 건도 받지 않는다 (실제 ' + marksCount(sB2) + ')');
  // ---- 전적: 방금 끝난 매치 1건이 랭킹에 그대로 반영되는가 (1등 +3, 그 외 참가 +1 — ranking.js)
  const rank = await req('GET', '/api/ranking', null, a.cookie);
  const rowOf = id => (rank.json || []).find(r => r.userId === id);
  const rA = rowOf(a.json.user.id), rB = rowOf(b.json.user.id);
  log('ranking:', JSON.stringify([rA, rB].map(r => r && [r.nickname, r.wins, r.draws, r.losses, r.points, r.played])));
  check(!!rA && !!rB, '/api/ranking 에 두 사용자가 모두 실린다');
  check(rA.played === 1 && rB.played === 1, '둘 다 참가 1건으로 잡힌다 (A ' + rA.played + ' / B ' + rB.played + ')');
  // 승자는 결과 페이로드가 이미 정했다 — 여기서 다시 계산하지 않고 그 값과의 정합만 본다.
  const winner = fin.winnerUserId;
  check(winner === a.json.user.id,
    '첫 대전은 정답 수 동률 + 먼저 제출한 A 의 승리다 (winnerUserId ' + winner + ', A ' + a.json.user.id + ')');
  const won = rowOf(winner), lost = rowOf(winner === a.json.user.id ? b.json.user.id : a.json.user.id);
  check(won.wins === 1 && won.draws === 0 && won.losses === 0,
    '승자 행: 1승 0무 0패 (실제 ' + [won.wins, won.draws, won.losses].join('/') + ')');
  check(lost.wins === 0 && lost.draws === 0 && lost.losses === 1,
    '패자 행: 0승 0무 1패 (실제 ' + [lost.wins, lost.draws, lost.losses].join('/') + ')');
  check(won.points === 3, '승자 승점 = 3 (실제 ' + won.points + ')');
  check(lost.points === 1, '패자 승점 = 참가 1점 (실제 ' + lost.points + ')');
  check(won.rank < lost.rank, '승점이 높은 승자가 더 앞 순위 (승자 ' + won.rank + ' vs 패자 ' + lost.rank + ')');

  // ---------------------------------------------- 이탈 = 즉시 제출 간주 (별도 방)
  // 규칙(PROTOCOL "playing → finished 트리거"): playing 중 room:leave 는 보관 답안 그대로
  // 즉시 제출로 확정되고 재입장이 없다. 이탈만으로 전원 제출이 완성되면 그 자리에서 finished.
  const bid = b.json.user.id;
  const room2 = await req('POST', '/api/rooms', { name: 'e2e-leave', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 }, a.cookie);
  const rid2 = room2.json.roomId;
  log('leave scenario: room', rid2, 'status', room2.status);
  sA.emit('room:join', { roomId: rid2 });
  await waitFor(sA, 'room:state', p => p.players.length === 1);
  sB2.emit('room:join', { roomId: rid2 });
  await waitFor(sA, 'room:state', p => p.players.length === 2);
  sA.emit('room:start', {});
  const qs2 = await waitFor(sA, 'battle:questions');
  sA.emit('battle:answer', { questionId: qs2.questions[0].id, fieldIndex: 0, value: 'a-typed' });
  sB2.emit('battle:answer', { questionId: qs2.questions[0].id, fieldIndex: 0, value: 'b-typed' });
  await sleep(600); // answer progress 디바운스(400ms)를 흘려보낸 뒤 이탈 방송을 본다

  // A 쪽 리스너를 먼저 걸고 B 가 이탈한다 (두 방송이 연달아 오므로 순차 await 하면 놓친다)
  const pLeaveProg = waitFor(sA, 'battle:progress', p => p.userId === bid && p.submitted === true, 5000);
  const pLeaveState = waitFor(sA, 'room:state', p => (p.players.find(x => x.userId === bid) || {}).left === true, 5000);
  const pLeaveMarks = waitFor(sB2, 'battle:marks', () => true, 5000); // 이탈=제출 → 이탈자도 제출자다
  sB2.emit('room:leave');
  const lprog = await pLeaveProg;
  const lstate = await pLeaveState;
  const lmarks = await pLeaveMarks;
  check(lmarks.players.length === 1 && lmarks.players[0].userId === bid,
    'B 이탈(=제출) → B 에게 battle:marks 1건: ' + JSON.stringify(lmarks.players.map(p => [p.userId, p.nickname])));
  check(marksCount(sA) === 1, '미제출자 A 는 이 시점에도 marks 를 받지 않는다 (누계 ' + marksCount(sA) + '건)');
  check(lprog.submitted === true, 'B 이탈 → A 가 battle:progress{submitted:true} 수신 ' + JSON.stringify(lprog));
  check((lstate.players.find(x => x.userId === bid) || {}).left === true, 'B 이탈 → room:state 에서 left=true');
  check(lstate.state === 'playing', '남은 A 가 미제출이라 아직 playing');

  // A 가 제출하면 이탈자 B 가 제출자로 세어져 그 자리에서 종료된다 (deadline 대기 없음)
  const pFin2 = waitFor(sA, 'battle:finished', () => true, 5000);
  sA.emit('battle:submit', {});
  const fin2 = await pFin2;
  log('leave scenario FINISHED reason', fin2.reason, 'winner', fin2.winnerUserId, JSON.stringify(fin2.results.map(r => [r.userId, r.submittedAt, r.left])));
  check(fin2.reason === 'allSubmitted', 'deadline 을 기다리지 않고 reason=allSubmitted 로 종료');
  const bRow = fin2.results.find(r => r.userId === bid);
  check(!!bRow && bRow.submittedAt != null, '이탈자 B 의 submittedAt 이 이탈 시각으로 기록됨: ' + (bRow && bRow.submittedAt));
  check(!!bRow && bRow.left === true, '이탈자 B 의 left=true');
  check(marksCount(sA) === 1 && marksCount(sB2) === 1,
    '종료 이벤트에는 marks 없음 — 누계 A ' + marksCount(sA) + '건 / B2 ' + marksCount(sB2) + '건');
  check(!!fin2.answersByUser && fin2.answersByUser[bid][qs2.questions[0].id][0] === 'b-typed',
    '이탈로 끝난 대전의 battle:finished 에도 이탈자 B 의 답안이 실린다: ' +
    JSON.stringify(fin2.answersByUser && fin2.answersByUser[bid][qs2.questions[0].id]));
  check(!!fin2.marksByUser && typeof fin2.marksByUser[bid][qs2.questions[0].id] === 'boolean',
    'marksByUser 도 함께 실린다');
  check(noLeak(sA) && noLeak(sB2),
    '이탈 시나리오 전 구간에서도 종료 전 답안 누출 0건 (A ' +
    JSON.stringify(sA.__answerLeaks) + ' / B2 ' + JSON.stringify(sB2.__answerLeaks) + ')');

  // ------------------------------- 대전 → 오답노트: 종료된 매치가 study_results(round=battle) 로 남는가
  await sleep(300); // persist 는 종료 방송과 같은 틱이지만 파일/WAL 반영 여유를 준다
  const study = readStudyResults();
  const battleRows = study.filter(r => r.round === 'battle');
  log('study_results(battle):', JSON.stringify(battleRows.map(r => [r.user_id, r.score, JSON.parse(r.question_ids).length, JSON.parse(r.wrong_ids).length])));
  check(battleRows.length === 4, '종료된 매치 2건 × 참가자 2명 = study_results 4행 (실제 ' + battleRows.length + '행)');
  check(new Set(battleRows.map(r => r.user_id)).size === 2, 'A·B 두 사용자 모두 기록된다');
  check(battleRows.every(r => Array.isArray(JSON.parse(r.question_ids)) && JSON.parse(r.question_ids).length > 0),
    '모든 행이 출제 문항 id 배열을 갖는다');
  check(battleRows.every(r => Array.isArray(JSON.parse(r.wrong_ids))), '모든 행이 오답 문항 id 배열을 갖는다');
  check(study.length === battleRows.length, '대전 외 학습 기록은 만들지 않는다 (총 ' + study.length + '행)');
  const hist = await req('GET', '/api/me/history', null, a.cookie);
  log('GET /api/me/history ->', JSON.stringify({ battle: hist.json.rounds.battle, wrongCount: hist.json.wrongCount }));
  check(!!hist.json.rounds.battle && hist.json.rounds.battle.count === 2,
    '/api/me/history 가 대전 2건을 집계한다: ' + JSON.stringify(hist.json.rounds.battle));
  check(hist.json.recent.some(r => r.round === 'battle' && r.total > 0),
    '/api/me/history recent 에 round=battle 이 total 과 함께 실린다');
  const wrongNote = await req('GET', '/api/me/wrong', null, a.cookie);
  check(wrongNote.json.questions.length === hist.json.wrongCount && wrongNote.json.questions.length > 0,
    '/api/me/wrong 이 대전 오답을 문항으로 돌려준다 (' + wrongNote.json.questions.length + '문항)');
  check(wrongNote.json.questions.every(q => !q.accept && !q.display && q.fields.every(f => !f.accept && !f.validator)),
    '오답노트 문항에도 정답 계열 필드는 없다');

  // ---- 오답노트 허브: 방금 끝난 대전이 방 이름과 함께 byBattle 에 잡히는가 (B = 두 번째 방의 패자/이탈자)
  const bStudy = readStudyResults().filter(r => r.round === 'battle' && r.user_id === bid);
  check(bStudy.every(r => r.match_id != null),
    'saveMatch 가 모든 battle 학습 기록에 match_id 를 남긴다: ' + JSON.stringify(bStudy.map(r => [r.id, r.match_id])));
  const summary = await req('GET', '/api/me/wrong/summary', null, b.cookie);
  check(summary.status === 200, 'GET /api/me/wrong/summary 200 (실제 ' + summary.status + ')');
  log('summary:', JSON.stringify({
    total: summary.json.total,
    byRound: summary.json.byRound.length,
    byBattle: summary.json.byBattle.map(x => [x.matchId, x.roomName, x.result, x.wrongCount, x.stillWrongCount]),
  }));
  check(summary.json.byBattle.length === 2, 'byBattle 에 참가한 대전 2건이 실린다 (실제 ' + summary.json.byBattle.length + '건)');
  const leaveCard = summary.json.byBattle.find(x => x.roomName === 'e2e-leave');
  check(!!leaveCard, 'byBattle 에 방금 끝난 방 이름 e2e-leave 가 있다: ' +
    JSON.stringify(summary.json.byBattle.map(x => x.roomName)));
  const bLeaveRow = bStudy.find(r => Number(r.match_id) === leaveCard.matchId);
  check(!!bLeaveRow,
    'byBattle 의 matchId 로 study_results 행을 되짚을 수 있다: ' + leaveCard.matchId +
    ' (있는 값 ' + JSON.stringify(bStudy.map(r => r.match_id)) + ')');
  check(leaveCard.wrongCount === JSON.parse(bLeaveRow.wrong_ids).length,
    'B 의 wrongCount 가 그 대전 행의 wrong_ids 수와 같다 (' + leaveCard.wrongCount + '문항)');
  check(leaveCard.wrongQuestions.length === leaveCard.wrongCount &&
    leaveCard.wrongQuestions.every(q => q.stillWrong === true),
    '틀린 문항이 전부 "지금도 오답"으로 실린다 (stillWrong ' + leaveCard.stillWrongCount + '/' + leaveCard.wrongCount + ')');
  check(!/accept|sampleAnswer|"display"|explanationHtml/.test(JSON.stringify(summary.json)),
    '요약 응답 어디에도 정답 계열 필드·해설은 없다');
  check(leaveCard.opponents.length === 1 && leaveCard.opponents[0].nickname === uA,
    'opponents 에 상대 닉네임이 실린다: ' + JSON.stringify(leaveCard.opponents));

  // 그 대전만 다시 풀기 — 남의 매치 id 는 404 여야 한다
  const byMatch = await req('GET', '/api/me/wrong?match=' + leaveCard.matchId, null, b.cookie);
  check(byMatch.status === 200 && byMatch.json.questions.length === leaveCard.wrongCount,
    'GET /api/me/wrong?match= 이 그 대전의 오답 ' + leaveCard.wrongCount + '문항을 돌려준다 (' + byMatch.status + ')');
  check(byMatch.json.title === '오답노트 · 대전 e2e-leave', 'title 에 방 이름이 들어간다: ' + byMatch.json.title);
  const notMine = await req('GET', '/api/me/wrong?match=999999', null, b.cookie);
  check(notMine.status === 404, '내 대전이 아닌 id 는 404 (실제 ' + notMine.status + ')');
  const badMatch = await req('GET', '/api/me/wrong?match=abc', null, b.cookie);
  check(badMatch.status === 400, '정수가 아닌 match 값은 400 (실제 ' + badMatch.status + ')');
  const histB = await req('GET', '/api/me/history', null, b.cookie);
  check(histB.json.recent.some(r => r.round === 'battle' && r.roomName === 'e2e-leave'),
    '/api/me/history recent 의 대전 행에 roomName 이 실린다: ' +
    JSON.stringify(histB.json.recent.filter(r => r.round === 'battle').map(r => [r.matchId, r.roomName])));

  // B 가 새 소켓으로 돌아와도 재입장은 없다 — 멤버십이 없으니 resync 도 없고, 방은 이미 파기됐다
  const sB3 = await sock(b.cookie, 'B3');
  await sleep(800);
  check(!sB3.__seen.includes('battle:resync'), '이탈 후 새 소켓에 battle:resync 가 오지 않는다 (수신: ' + JSON.stringify(sB3.__seen) + ')');
  const pNoRoom = waitFor(sB3, 'error', () => true, 3000).catch(() => null);
  sB3.emit('room:join', { roomId: rid2 });
  const joinErr = await pNoRoom;
  check(!!joinErr && joinErr.code === 'NO_ROOM', '종료된 방으로의 room:join 은 NO_ROOM: ' + JSON.stringify(joinErr));

  // ---------------------------------------------- 방 코드 참여 + 재대전 초대 (A3/C1, feat-battle)
  // 이 시점의 살아 있는 B 소켓은 sB3 다 — 위에서 새 소켓(B3)이 붙으며 SESSION_REPLACED 로 B2 가 끊겼다.
  // PROTOCOL "동일 유저 다중 탭: 최신 소켓만 유효, 이전 강제 종료" 를 여기서 실제로 단언한다.
  check(sB2.__errors.some(e => e && e.code === 'SESSION_REPLACED'),
    '같은 계정이 새 소켓(B3)으로 붙으면 옛 소켓 B2 가 SESSION_REPLACED 를 받는다: ' +
    JSON.stringify(sB2.__errors.map(e => e && e.code)));
  check(sB2.connected === false, '그리고 B2 는 서버가 끊어 실제로 연결이 닫혀 있다 (connected=' + sB2.connected + ')');
  check(sB3.connected === true && !sB3.__errors.some(e => e && e.code === 'SESSION_REPLACED'),
    '새 소켓 B3 은 살아 있고 SESSION_REPLACED 를 받지 않는다');
  log('room-code join + invite scenario start');
  const pInvite = waitFor(sB3, 'room:invite', () => true, 3000);
  const room3 = await req('POST', '/api/rooms',
    { name: 'e2e-invite', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600, inviteUserIds: [bid] }, a.cookie);
  log('POST /api/rooms (inviteUserIds) ->', room3.status, JSON.stringify(room3.json));
  const invite = await pInvite;
  check(invite.roomId === room3.json.roomId, 'room:invite roomId 가 생성된 방과 일치: ' + invite.roomId);
  check(invite.fromNickname === uA, 'room:invite fromNickname 이 초대자 닉네임: ' + invite.fromNickname);
  check(!!invite.settings && invite.settings.mode === 'round', 'room:invite settings.mode 전달: ' + JSON.stringify(invite.settings));

  // 소문자/오타 코드는 NO_ROOM (서버는 대소문자 그대로 정확히 매칭 — 클라이언트가 대문자로 정규화해 보내는 이유)
  let wrongCode = room3.json.roomId.toLowerCase();
  if (wrongCode === room3.json.roomId) wrongCode = 'zzzzzz'; // 코드가 전부 숫자인 극히 드문 경우 대비
  const badJoin = waitFor(sB3, 'error', () => true, 3000).catch(() => null);
  sB3.emit('room:join', { roomId: wrongCode });
  const badErr = await badJoin;
  check(!!badErr && badErr.code === 'NO_ROOM', '소문자/오타 방 코드는 NO_ROOM: ' + JSON.stringify(badErr));

  const goodJoin = waitFor(sB3, 'room:state', p => p.players.length >= 1, 3000);
  sB3.emit('room:join', { roomId: room3.json.roomId });
  const goodState = await goodJoin;
  check(goodState.settings.roomId === room3.json.roomId, '올바른 방 코드로 room:join -> room:state 수신');
  check(goodState.settings.type === null, '유형 미지정 방은 settings.type === null (전체): ' + JSON.stringify(goodState.settings.type));

  // ---------------------------------------------- 유형 필터 방 (feat-question-types)
  // 방 생성 시 1회만 적용되고 settings.type 으로 보존된다 — 양쪽이 같은 문항을 봐야 하기 때문이다.
  log('type filter scenario start');
  const badType = await req('POST', '/api/rooms',
    { name: 'x', mode: 'round', roundIds: ['2026-2'], type: 'nope', timeLimitS: 600 }, a.cookie);
  check(badType.status === 400, '잘못된 type 은 400: ' + badType.status + ' ' + JSON.stringify(badType.json));

  const roundsMeta = await req('GET', '/api/rounds', null, a.cookie);
  const meta = roundsMeta.json.find(r => r.round === '2026-2');
  check(!!meta && !!meta.counts && meta.counts.code + meta.counts.sql + meta.counts.theory === meta.questionCount,
    'GET /api/rounds 의 counts 합계 == questionCount: ' + JSON.stringify(meta && meta.counts));

  const room4 = await req('POST', '/api/rooms',
    { name: 'e2e-code', mode: 'round', roundIds: ['2026-2'], type: 'code', timeLimitS: 600 }, a.cookie);
  check(room4.status === 200, 'type=code 방 생성: ' + room4.status + ' ' + JSON.stringify(room4.json));
  const rid4 = room4.json.roomId;

  // 목록은 참가자가 1명 이상인 waiting 방만 싣는다 — 방장이 들어간 뒤에 조회한다.
  sA.emit('room:join', { roomId: rid4 });
  const st4 = await waitFor(sA, 'room:state', p => p.settings.roomId === rid4, 5000);
  check(st4.settings.type === 'code', 'room:state settings.type === "code": ' + JSON.stringify(st4.settings.type));

  const list4 = await req('GET', '/api/rooms', null, b.cookie);
  const row4 = list4.json.find(r => r.roomId === rid4);
  check(!!row4 && row4.type === 'code', 'GET /api/rooms 행에 type=code 가 실린다: ' + JSON.stringify(row4));
  check(!!row4 && row4.questionCount === meta.counts.code,
    '방 문항 수 == 그 회차 code 문항 수 (' + (row4 && row4.questionCount) + ' vs ' + meta.counts.code + ')');
  sB3.emit('room:join', { roomId: rid4 });
  await waitFor(sA, 'room:state', p => p.players.length === 2, 5000);
  sA.emit('room:start', {});
  const qs4 = await waitFor(sA, 'battle:questions', () => true, 10000);
  check(qs4.questions.length === meta.counts.code,
    'battle:questions 가 code 문항 수만큼 온다 (' + qs4.questions.length + '/' + meta.counts.code + ')');
  check(qs4.questions.every(q => q.type === 'code'),
    '출제된 전 문항이 type==="code": ' + JSON.stringify([...new Set(qs4.questions.map(q => q.type))]));
  check(qs4.questions.every(q => !q.accept && !q.sampleAnswer && !q.display),
    'type 이 붙어도 정답 계열 필드는 여전히 없다');
  check(!/explanationHtml|"explanations"/.test(JSON.stringify(qs4)),
    'type 필터 방의 battle:questions 에도 해설은 없다');

  // ---------------------------------------------- 언어 필터 방 (feat-code-lang, 계약 C4)
  // lang 은 코드 문항 전용이다 — type 은 생략하거나 'code' 여야 하고, 그 외 조합은 400 이다.
  // 유형과 마찬가지로 방 생성 시 1회만 적용되고 settings.lang 으로 보존된다.
  log('lang filter scenario start');
  // 두 소켓은 아직 유형 필터 방(playing)의 참가자다 — join 은 waiting 에서만 되므로 먼저 끝낸다.
  const pFin4 = waitFor(sA, 'battle:finished', () => true, 8000);
  sA.emit('battle:submit', {});
  sB3.emit('battle:submit', {});
  await pFin4;
  log('type filter room finished — sockets free for the lang scenario');

  const badLang = await req('POST', '/api/rooms',
    { name: 'x', mode: 'round', roundIds: ['2026-2'], type: 'sql', lang: 'java', timeLimitS: 600 }, a.cookie);
  check(badLang.status === 400,
    'type=sql + lang=java 조합은 400 (실제 ' + badLang.status + ' ' + JSON.stringify(badLang.json) + ')');
  const badLangValue = await req('POST', '/api/rooms',
    { name: 'x', mode: 'round', roundIds: ['2026-2'], type: 'code', lang: 'rust', timeLimitS: 600 }, a.cookie);
  check(badLangValue.status === 400,
    '허용값 밖의 lang 은 400 (실제 ' + badLangValue.status + ' ' + JSON.stringify(badLangValue.json) + ')');

  // 한 회차의 python 코드 문항은 5개에 못 미칠 수 있다 — 랜덤 모드로 전 회차를 풀에 넣는다.
  const LANG_COUNT = 5;
  const allRoundIds = roundsMeta.json.map(r => r.round);
  const room5 = await req('POST', '/api/rooms',
    { name: 'e2e-lang', mode: 'random', roundIds: allRoundIds, questionCount: LANG_COUNT, type: 'code', lang: 'python', timeLimitS: 600 },
    a.cookie);
  check(room5.status === 200,
    'type=code + lang=python 방 생성: ' + room5.status + ' ' + JSON.stringify(room5.json));
  const rid5 = room5.json.roomId;

  sA.emit('room:join', { roomId: rid5 });
  const st5 = await waitFor(sA, 'room:state', p => p.settings.roomId === rid5, 5000);
  check(st5.settings.type === 'code' && st5.settings.lang === 'python',
    'room:state settings 에 type=code · lang=python 이 실린다: ' +
    JSON.stringify({ type: st5.settings.type, lang: st5.settings.lang }));

  const list5 = await req('GET', '/api/rooms', null, b.cookie);
  const row5 = list5.json.find(r => r.roomId === rid5);
  check(!!row5 && row5.type === 'code' && row5.lang === 'python',
    'GET /api/rooms 행에 type=code · lang=python 이 실린다: ' + JSON.stringify(row5));

  sB3.emit('room:join', { roomId: rid5 });
  await waitFor(sA, 'room:state', p => p.players.length === 2, 5000);
  sA.emit('room:start', {});
  const qs5 = await waitFor(sA, 'battle:questions', () => true, 10000);
  check(qs5.questions.length === LANG_COUNT,
    'battle:questions 가 요청한 ' + LANG_COUNT + '문항을 준다 (실제 ' + qs5.questions.length + ')');
  check(qs5.questions.every(q => q.type === 'code'),
    '출제된 전 문항이 type==="code": ' + JSON.stringify([...new Set(qs5.questions.map(q => q.type))]));
  check(qs5.questions.every(q => q.lang === 'python'),
    '출제된 전 문항이 lang==="python": ' + JSON.stringify([...new Set(qs5.questions.map(q => q.lang))]));
  // lang 은 정답 정보가 아니지만(유형과 같은 취급) 정답 계열 필드는 여전히 한 톨도 없어야 한다.
  // `bodyText` 는 여기서 세지 않는다 — PROTOCOL "치팅 방어" 가 지문 평문을 battle:questions 에
  // **싣도록** 동결해 두었다(결과 화면 AI 질문 복사용). 정답 정보가 아니다.
  const ANSWER_FIELD_RE = /"accept"|sampleAnswer|"validator"|"display"|explanationHtml|"explanations"|sourceImages/;
  check(!ANSWER_FIELD_RE.test(JSON.stringify(qs5)),
    '언어 필터 방의 battle:questions 에 정답·해설 계열 필드가 없다 (accept/sampleAnswer/validator/display/explanationHtml/explanations/sourceImages)');
  check(qs5.questions.every(q => q.fields.every(f => Object.keys(f).length === 1 && 'label' in f)),
    'fields 는 여전히 {label} 만 남는다: ' + JSON.stringify(qs5.questions[0].fields));
  check(!ANSWER_FIELD_RE.test(JSON.stringify(st5)),
    '언어 필터 방의 room:state 에도 정답·해설 계열 필드가 없다');
  check(!ANSWER_FIELD_RE.test(JSON.stringify(list5.json)),
    'GET /api/rooms 응답에도 정답·해설 계열 필드가 없다');
  // 종료 전 상대 답안 누출 감시(소켓 생성 시부터 누적)는 이 시나리오까지 통틀어 0건이어야 한다.
  check(noLeak(sA) && noLeak(sB3),
    '언어 필터 시나리오까지 종료 전 answersByUser/marksByUser 누출 0건 (A ' +
    JSON.stringify(sA.__answerLeaks) + ' / B3 ' + JSON.stringify(sB3.__answerLeaks) + ')');

  // ---------------------------------------------- 타이머 3경로 (서버 M-14)
  //
  // deadline 종료 · abandon 유예 · 빈 방 GC 는 실제로는 각각 제한시간·60초·60초짜리라
  // 벽시계로는 e2e 에서 확인할 수 없다. `server/battle.js` 의 상수 백도어(BATTLE_*)를 넣은
  // **별도 서버**를 띄워 그 세 경로를 실제 소켓으로 통과시킨다.
  // 본 서버에 같은 env 를 넣으면 위 시나리오가 전부 2초짜리 대전이 되므로 서버를 나눈다.
  log('timer scenarios: spawning a second server with BATTLE_* overrides');
  const T = spawnServer({
    BATTLE_COUNTDOWN_MS: '200',      // 3s → 0.2s
    BATTLE_TIME_OVERRIDE_S: '2',     // 요청한 timeLimitS 를 무시하고 2초짜리 대전으로
    BATTLE_ABANDON_GRACE_MS: '1000', // 60s → 1s
    BATTLE_ROOM_GC_MS: '1000',       // 60s → 1s
  }, 'timers');
  extras.push(T);
  await T.ready;
  log('timer server up on', T.port);

  const tag = String(T0 % 100000);
  const tA = await req('POST', '/api/auth/signup', { nickname: 'e2eTA' + tag, password: 'pw12345678' }, null, T.base);
  const tB = await req('POST', '/api/auth/signup', { nickname: 'e2eTB' + tag, password: 'pw12345678' }, null, T.base);
  check(tA.status === 200 && tB.status === 200, '타이머 서버 가입 2건 (' + tA.status + '/' + tB.status + ')');
  const tAid = tA.json.user.id, tBid = tB.json.user.id;
  const sTA = await sock(tA.cookie, 'TA', T.base);
  const sTB = await sock(tB.cookie, 'TB', T.base);

  /** 두 사람이 방에 들어가 host 가 start 까지 누른 뒤 battle:questions 를 돌려준다. */
  async function playTogether(name) {
    const created = await req('POST', '/api/rooms',
      { name: name, mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 }, tA.cookie, T.base);
    check(created.status === 200, name + ' 방 생성 (' + created.status + ')');
    const id = created.json.roomId;
    sTA.emit('room:join', { roomId: id });
    await waitFor(sTA, 'room:state', p => p.settings.roomId === id && p.players.length === 1, 5000);
    sTB.emit('room:join', { roomId: id });
    await waitFor(sTA, 'room:state', p => p.players.length === 2, 5000);
    sTA.emit('room:start', {});
    const qs = await waitFor(sTA, 'battle:questions', () => true, 8000);
    return { roomId: id, questions: qs.questions };
  }

  // ---- (1) deadline 만료: 아무도 제출하지 않아도 마감이 대전을 끝낸다
  const d0 = Date.now();
  const t1 = await playTogether('t-deadline');
  const pDeadline = waitFor(sTA, 'battle:finished', () => true, 12000);
  sTA.emit('battle:answer', { questionId: t1.questions[0].id, fieldIndex: 0, value: 'deadline-typed' });
  const finD = await pDeadline;
  const elapsed = Date.now() - d0;
  log('deadline scenario finished in', elapsed + 'ms', 'reason', finD.reason);
  check(finD.reason === 'deadline', '아무도 제출하지 않으면 reason=deadline 으로 끝난다 (실제 ' + finD.reason + ')');
  check(elapsed < 8000,
    'BATTLE_TIME_OVERRIDE_S=2 가 먹어 timeLimitS=600 요청이 몇 초 만에 끝난다 (' + elapsed + 'ms)');
  check(finD.results.every(r => r.submittedAt == null),
    '마감 종료의 참가자는 전원 미제출로 남는다: ' + JSON.stringify(finD.results.map(r => [r.userId, r.submittedAt])));
  check(!!finD.answersByUser && !!finD.marksByUser &&
    finD.answersByUser[tAid][t1.questions[0].id][0] === 'deadline-typed',
    '마감 종료에도 두 맵이 실리고 미제출자의 보관 답안이 그대로 들어 있다');

  // ---- (2) abandon 유예: playing 중 전원이 끊기면 유예 뒤 방이 전적 없이 파기된다
  const t2 = await playTogether('t-abandon');
  sTA.disconnect(); sTB.disconnect();
  log('abandon scenario: both sockets disconnected, waiting the 1s grace');
  await sleep(1600);
  const sTA2 = await sock(tA.cookie, 'TA2', T.base);
  await sleep(300);
  check(!sTA2.__seen.includes('battle:resync'),
    '유예가 지난 뒤 돌아온 소켓에는 resync 가 없다 — 방이 이미 없다 (수신: ' + JSON.stringify(sTA2.__seen) + ')');
  const pAbandonErr = waitFor(sTA2, 'error', () => true, 3000).catch(() => null);
  sTA2.emit('room:join', { roomId: t2.roomId });
  const abandonErr = await pAbandonErr;
  check(!!abandonErr && abandonErr.code === 'NO_ROOM',
    'abandon 으로 파기된 방으로의 room:join 은 NO_ROOM: ' + JSON.stringify(abandonErr));
  const rankT = await req('GET', '/api/ranking', null, tA.cookie, T.base);
  const tRowA = (rankT.json || []).find(r => r.userId === tAid);
  check(!!tRowA && tRowA.played === 1,
    'abandoned 매치는 전적에 남지 않는다 — deadline 대전 1건만 집계 (played ' + (tRowA && tRowA.played) + ')');

  // ---- (3) 빈 waiting 방 GC: 아무도 들어가지 않은 방은 유예가 지나면 사라진다
  const t3 = await req('POST', '/api/rooms',
    { name: 't-gc', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 }, tA.cookie, T.base);
  check(t3.status === 200, 't-gc 방 생성 (' + t3.status + ')');
  await sleep(1600); // 소켓으로 아무도 들어가지 않는다 → 생성 시 걸린 roomGc 가 만료된다
  const pGcErr = waitFor(sTA2, 'error', () => true, 3000).catch(() => null);
  sTA2.emit('room:join', { roomId: t3.json.roomId });
  const gcErr = await pGcErr;
  check(!!gcErr && gcErr.code === 'NO_ROOM',
    '빈 waiting 방은 roomGc 유예가 지나면 사라진다 → NO_ROOM: ' + JSON.stringify(gcErr));
  // 대조군: 같은 서버 · 같은 소켓으로 방금 만든 방에는 곧바로 들어가진다(join 경로 자체는 멀쩡하다)
  const t4 = await req('POST', '/api/rooms',
    { name: 't-gc-control', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 }, tA.cookie, T.base);
  const pCtl = waitFor(sTA2, 'room:state', p => p.settings.roomId === t4.json.roomId, 3000);
  sTA2.emit('room:join', { roomId: t4.json.roomId });
  const ctl = await pCtl;
  check(ctl.settings.roomId === t4.json.roomId,
    '대조군: 유예 안에 들어간 방은 정상 입장된다 (' + ctl.settings.roomId + ')');
  sTA2.close();

  // ---- (4) production 잠금: 같은 env 를 넣어도 실서버 모드에서는 무시된다 (서버 M-13/M-14)
  log('production gate: BATTLE_* must be ignored under NODE_ENV=production');
  const P = spawnServer({ NODE_ENV: 'production', BATTLE_ROOM_GC_MS: '1000', BATTLE_TIME_OVERRIDE_S: '2' }, 'prod');
  extras.push(P);
  await P.ready;
  const pA = await req('POST', '/api/auth/signup', { nickname: 'e2ePA' + tag, password: 'pw12345678' }, null, P.base);
  const pRoom = await req('POST', '/api/rooms',
    { name: 'p-gc', mode: 'round', roundIds: ['2026-2'], timeLimitS: 600 }, pA.cookie, P.base);
  check(pRoom.status === 200, 'production 서버 방 생성 (' + pRoom.status + ')');
  await sleep(1600); // BATTLE_ROOM_GC_MS 가 먹었다면 이미 파기됐을 시간
  const sPA = await sock(pA.cookie, 'PA', P.base);
  const pProd = waitFor(sPA, 'room:state', p => p.settings.roomId === pRoom.json.roomId, 4000);
  sPA.emit('room:join', { roomId: pRoom.json.roomId });
  const prodState = await pProd;
  check(prodState.settings.roomId === pRoom.json.roomId,
    'NODE_ENV=production 이면 BATTLE_ROOM_GC_MS 백도어가 무시된다 — 1.6초 뒤에도 방이 살아 있다');
  check(prodState.settings.timeLimitS === 600,
    'BATTLE_TIME_OVERRIDE_S 도 무시된다 — 요청한 600초가 그대로다 (실제 ' +
    prodState.settings.timeLimitS + ')');
  sPA.close();

  sA.close(); sB2.close(); sB3.close();
  console.log(leak ? 'E2E FAIL (leak)' : 'E2E OK');
  shutdown(leak ? 1 : 0);
})().catch(e => {
  // 메시지가 빈 오류도 있다(happy-eyeballs 실패로 오는 AggregateError). 스택·원인까지 남긴다 —
  // "E2E ERROR" 한 줄만 찍히면 다음 사람이 아무것도 못 한다.
  console.error("E2E ERROR", (e && e.message) || e);
  if (e && e.stack) console.error(e.stack);
  if (e && Array.isArray(e.errors)) for (const sub of e.errors) console.error('  cause:', sub && sub.message);
  shutdown(1);
});
