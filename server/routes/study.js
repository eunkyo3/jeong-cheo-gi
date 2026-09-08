'use strict';
/**
 * routes/study.js — 학습 모드 REST (`/api/rounds*`, `/api/practice*`).
 *
 * index.js 에서 그대로 옮긴 라우트다. 등록 순서·응답 형태 모두 예전과 같다.
 * 유형·언어 해석과 답안 정리는 `server/filters.js`, 채점은 `server/grader.js` 소관이다.
 *
 * **채점은 로그인 필수다** (보안 C-1). 예전에는 두 채점 경로가 무인증이라 아무 문항 id 나
 * 적어 보내면 정답 표기(`display`)와 해설이 그대로 나왔다 — 대전 중인 문항까지 포함해서.
 * 지금은 세 겹으로 막는다:
 *   ① `auth.requireAuth` — 누가 채점하는지 서버가 안다.
 *   ② 채점 집합을 클라이언트가 정하지 못한다 — 회차 채점은 회차+필터로, 모의고사·오답노트
 *      채점은 **서버가 발급한 서명 토큰**(`server/settoken.js`)으로만 정해진다.
 *   ③ 지금 진행 중인 대전에 걸린 문항이면 409 로 거절한다(`ctx.battleIo`).
 * 사용자당 분당 20회 레이트리밋이 그 위에 얹힌다.
 *
 * @param {object} app express 앱
 * @param {{db:object, rounds:object, auth:object, battleIo:object, log:function, logErr:function}} ctx
 */

const filters = require('../filters.js');
const battle = require('../battle.js'); // 순수 모듈 — 랜덤 모의고사 출제에 buildQuestionSet 만 빌려 쓴다
const { gradeSet } = require('../grader.js');
const settoken = require('../settoken.js');
const battlelock = require('../battlelock.js');
const { rateLimit } = require('../ratelimit.js');

const PRACTICE_COUNT_MIN = 5;
const PRACTICE_COUNT_MAX = 60;
const PRACTICE_GRADE_MAX = 200;   // 한 번에 채점할 수 있는 문항 수 상한

const GRADE_WINDOW_MS = 60000;    // 채점 레이트리밋 — 사용자당 1분에 20회
const GRADE_MAX = 20;

const EXPLAIN_IDS_MAX = 50;       // 한 번에 조회할 수 있는 문항 수 (me.js 의 오답노트 조회와 같은 상한)
const EXPLAIN_WINDOW_MS = 60000;  // 학습 모드 정답·해설 조회 — 사용자당 1분에 60회
const EXPLAIN_MAX = 60;

const NEED_TOKEN = '문제 세트 정보가 없거나 만료되었습니다. 문제를 다시 불러온 뒤 채점하세요.';
const BATTLE_LOCKED = '진행 중인 대전의 문항은 채점할 수 없습니다.';

module.exports = function mount(app, ctx) {
  const db = ctx.db;
  const rounds = ctx.rounds;
  const auth = ctx.auth;
  const log = ctx.log;
  const logErr = ctx.logErr;

  // 사용자당 채점 횟수 제한. requireAuth 뒤에 놓으므로 req.user 는 항상 있다.
  const gradeLimit = rateLimit({
    windowMs: GRADE_WINDOW_MS,
    max: GRADE_MAX,
    label: 'grade',
    logErr: logErr,
    keyOf: function (req) { return 'grade:' + (req.user ? req.user.id : '?'); },
  });

  // 대전 잠금 판정은 `server/battlelock.js` 한 곳에만 있다 — 라우트마다 사본을 두면 어긋난다.
  const lock = battlelock.create(ctx);

  // ------------------------------------------------------------------- 회차

  app.get('/api/rounds', function (req, res) {
    res.json(rounds.listRounds());
  });

  app.get('/api/rounds/:id', function (req, res) {
    const round = rounds.getRound(req.params.id); // 인메모리 화이트리스트 — 경로 순회 불가
    if (!round) return res.status(404).json({ error: '없는 회차입니다.' });

    const f = filters.parseFilters(req.query);
    if (!f.ok) return res.status(400).json({ error: f.error });
    const questions = filters.applyFilters(round.questions, f);
    if ((f.type || f.lang) && questions.length === 0) {
      return res.status(400).json({ error: filters.emptyReason(f) });
    }

    res.json({
      round: round.round,
      title: round.title || round.round,
      sourceUrl: round.sourceUrl || '',
      type: f.type,
      lang: f.lang,
      questions: questions.map(rounds.publicQuestion), // 정답 계열 필드 제거
    });
  });

  // 회차 채점은 채점 집합을 **회차 + 필터**로 서버가 직접 정한다 — 세트 토큰이 필요 없다.
  app.post('/api/rounds/:id/grade', auth.requireAuth, gradeLimit, function (req, res) {
    const round = rounds.getRound(req.params.id);
    if (!round) return res.status(404).json({ error: '없는 회차입니다.' });

    // 유형을 지정하면 **그 부분집합만** 채점한다. 아래 questions 를 sanitizeAnswers·gradeSet·
    // study_results.question_ids 가 모두 공유하므로 총점·오답노트가 서로 어긋나지 않는다.
    // 언어까지 걸어 풀었다면 채점 집합도 같아야 한다 — 안 보내면 예전과 같은 동작(유형만).
    const f = filters.parseFilters(req.body || {});
    if (!f.ok) return res.status(400).json({ error: f.error });
    const questions = filters.applyFilters(round.questions, f);
    if (questions.length === 0) return res.status(400).json({ error: filters.emptyReason(f) });

    const qids = questions.map(function (q) { return q.id; });
    if (lock.blocks(req.user.id, qids)) return res.status(409).json({ error: BATTLE_LOCKED });

    const answers = filters.sanitizeAnswers(questions, (req.body || {}).answers);
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

    try {
      // 학습 이력·오답노트가 문항 단위로 되짚을 수 있도록 출제 문항과 틀린 문항을 함께 남긴다.
      // 유형 필터를 걸었다면 question_ids 도 그 부분집합이어야 오답노트가 어긋나지 않는다.
      db.saveStudyResult(req.user.id, round.round, result.score, qids, filters.wrongIdsOf(result.details));
    } catch (e) {
      logErr('study 저장 실패', round.round, req.user.nickname, '-', e.message);
    }
    log('grade', round.round + (f.type ? '/' + f.type : '') + (f.lang ? '/' + f.lang : ''),
      result.correctCount + '/' + result.totalCount,
      result.score + '점', req.user.nickname);

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

  // ------------------------------------------- 학습 모드 정답·해설 즉시 조회

  /**
   * `GET /api/study/explain?ids=2024-1#1,2024-1#2` (1~50개, **로그인 필수**)
   *   → `{ explanations: { [qid]: { display, html, bodyText } } }`
   *
   * **PROTOCOL "채점 전 비노출" 의 두 번째 예외다**(첫 번째는 오답노트의
   * `GET /api/me/wrong/explain`). 요구 2(2026-09-08): 학습은 혼자 공부하는 공간이고,
   * 모르는 문항 앞에서 막히면 배우지 못한 채 넘어간다. 그래서 학습·모의고사 화면에서는
   * **채점 전에도** 정답·해설·AI 질문용 지문을 토글로 열 수 있다.
   *
   * 그럼에도 정답 오라클이 되지 않는 이유 — 원래 무엇을 막던 규칙이었는지로 되짚는다:
   *   ① **비로그인 차단**(보안 C-1): 익명 요청으로 전 문항 정답을 긁어가는 길은 그대로 막힌다.
   *   ② **대전 잠금**(battlelock): 지금 내 대전에 걸린 문항은 조용히 생략한다 — 대전 중에
   *      다른 탭에서 정답을 꺼내 보는 길이 여기 열려서는 안 된다. 채점 라우트·오답노트
   *      조회와 **같은 한 곳**(battlelock.js)에서 판정한다.
   *   ③ **레이트리밋**: 사용자당 1분 60회. 정상적인 학습(문항 20개 일괄 펼치기 = 1회)에는
   *      전혀 걸리지 않고, 전 회차(420문항) 자동 수집은 눈에 띄게 느려진다.
   * 채점 이력 검사는 하지 **않는다** — 그게 오답노트 조회와 다른 점이고, 요구의 핵심이다.
   *
   * 없는 문항·대전에 걸린 문항은 403 이 아니라 **응답에서 조용히 생략**한다
   * (오답노트 조회와 같은 규약 — 클라이언트는 "권한 없음" 으로만 알면 된다).
   */
  const explainLimit = rateLimit({
    windowMs: EXPLAIN_WINDOW_MS,
    max: EXPLAIN_MAX,
    label: 'study explain',
    logErr: logErr,
    keyOf: function (req) { return 'study-explain:' + (req.user ? req.user.id : '?'); },
  });

  app.get('/api/study/explain', auth.requireAuth, explainLimit, function (req, res) {
    const raw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const parts = raw.split(',');
    // 상한 검사를 중복 제거보다 먼저 — 거절 비용을 split 한 번으로 끝낸다(me.js 와 같은 규칙).
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

    const locked = lock.activeIds(req.user.id); // 지금 내 대전에 걸린 문항 (없으면 null)
    const explanations = {};
    let served = 0;
    let blocked = 0;
    for (const qid of ids) {
      if (locked && locked.has(qid)) { blocked += 1; continue; } // 대전 중 — 조용히 생략
      const q = rounds.getQuestion(qid);
      if (!q) continue;                                          // 없는 문항 — 조용히 생략
      explanations[qid] = {
        display: q.display == null ? '' : q.display,
        html: rounds.explanationOf(qid),
        bodyText: q.bodyText == null ? '' : q.bodyText, // "AI에게 질문하기" 프롬프트 조립용
      };
      served += 1;
    }

    log('study explain', served + '/' + ids.length + '문항',
      blocked > 0 ? '(대전 잠금 ' + blocked + '건)' : '', req.user.nickname);
    res.json({ explanations: explanations });
  });

  // --------------------------------------------------------- 랜덤 모의고사

  app.get('/api/practice', function (req, res) {
    const f = filters.parseFilters(req.query);
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
        return { round: r.round, questions: filters.applyFilters(r.questions, f) };
      }),
      questionCount: count,
    });
    if (!built.ok) return res.status(400).json({ error: built.error }); // 유효 문항 총합 부족 등

    log('practice', roundIds.length + '회차', built.questions.length + '문항',
      f.type || '전체', f.lang || '', req.user ? req.user.nickname : '(비로그인)');

    // 세트 토큰은 로그인한 사람에게만 의미가 있다(채점이 로그인 필수다). 비로그인은 문제만 본다.
    const setToken = req.user
      ? settoken.signSet(req.user.id, built.questions.map(function (q) { return q.id; }))
      : '';

    res.json({
      setKey: 'practice',
      title: '랜덤 모의고사 · ' + roundIds.length + '회차 ' + built.questions.length + '문항',
      roundIds: roundIds,
      type: f.type,
      lang: f.lang,
      setToken: setToken, // 이 세트를 채점할 때 그대로 되돌려 보낸다 (보안 C-1)
      questions: built.questions.map(rounds.publicQuestion), // 정답 계열 필드 제거
    });
  });

  /**
   * 모의고사/오답노트 채점. 회차가 고정돼 있지 않으므로 채점 집합을 **서버가 발급한 세트 토큰**에서
   * 꺼낸다(`GET /api/practice` · `GET /api/me/wrong` 응답의 `setToken`).
   *
   * 예전에는 **제출한 답안의 키**로 집합을 복원했는데, 그러면 아무 문항 id 나 적어 보내는 것만으로
   * 그 문항의 `display`·해설을 받아낼 수 있었다(보안 C-1). 지금 `answers` 는 "토큰이 정한 각 칸에
   * 뭘 적었는가" 만 말한다 — 토큰 밖의 id 는 `sanitizeAnswers` 가 조용히 버린다.
   *
   * 응답 형태는 회차 채점과 같다 — 프런트가 같은 결과 화면을 쓴다.
   */
  app.post('/api/practice/grade', auth.requireAuth, gradeLimit, function (req, res) {
    const body = req.body || {};
    const setKey = body.setKey === 'practice' || body.setKey === 'wrong' ? body.setKey : null;
    if (!setKey) return res.status(400).json({ error: '알 수 없는 문제 집합입니다.' });

    const setIds = settoken.verifySet(body.setToken, req.user.id);
    if (!setIds) return res.status(400).json({ error: NEED_TOKEN });

    const raw = body.answers && typeof body.answers === 'object' ? body.answers : {};
    const questions = [];
    for (const qid of setIds) {
      if (questions.length >= PRACTICE_GRADE_MAX) break;
      const q = rounds.getQuestion(qid);
      if (q) questions.push(q); // 회차 파일이 바뀌어 사라진 문항은 조용히 빠진다
    }
    if (questions.length === 0) return res.status(400).json({ error: '채점할 문항이 없습니다.' });

    const qids = questions.map(function (q) { return q.id; });
    if (lock.blocks(req.user.id, qids)) return res.status(409).json({ error: BATTLE_LOCKED });

    const answers = filters.sanitizeAnswers(questions, raw);
    const result = gradeSet(questions, answers);

    // 채점 후에만 나가는 부가 자산 — 회차 채점과 같은 규칙이다.
    const bodyTexts = {};
    const explanations = {};
    for (const q of questions) {
      bodyTexts[q.id] = q.bodyText == null ? '' : q.bodyText;
      explanations[q.id] = q.explanationHtml == null ? '' : q.explanationHtml;
    }

    try {
      db.saveStudyResult(req.user.id, setKey, result.score, qids, filters.wrongIdsOf(result.details));
    } catch (e) {
      logErr('study 저장 실패', setKey, req.user.nickname, '-', e.message);
    }
    log('grade', setKey, result.correctCount + '/' + result.totalCount,
      result.score + '점', req.user.nickname);

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
};

module.exports.PRACTICE_COUNT_MIN = PRACTICE_COUNT_MIN;
module.exports.PRACTICE_COUNT_MAX = PRACTICE_COUNT_MAX;
module.exports.PRACTICE_GRADE_MAX = PRACTICE_GRADE_MAX;
module.exports.EXPLAIN_IDS_MAX = EXPLAIN_IDS_MAX;
module.exports.EXPLAIN_MAX = EXPLAIN_MAX;
