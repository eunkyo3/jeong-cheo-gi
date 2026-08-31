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
const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = 'http://localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-e2e-'));
const T0 = Date.now();
const log = (...a) => console.log('[' + String(Date.now() - T0).padStart(5) + 'ms]', ...a);

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

const ready = new Promise((res, rej) => {
  const t = setInterval(() => {
    if (srvLog.includes('battle-io.js 연결 완료')) { clearInterval(t); res(); }
    else if (/EADDRINUSE|battle-io\.js 없음|로드 실패/.test(srvLog)) { clearInterval(t); rej(new Error('server: ' + srvLog)); }
  }, 100);
  setTimeout(() => { clearInterval(t); rej(new Error('server start timeout\n' + srvLog)); }, 15000);
});

function shutdown(code) {
  try { srv.kill(); } catch (_) { /* already gone */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(code);
}

function req(method, p, body, cookie) {
  return new Promise((res, rej) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (data) headers['content-length'] = data.length;
    if (cookie) headers.cookie = cookie;
    const r = http.request(BASE + p, { method, headers }, resp => {
      let s = '';
      resp.on('data', c => { s += c; });
      resp.on('end', () => res({ status: resp.statusCode, json: s ? JSON.parse(s) : null, cookie: (resp.headers['set-cookie'] || [])[0]?.split(';')[0] }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

const sock = (cookie, name) => new Promise((res, rej) => {
  const s = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
  // 연결 직후(서버 connect 핸들러)에서 날아오는 battle:resync 를 놓치지 않으려면
  // 리스너를 소켓 생성 시점에 붙여 두고 이름만 기록해 둔다.
  s.__seen = [];
  s.on('connect', () => { log(name, 'socket connected'); res(s); });
  s.on('connect_error', e => rej(new Error(name + ' connect_error: ' + e.message)));
  s.onAny((ev, p) => {
    s.__seen.push(ev);
    if (ev === 'battle:tick' || ev === 'battle:progress') return;
    const extra = ev === 'battle:questions' ? `(${p.questions.length} q)`
      : ev === 'room:state' ? p.state + ' ' + p.players.map(x => x.nickname + (x.connected ? '' : '(x)')).join(',')
      : ev === 'error' ? JSON.stringify(p) : '';
    log(name, '<-', ev, extra);
  });
});

const waitFor = (s, ev, pred = () => true, ms = 15000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting ' + ev)), ms);
  s.on(ev, p => { if (pred(p)) { clearTimeout(t); res(p); } });
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
  await ready; log("server up on", PORT, "DATA_DIR", TMP);
  const uA = 'e2eA' + (T0 % 10000), uB = 'e2eB' + (T0 % 10000);
  const a = await req('POST', '/api/auth/signup', { nickname: uA, password: 'pw1234' });
  const b = await req('POST', '/api/auth/signup', { nickname: uB, password: 'pw1234' });
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
  await sleep(300);
  const marksCount = s => s.__seen.filter(e => e === 'battle:marks').length;
  check(marksCount(sA) === 1, '종료 이벤트에는 marks 를 내지 않는다 — A 의 battle:marks 누계 1건 (실제 ' + marksCount(sA) + ')');
  check(marksCount(sB2) === 0, 'B 는 마지막 제출자였으므로 marks 를 한 건도 받지 않는다 (실제 ' + marksCount(sB2) + ')');
  const rank = await req('GET', '/api/ranking', null, a.cookie);
  log('ranking:', JSON.stringify(rank.json.filter(r => [a.json.user.id, b.json.user.id].includes(r.userId)).map(r => [r.nickname, r.wins, r.draws, r.losses, r.points])));

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

  sA.close(); sB2.close(); sB3.close();
  console.log(leak ? 'E2E FAIL (leak)' : 'E2E OK');
  shutdown(leak ? 1 : 0);
})().catch(e => { console.error("E2E ERROR", e.message); shutdown(1); });
