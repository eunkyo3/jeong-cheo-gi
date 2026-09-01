#!/usr/bin/env node
// headless-study.js — 학습 모드 프런트를 jsdom 으로 실서버에 붙여 종단 검증한다 (브라우저 없이).
// 격리 임시 DATA_DIR + 임의 포트. 검증 항목: 메인 회차 버튼 수 / 풀이→채점 점수 / 오답 카드의 AI 복사 버튼 →
// 클립보드 3단 폴백의 최종 단계(모달) 진입 + 프롬프트 4요소 / 인라인 이의 제기 → reports.json 적재 /
// 답안 자동 저장·복원 / Enter→다음 칸 / 학습 이력 카드·회차 뱃지 / 오답노트 + 허브(wrong.html) / 랜덤 모의고사 / favicon /
// 가입→me→로그아웃 / 문항 유형 필터(코드·SQL·이론) — 유형 뱃지·필터 칩·부분집합 채점·메인 유형 구성.
//   npm run headless
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('vm');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3000 + Math.floor(Math.random() * 20000);
const BASE = 'http://localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jpk-headless-'));
const T0 = Date.now();
const log = (...a) => console.log('[' + String(Date.now() - T0).padStart(5) + 'ms]', ...a);
let failures = 0;
const check = (cond, label, detail) => { log((cond ? 'PASS ' : 'FAIL ') + label + (detail !== undefined ? ' — ' + detail : '')); if (!cond) failures++; };

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP }, stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
const ready = new Promise((res, rej) => {
  const t = setInterval(() => { if (srvLog.includes('battle-io.js 연결 완료')) { clearInterval(t); res(); } }, 100);
  setTimeout(() => { clearInterval(t); rej(new Error('server start timeout\n' + srvLog)); }, 15000);
});
function shutdown(code) {
  try { srv.kill(); } catch (_) { /* gone */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  process.exit(code);
}

// ---- 쿠키 항아리 + fetch 폴리필 (jsdom 에는 fetch 가 없다) ----
const jar = new Map();
function cookieHeader() { return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; '); }
function absorb(resp) {
  const sc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const line of sc) {
    const [kv, ...attrs] = line.split(';');
    const [k, v] = kv.split('=');
    const maxAge = attrs.map(a => a.trim()).find(a => /^max-age=/i.test(a));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(k.trim()); else jar.set(k.trim(), v);
  }
}
function makeFetch() {
  return async function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE).href;
    const headers = Object.assign({}, (init && init.headers) || {});
    if (jar.size) headers.cookie = cookieHeader();
    const resp = await fetch(url, Object.assign({}, init, { headers }));
    absorb(resp);
    return resp;
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout: ' + label);
}

// jsdom 인스턴스끼리 localStorage 를 공유하지 않는다. "새로고침" 을 흉내 내려면
// 스크립트가 돌기 전(beforeParse) 에 저장분을 심어 줘야 한다.
async function load(p, beforeParse) {
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', e => errors.push(String(e.message || e)));
  vc.on('error', m => errors.push(String(m)));
  const opts = { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc };
  // jsdom 에는 window.confirm 이 없다(부르면 "not implemented" 를 던지고 undefined 를 돌려준다).
  // 학습·대전의 "미입력 문항 확인" 이 검사 흐름을 막지 않도록 언제나 "그대로 제출" 로 답하게 심는다.
  opts.beforeParse = function (win) {
    win.confirm = function () { return true; };
    if (beforeParse) beforeParse(win);
  };
  const dom = await JSDOM.fromURL(BASE + p, opts);
  dom.window.fetch = makeFetch();
  dom.errors = errors;
  await new Promise(r => { if (dom.window.document.readyState === 'complete') r(); else dom.window.addEventListener('load', r); });
  return dom;
}

const readStore = (win, key) => { try { return win.localStorage.getItem(key); } catch (_) { return undefined; } };

(async () => {
  await ready; log('server up on', PORT);

  // ---------- 0. 정적 자산 ----------
  const fav = await makeFetch()('/favicon.svg');
  check(fav.status === 200, 'favicon: GET /favicon.svg → 200', fav.status);

  // ---------- 0b. 보기 파서 단위 검사 (public/js/boki.js — 순수 함수라 DOM 없이 돈다) ----------
  // study/battle 이 같은 파서를 쓴다. 여기서 계약(parse/fillValue)과 실데이터 적중률을 함께 못 박는다.
  const bokiCtx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'boki.js'), 'utf8'), bokiCtx, { filename: 'boki.js' });
  const Boki = bokiCtx.Boki;
  check(!!Boki && typeof Boki.parse === 'function' && typeof Boki.fillValue === 'function',
    'boki: window.Boki = { parse, fillValue } 계약', Boki ? Object.keys(Boki).join(',') : '전역 없음');

  // 런타임(study.js/battle.js)은 `.boki` 엘리먼트의 innerHTML 을 파서에 넘긴다 —
  // 검사도 같은 길로 뽑는다 (정규식은 중첩 div 의 첫 </div> 에서 끊긴다).
  const bokiHost = new JSDOM('<!doctype html><body></body>').window.document.createElement('div');
  const bokiOf = (bodyHtml) => {
    bokiHost.innerHTML = bodyHtml || '';
    const node = bokiHost.querySelector('.boki');
    return node ? node.innerHTML : '';
  };
  const round262 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rounds', '2026-2.json'), 'utf8'));
  const q262_1 = (round262.questions || []).find(q => q.id === '2026-2#1');
  const items262 = Boki ? Boki.parse(bokiOf(q262_1 && q262_1.bodyHtml)) : [];
  check(items262.length === 4, 'boki: 2026-2#1 의 [보기] 가 4개 항목으로 파싱된다',
    items262.length + '개: ' + items262.map(i => i.marker).join('/'));
  check(items262.length === 4 && items262[0].marker === 'ㄱ' && items262[0].text === '동치분할 (Equivalence Partitioning)',
    'boki: 항목이 {marker, text} 로 갈린다 (괄호 영문까지 text)', JSON.stringify(items262[0] || null));
  check(!!Boki && Boki.fillValue(items262[0], q262_1 ? q262_1.prompt : '') === '동치분할 (Equivalence Partitioning)',
    'boki: prompt 에 "기호" 가 없으면 마커 뒤 본문을 채운다',
    JSON.stringify(Boki ? Boki.fillValue(items262[0], q262_1 ? q262_1.prompt : '') : null));
  check(!!Boki && Boki.fillValue(items262[0], '보기에서 골라 기호로 쓰시오.') === 'ㄱ',
    'boki: prompt 에 "기호" 가 있으면 마커만 채운다',
    JSON.stringify(Boki ? Boki.fillValue(items262[0], '보기에서 골라 기호로 쓰시오.') : null));
  // 서술형 지문은 보기가 아니다 — 잘못 잘라 칩을 만들면 안 된다.
  check(!!Boki && Boki.parse('한 객체의 상태가 바뀌면 다른 객체들이 자동으로 갱신되는 방법이다.').length === 0,
    'boki: 문장 지문은 파싱하지 않는다 (칩 없음)');

  // 실데이터 적중률 — 보기가 있는 문항 중 몇 개가 칩이 되는가.
  const roundsDir = path.join(ROOT, 'data', 'rounds');
  let bokiTotal = 0, bokiParsed = 0;
  for (const f of fs.readdirSync(roundsDir).filter(n => n.endsWith('.json'))) {
    for (const q of (JSON.parse(fs.readFileSync(path.join(roundsDir, f), 'utf8')).questions || [])) {
      const raw = bokiOf(q.bodyHtml);
      if (!raw) continue;
      bokiTotal++;
      if (Boki && Boki.parse(raw).length >= 2) bokiParsed++;
    }
  }
  check(bokiTotal >= 50 && bokiParsed >= 45,
    'boki: 보기 있는 문항의 파싱 적중률 (45 이상)', bokiParsed + ' / ' + bokiTotal);

  // ---------- 1. 메인 페이지: 회차 버튼 ----------
  const idx = await load('/');
  check(!!idx.window.document.querySelector('link[rel="icon"][href="/favicon.svg"]'), 'favicon: index.html <head> 에 link 태그');
  const roundsApi = await (await makeFetch()('/api/rounds')).json();
  const btns = await waitFor(() => { const a = [...idx.window.document.querySelectorAll('a[href*="study.html?round="], button[data-round]')]; return a.length >= roundsApi.length ? a : null; }, 'round buttons');
  check(btns.length === roundsApi.length, 'index: 회차 버튼 수 == /api/rounds', btns.length + ' / ' + roundsApi.length);
  check(roundsApi.length === 21, 'index: 21회차 전부 노출', roundsApi.length);
  check(idx.errors.length === 0, 'index: JS 오류 없음', idx.errors.slice(0, 2).join(' | '));

  // 랜덤 모의고사 카드 (B1) — 비로그인 상태에서도 보여야 한다
  const pStart = await waitFor(() => idx.window.document.querySelector('#practiceStart'), '랜덤 모의고사 시작 링크', 4000).catch(() => null);
  check(!!pStart && /set=practice/.test(pStart.getAttribute('href') || ''), 'index: 랜덤 모의고사 카드 + 시작 링크', pStart ? pStart.getAttribute('href') : '없음');
  check(/로그인하면 점수 이력과 오답노트가 저장됩니다/.test(idx.window.document.body.textContent), 'index: 비로그인 시 학습 이력 안내 한 줄');

  // 오답노트 허브 — 비로그인 상태 (서버 없이도 최소 렌더가 되어야 한다)
  const wnOut = await load('/wrong.html');
  await waitFor(() => /로그인이 필요합니다/.test(wnOut.window.document.body.textContent) ? true : null, '허브 로그인 안내', 5000).catch(() => null);
  check(/로그인이 필요합니다/.test(wnOut.window.document.body.textContent),
    'wronghub: 비로그인 접근 시 "로그인이 필요합니다" 안내',
    (wnOut.window.document.getElementById('wrongBody') || {}).textContent);
  check(!!wnOut.window.document.querySelector('#wrongBody a[href="/"]'),
    'wronghub: 비로그인 화면에 메인 링크');
  check(wnOut.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
    'wronghub: 비로그인 화면 JS 오류 없음', wnOut.errors.slice(0, 2).join(' | '));

  // 가입 → me → 로그아웃 (index 의 폼을 통해)
  const nick = 'hl' + (T0 % 100000);
  const nickInput = idx.window.document.querySelector('input[name="nickname"], #nickname');
  const pwInput = idx.window.document.querySelector('input[name="password"], #password, input[type="password"]');
  const signupBtn = [...idx.window.document.querySelectorAll('button')].find(b => /가입/.test(b.textContent));
  check(!!(nickInput && pwInput && signupBtn), 'index: 가입 폼 존재');
  check(/비밀번호는 복구할 수 없습니다/.test(idx.window.document.body.textContent), 'index: 비밀번호 복구 불가 안내 (D3)');

  let logoutBtn = null;
  if (nickInput && pwInput && signupBtn) {
    nickInput.value = nick; pwInput.value = 'pw1234';
    nickInput.dispatchEvent(new idx.window.Event('input', { bubbles: true }));
    pwInput.dispatchEvent(new idx.window.Event('input', { bubbles: true }));
    signupBtn.click();
    await waitFor(() => jar.size > 0, 'session cookie after signup');
    const me = await (await makeFetch()('/api/auth/me')).json();
    check(me.user && me.user.nickname === nick, 'auth: 가입 후 /api/auth/me 가 나를 반환', JSON.stringify(me.user));
    const shown = await waitFor(() => idx.window.document.body.textContent.includes(nick) ? true : null, 'nickname shown', 4000).catch(() => false);
    check(shown === true, 'index: 로그인 후 닉네임 표시');
    logoutBtn = await waitFor(() => [...idx.window.document.querySelectorAll('button')].find(b => /로그아웃/.test(b.textContent)) || null, 'logout button', 4000).catch(() => null);
    check(!!logoutBtn, 'index: 로그아웃 버튼 표시');

    // ---- 로그인 상태로 battle.html / ranking.html 회귀 테스트 (아직 로그아웃하지 않은 시점) ----
    // window.api.me() 는 user 를 직접(비로그인이면 null) 반환한다 — {user} 로 감싸지 않는다.
    // 이 계약이 깨지면 두 페이지 모두 항상 '/?msg=...' 로 리다이렉트된다.
    const bt = await load('/battle.html');
    await waitFor(() => {
      var el = bt.window.document.getElementById('view');
      return el && /새 대전방 만들기/.test(el.textContent) ? true : null;
    }, 'battle.html #view 렌더', 2000).catch(() => null);
    const btView = bt.window.document.getElementById('view');
    const btNavErr = bt.errors.some(e => /navigation/i.test(e));
    check(
      !btNavErr && !!btView && /새 대전방 만들기/.test(btView.textContent),
      'battle: 로그인 상태로 접근 시 리다이렉트 없이 로비가 렌더된다',
      btNavErr ? 'navigation 시도됨: ' + bt.errors.join(' | ') : (btView ? btView.textContent.slice(0, 40) : '#view 없음')
    );

    // ---- 방 만들기 폼의 문항 유형 선택 (전체/코드/SQL/이론) ----
    const btTypeChips = btView ? [...btView.querySelectorAll('.chip[data-type]')] : [];
    check(btTypeChips.length === 4
      && btTypeChips.map(c => c.textContent.trim()).join('/') === '전체/코드/SQL/이론',
      'battle: 방 만들기 폼에 문항 유형 선택 4개',
      btTypeChips.map(c => c.textContent.trim()).join('/') || '없음');

    const rkIn = await load('/ranking.html');
    await waitFor(() => {
      var el = rkIn.window.document.getElementById('view');
      return el && /아직 대전 기록이 없습니다|순위/.test(el.textContent) ? true : null;
    }, 'ranking.html #view 렌더', 2000).catch(() => null);
    const rkInView = rkIn.window.document.getElementById('view');
    const rkInNavErr = rkIn.errors.some(e => /navigation/i.test(e));
    check(
      !rkInNavErr && !!rkInView && /아직 대전 기록이 없습니다|순위/.test(rkInView.textContent),
      'ranking: 로그인 상태로 접근 시 리다이렉트 없이 랭킹 화면이 렌더된다',
      rkInNavErr ? 'navigation 시도됨: ' + rkIn.errors.join(' | ') : (rkInView ? rkInView.textContent.slice(0, 40) : '#view 없음')
    );

    // ---- index.html ?msg= 안내 표시 ----
    const msgPage = await load('/?msg=' + encodeURIComponent('대전은 로그인이 필요합니다.'));
    const msgShown = await waitFor(
      () => msgPage.window.document.body.textContent.includes('대전은 로그인이 필요합니다.') ? true : null,
      '?msg= 안내 문구 표시', 2000
    ).catch(() => false);
    check(msgShown === true, 'index: ?msg= 쿼리의 안내 문구가 화면에 표시된다');
  }

  // ---------- 2. 학습 페이지: 자동 저장 → 풀이 → 채점 ----------
  // 여기부터는 로그인 상태다 (학습 이력·오답노트가 쌓여야 뒤의 검사가 성립한다).
  const SKEY = 'jpk-study:2026-2';
  const st = await load('/study.html?round=2026-2');
  const w = st.window, d = w.document;
  const cards = await waitFor(() => { const c = d.querySelectorAll('.q'); return c.length === 20 ? c : null; }, '20 question cards');
  check(cards.length === 20, 'study: 문항 카드 20개');

  // ---- 요구 4: 문항 카드 우상단 회차 표기 ----
  const firstOrigin = cards[0].querySelector('.q-origin');
  check(!!firstOrigin && /2026년\s*2회/.test(firstOrigin.textContent),
    'study: 첫 문항 카드에 회차 뱃지 "2026년 2회" 표시', firstOrigin ? firstOrigin.textContent : '.q-origin 없음');
  check(/총\s*20\s*문항/.test(d.body.textContent) && /100\s*점/.test(d.body.textContent), 'study: 헤더 "총 20문항 · 100점 만점" 동적 표기');

  // ---- ①: 한 회차를 그대로 푸는 화면은 원본 문항 번호를 유지한다 (.num == 회차 뱃지의 "N번") ----
  const numMismatch = [...cards].filter(c => {
    const n = ((c.querySelector('.num') || {}).textContent || '').trim();
    const m = /·\s*(\d+)번/.exec((c.querySelector('.q-origin') || {}).textContent || '');
    return !m || m[1] !== n;
  });
  check(numMismatch.length === 0, 'seqnum: ?round= 화면은 원본 문항 번호 유지 (.num == 뱃지 번호)',
    numMismatch.length + '개 불일치');

  // ---- ③: 제출 버튼 옆 "답한 문항 n/N" — 입력 전 ----
  const answeredEl = d.getElementById('answeredCount');
  check(!!answeredEl && answeredEl.hidden === false && /답한 문항\s*0\/20/.test(answeredEl.textContent),
    'blankguard: 입력 전 제출 버튼 옆에 "답한 문항 0/20"',
    answeredEl ? JSON.stringify(answeredEl.textContent) + ' hidden=' + answeredEl.hidden : '#answeredCount 없음');
  check(!!answeredEl && !!answeredEl.closest('#btnbar'),
    'blankguard: 진행 표시가 제출 버튼과 같은 btnbar 안에 있다');
  // ---- 해설: 채점 전에는 버튼도 데이터도 없어야 한다 (PROTOCOL "채점 전 비노출") ----
  check(![...d.querySelectorAll('button')].some(b => /해설/.test(b.textContent)),
    'study: 채점 전 DOM 에 "해설" 버튼 없음');
  const roundRaw = await (await makeFetch()('/api/rounds/2026-2')).text();
  check(!/explanationHtml|"explanations"/.test(roundRaw),
    'study: GET /api/rounds/2026-2 응답에 해설 필드 없음');

  const inputs = d.querySelectorAll('input.ans');
  check(inputs.length === 26, 'study: 입력 필드 26개 (단일 17 + Q9 4 + Q10 3 + Q12 2)', inputs.length);

  // ---- B5: Enter → 다음 답안 칸 ----
  inputs[0].focus();
  inputs[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check(d.activeElement === inputs[1], 'study: Enter 로 다음 답안 칸으로 이동 (B5)',
    d.activeElement ? d.activeElement.id : '(없음)');
  // Shift+Enter 는 무시한다 — 포커스가 그대로 두 번째 칸에 남아 있어야 한다
  inputs[1].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
  check(d.activeElement === inputs[1], 'study: Shift+Enter 는 이동하지 않는다', d.activeElement ? d.activeElement.id : '(없음)');

  // ---- ⑥: 보기 칩 (지문의 [보기] → 입력칸 채우기) ----
  const bokiCard = [...cards].find(c => c.getAttribute('data-q') === '2026-2#1');
  const bokiRow = bokiCard ? bokiCard.querySelector('.boki-chips') : null;
  const bokiChips = bokiRow ? [...bokiRow.querySelectorAll('button')] : [];
  check(bokiChips.length === 4, 'boki: 2026-2#1 카드에 보기 칩 4개', bokiChips.length + '개');
  if (bokiCard) {
    const kids = [...bokiCard.children].map(n => n.className);
    const iChips = kids.findIndex(c => /boki-chips/.test(c));
    const iRow = kids.findIndex(c => /ansrow/.test(c));
    check(iChips >= 0 && iRow >= 0 && iChips < iRow, 'boki: 칩 줄이 답안 입력칸 바로 위에 온다', JSON.stringify(kids));
  }
  const noBokiCard = [...cards].find(c => c.getAttribute('data-q') === '2026-2#2');
  check(!!noBokiCard && !noBokiCard.querySelector('.boki-chips'),
    'boki: [보기] 가 없는 문항에는 칩을 만들지 않는다');
  if (bokiChips.length === 4) {
    bokiChips[0].click();
    await sleep(60);
    const bokiInput = bokiCard.querySelector('input.ans');
    check(bokiInput.value === '동치분할 (Equivalence Partitioning)',
      'boki: 칩을 누르면 첫 빈 칸에 보기 값이 채워진다', JSON.stringify(bokiInput.value));
    check(/답한 문항\s*1\/20/.test(answeredEl.textContent),
      'boki: 칩으로 채운 값이 input 이벤트로 "답한 문항" 에 반영된다', JSON.stringify(answeredEl.textContent));
    // 타이핑으로 고칠 수 있어야 한다 — readonly 로 잠기면 안 된다.
    check(bokiInput.readOnly === false, 'boki: 칩으로 채운 뒤에도 입력칸은 그대로 수정 가능');
  }

  // ---- ⑦: 하단 미니바 (#studyBar) ----
  // jsdom 은 레이아웃을 계산하지 않는다 — 제출 버튼의 좌표만 갈아 끼우고 scroll 을 직접 쏜다.
  // 판정(shouldShowBar) · rAF 스로틀 · 표시 토글은 study.js 의 실제 코드가 그대로 돈다.
  const bar = d.getElementById('studyBar');
  const submitEl = d.getElementById('submitBtn');
  const setSubmitRect = (top, bottom) => {
    submitEl.getBoundingClientRect = () => ({ top, bottom, left: 0, right: 200, width: 200, height: bottom - top, x: 0, y: top });
    w.dispatchEvent(new w.Event('scroll'));
  };
  check(!!bar && bar.hidden === true, 'studybar: 제출 버튼이 보이는 동안에는 미니바가 없다',
    bar ? 'hidden=' + bar.hidden : '#studyBar 없음');
  setSubmitRect(2000, 2040);   // 화면(innerHeight 768) 아래로 밀려난 상태
  const barOn = await waitFor(() => (bar && bar.hidden === false ? true : null), '미니바 표시', 2000).catch(() => null);
  check(barOn === true, 'studybar: 제출 버튼이 화면 밖이면 하단 미니바가 뜬다', bar ? 'hidden=' + bar.hidden : '없음');
  check(!!bar && /답한\s*1\/20/.test(bar.textContent), 'studybar: "답한 n/N" 표시',
    bar ? bar.textContent.replace(/\s+/g, ' ') : '');
  const barNext = d.getElementById('studyBarNext');
  const barSubmit = d.getElementById('studyBarSubmit');
  check(!!barNext && barNext.disabled === false && !!barSubmit,
    'studybar: "다음 빈칸으로" + "제출" 버튼', barNext ? 'next.disabled=' + barNext.disabled : '버튼 없음');
  if (barNext) {
    barNext.click();
    await sleep(60);
    const focused = d.activeElement;
    check(!!focused && focused.classList && focused.classList.contains('ans')
      && focused.value === '',
      'studybar: "다음 빈칸으로" 가 첫 번째 빈 칸으로 포커스를 옮긴다',
      focused ? focused.id + '=' + JSON.stringify(focused.value) : '(없음)');
  }
  setSubmitRect(100, 140);     // 제출 버튼이 다시 화면 안으로 들어오면
  const barOff = await waitFor(() => (bar && bar.hidden === true ? true : null), '미니바 숨김', 2000).catch(() => null);
  check(barOff === true, 'studybar: 제출 버튼이 보이면 다시 숨는다', bar ? 'hidden=' + bar.hidden : '없음');

  // ---- ⑬ + B3: 학습 타이머 (기본 접힘 → 토글로 펼친다) ----
  const timerToggle = d.getElementById('timerToggle');
  const timerPanel = d.getElementById('timerPanel');
  check(!!timerToggle && /타이머/.test(timerToggle.textContent) && !!timerPanel && timerPanel.hidden === true,
    'timer: 타이머 컨트롤은 기본 접힘 — 헤더에는 토글 버튼 하나 (⑬)',
    timerToggle ? JSON.stringify(timerToggle.textContent) + ' panel.hidden=' + (timerPanel && timerPanel.hidden) : '#timerToggle 없음');
  if (timerToggle) {
    timerToggle.click();
    await sleep(60);
  }
  check(!!timerPanel && timerPanel.hidden === false,
    'timer: 토글을 누르면 select+시작 이 펼쳐진다', timerPanel ? 'hidden=' + timerPanel.hidden : '없음');
  check(readStore(w, 'jpk-study:timerOpen') === '1',
    'timer: 펼침 상태가 localStorage["jpk-study:timerOpen"] 에 저장', String(readStore(w, 'jpk-study:timerOpen')));

  const timerSelect = d.getElementById('timerSelect');
  const timerBtn = d.getElementById('timerBtn');
  const timerOut = d.getElementById('timerOut');
  check(!!(timerSelect && timerBtn && timerOut), 'timer: 학습 타이머 컨트롤 존재 (B3)');
  if (timerSelect && timerBtn && timerOut) {
    check([...timerSelect.options].map(o => o.textContent).join('/') === '타이머 없음/30분/60분/90분',
      'timer: 선택지 4개 (없음/30/60/90)', [...timerSelect.options].map(o => o.textContent).join('/'));
    check(timerBtn.disabled === true, 'timer: "타이머 없음" 이면 시작 버튼 비활성');
    timerSelect.value = '30';
    timerSelect.dispatchEvent(new w.Event('change', { bubbles: true }));
    check(timerBtn.disabled === false, 'timer: 시간을 고르면 시작 버튼 활성');
    check(readStore(w, 'jpk-study:timer') === '30', 'timer: 고른 분이 localStorage["jpk-study:timer"] 에 저장', String(readStore(w, 'jpk-study:timer')));
    timerBtn.click();
    await sleep(80);
    check(timerOut.hidden === false && /^(30:00|29:5\d)$/.test(timerOut.textContent),
      'timer: 시작하면 mm:ss 카운트다운 표시', JSON.stringify(timerOut.textContent));
    check(timerBtn.textContent === '중지' && timerSelect.disabled === true,
      'timer: 진행 중에는 버튼이 "중지", 선택은 잠긴다', timerBtn.textContent);
    // ⑬: 도는 동안에는 접히지 않는다 — 남은 시간이 항상 보여야 한다.
    if (timerToggle) {
      timerToggle.click();
      await sleep(60);
      check(timerPanel.hidden === false && timerOut.hidden === false,
        'timer: 타이머가 도는 동안에는 접기가 먹지 않는다 (항상 펼침)',
        'panel.hidden=' + timerPanel.hidden + ' out.hidden=' + timerOut.hidden);
    }
  }

  const setAns = (qnum, fi, val) => { const card = [...cards].find(c => c.querySelector('.num') && c.querySelector('.num').textContent.trim() === String(qnum)); const inp = card.querySelectorAll('input.ans')[fi]; inp.value = val; inp.dispatchEvent(new w.Event('input', { bubbles: true })); };
  setAns(1, 0, 'ㄱ'); setAns(2, 0, '10a20b'); setAns(10, 0, '192.168.35.72'); setAns(10, 1, '129.200.8.249'); setAns(10, 2, '192.168.36.249'); setAns(15, 0, '509'); setAns(3, 0, 'ㄴ'); // Q3 오답

  // ---- ③: 입력하면 진행 표시가 곧바로 갱신된다 ----
  // 위에서 문항 1·2·3·15(한 칸)와 10(세 칸 전부)을 채웠다 → 5개.
  check(!!answeredEl && /답한 문항\s*5\/20/.test(answeredEl.textContent),
    'blankguard: 입력하면 "답한 문항 5/20" 으로 갱신',
    answeredEl ? JSON.stringify(answeredEl.textContent) : '#answeredCount 없음');

  // "답함" 은 **모든 칸이 차야** 성립한다 (대전·서버 집계와 같은 규칙).
  // Q12 는 두 칸짜리다 — 한 칸만 채우면 여전히 덜 푼 문항이다.
  setAns(12, 0, 'zzz1');
  check(!!answeredEl && /답한 문항\s*5\/20/.test(answeredEl.textContent),
    'blankguard: 두 칸짜리 문항의 한 칸만 채우면 아직 "답한 문항" 이 아니다 (5/20 유지)',
    answeredEl ? JSON.stringify(answeredEl.textContent) : '#answeredCount 없음');
  setAns(12, 1, 'zzz2');
  check(!!answeredEl && /답한 문항\s*6\/20/.test(answeredEl.textContent),
    'blankguard: 남은 칸까지 채우면 "답한 문항 6/20" 으로 늘어난다',
    answeredEl ? JSON.stringify(answeredEl.textContent) : '#answeredCount 없음');

  // ---- A2: 자동 저장 (디바운스 300ms) ----
  await sleep(500);
  const rawSaved = readStore(w, SKEY);
  check(!!rawSaved && rawSaved.includes('192.168.35.72'),
    'autosave: 입력 후 localStorage["' + SKEY + '"] 에 답안 저장',
    rawSaved === undefined ? 'localStorage 접근 불가' : String(rawSaved).slice(0, 90));

  // ---- A2: "새로고침" 후 복원 + 안내 배너 ----
  if (rawSaved) {
    const st2 = await load('/study.html?round=2026-2', win => {
      try { win.localStorage.setItem(SKEY, rawSaved); } catch (_) { /* 저장 불가 환경 */ }
    });
    const d2 = st2.window.document;
    await waitFor(() => d2.querySelectorAll('.q').length === 20 ? true : null, 'reload: 20 question cards');
    await sleep(150);
    const q10r = [...d2.querySelectorAll('.q')].find(c => c.querySelector('.num').textContent.trim() === '10');
    const restored = q10r ? q10r.querySelectorAll('input.ans')[0].value : '';
    check(restored === '192.168.35.72', 'autosave: 새로고침 후 입력값 복원', JSON.stringify(restored));
    const notice = d2.getElementById('restoreNotice');
    check(!!notice && notice.hidden === false && /이전에 입력하던 답안을 불러왔습니다/.test(notice.textContent),
      'autosave: 복원 안내 배너 표시', notice ? notice.textContent.slice(0, 60) : '#restoreNotice 없음');
  }

  const submit = [...d.querySelectorAll('button')].find(b => /제출하고 채점/.test(b.textContent));
  check(!!submit, 'study: 제출 버튼 존재');
  submit.click();
  await waitFor(() => d.querySelector('.q.correct, .q.wrong'), 'graded cards');
  await sleep(200);
  // 채점 시 render(state) 가 카드를 재생성하므로 이전 노드 참조는 무효 — 재조회
  const cardsAfter = d.querySelectorAll('.q');
  const inputsAfter = d.querySelectorAll('input.ans');
  const correct = d.querySelectorAll('.q.correct').length, wrong = d.querySelectorAll('.q.wrong').length;
  check(correct === 4 && wrong === 16, 'study: 정답 4 / 오답 16 카드 표시', correct + '/' + wrong);
  check(/20\s*점/.test(d.body.textContent), 'study: 점수 20점 표시 (4/20)', (d.body.textContent.match(/\d+\s*점\s*\/\s*100/) || [])[0]);
  const q3 = [...cardsAfter].find(c => c.querySelector('.num').textContent.trim() === '3');
  check(q3.classList.contains('wrong') && /내용결합도/.test(q3.textContent), 'study: 오답 카드에 display(정답) 노출', (q3.querySelector('.feedback') || {}).textContent);
  check(inputsAfter[0].readOnly === true || inputsAfter[0].disabled === true, 'study: 채점 후 입력 read-only/disabled');
  check(d.querySelectorAll('.boki-chips').length === 0, 'boki: 채점 후에는 보기 칩을 만들지 않는다',
    d.querySelectorAll('.boki-chips').length + '개 남음');
  check(!!bar && bar.hidden === true, 'studybar: 채점 후에는 미니바가 사라진다', bar ? 'hidden=' + bar.hidden : '없음');

  // ---- A5: 채점 후 상단 안내 갱신 ----
  const metaText = (d.getElementById('roundMeta') || {}).textContent || '';
  check(/채점 완료/.test(metaText) && /오답\s*16\s*문항/.test(metaText),
    'study: 채점 후 상단 안내가 "채점 완료 — 오답 N문항" 으로 갱신 (A5)', metaText.slice(0, 80));

  // ---- ⑤: 채점 후 점수판이 sticky 로 붙으면 한 줄(.compact)로 줄어든다 ----
  // jsdom 은 레이아웃을 계산하지 않는다 — window.scrollTo 는 "not implemented" 라 scrollY 가 움직이지 않고
  // getBoundingClientRect 는 전부 0 이다. 그래서 scrollY 값만 갈아 끼우고 scroll 이벤트를 직접 쏜다.
  // 판정(붙었는지) · rAF 스로틀 · 클래스 토글은 study.js 의 실제 코드가 그대로 돈다.
  const boardEl = d.getElementById('scoreBoard');
  const setScrollY = y => {
    Object.defineProperty(w, 'scrollY', { value: y, configurable: true });
    w.dispatchEvent(new w.Event('scroll'));
  };
  check(!!boardEl && !boardEl.classList.contains('compact'),
    'compact: 채점 직후(맨 위)에는 점수판이 펼쳐져 있다', boardEl ? boardEl.className : '#scoreBoard 없음');
  setScrollY(1500);
  const gotCompact = await waitFor(() => (boardEl.classList.contains('compact') ? true : null),
    '점수판 .compact 진입', 2000).catch(() => null);
  check(gotCompact === true, 'compact: 스크롤해서 붙기 시작하면 #scoreBoard 에 .compact', boardEl.className);
  check(/\d+점\s*\/\s*100점/.test(boardEl.textContent) && /\(\d+\/\d+ 문제 정답\)/.test(boardEl.textContent),
    'compact: 축소 상태에서도 DOM 문구는 펼친 상태 그대로 (시각 축소만)',
    boardEl.textContent.replace(/\s+/g, ' ').slice(0, 60));
  setScrollY(0);
  const backExpanded = await waitFor(() => (boardEl.classList.contains('compact') ? null : true),
    '점수판 .compact 해제', 2000).catch(() => null);
  check(backExpanded === true, 'compact: 맨 위로 돌아오면 .compact 가 풀린다', boardEl.className);

  // ---- A2: 채점 성공 시 저장분 삭제 ----
  const afterSave = readStore(w, SKEY);
  check(afterSave === null, 'autosave: 채점 성공 후 저장분 삭제', String(afterSave));

  // ---- B3: 채점되면 타이머가 멎고 컨트롤이 사라진다 ----
  if (timerOut) {
    check(timerOut.hidden === true && d.getElementById('studyTools').hidden === true,
      'timer: 채점 후 타이머 정지 + 컨트롤 숨김',
      'out.hidden=' + timerOut.hidden + ' tools.hidden=' + d.getElementById('studyTools').hidden);
  }

  // ---- 해설 토글 (data/explanations/2026-2.json 이 있을 때만) ----
  const EXPLAIN_FILE = path.join(ROOT, 'data', 'explanations', '2026-2.json');
  if (fs.existsSync(EXPLAIN_FILE)) {
    const wrote = JSON.parse(fs.readFileSync(EXPLAIN_FILE, 'utf8')).explanations || {};
    // 채점된 카드 중 해설이 있는 첫 문항 — 정답/오답을 가리지 않는다.
    const target = [...d.querySelectorAll('.q')]
      .map(c => c.getAttribute('data-q'))
      .find(id => typeof wrote[id] === 'string' && wrote[id] !== '');
    if (!target) {
      check(false, 'explain: 2026-2 해설 파일에 이 회차 문항 해설이 하나도 없다');
    } else {
      const findCard = () => d.querySelector('.q[data-q="' + target + '"]');
      const explainBtn = () => [...findCard().querySelectorAll('button')].find(b => /해설 보기|해설 닫기/.test(b.textContent));
      check(!!explainBtn(), 'explain: 채점된 카드에 "해설 보기" 버튼', target);
      check(!findCard().querySelector('.explain-box'), 'explain: 처음에는 해설 상자가 닫혀 있다');

      explainBtn().click();
      const box = await waitFor(() => findCard().querySelector('.explain-box'), '해설 상자', 4000).catch(() => null);
      check(!!box, 'explain: 클릭하면 .explain-box 가 열린다');
      if (box) {
        check(!!box.querySelector('mark, b'), 'explain: 해설 마크업(<mark>/<b>)이 HTML 로 렌더된다',
          box.innerHTML.replace(/\s+/g, ' ').slice(0, 70));
        check(box.textContent.trim().length >= 50, 'explain: 해설 본문이 실려 있다', box.textContent.length + '자');
        // 피드백 줄 아래 · 버튼 줄 위
        const order = [...findCard().children].map(n => n.className);
        const iFb = order.findIndex(c => /feedback/.test(c));
        const iEx = order.findIndex(c => /explain-box/.test(c));
        const iAc = order.findIndex(c => /q-actions/.test(c));
        check(iFb >= 0 && iFb < iEx && iEx < iAc, 'explain: 배치가 피드백 → 해설 → 버튼 줄 순서', JSON.stringify(order));
      }
      check(/해설 닫기/.test(explainBtn().textContent), 'explain: 열린 뒤 버튼 문구가 "해설 닫기"');
      explainBtn().click();
      const closed = await waitFor(() => (findCard().querySelector('.explain-box') ? null : true), '해설 상자 닫힘', 4000).catch(() => null);
      check(closed === true, 'explain: 다시 클릭하면 해설이 닫힌다');
      check(/해설 보기/.test(explainBtn().textContent), 'explain: 닫힌 뒤 버튼 문구가 "해설 보기"');
    }
  } else {
    log('SKIP  explain: data/explanations/2026-2.json 미작성 — 해설 UI 검사 건너뜀');
  }

  // ---------- 3. AI 질문 복사 → 폴백 모달 ----------
  const copyBtn = [...q3.querySelectorAll('button')].find(b => /AI/.test(b.textContent));
  check(!!copyBtn, 'study: 오답 카드에 "AI에게 질문하기" 버튼');
  const q1 = [...cardsAfter].find(c => c.querySelector('.num').textContent.trim() === '1');
  check(![...q1.querySelectorAll('button')].some(b => /AI/.test(b.textContent)), 'study: 정답 카드에는 복사 버튼 없음');
  // jsdom: navigator.clipboard 없음, execCommand 미구현 → 3단계(모달)로 떨어져야 한다
  w.document.execCommand = undefined;
  copyBtn.click();
  const modal = await waitFor(() => d.querySelector('.modal textarea, textarea.modal-text, [role="dialog"] textarea'), 'clipboard fallback modal', 4000).catch(() => null);
  check(!!modal, 'clipboard: 3단 폴백 최종 단계(모달) 진입');
  if (modal) {
    const txt = modal.value;
    check(txt.includes('[문제]') && txt.includes('[내 답]') && txt.includes('[정답]') && txt.includes('풀이 과정을 설명해줘'), 'clipboard: 프롬프트 4요소 포함');
    check(txt.includes('내용결합도') && txt.includes('ㄴ') && /결합도\(Coupling\)/.test(txt), 'clipboard: 지문(bodyText)+내 답+정답 실제 값 포함');
    check(!/<[a-z]+[^>]*>|&[a-z]+;/i.test(txt.replace(/<stdio\.h>/g, '')), 'clipboard: 프롬프트에 HTML 태그/엔티티 없음');
    const sel = d.activeElement === modal || (modal.selectionStart === 0 && modal.selectionEnd === txt.length);
    check(sel, 'clipboard: 모달 textarea 전체 선택 상태', 'active=' + (d.activeElement === modal) + ' sel=' + modal.selectionStart + '..' + modal.selectionEnd + '/' + txt.length);
    check(/Ctrl\+C|길게 눌러/.test(d.body.textContent), 'clipboard: 기기별 안내 문구 표시');
    // 모달이 남아 있으면 뒤의 클릭·포커스 검사를 방해한다 — 걷어낸다
    const backdrop = d.querySelector('.modal-backdrop');
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }

  // ---------- 4. 정답 이의 제기(인라인 textarea) → reports.json ----------
  // 토글/전송마다 render() 가 카드를 다시 만든다 — 매번 data-q 로 다시 찾는다.
  const findQ3 = () => d.querySelector('.q[data-q="2026-2#3"]');
  check(!!findQ3(), 'study: 오답 카드를 data-q 로 식별', findQ3() ? findQ3().getAttribute('data-q') : '없음');
  const reportBtn = [...findQ3().querySelectorAll('button')].find(b => /정답 이의 제기/.test(b.textContent));
  check(!!reportBtn, 'study: 오답 카드에 "정답 이의 제기" 버튼');
  if (reportBtn) {
    check(!findQ3().querySelector('.report-box'), 'report: 처음에는 입력 상자가 닫혀 있다');
    reportBtn.click();
    await sleep(80);
    const ta = findQ3().querySelector('.report-box textarea');
    check(!!ta, 'report: 버튼을 누르면 인라인 textarea 가 열린다 (A6)');
    if (ta) {
      ta.value = 'headless 테스트 신고';
      ta.dispatchEvent(new w.Event('input', { bubbles: true }));
      const send = [...findQ3().querySelectorAll('.report-box button')].find(b => /보내기/.test(b.textContent));
      check(!!send, 'report: "보내기" 버튼 존재');
      if (send) {
        send.click();
        const rep = await waitFor(() => { try { const j = JSON.parse(fs.readFileSync(path.join(TMP, 'reports.json'), 'utf8')); return j.length ? j : null; } catch (_) { return null; } }, 'reports.json entry', 5000).catch(() => null);
        check(!!rep && rep[0].questionId === '2026-2#3' && /신고/.test(rep[0].comment || ''), 'reports: reports.json 에 1건 적재 (questionId, comment)', JSON.stringify(rep && rep[0]));
        await sleep(150);
        const done = [...findQ3().querySelectorAll('button')].find(b => /이의 제기 접수됨/.test(b.textContent));
        check(!!done && done.disabled === true, 'report: 접수 후 버튼이 "이의 제기 접수됨" 으로 잠긴다',
          done ? 'disabled=' + done.disabled : '버튼 없음');
        check(/접수되었습니다/.test(findQ3().textContent), 'report: 접수 상태 문구가 카드에 남는다');
      }
    }
  }
  check(st.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0, 'study: JS 오류 없음 (jsdom 미구현 경고 제외)', st.errors.slice(0, 2).join(' | '));

  // ---------- 5. 학습 이력 (A1) ----------
  const hist = await (await makeFetch()('/api/me/history')).json().catch(() => null);
  check(!!hist && hist.rounds && typeof hist.wrongCount === 'number',
    'history: GET /api/me/history 계약 형태', JSON.stringify(hist && { rounds: Object.keys(hist.rounds || {}), wrongCount: hist.wrongCount, recent: (hist.recent || []).length }));

  const idx2 = await load('/');
  await waitFor(() => idx2.window.document.querySelector('#studyBox .card'), '내 학습 카드', 6000).catch(() => null);
  const sBox = idx2.window.document.getElementById('studyBox');
  check(!!sBox && !sBox.hidden && /오답노트\s*\(\d+문항\)/.test(sBox.textContent),
    'index: 로그인 시 "내 학습" 카드 + 오답노트 버튼(문항 수)', sBox ? sBox.textContent.replace(/\s+/g, ' ').slice(0, 90) : '없음');
  const wrongLink = idx2.window.document.querySelector('#studyBox a[href="/wrong.html"]');
  check(!!wrongLink && /오답노트 \(16문항\)/.test(wrongLink.textContent),
    'index: 오답노트 버튼이 허브(/wrong.html)를 가리키고 오답 16문항을 표시', wrongLink ? wrongLink.textContent : '링크 없음');
  check(/2026년 2회|2026-2/.test(sBox ? sBox.textContent : ''), 'index: 최근 결과 목록에 방금 푼 회차 표시',
    sBox ? (sBox.querySelector('.history-list') || {}).textContent : '없음');

  const badge = await waitFor(() => idx2.window.document.querySelector('a[href*="round=2026-2"] .badge'), '회차 뱃지', 6000).catch(() => null);
  check(!!badge && /최근\s*20점/.test(badge.textContent) && /1회/.test(badge.textContent),
    'index: 회차 버튼에 "최근 N점 · 최고 M점 · K회" 뱃지', badge ? badge.textContent : '뱃지 없음');

  // ---------- 6. 오답노트 (B2) ----------
  const wr = await load('/study.html?set=wrong');
  const wrongN = hist ? hist.wrongCount : 0;
  const wrCards = await waitFor(() => { const c = wr.window.document.querySelectorAll('.q'); return c.length > 0 ? c : null; }, '오답노트 문항', 6000).catch(() => null);
  check(!!wrCards && wrCards.length === wrongN,
    'wrong: /study.html?set=wrong 문항 수 == history.wrongCount', (wrCards ? wrCards.length : 0) + ' / ' + wrongN);
  check(/오답노트/.test(wr.window.document.getElementById('roundTitle').textContent),
    'wrong: 제목이 "오답노트"', wr.window.document.getElementById('roundTitle').textContent);

  // ---- 요구 4: 오답노트 카드에도 회차 뱃지 ----
  const wrBadgeCount = wrCards ? [...wrCards].filter(c => !!c.querySelector('.q-origin') && c.querySelector('.q-origin').textContent.trim() !== '').length : 0;
  check(!!wrCards && wrCards.length > 0 && wrBadgeCount === wrCards.length,
    'wrong: 모든 오답 카드에 회차 뱃지 표시', wrBadgeCount + ' / ' + (wrCards ? wrCards.length : 0));

  // ---------- 6b. 오답노트 허브 (/wrong.html) ----------
  const sum = await (await makeFetch()('/api/me/wrong/summary')).json().catch(() => null);
  check(!!sum && typeof sum.total === 'number' && Array.isArray(sum.byRound) && Array.isArray(sum.byBattle),
    'wronghub: GET /api/me/wrong/summary 계약 형태',
    sum ? JSON.stringify({ total: sum.total, byRound: (sum.byRound || []).length, byBattle: (sum.byBattle || []).length }) : '응답 없음');

  const wn = await load('/wrong.html');
  const wnDoc = wn.window.document;
  const wnTabs = await waitFor(() => { const t = [...wnDoc.querySelectorAll('#wrongTabs button')]; return t.length ? t : null; }, '오답노트 허브 탭', 8000).catch(() => null);
  check(!!wnTabs && wnTabs.length === 2 && /회차별/.test(wnTabs[0].textContent) && /대전별/.test(wnTabs[1].textContent),
    'wronghub: 회차별 / 대전별 탭 2개', wnTabs ? wnTabs.map(b => b.textContent.trim()).join(' / ') : '탭 없음');
  const wnOnTab = wnTabs ? wnTabs.find(b => b.classList.contains('on')) : null;
  check(!!wnOnTab && /회차별/.test(wnOnTab.textContent), 'wronghub: 기본 탭이 회차별',
    wnOnTab ? wnOnTab.textContent.trim() : '.on 탭 없음');
  check(/총\s*\d+문항/.test((wnDoc.getElementById('wrongSummary') || {}).textContent || ''),
    'wronghub: 상단 요약에 "총 N문항"', (wnDoc.getElementById('wrongSummary') || {}).textContent);
  const wnAll = wnDoc.querySelector('#wrongSummary a.btn-link');
  check(!!wnAll && wnAll.getAttribute('href') === '/study.html?set=wrong',
    'wronghub: "전체 풀기" 링크', wnAll ? wnAll.getAttribute('href') : '링크 없음');

  const wnRow = wnDoc.querySelector('#wrongBody a[href="/study.html?set=wrong&round=2026-2"]');
  check(!!wnRow && /2026년 2회/.test(wnRow.textContent),
    'wronghub: 회차별 목록에 2026-2 행 → study.html?set=wrong&round=2026-2',
    wnRow ? wnRow.textContent.trim() : (wnDoc.getElementById('wrongBody') || {}).textContent.replace(/\s+/g, ' ').slice(0, 120));
  check(wn.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
    'wronghub: JS 오류 없음', wn.errors.slice(0, 2).join(' | '));

  // 대전별 탭도 눌러 본다 (대전 기록이 없으면 안내 문구가 나와야 한다 — 빈 화면은 실패다)
  if (wnTabs && wnTabs.length === 2) {
    wnTabs[1].click();
    await sleep(150);
    const bodyText = (wnDoc.getElementById('wrongBody') || {}).textContent.replace(/\s+/g, ' ').trim();
    check(bodyText.length > 0, 'wronghub: 대전별 탭에도 내용이 있다 (기록이 없으면 안내 문구)', bodyText.slice(0, 90));
  }

  // 회차별 행이 가리키는 학습 화면 — 서버 title 과 문항 수가 그대로 와야 한다
  const roundWrongApi = await (await makeFetch()('/api/me/wrong?round=2026-2')).json().catch(() => null);
  const wnRoundHref = wnRow ? wnRow.getAttribute('href') : '/study.html?set=wrong&round=2026-2';
  const wrR = await load(wnRoundHref);
  const wrRCards = await waitFor(() => { const c = wrR.window.document.querySelectorAll('.q'); return c.length > 0 ? c : null; }, '회차별 오답 문항', 8000).catch(() => null);
  const expectN = roundWrongApi && Array.isArray(roundWrongApi.questions) ? roundWrongApi.questions.length : -1;
  check(!!wrRCards && wrRCards.length === expectN,
    'wronghub: 회차별 링크가 그 회차의 오답만 낸다 (GET /api/me/wrong?round=2026-2 와 같은 수)',
    (wrRCards ? wrRCards.length : 0) + ' / ' + expectN);
  const wrRTitle = wrR.window.document.getElementById('roundTitle').textContent.trim();
  check(!!roundWrongApi && wrRTitle === String(roundWrongApi.title || ''),
    'wronghub: 학습 화면 제목이 서버 title 그대로', wrRTitle + ' / ' + (roundWrongApi ? roundWrongApi.title : '응답 없음'));
  check(wrR.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
    'wronghub: 회차별 오답 학습 화면 JS 오류 없음', wrR.errors.slice(0, 2).join(' | '));

  // ---------- 7. 랜덤 모의고사 (B1) ----------
  const pr = await load('/study.html?set=practice&rounds=all&count=10');
  const prCards = await waitFor(() => { const c = pr.window.document.querySelectorAll('.q'); return c.length === 10 ? c : null; }, '모의고사 10문항', 6000).catch(() => null);
  check(!!prCards && prCards.length === 10, 'practice: rounds=all&count=10 → 문항 10개', prCards ? prCards.length : (pr.window.document.getElementById('questions') || {}).textContent);

  // ---- 요구 4: 모의고사 카드 전부 회차 뱃지 + 서로 다른 회차 2개 이상 ----
  if (prCards) {
    const prOrigins = [...prCards].map(c => { const o = c.querySelector('.q-origin'); return o ? o.textContent.trim() : ''; });
    const prBadgeCount = prOrigins.filter(t => t !== '').length;
    check(prBadgeCount === prCards.length, 'practice: 모든 카드에 회차 뱃지 표시', prBadgeCount + ' / ' + prCards.length);
    const distinctOrigins = new Set(prOrigins.filter(t => t !== ''));
    check(distinctOrigins.size >= 2, 'practice: 뱃지가 서로 다른 회차 2개 이상 (rounds=all)', [...distinctOrigins].join(', '));
  }

  // ---- ①: 섞인 세트는 1부터 순번. 원본 번호는 회차 뱃지에만 남는다 ----
  const seq = await load('/study.html?set=practice&rounds=all&count=5');
  const seqCards = await waitFor(() => { const c = seq.window.document.querySelectorAll('.q'); return c.length === 5 ? c : null; }, '순번 검사용 모의고사 5문항', 6000).catch(() => null);
  const seqNums = seqCards ? [...seqCards].map(c => ((c.querySelector('.num') || {}).textContent || '').trim()) : [];
  check(seqNums.join(',') === '1,2,3,4,5',
    'seqnum: 랜덤 모의고사 카드 번호가 1..5 순번', seqNums.join(',') || '카드 없음');
  const seqOrigins = seqCards ? [...seqCards].map(c => ((c.querySelector('.q-origin') || {}).textContent || '').trim()) : [];
  check(seqOrigins.length === 5 && seqOrigins.every(t => /^\d{4}년\s*\d+회\s*·\s*\d+번$/.test(t)),
    'seqnum: 원본 회차·번호는 회차 뱃지(.q-origin)에 그대로 남는다', seqOrigins.join(' | ') || '뱃지 없음');
  check(seq.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
    'seqnum: 순번 화면 JS 오류 없음', seq.errors.slice(0, 2).join(' | '));

  const prSubmit = [...pr.window.document.querySelectorAll('button')].find(b => /제출하고 채점/.test(b.textContent));
  check(!!prSubmit, 'practice: 제출 버튼 존재');
  if (prSubmit) {
    prSubmit.click();
    const prBoard = await waitFor(() => { const b = pr.window.document.getElementById('scoreBoard'); return b && b.classList.contains('shown') ? b : null; }, 'practice 채점 결과', 6000).catch(() => null);
    check(!!prBoard && /\d+점\s*\/\s*100점/.test(prBoard.textContent),
      'practice: POST /api/practice/grade 로 채점되고 점수판이 뜬다', prBoard ? prBoard.textContent.replace(/\s+/g, ' ').slice(0, 50) : '점수판 없음');
  }
  check(pr.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0, 'practice: JS 오류 없음', pr.errors.slice(0, 2).join(' | '));

  // ---- 요구 3 후속: index 최근 목록이 setKey 'practice' 를 "랜덤 모의고사" 로 표기 (원문 그대로 노출 금지) ----
  if (prSubmit) {
    const idxAfterPractice = await load('/');
    await waitFor(() => idxAfterPractice.window.document.querySelector('#studyBox .history-list'), '모의고사 채점 후 최근 목록', 6000).catch(() => null);
    const histList = idxAfterPractice.window.document.querySelector('#studyBox .history-list');
    check(!!histList && /랜덤 모의고사/.test(histList.textContent) && !/(^|[^가-힣])practice([^가-힣]|$)/.test(histList.textContent),
      'index: 최근 목록의 practice 결과가 "랜덤 모의고사" 로 표기된다 (raw practice 노출 금지)',
      histList ? histList.textContent.replace(/\s+/g, ' ').slice(0, 120) : '.history-list 없음');
  }

  // ---------- 8. 로그아웃 → 랭킹 페이지 리다이렉트 ----------
  if (logoutBtn) {
    logoutBtn.click();
    await sleep(400);
    const me2 = await (await makeFetch()('/api/auth/me')).json();
    check(me2.user === null, 'auth: 로그아웃 후 me 가 null', JSON.stringify(me2));
  }

  const rk = await load('/ranking.html');
  await sleep(600);
  const rkText = rk.window.document.body.textContent;
  // ranking.js 는 비로그인 시 location.replace('/?msg=…') 로 보낸다. jsdom 은 내비게이션을 구현하지 않고 'Not implemented: navigation' 오류를 낸다 → 그 오류가 곧 리다이렉트 시도의 증거.
  const navAttempt = rk.errors.some(e => /navigation/i.test(e));
  check(navAttempt || /로그인/.test(rkText) || rk.window.location.pathname === '/', 'ranking: 비로그인 시 로그인 페이지로 리다이렉트 시도', navAttempt ? 'location.replace 호출됨' : rk.window.location.pathname);

  // 비로그인 오답노트 → 로그인 안내
  const wrOut = await load('/study.html?set=wrong');
  await waitFor(() => /로그인이 필요합니다/.test(wrOut.window.document.body.textContent) ? true : null, '오답노트 로그인 안내', 5000).catch(() => null);
  check(/로그인이 필요합니다/.test(wrOut.window.document.body.textContent),
    'wrong: 비로그인 접근 시 "로그인이 필요합니다" 안내',
    (wrOut.window.document.getElementById('questions') || {}).textContent);

  // ---------- 9. 채점 기록이 없는 새 계정 — 빈 오답노트 ----------
  // 서버는 questions: [] / wrongCount: 0 을 200 으로 준다 (오류가 아니다).
  const nick2 = 'hz' + (T0 % 100000);
  const su2 = await makeFetch()('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: nick2, password: 'pw1234' }),
  });
  check(su2.status === 200, 'auth: 두 번째 계정 가입', su2.status);
  const hist0 = await (await makeFetch()('/api/me/history')).json();
  check(hist0.wrongCount === 0 && (hist0.recent || []).length === 0,
    'history: 기록 없는 계정은 wrongCount 0 / recent 빈 배열', JSON.stringify(hist0));

  const idx3 = await load('/');
  await waitFor(() => idx3.window.document.querySelector('#studyBox .card'), '새 계정 내 학습 카드', 6000).catch(() => null);
  const sBox0 = idx3.window.document.getElementById('studyBox');
  check(!!sBox0 && /오답노트\s*\(0문항\)/.test(sBox0.textContent) && /아직 채점 기록이 없습니다/.test(sBox0.textContent),
    'index: 기록 없는 계정 — 빈 이력 안내 + 오답노트 (0문항)',
    sBox0 ? sBox0.textContent.replace(/\s+/g, ' ').slice(0, 90) : '없음');
  check(!idx3.window.document.querySelector('#studyBox a[href="/wrong.html"]')
    && !!idx3.window.document.querySelector('#studyBox .btn-link.disabled'),
    'index: 오답노트가 비면 링크 대신 비활성 버튼');
  check(!idx3.window.document.querySelector('.round-btn .badge'), 'index: 기록 없는 계정에는 회차 뱃지 없음');

  const wr0 = await load('/study.html?set=wrong');
  await waitFor(() => wr0.window.document.querySelector('.empty-state'), '빈 오답노트 화면', 6000).catch(() => null);
  const empty = wr0.window.document.querySelector('.empty-state');
  check(!!empty && /틀린 문항이 없습니다/.test(empty.textContent)
    && !!empty.querySelector('a[href="/"]'),
    'wrong: 오답노트가 비면 빈 상태 UI + 돌아가기 링크', empty ? empty.textContent.replace(/\s+/g, ' ').slice(0, 70) : '.empty-state 없음');
  check(wr0.window.document.getElementById('btnbar').hidden === true, 'wrong: 빈 오답노트에서는 제출 버튼을 숨긴다');
  check(wr0.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0, 'wrong: JS 오류 없음', wr0.errors.slice(0, 2).join(' | '));

  // ---------- 10. 문항 유형 필터 (코드 / SQL / 이론) ----------
  // 서버(types-srv)가 아직 counts/type 을 주지 않으면 통째로 SKIP 한다.
  // 기능이 들어오면 이 블록은 반드시 통과해야 한다 (SKIP 로그가 남으면 미완성이라는 뜻).
  const roundsT = await (await makeFetch()('/api/rounds')).json();
  const r262 = (roundsT || []).find(r => r.round === '2026-2');
  const counts262 = r262 && r262.counts;
  const typesReady = !!(counts262 && typeof counts262 === 'object'
    && ['code', 'sql', 'theory'].every(k => typeof counts262[k] === 'number'));

  if (!typesReady) {
    log('SKIP  types: /api/rounds 가 아직 counts 를 주지 않는다 — 유형 필터 검사 전체 건너뜀 (서버 미구현)');
  } else {
    const codeN = counts262.code;

    // ---- ① 회차 + 유형 필터: 문항 수와 뱃지 ----
    const ty = await load('/study.html?round=2026-2&type=code');
    const tyDoc = ty.window.document;
    const tyCards = await waitFor(() => { const c = tyDoc.querySelectorAll('.q'); return c.length > 0 ? c : null; }, 'type=code 문항 카드', 8000).catch(() => null);
    check(!!tyCards && tyCards.length === codeN && tyCards.length < 20,
      'types: ?round=2026-2&type=code → 코드 문항만 (20문항 미만)',
      (tyCards ? tyCards.length : 0) + '개 / counts.code=' + codeN);
    const codeBadges = tyCards
      ? [...tyCards].filter(c => { const b = c.querySelector('.q-type'); return b && b.textContent.trim() === '코드'; }).length
      : 0;
    check(!!tyCards && tyCards.length > 0 && codeBadges === tyCards.length,
      'types: 모든 문항 카드에 "코드" 유형 뱃지', codeBadges + ' / ' + (tyCards ? tyCards.length : 0));

    // ---- ③ 필터 칩 4개 · 채점 전 활성 ----
    const chips = [...tyDoc.querySelectorAll('#typeFilter button')];
    check(chips.length === 4, 'types: 학습 상단 유형 필터 칩 4개', chips.length);
    check(chips.map(b => b.textContent.trim()).join('/') === '전체/코드/SQL/이론',
      'types: 칩 문구가 전체/코드/SQL/이론', chips.map(b => b.textContent.trim()).join('/'));
    check(chips.length === 4 && chips.every(b => b.disabled === false), 'types: 채점 전에는 필터가 활성');
    const onChip = chips.find(b => b.classList.contains('on'));
    check(!!onChip && onChip.textContent.trim() === '코드',
      'types: 지금 보고 있는 유형 칩에 .on 표시', onChip ? onChip.textContent.trim() : '없음');

    // ---- ② 채점: 점수판 분모가 그 유형의 문항 수 ----
    const tySubmit = [...tyDoc.querySelectorAll('button')].find(b => /제출하고 채점/.test(b.textContent));
    check(!!tySubmit, 'types: 유형 필터 상태에서 제출 버튼 존재');
    if (tySubmit) {
      tySubmit.click();
      const tyBoard = await waitFor(() => { const b = tyDoc.getElementById('scoreBoard'); return b && b.classList.contains('shown') ? b : null; }, '유형 채점 점수판', 8000).catch(() => null);
      const boardText = tyBoard ? tyBoard.textContent.replace(/\s+/g, ' ') : '';
      check(new RegExp('\\(\\d+/' + codeN + ' 문제 정답\\)').test(boardText),
        'types: 채점 점수판 분모 == 유형 문항 수 (' + codeN + ')', boardText.slice(0, 70) || '점수판 없음');

      // ---- ③ 채점 후에는 필터 비활성 ----
      const chipsAfter = [...tyDoc.querySelectorAll('#typeFilter button')];
      check(chipsAfter.length === 4 && chipsAfter.every(b => b.disabled === true),
        'types: 채점 후 유형 필터 비활성', chipsAfter.map(b => b.disabled).join(','));

      // "다시 풀기" 하면 다시 활성
      const tyReset = [...tyDoc.querySelectorAll('button')].find(b => /다시 풀기/.test(b.textContent));
      if (tyReset) {
        tyReset.click();
        await sleep(200);
        const chipsReset = [...tyDoc.querySelectorAll('#typeFilter button')];
        check(chipsReset.length === 4 && chipsReset.every(b => b.disabled === false),
          'types: "다시 풀기" 후 유형 필터 재활성', chipsReset.map(b => b.disabled).join(','));
      }
    }
    check(ty.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
      'types: 유형 필터 학습 화면 JS 오류 없음', ty.errors.slice(0, 2).join(' | '));

    // ---- 0문항 유형은 아예 못 누르게 막는다 (2025-2 는 SQL 0문항) ----
    // 어떤 회차가 0인지 하드코딩하지 않는다 — /api/rounds 의 counts 에서 직접 찾는다.
    const zeroPick = (roundsT || []).map(r => {
      const c = r && r.counts;
      if (!c) return null;
      const t = ['code', 'sql', 'theory'].find(k => Number(c[k]) === 0);
      return t ? { round: r.round, type: t } : null;
    }).find(Boolean);
    check(!!zeroPick, 'types: 특정 유형이 0문항인 회차가 데이터에 존재한다 (필터 비활성 검사 대상)',
      zeroPick ? zeroPick.round + ' / ' + zeroPick.type + '=0' : '없음 — 검사 대상 회차 없음');
    if (zeroPick) {
      const LABEL = { code: '코드', sql: 'SQL', theory: '이론' };
      const zr = await load('/study.html?round=' + encodeURIComponent(zeroPick.round));
      const zDoc = zr.window.document;
      // counts 는 문항과 별도로 도착한다 — 비활성이 반영될 때까지 기다린다.
      const zChip = await waitFor(() => {
        const b = zDoc.querySelector('#typeFilter button[data-type="' + zeroPick.type + '"]');
        return b && b.disabled ? b : null;
      }, '0문항 유형 칩 비활성', 8000).catch(() => null);
      check(!!zChip, 'types: 0문항 유형 칩이 비활성 (' + zeroPick.round + ' / ' + LABEL[zeroPick.type] + ')',
        zChip ? 'disabled=true class=' + zChip.className : '비활성되지 않음');
      check(!!zChip && zChip.classList.contains('empty'),
        'types: 0문항 유형 칩에 .empty 표시', zChip ? zChip.className : '없음');
      const zOthers = [...zDoc.querySelectorAll('#typeFilter button')]
        .filter(b => b.getAttribute('data-type') !== zeroPick.type);
      check(zOthers.length === 3 && zOthers.every(b => b.disabled === false),
        'types: 나머지 유형 칩은 그대로 활성', zOthers.map(b => b.textContent.trim() + '=' + b.disabled).join(','));
      check(zr.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
        'types: 0문항 회차 화면 JS 오류 없음', zr.errors.slice(0, 2).join(' | '));
    }

    // ---- 2025-2 는 SQL 0문항 — 회귀로 못 박아 둔다 (실브라우저에서 한 번 놓쳤던 항목).
    // 회차를 이름으로 짚되 기대값은 서버 counts 에서 가져와, 분류가 바뀌면 조용히 건너뛴다.
    const r2025_2 = (roundsT || []).find(r => r.round === '2025-2');
    if (r2025_2 && r2025_2.counts && Number(r2025_2.counts.sql) === 0) {
      const z2 = await load('/study.html?round=2025-2');
      const sqlChip = await waitFor(() => {
        const b = z2.window.document.querySelector('#typeFilter button[data-type="sql"]');
        return b && b.disabled ? b : null;
      }, '2025-2 SQL 칩 비활성', 8000).catch(() => null);
      check(!!sqlChip, 'types: 2025-2(SQL 0문항)에서 SQL 칩이 disabled',
        sqlChip ? 'disabled=true class=' + sqlChip.className : '활성 상태로 남아 있음');
    } else {
      log('SKIP  types: 2025-2 의 SQL 이 더 이상 0문항이 아니다 — 고정 회귀 검사 생략');
    }

    if (zeroPick) {

      // 그래도 URL 을 직접 치고 들어오면 서버 400 문구를 그대로 보여 준다 (기존 규약 유지)
      const zDirect = await load('/study.html?round=' + encodeURIComponent(zeroPick.round)
        + '&type=' + zeroPick.type);
      await waitFor(() => /해당 유형의 문항이 없습니다/.test(zDirect.window.document.body.textContent) ? true : null,
        '0문항 유형 직접 진입 안내', 8000).catch(() => null);
      check(/해당 유형의 문항이 없습니다/.test(zDirect.window.document.body.textContent),
        'types: 0문항 유형으로 직접 들어오면 서버 400 문구를 그대로 노출',
        (zDirect.window.document.getElementById('questions') || {}).textContent);
      check(zDirect.window.document.querySelectorAll('#typeFilter button').length === 4,
        'types: 400 화면에서도 유형 필터가 남아 있다 (다른 유형으로 되돌아갈 수 있게)');
    }

    // ---- ④ 메인: 회차 버튼의 유형 구성 + 유형 칩 ----
    const idxT = await load('/');
    await waitFor(() => idxT.window.document.querySelector('a.round-btn .types'), '회차 버튼 유형 구성', 8000).catch(() => null);
    const btn262 = [...idxT.window.document.querySelectorAll('a.round-btn')]
      .find(a => /round=2026-2(?:&|$)/.test(a.getAttribute('href') || ''));
    const typesSpan = btn262 ? btn262.querySelector('.types') : null;
    check(!!typesSpan && /코드\s*\d+/.test(typesSpan.textContent) && /이론\s*\d+/.test(typesSpan.textContent),
      'index: 회차 버튼에 유형 구성 표시 (코드 N · 이론 M)', typesSpan ? typesSpan.textContent : '.types 없음');

    // 0인 유형은 구성 표기에서 빠진다 (2025-2 → "코드 9 · 이론 11", SQL 없음)
    if (zeroPick) {
      const LABEL2 = { code: '코드', sql: 'SQL', theory: '이론' };
      const btnZero = [...idxT.window.document.querySelectorAll('a.round-btn')]
        .find(a => new RegExp('round=' + zeroPick.round + '(?:&|$)').test(a.getAttribute('href') || ''));
      const zSpan = btnZero ? btnZero.querySelector('.types') : null;
      check(!!zSpan && zSpan.textContent.indexOf(LABEL2[zeroPick.type]) === -1,
        'index: 0인 유형은 회차 구성 표기에서 생략 (' + zeroPick.round + ' 에 ' + LABEL2[zeroPick.type] + ' 없음)',
        zSpan ? zSpan.textContent : '.types 없음');
    }

    const idxChips = [...idxT.window.document.querySelectorAll('#roundTypeFilter button')];
    check(idxChips.length === 4, 'index: 회차 목록 위 유형 칩 4개', idxChips.length);
    if (idxChips.length === 4) {
      idxChips[1].click(); // '코드'
      await sleep(150);
      const links = [...idxT.window.document.querySelectorAll('a.round-btn')];
      check(links.length > 0 && links.every(a => /&type=code/.test(a.getAttribute('href') || '')),
        'index: 유형 칩을 고르면 회차 링크에 &type=code 가 붙는다',
        links.length ? links[0].getAttribute('href') : '회차 버튼 없음');
    }

    // ---- 0문항 회차 버튼은 링크를 죽인다 (0인 (회차,유형) 조합을 counts 에서 동적으로 찾는다) ----
    if (idxChips.length === 4 && zeroPick) {
      const LABEL3 = { code: '코드', sql: 'SQL', theory: '이론' };
      idxChips[['code', 'sql', 'theory'].indexOf(zeroPick.type) + 1].click();
      await sleep(200);
      const zDoc2 = idxT.window.document;
      // 0문항 회차는 <a> 가 아니어야 한다 — 눌러서 400 으로 떨어질 길 자체가 없어야 한다
      const stillLink = zDoc2.querySelector('a.round-btn[href*="round=' + zeroPick.round + '&"]');
      check(!stillLink,
        'index: 0문항 회차(' + zeroPick.round + ' / ' + LABEL3[zeroPick.type] + ')는 링크가 아니다',
        stillLink ? stillLink.getAttribute('href') : '링크 없음 (정상)');
      const zBtn = [...zDoc2.querySelectorAll('.round-btn')]
        .find(b => new RegExp(zeroPick.round.replace('-', '년 ') + '회').test(b.textContent)
          || b.textContent.indexOf(zeroPick.round) !== -1);
      check(!!zBtn && zBtn.classList.contains('empty') && zBtn.tagName === 'SPAN',
        'index: 0문항 회차 버튼이 .empty span 으로 비활성화',
        zBtn ? zBtn.tagName + '.' + zBtn.className : '버튼 없음');
      check(!!zBtn && /문항 없음/.test(zBtn.textContent) && !!zBtn.title,
        'index: 0문항 회차 버튼에 사유 표기 + title',
        zBtn ? (zBtn.querySelector('.empty-note') || {}).textContent + ' / title=' + zBtn.title : '-');
      // 나머지 회차는 그대로 링크로 남아 있어야 한다
      const others = [...zDoc2.querySelectorAll('a.round-btn')];
      check(others.length > 0 && others.every(a => a.getAttribute('href').indexOf('type=' + zeroPick.type) !== -1),
        'index: 그 유형이 있는 나머지 회차는 정상 링크', others.length + '개');
    }
    check(idxT.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
      'index: 유형 UI JS 오류 없음', idxT.errors.slice(0, 2).join(' | '));

    // ---- ⑤ 랜덤 모의고사 유형 필터 ----
    const prT = await load('/study.html?set=practice&rounds=all&count=10&type=sql');
    const prTCards = await waitFor(() => { const c = prT.window.document.querySelectorAll('.q'); return c.length > 0 ? c : null; }, 'SQL 모의고사 문항', 8000).catch(() => null);
    const sqlBadges = prTCards
      ? [...prTCards].filter(c => { const b = c.querySelector('.q-type'); return b && b.textContent.trim() === 'SQL'; }).length
      : 0;
    check(!!prTCards && prTCards.length > 0 && sqlBadges === prTCards.length,
      'types: ?set=practice&rounds=all&count=10&type=sql → SQL 문항만 출제',
      sqlBadges + ' / ' + (prTCards ? prTCards.length : 0));
    check(prT.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
      'types: SQL 모의고사 JS 오류 없음', prT.errors.slice(0, 2).join(' | '));
  }

  // ---------- 11. 불합격 CTA · 포커스 링 · 텍스트 대비 · 상대 날짜 (P3) ----------
  // 여기서 다시 채점해도 앞의 학습 이력·회차 뱃지 검사는 이미 끝났다 — 같은 회차를 다시 써도 안전하다.

  // ---- ⓐ 불합격이면 "틀린 N문항 해설 보기 →" 가 붙고, 누르면 첫 오답 카드 해설이 열린다 ----
  {
    const ct = await load('/study.html?round=2026-2');
    const cw = ct.window, cd = ct.window.document;
    await waitFor(() => cd.querySelectorAll('.q').length === 20 ? true : null, 'CTA: 문항 카드');
    // 한 칸도 채우지 않고 제출한다 → 0점 · 20문항 전부 오답 (confirm 은 load() 가 true 로 심어 둔다).
    const cSubmit = [...cd.querySelectorAll('button')].find(b => /제출하고 채점/.test(b.textContent));
    cSubmit.click();
    await waitFor(() => cd.querySelector('.q.wrong'), 'CTA: 채점 결과');
    await sleep(200);
    const cBoard = cd.getElementById('scoreBoard');
    const cWrong = cd.querySelectorAll('.q.wrong').length;
    const cta = cBoard ? cBoard.querySelector('.pass-cta') : null;
    check(!!cta, 'passcta: 불합격 점수판에 .pass-cta 버튼이 붙는다',
      cBoard ? cBoard.textContent.replace(/\s+/g, ' ').slice(0, 80) : '#scoreBoard 없음');
    check(!!cta && cta.textContent === '틀린 ' + cWrong + '문항 해설 보기 →',
      'passcta: CTA 문구가 "틀린 N문항 해설 보기 →" (N = 오답 수 ' + cWrong + ')',
      cta ? JSON.stringify(cta.textContent) : '-');
    // CTA 는 덧붙이기만 한 것이다 — 기존 점수판 문구는 그대로 남아 있어야 한다.
    check(!!cBoard && /\d+점\s*\/\s*100점/.test(cBoard.textContent)
      && /\(\d+\/\d+ 문제 정답\)/.test(cBoard.textContent) && /아쉽습니다/.test(cBoard.textContent),
      'passcta: CTA 를 붙여도 기존 점수판 문구(N점 / 100점 · (n/N 문제 정답) · 아쉽습니다) 유지',
      cBoard ? cBoard.textContent.replace(/\s+/g, ' ').slice(0, 90) : '-');

    if (cta) {
      // jsdom 에는 레이아웃이 없어 scrollIntoView 자체가 없다 — 심어 두고 "누구를 향해 불렸는지" 만 본다.
      const scrolled = [];
      cw.Element.prototype.scrollIntoView = function () { scrolled.push(this); };
      const firstWrongId = cd.querySelector('.q.wrong').getAttribute('data-q');
      cta.click();
      await sleep(200);
      const wrongCard = cd.querySelector('.q[data-q="' + firstWrongId + '"]');
      check(!!wrongCard && !!wrongCard.querySelector('.explain-box'),
        'passcta: CTA 를 누르면 첫 오답 카드(' + firstWrongId + ')의 해설이 열린다',
        wrongCard ? [...wrongCard.children].map(n => n.className).join(',') : '카드 없음');
      check(scrolled.indexOf(wrongCard) >= 0, 'passcta: 그 카드로 scrollIntoView 가 불린다',
        scrolled.length + '회 호출');
      const btnText = [...wrongCard.querySelectorAll('button')]
        .map(b => b.textContent).find(t => /해설 (보기|닫기)/.test(t));
      check(btnText === '해설 닫기', 'passcta: 기존 해설 토글과 같은 상태로 열린다 (버튼이 "해설 닫기")',
        JSON.stringify(btnText));
      // CTA 는 재렌더로 사라진다 — 포커스가 <body> 로 떨어지면 키보드 사용자는 맨 위부터 다시 탭해야 한다.
      check(cd.activeElement === wrongCard && wrongCard.getAttribute('tabindex') === '-1',
        'passcta: 포커스가 도착한 오답 카드로 넘어간다 (body 로 떨어지지 않는다)',
        (cd.activeElement ? cd.activeElement.className || cd.activeElement.tagName : '없음')
          + ' tabindex=' + wrongCard.getAttribute('tabindex'));
    }
    check(ct.errors.filter(e => !/not implemented|execCommand|clipboard/i.test(e)).length === 0,
      'passcta: CTA 화면 JS 오류 없음', ct.errors.slice(0, 2).join(' | '));
  }

  // ---- ⓐ 합격이면 CTA 가 없다 (정답 표본 sampleAnswer 로 합격권을 만들어 확인) ----
  {
    const key262 = {};
    (round262.questions || []).forEach(q => {
      key262[q.id] = (q.fields || []).map(f => f.sampleAnswer || (f.accept || [])[0] || '');
    });
    const pt = await load('/study.html?round=2026-2');
    const pw = pt.window, pd = pt.window.document;
    await waitFor(() => pd.querySelectorAll('.q').length === 20 ? true : null, 'PASS: 문항 카드');
    [...pd.querySelectorAll('.q')].forEach(card => {
      const vals = key262[card.getAttribute('data-q')] || [];
      [...card.querySelectorAll('input.ans')].forEach((inp, i) => {
        inp.value = vals[i] == null ? '' : String(vals[i]);
        inp.dispatchEvent(new pw.Event('input', { bubbles: true }));
      });
    });
    const pSubmit = [...pd.querySelectorAll('button')].find(b => /제출하고 채점/.test(b.textContent));
    pSubmit.click();
    const pBoard = await waitFor(() => {
      const b = pd.getElementById('scoreBoard');
      return b && b.classList.contains('shown') ? b : null;
    }, 'PASS: 점수판', 8000).catch(() => null);
    await sleep(150);
    const pScoreM = ((pBoard || {}).textContent || '').match(/(\d+)점\s*\/\s*100점/);
    const pScore = pScoreM ? Number(pScoreM[1]) : -1;
    check(pScore >= 60, 'passcta: 정답 표본으로 제출하면 합격권 점수가 나온다 (CTA 없음 검사의 전제)', pScore + '점');
    check(!!pBoard && !pBoard.querySelector('.pass-cta'),
      'passcta: 합격 점수판에는 CTA 가 없다',
      pBoard ? pBoard.textContent.replace(/\s+/g, ' ').slice(0, 70) : '#scoreBoard 없음');
  }

  // ---- ⓑⓔ 서버가 실제로 내려주는 CSS 를 읽어서 검사한다 ----
  {
    // `outline: none` 이 남아도 되는 자리는 `:focus:not(:focus-visible)` 뿐이다
    // (마우스 클릭에만 링을 끄는 규칙). 그 밖의 자리는 키보드 포커스 표시를 지워 버린다.
    const strayOutlineNone = (css) => {
      const out = [];
      const re = /outline\s*:\s*none/g;
      let m;
      while ((m = re.exec(css))) {
        const head = css.slice(0, m.index);
        const rule = head.slice(head.lastIndexOf('}') + 1);
        if (rule.indexOf(':focus:not(:focus-visible)') === -1) out.push(rule.trim().slice(-60));
      }
      return out;
    };
    const appCss = await (await makeFetch()('/css/app.css')).text();
    const battleCss = await (await makeFetch()('/css/battle.css')).text();
    check(/--muted:\s*#666\b/.test(appCss), 'contrast: app.css 의 --muted 가 #666 (흰 5.7:1 · paper 5.3:1)',
      (appCss.match(/--muted:[^;]*/) || ['없음'])[0]);
    const strayApp = strayOutlineNone(appCss), strayBattle = strayOutlineNone(battleCss);
    check(strayApp.length === 0, 'focusring: app.css 에 :focus:not(:focus-visible) 밖의 outline:none 이 없다',
      strayApp.join(' | ') || '없음');
    check(strayBattle.length === 0, 'focusring: battle.css 에 :focus:not(:focus-visible) 밖의 outline:none 이 없다',
      strayBattle.join(' | ') || '없음');
    check(/:focus-visible\s*\{[^}]*outline:\s*2px solid/.test(appCss),
      'focusring: app.css 에 전역 :focus-visible 링이 있다');
    check(/\.topnav\s+:focus-visible[\s\S]{0,140}outline-color:\s*#fff/.test(appCss),
      'focusring: 어두운 헤더(.topnav / header.page) 안에서는 링이 흰색');
    // 하단 미니바(.studybar)도 var(--deep) 위다 — 초록 링은 여기서 ≈1.3:1 로 안 보인다.
    check(/\.studybar\s+:focus-visible[^{]*\{[^}]*outline-color:\s*#fff/.test(appCss),
      'focusring: 하단 미니바(.studybar) 안에서도 링이 흰색',
      (appCss.match(/[^}]*:focus-visible \{ outline-color:[^;]*/) || ['규칙 없음'])[0].trim().slice(-70));
    // 링을 더한 것뿐이다 — 입력칸의 테두리 강조는 그대로 남아 있어야 한다.
    check(/input\.ans:focus\s*\{\s*border-color:\s*var\(--deep\)/.test(appCss),
      'focusring: input.ans:focus 의 테두리 강조 유지');
  }

  // ---- ⓒ 상대 날짜 포맷터 단위 검사 (public/js/fmt.js — 순수 함수라 DOM 없이 돈다) ----
  {
    const FMT_FILE = path.join(ROOT, 'public', 'js', 'fmt.js');
    if (fs.existsSync(FMT_FILE)) {
      const fmtCtx = vm.createContext({});
      fmtCtx.window = fmtCtx;
      vm.runInContext(fs.readFileSync(FMT_FILE, 'utf8'), fmtCtx, { filename: 'fmt.js' });
      const Fmt = fmtCtx.Fmt || (fmtCtx.window && fmtCtx.window.Fmt);
      check(!!Fmt && typeof Fmt.relativeDate === 'function' && typeof Fmt.dateTime === 'function',
        'fmt: window.Fmt = { relativeDate, dateTime } 계약', Fmt ? Object.keys(Fmt).join(',') : '전역 없음');
      if (Fmt && typeof Fmt.relativeDate === 'function') {
        // now 를 주입해서 "오늘/어제" 판정이 벽시계에 흔들리지 않게 못 박는다.
        const NOW = new Date(2026, 8, 2, 15, 30, 0);
        const at = (...a) => new Date(...a).toISOString();
        const cases = [
          [at(2026, 8, 2, 14, 0), '오늘 14:00', '같은 날 → "오늘 HH:MM"'],
          [at(2026, 8, 1, 9, 5), '어제 09:05', '하루 전 → "어제 HH:MM"'],
          [at(2026, 7, 30, 10, 0), '3일 전', '7일 이내 → "N일 전"'],
          [at(2026, 7, 26, 10, 0), '7일 전', '경계 안쪽 — 7일 차이는 아직 "N일 전"'],
          [at(2026, 7, 25, 10, 0), '2026-08-25', '경계 바깥 — 8일 차이부터 절대 날짜'],
          [at(2026, 8, 5, 10, 0), '2026-09-05', '미래 시각은 절대 날짜'],
        ];
        cases.forEach(c => {
          const got = Fmt.relativeDate(c[0], NOW);
          check(got === c[1], 'fmt: relativeDate — ' + c[2],
            JSON.stringify(got) + ' (기대 ' + JSON.stringify(c[1]) + ')');
        });
        // 읽을 수 없는 값은 던지지 않고 빈 문자열이다 (화면에 'Invalid Date' 가 새지 않게).
        check(Fmt.relativeDate('') === '' && Fmt.relativeDate('nonsense') === '',
          'fmt: relativeDate — 빈 값·못 읽는 값은 ""',
          JSON.stringify([Fmt.relativeDate(''), Fmt.relativeDate('nonsense')]));
        const abs = Fmt.dateTime(at(2026, 8, 1, 14, 0));
        check(abs === '2026-09-01 14:00', 'fmt: dateTime — title 에 남길 절대 시각', JSON.stringify(abs));
      }
    } else {
      log('SKIP  fmt: public/js/fmt.js 미작성 — 상대 날짜 단위 검사 건너뜀');
    }
  }

  console.log('\n' + (failures === 0 ? 'HEADLESS OK' : 'HEADLESS FAIL — ' + failures + ' check(s) failed'));
  shutdown(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HEADLESS ERROR', e.stack || e.message); shutdown(1); });
