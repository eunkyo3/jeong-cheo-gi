'use strict';
/**
 * index.js — HTTP + socket.io 서버 엔트리.
 *
 * 담당: 정적 파일, 학습 모드 REST(회차·랜덤 모의고사·오답노트·학습 이력), 인증 REST, 정답 이의 제기.
 * 대전/랭킹 라우트와 소켓 핸들러는 `server/battle-io.js` 가 붙인다.
 * battle-io.js 가 아직 없어도 서버는 기동한다 (학습 모드만 동작).
 *
 * battle-io.js 연결 규약:
 *   module.exports = function ({ app, server, io, db, rounds, auth }) { ... }
 *   또는 module.exports = { attach({ app, server, io, db, rounds, auth }) { ... } }
 *   또는 require('./index.js') 로 순환 참조해 스스로 붙는 형태(그 시점에 exports 는 이미 채워져 있다).
 * battle-io 를 require 한 뒤에 404/에러 핸들러를 등록하므로 라우트 추가 순서가 어긋나지 않는다.
 */

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const dbModule = require('./db.js');
const rounds = require('./rounds.js');
const auth = require('./auth.js');
const battle = require('./battle.js'); // 순수 모듈 — 랜덤 모의고사 출제에 buildQuestionSet 만 빌려 쓴다
const { gradeSet } = require('./grader.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// DATA_DIR env 로 데이터 디렉터리를 옮길 수 있다 (E2E 테스트가 격리된 임시 디렉터리를 쓴다). 회차 JSON 은 항상 repo 의 data/rounds 에서 읽는다.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');

// ------------------------------------------------------------------- 로깅

/** 한 사건 = 한 줄. 타임스탬프는 로컬 시각 HH:MM:SS. */
function log(...parts) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + parts.join(' '));
}

function logErr(...parts) {
  const t = new Date().toTimeString().slice(0, 8);
  console.error('[' + t + '] ' + parts.join(' '));
}

// ---------------------------------------------------------------- 부팅 준비

const db = dbModule.open({ dir: DATA_DIR });
auth.loadSecret(DATA_DIR); // 최초 기동 시 {DATA_DIR}/secret.key 생성

const app = express();
const server = http.createServer(app);
const io = new Server(server, { path: '/socket.io' });

// battle-io.js 가 순환 require 로 들어와도 채워진 exports 를 보도록 먼저 공개한다
module.exports = { app: app, server: server, io: io, db: db, rounds: rounds, auth: auth, log: log, start: start };

// ---------------------------------------------------------------- 미들웨어

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(auth.attachUser(db));

// 한국어 데이터 — 텍스트 응답은 항상 utf-8 로 못박는다
app.use(function (req, res, next) {
  res.set('Charset', 'utf-8');
  next();
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: function (res, filePath) {
    if (/\.html$/i.test(filePath)) res.set('Content-Type', 'text/html; charset=utf-8');
    else if (/\.css$/i.test(filePath)) res.set('Content-Type', 'text/css; charset=utf-8');
    else if (/\.js$/i.test(filePath)) res.set('Content-Type', 'text/javascript; charset=utf-8');
  },
}));

// ------------------------------------------------------------------- 인증

app.post('/api/auth/signup', function (req, res) {
  const body = req.body || {};
  const result = auth.signup(db, body.nickname, body.password);
  if (!result.ok) return res.status(400).json({ error: result.error });
  auth.setSessionCookie(res, result.user);
  log('signup', result.user.nickname, '(#' + result.user.id + ')');
  res.json({ user: result.user });
});

app.post('/api/auth/login', function (req, res) {
  const body = req.body || {};
  const user = auth.login(db, body.nickname, body.password);
  if (!user) return res.status(401).json({ error: '닉네임 또는 비밀번호가 올바르지 않습니다.' });
  auth.setSessionCookie(res, user);
  log('login', user.nickname, '(#' + user.id + ')');
  res.json({ user: user });
});

app.post('/api/auth/logout', function (req, res) {
  auth.clearSessionCookie(res);
  if (req.user) log('logout', req.user.nickname);
  res.json({ ok: true });
});

app.get('/api/auth/me', function (req, res) {
  res.json({ user: req.user || null });
});

// ------------------------------------------------------------------- 회차

/**
 * 유형 파라미터 해석 — 학습·모의고사·오답노트·대전이 전부 같은 규칙을 쓰도록 한 곳에 둔다.
 * 미지정·빈 값·"all" 은 **전체**(type=null)이고, 그 밖의 값은 `code|sql|theory` 만 허용한다.
 * @returns {{ok:true, type:string|null} | {ok:false, error:string}}
 */
function parseType(raw) {
  if (raw == null) return { ok: true, type: null };
  const bad = { ok: false, error: '유형은 ' + rounds.TYPES.join('/') + ' 중 하나여야 합니다.' };
  if (typeof raw !== 'string') return bad; // ?type=a&type=b 처럼 배열로 들어온 경우
  const v = raw.trim();
  if (v === '' || v === 'all') return { ok: true, type: null };
  return rounds.isType(v) ? { ok: true, type: v } : bad;
}

/**
 * 언어 파라미터 해석 — parseType 과 같은 규약이다.
 * 미지정·빈 값·"all" 은 **전체**(lang=null)이고, 그 밖의 값은 `c|java|python` 만 허용한다.
 * @returns {{ok:true, lang:string|null} | {ok:false, error:string}}
 */
function parseLang(raw) {
  if (raw == null) return { ok: true, lang: null };
  const bad = { ok: false, error: '언어는 ' + rounds.LANGS.join('/') + ' 중 하나여야 합니다.' };
  if (typeof raw !== 'string') return bad; // ?lang=a&lang=b 처럼 배열로 들어온 경우
  const v = raw.trim();
  if (v === '' || v === 'all') return { ok: true, lang: null };
  return rounds.isLang(v) ? { ok: true, lang: v } : bad;
}

const LANG_NEEDS_CODE = 'lang 은 코드 문항에만 쓸 수 있습니다.';

/**
 * 유형 + 언어를 **함께** 해석한다 (handoff C3). 학습·모의고사·오답노트가 전부 이 한 곳을 쓴다.
 *   · 언어는 코드 문항에만 있다 → `lang` 이 오면 `type` 은 생략이거나 `code` 여야 한다.
 *   · `lang` 만 오면 `type=code` 로 간주한다 — 아래 호출부가 유형 필터를 그대로 쓰면 된다.
 * @param {object} src `req.query` 또는 `req.body`
 * @returns {{ok:true, type:string|null, lang:string|null} | {ok:false, error:string}}
 */
function parseFilters(src) {
  const q = src || {};
  const t = parseType(q.type);
  if (!t.ok) return t;
  const l = parseLang(q.lang);
  if (!l.ok) return l;
  if (l.lang && t.type && t.type !== 'code') return { ok: false, error: LANG_NEEDS_CODE };
  return { ok: true, type: l.lang ? 'code' : t.type, lang: l.lang };
}

/** 유형·언어 필터를 순서대로 건다. 둘 다 null 이면 원본 사본 그대로다. */
function applyFilters(questions, f) {
  return rounds.filterByLang(rounds.filterByType(questions, f.type), f.lang);
}

const NO_QUESTIONS_OF_TYPE = '해당 유형의 문항이 없습니다.';
const NO_QUESTIONS_OF_LANG = '해당 언어의 문항이 없습니다.';

/** 필터 결과가 비었을 때 쓸 사유 — 언어까지 걸었으면 언어 쪽을 말해 준다. */
function emptyReason(f) {
  return f.lang ? NO_QUESTIONS_OF_LANG : NO_QUESTIONS_OF_TYPE;
}

app.get('/api/rounds', function (req, res) {
  res.json(rounds.listRounds());
});

app.get('/api/rounds/:id', function (req, res) {
  const round = rounds.getRound(req.params.id); // 인메모리 화이트리스트 — 경로 순회 불가
  if (!round) return res.status(404).json({ error: '없는 회차입니다.' });

  const f = parseFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });
  const questions = applyFilters(round.questions, f);
  if ((f.type || f.lang) && questions.length === 0) return res.status(400).json({ error: emptyReason(f) });

  res.json({
    round: round.round,
    title: round.title || round.round,
    sourceUrl: round.sourceUrl || '',
    type: f.type,
    lang: f.lang,
    questions: questions.map(rounds.publicQuestion), // 정답 계열 필드 제거
  });
});

/**
 * 제출 답안 정리: 주어진 문항 목록에 실제로 있는 문항 id 만, 필드 수만큼만, 문자열로.
 * 클라이언트가 뭘 보내든 채점기에 이상한 값이 들어가지 않게 한다.
 * (회차 채점과 모의고사/오답노트 채점이 같은 규칙을 쓰도록 문항 배열을 받는다.)
 */
function sanitizeAnswers(questions, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of questions) {
    const given = raw[q.id];
    if (!Array.isArray(given)) continue;
    out[q.id] = q.fields.map(function (_f, i) {
      const v = given[i];
      return typeof v === 'string' ? v.slice(0, 500) : '';
    });
  }
  return out;
}

/** 채점 결과 details → 틀린 문항 id 배열. study_results.wrong_ids 에 그대로 들어간다. */
function wrongIdsOf(details) {
  const out = [];
  for (const d of details || []) if (d.correct === false) out.push(d.questionId);
  return out;
}

app.post('/api/rounds/:id/grade', function (req, res) {
  const round = rounds.getRound(req.params.id);
  if (!round) return res.status(404).json({ error: '없는 회차입니다.' });

  // 유형을 지정하면 **그 부분집합만** 채점한다. 아래 questions 를 sanitizeAnswers·gradeSet·
  // study_results.question_ids 가 모두 공유하므로 총점·오답노트가 서로 어긋나지 않는다.
  // 언어까지 걸어 풀었다면 채점 집합도 같아야 한다 — 안 보내면 예전과 같은 동작(유형만).
  const f = parseFilters(req.body || {});
  if (!f.ok) return res.status(400).json({ error: f.error });
  const questions = applyFilters(round.questions, f);
  if (questions.length === 0) return res.status(400).json({ error: emptyReason(f) });

  const answers = sanitizeAnswers(questions, (req.body || {}).answers);
  const result = gradeSet(questions, answers);

  // 채점 이후에는 정답 표기(display)·지문 원문(bodyText)·해설(explanationHtml)을 내보내도 된다.
  // bodyText 는 "AI에게 질문하기" 프롬프트 조립용, explanations 는 "해설 보기" 용 —
  // 둘 다 채점 전에는 절대 내보내지 않는다(PROTOCOL.md "채점 전 비노출").
  const bodyTexts = {};
  const explanations = {};
  for (const q of questions) {
    bodyTexts[q.id] = q.bodyText == null ? '' : q.bodyText;
    explanations[q.id] = q.explanationHtml == null ? '' : q.explanationHtml;
  }

  if (req.user) {
    try {
      // 학습 이력·오답노트가 문항 단위로 되짚을 수 있도록 출제 문항과 틀린 문항을 함께 남긴다.
      // 유형 필터를 걸었다면 question_ids 도 그 부분집합이어야 오답노트가 어긋나지 않는다.
      db.saveStudyResult(req.user.id, round.round, result.score,
        questions.map(function (q) { return q.id; }), wrongIdsOf(result.details));
    } catch (e) {
      logErr('study 저장 실패', round.round, req.user.nickname, '-', e.message);
    }
  }
  log('grade', round.round + (f.type ? '/' + f.type : '') + (f.lang ? '/' + f.lang : ''),
    result.correctCount + '/' + result.totalCount,
    result.score + '점', req.user ? req.user.nickname : '(비로그인)');

  res.json({
    round: round.round, // 유형을 걸어도 회차 id 그대로다 (학습 이력 집계 키)
    type: f.type,
    lang: f.lang,
    correctCount: result.correctCount,
    totalCount: result.totalCount,
    score: result.score,
    details: result.details,
    bodyTexts: bodyTexts,
    explanations: explanations,
  });
});

// --------------------------------------- 학습 이력 · 오답노트 · 랜덤 모의고사

const HISTORY_SCAN_LIMIT = 1000;  // 집계를 위해 훑는 최대 기록 수
const HISTORY_RECENT_MAX = 20;    // 응답에 싣는 최근 기록 수
const PRACTICE_COUNT_MIN = 5;
const PRACTICE_COUNT_MAX = 60;
const PRACTICE_GRADE_MAX = 200;   // 한 번에 채점할 수 있는 문항 수 상한

/** study_results 의 id 컬럼(JSON 문자열) → 배열. 값이 없거나 깨졌으면 null(= 문항 단위 정보 없음). */
function parseIdColumn(v) {
  if (typeof v !== 'string' || v === '') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** 최신 먼저 정렬된 학습 기록. 조회 실패는 빈 이력으로 다룬다(이력은 부가 기능 — 500 을 내지 않는다). */
function studyRows(userId) {
  try {
    return db.listStudyResults(userId, HISTORY_SCAN_LIMIT);
  } catch (e) {
    logErr('study 이력 조회 실패', '#' + userId, '-', e.message);
    return [];
  }
}

/**
 * 현재 오답 문항 id 집합.
 * 문항별로 **가장 최근 판정**만 본다: 최신 기록부터 훑다가 그 문항을 처음 만나는 순간 결론이 나고
 * (wrong_ids 에 있으면 오답, question_ids 에만 있으면 해제) 그보다 오래된 기록은 무시한다.
 * question_ids 가 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.
 * 이미 읽어 둔 기록(최신 먼저)을 그대로 받는다 — 한 요청 안에서 이력을 여러 번 읽지 않기 위해서다.
 */
function wrongSetFromRows(rows) {
  const decided = new Set();
  const wrong = new Set();
  for (const row of rows) {
    const qids = parseIdColumn(row.question_ids);
    if (!qids) continue;
    const wrongSet = new Set(parseIdColumn(row.wrong_ids) || []);
    for (const qid of qids) {
      if (decided.has(qid)) continue;
      decided.add(qid);
      if (wrongSet.has(qid)) wrong.add(qid);
    }
  }
  return wrong;
}

/**
 * 사용자가 **채점 기록을 가진** 문항 id 집합.
 * `wrongSetFromRows` 의 decided 집합과 **똑같은 규칙**이다(정오는 보지 않고 출제 여부만 본다):
 * question_ids 가 있는 기록만 세고, 없는 예전 기록은 문항 단위 판정이 불가능하므로 건너뛴다.
 *
 * `/api/me/wrong/explain` 의 권한 검사에 쓴다 — "이미 한 번 채점받은 문항"이라는 뜻이므로
 * 그 문항의 정답·해설을 다시 보여 줘도 채점 전 노출이 아니다(PROTOCOL.md C5 예외).
 */
function gradedIdsOf(userId) {
  const decided = new Set();
  for (const row of studyRows(userId)) {
    const qids = parseIdColumn(row.question_ids);
    if (!qids) continue;
    for (const qid of qids) decided.add(qid);
  }
  return decided;
}

/**
 * 오답 집합 → 회차 순(rounds 정렬) → 문항 순으로 정렬된 id 배열.
 * 지금 데이터에 없는 문항 id 는 빠진다(회차 파일이 바뀌어도 오답노트가 깨지지 않는다).
 */
function orderedWrongIds(wrong) {
  const ordered = [];
  for (const meta of rounds.listRounds()) {
    const round = rounds.getRound(meta.round);
    if (!round) continue;
    for (const q of round.questions) if (wrong.has(q.id)) ordered.push(q.id);
  }
  return ordered;
}

/** 현재 오답 문항 id 목록(회차 순). */
function currentWrongIds(userId) {
  return orderedWrongIds(wrongSetFromRows(studyRows(userId)));
}

/** 내가 참가한 매치 목록. 조회 실패는 빈 목록으로 다룬다(이력과 같은 규칙 — 500 을 내지 않는다). */
function matchRows(userId) {
  try {
    return db.listMatchesByUser(userId);
  } catch (e) {
    logErr('대전 목록 조회 실패', '#' + userId, '-', e.message);
    return [];
  }
}

/**
 * 대전 학습 기록을 match_id 로 색인한다(매치 1건당 1행).
 * match_id 가 NULL 인 예전 행은 어느 대전인지 알 수 없으므로 빠진다 —
 * `scripts/backfill-battle-notes.mjs` 가 그런 행을 소급해 채운다.
 */
function battleStudyByMatch(rows) {
  const map = new Map();
  for (const row of rows) {
    if (row.round !== dbModule.BATTLE_ROUND) continue;
    if (row.match_id == null) continue;
    const mid = Number(row.match_id);
    if (map.has(mid)) continue; // 최신 먼저 — 처음 만난 행이 그 매치의 기록이다
    map.set(mid, row);
  }
  return map;
}

/** 나(userId) 기준 승/패/무. winner_user_id 가 NULL 이면 무승부다(SCHEMA "승자 판정 체인"). */
function matchResultOf(match, userId) {
  if (match.winner_user_id == null) return 'draw';
  return Number(match.winner_user_id) === Number(userId) ? 'win' : 'lose';
}

/**
 * 대전 한 건의 머리말 정보(문항 내용 없이).
 * `/api/me/wrong/summary` 의 byBattle 항목과 `/api/me/wrong?match=` 의 battle 블록이
 * 같은 모양을 쓰도록 한 곳에서 만든다. 상대의 보관 답안은 애초에 조회하지 않는다.
 */
function battleInfo(match, userId, studyRow) {
  const players = match.players || [];
  const me = players.find(function (p) { return Number(p.user_id) === Number(userId); }) || null;
  return {
    matchId: Number(match.id),
    roomName: match.room_name,
    finishedAt: match.finished_at,
    mode: match.mode,
    roundIds: parseIdColumn(match.round_ids) || [],
    questionCount: (parseIdColumn(match.question_ids) || []).length,
    me: {
      correctCount: me ? me.correct_count : null,
      score: studyRow ? studyRow.score : null,
    },
    opponents: players
      .filter(function (p) { return Number(p.user_id) !== Number(userId); })
      .map(function (p) {
        return { nickname: p.nickname == null ? '(알 수 없음)' : p.nickname, correctCount: p.correct_count };
      }),
    result: matchResultOf(match, userId),
  };
}

app.get('/api/me/history', auth.requireAuth, function (req, res) {
  const rows = studyRows(req.user.id); // 최신 먼저
  const bySet = {};
  const recent = [];

  for (const row of rows) {
    const qids = parseIdColumn(row.question_ids);
    const wrongIds = parseIdColumn(row.wrong_ids);
    // 문항 수/정답 수는 컬럼이 있을 때만 셀 수 있다. 예전 기록은 점수만 남아 있으므로 null.
    const total = qids ? qids.length : null;
    const correct = qids ? qids.length - (wrongIds ? wrongIds.length : 0) : null;

    let agg = bySet[row.round];
    if (!agg) {
      // 최신 먼저 훑으므로 그 집합에서 처음 만난 기록이 곧 마지막 기록이다
      agg = bySet[row.round] = { count: 0, best: row.score, last: row.score, lastAt: row.taken_at };
    }
    agg.count += 1;
    if (row.score > agg.best) agg.best = row.score;

    if (recent.length < HISTORY_RECENT_MAX) {
      const entry = {
        round: row.round, score: row.score, takenAt: row.taken_at, total: total, correct: correct,
      };
      // 대전 행은 어느 방이었는지까지 실어 준다 — 목록에서 "대전 · <방이름>" 으로 보이게.
      if (row.round === dbModule.BATTLE_ROUND && row.match_id != null) {
        entry.matchId = Number(row.match_id);
        entry.roomName = null; // 아래에서 방 이름을 채운다
      }
      recent.push(entry);
    }
  }

  if (recent.some(function (r) { return r.matchId != null; })) {
    const nameById = new Map(matchRows(req.user.id).map(function (m) { return [Number(m.id), m.room_name]; }));
    for (const r of recent) {
      if (r.matchId == null) continue;
      r.roomName = nameById.has(r.matchId) ? nameById.get(r.matchId) : null;
    }
  }

  res.json({ rounds: bySet, recent: recent, wrongCount: orderedWrongIds(wrongSetFromRows(rows)).length });
});

/**
 * 오답노트 허브 요약 — 지금 오답을 **회차별**로, 지난 대전을 **대전별**로 묶어 한 번에 준다.
 *
 * `/api/me/wrong` 보다 **먼저** 등록한다(경로가 가려지지 않도록).
 * 문항 내용은 공개 필드(id/num/prompt/type)만 나간다 — 정답 계열 필드는 여기서도 절대 나가지 않는다.
 * `stillWrong`/`stillWrongCount` 는 "지금도 오답인가"라는 **정오 이력**이지 정답 정보가 아니다.
 */
app.get('/api/me/wrong/summary', auth.requireAuth, function (req, res) {
  const rows = studyRows(req.user.id); // 최신 먼저
  const wrong = wrongSetFromRows(rows);

  // ── 회차별: rounds 정렬 그대로, 오답이 있는 회차만
  const byRound = [];
  let total = 0;
  for (const meta of rounds.listRounds()) {
    const round = rounds.getRound(meta.round);
    if (!round) continue;
    const mine = round.questions.filter(function (q) { return wrong.has(q.id); });
    if (mine.length === 0) continue;
    total += mine.length;
    byRound.push({
      round: round.round,
      title: round.title || round.round,
      count: mine.length,
      counts: rounds.countTypes(mine),
      langs: rounds.countLangs(mine), // 허브의 언어 칩이 "0개 언어"를 비활성으로 둘 수 있도록
    });
  }

  // ── 대전별: 최신 먼저. match_id 로 이어지지 않는 예전 기록은 여기서만 빠지고 회차별 집계에는 그대로 든다.
  const byMatch = battleStudyByMatch(rows);
  const byBattle = [];
  for (const match of matchRows(req.user.id)) {
    const row = byMatch.get(Number(match.id));
    if (!row) continue;
    const wrongIds = parseIdColumn(row.wrong_ids) || [];
    let stillWrongCount = 0;
    const wrongQuestions = [];
    for (const qid of wrongIds) {
      const stillWrong = wrong.has(qid);
      if (stillWrong) stillWrongCount += 1;
      const q = rounds.getQuestion(qid);
      if (!q) continue; // 지금 데이터에 없는 문항은 보여줄 수 없다
      wrongQuestions.push({
        id: q.id,
        num: q.num,
        prompt: q.prompt == null ? '' : q.prompt,
        type: rounds.typeOf(q),
        lang: rounds.langOf(q),
        stillWrong: stillWrong,
      });
    }
    byBattle.push(Object.assign(battleInfo(match, req.user.id, row), {
      wrongCount: wrongIds.length,
      stillWrongCount: stillWrongCount,
      wrongQuestions: wrongQuestions,
    }));
  }
  byBattle.reverse(); // listMatchesByUser 는 오래된 것 먼저 — 응답은 최신 먼저다

  res.json({ total: total, byRound: byRound, byBattle: byBattle });
});

/**
 * `?match=<id>` — **그 대전에서 틀린 문항 전부**(지금은 맞힌 것도 포함)를 과거 스냅샷 그대로 돌려준다.
 * `?round=` 가 "지금 오답"인 것과 대비된다. 남의 매치·없는 매치는 404 다(존재 여부도 알려주지 않는다).
 */
function wrongByMatch(req, res, rawMatch, f) {
  if (!/^\d+$/.test(rawMatch)) return res.status(400).json({ error: '대전 id 는 정수여야 합니다.' });
  const matchId = Number(rawMatch);
  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    return res.status(400).json({ error: '대전 id 는 정수여야 합니다.' });
  }

  // 내가 참가한 매치만 조회하므로 남의 매치 id 는 자연히 404 가 된다.
  const match = matchRows(req.user.id).find(function (m) { return Number(m.id) === matchId; });
  if (!match) return res.status(404).json({ error: '없는 대전입니다.' });

  const rows = studyRows(req.user.id);
  const row = battleStudyByMatch(rows).get(matchId);
  if (!row) return res.status(404).json({ error: '이 대전의 문항 기록이 없습니다.' });

  const wrong = wrongSetFromRows(rows);
  const questions = [];
  const resolvedIds = [];
  for (const qid of parseIdColumn(row.wrong_ids) || []) {
    const q = rounds.getQuestion(qid);
    if (!q) continue;
    if (f.type && rounds.typeOf(q) !== f.type) continue;
    if (f.lang && rounds.langOf(q) !== f.lang) continue;
    questions.push(rounds.publicQuestion(q)); // 정답 계열 필드 제거
    if (!wrong.has(qid)) resolvedIds.push(qid); // 그 뒤에 맞혀서 지금은 오답이 아닌 문항
  }

  res.json({
    setKey: 'wrong',
    title: '오답노트 · 대전 ' + match.room_name,
    type: f.type,
    lang: f.lang,
    match: matchId,
    battle: battleInfo(match, req.user.id, row),
    resolvedIds: resolvedIds,
    questions: questions,
  });
}

const EXPLAIN_IDS_MAX = 50; // 한 번에 조회할 수 있는 문항 수 상한

/**
 * 오답노트 전용 **채점 전 해설 조회** (handoff C5).
 *
 * PROTOCOL.md 의 "채점 전 비노출"에 대한 **유일한 예외**다. 오답노트에 뜨는 문항은 정의상
 * 그 사용자가 이미 채점받은 문항이므로, 정답 표기(display)와 해설(explanationHtml)을 다시
 * 보여 줘도 새로 새는 정보가 없다. 권한 검사는 클라이언트 말이 아니라 **서버가 가진
 * 채점 이력**(gradedIdsOf)으로 한다.
 *
 *   GET /api/me/wrong/explain?ids=2024-1#1,2024-1#2   (1~50개)
 *   → { explanations: { [qid]: { display: string, html: string } } }
 *
 * 채점 이력에 없는 문항·없는 문항 id 는 **조용히 생략**한다(403 이 아니다 —
 * 어떤 문항이 존재하는지·남이 뭘 풀었는지 알려주지 않기 위해서다).
 *
 * `/api/me/wrong` 보다 **먼저** 등록한다(요약 라우트와 같은 규칙).
 */
app.get('/api/me/wrong/explain', auth.requireAuth, function (req, res) {
  const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
  const parts = raw.split(',');
  // 상한 검사를 **중복 제거보다 먼저** 한다. 그러지 않으면 헤더 한계까지 채운 ids 로
  // 중복 제거 비용을 먼저 치르게 된다 — 여기서 끊으면 거절 비용이 split 한 번으로 끝난다.
  if (parts.length > EXPLAIN_IDS_MAX) {
    return res.status(400).json({ error: '한 번에 ' + EXPLAIN_IDS_MAX + '개까지만 조회할 수 있습니다.' });
  }
  const seen = new Set();
  const ids = [];
  for (const part of parts) {
    const id = part.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return res.status(400).json({ error: '문항 id 가 필요합니다.' });

  const graded = gradedIdsOf(req.user.id);
  const explanations = {};
  let served = 0;
  for (const qid of ids) {
    if (!graded.has(qid)) continue;            // 채점 기록 없음 — 조용히 생략
    const q = rounds.getQuestion(qid);
    if (!q) continue;                          // 지금 데이터에 없는 문항 — 조용히 생략
    explanations[qid] = {
      display: q.display == null ? '' : q.display,
      html: rounds.explanationOf(qid),
    };
    served += 1;
  }

  log('wrong explain', served + '/' + ids.length + '문항', req.user.nickname);
  res.json({ explanations: explanations });
});

app.get('/api/me/wrong', auth.requireAuth, function (req, res) {
  const f = parseFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });

  const rawRound = typeof req.query.round === 'string' ? req.query.round.trim() : '';
  const rawMatch = typeof req.query.match === 'string' ? req.query.match.trim() : '';
  // 둘은 서로 다른 관점(현재 상태 / 과거 스냅샷)이라 섞을 수 없다.
  if (rawRound !== '' && rawMatch !== '') {
    return res.status(400).json({ error: 'round 와 match 는 함께 지정할 수 없습니다.' });
  }
  if (rawMatch !== '') return wrongByMatch(req, res, rawMatch, f);

  let round = null;
  let inRound = null;
  if (rawRound !== '') {
    round = rounds.getRound(rawRound); // 인메모리 화이트리스트 — 경로 순회 불가
    if (!round) return res.status(400).json({ error: '없는 회차입니다: ' + rawRound });
    inRound = new Set(round.questions.map(function (q) { return q.id; }));
  }

  // 오답이 하나도 없는 상태가 정상이므로 빈 목록은 400 이 아니다(유형·회차 필터도 마찬가지).
  const questions = [];
  for (const qid of currentWrongIds(req.user.id)) {
    const q = rounds.getQuestion(qid);
    if (!q) continue;
    if (inRound && !inRound.has(qid)) continue;
    if (f.type && rounds.typeOf(q) !== f.type) continue;
    if (f.lang && rounds.langOf(q) !== f.lang) continue;
    questions.push(rounds.publicQuestion(q)); // 정답 계열 필드 제거
  }
  res.json({
    setKey: 'wrong',
    title: round ? '오답노트 · ' + (round.title || round.round) : '오답노트',
    type: f.type,
    lang: f.lang,
    round: round ? round.round : null,
    questions: questions,
  });
});

app.get('/api/practice', function (req, res) {
  const f = parseFilters(req.query);
  if (!f.ok) return res.status(400).json({ error: f.error });

  const rawCount = typeof req.query.count === 'string' ? req.query.count.trim() : '';
  const count = /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  if (!Number.isInteger(count) || count < PRACTICE_COUNT_MIN || count > PRACTICE_COUNT_MAX) {
    return res.status(400).json({
      error: '문항 수는 ' + PRACTICE_COUNT_MIN + '~' + PRACTICE_COUNT_MAX + ' 사이의 정수여야 합니다.',
    });
  }

  const rawRounds = typeof req.query.rounds === 'string' ? req.query.rounds.trim() : '';
  let roundIds;
  if (rawRounds === '' || rawRounds === 'all') {
    roundIds = rounds.listRounds().map(function (r) { return r.round; });
  } else {
    roundIds = [];
    for (const part of rawRounds.split(',')) {
      const id = part.trim();
      if (id === '') continue;
      if (!rounds.hasRound(id)) return res.status(400).json({ error: '없는 회차입니다: ' + id });
      if (roundIds.indexOf(id) === -1) roundIds.push(id); // 중복 회차는 한 번만
    }
  }
  if (roundIds.length === 0) return res.status(400).json({ error: '회차를 하나 이상 선택해야 합니다.' });

  // 대전의 random 출제와 같은 규칙(회차별 균등 배분 + 나머지 무작위)을 그대로 쓴다.
  // 유형·언어 필터는 **출제 전에 풀을 좁히는 것**으로 끝난다 — 풀이 count 보다 적으면
  // buildQuestionSet 이 내는 한국어 사유("유효 문항 총합…")가 그대로 400 이 된다.
  const built = battle.buildQuestionSet({
    mode: 'random',
    rounds: roundIds.map(function (id) {
      const r = rounds.getRound(id);
      return { round: r.round, questions: applyFilters(r.questions, f) };
    }),
    questionCount: count,
  });
  if (!built.ok) return res.status(400).json({ error: built.error }); // 유효 문항 총합 부족 등

  log('practice', roundIds.length + '회차', built.questions.length + '문항',
    f.type || '전체', f.lang || '', req.user ? req.user.nickname : '(비로그인)');

  res.json({
    setKey: 'practice',
    title: '랜덤 모의고사 · ' + roundIds.length + '회차 ' + built.questions.length + '문항',
    roundIds: roundIds,
    type: f.type,
    lang: f.lang,
    questions: built.questions.map(rounds.publicQuestion), // 정답 계열 필드 제거
  });
});

/**
 * 모의고사/오답노트 채점. 회차가 고정돼 있지 않으므로 **제출한 답안의 키**로 문항 집합을 복원한다.
 * (문항 id 는 전역 화이트리스트로만 조회하므로 모르는 id 는 그냥 빠진다.)
 * 응답 형태는 회차 채점과 같다 — 프런트가 같은 결과 화면을 쓴다.
 */
app.post('/api/practice/grade', function (req, res) {
  const body = req.body || {};
  const setKey = body.setKey === 'practice' || body.setKey === 'wrong' ? body.setKey : null;
  if (!setKey) return res.status(400).json({ error: '알 수 없는 문제 집합입니다.' });

  const raw = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const questions = [];
  for (const qid of Object.keys(raw)) {
    if (questions.length >= PRACTICE_GRADE_MAX) break;
    const q = rounds.getQuestion(qid);
    if (q) questions.push(q);
  }
  if (questions.length === 0) return res.status(400).json({ error: '채점할 문항이 없습니다.' });

  const answers = sanitizeAnswers(questions, raw);
  const result = gradeSet(questions, answers);

  // 채점 후에만 나가는 부가 자산 — 회차 채점과 같은 규칙이다.
  const bodyTexts = {};
  const explanations = {};
  for (const q of questions) {
    bodyTexts[q.id] = q.bodyText == null ? '' : q.bodyText;
    explanations[q.id] = q.explanationHtml == null ? '' : q.explanationHtml;
  }

  if (req.user) {
    try {
      db.saveStudyResult(req.user.id, setKey, result.score,
        questions.map(function (q) { return q.id; }), wrongIdsOf(result.details));
    } catch (e) {
      logErr('study 저장 실패', setKey, req.user.nickname, '-', e.message);
    }
  }
  log('grade', setKey, result.correctCount + '/' + result.totalCount,
    result.score + '점', req.user ? req.user.nickname : '(비로그인)');

  res.json({
    round: setKey,
    correctCount: result.correctCount,
    totalCount: result.totalCount,
    score: result.score,
    details: result.details,
    bodyTexts: bodyTexts,
    explanations: explanations,
  });
});

// ------------------------------------------------------------- 이의 제기

/** 읽기-수정-쓰기. 동기 I/O 라 요청 사이에 끼어들 수 없고, 교체는 rename 으로 원자적이다. */
function appendReport(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
    if (Array.isArray(parsed)) list = parsed;
    else logErr('reports.json 이 배열이 아닙니다 — 새 배열로 시작합니다.');
  } catch (e) {
    if (e.code !== 'ENOENT') logErr('reports.json 읽기 실패 — 새 배열로 시작합니다:', e.message);
  }
  list.push(entry);
  const tmp = REPORTS_FILE + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, REPORTS_FILE);
  return list.length;
}

app.post('/api/reports', function (req, res) {
  const body = req.body || {};
  const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : '';
  if (!questionId) return res.status(400).json({ error: '문항 id 가 필요합니다.' });
  if (!rounds.getQuestion(questionId)) return res.status(400).json({ error: '없는 문항입니다.' });

  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
  if (!comment) return res.status(400).json({ error: '어떤 점이 이상한지 적어 주세요.' });

  const myAnswer = Array.isArray(body.myAnswer)
    ? body.myAnswer.map(function (v) { return typeof v === 'string' ? v.slice(0, 500) : ''; })
    : typeof body.myAnswer === 'string' ? body.myAnswer.slice(0, 500) : '';

  try {
    const total = appendReport({
      at: new Date().toISOString(),
      questionId: questionId,
      myAnswer: myAnswer,
      comment: comment,
      byUserId: req.user ? req.user.id : null,
    });
    log('report', questionId, 'by', req.user ? req.user.nickname : '(비로그인)', '- 누적', total + '건');
    res.json({ ok: true });
  } catch (e) {
    logErr('report 저장 실패', questionId, '-', e.message);
    res.status(500).json({ error: '신고 저장에 실패했습니다.' });
  }
});

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
      return;
    }
    logErr('battle-io.js 로드 실패 — 학습 모드만 제공합니다:', e.message);
    return;
  }
  try {
    const ctx = { app: app, server: server, io: io, db: db, rounds: rounds, auth: auth, log: log };
    if (typeof mod === 'function') mod(ctx);
    else if (mod && typeof mod.attach === 'function') mod.attach(ctx);
    log('battle-io.js 연결 완료');
  } catch (e) {
    logErr('battle-io.js 초기화 실패 — 학습 모드만 제공합니다:', e.message);
  }
}

attachBattleIo();

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

function printBanner(port) {
  const urls = accessUrls(port);
  const width = urls.reduce(function (m, u) { return Math.max(m, u.label.length); }, 0);
  console.log('');
  console.log('  정처기 배틀 서버 기동 (' + db.kind + ' 어댑터, 회차 ' + rounds.listRounds().length + '개)');
  for (const u of urls) console.log('  ' + u.label.padEnd(width + 2) + u.url);
  console.log('');
  console.log('  종료: Ctrl+C   /   다른 기기에서 접속하려면 방화벽 인바운드 허용이 필요합니다.');
  console.log('');
}

function start(port) {
  const p = port || PORT;
  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      logErr('포트 ' + p + ' 이(가) 이미 사용 중입니다. 다른 프로그램을 종료하거나 PORT=' + (p + 1) + ' 로 실행하세요.');
      process.exit(1);
    }
    logErr('서버 오류:', err.message);
    process.exit(1);
  });
  server.listen(p, function () { printBanner(p); });
  return server;
}

if (require.main === module) start();
