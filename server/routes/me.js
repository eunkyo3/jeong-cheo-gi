'use strict';
/**
 * routes/me.js — 내 학습 이력·오답노트 REST (`/api/me/*`).
 *
 * index.js 에서 그대로 옮긴 라우트다. 등록 순서·응답 형태 모두 예전과 같다.
 * **등록 순서가 계약이다**: `/api/me/wrong/summary`·`/api/me/wrong/explain` 을
 * `/api/me/wrong` 보다 **먼저** 등록해야 경로가 가려지지 않는다.
 *
 * 집계 로직은 전부 `server/wrongnote.js` 에 있다 — 여기서는 요청 해석과 응답 조립만 한다.
 *
 * @param {object} app express 앱
 * @param {{rounds:object, auth:object, wrongnote:object, log:function, logErr:function}} ctx
 */

const filters = require('../filters.js');
const dbModule = require('../db.js');
const settoken = require('../settoken.js');
const battlelock = require('../battlelock.js');

const HISTORY_RECENT_MAX = 20;    // 응답에 싣는 최근 기록 수
const EXPLAIN_IDS_MAX = 50;       // 한 번에 조회할 수 있는 문항 수 상한

module.exports = function mount(app, ctx) {
  const db = ctx.db;
  const rounds = ctx.rounds;
  const auth = ctx.auth;
  const log = ctx.log;
  const logErr = ctx.logErr;
  const wrongnote = ctx.wrongnote;

  const studyRows = wrongnote.studyRows;
  const matchRows = wrongnote.matchRows;
  const parseIdColumn = wrongnote.parseIdColumn;
  const wrongSetFromRows = wrongnote.wrongSetFromRows;
  const orderedWrongIds = wrongnote.orderedWrongIds;
  const currentWrongIds = wrongnote.currentWrongIds;
  const gradedIdsOf = wrongnote.gradedIdsOf;
  const battleStudyByMatch = wrongnote.battleStudyByMatch;
  const battleInfo = wrongnote.battleInfo;
  const SCAN_LIMIT = wrongnote.HISTORY_SCAN_LIMIT;

  // 대전 잠금 판정은 `server/battlelock.js` 한 곳에만 있다 (routes/study.js 와 같은 객체 계약).
  const lock = battlelock.create(ctx);

  /**
   * 회차별 최고점을 **DB 에게** 묻는다. `studyRows` 는 최근 SCAN_LIMIT 건만 훑으므로,
   * 기록이 그보다 많으면 스캔으로 구한 best 는 조용히 틀린다(서버 M-10).
   * 조회가 안 되면 null 을 돌려주고 호출부가 스캔값을 그대로 쓴다 — 이력은 부가 기능이다.
   * @returns {Map<string, number>|null}
   */
  function bestByRound(userId) {
    try {
      const rows = db.bestScoresByRound(userId);
      if (!Array.isArray(rows)) return null;
      const out = new Map();
      for (const r of rows) out.set(r.round, r.best);
      return out;
    } catch (e) {
      logErr('회차별 최고점 조회 실패', '#' + userId, '-', e.message);
      return null;
    }
  }

  /**
   * 매치 id → 방 이름. 전체 매치 목록(참가자·문항 id 까지 딸려 온다)을 끌어오는 대신
   * 필요한 id 만 묻는다(서버 M-3). 실패하면 이름 없이 간다.
   * @returns {Map<number, string>}
   */
  function matchNames(ids) {
    try {
      const rows = db.listMatchNames(ids);
      return new Map((Array.isArray(rows) ? rows : []).map(function (m) { return [Number(m.id), m.room_name]; }));
    } catch (e) {
      logErr('대전 이름 조회 실패', '-', e.message);
      return new Map();
    }
  }

  // ------------------------------------------------------------- 학습 이력

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

    const needNames = recent.filter(function (r) { return r.matchId != null; }).map(function (r) { return r.matchId; });
    if (needNames.length > 0) {
      const nameById = matchNames(needNames);
      for (const r of recent) {
        if (r.matchId == null) continue;
        r.roomName = nameById.has(r.matchId) ? nameById.get(r.matchId) : null;
      }
    }

    // 최고점은 스캔 상한과 무관하게 정확해야 한다 — 되면 DB 집계로 덮어쓴다.
    const best = bestByRound(req.user.id);
    if (best) {
      for (const key of Object.keys(bySet)) {
        if (best.has(key)) bySet[key].best = best.get(key);
      }
    }

    res.json({
      rounds: bySet,
      recent: recent,
      wrongCount: orderedWrongIds(wrongSetFromRows(rows)).length,
      // 기록이 스캔 상한에 닿았다 = count·wrongCount 가 최근 SCAN_LIMIT 건 기준이라는 뜻이다.
      // 조용히 틀린 숫자를 보여 주느니 잘렸다는 사실을 알린다(서버 M-10).
      truncated: rows.length >= SCAN_LIMIT,
    });
  });

  // ---------------------------------------------------------- 오답노트 허브

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
   * **지금 진행 중인 대전에 걸린 문항도 같은 규칙으로 생략한다.** 채점 이력만 보던 시절에는
   * 이 경로가 대전 중 정답 오라클이었다(Phase 3 재검토): 예전에 학습 모드로 한 번 채점해 둔
   * 회차로 대전을 시작하면, 채점 라우트는 409 로 막히는데 여기로는 그 회차 전 문항의
   * `display` 가 그대로 나왔다. "이미 채점받았으니 새로 새는 정보가 없다" 는 전제가
   * **대전 중에는 성립하지 않는다** — 지금 그 답을 맞히면 점수가 되기 때문이다.
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
    const locked = lock.activeIds(req.user.id); // 지금 내 대전에 걸린 문항 (없으면 null)
    const explanations = {};
    let served = 0;
    let blocked = 0;
    for (const qid of ids) {
      if (!graded.has(qid)) continue;            // 채점 기록 없음 — 조용히 생략
      if (locked && locked.has(qid)) {           // 지금 대전에 걸린 문항 — 조용히 생략
        blocked += 1;
        continue;
      }
      const q = rounds.getQuestion(qid);
      if (!q) continue;                          // 지금 데이터에 없는 문항 — 조용히 생략
      explanations[qid] = {
        display: q.display == null ? '' : q.display,
        html: rounds.explanationOf(qid),
      };
      served += 1;
    }

    // 대전 중 조회는 흔한 일이 아니다 — 몇 건이 막혔는지 로그에 남겨 둔다.
    log('wrong explain', served + '/' + ids.length + '문항',
      blocked > 0 ? '(대전 잠금 ' + blocked + '건)' : '', req.user.nickname);
    res.json({ explanations: explanations });
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
      // 이 세트를 채점할 때 그대로 되돌려 보낸다 — 채점 집합은 서버가 정한다(보안 C-1)
      setToken: settoken.signSet(req.user.id, questions.map(function (q) { return q.id; })),
      questions: questions,
    });
  }

  app.get('/api/me/wrong', auth.requireAuth, function (req, res) {
    const f = filters.parseFilters(req.query);
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
      // 이 세트를 채점할 때 그대로 되돌려 보낸다 — 채점 집합은 서버가 정한다(보안 C-1)
      setToken: settoken.signSet(req.user.id, questions.map(function (q) { return q.id; })),
      questions: questions,
    });
  });
};

module.exports.HISTORY_RECENT_MAX = HISTORY_RECENT_MAX;
module.exports.EXPLAIN_IDS_MAX = EXPLAIN_IDS_MAX;
