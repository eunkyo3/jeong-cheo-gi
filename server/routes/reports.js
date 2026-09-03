'use strict';
/**
 * routes/reports.js — 정답 이의 제기 (`POST /api/reports`).
 *
 * 적재는 전부 `server/reports.js`(append-only JSONL) 소관이고 여기서는 요청 검증만 한다.
 * 보안 H-3 에 따라 세 겹을 걸었다.
 *   ① `requireAuth` — 비로그인 쓰기를 막는다(예전에는 누구나 디스크를 불릴 수 있었다).
 *   ② 사용자당 분당 5건 레이트리밋.
 *   ③ `myAnswer` 배열 10칸·칸당 500자, 파일 8MB 상한.
 *
 * @param {object} app express 앱
 * @param {{rounds:object, auth:object, DATA_DIR:string, log:function, logErr:function}} ctx
 */

const reports = require('../reports.js');
const { rateLimit } = require('../ratelimit.js');

module.exports = function mount(app, ctx) {
  const rounds = ctx.rounds;
  const auth = ctx.auth;
  const log = ctx.log;
  const logErr = ctx.logErr;
  const DATA_DIR = ctx.DATA_DIR;
  const REPORTS_FILE = reports.fileOf(DATA_DIR);

  // 기동 시 1회 — 예전 배열 파일이 있으면 JSONL 로 옮기고 `.migrated` 로 이름을 바꾼다
  try {
    const moved = reports.migrateLegacy(DATA_DIR, logErr);
    if (moved) log('reports.json →', reports.FILE_NAME, '이관', moved.moved + '건');
  } catch (e) {
    logErr('reports 이관 실패 — 새 신고는 JSONL 로 쌓입니다:', e.message);
  }

  /** 사용자당(비정상 경로 대비 IP 폴백) 분당 5건. */
  const limiter = rateLimit({
    windowMs: 60000,
    max: 5,
    keyOf: req => (req.user ? 'u' + req.user.id : 'ip:' + (req.socket && req.socket.remoteAddress)),
    label: 'reports',
    logErr: logErr,
  });

  /** JSONL 한 줄을 덧붙인다. 반환값은 기록 후 파일 크기(바이트). */
  function appendReport(entry) {
    return reports.appendReport(entry, DATA_DIR).bytes;
  }

  app.post('/api/reports', auth.requireAuth, limiter, function (req, res) {
    const body = req.body || {};
    const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : '';
    if (!questionId) return res.status(400).json({ error: '문항 id 가 필요합니다.' });
    if (!rounds.getQuestion(questionId)) return res.status(400).json({ error: '없는 문항입니다.' });

    const comment = typeof body.comment === 'string'
      ? body.comment.trim().slice(0, reports.MAX_COMMENT_CHARS) : '';
    if (!comment) return res.status(400).json({ error: '어떤 점이 이상한지 적어 주세요.' });

    // 배열 길이가 무제한이던 자리 — 칸 수도 칸 크기도 둘 다 막는다
    let myAnswer;
    if (Array.isArray(body.myAnswer)) {
      if (body.myAnswer.length > reports.MAX_ANSWER_ITEMS) {
        return res.status(400).json({ error: '답안 칸이 너무 많습니다. (' + reports.MAX_ANSWER_ITEMS + '개 이하)' });
      }
      myAnswer = body.myAnswer.map(function (v) {
        return typeof v === 'string' ? v.slice(0, reports.MAX_ANSWER_CHARS) : '';
      });
    } else {
      myAnswer = typeof body.myAnswer === 'string' ? body.myAnswer.slice(0, reports.MAX_ANSWER_CHARS) : '';
    }

    try {
      const bytes = appendReport({
        at: new Date().toISOString(),
        questionId: questionId,
        myAnswer: myAnswer,
        comment: comment,
        byUserId: req.user.id,
      });
      log('report', questionId, 'by', req.user.nickname, '- 파일', Math.round(bytes / 1024) + 'KB');
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'REPORTS_FULL') {
        logErr('report 상한 도달', questionId, '-', e.message);
        return res.status(507).json({ error: '신고 저장 공간이 가득 찼습니다. 관리자에게 알려 주세요.' });
      }
      logErr('report 저장 실패', questionId, '-', e.message);
      res.status(500).json({ error: '신고 저장에 실패했습니다.' });
    }
  });

  return {
    appendReport: appendReport,
    REPORTS_FILE: REPORTS_FILE,
    listReports: opts => reports.listReports(Object.assign({ dir: DATA_DIR }, opts || {})),
  };
};
