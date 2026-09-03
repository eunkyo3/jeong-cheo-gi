'use strict';
/**
 * routes/admin.js — 관리자 페이지 REST (`/api/admin/*`).
 *
 * 전부 읽기 전용이다. 관리자 화면은 데이터를 **보기만** 하고 고치지 않는다.
 * 로그인·로그아웃을 뺀 모든 경로는 admin.requireAdmin 뒤에 있다(쿠키 없으면 401 JSON).
 *
 *   POST /api/admin/login    {id, password} → 쿠키 발급. IP 당 1분 5회 제한.
 *   POST /api/admin/logout   쿠키 삭제. 로그인 상태가 아니어도 200.
 *   GET  /api/admin/me       현재 관리자 세션
 *   GET  /api/admin/stats    전체 통계 한 판
 *   GET  /api/admin/users    ?limit&offset&q   (비밀번호 해시는 어떤 필드로도 나가지 않는다)
 *   GET  /api/admin/matches  ?limit&offset
 *   GET  /api/admin/reports  ?limit&offset
 *   GET  /api/admin/rooms    진행 중인 대전 방
 *   GET  /api/admin/study    ?limit&offset&userId
 *
 * 다른 레인이 만드는 것에 의존하는 두 곳은 **있으면 쓰고 없으면 "준비 중"** 으로 답한다.
 * 서버가 죽지 않게 하려는 것이다.
 *   - `server/reports.js` 의 listReports  (없으면 DATA_DIR 의 reports.jsonl → reports.json 순으로 직접 읽는다)
 *   - `ctx.battleIo.listRooms()`          (없으면 battleIo.rooms 맵에서 직접 조립한다)
 *
 * @param {object} app express 앱
 * @param {object} ctx index.js 가 만든 배선 묶음
 */

const fs = require('node:fs');
const path = require('node:path');
const admin = require('../admin.js');

/** 페이지 인자 — limit 은 1~100, offset 은 0 이상. */
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 20;

function pageOf(req) {
  let limit = Number(req.query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = LIMIT_DEFAULT;
  limit = Math.min(Math.floor(limit), LIMIT_MAX);
  let offset = Number(req.query.offset);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit: limit, offset: Math.floor(offset) };
}

/** 로그에 남기는 관리자 아이디 길이 상한 — 로그 오염을 막는다. */
const ID_LOG_MAX = 40;

/**
 * 로그에 실을 수 있게 다듬은 아이디. `routes/auth.js` 의 `nickForLog` 와 같은 규약이다.
 * 제어문자(개행·ESC 등)는 로그 인젝션의 통로라 물음표로 바꿔 **한 줄을 유지한다**.
 * 코드포인트 단위로 세어 자르므로 서로게이트 짝이 반쪽만 남지 않는다.
 */
function idForLog(v) {
  let out = '';
  let n = 0;
  for (const ch of String(v == null ? '' : v)) {
    if (n >= ID_LOG_MAX) break;
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) ? '?' : ch;
    n += 1;
  }
  return out;
}

/** 아직 붙지 않은 기능에 대한 공통 응답. 500 이 아니라 200 + 빈 목록이다. */
function pending(res, what) {
  res.json({ items: [], total: 0, pending: true, note: what + ' 준비 중입니다.' });
}

module.exports = function mount(app, ctx) {
  const db = ctx.db;
  const rounds = ctx.rounds;
  const log = ctx.log;
  const logErr = ctx.logErr;
  const DATA_DIR = ctx.DATA_DIR;
  const startedAt = Date.now();

  admin.warnDefaultPassword(log); // 기본 비밀번호로 뜨면 기동 로그에 한 줄 남는다

  const loginLimiter = admin.makeLoginLimiter(logErr);

  // ------------------------------------------------------------ 신고 목록
  //
  // 레인 A 의 server/reports.js 가 붙으면 그걸 쓴다. 아직 없으면 파일을 직접 읽는다
  // (jsonl 우선, 없으면 예전 배열 json). 둘 다 없으면 빈 목록이다.

  function loadReportsModule() {
    try {
      const m = require('../reports.js');
      return m && typeof m.listReports === 'function' ? m : null;
    } catch {
      return null;
    }
  }

  function readReportsFile(page) {
    const jsonl = path.join(DATA_DIR, 'reports.jsonl');
    const json = path.join(DATA_DIR, 'reports.json');
    let all = [];
    try {
      all = fs.readFileSync(jsonl, 'utf8').split('\n')
        .map(function (l) { return l.trim(); })
        .filter(Boolean)
        .map(function (l) { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code !== 'ENOENT') logErr('reports.jsonl 읽기 실패 -', e.message);
      try {
        const parsed = JSON.parse(fs.readFileSync(json, 'utf8'));
        if (Array.isArray(parsed)) all = parsed;
      } catch (e2) {
        if (e2.code !== 'ENOENT') logErr('reports.json 읽기 실패 -', e2.message);
      }
    }
    const newestFirst = all.slice().reverse();
    return { items: newestFirst.slice(page.offset, page.offset + page.limit), total: all.length };
  }

  // ------------------------------------------------------- 진행 중인 방
  //
  // 레인 C 의 listRooms() 가 붙으면 그걸 쓴다. 없으면 battleIo.rooms(Map)에서 직접 만든다.

  function liveRooms() {
    const io = ctx.battleIo;
    if (!io) return null;
    if (typeof io.listRooms === 'function') {
      try {
        const list = io.listRooms();
        return Array.isArray(list) ? list : [];
      } catch (e) {
        logErr('battleIo.listRooms 실패 -', e.message);
        return [];
      }
    }
    if (!io.rooms || typeof io.rooms.values !== 'function') return null;
    const out = [];
    for (const s of io.rooms.values()) {
      if (!s) continue;
      const players = s.players && typeof s.players === 'object' ? Object.keys(s.players).length : 0;
      out.push({
        id: s.roomId,
        name: s.name,
        state: s.state,
        hostUserId: s.hostUserId == null ? null : s.hostUserId,
        players: players,
        createdAt: s.createdAt == null ? null : s.createdAt,
      });
    }
    return out;
  }

  function roomCount() {
    const io = ctx.battleIo;
    if (io && typeof io.roomCount === 'function') {
      try { return Number(io.roomCount()) || 0; } catch { /* 아래로 */ }
    }
    const list = liveRooms();
    return list == null ? null : list.length;
  }

  // ---------------------------------------------------------------- 로그인

  app.post('/api/admin/login', loginLimiter, function (req, res) {
    const body = req.body || {};
    const id = typeof body.id === 'string' ? body.id : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!admin.login(id, password)) {
      logErr('admin 로그인 실패 id=' + idForLog(id));
      // 아이디가 틀렸는지 비밀번호가 틀렸는지 구분해 주지 않는다
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }
    admin.setAdminCookie(res);
    log('admin 로그인 성공');
    res.json({ ok: true, id: admin.ADMIN_ID });
  });

  app.post('/api/admin/logout', function (req, res) {
    admin.clearAdminCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', admin.requireAdmin, function (req, res) {
    res.json({ ok: true, id: req.admin.id, since: req.admin.iat, maxAgeS: admin.MAX_AGE_S });
  });

  // ------------------------------------------------------------------ 통계

  app.get('/api/admin/stats', admin.requireAdmin, function (req, res) {
    let counts = null;
    if (typeof db.adminCounts === 'function') {
      try {
        counts = db.adminCounts();
      } catch (e) {
        logErr('adminCounts 실패 -', e.message);
      }
    }

    let roundCount = 0;
    let questionCount = 0;
    try {
      roundCount = rounds.listRounds().length;
      questionCount = rounds.allQuestions().length;
    } catch (e) {
      logErr('회차 통계 실패 -', e.message);
    }

    res.json({
      db: {
        adapter: db.kind || '(알 수 없음)',
        available: counts != null,
        users: counts ? counts.users : null,
        matches: counts ? counts.matches : null,
        matchPlayers: counts ? counts.matchPlayers : null,
        studyResults: counts ? counts.studyResults : null,
      },
      content: { rounds: roundCount, questions: questionCount },
      battle: { activeRooms: roomCount() },
      server: {
        uptimeS: Math.floor((Date.now() - startedAt) / 1000),
        processUptimeS: Math.floor(process.uptime()),
        node: process.version,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
      },
    });
  });

  // ---------------------------------------------------------------- 사용자

  app.get('/api/admin/users', admin.requireAdmin, function (req, res) {
    if (typeof db.adminListUsers !== 'function') return pending(res, '사용자 조회가');
    const page = pageOf(req);
    try {
      const r = db.adminListUsers({ limit: page.limit, offset: page.offset, q: req.query.q });
      res.json({ items: r.items, total: r.total, limit: page.limit, offset: page.offset });
    } catch (e) {
      logErr('adminListUsers 실패 -', e.message);
      res.status(500).json({ error: '사용자 목록을 불러오지 못했습니다.' });
    }
  });

  // ------------------------------------------------------------------ 대전

  app.get('/api/admin/matches', admin.requireAdmin, function (req, res) {
    if (typeof db.adminListMatches !== 'function') return pending(res, '대전 조회가');
    const page = pageOf(req);
    try {
      const r = db.adminListMatches({ limit: page.limit, offset: page.offset });
      res.json({ items: r.items, total: r.total, limit: page.limit, offset: page.offset });
    } catch (e) {
      logErr('adminListMatches 실패 -', e.message);
      res.status(500).json({ error: '대전 목록을 불러오지 못했습니다.' });
    }
  });

  // ------------------------------------------------------------- 학습 기록

  app.get('/api/admin/study', admin.requireAdmin, function (req, res) {
    if (typeof db.adminListStudy !== 'function') return pending(res, '학습 기록 조회가');
    const page = pageOf(req);
    const rawUser = req.query.userId;
    let userId = null;
    if (rawUser !== undefined && String(rawUser) !== '') {
      const n = Number(rawUser);
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'userId 는 양의 정수여야 합니다.' });
      userId = n;
    }
    try {
      const r = db.adminListStudy({ limit: page.limit, offset: page.offset, userId: userId });
      res.json({ items: r.items, total: r.total, limit: page.limit, offset: page.offset, userId: userId });
    } catch (e) {
      logErr('adminListStudy 실패 -', e.message);
      res.status(500).json({ error: '학습 기록을 불러오지 못했습니다.' });
    }
  });

  // ------------------------------------------------------------------ 신고

  app.get('/api/admin/reports', admin.requireAdmin, function (req, res) {
    const page = pageOf(req);
    const mod = loadReportsModule();
    try {
      // dir 을 명시한다 — 모듈 기본값은 DATA_DIR env 를 읽지만 ctx 쪽이 단일 출처다
      const r = mod
        ? mod.listReports({ dir: DATA_DIR, limit: page.limit, offset: page.offset })
        : readReportsFile(page);
      res.json({
        items: Array.isArray(r && r.items) ? r.items : [],
        total: Number(r && r.total) || 0,
        limit: page.limit,
        offset: page.offset,
        source: mod ? 'module' : 'file',
      });
    } catch (e) {
      logErr('신고 목록 조회 실패 -', e.message);
      res.status(500).json({ error: '신고 목록을 불러오지 못했습니다.' });
    }
  });

  // ------------------------------------------------------------ 진행 중 방

  app.get('/api/admin/rooms', admin.requireAdmin, function (req, res) {
    const list = liveRooms();
    if (list == null) return pending(res, '대전 방 조회가');
    res.json({ items: list, total: list.length });
  });

  return { pageOf: pageOf, LIMIT_MAX: LIMIT_MAX, LIMIT_DEFAULT: LIMIT_DEFAULT };
};
